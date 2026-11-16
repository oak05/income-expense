// The Vercel functions (cloud/vercel/api) talking over real HTTP to the fake Apps Script web app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { startDev } from "../dev/server.mjs";
import { createSession, sessionValid } from "../vercel/lib/server.js";

const JPEG = readFileSync(new URL("../../tests/fixtures/receipt-restaurant.jpg", import.meta.url));
const APP = { "x-requested-with": "fetch", "content-type": "application/json" };
let dev, base;

before(async () => {
  dev = await startDev({ port: 0, password: "correct horse battery" });
  base = dev.url;
});
after(() => dev.close());

const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { ...APP, ...headers }, body: JSON.stringify(body) });
const cookieOf = (res) => (res.headers.getSetCookie()[0] || "").split(";")[0];
async function login(password = dev.password, headers = {}) {
  return post("/api/login", { password }, headers);
}
async function session() {
  const res = await login();
  assert.equal(res.status, 200);
  return { cookie: cookieOf(res) };
}
const rpc = (cookie, action, params = {}, headers = {}) => post("/api/rpc", { action, params }, { cookie, ...headers });

/* ---------- login & sessions ---------- */

test("nothing is readable without signing in", async () => {
  assert.equal((await post("/api/rpc", { action: "transactions.list" })).status, 401);
  assert.equal((await fetch(base + "/api/file?id=1")).status, 401);
  assert.deepEqual(await (await fetch(base + "/api/session")).json(), { authenticated: false });
});

test("wrong password is refused; right password sets a locked-down cookie", async () => {
  const bad = await login("nope", { "x-forwarded-for": "9.9.9.1" });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.getSetCookie().length, 0);
  for (const pw of ["", null, 12345, { $ne: "" }]) assert.equal((await login(pw)).status, 401);

  const ok = await login();
  assert.equal(ok.status, 200);
  const cookie = ok.headers.getSetCookie()[0];
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) assert.ok(cookie.includes(flag), flag);
  const s = await (await fetch(base + "/api/session", { headers: { cookie: cookieOf(ok) } })).json();
  assert.deepEqual(s, { authenticated: true });
});

test("a signed-in page can read and write through /api/rpc", async () => {
  const { cookie } = await session();
  const cats = await (await rpc(cookie, "categories.list")).json();
  assert.equal(cats.length, 15);
  const created = await rpc(cookie, "transactions.create", { type: "expense", amount: "59.00", date: "2026-11-10", category_id: cats[1].id, note: "BTS" });
  assert.equal(created.status, 200);
  const month = await (await rpc(cookie, "month.get", { month: "2026-11" })).json();
  assert.equal(month.totals.expense, 59);
  assert.equal(month.transactions[0].note, "BTS");
});

test("forged, expired and tampered cookies are refused", async () => {
  const { cookie } = await session();
  const value = cookie.split("=")[1];
  const flipped = value.slice(0, -1) + (value.endsWith("A") ? "B" : "A");
  const later = value.replace(/^\d+/, (n) => String(Number(n) + 86400)); // extend the expiry, keep the signature
  for (const forged of [flipped, later, "9999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "x", ""]) {
    assert.equal((await rpc("session=" + forged, "categories.list")).status, 401, forged);
  }
  const cfg = { password: "p".repeat(12), sessionSecret: "s".repeat(40) };
  const now = Date.UTC(2026, 10, 10);
  const token = createSession(cfg, now);
  assert.equal(sessionValid(token, cfg, now + 29 * 86400e3), true);
  assert.equal(sessionValid(token, cfg, now + 31 * 86400e3), false, "expires after 30 days");
  assert.equal(sessionValid(token, { ...cfg, password: "changed-password" }, now), false, "changing the password signs everyone out");
  assert.equal(sessionValid(token, { ...cfg, sessionSecret: "t".repeat(40) }, now), false);
});

test("logout clears the cookie", async () => {
  const res = await post("/api/logout", {});
  assert.equal(res.status, 200);
  assert.match(res.headers.getSetCookie()[0], /^session=; .*Max-Age=0/);
});

test("eight wrong passwords from one address block it for a while, even with the right password", async () => {
  const from = { "x-forwarded-for": "9.9.9.2" };
  // the dev server overwrites x-forwarded-for like Vercel does, so count against the real caller instead
  let last;
  for (let i = 0; i < 8; i++) last = await login("wrong-" + i, from);
  assert.equal(last.status, 401);
  const blocked = await login(dev.password, from);
  assert.equal(blocked.status, 429);
  assert.match((await blocked.json()).detail, /15 นาที/);
  dev.backend.state.cache.clear(); // let the other tests sign in again
});

/* ---------- requests from other websites ---------- */

test("writes need the app header and a same-origin request", async () => {
  const { cookie } = await session();
  const body = JSON.stringify({ action: "transactions.list", params: {} });
  const attempt = (headers) => fetch(base + "/api/rpc", { method: "POST", headers: { cookie, ...headers }, body });

  assert.equal((await attempt({ "content-type": "text/plain" })).status, 403, "no custom header (what a cross-site form can send)");
  assert.equal((await attempt({ ...APP, origin: "https://evil.example" })).status, 403);
  assert.equal((await attempt({ ...APP, origin: "null" })).status, 403);
  assert.equal((await attempt({ ...APP, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await attempt({ ...APP, "sec-fetch-site": "same-site" })).status, 403);
  assert.equal((await attempt({ ...APP, origin: base, "sec-fetch-site": "same-origin" })).status, 200);

  assert.equal((await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 403);
  assert.equal((await fetch(base + "/api/logout", { method: "POST", headers: { origin: "https://evil.example", ...APP }, body: "{}" })).status, 403);
});

test("only listed actions pass; the login throttle and file actions are not reachable from pages", async () => {
  const { cookie } = await session();
  for (const action of ["auth.attempt", "receipts.file", "nope", "constructor", "", null, 7]) {
    assert.equal((await rpc(cookie, action)).status, 404, String(action));
  }
  assert.equal((await post("/api/rpc", ["not", "an", "object"], { cookie })).status, 400);
  assert.equal((await fetch(base + "/api/rpc", { method: "POST", headers: { ...APP, cookie }, body: "{bad json" })).status, 400);
  assert.equal((await fetch(base + "/api/rpc", { headers: { cookie } })).status, 405);
});

/* ---------- errors from the backend ---------- */

test("validation errors keep their status and Thai message", async () => {
  const { cookie } = await session();
  const res = await rpc(cookie, "transactions.create", { type: "expense", amount: "-5", date: "2026-11-10", category_id: 1 });
  assert.equal(res.status, 422);
  assert.match((await res.json()).detail, /จำนวนเงิน/);
  assert.equal((await rpc(cookie, "transactions.delete", { id: 99999 })).status, 404);
});

test("a wrong backend secret, a wrong URL and an unreachable backend each give a clear 5xx (never a 401)", async () => {
  const { cookie } = await session();
  const saved = { ...process.env };
  try {
    process.env.APPS_SCRIPT_SECRET = "not-the-secret";
    let res = await rpc(cookie, "categories.list");
    assert.equal(res.status, 502);
    assert.match((await res.json()).detail, /APPS_SCRIPT_SECRET/);

    process.env.APPS_SCRIPT_SECRET = saved.APPS_SCRIPT_SECRET;
    process.env.APPS_SCRIPT_URL = saved.APPS_SCRIPT_URL.replace("/exec", "/wrong"); // answers with an HTML page
    res = await rpc(cookie, "categories.list");
    assert.equal(res.status, 502);
    assert.match((await res.json()).detail, /APPS_SCRIPT_URL/);

    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, "127.0.0.1", r));
    const port = dead.address().port;
    await new Promise((r) => dead.close(r));
    process.env.APPS_SCRIPT_URL = `http://127.0.0.1:${port}/exec`;
    assert.equal((await rpc(cookie, "categories.list")).status, 504);
  } finally {
    Object.assign(process.env, saved);
  }
});

test("missing settings are named instead of failing mysteriously", async () => {
  const saved = process.env.SESSION_SECRET;
  try {
    delete process.env.SESSION_SECRET;
    const res = await login();
    assert.equal(res.status, 500);
    assert.match((await res.json()).detail, /SESSION_SECRET/);
    process.env.SESSION_SECRET = "short";
    assert.match((await (await login()).json()).detail, /32/);
  } finally {
    process.env.SESSION_SECRET = saved;
  }
});

/* ---------- receipts & files ---------- */

test("a receipt goes up as base64, is read, and its file comes back through /api/file", async () => {
  const { cookie } = await session();
  const up = await rpc(cookie, "receipts.upload", { name: "ส้มตำ.jpg", data: JPEG.toString("base64") });
  assert.equal(up.status, 200);
  const draft = await up.json();
  assert.equal(draft.status, "pending");
  assert.ok(draft.amount > 0);

  const file = await fetch(`${base}/api/file?id=${draft.id}`, { headers: { cookie } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "image/jpeg");
  assert.equal(file.headers.get("x-content-type-options"), "nosniff");
  assert.match(file.headers.get("cache-control"), /private/);
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(JPEG));

  assert.equal((await fetch(`${base}/api/file?id=${draft.id}`)).status, 401);
  assert.equal((await fetch(`${base}/api/file?id=abc`, { headers: { cookie } })).status, 400);
  assert.equal((await fetch(`${base}/api/file?id=99999`, { headers: { cookie } })).status, 404);
});

test("requests over the size limit are refused", async () => {
  const { cookie } = await session();
  const big = await rpc(cookie, "receipts.upload", { name: "x.jpg", data: "A".repeat(4.2 * 1024 * 1024) });
  assert.equal(big.status, 413);
  const res = await post("/api/login", { password: "x".repeat(5000) });
  assert.equal(res.status, 413);
});

/* ---------- static pages ---------- */

test("pages are served with the security headers from vercel.json", async () => {
  for (const path of ["/", "/login.html", "/receipts.html", "/app.js", "/csv.js", "/icons.svg", "/vendor/chart.umd.min.js"]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal((await fetch(base + "/../package.json")).status, 404);
  assert.equal((await fetch(base + "/%2e%2e/package.json")).status, 404);
});

test("the pages contain no inline scripts or handlers (the CSP would block them)", () => {
  for (const page of ["index.html", "receipts.html", "login.html"]) {
    const html = readFileSync(new URL(`../vercel/public/${page}`, import.meta.url), "utf8");
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${page}: inline <script>`);
    assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html), `${page}: inline event handler`);
  }
});
