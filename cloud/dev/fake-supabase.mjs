// A local stand-in for the parts of Supabase that the Vercel functions call, over real HTTP:
//   /auth/v1/*      sign in, refresh (rotating, 10 s reuse window), sign out, user, sign up, verify, recover, resend
//   /rest/v1/rpc/*  database functions, run in PGlite as the caller's role with the JWT claims set
//   /storage/v1/*   the "receipts" bucket, kept in memory, owner-only like the bucket's policies
// Emails are not sent: they are pushed to `mailbox` (and printed when `log` is on).
// It is a model of how Supabase behaves, written from its documented responses, not Supabase itself.
import http from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { callFn, ApiError, hashPassword, passwordMatches } from "./pg.mjs";

let fakeNow = null;
/** Moves the fake's clock (JWT expiry, refresh reuse window); null = real time. */
export function setFakeNow(ms) {
  fakeNow = ms;
}
const now = () => fakeNow ?? Date.now();

const REUSE_INTERVAL_MS = 10_000;
const LINK_TTL_MS = 3600_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startFakeSupabase({ db, siteUrl = "http://localhost:3000", accessTtlSeconds = 3600, port = 0, log = false } = {}) {
  const jwtSecret = randomBytes(32);
  const anonKey = "sb_publishable_fake";
  const serviceKey = "sb_secret_fake";
  const refreshTokens = new Map(); // token -> {userId, usedAt, child}
  const links = new Map(); // token_hash -> {type, userId, expires}
  const objects = new Map(); // "<path>" -> {bytes, mime}
  const mailbox = [];
  let failUpload = false;

  /* ---------- tokens ---------- */

  function signJwt(user) {
    const head = b64url({ alg: "HS256", typ: "JWT" });
    const exp = Math.floor(now() / 1000) + accessTtlSeconds;
    const body = b64url({ sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", exp });
    const sig = createHmac("sha256", jwtSecret).update(`${head}.${body}`).digest("base64url");
    return { token: `${head}.${body}.${sig}`, exp };
  }

  function verifyJwt(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const want = createHmac("sha256", jwtSecret).update(`${parts[0]}.${parts[1]}`).digest();
    const got = Buffer.from(parts[2], "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    let claims;
    try {
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    } catch {
      return null;
    }
    return claims.exp * 1000 > now() ? claims : null;
  }

  function session(user) {
    const { token, exp } = signJwt(user);
    const refresh = randomBytes(24).toString("hex");
    refreshTokens.set(refresh, { userId: user.id, usedAt: null, child: null });
    return {
      access_token: token, token_type: "bearer", expires_in: accessTtlSeconds, expires_at: exp,
      refresh_token: refresh, user: { id: user.id, email: user.email },
    };
  }

  /* ---------- users ---------- */

  const userByEmail = async (email) =>
    (await db.query("select id, email, encrypted_password, email_confirmed_at from auth.users where lower(email) = lower($1)", [email])).rows[0];
  const userById = async (id) =>
    (await db.query("select id, email, encrypted_password, email_confirmed_at from auth.users where id = $1", [id])).rows[0];

  function mail(to, type, userId) {
    const tokenHash = randomBytes(20).toString("hex");
    links.set(tokenHash, { type, userId, expires: now() + LINK_TTL_MS });
    const link = `${api.siteUrl}/confirm.html?token_hash=${tokenHash}&type=${type}`;
    mailbox.push({ to, type, link });
    if (log) console.log(`\n  [อีเมลจำลอง] ถึง ${to} (${type === "email" ? "ยืนยันอีเมล" : "ตั้งรหัสผ่านใหม่"}):\n  ${link}\n`);
  }

  /* ---------- HTTP ---------- */

  const send = (res, status, body, headers = {}) => {
    if (body === undefined) return void res.writeHead(status, headers).end();
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  };
  const authErr = (res, status, error_code, msg) => send(res, status, { code: status, error_code, msg });

  async function bearerUser(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    return m ? verifyJwt(m[1]) : null;
  }

  async function handleAuth(req, res, path, url, body) {
    if (req.method === "POST" && path === "/token") {
      const grant = url.searchParams.get("grant_type");
      if (grant === "password") {
        const user = await userByEmail(String(body.email || ""));
        if (!user || !passwordMatches(user.encrypted_password, body.password)) {
          return authErr(res, 400, "invalid_credentials", "Invalid login credentials");
        }
        if (!user.email_confirmed_at) return authErr(res, 400, "email_not_confirmed", "Email not confirmed");
        return send(res, 200, session(user));
      }
      if (grant === "refresh_token") {
        const rt = refreshTokens.get(String(body.refresh_token || ""));
        if (!rt) return authErr(res, 400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
        const user = await userById(rt.userId);
        if (!user) return authErr(res, 400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
        if (rt.usedAt !== null) {
          if (now() - rt.usedAt > REUSE_INTERVAL_MS) {
            return authErr(res, 400, "refresh_token_already_used", "Invalid Refresh Token: Already Used");
          }
          const { token, exp } = signJwt(user); // inside the reuse window: hand out the same child token again
          return send(res, 200, { access_token: token, token_type: "bearer", expires_in: accessTtlSeconds, expires_at: exp,
            refresh_token: rt.child, user: { id: user.id, email: user.email } });
        }
        const s = session(user);
        rt.usedAt = now();
        rt.child = s.refresh_token;
        return send(res, 200, s);
      }
      return authErr(res, 400, "unsupported_grant_type", "unsupported grant type");
    }
    if (req.method === "POST" && path === "/logout") {
      const claims = await bearerUser(req);
      if (!claims) return authErr(res, 401, "bad_jwt", "invalid JWT");
      for (const [k, v] of refreshTokens) if (v.userId === claims.sub) refreshTokens.delete(k);
      return send(res, 204);
    }
    if (path === "/user" && (req.method === "GET" || req.method === "PUT")) {
      const claims = await bearerUser(req);
      const user = claims && (await userById(claims.sub));
      if (!user) return authErr(res, 401, "bad_jwt", "invalid JWT");
      if (req.method === "PUT") {
        if (typeof body.password !== "string" || body.password.length < 6) {
          return authErr(res, 422, "weak_password", "Password should be at least 6 characters.");
        }
        await db.query("update auth.users set encrypted_password = $1 where id = $2", [hashPassword(body.password), user.id]);
      }
      return send(res, 200, { id: user.id, email: user.email });
    }
    if (req.method === "POST" && path === "/signup") {
      const email = String(body.email || "").trim();
      if (!EMAIL_RE.test(email)) return authErr(res, 400, "email_address_invalid", "Email address is invalid");
      if (typeof body.password !== "string" || body.password.length < 6) {
        return authErr(res, 422, "weak_password", "Password should be at least 6 characters.");
      }
      const existing = await userByEmail(email);
      if (existing) return send(res, 200, { id: randomBytes(16).toString("hex"), email }); // looks the same, sends nothing
      const r = await db.query("insert into auth.users (email, encrypted_password) values ($1, $2) returning id",
        [email.toLowerCase(), hashPassword(body.password)]);
      mail(email.toLowerCase(), "email", r.rows[0].id);
      return send(res, 200, { id: r.rows[0].id, email: email.toLowerCase() });
    }
    if (req.method === "POST" && path === "/recover") {
      const user = await userByEmail(String(body.email || ""));
      if (user) mail(user.email, "recovery", user.id);
      return send(res, 200, {});
    }
    if (req.method === "POST" && path === "/resend") {
      const user = await userByEmail(String(body.email || ""));
      if (user && !user.email_confirmed_at && body.type === "signup") mail(user.email, "email", user.id);
      return send(res, 200, {});
    }
    if (req.method === "POST" && path === "/verify") {
      const link = links.get(String(body.token_hash || ""));
      const type = body.type === "signup" ? "email" : body.type;
      if (!link || link.type !== type || link.expires < now()) {
        return authErr(res, 403, "otp_expired", "Email link is invalid or has expired");
      }
      links.delete(String(body.token_hash));
      if (type === "email") await db.query("update auth.users set email_confirmed_at = now() where id = $1", [link.userId]);
      const user = await userById(link.userId);
      if (!user) return authErr(res, 403, "otp_expired", "Email link is invalid or has expired");
      return send(res, 200, session(user));
    }
    return send(res, 404, { code: 404, msg: "not found" });
  }

  async function handleRpc(req, res, fn, body) {
    let claims;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (m && m[1] === serviceKey) claims = { role: "service_role" };
    else if (m) {
      const jwt = verifyJwt(m[1]);
      if (!jwt) return send(res, 401, { code: "PGRST301", message: "JWT expired", details: null, hint: null });
      claims = { role: "authenticated", sub: jwt.sub, email: jwt.email };
    } else claims = { role: req.headers.apikey === serviceKey ? "service_role" : "anon" };
    try {
      const data = await callFn(db, claims, fn, body && typeof body === "object" ? body : {});
      return send(res, 200, data);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.status !== 500) return send(res, err.status, { code: `PT${err.status}`, message: err.message, details: null, hint: null });
      if (err.code === "42883") return send(res, 404, { code: "PGRST202", message: err.message });
      if (err.code === "42501") return send(res, claims.role === "anon" ? 401 : 403, { code: "42501", message: err.message });
      return send(res, 400, { code: err.code || "P0001", message: err.message });
    }
  }

  async function handleStorage(req, res, path, body, raw) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    const claims = m ? verifyJwt(m[1]) : null;
    if (!claims) return send(res, 400, { statusCode: "403", error: "Unauthorized", message: "invalid JWT" });
    const owns = (p) => p.split("/")[0] === claims.sub && p.split("/").length >= 2;

    if (req.method === "POST" && path.startsWith("/object/list/receipts")) {
      const prefix = String(body.prefix || "").replace(/\/+$/, "");
      const limit = Number(body.limit) || 100, offset = Number(body.offset) || 0;
      if (prefix !== claims.sub) return send(res, 200, []);
      const names = [...objects.keys()].filter((k) => k.startsWith(prefix + "/")).map((k) => k.slice(prefix.length + 1)).sort();
      return send(res, 200, names.slice(offset, offset + limit).map((name) => ({ name, id: name })));
    }
    if (req.method === "DELETE" && path === "/object/receipts") {
      const gone = [];
      for (const p of Array.isArray(body.prefixes) ? body.prefixes : []) {
        if (owns(String(p)) && objects.delete(String(p))) {
          gone.push({ name: String(p), bucket_id: "receipts" });
          await db.query("delete from storage.objects where bucket_id = 'receipts' and name = $1", [String(p)]);
        }
      }
      return send(res, 200, gone);
    }
    const obj = /^\/object\/receipts\/(.+)$/.exec(path);
    if (obj) {
      const p = decodeURIComponent(obj[1]);
      if (req.method === "POST") {
        if (failUpload) {
          failUpload = false;
          return send(res, 500, { statusCode: "500", error: "internal", message: "storage failure (simulated)" });
        }
        if (!owns(p)) return send(res, 400, { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" });
        if (objects.has(p)) return send(res, 400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
        objects.set(p, { bytes: raw, mime: req.headers["content-type"] || "application/octet-stream" });
        await db.query("insert into storage.objects (bucket_id, name, owner) values ('receipts', $1, $2)", [p, claims.sub]);
        return send(res, 200, { Key: `receipts/${p}` });
      }
      if (req.method === "GET") {
        const o = owns(p) && objects.get(p);
        if (!o) return send(res, 400, { statusCode: "404", error: "not_found", message: "Object not found" });
        return void res.writeHead(200, { "content-type": o.mime, "content-length": o.bytes.length }).end(o.bytes);
      }
    }
    return send(res, 404, { statusCode: "404", error: "not_found" });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (req.headers.apikey !== anonKey && req.headers.apikey !== serviceKey) {
        return send(res, 401, { message: "Invalid API key" });
      }
      const raw = await readBody(req);
      let body = {};
      if ((req.headers["content-type"] || "").includes("json") && raw.length) {
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          return send(res, 400, { message: "bad json" });
        }
      }
      if (url.pathname.startsWith("/auth/v1/")) return await handleAuth(req, res, url.pathname.slice(8), url, body);
      const rpc = /^\/rest\/v1\/rpc\/([^/]+)$/.exec(url.pathname);
      if (rpc && req.method === "POST") return await handleRpc(req, res, rpc[1], body);
      if (url.pathname.startsWith("/storage/v1/")) return await handleStorage(req, res, url.pathname.slice(11), body, raw);
      send(res, 404, { message: "not found" });
    } catch (err) {
      console.error("fake supabase:", err);
      send(res, 500, { message: String(err?.message || err) });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const api = {
    url: `http://127.0.0.1:${server.address().port}`,
    anonKey,
    serviceKey,
    siteUrl,
    mailbox,
    /** The next upload answers 500, as if Storage were down. */
    failNextUpload() {
      failUpload = true;
    },
    /** Puts a file straight into the bucket (for tests that need many files quickly). */
    seedObject(path, bytes, mime) {
      objects.set(path, { bytes: Buffer.from(bytes), mime });
    },
    hasObject: (path) => objects.has(path),
    objectCount: (prefix = "") => [...objects.keys()].filter((k) => k.startsWith(prefix)).length,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
  return api;
}
