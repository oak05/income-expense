// The local stand-in for Supabase answers the HTTP calls Vercel makes the way Supabase does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, createUser } from "../dev/pg.mjs";
import { startFakeSupabase, setFakeNow } from "../dev/fake-supabase.mjs";

let sb, db;
before(async () => {
  db = await createDb();
  await createUser(db, { email: "a@example.com", password: "password-a" });
  await createUser(db, { email: "b@example.com", password: "password-b" });
  sb = await startFakeSupabase({ db, siteUrl: "http://app.test" });
});
after(() => sb.close());

const req = (path, { method = "POST", body, token, key = sb.anonKey, raw, type } = {}) => fetch(sb.url + path, {
  method,
  headers: {
    apikey: key,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    "content-type": type || "application/json",
  },
  body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
});
const signIn = async (email = "a@example.com", password = "password-a") =>
  (await req("/auth/v1/token?grant_type=password", { body: { email, password } })).json();

test("every request needs a known API key", async () => {
  const r = await req("/auth/v1/user", { method: "GET", key: "nope" });
  assert.equal(r.status, 401);
});

test("password grant gives a session; /user answers with it", async () => {
  const s = await signIn();
  assert.ok(s.access_token && s.refresh_token && s.expires_at && s.user.id);
  assert.equal(s.user.email, "a@example.com");
  const u = await (await req("/auth/v1/user", { method: "GET", token: s.access_token })).json();
  assert.equal(u.id, s.user.id);
  const bad = await req("/auth/v1/token?grant_type=password", { body: { email: "a@example.com", password: "wrong" } });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error_code, "invalid_credentials");
});

test("refresh tokens rotate; the old one works for 10 seconds, then not", async () => {
  const s = await signIn();
  const t0 = Date.now();
  setFakeNow(t0);
  try {
    const r1 = await (await req("/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: s.refresh_token } })).json();
    assert.ok(r1.refresh_token && r1.refresh_token !== s.refresh_token);
    setFakeNow(t0 + 5000);
    const again = await req("/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: s.refresh_token } });
    assert.equal(again.status, 200, "a second tab refreshing at the same moment still succeeds");
    setFakeNow(t0 + 11000);
    const late = await req("/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: s.refresh_token } });
    assert.equal(late.status, 400);
    assert.equal((await late.json()).error_code, "refresh_token_already_used");
    const unknown = await req("/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: "zzz" } });
    assert.equal((await unknown.json()).error_code, "refresh_token_not_found");
  } finally {
    setFakeNow(null);
  }
});

test("logout revokes the refresh tokens", async () => {
  const s = await signIn();
  assert.equal((await req("/auth/v1/logout", { token: s.access_token })).status, 204);
  const r = await req("/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: s.refresh_token } });
  assert.equal(r.status, 400);
});

test("rpc runs as the user and maps PTxyz to the HTTP status", async () => {
  const s = await signIn();
  const cats = await req("/rest/v1/rpc/api_categories_list", { body: { p: {} }, token: s.access_token });
  assert.equal(cats.status, 200);
  assert.equal((await cats.json()).length, 15);
  const missing = await req("/rest/v1/rpc/api_transactions_delete", { body: { p: { id: 999999 } }, token: s.access_token });
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).message, /ไม่พบรายการ/);
  const noFn = await req("/rest/v1/rpc/nope", { body: { p: {} }, token: s.access_token });
  assert.equal(noFn.status, 404);
});

test("an expired or forged access token gets 401 PGRST301", async () => {
  const s = await signIn();
  setFakeNow(Date.now() + 2 * 3600 * 1000);
  try {
    const r = await req("/rest/v1/rpc/api_categories_list", { body: { p: {} }, token: s.access_token });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, "PGRST301");
  } finally {
    setFakeNow(null);
  }
  const forged = s.access_token.slice(0, -4) + "AAAA";
  assert.equal((await req("/rest/v1/rpc/api_categories_list", { body: { p: {} }, token: forged })).status, 401);
});

test("the service key runs auth_throttle; a user token cannot", async () => {
  const args = { p_kind: "login", p_key: "k", p_outcome: "check" };
  const ok = await req("/rest/v1/rpc/auth_throttle", { body: args, key: sb.serviceKey });
  assert.deepEqual(await ok.json(), { blocked: false });
  const s = await signIn();
  assert.equal((await req("/rest/v1/rpc/auth_throttle", { body: args, token: s.access_token })).status, 403);
});

test("sign up → mailed link → verify gives a session once; the second try is otp_expired", async () => {
  const r = await req("/auth/v1/signup", { body: { email: "new@example.com", password: "password-new" } });
  assert.equal(r.status, 200);
  const mail = sb.mailbox.at(-1);
  assert.equal(mail.to, "new@example.com");
  assert.equal(mail.type, "email");
  const link = new URL(mail.link);
  assert.equal(link.origin + link.pathname, "http://app.test/confirm.html");
  const unconfirmed = await req("/auth/v1/token?grant_type=password", { body: { email: "new@example.com", password: "password-new" } });
  assert.equal((await unconfirmed.json()).error_code, "email_not_confirmed");

  const body = { type: "email", token_hash: link.searchParams.get("token_hash") };
  const v = await req("/auth/v1/verify", { body });
  assert.equal(v.status, 200);
  assert.ok((await v.json()).access_token);
  const again = await req("/auth/v1/verify", { body });
  assert.equal(again.status, 403);
  assert.equal((await again.json()).error_code, "otp_expired");
  assert.ok((await signIn("new@example.com", "password-new")).access_token);

  const before = sb.mailbox.length;
  assert.equal((await req("/auth/v1/signup", { body: { email: "new@example.com", password: "whatever-1" } })).status, 200);
  assert.equal(sb.mailbox.length, before, "an existing email gets the same answer and no mail");
  assert.equal((await req("/auth/v1/signup", { body: { email: "x", password: "password-x" } })).status, 400);
  assert.equal((await req("/auth/v1/signup", { body: { email: "y@example.com", password: "123" } })).status, 422);
});

test("recover mails a recovery link only to known emails; PUT /user changes the password", async () => {
  const before = sb.mailbox.length;
  assert.equal((await req("/auth/v1/recover", { body: { email: "nobody@example.com" } })).status, 200);
  assert.equal(sb.mailbox.length, before);
  await req("/auth/v1/recover", { body: { email: "b@example.com" } });
  const mail = sb.mailbox.at(-1);
  assert.equal(mail.type, "recovery");
  const s = await (await req("/auth/v1/verify", { body: { type: "recovery", token_hash: new URL(mail.link).searchParams.get("token_hash") } })).json();
  assert.equal((await req("/auth/v1/user", { method: "PUT", body: { password: "12" }, token: s.access_token })).status, 422);
  assert.equal((await req("/auth/v1/user", { method: "PUT", body: { password: "new-password-b" }, token: s.access_token })).status, 200);
  assert.ok((await signIn("b@example.com", "new-password-b")).access_token);
  assert.equal((await signIn("b@example.com", "password-b")).error_code, "invalid_credentials");
});

test("storage: only the owner's folder; list pages; delete by prefixes", async () => {
  const a = await signIn();
  const b = await signIn("b@example.com", "new-password-b"); // changed by the test above
  const path = `${a.user.id}/one.jpg`;
  const up = await req(`/storage/v1/object/receipts/${path}`, { token: a.access_token, raw: Buffer.from("JPEGDATA"), type: "image/jpeg" });
  assert.equal(up.status, 200);
  const down = await req(`/storage/v1/object/receipts/${path}`, { method: "GET", token: a.access_token });
  assert.equal(down.status, 200);
  assert.equal(down.headers.get("content-type"), "image/jpeg");
  assert.equal(Buffer.from(await down.arrayBuffer()).toString(), "JPEGDATA");
  assert.notEqual((await req(`/storage/v1/object/receipts/${path}`, { method: "GET", token: b.access_token })).status, 200);
  assert.notEqual((await req(`/storage/v1/object/receipts/${path}`, { token: b.access_token, raw: Buffer.from("x"), type: "image/jpeg" })).status, 200);

  for (let i = 0; i < 120; i++) sb.seedObject(`${a.user.id}/seed-${String(i).padStart(3, "0")}.jpg`, Buffer.from("x"), "image/jpeg");
  const page1 = await (await req("/storage/v1/object/list/receipts", { body: { prefix: a.user.id, limit: 100, offset: 0 }, token: a.access_token })).json();
  const page2 = await (await req("/storage/v1/object/list/receipts", { body: { prefix: a.user.id, limit: 100, offset: 100 }, token: a.access_token })).json();
  assert.equal(page1.length, 100);
  assert.equal(page2.length, 21);
  assert.ok(page1.every((o) => !o.name.includes("/")));
  const none = await (await req("/storage/v1/object/list/receipts", { body: { prefix: a.user.id, limit: 100, offset: 0 }, token: b.access_token })).json();
  assert.equal(none.length, 0);

  const notMine = await (await req("/storage/v1/object/receipts", { method: "DELETE", body: { prefixes: [path] }, token: b.access_token })).json();
  assert.deepEqual(notMine, []);
  const gone = await (await req("/storage/v1/object/receipts", { method: "DELETE", body: { prefixes: [path] }, token: a.access_token })).json();
  assert.equal(gone.length, 1);
  assert.notEqual((await req(`/storage/v1/object/receipts/${path}`, { method: "GET", token: a.access_token })).status, 200);

  sb.failNextUpload();
  assert.equal((await req(`/storage/v1/object/receipts/${a.user.id}/two.jpg`, { token: a.access_token, raw: Buffer.from("x"), type: "image/jpeg" })).status, 500);
});
