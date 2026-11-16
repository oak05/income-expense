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
