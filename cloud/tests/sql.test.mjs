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
