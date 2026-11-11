"""Findings from the v1.2 review: cross-site writes, DNS rebinding, oversized uploads, zip bombs."""
from __future__ import annotations

import io
import sqlite3
import zipfile

import pytest
from conftest import FIXTURES, png_bytes

from app import main, migrate

EVIL = "https://evil.example"


def empty_db_bytes(tmp_path) -> bytes:
    path = tmp_path / "empty.db"
    conn = sqlite3.connect(path)
    migrate.migrate(conn)
    conn.close()
    return path.read_bytes()


# --- 1. another website must not be able to change data -------------------------------------------------------------

@pytest.mark.parametrize("path, body", [
    ("/api/restore", b"SQLite format 3\x00"),
    ("/api/import", b"date,amount\n2026-11-10,-99999\n"),
    ("/api/receipts", png_bytes()),
])
def test_cross_site_simple_posts_are_refused(raw_client, path, body):
    """A page on another site can send these without a CORS preflight (text/plain body)."""
    r = raw_client.post(path, content=body, headers={"Content-Type": "text/plain", "Origin": EVIL})
    assert r.status_code == 403


def test_restore_from_another_site_cannot_wipe_data(client, raw_client, add_tx, tmp_path):
    add_tx("expense", 59, "2026-11-10", note="BTS")
    r = raw_client.post("/api/restore", content=empty_db_bytes(tmp_path),
                        headers={"Content-Type": "text/plain", "Origin": EVIL, "Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403
    assert [t["note"] for t in client.get("/api/transactions?month=2026-11").json()] == ["BTS"]


def test_writes_need_the_app_header_even_without_origin(raw_client):
    r = raw_client.post("/api/import", content=b"date,amount\n2026-11-10,5\n")
    assert r.status_code == 403


@pytest.mark.parametrize("site", ["cross-site", "same-site"])
def test_fetch_metadata_from_elsewhere_is_refused(client, site):
    r = client.post("/api/import", content=b"date,amount\n2026-11-10,5\n", headers={"Sec-Fetch-Site": site})
    assert r.status_code == 403


def test_the_apps_own_page_can_write(client):
    r = client.post("/api/import", content=b"date,amount\n2026-11-10,5\n",
                    headers={"Origin": "http://localhost", "Sec-Fetch-Site": "same-origin"})
    assert r.status_code == 200 and r.json()["imported"] == 1


def test_delete_from_another_origin_is_refused(client, add_tx):
    tx = add_tx("expense", 59, "2026-11-10")
    assert client.delete(f"/api/transactions/{tx['id']}", headers={"Origin": EVIL}).status_code == 403
    assert client.delete(f"/api/transactions/{tx['id']}", headers={"Origin": "null"}).status_code == 403


def test_reads_and_downloads_need_no_header(raw_client):
    for path in ("/api/health", "/api/categories", "/api/backup.zip", "/api/export.csv", "/"):
        assert raw_client.get(path).status_code == 200, path


# --- 2. DNS rebinding: unknown host names are refused -----------------------------------------------------------------

@pytest.mark.parametrize("host", ["rebind.attacker.example", "rebind.attacker.example:8080", "localhost.evil.example"])
def test_unknown_host_names_are_refused(raw_client, host):
    for path in ("/api/backup.zip", "/api/transactions", "/"):
        assert raw_client.get(path, headers={"Host": host}).status_code == 400


@pytest.mark.parametrize("host", ["localhost:8080", "127.0.0.1:8080", "192.168.1.25:8080", "[::1]:8080", "10.0.0.7"])
def test_localhost_and_ip_addresses_are_allowed(raw_client, host):
    assert raw_client.get("/api/health", headers={"Host": host}).status_code == 200


def test_extra_host_names_come_from_settings(raw_client, monkeypatch):
    monkeypatch.setattr(main, "ALLOWED_HOSTS", main.ALLOWED_HOSTS | {"mypc.local"})
    assert raw_client.get("/api/health", headers={"Host": "mypc.local:8080"}).status_code == 200
    assert raw_client.get("/api/health", headers={"Host": "otherpc.local"}).status_code == 400


def test_write_origin_must_match_the_host_actually_used(client):
    headers = {"Host": "192.168.1.25:8080", "Origin": "http://192.168.1.25:8080"}
    assert client.post("/api/import", content=b"date,amount\n2026-11-10,5\n", headers=headers).status_code == 200
    headers["Origin"] = "http://192.168.1.99:8080"
    assert client.post("/api/import", content=b"date,amount\n2026-11-10,5\n", headers=headers).status_code == 403


# --- 3. oversized uploads are refused before they are read into memory ----------------------------------------------

def test_oversized_receipt_is_refused(client, monkeypatch):
    monkeypatch.setattr(main, "MAX_RECEIPT_BYTES", 1000)
    assert client.post("/api/receipts", content=b"x" * 5000).status_code == 413


def test_oversized_csv_is_refused(client, monkeypatch):
    monkeypatch.setattr(main, "MAX_UPLOAD_BYTES", 1000)
    assert client.post("/api/import", content=b"x" * 5000).status_code == 413


def test_body_longer_than_declared_limit_is_cut_off(client, monkeypatch):
    """No Content-Length (chunked upload): the stream is still capped."""
    monkeypatch.setattr(main, "MAX_RECEIPT_BYTES", 1000)

    def chunks():
        for _ in range(10):
            yield b"x" * 500
    assert client.post("/api/receipts", content=chunks()).status_code == 413


# --- 4. zip restore does not unpack oversized members ---------------------------------------------------------------

def bomb_zip(size: int) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z, z.open("finance.db", "w", force_zip64=True) as f:
        for _ in range(size // (1 << 16)):
            f.write(b"\0" * (1 << 16))
    return buf.getvalue()


def test_zip_bomb_is_refused_without_unpacking(client, add_tx, data_dir, monkeypatch):
    add_tx("expense", 59, "2026-11-10", note="BTS")
    monkeypatch.setattr(main, "MAX_DB_BYTES", 256 * 1024)
    bomb = bomb_zip(4 * 1024 * 1024)
    assert len(bomb) < 64 * 1024  # tiny file, large when unpacked

    r = client.post("/api/restore", content=bomb)
    assert r.status_code == 400 and "ใหญ่ผิดปกติ" in r.json()["detail"]
    assert not list(data_dir.glob(".tmp-*")), "temporary files must be cleaned up"
    assert [t["note"] for t in client.get("/api/transactions?month=2026-11").json()] == ["BTS"]


def test_oversized_receipt_inside_zip_stops_restore_before_db_changes(client, add_tx, monkeypatch):
    add_tx("expense", 59, "2026-11-10", note="BTS")
    backup = client.get("/api/backup.zip").content
    add_tx("expense", 1000, "2026-11-10", note="after backup")

    monkeypatch.setattr(main, "MAX_RECEIPT_BYTES", 100)
    buf = io.BytesIO(backup)
    with zipfile.ZipFile(buf, "a") as z:
        z.writestr("receipts/" + "a" * 32 + ".jpg", b"x" * 1000)
    assert client.post("/api/restore", content=buf.getvalue()).status_code == 400
    notes = sorted(t["note"] for t in client.get("/api/transactions?month=2026-11").json())
    assert notes == ["BTS", "after backup"]  # nothing was restored


def test_receipts_that_compress_like_a_bomb_are_refused(client, add_tx):
    add_tx("expense", 59, "2026-11-10", note="BTS")
    buf = io.BytesIO(client.get("/api/backup.zip").content)
    with zipfile.ZipFile(buf, "a", zipfile.ZIP_DEFLATED) as z:
        z.writestr("receipts/" + "b" * 32 + ".jpg", b"\0" * (5 * 1024 * 1024))  # 5 MB of zeros, ~5 KB packed
    assert client.post("/api/restore", content=buf.getvalue()).status_code == 400


def test_real_backup_with_receipt_images_still_restores(client, fake_ocr, data_dir):
    client.post("/api/receipts", content=(FIXTURES / "receipt-restaurant.jpg").read_bytes())
    backup = client.get("/api/backup.zip").content
    for f in (data_dir / "receipts").iterdir():
        f.unlink()
    r = client.post("/api/restore", content=backup)
    assert r.status_code == 200 and r.json()["receipts_restored"] == 1

