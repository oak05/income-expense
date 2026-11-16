// Apps Script backend (Code.gs) running on the fake Google services.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadBackend } from "../dev/fake-google.mjs";

const JPEG = readFileSync(new URL("../../tests/fixtures/receipt-restaurant.jpg", import.meta.url));
const PDF = readFileSync(new URL("../../tests/fixtures/ereceipt-shopee.pdf", import.meta.url));
const OCR_TEXT = "7-ELEVEN\nรวม 2 ชิ้น 125.00\nเงินสด 200.00\nทอน 75.00\n09/11/2026 12:30";

function start(opts = {}) {
  const b = loadBackend({ ocr: () => OCR_TEXT, ...opts });
  b.setNow(new Date("2026-11-10T05:00:00Z")); // 12:00 in Bangkok
  b.setup();
  const cats = Object.fromEntries(b.call("categories.list").map((c) => [`${c.type}:${c.name}`, c.id]));
  const add = (type, amount, date, extra = {}) => b.call("transactions.create", {
    type, amount: String(amount), date, note: "",
    category_id: cats[type === "expense" ? "expense:อาหารและเครื่องดื่ม" : "income:เงินเดือน"], ...extra,
  });
  const upload = (bytes = JPEG, name = "r.jpg") => b.call("receipts.upload", { name, data: bytes.toString("base64") });
  return { b, cats, add, upload };
}

const rejects = (fn, status, pattern) => assert.throws(fn, (e) => e.status === status && (!pattern || pattern.test(e.message)));

/* ---------- setup & access ---------- */

test("setup creates tabs, default categories, folder and secret; re-running keeps data", () => {
  const { b, add } = start();
  for (const name of ["categories", "transactions", "receipts", "meta"]) assert.ok(b.sheet(name), name);
  assert.equal(b.call("categories.list").length, 15);
  add("expense", 50, "2026-11-01");
  const secret = b.secret;
  b.setup();
  assert.equal(b.secret, secret);
  assert.equal(b.call("categories.list").length, 15);
  assert.equal(b.call("transactions.list", {}).length, 1);
});

test("a standalone script (no bound sheet) creates its own spreadsheet", () => {
  const b = loadBackend({ bound: false });
  const r = b.setup();
  assert.match(r.sheet_url, /spreadsheets/);
  assert.equal(b.call("categories.list").length, 15);
});

test("requests without the right secret get nothing", () => {
  const { b } = start();
  for (const secret of [undefined, "", "wrong", b.secret + "x", 12345]) {
    const r = b.post("transactions.list", {}, secret);
    assert.deepEqual(r, { ok: false, status: 401, error: "unauthorized" });
  }
  const garbage = JSON.parse(b.gs.doPost({ postData: { contents: "not json" } }).getContent());
  assert.equal(garbage.status, 400);
  assert.equal(JSON.parse(b.gs.doPost({}).getContent()).status, 400);
});

test("unknown actions and prototype names are refused", () => {
  const { b } = start();
  for (const action of ["nope", "constructor", "__proto__", "toString", 5]) {
    assert.equal(b.post(action).status, 404, String(action));
  }
});

test("opening the URL in a browser (GET) reveals no data", () => {
  const { b } = start();
  assert.match(b.gs.doGet().getContent(), /^income-expense backend/);
});

test("the write lock is always released, also after an error", () => {
  const { b } = start();
  rejects(() => b.call("transactions.create", { type: "expense" }), 422);
  assert.equal(b.state.locks, 0);
  assert.equal(b.post("transactions.create", { type: "x" }).ok, false);
  assert.equal(b.state.locks, 0);
});

/* ---------- transactions ---------- */

test("transaction create / update / delete, rounding half-up to satang", () => {
  const { b, add, cats } = start();
  const tx = add("expense", "120.505", "2026-11-05", { note: "ข้าวมันไก่" });
  assert.equal(tx.amount, 120.51);
  assert.equal(tx.category_name, "อาหารและเครื่องดื่ม");
  assert.equal(tx.receipt_id, null);

  const up = b.call("transactions.update", { id: tx.id, type: "expense", amount: "99", date: "2026-11-06",
    category_id: cats["expense:เดินทาง"], note: "แก้แล้ว" });
  assert.deepEqual([up.amount, up.date, up.category_name, up.note], [99, "2026-11-06", "เดินทาง", "แก้แล้ว"]);

  assert.equal(b.call("transactions.delete", { id: tx.id }).ok, true);
  rejects(() => b.call("transactions.delete", { id: tx.id }), 404);
});

test("ids are never reused after a delete", () => {
  const { b, add } = start();
  const a = add("expense", 1, "2026-11-01");
  b.call("transactions.delete", { id: a.id });
  assert.equal(add("expense", 2, "2026-11-01").id, a.id + 1);
});

test("bad input is rejected with Thai messages", () => {
  const { b, cats } = start();
  const base = { type: "expense", amount: "10", date: "2026-11-01", category_id: cats["expense:เดินทาง"] };
  rejects(() => b.call("transactions.create", { ...base, category_id: cats["income:เงินเดือน"] }), 400, /หมวดหมู่ไม่ตรง/);
  rejects(() => b.call("transactions.create", { ...base, amount: "-5" }), 422, /จำนวนเงิน/);
  rejects(() => b.call("transactions.create", { ...base, amount: "0" }), 422, /จำนวนเงิน/);
  rejects(() => b.call("transactions.create", { ...base, amount: "1e3" }), 422, /จำนวนเงิน/);
  rejects(() => b.call("transactions.create", { ...base, date: "2026-13-01" }), 422, /วันที่/);
  rejects(() => b.call("transactions.create", { ...base, date: "2026-02-30" }), 422, /วันที่/);
  rejects(() => b.call("transactions.create", { ...base, type: "gift" }), 422, /ประเภท/);
  rejects(() => b.call("transactions.create", { ...base, note: "x".repeat(501) }), 422, /หมายเหตุ/);
  rejects(() => b.call("month.get", { month: "2026-13" }), 400);
  assert.equal(b.call("transactions.list", {}).length, 0);
});

test("dates and tricky text survive the round trip through the sheet", () => {
  const { b, add } = start();
  const notes = ["=HYPERLINK(\"http://x.example\",\"click\")", "+66 81 234 5678", "-ส่วนลด", "@home", "007", "'quoted", "2026-11-10", "true"];
  for (const note of notes) add("expense", 10, "2026-11-10", { note });
  const back = b.call("transactions.list", { month: "2026-11" });
  assert.deepEqual(back.map((t) => t.note).sort(), [...notes].sort());
  assert.ok(back.every((t) => t.date === "2026-11-10"));
  // and nothing in the sheet became a formula
  const cells = b.sheet("transactions").rows.flat();
  assert.ok(!cells.includes("#FORMULA!"));
});

test("a date column that someone reformatted in the Sheet is still read correctly", () => {
  const { b, add } = start();
  add("expense", 10, "2026-11-09");
  const sheet = b.sheet("transactions");
  sheet.rows[1][4] = new Date("2026-11-09T00:00:00+07:00"); // what Sheets stores after "Format > Date"
  assert.equal(b.call("transactions.list", {})[0].date, "2026-11-09");
});

test("month summary: totals, previous month, cumulative balance, daily and per category", () => {
  const { b, add } = start();
  add("income", 30000, "2026-10-01");
  add("expense", 1000, "2026-10-15");
  add("income", 28000, "2026-11-01");
  add("expense", 120.5, "2026-11-05");
  add("expense", 0.1, "2026-11-05");
  add("expense", 0.2, "2026-11-05");

  const m = b.call("month.get", { month: "2026-11" });
  assert.deepEqual(m.totals, { income: 28000, expense: 120.8, balance: 27879.2, count: 4 });
  assert.equal(m.previous.expense, 1000);
  assert.equal(m.cumulative_balance, 30000 - 1000 + 27879.2);
  assert.equal(m.daily.length, 30);
  assert.equal(m.daily[4].expense, 120.8); // 120.5 + 0.1 + 0.2 without float drift
  assert.equal(m.by_category.expense[0].total, 120.8);
  assert.equal(m.transactions.length, 4);
  assert.equal(m.transactions[0].date, "2026-11-05"); // newest first

  const y = b.call("yearly.get", { year: 2026 });
  assert.equal(y.months[9].income, 30000);
  assert.equal(y.totals.count, 6);
  assert.equal(y.top_expense_categories[0].total, 1120.8);
  assert.equal(b.call("month.get", { month: "2027-02" }).daily.length, 28);
});

/* ---------- categories ---------- */

test("categories: create, duplicate, rename, delete with move", () => {
  const { b, add, cats } = start();
  const c = b.call("categories.create", { name: " กาแฟ ", type: "expense", color: "#112233" });
  assert.equal(c.name, "กาแฟ");
  rejects(() => b.call("categories.create", { name: "กาแฟ", type: "expense", color: "#112233" }), 409);
  rejects(() => b.call("categories.create", { name: "", type: "expense", color: "#112233" }), 422);
  rejects(() => b.call("categories.create", { name: "x", type: "expense", color: "red" }), 422);
  assert.equal(b.call("categories.update", { id: c.id, name: "คาเฟ่", color: "#445566" }).name, "คาเฟ่");
  rejects(() => b.call("categories.update", { id: c.id, name: "เดินทาง", color: "#445566" }), 409);

  const tx = add("expense", 50, "2026-11-01", { category_id: c.id });
  rejects(() => b.call("categories.delete", { id: c.id }), 409, /1 รายการ/);
  rejects(() => b.call("categories.delete", { id: c.id, move_to: cats["income:เงินเดือน"] }), 400);
  const other = cats["expense:อื่นๆ"];
  assert.equal(b.call("categories.delete", { id: c.id, move_to: other }).moved, 1);
  assert.equal(b.call("transactions.list", {})[0].category_id, other);
  assert.equal(b.call("transactions.list", {})[0].id, tx.id);
});

test("the last category of a type cannot be deleted", () => {
  const { b } = start();
  const income = b.call("categories.list").filter((c) => c.type === "income");
  for (const c of income.slice(0, -1)) b.call("categories.delete", { id: c.id });
  rejects(() => b.call("categories.delete", { id: income.at(-1).id }), 400);
});

/* ---------- import ---------- */

test("import skips rows already present, keeps repeats inside one file, creates categories", () => {
  const { b, add } = start();
  add("expense", 60, "2026-11-02", { note: "ข้าวมันไก่" });
  const rows = [
    { line: 2, date: "2026-11-02", type: "expense", category: "อาหารและเครื่องดื่ม", amount: "60.00", note: "ข้าวมันไก่" },
    { line: 3, date: "2026-11-10", type: "expense", category: "กาแฟ", amount: "1250.00", note: "ลาเต้" },
    { line: 4, date: "2026-11-10", type: "expense", category: "กาแฟ", amount: "1250.00", note: "ลาเต้" },
    { line: 5, date: "2026-02-31", type: "expense", category: "x", amount: "5", note: "bad" },
    { line: 6, date: "2026-11-09", type: "expense", category: "", amount: "300", note: "ถอนเงิน" },
  ];
  const r = b.call("transactions.import", { rows });
  assert.deepEqual([r.imported, r.skipped_duplicates, r.error_count], [3, 1, 1]);
  assert.match(r.errors[0], /บรรทัด 5/);
  const again = b.call("transactions.import", { rows });
  assert.deepEqual([again.imported, again.skipped_duplicates], [0, 4]);
  const cats = b.call("categories.list");
  assert.equal(cats.filter((c) => c.name === "กาแฟ").length, 1);
  assert.equal(cats.find((c) => c.name === "กาแฟ").tx_count, 2);
  rejects(() => b.call("transactions.import", { rows: [] }), 400);
});

/* ---------- receipts ---------- */

test("upload stores the file in Drive, reads it with OCR and returns a draft", () => {
  const { b, cats, upload } = start();
  const d = upload();
  assert.deepEqual([d.merchant, d.amount, d.date, d.status, d.included], ["7-Eleven", 125, "2026-11-09", "pending", true]);
  assert.equal(d.category_id, cats["expense:อาหารและเครื่องดื่ม"]);
  assert.equal(d.is_pdf, false);
  assert.equal(b.state.files.size, 1);
  assert.equal(b.state.docs.size, 0, "the temporary OCR document is removed");
  assert.deepEqual(b.call("receipts.list", {}).map((r) => r.id), [d.id]);

  const file = b.call("receipts.file", { id: d.id });
  assert.equal(file.mime, "image/jpeg");
  assert.ok(Buffer.from(file.data, "base64").equals(JPEG), "bytes come back unchanged");
});

test("file type is decided by content, not by the name; oversized or unknown files are refused", () => {
  const { b, upload } = start();
  assert.equal(upload(PDF, "photo.jpg").is_pdf, true);
  rejects(() => upload(Buffer.from("hello world"), "x.jpg"), 400, /JPG/);
  rejects(() => b.call("receipts.upload", { name: "x", data: "###" }), 400);
  rejects(() => b.call("receipts.upload", { name: "x", data: "" }), 400);
  rejects(() => upload(Buffer.concat([JPEG.subarray(0, 4), Buffer.alloc(3 * 1024 * 1024)])), 413);
  assert.equal(b.state.files.size, 1);
});

test("OCR failure keeps the receipt so the amount can be typed", () => {
  const { b, upload } = start();
  b.state.ocrFails = true;
  const d = upload();
  assert.equal(d.amount, null);
  assert.ok(d.flags.includes("no_amount") && d.flags.includes("no_date"));
  assert.match(d.error, /ใส่ยอดเอง/);
  assert.equal(d.date, "2026-11-10");
});

test("draft edits are stored; saved receipts can't be edited", () => {
  const { b, cats, upload } = start();
  const d = upload();
  b.call("receipts.update", { id: d.id, amount: "130", included: false, merchant: "ร้าน A" });
  let r = b.call("receipts.list", {})[0];
  assert.deepEqual([r.amount, r.included, r.merchant], [130, false, "ร้าน A"]);
  assert.equal(b.call("receipts.update", { id: d.id, amount: null }).amount, null);
  rejects(() => b.call("receipts.update", { id: d.id, category_id: cats["income:เงินเดือน"] }), 400);
  rejects(() => b.call("receipts.update", { id: d.id, amount: "abc" }), 422);

  b.call("receipts.commit", { items: [{ id: d.id, amount: "130", date: "2026-11-09", category_id: cats["expense:เดินทาง"] }] });
  rejects(() => b.call("receipts.update", { id: d.id, amount: "1" }), 409);
});

test("commit writes nothing unless every item is valid", () => {
  const { b, cats, upload } = start();
  const a = upload(), c = upload();
  const food = cats["expense:อาหารและเครื่องดื่ม"];
  const items = [
    { id: a.id, amount: "125", date: "2026-11-09", category_id: food, merchant: "7-Eleven" },
    { id: c.id, amount: "50", date: "2026-11-09", category_id: cats["income:เงินเดือน"] },
  ];
  rejects(() => b.call("receipts.commit", { items }), 400);
  assert.equal(b.call("transactions.list", {}).length, 0);
  assert.equal(b.call("receipts.list", {}).length, 2);

  rejects(() => b.call("receipts.commit", { items: [items[0], items[0]] }), 409);
  assert.equal(b.call("transactions.list", {}).length, 0);

  items[1].category_id = food;
  assert.deepEqual(b.call("receipts.commit", { items }), { saved: 2, total: 175 });
  const txs = b.call("transactions.list", {});
  assert.deepEqual(txs.map((t) => t.receipt_id).sort(), [a.id, c.id].sort());
  assert.deepEqual(txs.map((t) => t.note).sort(), ["7-Eleven", "ใบเสร็จ"]);
  assert.equal(b.call("receipts.list", {}).length, 0);
  assert.equal(b.call("receipts.list", { status: "saved" }).length, 2);
  rejects(() => b.call("receipts.commit", { items }), 409);
});

test("deleting a transaction removes its receipt row and trashes the Drive file", () => {
  const { b, cats, upload } = start();
  const d = upload();
  b.call("receipts.commit", { items: [{ id: d.id, amount: "125", date: "2026-11-09", category_id: cats["expense:เดินทาง"] }] });
  const tx = b.call("transactions.list", {})[0];
  assert.equal(b.call("transactions.delete", { id: tx.id }).receipts_removed, 1);
  assert.equal(b.call("receipts.list", { status: "saved" }).length, 0);
  assert.ok([...b.state.files.values()].every((f) => f.trashed));
  rejects(() => b.call("receipts.file", { id: d.id }), 404);
});

test("deleting a pending receipt trashes its file", () => {
  const { b, upload } = start();
  const d = upload();
  b.call("receipts.delete", { id: d.id });
  assert.equal(b.call("receipts.list", {}).length, 0);
  assert.ok([...b.state.files.values()][0].trashed);
});

test("deleting a category clears it from pending receipts", () => {
  const { b, cats, upload } = start();
  const d = upload();
  b.call("categories.delete", { id: d.category_id });
  assert.equal(b.call("receipts.list", {})[0].category_id, null);
  assert.ok(cats["expense:เดินทาง"]);
});

/* ---------- login throttle ---------- */

test("login attempts are counted per key and blocked for 15 minutes after 8 failures", () => {
  const { b } = start();
  for (let i = 0; i < 8; i++) assert.equal(b.call("auth.attempt", { key: "1.2.3.4", ok: false }).blocked, false);
  assert.equal(b.call("auth.attempt", { key: "1.2.3.4", ok: true }).blocked, true, "even the right password waits");
  assert.equal(b.call("auth.attempt", { key: "5.6.7.8", ok: true }).blocked, false, "other addresses are unaffected");
  b.setNow(new Date("2026-11-10T05:16:00Z"));
  assert.equal(b.call("auth.attempt", { key: "1.2.3.4", ok: true }).blocked, false);
});

test("a successful login clears earlier failures", () => {
  const { b } = start();
  for (let i = 0; i < 7; i++) b.call("auth.attempt", { key: "k", ok: false });
  b.call("auth.attempt", { key: "k", ok: true });
  for (let i = 0; i < 7; i++) assert.equal(b.call("auth.attempt", { key: "k", ok: false }).blocked, false);
});

test("without the Drive API service the receipt is kept and the message says what to add", () => {
  const { b, upload } = start();
  delete b.context.Drive;
  const d = upload();
  assert.equal(d.amount, null);
  assert.match(d.error, /Drive API/);
});

test("Drive API v2 (older projects) is used when v3 is not there", () => {
  const { b, upload } = start();
  const v3 = b.context.Drive.Files.create;
  b.context.Drive.Files.insert = (meta, blob, opts) => v3({ mimeType: meta.mimeType }, blob, opts);
  delete b.context.Drive.Files.create;
  assert.equal(upload().amount, 125);
});
