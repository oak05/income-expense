"""Shared fixtures: every test gets its own empty data folder and a running app."""
from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import db, main
from app import receipts as rc

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DATA_DIR", tmp_path)
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "finance.db")
    monkeypatch.setattr(db, "RECEIPTS_DIR", tmp_path / "receipts")
    return tmp_path


APP_HEADERS = {"X-Requested-With": "fetch"}  # what the app's own pages send


@pytest.fixture
def client(data_dir):
    """Behaves like the app's own web page: same host, write header included."""
    with TestClient(main.app, base_url="http://localhost", headers=APP_HEADERS) as c:
        yield c


@pytest.fixture
def raw_client(data_dir):
    """A bare HTTP client: no app header, so tests can play the part of another website or a script."""
    with TestClient(main.app, base_url="http://localhost") as c:
        yield c


@pytest.fixture
def categories(client):
    """{(name, type): id} for the seeded default categories."""
    return {(c["name"], c["type"]): c["id"] for c in client.get("/api/categories").json()}


@pytest.fixture
def add_tx(client, categories):
    def _add(type_, amount, date, category=None, note=""):
        category = category or ("อาหารและเครื่องดื่ม" if type_ == "expense" else "เงินเดือน")
        r = client.post("/api/transactions", json={
            "type": type_, "amount": str(amount), "date": date,
            "category_id": categories[(category, type_)], "note": note,
        })
        assert r.status_code == 201, r.text
        return r.json()
    return _add


@pytest.fixture
def fake_ocr(monkeypatch):
    """Replace Tesseract with a fixed text so API tests don't depend on OCR quality."""
    state = {"text": "7-ELEVEN\nรวม 2 ชิ้น 125.00\nเงินสด 200.00\nทอน 75.00\n09/11/2026 12:30"}
    monkeypatch.setattr(rc, "ocr_image", lambda img: state["text"])
    return state


def png_bytes(size=(300, 500)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, "white").save(buf, "PNG")
    return buf.getvalue()


def upload(client, raw: bytes, name="receipt.png"):
    return client.post("/api/receipts", content=raw, headers={"x-filename": name})
