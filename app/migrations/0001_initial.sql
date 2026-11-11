-- 0001: categories and transactions (app v1.0)

CREATE TABLE categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    type        TEXT    NOT NULL CHECK (type IN ('income', 'expense')),
    color       TEXT    NOT NULL DEFAULT '#64748b',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    UNIQUE (name, type)
);

CREATE TABLE transactions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    type           TEXT    NOT NULL CHECK (type IN ('income', 'expense')),
    amount_satang  INTEGER NOT NULL CHECK (amount_satang > 0),
    category_id    INTEGER NOT NULL REFERENCES categories (id),
    date           TEXT    NOT NULL,
    note           TEXT    NOT NULL DEFAULT '',
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tx_date ON transactions (date);
CREATE INDEX idx_tx_category ON transactions (category_id);
