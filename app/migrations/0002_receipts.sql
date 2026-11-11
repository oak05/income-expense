-- 0002: scanned receipts, drafts until saved as expenses (app v1.1)

CREATE TABLE receipts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    image_file      TEXT    NOT NULL,              -- preview JPEG in receipts/
    source_file     TEXT    NOT NULL DEFAULT '',   -- original PDF, if uploaded as PDF
    original_name   TEXT    NOT NULL DEFAULT '',
    status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'saved')),
    text_source     TEXT    NOT NULL DEFAULT '',   -- ocr | pdf-text
    ocr_text        TEXT    NOT NULL DEFAULT '',
    error           TEXT    NOT NULL DEFAULT '',
    merchant        TEXT    NOT NULL DEFAULT '',
    amount_satang   INTEGER,
    date            TEXT,
    category_id     INTEGER REFERENCES categories (id) ON DELETE SET NULL,
    candidates      TEXT    NOT NULL DEFAULT '[]', -- other amounts found (satang)
    confidence      TEXT    NOT NULL DEFAULT 'none',
    flags           TEXT    NOT NULL DEFAULT '[]',
    included        INTEGER NOT NULL DEFAULT 1,
    transaction_id  INTEGER REFERENCES transactions (id) ON DELETE SET NULL,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_receipts_status ON receipts (status);
CREATE INDEX idx_receipts_tx ON receipts (transaction_id);
