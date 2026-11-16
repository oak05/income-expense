// Account flows over real HTTP: sign up, email confirmation, password reset, change password, delete account.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startDev } from "../dev/server.mjs";
import { setFakeNow } from "../dev/fake-supabase.mjs";

const APP = { "x-requested-with": "fetch", "content-type": "application/json" };
let dev, base;

before(async () => {
  dev = await startDev({ port: 0 });
  base = dev.url;
});
after(() => dev.close());
beforeEach(() => dev.db.query("delete from private.auth_attempts"));

const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { ...APP, ...headers }, body: JSON.stringify(body) });
const cookiesOf = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const rpc = (cookie, action, params = {}) => post("/api/rpc", { action, params }, { cookie });
const lastMail = () => dev.mailbox.at(-1);
const linkParams = (mail) => Object.fromEntries(new URL(mail.link).searchParams);
let n = 0;
const freshEmail = () => `user${++n}-${Date.now()}@example.com`;

async function signUpAndConfirm(email = freshEmail(), password = "password-123") {
  assert.equal((await post("/api/signup", { email, password })).status, 200);
  const v = await post("/api/verify", linkParams(lastMail()));
  assert.equal(v.status, 200);
  return { email, password, cookie: cookiesOf(v), verify: await v.json() };
}

test("sign up → email link → confirm → signed in with own default categories", async () => {
  const email = freshEmail();
  const res = await post("/api/signup", { email, password: "password-123" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const mail = lastMail();
  assert.equal(mail.to, email);
  const link = new URL(mail.link);
  assert.equal(link.pathname, "/confirm.html");
  assert.equal(link.searchParams.get("type"), "email");

  const v = await post("/api/verify", linkParams(mail));
  assert.equal(v.status, 200);
  assert.deepEqual(await v.json(), { ok: true, next: "/", email }); // the page shows whose account this is
  const cookie = cookiesOf(v);
  assert.match(cookie, /sb_access=.+; sb_refresh=.+/);
  const cats = await (await rpc(cookie, "categories.list")).json();
  assert.equal(cats.length, 15);
  assert.deepEqual(await (await fetch(base + "/api/session", { headers: { cookie } })).json(), { authenticated: true, email });
});

test("sign up checks the password and email first", async () => {
  let res = await post("/api/signup", { email: freshEmail(), password: "short" });
  assert.equal(res.status, 422);
  assert.match((await res.json()).detail, /8 ตัวอักษร/);
  res = await post("/api/signup", { email: "not-an-email", password: "password-123" });
  assert.equal(res.status, 422);
  assert.match((await res.json()).detail, /อีเมลไม่ถูกต้อง/);
  assert.equal((await fetch(base + "/api/signup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 403);
});

test("sign up with an existing email looks the same and sends nothing", async () => {
  const before = dev.mailbox.length;
  const res = await post("/api/signup", { email: dev.users.a.email, password: "password-123" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(dev.mailbox.length, before);
});

test("unconfirmed login gets code email_not_confirmed; resend sends another link", async () => {
  const email = freshEmail();
  await post("/api/signup", { email, password: "password-123" });
  const res = await post("/api/login", { email, password: "password-123" });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, "email_not_confirmed");
  assert.match(body.detail, /ยืนยันอีเมล/);
  const before = dev.mailbox.length;
  setFakeNow(Date.now() + 61_000); // past Supabase's minimum interval between emails to one address
  try {
    assert.equal((await post("/api/resend", { email })).status, 200);
  } finally {
    setFakeNow(null);
  }
  assert.equal(dev.mailbox.length, before + 1);
  assert.equal(lastMail().to, email);
});

test("asking twice in a row looks the same for registered and unknown emails", async () => {
  const { email } = await signUpAndConfirm();
  for (const path of ["/api/recover", "/api/resend"]) {
    for (const who of [email, freshEmail()]) {
      const first = await post(path, { email: who });
      const second = await post(path, { email: who });
      assert.deepEqual([first.status, second.status], [200, 200], `${path} ${who}`);
      assert.deepEqual(await second.json(), { ok: true });
    }
  }
  const unconfirmed = freshEmail();
  assert.equal((await post("/api/signup", { email: unconfirmed, password: "password-123" })).status, 200);
  assert.equal((await post("/api/signup", { email: unconfirmed, password: "password-123" })).status, 200);
});

test("a used or bogus link gives 410 link_expired", async () => {
  const email = freshEmail();
  await post("/api/signup", { email, password: "password-123" });
  const params = linkParams(lastMail());
  assert.equal((await post("/api/verify", params)).status, 200);
  for (const body of [params, { token_hash: "nope", type: "email" }, { token_hash: params.token_hash, type: "other" }, {}]) {
    const res = await post("/api/verify", body);
    assert.equal(res.status, 410, JSON.stringify(body));
    const j = await res.json();
    assert.equal(j.code, "link_expired");
    assert.match(j.detail, /ลิงก์นี้ใช้แล้วหรือหมดอายุ/);
    assert.equal(res.headers.getSetCookie().length, 0);
  }
});

test("forgot password → link → new password works, old one doesn't", async () => {
  const { email, password } = await signUpAndConfirm();
  setFakeNow(Date.now() + 61_000); // a minute after the confirmation email (Supabase's interval per address)
  try {
    assert.equal((await post("/api/recover", { email })).status, 200);
  } finally {
    setFakeNow(null);
  }
  const mail = lastMail();
  assert.equal(mail.type, "recovery");
  const v = await post("/api/verify", linkParams(mail));
  assert.deepEqual(await v.json(), { ok: true, next: "/password.html?reset=1", email });
  const cookie = cookiesOf(v);
  let res = await post("/api/password", { password: "short" }, { cookie });
  assert.equal(res.status, 422);
  res = await post("/api/password", { password: "brand-new-password" }, { cookie });
  assert.equal(res.status, 200);
  assert.equal((await post("/api/login", { email, password: "brand-new-password" })).status, 200);
  assert.equal((await post("/api/login", { email, password })).status, 401);
});

test("recover for an unknown email still answers ok and sends nothing", async () => {
  const before = dev.mailbox.length;
  const res = await post("/api/recover", { email: "nobody@example.com" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(dev.mailbox.length, before);
});

test("sign-up, recover and resend are limited to 5 per hour per address", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await post("/api/signup", { email: freshEmail(), password: "password-123" })).status, 200);
  const res = await post("/api/signup", { email: freshEmail(), password: "password-123" });
  assert.equal(res.status, 429);
  assert.match((await res.json()).detail, /1 ชั่วโมง/);
  for (let i = 0; i < 5; i++) await post("/api/recover", { email: "x@example.com" });
  assert.equal((await post("/api/recover", { email: "x@example.com" })).status, 429);
  for (let i = 0; i < 5; i++) await post("/api/resend", { email: "x@example.com" });
  assert.equal((await post("/api/resend", { email: "x@example.com" })).status, 429);
});

test("change password needs a session", async () => {
  assert.equal((await post("/api/password", { password: "brand-new-password" })).status, 401);
  assert.equal((await post("/api/password", { password: "brand-new-password" }, { cookie: "sb_refresh=nope" })).status, 401);
});

test("delete account: wrong email refused; right email removes rows and every file", async () => {
  const { email, password, cookie } = await signUpAndConfirm();
  const uid = (await dev.db.query("select id from auth.users where email = $1", [email])).rows[0].id;
  const cats = await (await rpc(cookie, "categories.list")).json();
  await rpc(cookie, "transactions.create", { type: "expense", amount: "10", date: "2026-11-01", category_id: cats[0].id, note: "" });
  for (let i = 0; i < 150; i++) dev.supabase.seedObject(`${uid}/seed-${i}.jpg`, Buffer.from("x"), "image/jpeg");
  const otherFiles = dev.supabase.objectCount() - 150;

  let res = await post("/api/account", { action: "delete", email: "someone@else.com" }, { cookie });
  assert.equal(res.status, 400);
  assert.match((await res.json()).detail, /อีเมลไม่ตรงกับบัญชีนี้/);
  assert.equal(dev.supabase.objectCount(uid), 150, "nothing touched");
  assert.equal((await post("/api/account", { action: "nope", email }, { cookie })).status, 400);

  res = await post("/api/account", { action: "delete", email: email.toUpperCase() }, { cookie });
  assert.equal(res.status, 200);
  assert.ok(res.headers.getSetCookie().every((c) => /Max-Age=0/.test(c)));
  assert.equal(dev.supabase.objectCount(uid), 0);
  assert.equal(dev.supabase.objectCount(), otherFiles, "other accounts' files stay");
  const rows = await dev.db.query("select (select count(*)::int from categories where user_id = $1) c, (select count(*)::int from transactions where user_id = $1) t", [uid]);
  assert.deepEqual(rows.rows[0], { c: 0, t: 0 });

  // the old cookies no longer give access to anything
  assert.deepEqual(await (await fetch(base + "/api/session", { headers: { cookie } })).json(), { authenticated: false });
  const refreshOnly = /sb_refresh=[^;]+/.exec(cookie)[0];
  assert.equal((await rpc(refreshOnly, "categories.list")).status, 401);
  const stale = await rpc(cookie, "categories.list");
  assert.ok(stale.status === 401 || (await stale.json()).length === 0, "a still-unexpired access token sees an empty book");
  assert.equal((await post("/api/login", { email, password })).status, 401);
});

test("delete account needs a session", async () => {
  assert.equal((await post("/api/account", { action: "delete", email: "a@example.com" })).status, 401);
});

test("deleting the account right after a token refresh still clears the cookies", async () => {
  const { email, cookie } = await signUpAndConfirm();
  const refreshOnly = /sb_refresh=[^;]+/.exec(cookie)[0]; // forces a refresh inside the request
  const res = await post("/api/account", { action: "delete", email }, { cookie: refreshOnly });
  assert.equal(res.status, 200);
  const set = res.headers.getSetCookie();
  assert.equal(set.length, 2);
  assert.ok(set.every((c) => /Max-Age=0/.test(c)), set.join(" | "));
});
