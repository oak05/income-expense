"use strict";
/* CSV import/export, done in the browser (the Sheet backend only receives clean rows). */

const CSV_HEADERS = ["วันที่", "ประเภท", "หมวดหมู่", "จำนวนเงิน", "หมายเหตุ"];
const CSV_HEADER_ALIASES = {
  date: ["date", "วันที่"],
  type: ["type", "ประเภท"],
  category: ["category", "หมวดหมู่", "หมวด"],
  amount: ["amount", "จำนวนเงิน", "จำนวน", "ยอดเงิน"],
  note: ["note", "หมายเหตุ", "รายละเอียด", "บันทึก"],
};
const CSV_TYPE_ALIASES = {
  income: "income", "รายรับ": "income", "รับ": "income",
  expense: "expense", "รายจ่าย": "expense", "จ่าย": "expense",
};
const CSV_TYPE_TH = { income: "รายรับ", expense: "รายจ่าย" };

/** Bytes -> text. UTF-8 first, then Windows-874 (what Thai Excel writes for "CSV"). */
function decodeCsvBytes(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-874").decode(buffer);
  }
}

function sniffDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  let best = ",", bestCount = 0;
  for (const d of [",", ";", "\t"]) {
    let count = 0, quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

/** RFC 4180-style parser: quoted cells, doubled quotes, newlines inside quotes. Returns rows of cells. */
function parseCsv(text, delimiter = sniffDelimiter(text)) {
  const rows = [];
  let row = [], cell = "", quoted = false, i = 0;
  const pushCell = () => { row.push(cell); cell = ""; };
  const pushRow = () => { pushCell(); rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === delimiter) {
      pushCell();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      pushRow();
    } else {
      cell += ch;
    }
    i++;
  }
  if (cell !== "" || row.length) pushRow();
  return rows;
}

/** "10/11/2569", "10-11-2026", "2026-11-10 12:30" -> "2026-11-10". Throws on anything else. */
function parseCsvDate(value) {
  const s = String(value).trim().slice(0, 10).trim();
  const parts = s.split(/[/.\-]/);
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) throw new Error("วันที่ไม่ถูกต้อง");
  let [y, m, d] = parts[0].length === 4 ? parts.map(Number) : [Number(parts[2]), Number(parts[1]), Number(parts[0])];
  if (y < 1000) throw new Error("ปีต้องเป็นตัวเลข 4 หลัก");
  if (y > 2400) y -= 543; // Buddhist Era -> CE
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new Error(`วันที่ "${String(value).trim()}" ไม่ถูกต้อง`);
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "1,250.00", "฿99", "(300)", "-300 บาท" -> {text: "1250.00", negative: false}. Throws if not a number. */
function parseCsvAmount(value) {
  let s = String(value || "").replace(/[,\s฿]|บาท/g, "");
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1); } else if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith(".")) s = "0" + s;
  if (!/^\d{1,10}(\.\d{1,6})?$/.test(s)) throw new Error("จำนวนเงินไม่ถูกต้อง");
  return { text: s, negative, zero: Number(s) === 0 };
}

/** CSV text -> {rows: [{line, date, type, category, amount, note}], errors: ["บรรทัด 5: ..."]} */
function csvToRows(text) {
  const table = parseCsv(text);
  if (!table.length) throw new Error("ไฟล์ว่าง");
  const col = {};
  table[0].forEach((h, i) => {
    const key = h.trim().toLowerCase();
    for (const [field, aliases] of Object.entries(CSV_HEADER_ALIASES)) {
      if (aliases.includes(key) && !(field in col)) col[field] = i;
    }
  });
  const missing = ["date", "amount"].filter((f) => !(f in col));
  if (missing.length) {
    throw new Error("ไม่พบคอลัมน์ที่จำเป็น: " + missing.map((f) => (f === "date" ? "วันที่" : "จำนวนเงิน")).join(", ")
      + " (หัวตารางที่รองรับ: วันที่, ประเภท, หมวดหมู่, จำนวนเงิน, หมายเหตุ)");
  }
  // exports protect cells that start with = + - @ with a leading apostrophe; take it off again
  const cell = (row, field) => (field in col && col[field] < row.length ? row[col[field]].trim().replace(/^'(?=[=+\-@])/, "") : "");

  const rows = [], errors = [];
  table.slice(1).forEach((row, i) => {
    const line = i + 2;
    if (!row.some((c) => c.trim())) return;
    try {
      const date = parseCsvDate(cell(row, "date"));
      const amount = parseCsvAmount(cell(row, "amount"));
      const typeRaw = cell(row, "type").toLowerCase();
      let type;
      if (typeRaw) {
        type = CSV_TYPE_ALIASES[typeRaw];
        if (!type) throw new Error(`ประเภท "${typeRaw}" ไม่รู้จัก (ใช้ รายรับ/รายจ่าย)`);
      } else {
        type = amount.negative ? "expense" : "income";
      }
      if (amount.zero) throw new Error("จำนวนเงินต้องมากกว่า 0");
      rows.push({
        line, date, type, amount: amount.text,
        category: cell(row, "category").slice(0, 50) || "อื่นๆ",
        note: cell(row, "note").slice(0, 500),
      });
    } catch (e) {
      errors.push(`บรรทัด ${line}: ${e.message}`);
    }
  });
  return { rows, errors };
}

function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // so Excel shows the text instead of running it as a formula
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Transactions (as the API returns them) -> CSV text with a BOM so Excel on Windows reads Thai correctly. */
function toCsv(transactions) {
  const sorted = [...transactions].sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
  const lines = [CSV_HEADERS.join(",")];
  for (const t of sorted) {
    lines.push([t.date, CSV_TYPE_TH[t.type], csvCell(t.category_name), Number(t.amount).toFixed(2), csvCell(t.note)].join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}
