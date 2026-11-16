// The Vercel functions (cloud/vercel/api) over real HTTP, talking to the fake Supabase (dev/fake-supabase.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { startDev } from "../dev/server.mjs";
import { createUser } from "../dev/pg.mjs";
import { setFakeNow } from "../dev/fake-supabase.mjs";

const JPEG = readFileSync(new URL("../../tests/fixtures/receipt-restaurant.jpg", import.meta.url));
const APP = { "x-requested-with": "fetch", "content-type": "application/json" };
let dev, base;

before(async () => {
  dev = await startDev({ port: 0 });
  base = dev.url;
});
after(() => dev.close());

const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { ...APP, ...headers }, body: JSON.stringify(body) });
const cookiesOf = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const login = (email = dev.users.a.email, password = dev.users.a.password, headers = {}) => post("/api/login", { email, password }, headers);
async function session(user = dev.users.a) {
  const res = await login(user.email, user.password);
  assert.equal(res.status, 200, await res.clone().text());
  return { cookie: cookiesOf(res) };
}
const rpc = (cookie, action, params = {}, headers = {}) => post("/api/rpc", { action, params }, { cookie, ...headers });
const clearThrottle = () => dev.db.query("delete from private.auth_attempts");

/* ---------- sign in & sessions ---------- */

test("nothing is readable without signing in", async () => {
  assert.equal((await post("/api/rpc", { action: "transactions.list" })).status, 401);
  assert.equal((await fetch(base + "/api/file?id=1")).status, 401);
  assert.deepEqual(await (await fetch(base + "/api/session")).json(), { authenticated: false });
});

test("wrong password is refused; right password sets two locked-down cookies", async () => {
  const bad = await login(dev.users.a.email, "nope-nope");
  assert.equal(bad.status, 401);
  assert.match((await bad.json()).detail, /อีเมลหรือรหัสผ่านไม่ถูกต้อง/);
  assert.equal(bad.headers.getSetCookie().length, 0);
  for (const pw of ["", null, 12345, { $ne: "" }]) assert.equal((await login(dev.users.a.email, pw)).status, 401);
  assert.equal((await login("", "x")).status, 401);
  await clearThrottle();

  const ok = await login();
  assert.equal(ok.status, 200);
  const cookies = ok.headers.getSetCookie();
  assert.deepEqual(cookies.map((c) => c.split("=")[0]).sort(), ["sb_access", "sb_refresh"]);
  for (const c of cookies) {
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) assert.ok(c.includes(flag), flag);
  }
  const s = await (await fetch(base + "/api/session", { headers: { cookie: cookiesOf(ok) } })).json();
  assert.deepEqual(s, { authenticated: true, email: dev.users.a.email });
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
  assert.deepEqual(await (await rpc(cookie, "info")).json(), { version: "3.0.0", email: dev.users.a.email });
});

test("each account sees only its own book through /api/rpc", async () => {
  const a = await session(dev.users.a);
  const b = await session(dev.users.b);
  const catsA = await (await rpc(a.cookie, "categories.list")).json();
  const tx = await (await rpc(a.cookie, "transactions.create", { type: "expense", amount: "12", date: "2026-10-01", category_id: catsA[0].id, note: "A only" })).json();
  const listB = await (await rpc(b.cookie, "transactions.list", {})).json();
  assert.ok(!listB.some((t) => t.note === "A only"));
  assert.equal((await rpc(b.cookie, "transactions.delete", { id: tx.id })).status, 404);
});

test("forged and tampered cookies are refused", async () => {
  const { cookie } = await session();
  const access = /sb_access=([^;]+)/.exec(cookie)[1];
  const forged = access.slice(0, -4) + "AAAA";
  for (const c of [`sb_access=${forged}; sb_refresh=nope`, `sb_access=${forged}`, "sb_refresh=nope", "sb_access=x; sb_refresh=y", ""]) {
    const res = await rpc(c, "categories.list");
    assert.equal(res.status, 401, c);
  }
});

test("an expired access token is refreshed transparently and new cookies are set", async () => {
  const { cookie } = await session();
  setFakeNow(Date.now() + 2 * 3600 * 1000); // Supabase now considers the access token expired
  try {
    const res = await rpc(cookie, "categories.list");
    assert.equal(res.status, 200);
    const renewed = res.headers.getSetCookie();
    assert.deepEqual(renewed.map((c) => c.split("=")[0]).sort(), ["sb_access", "sb_refresh"]);
    assert.equal((await rpc(cookiesOf(res), "categories.list")).status, 200);
  } finally {
    setFakeNow(null);
  }
});

test("two requests refreshing with the same refresh token both succeed", async () => {
  const { cookie } = await session();
  const refreshOnly = /sb_refresh=[^;]+/.exec(cookie)[0]; // no access cookie: both requests must refresh
  const [r1, r2] = await Promise.all([rpc(refreshOnly, "categories.list"), rpc(refreshOnly, "categories.list")]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r1.headers.getSetCookie().length, 2);
  assert.equal(r2.headers.getSetCookie().length, 2);
});

test("a validation error after a refresh still delivers the new cookies", async () => {
  const { cookie } = await session();
  const refreshOnly = /sb_refresh=[^;]+/.exec(cookie)[0];
  const res = await rpc(refreshOnly, "transactions.create", { type: "expense", amount: "-5" });
  assert.equal(res.status, 422);
  assert.equal(res.headers.getSetCookie().length, 2);
});

test("logout clears both cookies and the old refresh token stops working", async () => {
  const { cookie } = await session();
  const res = await post("/api/logout", {}, { cookie });
  assert.equal(res.status, 200);
  const cleared = res.headers.getSetCookie();
  assert.equal(cleared.length, 2);
  assert.ok(cleared.every((c) => /Max-Age=0/.test(c)));
  const refreshOnly = /sb_refresh=[^;]+/.exec(cookie)[0];
  assert.equal((await rpc(refreshOnly, "categories.list")).status, 401);
});

test("logout signs out this browser only, also after an idle hour", async () => {
  const phone = await session();
  const laptop = await session();
  const refreshOf = (c) => /sb_refresh=[^;]+/.exec(c)[0];
  assert.equal((await post("/api/logout", {}, { cookie: phone.cookie })).status, 200);
  assert.equal((await rpc(refreshOf(phone.cookie), "categories.list")).status, 401, "the phone's session is ended");
  assert.equal((await rpc(refreshOf(laptop.cookie), "categories.list")).status, 200, "the laptop stays signed in");

  const idle = await session(); // access cookie gone (expired), only the refresh cookie left
  assert.equal((await post("/api/logout", {}, { cookie: refreshOf(idle.cookie) })).status, 200);
  assert.equal((await rpc(refreshOf(idle.cookie), "categories.list")).status, 401, "revoked even without an access token");
});

test("eight wrong passwords block that email from that address, even with the right password", async () => {
  await clearThrottle();
  await createUser(dev.db, { email: "throttle@example.com", password: "right-password" });
  let last;
  for (let i = 0; i < 8; i++) last = await login("throttle@example.com", "wrong-" + i);
  assert.equal(last.status, 401);
  const blocked = await login("throttle@example.com", "right-password");
  assert.equal(blocked.status, 429);
  assert.match((await blocked.json()).detail, /15 นาที/);
  assert.equal((await login("THROTTLE@example.com ", "right-password")).status, 429, "same email in other spelling");
  assert.equal((await login()).status, 200, "another email from the same address is not blocked");
  await clearThrottle();
  assert.equal((await login("throttle@example.com", "right-password")).status, 200);
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

test("only listed actions pass; internal functions are not reachable from pages", async () => {
  const { cookie } = await session();
  for (const action of ["auth.attempt", "auth_throttle", "delete_account", "receipts.file", "receipts.create", "fail", "nope", "constructor", "", null, 7]) {
    assert.equal((await rpc(cookie, action)).status, 404, String(action));
  }
  assert.equal((await post("/api/rpc", ["not", "an", "object"], { cookie })).status, 400);
  assert.equal((await fetch(base + "/api/rpc", { method: "POST", headers: { ...APP, cookie }, body: "{bad json" })).status, 400);
  assert.equal((await fetch(base + "/api/rpc", { headers: { cookie } })).status, 405);
});

/* ---------- errors ---------- */

test("validation errors keep their status and Thai message", async () => {
  const { cookie } = await session();
  const res = await rpc(cookie, "transactions.create", { type: "expense", amount: "-5", date: "2026-11-10", category_id: 1 });
  assert.equal(res.status, 422);
  assert.match((await res.json()).detail, /จำนวนเงิน/);
  assert.equal((await rpc(cookie, "transactions.delete", { id: 99999 })).status, 404);
});

test("Supabase unreachable or a wrong key gives a clear Thai 5xx (never a 401)", async () => {
  const { cookie } = await session();
  const saved = { ...process.env };
  try {
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, "127.0.0.1", r));
    const port = dead.address().port;
    await new Promise((r) => dead.close(r));
    process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
    let res = await rpc(cookie, "categories.list");
    assert.equal(res.status, 504);
    assert.match((await res.json()).detail, /Supabase/);
    res = await login();
    assert.equal(res.status, 504);

    process.env.SUPABASE_URL = saved.SUPABASE_URL;
    process.env.SUPABASE_ANON_KEY = "wrong";
    res = await rpc(cookie, "categories.list");
    assert.equal(res.status, 502);
    assert.match((await res.json()).detail, /SUPABASE_ANON_KEY/);
  } finally {
    Object.assign(process.env, saved);
  }
});

test("missing settings are named instead of failing mysteriously", async () => {
  for (const name of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "APPS_SCRIPT_URL", "APPS_SCRIPT_SECRET"]) {
    const saved = process.env[name];
    try {
      delete process.env[name];
      const res = await login();
      assert.equal(res.status, 500, name);
      assert.match((await res.json()).detail, new RegExp(name));
    } finally {
      process.env[name] = saved;
    }
  }
});

test("requests over the size limit are refused", async () => {
  const { cookie } = await session();
  const big = await rpc(cookie, "transactions.import", { rows: "A".repeat(4.2 * 1024 * 1024) });
  assert.equal(big.status, 413);
  const res = await post("/api/login", { email: "a@example.com", password: "x".repeat(5000) });
  assert.equal(res.status, 413);
});

/* ---------- receipts & files ---------- */

const PDF = readFileSync(new URL("../../tests/fixtures/ereceipt-shopee.pdf", import.meta.url));
const upload = (cookie, bytes = JPEG, name = "ส้มตำ.jpg") => rpc(cookie, "receipts.upload", { name, data: bytes.toString("base64") });

test("a receipt goes up as base64, is read, and its file comes back through /api/file", async () => {
  const { cookie } = await session();
  const up = await upload(cookie);
  assert.equal(up.status, 200);
  const draft = await up.json();
  assert.equal(draft.status, "pending");
  assert.ok(draft.amount > 0);
  assert.equal(draft.original_name, "ส้มตำ.jpg");
  assert.equal(draft.text_source, "drive-ocr");
  assert.ok(draft.category_id);

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

test("B cannot fetch A's receipt file", async () => {
  const a = await session(dev.users.a);
  const b = await session(dev.users.b);
  const draft = await (await upload(a.cookie)).json();
  assert.equal((await fetch(`${base}/api/file?id=${draft.id}`, { headers: { cookie: b.cookie } })).status, 404);
});

test("file type is decided by content, not by the name; bad or oversized files are refused", async () => {
  const { cookie } = await session();
  const pdf = await (await upload(cookie, PDF, "photo.jpg")).json();
  assert.equal(pdf.is_pdf, true);
  assert.equal(pdf.text_source, "drive-pdf");
  let res = await upload(cookie, Buffer.from("hello world"), "x.jpg");
  assert.equal(res.status, 400);
  assert.match((await res.json()).detail, /JPG/);
  assert.equal((await rpc(cookie, "receipts.upload", { name: "x", data: "" })).status, 400);
  assert.equal((await rpc(cookie, "receipts.upload", { name: "x", data: "###" })).status, 400);
  res = await upload(cookie, Buffer.concat([JPEG.subarray(0, 4), Buffer.alloc(2.6 * 1024 * 1024)]));
  assert.equal(res.status, 413);
});

test("OCR down: the receipt is still saved with an error and no amount", async () => {
  const { cookie } = await session();
  const saved = process.env.APPS_SCRIPT_URL;
  try {
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, "127.0.0.1", r));
    const port = dead.address().port;
    await new Promise((r) => dead.close(r));
    process.env.APPS_SCRIPT_URL = `http://127.0.0.1:${port}/exec`;
    const res = await upload(cookie);
    assert.equal(res.status, 200);
    const draft = await res.json();
    assert.equal(draft.amount, null);
    assert.ok(draft.flags.includes("no_amount") && draft.flags.includes("no_date"));
    assert.match(draft.error, /ใส่ยอดเอง/);
    assert.match(draft.date, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    process.env.APPS_SCRIPT_URL = saved;
  }
});

test("a wrong OCR secret also keeps the receipt", async () => {
  const { cookie } = await session();
  const saved = process.env.APPS_SCRIPT_SECRET;
  try {
    process.env.APPS_SCRIPT_SECRET = "not-the-secret";
    const draft = await (await upload(cookie)).json();
    assert.equal(draft.amount, null);
    assert.match(draft.error, /ใส่ยอดเอง/);
  } finally {
    process.env.APPS_SCRIPT_SECRET = saved;
  }
});

test("storage failure leaves no receipt row", async () => {
  const { cookie } = await session();
  const before = (await (await rpc(cookie, "receipts.list", {})).json()).length;
  dev.supabase.failNextUpload();
  const res = await upload(cookie);
  assert.equal(res.status, 502);
  assert.match((await res.json()).detail, /เก็บไฟล์ใบเสร็จไม่สำเร็จ/);
  assert.equal((await (await rpc(cookie, "receipts.list", {})).json()).length, before);
});

test("a refused draft removes the file it just stored", async () => {
  const { cookie } = await session();
  const objects = dev.supabase.objectCount();
  await dev.db.exec("alter table receipts add constraint no_receipts_now check (false) not valid");
  try {
    assert.equal((await upload(cookie)).status, 500);
  } finally {
    await dev.db.exec("alter table receipts drop constraint no_receipts_now");
  }
  assert.equal(dev.supabase.objectCount(), objects);
});

test("deleting the transaction removes the stored file", async () => {
  const { cookie } = await session();
  const draft = await (await upload(cookie)).json();
  const objects = dev.supabase.objectCount();
  const cats = await (await rpc(cookie, "categories.list")).json();
  const food = cats.find((c) => c.type === "expense").id;
  assert.equal((await rpc(cookie, "receipts.commit", { items: [{ id: draft.id, amount: "65", date: "2026-11-09", category_id: food }] })).status, 200);
  const tx = (await (await rpc(cookie, "transactions.list", {})).json()).find((t) => t.receipt_id === draft.id);
  const del = await (await rpc(cookie, "transactions.delete", { id: tx.id })).json();
  assert.deepEqual(del, { ok: true, receipts_removed: 1 });
  assert.equal(dev.supabase.objectCount(), objects - 1);
  assert.equal((await fetch(`${base}/api/file?id=${draft.id}`, { headers: { cookie } })).status, 404);

  const pending = await (await upload(cookie)).json();
  assert.deepEqual(await (await rpc(cookie, "receipts.delete", { id: pending.id })).json(), { ok: true });
  assert.equal(dev.supabase.objectCount(), objects - 1);
});

/* ---------- static pages ---------- */

test("pages are served with the security headers from vercel.json", async () => {
  for (const path of ["/", "/login.html", "/receipts.html", "/app.js", "/csv.js", "/icons.svg", "/vendor/chart.umd.min.js"]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(res.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal((await fetch(base + "/../package.json")).status, 404);
  assert.equal((await fetch(base + "/%2e%2e/package.json")).status, 404);
});

test("the pages contain no inline scripts or handlers (the CSP would block them)", () => {
  const dir = new URL("../vercel/public/", import.meta.url);
  for (const page of readdirSync(dir).filter((n) => n.endsWith(".html"))) {
    const html = readFileSync(new URL(page, dir), "utf8");
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${page}: inline <script>`);
    assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html), `${page}: inline event handler`);
  }
});

test("signed-in pages offer change password and delete account, and no Google Sheet link", () => {
  for (const page of ["index.html", "receipts.html"]) {
    const html = readFileSync(new URL(`../vercel/public/${page}`, import.meta.url), "utf8");
    assert.ok(html.includes('href="/password.html"'), `${page}: change password`);
    assert.ok(html.includes("data-delete-account"), `${page}: delete account`);
    assert.ok(html.includes('id="delete-account-dialog"'), `${page}: delete dialog`);
    assert.ok(!/sheet-link|folder-link|Google Sheet/.test(html), `${page}: no Google Sheet`);
    assert.ok(!html.includes("v=2.1.0"), `${page}: version strings`);
  }
  const app = readFileSync(new URL("../vercel/public/app.js", import.meta.url), "utf8");
  assert.ok(!/sheet_url|showSheetLinks/.test(app));
});
