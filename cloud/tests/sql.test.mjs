// The Supabase database (cloud/supabase/migrations) running in PGlite, called the way PostgREST calls it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb, createUser, callApi } from "../dev/pg.mjs";

/* ---------- harness ---------- */

test("harness: auth.uid() follows the claims and roles exist", async () => {
  const db = await createDb();
  const id = await createUser(db, { email: "a@example.com" });
  const results = await db.exec(`begin; set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${id}"}', true); select auth.uid()::text as u; commit;`);
  assert.equal(results.at(-2).rows[0].u, id); // db.exec returns one result per statement
  assert.equal(await callApi(db, id, "pg_typeof", {}).catch((e) => e.status), 500); // unknown → ApiError 500
});

test("harness: Bangkok time zone is available", async () => {
  const db = await createDb();
  const r = await db.query("select to_char(timestamptz '2026-11-10 05:00:00+00' at time zone 'Asia/Bangkok', 'HH24:MI') as t");
  assert.equal(r.rows[0].t, "12:00");
});

/* ---------- schema, RLS, defaults ---------- */

const DEFAULT_CATEGORIES = [
  ["อาหารและเครื่องดื่ม", "expense", "#E07A3F"], ["เดินทาง", "expense", "#3A86C8"],
  ["ที่พัก / ค่าเช่า", "expense", "#7B61C9"], ["ค่าน้ำ ค่าไฟ ค่าเน็ต", "expense", "#D4A72C"],
  ["ช้อปปิ้ง", "expense", "#D2588E"], ["สุขภาพ", "expense", "#2E9E83"], ["บันเทิง", "expense", "#C8463D"],
  ["การศึกษา", "expense", "#4F5BD5"], ["อื่นๆ", "expense", "#7A8290"],
  ["เงินเดือน", "income", "#2F8F5B"], ["งานฟรีแลนซ์", "income", "#1F8A8A"], ["โบนัส", "income", "#7FA33A"],
  ["ขายของ", "income", "#3E9E3E"], ["ดอกเบี้ย / เงินปันผล", "income", "#4C7A5A"], ["อื่นๆ", "income", "#7A8290"],
];

/** Runs SQL as a user (RLS applies), returning the last statement's rows. */
async function asUser(db, userId, sql, params = [], role = "authenticated") {
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(userId ? { sub: userId, role } : { role })]);
    return (await tx.query(sql, params)).rows;
  });
}

test("a new user gets the 15 default categories in order", async () => {
  const db = await createDb();
  const a = await createUser(db, { email: "a@example.com" });
  const rows = await asUser(db, a, "select name, type, color from categories order by sort_order");
  assert.deepEqual(rows.map((r) => [r.name, r.type, r.color]), DEFAULT_CATEGORIES);
});

test("user B sees none of A's rows and cannot write rows for A", async () => {
  const db = await createDb();
  const a = await createUser(db, { email: "a@example.com" });
  const b = await createUser(db, { email: "b@example.com" });
  const [aCat] = await asUser(db, a, "select id from categories where type = 'expense' order by sort_order limit 1");
  const [tx] = await asUser(db, a,
    "insert into transactions (type, amount, category_id, date) values ('expense', 10, $1, '2026-11-01') returning id", [aCat.id]);
  assert.equal((await asUser(db, b, "select count(*)::int as n from transactions"))[0].n, 0);
  assert.equal((await asUser(db, b, "select count(*)::int as n from categories"))[0].n, 15);
  assert.equal((await asUser(db, b, "update transactions set note = 'x' where id = $1 returning id", [tx.id])).length, 0);
  assert.equal((await asUser(db, b, "delete from transactions where id = $1 returning id", [tx.id])).length, 0);
  await assert.rejects(asUser(db, b,
    "insert into transactions (user_id, type, amount, category_id, date) values ($1, 'expense', 1, $2, '2026-11-01')", [a, aCat.id]));
  await assert.rejects(asUser(db, b,
    "insert into transactions (type, amount, category_id, date) values ('expense', 1, $1, '2026-11-01')", [aCat.id]));
  assert.equal((await asUser(db, a, "select note from transactions"))[0].note, "");
});

test("anon cannot read anything", async () => {
  const db = await createDb();
  await createUser(db, { email: "a@example.com" });
  for (const table of ["categories", "transactions", "receipts"]) {
    await assert.rejects(asUser(db, null, `select * from ${table}`, [], "anon"), /permission denied/);
  }
});

/* ---------- API helpers for the tests ---------- */

/** Two accounts on one database. call("transactions.create", {...}) runs public.api_transactions_create as A. */
async function start() {
  const db = await createDb();
  const a = await createUser(db, { email: "a@example.com" });
  const b = await createUser(db, { email: "b@example.com" });
  const fn = (action) => "api_" + action.replace(".", "_");
  const call = (action, params = {}) => callApi(db, a, fn(action), params, { email: "a@example.com" });
  const callB = (action, params = {}) => callApi(db, b, fn(action), params, { email: "b@example.com" });
  const catMap = async (c) => Object.fromEntries((await c("categories.list")).map((x) => [`${x.type}:${x.name}`, x.id]));
  const cats = await catMap(call);
  const catsB = await catMap(callB);
  const add = (type, amount, date, extra = {}) => call("transactions.create", {
    type, amount: String(amount), date, note: "",
    category_id: cats[type === "expense" ? "expense:อาหารและเครื่องดื่ม" : "income:เงินเดือน"], ...extra,
  });
  return { db, a, b, call, callB, cats, catsB, add };
}

const rejects = (promise, status, pattern) => assert.rejects(promise, (e) => {
  assert.equal(e.status, status, `status ${e.status}: ${e.message}`);
  if (pattern) assert.match(e.message, pattern);
  return true;
});

/* ---------- transactions ---------- */

test("transaction create / update / delete, rounding half-up to satang", async () => {
  const { call, add, cats } = await start();
  const tx = await add("expense", "120.505", "2026-11-05", { note: "ข้าวมันไก่" });
  assert.equal(tx.amount, 120.51);
  assert.equal(tx.category_name, "อาหารและเครื่องดื่ม");
  assert.equal(tx.category_color, "#E07A3F");
  assert.equal(tx.receipt_id, null);
  assert.match(tx.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  const up = await call("transactions.update", { id: tx.id, type: "expense", amount: "99", date: "2026-11-06",
    category_id: cats["expense:เดินทาง"], note: "แก้แล้ว" });
  assert.deepEqual([up.amount, up.date, up.category_name, up.note], [99, "2026-11-06", "เดินทาง", "แก้แล้ว"]);

  assert.deepEqual(await call("transactions.delete", { id: tx.id }), { ok: true, receipts_removed: 0, removed_files: [] });
  await rejects(call("transactions.delete", { id: tx.id }), 404);
});

test("ids are never reused after a delete", async () => {
  const { call, add } = await start();
  const a = await add("expense", 1, "2026-11-01");
  await call("transactions.delete", { id: a.id });
  assert.ok((await add("expense", 2, "2026-11-01")).id > a.id);
});

test("bad input is rejected with Thai messages", async () => {
  const { call, cats } = await start();
  const base = { type: "expense", amount: "10", date: "2026-11-01", category_id: cats["expense:เดินทาง"] };
  await rejects(call("transactions.create", { ...base, category_id: cats["income:เงินเดือน"] }), 400, /หมวดหมู่ไม่ตรง/);
  await rejects(call("transactions.create", { ...base, amount: "-5" }), 422, /จำนวนเงิน/);
  await rejects(call("transactions.create", { ...base, amount: "0" }), 422, /จำนวนเงิน/);
  await rejects(call("transactions.create", { ...base, amount: "1e3" }), 422, /จำนวนเงิน/);
  await rejects(call("transactions.create", { ...base, amount: "99999999999" }), 422, /จำนวนเงิน/);
  await rejects(call("transactions.create", { ...base, date: "2026-13-01" }), 422, /วันที่/);
  await rejects(call("transactions.create", { ...base, date: "2026-02-30" }), 422, /วันที่/);
  await rejects(call("transactions.create", { ...base, type: "gift" }), 422, /ประเภท/);
  await rejects(call("transactions.create", { ...base, note: "x".repeat(501) }), 422, /หมายเหตุ/);
  await rejects(call("transactions.create", { ...base, category_id: "abc" }), 422, /หมวดหมู่/);
  await rejects(call("transactions.create", { ...base, category_id: 999999 }), 400, /ไม่พบหมวดหมู่นี้/);
  await rejects(call("transactions.list", { month: "2026-13" }), 400, /YYYY-MM/);
  assert.equal((await call("transactions.list", {})).length, 0);
});

test("tricky text survives the round trip", async () => {
  const { call, add } = await start();
  const notes = ["=HYPERLINK(\"http://x.example\",\"click\")", "+66 81 234 5678", "-ส่วนลด", "@home", "007", "'quoted", "2026-11-10", "true"];
  for (const note of notes) await add("expense", 10, "2026-11-10", { note });
  const back = await call("transactions.list", { month: "2026-11" });
  assert.deepEqual(back.map((t) => t.note).sort(), [...notes].sort());
  assert.ok(back.every((t) => t.date === "2026-11-10"));
  assert.equal((await call("transactions.list", { month: "2026-10" })).length, 0);
});

test("B cannot update, delete or move into A's rows", async () => {
  const { call, callB, add, cats, catsB } = await start();
  const tx = await add("expense", 10, "2026-11-01");
  const base = { type: "expense", amount: "5", date: "2026-11-01", note: "" };
  await rejects(callB("transactions.update", { ...base, id: tx.id, category_id: catsB["expense:เดินทาง"] }), 404);
  await rejects(callB("transactions.delete", { id: tx.id }), 404);
  await rejects(callB("transactions.create", { ...base, category_id: cats["expense:เดินทาง"] }), 400, /ไม่พบหมวดหมู่นี้/);
  const mine = await callB("categories.create", { name: "กาแฟ", type: "expense", color: "#112233" });
  await callB("transactions.create", { ...base, category_id: mine.id });
  await rejects(callB("categories.delete", { id: mine.id, move_to: cats["expense:อื่นๆ"] }), 400, /หมวดหมู่ปลายทางไม่ถูกต้อง/);
  await rejects(callB("categories.update", { id: cats["expense:เดินทาง"], name: "x", color: "#112233" }), 404);
  await rejects(callB("categories.delete", { id: cats["expense:เดินทาง"] }), 404);
  assert.equal((await callB("transactions.list", {})).length, 1);
  assert.equal((await call("transactions.list", {}))[0].amount, 10);
});

/* ---------- categories ---------- */

test("categories: create, duplicate, rename, delete with move", async () => {
  const { call, add, cats } = await start();
  const c = await call("categories.create", { name: " กาแฟ ", type: "expense", color: "#112233" });
  assert.deepEqual({ ...c, id: 0 }, { id: 0, name: "กาแฟ", type: "expense", color: "#112233", sort_order: 15, budget: null, tx_count: 0 });
  await rejects(call("categories.create", { name: "กาแฟ", type: "expense", color: "#112233" }), 409, /มีหมวดหมู่ "กาแฟ" อยู่แล้ว/);
  await rejects(call("categories.create", { name: "", type: "expense", color: "#112233" }), 422);
  await rejects(call("categories.create", { name: "x", type: "expense", color: "red" }), 422, /สี/);
  assert.equal((await call("categories.update", { id: c.id, name: "คาเฟ่", color: "#445566" })).name, "คาเฟ่");
  await rejects(call("categories.update", { id: c.id, name: "เดินทาง", color: "#445566" }), 409);

  const tx = await add("expense", 50, "2026-11-01", { category_id: c.id });
  await rejects(call("categories.delete", { id: c.id }), 409, /1 รายการ/);
  await rejects(call("categories.delete", { id: c.id, move_to: cats["income:เงินเดือน"] }), 400);
  const other = cats["expense:อื่นๆ"];
  assert.deepEqual(await call("categories.delete", { id: c.id, move_to: other }), { ok: true, moved: 1 });
  const list = await call("transactions.list", {});
  assert.equal(list[0].category_id, other);
  assert.equal(list[0].id, tx.id);
  assert.equal((await call("categories.list")).find((x) => x.id === other).tx_count, 1);
});

test("category budgets: set, kept on rename, cleared, expense categories only", async () => {
  const { call, cats } = await start();
  const food = cats["expense:อาหารและเครื่องดื่ม"];
  const budgetOf = async (id) => (await call("categories.list")).find((c) => c.id === id).budget;
  assert.ok((await call("categories.list")).every((c) => c.budget === null));

  assert.equal((await call("categories.update", { id: food, name: "อาหาร", color: "#E07A3F", budget: "6000" })).budget, 6000);
  assert.equal(await budgetOf(food), 6000);
  await call("categories.update", { id: food, name: "อาหารนอกบ้าน", color: "#E07A3F" }); // no budget key: unchanged
  assert.equal(await budgetOf(food), 6000);
  await call("categories.update", { id: food, name: "อาหาร", color: "#E07A3F", budget: "1500.505" });
  assert.equal(await budgetOf(food), 1500.51);
  for (const clear of [null, "", "0"]) {
    await call("categories.update", { id: food, name: "อาหาร", color: "#E07A3F", budget: "100" });
    assert.equal((await call("categories.update", { id: food, name: "อาหาร", color: "#E07A3F", budget: clear })).budget, null);
  }
  await rejects(call("categories.update", { id: cats["income:เงินเดือน"], name: "เงินเดือน", color: "#2F8F5B", budget: "100" }), 400, /รายจ่าย/);
  for (const bad of ["-5", "abc", "1e3"]) {
    await rejects(call("categories.update", { id: food, name: "อาหาร", color: "#E07A3F", budget: bad }), 422, /งบประมาณ/);
  }
  assert.equal((await call("categories.create", { name: "สัตว์เลี้ยง", type: "expense", color: "#112233" })).budget, null);
});

test("the last category of a type cannot be deleted", async () => {
  const { call } = await start();
  const income = (await call("categories.list")).filter((c) => c.type === "income");
  for (const c of income.slice(0, -1)) await call("categories.delete", { id: c.id });
  await rejects(call("categories.delete", { id: income.at(-1).id }), 400, /อย่างน้อย 1 หมวด/);
});

/* ---------- import ---------- */

test("import skips rows already present, keeps repeats inside one file, creates categories", async () => {
  const { call, add } = await start();
  await add("expense", 60, "2026-11-02", { note: "ข้าวมันไก่" });
  const rows = [
    { line: 2, date: "2026-11-02", type: "expense", category: "อาหารและเครื่องดื่ม", amount: "60.00", note: "ข้าวมันไก่" },
    { line: 3, date: "2026-11-10", type: "expense", category: "กาแฟ", amount: "1250.00", note: "ลาเต้" },
    { line: 4, date: "2026-11-10", type: "expense", category: "กาแฟ", amount: "1250.00", note: "ลาเต้" },
    { line: 5, date: "2026-02-31", type: "expense", category: "x", amount: "5", note: "bad" },
    { line: 6, date: "2026-11-09", type: "expense", category: "", amount: "300", note: "ถอนเงิน" },
  ];
  const r = await call("transactions.import", { rows });
  assert.deepEqual([r.imported, r.skipped_duplicates, r.error_count], [3, 1, 1]);
  assert.match(r.errors[0], /บรรทัด 5/);
  const again = await call("transactions.import", { rows });
  assert.deepEqual([again.imported, again.skipped_duplicates], [0, 4]);
  const cats = await call("categories.list");
  assert.equal(cats.filter((c) => c.name === "กาแฟ").length, 1);
  assert.equal(cats.find((c) => c.name === "กาแฟ").tx_count, 2);
  assert.equal(cats.find((c) => c.name === "กาแฟ").color, "#B86F5B"); // NEW_CATEGORY_COLORS[(15 existing + 0) % 7]
  assert.equal((await call("transactions.list", {})).find((t) => t.note === "ถอนเงิน").category_name, "อื่นๆ");
  await rejects(call("transactions.import", { rows: [] }), 400);
  await rejects(call("transactions.import", { rows: Array(5001).fill(rows[0]) }), 413);
});

test("import is all-or-nothing on a database error", async () => {
  const { db, call } = await start();
  await db.exec("alter table transactions add constraint no_boom check (note <> 'boom')");
  const before = [(await call("transactions.list", {})).length, (await call("categories.list")).length];
  const rows = [
    { line: 2, date: "2026-11-10", type: "expense", category: "ใหม่", amount: "1", note: "ok" },
    { line: 3, date: "2026-11-10", type: "expense", category: "ใหม่", amount: "1", note: "boom" },
  ];
  await assert.rejects(call("transactions.import", { rows }));
  assert.deepEqual([(await call("transactions.list", {})).length, (await call("categories.list")).length], before);
});

/* ---------- summaries ---------- */

test("month summary: totals, previous month, cumulative balance, daily and per category", async () => {
  const { call, add } = await start();
  await add("income", 30000, "2026-10-01");
  await add("expense", 1000, "2026-10-15");
  await add("income", 28000, "2026-11-01");
  await add("expense", 120.5, "2026-11-05");
  await add("expense", 0.1, "2026-11-05");
  await add("expense", 0.2, "2026-11-05");
  await add("expense", 5, "2026-12-01"); // after the month: not in the cumulative balance

  const m = await call("month.get", { month: "2026-11" });
  assert.equal(m.month, "2026-11");
  assert.deepEqual(m.totals, { income: 28000, expense: 120.8, balance: 27879.2, count: 4 });
  assert.deepEqual(m.previous, { income: 30000, expense: 1000, balance: 29000, count: 2 });
  assert.equal(m.cumulative_balance, 30000 - 1000 + 27879.2);
  assert.equal(m.daily.length, 30);
  assert.deepEqual(m.daily[4], { day: 5, income: 0, expense: 120.8 }); // 120.5 + 0.1 + 0.2 without float drift
  assert.deepEqual(m.daily[0], { day: 1, income: 28000, expense: 0 });
  assert.deepEqual(m.by_category.expense, [{ id: m.by_category.expense[0].id, name: "อาหารและเครื่องดื่ม", color: "#E07A3F", total: 120.8, count: 3 }]);
  assert.equal(m.by_category.income[0].total, 28000);
  assert.equal(m.transactions.length, 4);
  assert.equal(m.transactions[0].date, "2026-11-05"); // newest first
  assert.equal(m.transactions.at(-1).date, "2026-11-01");

  const y = await call("yearly.get", { year: 2026 });
  assert.equal(y.year, 2026);
  assert.equal(y.months.length, 12);
  assert.deepEqual(y.months[9], { month: "2026-10", income: 30000, expense: 1000 });
  assert.deepEqual(y.totals, { income: 58000, expense: 1125.8, balance: 56874.2, count: 7 });
  assert.deepEqual(y.top_expense_categories, [{ name: "อาหารและเครื่องดื่ม", color: "#E07A3F", total: 1125.8 }]);
  assert.equal((await call("month.get", { month: "2027-02" })).daily.length, 28);
  assert.deepEqual((await call("month.get", { month: "2027-02" })).by_category, { income: [], expense: [] });
  await rejects(call("month.get", { month: "2026-13" }), 400, /YYYY-MM/);
  await rejects(call("yearly.get", { year: 1800 }), 422, /ปี/);
  await rejects(call("yearly.get", { year: "abc" }), 422, /ปี/);
});

test("top expense categories: sorted, at most 8", async () => {
  const { call, cats } = await start();
  const expense = Object.entries(cats).filter(([k]) => k.startsWith("expense:"));
  for (const [i, [, id]] of expense.entries()) {
    await call("transactions.create", { type: "expense", amount: String(10 + i), date: "2026-03-01", note: "", category_id: id });
  }
  const top = (await call("yearly.get", { year: 2026 })).top_expense_categories;
  assert.equal(top.length, 8);
  assert.deepEqual(top.map((c) => c.total), [18, 17, 16, 15, 14, 13, 12, 11]);
});

test("summaries never include another user's rows", async () => {
  const { callB, add } = await start();
  await add("income", 100, "2026-11-01");
  const m = await callB("month.get", { month: "2026-11" });
  assert.deepEqual(m.totals, { income: 0, expense: 0, balance: 0, count: 0 });
  assert.equal(m.cumulative_balance, 0);
  assert.equal((await callB("yearly.get", { year: 2026 })).totals.count, 0);
});

/* ---------- receipts ---------- */

let fileNo = 0;
/** What Vercel sends after storing the file and reading it: api_receipts_create. */
const draft = (call, userId, extra = {}) => call("receipts.create", {
  merchant: "7-Eleven", amount: 125, date: "2026-11-09", hint_names: ["อาหารและเครื่องดื่ม"],
  storage_path: `${userId}/${++fileNo}.jpg`, size: 1000, mime: "image/jpeg", original_name: "r.jpg",
  text_source: "drive-ocr", confidence: "high", candidates: [{ amount: 125, label: "รวม" }], flags: [], error: "",
  ocr_text: "7-ELEVEN\nรวม 125.00", ...extra,
});

test("a receipt draft is stored and comes back in the old shape", async () => {
  const { call, a, cats } = await start();
  const d = await draft(call, a);
  assert.deepEqual({ ...d, id: 0, created_at: "" }, {
    id: 0, status: "pending", merchant: "7-Eleven", amount: 125, date: "2026-11-09",
    category_id: cats["expense:อาหารและเครื่องดื่ม"], included: true, transaction_id: null, is_pdf: false,
    original_name: "r.jpg", text_source: "drive-ocr", confidence: "high", candidates: [{ amount: 125, label: "รวม" }],
    flags: [], error: "", ocr_text: "7-ELEVEN\nรวม 125.00", created_at: "",
  });
  assert.deepEqual((await call("receipts.list", {})).map((r) => r.id), [d.id]);
  assert.deepEqual(await call("receipts.file", { id: d.id }), { storage_path: `${a}/${fileNo}.jpg`, mime: "image/jpeg", original_name: "r.jpg" });
  const pdf = await draft(call, a, { mime: "application/pdf", amount: null, ocr_text: "x".repeat(5000) });
  assert.equal(pdf.is_pdf, true);
  assert.equal(pdf.amount, null);
  assert.equal(pdf.ocr_text.length, 4000);
  await rejects(draft(call, a, { mime: "image/gif" }), 400, /JPG/);
});

test("category hint picks the matching expense category", async () => {
  const { call, a, cats } = await start();
  assert.equal((await draft(call, a, { hint_names: ["เดินทาง"] })).category_id, cats["expense:เดินทาง"]);
  assert.equal((await draft(call, a, { hint_names: ["xyz", "ช้อปปิ้ง"] })).category_id, cats["expense:ช้อปปิ้ง"]);
  assert.equal((await draft(call, a, { hint_names: ["อาหาร"] })).category_id, cats["expense:อาหารและเครื่องดื่ม"]); // substring
  assert.equal((await draft(call, a, { hint_names: [] })).category_id, cats["expense:อื่นๆ"]);
});

test("quota: the upload that crosses 100 MB is refused", async () => {
  const { call, callB, a, b } = await start();
  await draft(call, a, { size: 60 * 1024 * 1024 });
  await draft(call, a, { size: 40 * 1024 * 1024 }); // exactly 100 MB is fine
  await rejects(draft(call, a, { size: 1 }), 413, /100 MB/);
  await draft(callB, b, { size: 1 }); // the quota is per account
});

test("storage_path outside the user's folder is refused", async () => {
  const { call, a, b } = await start();
  await rejects(draft(call, a, { storage_path: `${b}/x.jpg` }), 400, /ไฟล์/);
  await rejects(draft(call, a, { storage_path: `${a}x/x.jpg` }), 400, /ไฟล์/);
  await rejects(draft(call, a, { storage_path: `${a}/../${b}/x.jpg` }), 400, /ไฟล์/);
});

test("draft edits are stored; saved receipts can't be edited", async () => {
  const { call, a, cats } = await start();
  const d = await draft(call, a);
  await call("receipts.update", { id: d.id, amount: "130", included: false, merchant: "ร้าน A" });
  const r = (await call("receipts.list", {}))[0];
  assert.deepEqual([r.amount, r.included, r.merchant], [130, false, "ร้าน A"]);
  assert.equal((await call("receipts.update", { id: d.id, amount: null })).amount, null);
  assert.equal((await call("receipts.update", { id: d.id, date: "2026-11-01" })).date, "2026-11-01");
  await rejects(call("receipts.update", { id: d.id, category_id: cats["income:เงินเดือน"] }), 400);
  await rejects(call("receipts.update", { id: d.id, amount: "abc" }), 422);
  await rejects(call("receipts.update", { id: 999999, amount: "1" }), 404);

  await call("receipts.commit", { items: [{ id: d.id, amount: "130", date: "2026-11-09", category_id: cats["expense:เดินทาง"] }] });
  await rejects(call("receipts.update", { id: d.id, amount: "1" }), 409, /บันทึกไปแล้ว/);
});

test("commit writes nothing unless every item is valid", async () => {
  const { call, a, cats } = await start();
  const r1 = await draft(call, a), r2 = await draft(call, a);
  const food = cats["expense:อาหารและเครื่องดื่ม"];
  const items = [
    { id: r1.id, amount: "125", date: "2026-11-09", category_id: food, merchant: "7-Eleven" },
    { id: r2.id, amount: "50", date: "2026-11-09", category_id: cats["income:เงินเดือน"] },
  ];
  await rejects(call("receipts.commit", { items }), 400);
  assert.equal((await call("transactions.list", {})).length, 0);
  assert.equal((await call("receipts.list", {})).length, 2);

  await rejects(call("receipts.commit", { items: [items[0], items[0]] }), 409);
  assert.equal((await call("transactions.list", {})).length, 0);
  await rejects(call("receipts.commit", { items: [] }), 422);

  items[1].category_id = food;
  assert.deepEqual(await call("receipts.commit", { items }), { saved: 2, total: 175 });
  const txs = await call("transactions.list", {});
  assert.deepEqual(txs.map((t) => t.receipt_id).sort(), [r1.id, r2.id].sort());
  assert.deepEqual(txs.map((t) => t.note).sort(), ["7-Eleven", "ใบเสร็จ"]);
  assert.equal((await call("receipts.list", {})).length, 0);
  const saved = await call("receipts.list", { status: "saved" });
  assert.equal(saved.length, 2);
  assert.ok(saved.every((r) => r.transaction_id && r.status === "saved"));
  await rejects(call("receipts.commit", { items }), 409);
});

test("deleting a transaction removes its receipt row and returns the file path", async () => {
  const { call, a, cats } = await start();
  const d = await draft(call, a);
  const path = (await call("receipts.file", { id: d.id })).storage_path;
  await call("receipts.commit", { items: [{ id: d.id, amount: "125", date: "2026-11-09", category_id: cats["expense:เดินทาง"] }] });
  const tx = (await call("transactions.list", {}))[0];
  assert.deepEqual(await call("transactions.delete", { id: tx.id }), { ok: true, receipts_removed: 1, removed_files: [path] });
  assert.equal((await call("receipts.list", { status: "saved" })).length, 0);
  await rejects(call("receipts.file", { id: d.id }), 404, /ไม่พบไฟล์ใบเสร็จ/);
});

test("deleting a receipt returns its path; a saved one leaves its transaction in place", async () => {
  const { call, a, cats } = await start();
  const d = await draft(call, a);
  assert.deepEqual(await call("receipts.delete", { id: d.id }), { ok: true, removed_files: [`${a}/${fileNo}.jpg`] });
  assert.equal((await call("receipts.list", {})).length, 0);
  await rejects(call("receipts.delete", { id: d.id }), 404);

  const s = await draft(call, a);
  await call("receipts.commit", { items: [{ id: s.id, amount: "125", date: "2026-11-09", category_id: cats["expense:เดินทาง"] }] });
  await call("receipts.delete", { id: s.id });
  assert.equal((await call("transactions.list", {}))[0].receipt_id, null);
});

test("deleting a category clears it from pending receipts", async () => {
  const { call, a } = await start();
  const d = await draft(call, a);
  await call("categories.delete", { id: d.category_id });
  assert.equal((await call("receipts.list", {}))[0].category_id, null);
});

test("B cannot commit, update, delete or fetch the file of A's receipt", async () => {
  const { call, callB, a, catsB } = await start();
  const d = await draft(call, a);
  await rejects(callB("receipts.commit", { items: [{ id: d.id, amount: "1", date: "2026-11-09", category_id: catsB["expense:เดินทาง"] }] }), 404);
  await rejects(callB("receipts.update", { id: d.id, amount: "1" }), 404);
  await rejects(callB("receipts.delete", { id: d.id }), 404);
  await rejects(callB("receipts.file", { id: d.id }), 404);
  assert.equal((await callB("receipts.list", {})).length, 0);
  assert.equal((await call("receipts.list", {}))[0].amount, 125);
});
