// The Supabase database in-process: PGlite (real PostgreSQL compiled to WebAssembly) with a stand-in for
// Supabase's auth/storage schemas, then every migration in cloud/supabase/migrations.
// Used by the tests and by the fake Supabase server. Functions are called the way PostgREST calls them:
// in a transaction, as the request's role, with the JWT claims in request.jwt.claims.
import { PGlite } from "@electric-sql/pglite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SUPABASE_DIR = fileURLToPath(new URL("../supabase/", import.meta.url));
const MIGRATIONS_DIR = join(SUPABASE_DIR, "migrations");

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function migrationFiles() {
  let names = [];
  try {
    names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql")).sort();
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return names.map((n) => join(MIGRATIONS_DIR, n));
}

/** A fresh in-memory database with the stand-in schemas and all migrations applied. */
export async function createDb() {
  const db = new PGlite();
  await db.exec(readFileSync(join(SUPABASE_DIR, "test", "auth-stub.sql"), "utf8"));
  for (const file of migrationFiles()) {
    try {
      await db.exec(readFileSync(file, "utf8"));
    } catch (err) {
      err.message = `${file}: ${err.message}`;
      throw err;
    }
  }
  return db;
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(String(password), salt, 32).toString("hex")}`;
}

export function passwordMatches(stored, password) {
  const m = /^scrypt\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(String(stored || ""));
  if (!m) return false;
  const want = Buffer.from(m[2], "hex");
  return timingSafeEqual(want, scryptSync(String(password), Buffer.from(m[1], "hex"), 32));
}

/** Adds a row to auth.users (as Supabase Auth would); the database's own trigger seeds the new user's data. */
export async function createUser(db, { email, password = "", confirmed = true } = {}) {
  const r = await db.query(
    "insert into auth.users (email, encrypted_password, email_confirmed_at) values ($1, $2, $3) returning id",
    [email, password ? hashPassword(password) : null, confirmed ? new Date() : null],
  );
  return r.rows[0].id;
}

/**
 * Calls public.<fn>(name => value, ...) as PostgREST would: one transaction, `set local role`, claims set.
 * Objects and arrays are passed as jsonb. SQLSTATE PTxyz becomes ApiError(xyz); anything else ApiError(500).
 * @param {{role?: string, sub?: string|null, email?: string}} claims
 */
export async function callFn(db, claims, fn, args = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new ApiError(404, "unknown function");
  const role = claims.role || "authenticated";
  if (!["anon", "authenticated", "service_role"].includes(role)) throw new ApiError(401, "bad role");
  const names = Object.keys(args);
  for (const n of names) if (!/^[a-z_][a-z0-9_]*$/.test(n)) throw new ApiError(400, "bad argument name");
  const values = names.map((n) => (args[n] !== null && typeof args[n] === "object" ? JSON.stringify(args[n]) : args[n]));
  const list = names.map((n, i) => `${n} => $${i + 1}${args[n] !== null && typeof args[n] === "object" ? "::jsonb" : ""}`).join(", ");
  const jwt = { role, ...(claims.sub ? { sub: claims.sub } : {}), ...(claims.email ? { email: claims.email } : {}) };
  try {
    return await db.transaction(async (tx) => {
      await tx.query(`set local role ${role}`);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(jwt)]);
      const r = await tx.query(`select public.${fn}(${list}) as r`, values);
      return r.rows[0].r;
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const m = /^PT(\d{3})$/.exec(err.code || "");
    if (m) throw new ApiError(Number(m[1]), err.message);
    const e = new ApiError(500, err.message);
    e.code = err.code;
    throw e;
  }
}

/** Runs public.<fn>(p => params) as a signed-in user (or as `role` with no user when userId is null). */
export function callApi(db, userId, fn, params = {}, { role = "authenticated", email } = {}) {
  return callFn(db, { role, sub: userId, email }, fn, { p: params });
}
