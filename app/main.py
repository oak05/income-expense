"""รายรับรายจ่าย — personal income/expense tracker (FastAPI + SQLite)."""
from __future__ import annotations

import base64
import calendar
import csv
import datetime as dt
import io
import ipaddress
import json
import logging
import os
import re
import secrets
import sqlite3
import tempfile
import uuid
import zipfile
from collections import Counter
from contextlib import asynccontextmanager
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path
from typing import Literal
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from . import db, migrate
from . import receipts as rc

APP_VERSION = "1.2.1"
log = logging.getLogger("uvicorn.error")
STATIC_DIR = Path(__file__).resolve().parent / "static"
TZ = ZoneInfo(os.environ.get("TZ") or "Asia/Bangkok")
APP_USER = os.environ.get("APP_USER", "admin")
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
# Host names the app answers to, besides localhost and any IP address (comma-separated, e.g. "mypc.local")
ALLOWED_HOSTS = {"localhost"} | {h.strip().lower() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip()}
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

TxType = Literal["income", "expense"]
TYPE_TH = {"income": "รายรับ", "expense": "รายจ่าย"}
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
COLOR_RE = r"^#[0-9A-Fa-f]{6}$"
FIELD_TH = {
    "amount": "จำนวนเงิน",
    "category_id": "หมวดหมู่",
    "date": "วันที่",
    "note": "หมายเหตุ",
    "type": "ประเภท",
    "name": "ชื่อหมวดหมู่",
    "color": "สี",
    "month": "เดือน",
    "year": "ปี",
}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    ran = db.init()
    if ran:
        log.info("database migrated: applied %s", ", ".join(f"{v:04d}" for v in ran))
    log.info("database at schema version %s (%s)", migrate.latest_version(), db.DB_PATH)
    yield


app = FastAPI(title="รายรับรายจ่าย", version=APP_VERSION, lifespan=lifespan)


# --------------------------------------------------------------------------- #
# Optional password (set APP_PASSWORD in .env to turn on)
# --------------------------------------------------------------------------- #
@app.middleware("http")
async def basic_auth(request: Request, call_next):
    if APP_PASSWORD and request.url.path != "/api/health":
        ok = False
        header = request.headers.get("authorization", "")
        if header[:6].lower() == "basic ":
            try:
                user, _, pw = base64.b64decode(header[6:]).decode("utf-8").partition(":")
                ok = secrets.compare_digest(user.encode(), APP_USER.encode()) & secrets.compare_digest(
                    pw.encode(), APP_PASSWORD.encode()
                )
            except Exception:
                ok = False
        if not ok:
            return Response(
                "ต้องใส่ชื่อผู้ใช้และรหัสผ่าน",
                status_code=401,
                headers={"WWW-Authenticate": 'Basic realm="income-expense", charset="UTF-8"'},
                media_type="text/plain; charset=utf-8",
            )
    return await call_next(request)


# --------------------------------------------------------------------------- #
# Request guard: only this app's own pages may change data
# --------------------------------------------------------------------------- #
def _host_only(host_header: str) -> str:
    host = host_header.strip().lower()
    if host.startswith("["):  # [::1]:8080
        return host[1 : host.find("]")] if "]" in host else ""
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def host_allowed(host_header: str) -> bool:
    """Blocks DNS rebinding: an attacker's domain pointed at 127.0.0.1 arrives with the attacker's host name.
    IP addresses are always fine (a page cannot make the browser send an IP as its own host)."""
    host = _host_only(host_header)
    if not host:
        return False
    if host in ALLOWED_HOSTS:
        return True
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def same_origin(origin: str, host_header: str) -> bool:
    try:
        netloc = urlsplit(origin).netloc
    except ValueError:
        return False
    return bool(netloc) and netloc.lower() == host_header.strip().lower()


@app.middleware("http")
async def request_guard(request: Request, call_next):
    host = request.headers.get("host", "")
    if not host_allowed(host):
        return JSONResponse(
            {"detail": "ชื่อโฮสต์นี้ไม่ได้รับอนุญาต — ถ้าเปิดแอปด้วยชื่อเครื่อง ให้เพิ่มชื่อนั้นใน ALLOWED_HOSTS ในไฟล์ .env"},
            status_code=400,
        )
    if request.method in UNSAFE_METHODS:
        # Writes must come from the app's own pages. A custom header can't be added by another site without a CORS
        # preflight (which this app never grants); Origin / Sec-Fetch-Site catch the rest.
        site = request.headers.get("sec-fetch-site")
        origin = request.headers.get("origin")
        if (
            (site is not None and site not in ("same-origin", "none"))
            or (origin is not None and not same_origin(origin, host))
            or not request.headers.get("x-requested-with")
        ):
            return JSONResponse(
                {"detail": "คำขอถูกปฏิเสธ: การแก้ไขข้อมูลต้องทำจากหน้าเว็บของแอปเท่านั้น"}, status_code=403
            )
    return await call_next(request)


@app.exception_handler(RequestValidationError)
async def validation_handler(_request: Request, exc: RequestValidationError):
    fields = []
    for err in exc.errors():
        loc = [str(p) for p in err.get("loc", []) if p not in ("body", "query", "path")]
        name = FIELD_TH.get(loc[-1], loc[-1]) if loc else "ข้อมูล"
        if name not in fields:
            fields.append(name)
    return JSONResponse({"detail": "ข้อมูลไม่ถูกต้อง: " + ", ".join(fields)}, status_code=422)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
async def read_body_limited(request: Request, limit: int, too_big: str) -> bytes:
    """Read the request body but stop at `limit` bytes, so an oversized upload never sits in memory whole."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise HTTPException(413, too_big)
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise HTTPException(413, too_big)
        chunks.append(chunk)
    return b"".join(chunks)


def to_satang(value: Decimal) -> int:
    return int((value * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def baht(satang: int | None) -> float:
    return round((satang or 0) / 100, 2)


def now_local() -> dt.datetime:
    return dt.datetime.now(TZ)


def month_range(month: str) -> tuple[str, str]:
    if not MONTH_RE.match(month or ""):
        raise HTTPException(400, "รูปแบบเดือนต้องเป็น YYYY-MM")
    y, m = map(int, month.split("-"))
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    return f"{y:04d}-{m:02d}-01", f"{ny:04d}-{nm:02d}-01"


def shift_month(month: str, delta: int) -> str:
    y, m = map(int, month.split("-"))
    idx = y * 12 + (m - 1) + delta
    return f"{idx // 12:04d}-{idx % 12 + 1:02d}"


def parse_iso_date(value: str, label: str) -> str:
    try:
        return dt.date.fromisoformat(value).isoformat()
    except ValueError:
        raise HTTPException(400, f"{label}ต้องเป็นรูปแบบ YYYY-MM-DD") from None


def check_category(conn: sqlite3.Connection, category_id: int, tx_type: str) -> None:
    row = conn.execute("SELECT type FROM categories WHERE id = ?", (category_id,)).fetchone()
    if row is None:
        raise HTTPException(400, "ไม่พบหมวดหมู่นี้")
    if row["type"] != tx_type:
        raise HTTPException(400, "หมวดหมู่ไม่ตรงกับประเภทรายการ (รายรับ/รายจ่าย)")


TX_SELECT = """
SELECT t.id, t.type, t.amount_satang, t.category_id, c.name AS category_name,
       c.color AS category_color, t.date, t.note, t.created_at, t.updated_at,
       (SELECT r.id FROM receipts r WHERE r.transaction_id = t.id LIMIT 1) AS receipt_id
FROM transactions t
JOIN categories c ON c.id = t.category_id
"""


def tx_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["amount"] = baht(d.pop("amount_satang"))
    return d


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #
class TransactionIn(BaseModel):
    type: TxType
    amount: Decimal = Field(gt=0, le=Decimal("9999999999.99"))
    category_id: int
    date: dt.date
    note: str = Field(default="", max_length=500)

    @field_validator("note")
    @classmethod
    def _strip_note(cls, v: str) -> str:
        return v.strip()


def _clean_name(v: str) -> str:
    v = v.strip()
    if not v:
        raise ValueError("empty")
    return v


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    type: TxType
    color: str = Field(default="#7A8290", pattern=COLOR_RE)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        return _clean_name(v)


class CategoryUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    color: str = Field(pattern=COLOR_RE)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        return _clean_name(v)


# --------------------------------------------------------------------------- #
# Health
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health():
    return {"status": "ok", "version": APP_VERSION, "schema": migrate.latest_version()}


# --------------------------------------------------------------------------- #
# Categories
# --------------------------------------------------------------------------- #
@app.get("/api/categories")
def list_categories():
    with db.session() as conn:
        rows = conn.execute(
            """
            SELECT c.id, c.name, c.type, c.color, c.sort_order, COUNT(t.id) AS tx_count
            FROM categories c
            LEFT JOIN transactions t ON t.category_id = c.id
            GROUP BY c.id
            ORDER BY c.sort_order, c.id
            """
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/categories", status_code=201)
def create_category(body: CategoryIn):
    with db.session() as conn:
        (next_order,) = conn.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories").fetchone()
        try:
            cur = conn.execute(
                "INSERT INTO categories (name, type, color, sort_order) VALUES (?, ?, ?, ?)",
                (body.name, body.type, body.color, next_order),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(409, f"มีหมวดหมู่ \"{body.name}\" อยู่แล้ว") from None
        row = conn.execute("SELECT *, 0 AS tx_count FROM categories WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


@app.put("/api/categories/{cid}")
def update_category(cid: int, body: CategoryUpdate):
    with db.session() as conn:
        if conn.execute("SELECT 1 FROM categories WHERE id = ?", (cid,)).fetchone() is None:
            raise HTTPException(404, "ไม่พบหมวดหมู่")
        try:
            conn.execute("UPDATE categories SET name = ?, color = ? WHERE id = ?", (body.name, body.color, cid))
        except sqlite3.IntegrityError:
            raise HTTPException(409, f"มีหมวดหมู่ \"{body.name}\" อยู่แล้ว") from None
        row = conn.execute("SELECT * FROM categories WHERE id = ?", (cid,)).fetchone()
    return dict(row)


@app.delete("/api/categories/{cid}")
def delete_category(cid: int, move_to: int | None = None):
    with db.session() as conn:
        cat = conn.execute("SELECT * FROM categories WHERE id = ?", (cid,)).fetchone()
        if cat is None:
            raise HTTPException(404, "ไม่พบหมวดหมู่")
        (same_type,) = conn.execute("SELECT COUNT(*) FROM categories WHERE type = ?", (cat["type"],)).fetchone()
        if same_type <= 1:
            raise HTTPException(400, f"ต้องมีหมวดหมู่{TYPE_TH[cat['type']]}อย่างน้อย 1 หมวด")
        (used,) = conn.execute("SELECT COUNT(*) FROM transactions WHERE category_id = ?", (cid,)).fetchone()
        moved = 0
        if used:
            if move_to is None:
                raise HTTPException(409, f"หมวดหมู่นี้มี {used} รายการ — เลือกหมวดที่จะย้ายรายการไปก่อนลบ")
            target = conn.execute("SELECT type FROM categories WHERE id = ?", (move_to,)).fetchone()
            if target is None or move_to == cid or target["type"] != cat["type"]:
                raise HTTPException(400, "หมวดหมู่ปลายทางไม่ถูกต้อง")
            moved = conn.execute(
                "UPDATE transactions SET category_id = ?, updated_at = datetime('now') WHERE category_id = ?",
                (move_to, cid),
            ).rowcount
        conn.execute("DELETE FROM categories WHERE id = ?", (cid,))
    return {"ok": True, "moved": moved}


# --------------------------------------------------------------------------- #
# Transactions
# --------------------------------------------------------------------------- #
@app.get("/api/transactions")
def list_transactions(
    month: str | None = None,
    start: str | None = None,
    end: str | None = None,
    type: TxType | None = None,  # noqa: A002 - query param name
    category_id: int | None = None,
    q: str | None = None,
    limit: int = Query(5000, ge=1, le=50000),
):
    where, params = [], []
    if month:
        s, e = month_range(month)
        where += ["t.date >= ?", "t.date < ?"]
        params += [s, e]
    if start:
        where.append("t.date >= ?")
        params.append(parse_iso_date(start, "วันที่เริ่ม"))
    if end:
        where.append("t.date <= ?")
        params.append(parse_iso_date(end, "วันที่สิ้นสุด"))
    if type:
        where.append("t.type = ?")
        params.append(type)
    if category_id:
        where.append("t.category_id = ?")
        params.append(category_id)
    if q and q.strip():
        where.append("(instr(lower(t.note), lower(?)) > 0 OR instr(lower(c.name), lower(?)) > 0)")
        params += [q.strip(), q.strip()]
    sql = TX_SELECT + (" WHERE " + " AND ".join(where) if where else "")
    sql += " ORDER BY t.date DESC, t.id DESC LIMIT ?"
    params.append(limit)
    with db.session() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [tx_dict(r) for r in rows]


@app.post("/api/transactions", status_code=201)
def create_transaction(body: TransactionIn):
    with db.session() as conn:
        check_category(conn, body.category_id, body.type)
        cur = conn.execute(
            "INSERT INTO transactions (type, amount_satang, category_id, date, note) VALUES (?, ?, ?, ?, ?)",
            (body.type, to_satang(body.amount), body.category_id, body.date.isoformat(), body.note),
        )
        row = conn.execute(TX_SELECT + " WHERE t.id = ?", (cur.lastrowid,)).fetchone()
    return tx_dict(row)


@app.put("/api/transactions/{tid}")
def update_transaction(tid: int, body: TransactionIn):
    with db.session() as conn:
        if conn.execute("SELECT 1 FROM transactions WHERE id = ?", (tid,)).fetchone() is None:
            raise HTTPException(404, "ไม่พบรายการ")
        check_category(conn, body.category_id, body.type)
        conn.execute(
            """UPDATE transactions
               SET type = ?, amount_satang = ?, category_id = ?, date = ?, note = ?, updated_at = datetime('now')
               WHERE id = ?""",
            (body.type, to_satang(body.amount), body.category_id, body.date.isoformat(), body.note, tid),
        )
        row = conn.execute(TX_SELECT + " WHERE t.id = ?", (tid,)).fetchone()
    return tx_dict(row)


@app.delete("/api/transactions/{tid}")
def delete_transaction(tid: int):
    with db.session() as conn:
        attached = conn.execute("SELECT * FROM receipts WHERE transaction_id = ?", (tid,)).fetchall()
        if conn.execute("DELETE FROM transactions WHERE id = ?", (tid,)).rowcount == 0:
            raise HTTPException(404, "ไม่พบรายการ")
        conn.execute("DELETE FROM receipts WHERE transaction_id IS NULL AND status = 'saved'")
    for r in attached:  # the receipt image goes with its transaction
        _remove_receipt_files(r)
    return {"ok": True, "receipts_removed": len(attached)}


# --------------------------------------------------------------------------- #
# Summaries
# --------------------------------------------------------------------------- #
def _totals(conn: sqlite3.Connection, start: str, end: str) -> dict:
    out = {"income": 0, "expense": 0, "count": 0}
    for r in conn.execute(
        "SELECT type, SUM(amount_satang) AS s, COUNT(*) AS n FROM transactions "
        "WHERE date >= ? AND date < ? GROUP BY type",
        (start, end),
    ):
        out[r["type"]] = r["s"] or 0
        out["count"] += r["n"]
    return {
        "income": baht(out["income"]),
        "expense": baht(out["expense"]),
        "balance": baht(out["income"] - out["expense"]),
        "count": out["count"],
    }


@app.get("/api/summary")
def summary(month: str):
    start, end = month_range(month)
    prev_start, prev_end = month_range(shift_month(month, -1))
    y, m = map(int, month.split("-"))
    days_in_month = calendar.monthrange(y, m)[1]

    with db.session() as conn:
        totals = _totals(conn, start, end)
        previous = _totals(conn, prev_start, prev_end)
        (cumulative,) = conn.execute(
            "SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount_satang ELSE -amount_satang END), 0) "
            "FROM transactions WHERE date < ?",
            (end,),
        ).fetchone()
        by_cat = conn.execute(
            """
            SELECT c.id, c.name, c.color, t.type, SUM(t.amount_satang) AS s, COUNT(*) AS n
            FROM transactions t JOIN categories c ON c.id = t.category_id
            WHERE t.date >= ? AND t.date < ?
            GROUP BY c.id
            ORDER BY s DESC
            """,
            (start, end),
        ).fetchall()
        daily_rows = conn.execute(
            "SELECT date, type, SUM(amount_satang) AS s FROM transactions "
            "WHERE date >= ? AND date < ? GROUP BY date, type",
            (start, end),
        ).fetchall()

    daily = [{"day": d, "income": 0.0, "expense": 0.0} for d in range(1, days_in_month + 1)]
    for r in daily_rows:
        daily[int(r["date"][8:10]) - 1][r["type"]] = baht(r["s"])

    categories = {"income": [], "expense": []}
    for r in by_cat:
        categories[r["type"]].append(
            {"id": r["id"], "name": r["name"], "color": r["color"], "total": baht(r["s"]), "count": r["n"]}
        )

    return {
        "month": month,
        "totals": totals,
        "previous": previous,
        "cumulative_balance": baht(cumulative),
        "by_category": categories,
        "daily": daily,
    }


@app.get("/api/yearly")
def yearly(year: int = Query(ge=1900, le=2999)):
    start, end = f"{year:04d}-01-01", f"{year + 1:04d}-01-01"
    with db.session() as conn:
        rows = conn.execute(
            "SELECT CAST(substr(date, 6, 2) AS INTEGER) AS m, type, SUM(amount_satang) AS s "
            "FROM transactions WHERE date >= ? AND date < ? GROUP BY m, type",
            (start, end),
        ).fetchall()
        top = conn.execute(
            """
            SELECT c.name, c.color, SUM(t.amount_satang) AS s
            FROM transactions t JOIN categories c ON c.id = t.category_id
            WHERE t.type = 'expense' AND t.date >= ? AND t.date < ?
            GROUP BY c.id ORDER BY s DESC LIMIT 8
            """,
            (start, end),
        ).fetchall()
        totals = _totals(conn, start, end)

    months = [{"month": f"{year:04d}-{i:02d}", "income": 0.0, "expense": 0.0} for i in range(1, 13)]
    for r in rows:
        months[r["m"] - 1][r["type"]] = baht(r["s"])
    return {
        "year": year,
        "totals": totals,
        "months": months,
        "top_expense_categories": [{"name": r["name"], "color": r["color"], "total": baht(r["s"])} for r in top],
    }


# --------------------------------------------------------------------------- #
# CSV export / import
# --------------------------------------------------------------------------- #
CSV_HEADERS = ["วันที่", "ประเภท", "หมวดหมู่", "จำนวนเงิน", "หมายเหตุ"]
HEADER_ALIASES = {
    "date": {"date", "วันที่"},
    "type": {"type", "ประเภท"},
    "category": {"category", "หมวดหมู่", "หมวด"},
    "amount": {"amount", "จำนวนเงิน", "จำนวน", "ยอดเงิน"},
    "note": {"note", "หมายเหตุ", "รายละเอียด", "บันทึก"},
}
TYPE_ALIASES = {
    "income": "income", "รายรับ": "income", "รับ": "income",
    "expense": "expense", "รายจ่าย": "expense", "จ่าย": "expense",
}
NEW_CATEGORY_COLORS = ["#5B8DB8", "#B86F5B", "#6FA06B", "#9A6FB0", "#C29A3D", "#4E9A9A", "#B05B7A"]


@app.get("/api/export.csv")
def export_csv(month: str | None = None):
    sql, params = TX_SELECT, []
    if month:
        s, e = month_range(month)
        sql += " WHERE t.date >= ? AND t.date < ?"
        params = [s, e]
    sql += " ORDER BY t.date, t.id"
    with db.session() as conn:
        rows = conn.execute(sql, params).fetchall()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(CSV_HEADERS)
    for r in rows:
        writer.writerow([r["date"], TYPE_TH[r["type"]], r["category_name"], f"{r['amount_satang'] / 100:.2f}", r["note"]])
    filename = f"income-expense-{month or 'all'}.csv"
    # BOM so Excel on Windows opens Thai text correctly
    return Response(
        ("﻿" + buf.getvalue()).encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _decode_text(raw: bytes) -> str:
    for enc in ("utf-8-sig", "cp874"):  # cp874 = Thai Windows "ANSI" (Excel's default CSV save)
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise HTTPException(400, "อ่านไฟล์ไม่ได้ (รองรับ UTF-8 และ Windows-874)")


def _parse_date(value: str) -> dt.date:
    s = value.strip()[:10].strip()
    parts = re.split(r"[/.\-]", s)
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        raise ValueError("วันที่ไม่ถูกต้อง")
    if len(parts[0]) == 4:  # YYYY-MM-DD
        y, m, d = map(int, parts)
    else:  # DD/MM/YYYY (Thai Excel style)
        d, m, y = map(int, parts)
    if y < 1000:
        raise ValueError("ปีต้องเป็นตัวเลข 4 หลัก")
    if y > 2400:  # Buddhist Era -> CE
        y -= 543
    try:
        return dt.date(y, m, d)
    except ValueError:
        raise ValueError(f"วันที่ \"{value.strip()}\" ไม่ถูกต้อง") from None


def _parse_amount(value: str) -> Decimal:
    s = re.sub(r"[,\s฿]|บาท", "", value or "")
    if s.startswith("(") and s.endswith(")"):
        s = "-" + s[1:-1]
    try:
        return Decimal(s)
    except InvalidOperation:
        raise ValueError("จำนวนเงินไม่ถูกต้อง") from None


def _do_import(raw: bytes) -> dict:
    text = _decode_text(raw)
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text), dialect)
    try:
        header = next(reader)
    except StopIteration:
        raise HTTPException(400, "ไฟล์ว่าง") from None

    col: dict[str, int] = {}
    for i, h in enumerate(header):
        key = h.strip().lower()
        for field, aliases in HEADER_ALIASES.items():
            if key in aliases and field not in col:
                col[field] = i
    missing = [f for f in ("date", "amount") if f not in col]
    if missing:
        raise HTTPException(
            400, "ไม่พบคอลัมน์ที่จำเป็น: " + ", ".join(FIELD_TH.get(f, f) for f in missing)
            + " (หัวตารางที่รองรับ: วันที่, ประเภท, หมวดหมู่, จำนวนเงิน, หมายเหตุ)"
        )

    def cell(row: list[str], field: str) -> str:
        i = col.get(field)
        return row[i].strip() if i is not None and i < len(row) else ""

    imported, skipped_dup, errors = 0, 0, []
    with db.session() as conn:
        cats = {(r["name"], r["type"]): r["id"] for r in conn.execute("SELECT id, name, type FROM categories")}
        (next_order,) = conn.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories").fetchone()
        existing = Counter(
            (r["date"], r["type"], r["category_id"], r["amount_satang"], r["note"])
            for r in conn.execute("SELECT date, type, category_id, amount_satang, note FROM transactions")
        )
        for line_no, row in enumerate(reader, start=2):
            if not any(c.strip() for c in row):
                continue
            try:
                date = _parse_date(cell(row, "date"))
                amount = _parse_amount(cell(row, "amount"))
                type_raw = cell(row, "type").lower()
                if type_raw:
                    tx_type = TYPE_ALIASES.get(type_raw)
                    if tx_type is None:
                        raise ValueError(f"ประเภท \"{type_raw}\" ไม่รู้จัก (ใช้ รายรับ/รายจ่าย)")
                else:
                    tx_type = "expense" if amount < 0 else "income"
                amount = abs(amount)
                if amount == 0:
                    raise ValueError("จำนวนเงินต้องมากกว่า 0")
                cat_name = cell(row, "category")[:50] or "อื่นๆ"
                cid = cats.get((cat_name, tx_type))
                if cid is None:
                    color = NEW_CATEGORY_COLORS[len(cats) % len(NEW_CATEGORY_COLORS)]
                    cid = conn.execute(
                        "INSERT INTO categories (name, type, color, sort_order) VALUES (?, ?, ?, ?)",
                        (cat_name, tx_type, color, next_order),
                    ).lastrowid
                    next_order += 1
                    cats[(cat_name, tx_type)] = cid
                note = cell(row, "note")[:500]
                key = (date.isoformat(), tx_type, cid, to_satang(amount), note)
                if existing[key] > 0:  # same row already in the database -> skip
                    existing[key] -= 1
                    skipped_dup += 1
                    continue
                conn.execute(
                    "INSERT INTO transactions (type, amount_satang, category_id, date, note) VALUES (?, ?, ?, ?, ?)",
                    (tx_type, key[3], cid, key[0], note),
                )
                imported += 1
            except (ValueError, InvalidOperation) as e:
                errors.append(f"บรรทัด {line_no}: {e}")
    return {"imported": imported, "skipped_duplicates": skipped_dup, "errors": errors[:20], "error_count": len(errors)}


@app.post("/api/import")
async def import_csv(request: Request):
    raw = await read_body_limited(request, MAX_UPLOAD_BYTES, "ไฟล์ใหญ่เกิน 50 MB")
    if not raw:
        raise HTTPException(400, "ไม่มีไฟล์")
    return await run_in_threadpool(_do_import, raw)


# --------------------------------------------------------------------------- #
# Receipts: upload -> OCR -> review -> save as expenses
# --------------------------------------------------------------------------- #
MAX_RECEIPT_BYTES = 25 * 1024 * 1024
RECEIPT_FILE_RE = re.compile(r"^[0-9a-f]{32}\.(jpg|pdf)$")


class ReceiptUpdate(BaseModel):
    merchant: str | None = Field(default=None, max_length=200)
    amount: Decimal | None = Field(default=None, ge=0, le=Decimal("9999999999.99"))
    date: dt.date | None = None
    category_id: int | None = None
    included: bool | None = None


class ReceiptCommitItem(BaseModel):
    id: int
    amount: Decimal = Field(gt=0, le=Decimal("9999999999.99"))
    date: dt.date
    category_id: int
    merchant: str = Field(default="", max_length=200)


class ReceiptCommit(BaseModel):
    items: list[ReceiptCommitItem] = Field(min_length=1, max_length=500)


def _remove_receipt_files(row) -> None:
    for name in (row["image_file"], row["source_file"]):
        if name and RECEIPT_FILE_RE.match(name):
            try:
                (db.RECEIPTS_DIR / name).unlink()
            except FileNotFoundError:
                pass


def _receipt_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["amount"] = baht(d.pop("amount_satang")) if row["amount_satang"] is not None else None
    d["candidates"] = [baht(v) for v in json.loads(d["candidates"] or "[]")]
    d["flags"] = json.loads(d["flags"] or "[]")
    d["included"] = bool(d["included"])
    d["image_url"] = f"/api/receipts/{row['id']}/image"
    d["file_url"] = f"/api/receipts/{row['id']}/file"
    d.pop("image_file", None)
    d.pop("source_file", None)
    return d


def _category_for_hint(conn: sqlite3.Connection, hint: str | None) -> int | None:
    cats = conn.execute("SELECT id, name FROM categories WHERE type = 'expense' ORDER BY sort_order, id").fetchall()
    if not cats:
        return None
    names = rc.HINT_CATEGORY_NAMES.get(hint or "", [])
    for wanted in names:
        for c in cats:
            if c["name"] == wanted:
                return c["id"]
    for wanted in names:
        for c in cats:
            if wanted in c["name"] or c["name"] in wanted:
                return c["id"]
    for c in cats:  # fall back to "อื่นๆ", else the first expense category
        if c["name"] == "อื่นๆ":
            return c["id"]
    return cats[0]["id"]


def _process_receipt(raw: bytes, original_name: str) -> dict:
    # 1) open the file (fails fast on a bad upload) and make a preview
    if rc.is_pdf(raw):
        img, pdf_text = rc.pdf_to_image_and_text(raw)
    else:
        img, pdf_text = rc.load_image(raw), ""
    preview = rc.preview_jpeg(img)

    # 2) get text: PDF text layer if present, otherwise OCR
    text, source, error = "", "", ""
    if len(re.sub(r"\s", "", pdf_text)) >= 20:
        text, source = pdf_text, "pdf-text"
    else:
        try:
            text, source = rc.ocr_image(img), "ocr"
        except rc.ReceiptFileError as e:
            error = str(e)
        except Exception:  # timeout etc. — keep the receipt, let the user type the amount
            error = "อ่านตัวอักษรจากรูปไม่สำเร็จ ใส่ยอดเองได้"

    # 3) find total / date / shop / category
    parsed = rc.parse_receipt_text(text, now_local().date())
    flags = []
    if parsed.amount is None:
        flags.append("no_amount")
    elif parsed.confidence == "low":
        flags.append("check_amount")
    if parsed.date is None:
        flags.append("no_date")

    image_file = f"{uuid.uuid4().hex}.jpg"
    (db.RECEIPTS_DIR / image_file).write_bytes(preview)
    source_file = ""
    if rc.is_pdf(raw):
        source_file = f"{uuid.uuid4().hex}.pdf"
        (db.RECEIPTS_DIR / source_file).write_bytes(raw)

    with db.session() as conn:
        cur = conn.execute(
            """INSERT INTO receipts (image_file, source_file, original_name, text_source, ocr_text, error, merchant,
                                     amount_satang, date, category_id, candidates, confidence, flags)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                image_file, source_file, original_name[:200], source, text[:20000], error, parsed.merchant,
                to_satang(Decimal(str(parsed.amount))) if parsed.amount is not None else None,
                parsed.date or now_local().date().isoformat(),
                _category_for_hint(conn, parsed.category_hint),
                json.dumps([to_satang(Decimal(str(v))) for v in parsed.candidates]),
                parsed.confidence, json.dumps(flags),
            ),
        )
        row = conn.execute("SELECT * FROM receipts WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _receipt_dict(row)


@app.get("/api/ocr/status")
def ocr_status():
    return {"available": rc.ocr_available(), "languages": rc.tesseract_langs()}


@app.get("/api/receipts")
def list_receipts(status: Literal["pending", "saved"] = "pending", limit: int = Query(500, ge=1, le=5000)):
    with db.session() as conn:
        rows = conn.execute(
            "SELECT * FROM receipts WHERE status = ? ORDER BY id DESC LIMIT ?", (status, limit)
        ).fetchall()
    return [_receipt_dict(r) for r in rows]


@app.post("/api/receipts", status_code=201)
async def upload_receipt(request: Request):
    raw = await read_body_limited(request, MAX_RECEIPT_BYTES, "ไฟล์ใหญ่เกิน 25 MB")
    if not raw:
        raise HTTPException(400, "ไม่มีไฟล์")
    name = unquote(request.headers.get("x-filename", ""))
    try:
        return await run_in_threadpool(_process_receipt, raw, name)
    except rc.ReceiptFileError as e:
        raise HTTPException(400, str(e)) from None


@app.put("/api/receipts/{rid}")
def update_receipt(rid: int, body: ReceiptUpdate):
    changes = body.model_dump(exclude_unset=True)
    with db.session() as conn:
        row = conn.execute("SELECT * FROM receipts WHERE id = ?", (rid,)).fetchone()
        if row is None:
            raise HTTPException(404, "ไม่พบใบเสร็จ")
        if row["status"] != "pending":
            raise HTTPException(409, "ใบเสร็จนี้บันทึกไปแล้ว")
        sets, params = [], []
        if "merchant" in changes:
            sets.append("merchant = ?")
            params.append((changes["merchant"] or "").strip())
        if "amount" in changes:
            sets.append("amount_satang = ?")
            params.append(to_satang(changes["amount"]) if changes["amount"] else None)
        if "date" in changes and changes["date"]:
            sets.append("date = ?")
            params.append(changes["date"].isoformat())
        if "category_id" in changes and changes["category_id"]:
            check_category(conn, changes["category_id"], "expense")
            sets.append("category_id = ?")
            params.append(changes["category_id"])
        if "included" in changes and changes["included"] is not None:
            sets.append("included = ?")
            params.append(int(changes["included"]))
        if sets:
            conn.execute(f"UPDATE receipts SET {', '.join(sets)} WHERE id = ?", (*params, rid))
        row = conn.execute("SELECT * FROM receipts WHERE id = ?", (rid,)).fetchone()
    return _receipt_dict(row)


@app.delete("/api/receipts/{rid}")
def delete_receipt(rid: int):
    with db.session() as conn:
        row = conn.execute("SELECT * FROM receipts WHERE id = ?", (rid,)).fetchone()
        if row is None:
            raise HTTPException(404, "ไม่พบใบเสร็จ")
        conn.execute("DELETE FROM receipts WHERE id = ?", (rid,))
    _remove_receipt_files(row)
    return {"ok": True}


@app.post("/api/receipts/commit")
def commit_receipts(body: ReceiptCommit):
    """Save reviewed receipts as expense transactions (all or nothing)."""
    total = 0
    with db.session() as conn:
        for item in body.items:
            row = conn.execute("SELECT status FROM receipts WHERE id = ?", (item.id,)).fetchone()
            if row is None:
                raise HTTPException(404, f"ไม่พบใบเสร็จ #{item.id}")
            if row["status"] != "pending":
                raise HTTPException(409, f"ใบเสร็จ #{item.id} บันทึกไปแล้ว")
            check_category(conn, item.category_id, "expense")
            satang = to_satang(item.amount)
            merchant = item.merchant.strip()
            cur = conn.execute(
                "INSERT INTO transactions (type, amount_satang, category_id, date, note) VALUES ('expense', ?, ?, ?, ?)",
                (satang, item.category_id, item.date.isoformat(), merchant or "ใบเสร็จ"),
            )
            conn.execute(
                """UPDATE receipts SET status = 'saved', transaction_id = ?, amount_satang = ?, date = ?,
                          category_id = ?, merchant = ? WHERE id = ?""",
                (cur.lastrowid, satang, item.date.isoformat(), item.category_id, merchant, item.id),
            )
            total += satang
    return {"saved": len(body.items), "total": baht(total)}


def _receipt_path(rid: int, field_name: str) -> tuple[Path, str]:
    with db.session() as conn:
        row = conn.execute("SELECT * FROM receipts WHERE id = ?", (rid,)).fetchone()
    if row is None:
        raise HTTPException(404, "ไม่พบใบเสร็จ")
    name = row[field_name] or row["image_file"]
    path = db.RECEIPTS_DIR / name
    if not RECEIPT_FILE_RE.match(name) or not path.exists():
        raise HTTPException(404, "ไม่พบไฟล์ใบเสร็จ")
    return path, row["original_name"]


@app.get("/api/receipts/{rid}/image")
def receipt_image(rid: int):
    path, _ = _receipt_path(rid, "image_file")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/receipts/{rid}/file")
def receipt_file(rid: int):
    path, original = _receipt_path(rid, "source_file")
    media = "application/pdf" if path.suffix == ".pdf" else "image/jpeg"
    return FileResponse(path, media_type=media, content_disposition_type="inline",
                        filename=original or path.name)


# --------------------------------------------------------------------------- #
# Full backup / restore  (.zip = database + receipt images, .db = database only)
# --------------------------------------------------------------------------- #
MAX_RESTORE_BYTES = 2 * 1024 * 1024 * 1024
MAX_DB_BYTES = 256 * 1024 * 1024  # largest finance.db accepted from a .zip (a real one is a few MB)
MAX_RECEIPT_RATIO = 10  # backups store receipt JPG/PDF uncompressed; a much higher ratio means a zip bomb


def _copy_db(src: sqlite3.Connection, dest_path: Path | str) -> None:
    dst = sqlite3.connect(str(dest_path))
    try:
        src.backup(dst)
    finally:
        dst.close()


def _tmp_path(suffix: str) -> str:
    fd, tmp = tempfile.mkstemp(suffix=suffix, prefix=".tmp-", dir=db.DATA_DIR)
    os.close(fd)
    return tmp


def _snapshot_db() -> str:
    tmp = _tmp_path(".db")
    src = db.connect()
    try:
        _copy_db(src, tmp)
    finally:
        src.close()
    return tmp


@app.get("/api/backup.db")
def backup_db():
    tmp = _snapshot_db()
    name = f"finance-backup-{now_local():%Y%m%d-%H%M%S}.db"
    return FileResponse(tmp, filename=name, media_type="application/octet-stream", background=BackgroundTask(os.remove, tmp))


def _build_backup_zip() -> str:
    snap = _snapshot_db()
    out = _tmp_path(".zip")
    try:
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(snap, "finance.db")
            for f in sorted(db.RECEIPTS_DIR.iterdir()):
                if RECEIPT_FILE_RE.match(f.name):
                    z.write(f, f"receipts/{f.name}", compress_type=zipfile.ZIP_STORED)  # jpg/pdf don't shrink
    finally:
        os.remove(snap)
    return out


@app.get("/api/backup.zip")
def backup_zip():
    out = _build_backup_zip()
    name = f"finance-backup-{now_local():%Y%m%d-%H%M%S}.zip"
    return FileResponse(out, filename=name, media_type="application/zip", background=BackgroundTask(os.remove, out))


def _restore_db_file(path: str) -> str:
    try:
        src = sqlite3.connect(path)
        try:
            ok = src.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            if not ok or not db.has_expected_tables(src):
                raise HTTPException(400, "ไฟล์สำรองไม่ถูกต้องหรือเสียหาย")
            if migrate.schema_version(src) > migrate.latest_version():
                raise HTTPException(400, "ไฟล์สำรองนี้มาจากแอปเวอร์ชันใหม่กว่า — อัปเดตแอปก่อนแล้วค่อยกู้คืน")
            live = db.connect()
            try:
                safety = db.DATA_DIR / f"before-restore-{now_local():%Y%m%d-%H%M%S}.db"
                _copy_db(live, safety)  # keep a copy of current data, just in case
                src.backup(live)
            finally:
                live.close()
        finally:
            src.close()
    except sqlite3.DatabaseError:
        raise HTTPException(400, "ไฟล์นี้ไม่ใช่ไฟล์สำรองของแอป") from None
    db.init()
    return safety.name


def _extract_capped(z: zipfile.ZipFile, info: zipfile.ZipInfo, target: Path | str, limit: int) -> None:
    written = 0
    try:
        with z.open(info) as src, open(target, "wb") as dst:
            while chunk := src.read(1 << 20):
                written += len(chunk)
                if written > limit:
                    raise HTTPException(400, "ไฟล์ข้างใน .zip ใหญ่ผิดปกติ — ไม่กู้คืน")
                dst.write(chunk)
    except BaseException:
        Path(target).unlink(missing_ok=True)
        raise


def _do_restore(upload_path: str) -> dict:
    with open(upload_path, "rb") as f:
        head = f.read(16)
    if head.startswith(b"SQLite format 3\x00"):
        return {"ok": True, "safety_copy": _restore_db_file(upload_path), "receipts_restored": 0}
    if not head.startswith(b"PK"):
        raise HTTPException(400, "ไฟล์นี้ไม่ใช่ไฟล์สำรองของแอป (.zip หรือ .db)")
    try:
        z = zipfile.ZipFile(upload_path)
    except zipfile.BadZipFile:
        raise HTTPException(400, "ไฟล์ .zip เสียหาย") from None
    with z:
        if "finance.db" not in z.namelist():
            raise HTTPException(400, "ในไฟล์ .zip ไม่มี finance.db")
        db_info = z.getinfo("finance.db")
        receipt_infos = [
            i for i in z.infolist()
            if i.filename.startswith("receipts/") and RECEIPT_FILE_RE.match(i.filename.rsplit("/", 1)[-1])
        ]
        # Check unpacked sizes before touching anything (zipfile never returns more than the declared size)
        too_big = (
            db_info.file_size > MAX_DB_BYTES
            or any(i.file_size > MAX_RECEIPT_BYTES for i in receipt_infos)
            or any(i.file_size > 1024 * 1024 and i.file_size > MAX_RECEIPT_RATIO * i.compress_size for i in receipt_infos)
            or sum(i.file_size for i in receipt_infos) > MAX_RESTORE_BYTES
        )
        if too_big:
            raise HTTPException(400, "ไฟล์ข้างใน .zip ใหญ่ผิดปกติ — ไม่ใช่ไฟล์สำรองของแอป จึงไม่กู้คืน")

        db_tmp = _tmp_path(".db")
        try:
            _extract_capped(z, db_info, db_tmp, MAX_DB_BYTES)
            safety = _restore_db_file(db_tmp)
        finally:
            os.remove(db_tmp)
        restored = 0
        for info in receipt_infos:
            target = db.RECEIPTS_DIR / info.filename.rsplit("/", 1)[-1]  # name validated: no path tricks possible
            if not target.exists():
                _extract_capped(z, info, target, MAX_RECEIPT_BYTES)
                restored += 1
    return {"ok": True, "safety_copy": safety, "receipts_restored": restored}


@app.post("/api/restore")
async def restore(request: Request):
    tmp = _tmp_path(".upload")
    size = 0
    try:
        with open(tmp, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_RESTORE_BYTES:
                    raise HTTPException(413, "ไฟล์ใหญ่เกินไป")
                f.write(chunk)
        if size == 0:
            raise HTTPException(400, "ไม่มีไฟล์")
        return await run_in_threadpool(_do_restore, tmp)
    finally:
        os.remove(tmp)


# --------------------------------------------------------------------------- #
# Web UI
# --------------------------------------------------------------------------- #
@app.middleware("http")
async def no_cache_html(request: Request, call_next):
    response = await call_next(request)
    if request.url.path in ("/", "/index.html"):
        response.headers["Cache-Control"] = "no-cache"
    return response


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
