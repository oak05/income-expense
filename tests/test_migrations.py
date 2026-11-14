"""Schema migrations: fresh install, upgrading old databases, failures, newer data."""
from __future__ import annotations

import shutil
import sqlite3

import pytest

from app import migrate

V10_SCHEMA = (migrate.MIGRATIONS_DIR / "0001_initial.sql").read_text(encoding="utf-8")
V11_SCHEMA = V10_SCHEMA + (migrate.MIGRATIONS_DIR / "0002_receipts.sql").read_text(encoding="utf-8")
NEXT = migrate.latest_version() + 1  # number for a test-only migration added after the real ones


def connect(path):
    return sqlite3.connect(str(path))


@pytest.fixture
def migrations_copy(tmp_path):
    """A private copy of app/migrations that a test may add files to."""
    d = tmp_path / "migrations"
    shutil.copytree(migrate.MIGRATIONS_DIR, d)
    return d


def test_fresh_database_gets_every_migration_once(tmp_path):
    conn = connect(tmp_path / "a.db")
    assert migrate.migrate(conn) == [1, 2, 3]
    assert {"categories", "transactions", "receipts", "schema_migrations"} <= migrate.tables(conn)
    assert migrate.migrate(conn) == []
    assert migrate.schema_version(conn) == migrate.latest_version()


def test_v10_database_is_recognised_then_upgraded(tmp_path):
    conn = connect(tmp_path / "v10.db")
    conn.executescript(V10_SCHEMA)
    conn.execute("INSERT INTO categories (name, type) VALUES ('อาหาร', 'expense')")
    conn.execute("INSERT INTO transactions (type, amount_satang, category_id, date) VALUES ('expense', 5900, 1, '2026-11-10')")
    conn.commit()

    assert migrate.migrate(conn) == [2, 3]  # 0001 recorded as already present, 0002 + 0003 applied
    assert sorted(migrate.applied(conn)) == [1, 2, 3]
    assert conn.execute("SELECT amount_satang FROM transactions").fetchone() == (5900,)
    assert conn.execute("SELECT budget_satang FROM categories").fetchone() == (None,)


def test_v11_database_only_gets_budgets(tmp_path):
    conn = connect(tmp_path / "v11.db")
    conn.executescript(V11_SCHEMA)
    assert migrate.migrate(conn) == [3]
    assert sorted(migrate.applied(conn)) == [1, 2, 3]


def test_budget_column_rejects_zero_and_negative(tmp_path):
    conn = connect(tmp_path / "a.db")
    migrate.migrate(conn)
    conn.execute("INSERT INTO categories (name, type, budget_satang) VALUES ('ok', 'expense', 600000)")
    for bad in (0, -100):
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO categories (name, type, budget_satang) VALUES (?, 'expense', ?)", (f"b{bad}", bad))


def test_new_migration_can_change_an_existing_table(tmp_path, migrations_copy):
    conn = connect(tmp_path / "a.db")
    migrate.migrate(conn, migrations_copy)
    conn.execute("INSERT INTO categories (name, type) VALUES ('x', 'expense')")
    conn.execute("INSERT INTO transactions (type, amount_satang, category_id, date) VALUES ('expense', 100, 1, '2026-11-01')")
    conn.commit()

    (migrations_copy / f"{NEXT:04d}_add_account.sql").write_text(
        "ALTER TABLE transactions ADD COLUMN account_id INTEGER;\nUPDATE transactions SET account_id = 1;", encoding="utf-8")
    assert migrate.migrate(conn, migrations_copy) == [NEXT]
    assert conn.execute("SELECT account_id, amount_satang FROM transactions").fetchone() == (1, 100)


def test_failed_migration_changes_nothing(tmp_path, migrations_copy):
    conn = connect(tmp_path / "a.db")
    migrate.migrate(conn, migrations_copy)
    (migrations_copy / f"{NEXT:04d}_broken.sql").write_text(
        "CREATE TABLE half_done (x INTEGER);\nINSERT INTO no_such_table VALUES (1);", encoding="utf-8")

    with pytest.raises(migrate.MigrationError, match=f"{NEXT:04d}_broken"):
        migrate.migrate(conn, migrations_copy)
    assert "half_done" not in migrate.tables(conn)
    assert NEXT not in migrate.applied(conn)


def test_migration_breaking_foreign_keys_is_rolled_back(tmp_path, migrations_copy):
    conn = connect(tmp_path / "a.db")
    migrate.migrate(conn, migrations_copy)
    (migrations_copy / f"{NEXT:04d}_orphans.sql").write_text(
        "INSERT INTO transactions (type, amount_satang, category_id, date) VALUES ('expense', 1, 999, '2026-01-01');",
        encoding="utf-8")
    with pytest.raises(migrate.MigrationError, match="foreign key"):
        migrate.migrate(conn, migrations_copy)
    assert conn.execute("SELECT COUNT(*) FROM transactions").fetchone() == (0,)


def test_database_from_a_newer_app_is_refused(tmp_path):
    conn = connect(tmp_path / "a.db")
    migrate.migrate(conn)
    conn.execute("INSERT INTO schema_migrations (version, name) VALUES (99, 'future')")
    conn.commit()
    with pytest.raises(migrate.MigrationError, match="update the app"):
        migrate.migrate(conn)


def test_badly_named_file_is_rejected(migrations_copy):
    (migrations_copy / "3_oops.sql").write_text("SELECT 1;", encoding="utf-8")
    with pytest.raises(migrate.MigrationError, match="file name"):
        migrate.discover(migrations_copy)


def test_restoring_a_backup_from_a_newer_app_is_refused(client, tmp_path):
    newer = tmp_path / "newer.db"
    conn = connect(newer)
    migrate.migrate(conn)
    conn.execute("INSERT INTO schema_migrations (version, name) VALUES (99, 'future')")
    conn.commit()
    conn.close()
    r = client.post("/api/restore", content=newer.read_bytes())
    assert r.status_code == 400 and "เวอร์ชันใหม่กว่า" in r.json()["detail"]


def test_restoring_an_old_v10_backup_upgrades_it(client, tmp_path):
    old = tmp_path / "old.db"
    conn = connect(old)
    conn.executescript(V10_SCHEMA)
    conn.execute("INSERT INTO categories (name, type) VALUES ('อาหาร', 'expense')")
    conn.execute("INSERT INTO transactions (type, amount_satang, category_id, date, note) VALUES ('expense', 5900, 1, '2026-11-10', 'เก่า')")
    conn.commit()
    conn.close()

    assert client.post("/api/restore", content=old.read_bytes()).status_code == 200
    assert [t["note"] for t in client.get("/api/transactions?month=2026-11").json()] == ["เก่า"]
    assert client.get("/api/receipts").status_code == 200  # receipts table exists after the upgrade
