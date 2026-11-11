"""Ledger API: transactions, categories, summaries, CSV, backup/restore, auth."""
from __future__ import annotations

import io
import zipfile

from app import main


def test_health_reports_version_and_schema(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["version"] == main.APP_VERSION
    assert body["schema"] >= 2


def test_default_categories_are_seeded_once(client):
    cats = client.get("/api/categories").json()
    assert sum(c["type"] == "expense" for c in cats) == 9
    assert sum(c["type"] == "income" for c in cats) == 6


def test_transaction_crud_rounds_to_satang(client, categories, add_tx):
    tx = add_tx("expense", "120.505", "2026-11-05", note="ข้าวมันไก่")
    assert tx["amount"] == 120.51
    assert tx["receipt_id"] is None

    food = categories[("อาหารและเครื่องดื่ม", "expense")]
    r = client.put(f"/api/transactions/{tx['id']}", json={
        "type": "expense", "amount": "99", "date": "2026-11-06", "category_id": food, "note": "แก้แล้ว"})
    assert r.status_code == 200 and r.json()["amount"] == 99.0 and r.json()["date"] == "2026-11-06"

    assert client.delete(f"/api/transactions/{tx['id']}").status_code == 200
    assert client.delete(f"/api/transactions/{tx['id']}").status_code == 404


def test_validation_messages_are_thai(client, categories):
    salary = categories[("เงินเดือน", "income")]
    r = client.post("/api/transactions", json={"type": "expense", "amount": "10", "date": "2026-11-01", "category_id": salary})
    assert r.status_code == 400 and "หมวดหมู่ไม่ตรง" in r.json()["detail"]

    r = client.post("/api/transactions", json={"type": "expense", "amount": "-5", "date": "2026-13-01", "category_id": salary})
    assert r.status_code == 422 and "จำนวนเงิน" in r.json()["detail"] and "วันที่" in r.json()["detail"]

    assert client.get("/api/summary?month=2026-13").status_code == 400


def test_search_filters_by_note(client, add_tx):
    add_tx("expense", 60, "2026-11-02", note="ข้าวมันไก่")
    add_tx("expense", 45, "2026-11-03", note="กาแฟ")
    hits = client.get("/api/transactions", params={"month": "2026-11", "q": "ไก่"}).json()
    assert [t["note"] for t in hits] == ["ข้าวมันไก่"]


def test_month_summary_previous_and_cumulative(client, add_tx):
    add_tx("income", 30000, "2026-10-01")
    add_tx("expense", 1000, "2026-10-15")
    add_tx("income", 28000, "2026-11-01")
    add_tx("expense", 120.5, "2026-11-05")

    s = client.get("/api/summary?month=2026-11").json()
    assert s["totals"] == {"income": 28000.0, "expense": 120.5, "balance": 27879.5, "count": 2}
    assert s["previous"]["expense"] == 1000.0
    assert s["cumulative_balance"] == 30000 - 1000 + 27879.5
    assert len(s["daily"]) == 30 and s["daily"][4]["expense"] == 120.5

    y = client.get("/api/yearly?year=2026").json()
    assert y["months"][9]["income"] == 30000.0 and y["totals"]["count"] == 4


def test_category_delete_moves_transactions(client, categories, add_tx):
    tx = add_tx("expense", 50, "2026-11-01", category="บันเทิง")
    cid, other = categories[("บันเทิง", "expense")], categories[("อื่นๆ", "expense")]

    r = client.delete(f"/api/categories/{cid}")
    assert r.status_code == 409

    r = client.delete(f"/api/categories/{cid}?move_to={other}")
    assert r.status_code == 200 and r.json()["moved"] == 1
    moved = client.get("/api/transactions?month=2026-11").json()[0]
    assert moved["id"] == tx["id"] and moved["category_id"] == other


def test_last_category_of_a_type_cannot_be_deleted(client, categories):
    income_ids = [cid for (name, t), cid in categories.items() if t == "income"]
    for cid in income_ids[:-1]:
        assert client.delete(f"/api/categories/{cid}").status_code == 200
    r = client.delete(f"/api/categories/{income_ids[-1]}")
    assert r.status_code == 400


def test_csv_round_trip_skips_rows_already_present(client, add_tx):
    add_tx("expense", 60, "2026-11-02", note="ข้าวมันไก่")
    add_tx("income", 28000, "2026-11-01", note="เงินเดือน")

    csv_bytes = client.get("/api/export.csv").content
    assert csv_bytes.startswith("﻿".encode())  # BOM for Excel
    r = client.post("/api/import", content=csv_bytes).json()
    assert r == {"imported": 0, "skipped_duplicates": 2, "errors": [], "error_count": 0}


def test_csv_import_handles_thai_excel_formats(client):
    text = ("วันที่,ประเภท,หมวดหมู่,จำนวนเงิน,หมายเหตุ\r\n"
            "10/11/2569,รายจ่าย,กาแฟ,\"1,250.00\",ลาเต้\r\n"
            "10/11/2569,รายจ่าย,กาแฟ,\"1,250.00\",ลาเต้\r\n"
            "2026-11-09,,,-300,ถอนเงิน\r\n"
            "31/02/2026,รายจ่าย,x,5,bad\r\n")
    r = client.post("/api/import", content=text.encode("cp874")).json()
    assert r["imported"] == 3 and r["error_count"] == 1
    rows = client.get("/api/transactions?month=2026-11").json()
    assert sum(t["note"] == "ลาเต้" for t in rows) == 2  # identical rows inside one file are both kept
    withdrawal = next(t for t in rows if t["note"] == "ถอนเงิน")
    assert withdrawal["type"] == "expense" and withdrawal["amount"] == 300.0


def test_backup_zip_and_restore_round_trip(client, add_tx):
    add_tx("expense", 59, "2026-11-10", note="BTS")
    backup = client.get("/api/backup.zip")
    assert backup.status_code == 200
    assert "finance.db" in zipfile.ZipFile(io.BytesIO(backup.content)).namelist()

    add_tx("expense", 1000, "2026-11-10", note="หลังสำรอง")
    r = client.post("/api/restore", content=backup.content)
    assert r.status_code == 200 and r.json()["safety_copy"].startswith("before-restore-")
    notes = [t["note"] for t in client.get("/api/transactions?month=2026-11").json()]
    assert notes == ["BTS"]


def test_restore_rejects_files_that_are_not_backups(client):
    assert client.post("/api/restore", content=b"hello").status_code == 400
    assert client.post("/api/restore", content=b"PK\x03\x04broken").status_code == 400


def test_zip_restore_cannot_write_outside_receipts(client, data_dir):
    good = client.get("/api/backup.zip").content
    buf = io.BytesIO(good)
    with zipfile.ZipFile(buf, "a") as z:
        z.writestr("receipts/../../escape.jpg", b"x")
        z.writestr("receipts/0123456789abcdef0123456789abcdef.exe", b"x")
    assert client.post("/api/restore", content=buf.getvalue()).status_code == 200
    assert not (data_dir.parent / "escape.jpg").exists()
    assert not any(p.suffix == ".exe" for p in (data_dir / "receipts").iterdir())


def test_password_protects_everything_but_health(client, monkeypatch):
    monkeypatch.setattr(main, "APP_PASSWORD", "s3cret")
    assert client.get("/api/categories").status_code == 401
    assert client.get("/api/categories", auth=("admin", "wrong")).status_code == 401
    assert client.get("/api/categories", auth=("admin", "s3cret")).status_code == 200
    assert client.get("/api/health").status_code == 200


def test_web_pages_are_served(client):
    for path in ("/", "/receipts.html", "/common.js", "/vendor/chart.umd.min.js"):
        assert client.get(path).status_code == 200, path
