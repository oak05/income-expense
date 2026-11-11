"""SQLite storage for the income/expense app. The schema lives in app/migrations/."""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from . import migrate

DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
DB_PATH = DATA_DIR / "finance.db"
RECEIPTS_DIR = DATA_DIR / "receipts"

DEFAULT_CATEGORIES = [
    # (name, type, color)
    ("อาหารและเครื่องดื่ม", "expense", "#E07A3F"),
    ("เดินทาง", "expense", "#3A86C8"),
    ("ที่พัก / ค่าเช่า", "expense", "#7B61C9"),
    ("ค่าน้ำ ค่าไฟ ค่าเน็ต", "expense", "#D4A72C"),
    ("ช้อปปิ้ง", "expense", "#D2588E"),
    ("สุขภาพ", "expense", "#2E9E83"),
    ("บันเทิง", "expense", "#C8463D"),
    ("การศึกษา", "expense", "#4F5BD5"),
    ("อื่นๆ", "expense", "#7A8290"),
    ("เงินเดือน", "income", "#2F8F5B"),
    ("งานฟรีแลนซ์", "income", "#1F8A8A"),
    ("โบนัส", "income", "#7FA33A"),
    ("ขายของ", "income", "#3E9E3E"),
    ("ดอกเบี้ย / เงินปันผล", "income", "#4C7A5A"),
    ("อื่นๆ", "income", "#7A8290"),
]


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path or DB_PATH), timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def session():
    """One connection per request; commits on success, rolls back on error."""
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init() -> list[int]:
    """Create folders, bring the schema up to date, seed default categories. Returns migrations applied."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RECEIPTS_DIR.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        ran = migrate.migrate(conn)
        (count,) = conn.execute("SELECT COUNT(*) FROM categories").fetchone()
        if count == 0:
            conn.executemany(
                "INSERT INTO categories (name, type, color, sort_order) VALUES (?, ?, ?, ?)",
                [(n, t, c, i) for i, (n, t, c) in enumerate(DEFAULT_CATEGORIES)],
            )
            conn.commit()
        return ran
    finally:
        conn.close()


def has_expected_tables(conn: sqlite3.Connection) -> bool:
    return {"categories", "transactions"} <= migrate.tables(conn)
