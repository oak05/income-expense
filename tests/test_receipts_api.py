"""Receipts API: upload, review, commit, cleanup — and real OCR when Tesseract is installed."""
from __future__ import annotations

import datetime as dt

import pytest
from conftest import FIXTURES, png_bytes, upload

from app import main
from app import receipts as rc


@pytest.fixture(autouse=True)
def frozen_today(monkeypatch):
    """Receipt dates are judged against "today"; pin it so the tests don't age."""
    monkeypatch.setattr(main, "now_local", lambda: dt.datetime(2026, 11, 10, 12, 0, tzinfo=main.TZ))


def test_upload_returns_a_parsed_draft(client, categories, fake_ocr):
    r = upload(client, png_bytes())
    assert r.status_code == 201, r.text
    d = r.json()
    assert (d["merchant"], d["amount"], d["date"], d["status"]) == ("7-Eleven", 125.0, "2026-11-09", "pending")
    assert d["category_id"] == categories[("อาหารและเครื่องดื่ม", "expense")]
    assert client.get(d["image_url"]).headers["content-type"] == "image/jpeg"
    assert [x["id"] for x in client.get("/api/receipts").json()] == [d["id"]]


def test_unreadable_file_is_rejected(client):
    r = upload(client, b"not an image", "notes.txt")
    assert r.status_code == 400 and "JPG" in r.json()["detail"]


def test_missing_total_is_flagged_not_rejected(client, fake_ocr):
    fake_ocr["text"] = "ร้านป้าแดง\nขอบคุณค่ะ"
    d = upload(client, png_bytes()).json()
    assert d["amount"] is None and "no_amount" in d["flags"] and "no_date" in d["flags"]


def test_draft_edits_are_kept(client, fake_ocr):
    d = upload(client, png_bytes()).json()
    r = client.put(f"/api/receipts/{d['id']}", json={"amount": "130", "included": False, "merchant": "ร้าน A"})
    assert r.status_code == 200
    again = client.get("/api/receipts").json()[0]
    assert (again["amount"], again["included"], again["merchant"]) == (130.0, False, "ร้าน A")


def test_commit_is_all_or_nothing(client, categories, fake_ocr):
    a = upload(client, png_bytes()).json()
    b = upload(client, png_bytes()).json()
    food = categories[("อาหารและเครื่องดื่ม", "expense")]
    salary = categories[("เงินเดือน", "income")]

    bad = {"items": [
        {"id": a["id"], "amount": "125", "date": "2026-11-09", "category_id": food},
        {"id": b["id"], "amount": "50", "date": "2026-11-09", "category_id": salary},  # income category
    ]}
    assert client.post("/api/receipts/commit", json=bad).status_code == 400
    assert client.get("/api/transactions?month=2026-11").json() == []

    bad["items"][1]["category_id"] = food
    r = client.post("/api/receipts/commit", json=bad)
    assert r.json() == {"saved": 2, "total": 175.0}
    txs = client.get("/api/transactions?month=2026-11").json()
    assert sorted(t["receipt_id"] for t in txs) == sorted([a["id"], b["id"]])
    assert client.get("/api/receipts").json() == []
    assert client.post("/api/receipts/commit", json=bad).status_code == 409


def test_deleting_a_transaction_removes_its_receipt_files(client, categories, fake_ocr, data_dir):
    d = upload(client, png_bytes()).json()
    food = categories[("อาหารและเครื่องดื่ม", "expense")]
    client.post("/api/receipts/commit", json={"items": [
        {"id": d["id"], "amount": "125", "date": "2026-11-09", "category_id": food}]})
    tx = client.get("/api/transactions?month=2026-11").json()[0]
    assert len(list((data_dir / "receipts").iterdir())) == 1

    assert client.delete(f"/api/transactions/{tx['id']}").json()["receipts_removed"] == 1
    assert list((data_dir / "receipts").iterdir()) == []
    assert client.get(f"/api/receipts/{d['id']}/image").status_code == 404


def test_pdf_with_text_layer_skips_ocr(client, monkeypatch):
    def no_ocr(img):
        raise AssertionError("OCR should not run for a PDF that has text")
    monkeypatch.setattr(rc, "ocr_image", no_ocr)
    d = upload(client, (FIXTURES / "ereceipt-shopee.pdf").read_bytes(), "order.pdf").json()
    assert (d["text_source"], d["merchant"], d["amount"], d["date"]) == ("pdf-text", "Shopee", 378.0, "2026-11-07")
    assert client.get(d["file_url"]).headers["content-type"] == "application/pdf"


@pytest.mark.skipif(not rc.ocr_available(), reason="Tesseract OCR is not installed")
@pytest.mark.parametrize("fixture, merchant, amount", [
    ("receipt-restaurant.jpg", "Somtum Der", 364.87),
    ("receipt-7eleven-th.jpg", "7-Eleven", 125.0),
])
def test_real_ocr_reads_photographed_receipts(client, fixture, merchant, amount):
    d = upload(client, (FIXTURES / fixture).read_bytes(), fixture).json()
    assert d["text_source"] == "ocr"
    assert (d["merchant"], d["amount"]) == (merchant, amount)
