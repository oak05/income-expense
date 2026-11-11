"""Versioned schema migrations.

Files in app/migrations named NNNN_short_name.sql are applied in order. Each one runs in its
own transaction together with the row that records it in `schema_migrations`, so a failed
migration leaves the database exactly as it was.

    python -m app.migrate status   # what is applied / pending
    python -m app.migrate up       # apply pending migrations (the app also does this on start)
"""
from __future__ import annotations

import re
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"
FILE_RE = re.compile(r"^(\d{4})_([a-z0-9_]+)\.sql$")

TRACKING_TABLE = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
)
"""

# Databases made by app v1.0 / v1.1 have their tables but no migration history.
# version -> a table whose presence proves that migration's changes are already there.
LEGACY_MARKERS = {1: "transactions", 2: "receipts"}


class MigrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    path: Path

    @property
    def label(self) -> str:
        return f"{self.version:04d}_{self.name}"

    def sql(self) -> str:
        return self.path.read_text(encoding="utf-8")


def discover(directory: Path = MIGRATIONS_DIR) -> list[Migration]:
    found: list[Migration] = []
    for path in sorted(directory.glob("*.sql")):
        m = FILE_RE.match(path.name)
        if not m:
            raise MigrationError(f"migration file name must look like 0003_add_budgets.sql: {path.name}")
        found.append(Migration(int(m.group(1)), m.group(2), path))
    versions = [m.version for m in found]
    if len(versions) != len(set(versions)):
        raise MigrationError("two migration files share the same number")
    return found


def latest_version(directory: Path = MIGRATIONS_DIR) -> int:
    return max((m.version for m in discover(directory)), default=0)


def tables(conn: sqlite3.Connection) -> set[str]:
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def schema_version(conn: sqlite3.Connection) -> int:
    """Highest applied migration (0 when the database has no history table)."""
    if "schema_migrations" not in tables(conn):
        return 0
    (v,) = conn.execute("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").fetchone()
    return v


def applied(conn: sqlite3.Connection) -> dict[int, tuple[str, str]]:
    if "schema_migrations" not in tables(conn):
        return {}
    return {r[0]: (r[1], r[2]) for r in conn.execute("SELECT version, name, applied_at FROM schema_migrations")}


def _baseline_legacy(conn: sqlite3.Connection, migrations: list[Migration]) -> list[int]:
    if applied(conn):
        return []
    have = tables(conn)
    marked = []
    for m in migrations:
        marker = LEGACY_MARKERS.get(m.version)
        if not marker or marker not in have:
            break
        conn.execute("INSERT INTO schema_migrations (version, name) VALUES (?, ?)", (m.version, m.name))
        marked.append(m.version)
    conn.commit()
    return marked


def migrate(conn: sqlite3.Connection, directory: Path = MIGRATIONS_DIR) -> list[int]:
    """Apply pending migrations. Returns the versions applied by this call."""
    migrations = discover(directory)
    known = max((m.version for m in migrations), default=0)

    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")  # allows SQLite table rebuilds; checked per migration
    try:
        conn.execute(TRACKING_TABLE)
        conn.commit()
        _baseline_legacy(conn, migrations)

        done = applied(conn)
        newer = sorted(v for v in done if v > known)
        if newer:
            raise MigrationError(
                f"the database is at schema version {max(newer)} but this app only knows up to {known} "
                "— update the app before using this data"
            )

        ran = []
        for m in migrations:
            if m.version in done:
                continue
            try:
                conn.executescript("BEGIN;\n" + m.sql())
                problems = conn.execute("PRAGMA foreign_key_check").fetchall()
                if problems:
                    raise MigrationError(f"foreign key check failed: {problems[:3]}")
                conn.execute("INSERT INTO schema_migrations (version, name) VALUES (?, ?)", (m.version, m.name))
                conn.commit()
            except Exception as e:
                if conn.in_transaction:
                    conn.rollback()
                raise MigrationError(f"migration {m.label} failed: {e}") from e
            ran.append(m.version)
        return ran
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def _cli(argv: list[str]) -> int:
    from . import db  # imported here: db imports this module

    cmd = argv[0] if argv else "status"
    if cmd not in ("status", "up"):
        print(__doc__)
        return 2
    db.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = db.connect()
    try:
        if cmd == "up":
            ran = migrate(conn)
            print("applied: " + (", ".join(f"{v:04d}" for v in ran) if ran else "nothing, already up to date"))
        done = applied(conn)
        print(f"database: {db.DB_PATH}")
        for m in discover():
            if m.version in done:
                print(f"  [x] {m.label:<28} applied {done[m.version][1]}")
            else:
                print(f"  [ ] {m.label:<28} pending")
        for v in sorted(set(done) - {m.version for m in discover()}):
            print(f"  [!] {v:04d}_{done[v][0]:<23} unknown to this app (database is newer)")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
