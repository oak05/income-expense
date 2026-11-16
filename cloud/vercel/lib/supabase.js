// Supabase over plain fetch: Auth (/auth/v1), database functions (/rest/v1/rpc) and Storage (/storage/v1).
// Data calls carry the signed-in user's access token, so the database's row-level security applies to them.
// The service key is used for one thing only: the sign-in throttle (auth_throttle).
import { config, HttpError } from "./server.js";

const TIMEOUT_MS = 10_000;
const BUCKET = "receipts";
const LIST_PAGE = 100;

/** The access token was refused or the refresh token can no longer be used: the user has to sign in again. */
export class AuthExpired extends Error {}

const UNREACHABLE = "ติดต่อ Supabase ไม่ได้ ลองใหม่อีกครั้ง";
const BAD_ANON_KEY = "Supabase ไม่ยอมรับ SUPABASE_ANON_KEY — ตรวจค่าใน Vercel แล้ว deploy ใหม่";

async function request(cfg, path, { method = "POST", body, raw, contentType, token, key } = {}) {
  const headers = { apikey: key || cfg.anonKey };
  if (token) headers.authorization = `Bearer ${token}`;
  if (raw !== undefined) headers["content-type"] = contentType;
  else if (body !== undefined) headers["content-type"] = "application/json";
  try {
    return await fetch(cfg.supabaseUrl + path, {
      method,
      headers,
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error("supabase unreachable:", path.split("?")[0], err?.name, err?.message);
    throw new HttpError(504, UNREACHABLE);
  }
}

async function bodyOf(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { message: text.slice(0, 200) };
  }
}

const invalidApiKey = (status, body) => status === 401 && /invalid api key/i.test(String(body?.message || body?.msg || ""));

/* ---------------------------------------------------------------- Auth */

/** Supabase Auth error -> HttpError with the Thai message the page shows. */
export function authError(body, status) {
  const code = body?.error_code || (/invalid login credentials/i.test(body?.error_description || body?.msg || "") ? "invalid_credentials"
    : /email not confirmed/i.test(body?.error_description || body?.msg || "") ? "email_not_confirmed" : "");
  if (invalidApiKey(status, body)) return new HttpError(502, BAD_ANON_KEY);
  switch (code) {
    case "invalid_credentials":
      return new HttpError(401, "อีเมลหรือรหัสผ่านไม่ถูกต้อง");
    case "email_not_confirmed":
      return new HttpError(403, "ยังไม่ได้ยืนยันอีเมล — เปิดลิงก์ในอีเมลที่เราส่งให้ หรือกดส่งอีกครั้ง", "email_not_confirmed");
    case "weak_password":
      return new HttpError(422, "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร");
    case "email_address_invalid":
    case "validation_failed":
      return new HttpError(422, "อีเมลไม่ถูกต้อง");
    case "otp_expired":
    case "flow_state_expired":
    case "flow_state_not_found":
      return new HttpError(410, "ลิงก์นี้ใช้แล้วหรือหมดอายุ — ขอลิงก์ใหม่", "link_expired");
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return new HttpError(429, "ส่งอีเมลบ่อยเกินไป รอสักครู่แล้วลองใหม่");
    default:
      if (status === 429) return new HttpError(429, "ส่งอีเมลบ่อยเกินไป รอสักครู่แล้วลองใหม่");
      console.error("supabase auth error:", status, JSON.stringify(body).slice(0, 300));
      return new HttpError(502, "ระบบบัญชีผู้ใช้ (Supabase) ทำงานไม่สำเร็จ");
  }
}

function toSession(body) {
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: body.expires_at,
    user: { id: body.user?.id, email: body.user?.email },
  };
}

async function authCall(path, opts, cfg) {
  const res = await request(cfg, "/auth/v1" + path, opts);
  const body = await bodyOf(res);
  if (!res.ok) throw authError(body, res.status);
  return body;
}

export async function signIn(email, password, cfg = config()) {
  return toSession(await authCall("/token?grant_type=password", { body: { email, password } }, cfg));
}

export async function refresh(refreshToken, cfg = config()) {
  const res = await request(cfg, "/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: refreshToken } });
  const body = await bodyOf(res);
  if (res.ok) return toSession(body);
  if (invalidApiKey(res.status, body)) throw new HttpError(502, BAD_ANON_KEY);
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new AuthExpired();
  throw authError(body, res.status);
}

/** Ends the session on Supabase (revokes its refresh tokens). Best effort: signing out locally always works. */
export async function signOut(accessToken, cfg = config()) {
  try {
    await request(cfg, "/auth/v1/logout", { token: accessToken });
  } catch { /* the cookies are cleared anyway */ }
}

/** The user behind an access token, or null when Supabase no longer accepts it. */
export async function getUser(accessToken, cfg = config()) {
  const res = await request(cfg, "/auth/v1/user", { method: "GET", token: accessToken });
  const body = await bodyOf(res);
  if (res.ok) return { id: body.id, email: body.email };
  if (invalidApiKey(res.status, body)) throw new HttpError(502, BAD_ANON_KEY);
  if (res.status === 401 || res.status === 403 || res.status === 404) return null;
  throw authError(body, res.status);
}

export async function updatePassword(accessToken, password, cfg = config()) {
  const res = await request(cfg, "/auth/v1/user", { method: "PUT", token: accessToken, body: { password } });
  const body = await bodyOf(res);
  if (res.ok) return true;
  if (res.status === 401) throw new AuthExpired();
  throw authError(body, res.status);
}

export async function signUp(email, password, cfg = config()) {
  await authCall("/signup", { body: { email, password } }, cfg);
}

export async function recover(email, cfg = config()) {
  await authCall("/recover", { body: { email } }, cfg);
}

export async function resend(email, cfg = config()) {
  await authCall("/resend", { body: { type: "signup", email } }, cfg);
}

/** Uses a one-time link from an email (sign-up confirmation or password reset) and returns the new session. */
export async function verify(type, tokenHash, cfg = config()) {
  return toSession(await authCall("/verify", { body: { type, token_hash: tokenHash } }, cfg));
}

/* ---------------------------------------------------------------- database functions */

/** Calls public.<fn>(p => params) as the signed-in user and returns its JSON. */
export async function rpc(fn, params, accessToken, cfg = config()) {
  const res = await request(cfg, `/rest/v1/rpc/${fn}`, { body: { p: params }, token: accessToken });
  const body = await bodyOf(res);
  if (res.ok) return body;
  if (invalidApiKey(res.status, body)) throw new HttpError(502, BAD_ANON_KEY);
  if (res.status === 401) throw new AuthExpired();
  if (/^PT\d{3}$/.test(body?.code || "")) throw new HttpError(res.status, String(body.message));
  console.error("supabase rpc error:", fn, res.status, JSON.stringify(body).slice(0, 300));
  if (body?.code === "PGRST202") {
    throw new HttpError(502, "ฐานข้อมูลยังไม่ได้ตั้งค่า — รันไฟล์ใน cloud/supabase/migrations ใน Supabase ให้ครบ");
  }
  throw new HttpError(500, "เกิดข้อผิดพลาดที่ฐานข้อมูล (Supabase)");
}

/** Calls public.<fn>(args) with the service key. Only used for auth_throttle. */
export async function serviceRpc(fn, args, cfg = config()) {
  // new-style secret keys (sb_secret_...) go in apikey only; legacy JWT keys also as the bearer token
  const res = await request(cfg, `/rest/v1/rpc/${fn}`, {
    body: args, key: cfg.serviceKey, token: cfg.serviceKey.startsWith("eyJ") ? cfg.serviceKey : undefined,
  });
  const body = await bodyOf(res);
  if (res.ok) return body;
  console.error("supabase service rpc error:", fn, res.status, JSON.stringify(body).slice(0, 300));
  throw new HttpError(502, "ตรวจสิทธิ์เข้าสู่ระบบไม่สำเร็จ — ตรวจ SUPABASE_SERVICE_ROLE_KEY และ migration ใน Supabase");
}

/* ---------------------------------------------------------------- Storage (bucket "receipts") */

const objectPath = (path) => `/storage/v1/object/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;

export async function storageUpload(accessToken, path, bytes, mime, cfg = config()) {
  const res = await request(cfg, objectPath(path), { raw: bytes, contentType: mime, token: accessToken });
  if (res.ok) return;
  console.error("storage upload failed:", res.status, (await res.text()).slice(0, 300));
  throw new HttpError(502, "เก็บไฟล์ใบเสร็จไม่สำเร็จ ลองใหม่อีกครั้ง");
}

/** @returns {Promise<{bytes: Buffer, mime: string} | null>} null when the file is not there (or not the user's) */
export async function storageDownload(accessToken, path, cfg = config()) {
  const res = await request(cfg, objectPath(path), { method: "GET", token: accessToken });
  if (!res.ok) {
    console.warn("storage download failed:", res.status, (await res.text()).slice(0, 200));
    return null;
  }
  return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") || "" };
}

export async function storageRemove(accessToken, paths, cfg = config()) {
  for (let i = 0; i < paths.length; i += LIST_PAGE) {
    const res = await request(cfg, `/storage/v1/object/${BUCKET}`, {
      method: "DELETE", token: accessToken, body: { prefixes: paths.slice(i, i + LIST_PAGE) },
    });
    if (!res.ok) {
      console.error("storage delete failed:", res.status, (await res.text()).slice(0, 300));
      throw new HttpError(502, "ลบไฟล์ใบเสร็จไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
  }
}

/** Every file path under "<prefix>/", all pages. */
export async function storageList(accessToken, prefix, cfg = config()) {
  const out = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const res = await request(cfg, `/storage/v1/object/list/${BUCKET}`, {
      token: accessToken, body: { prefix, limit: LIST_PAGE, offset, sortBy: { column: "name", order: "asc" } },
    });
    const body = await bodyOf(res);
    if (!res.ok || !Array.isArray(body)) {
      console.error("storage list failed:", res.status, JSON.stringify(body).slice(0, 300));
      throw new HttpError(502, "อ่านรายการไฟล์ใบเสร็จไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
    out.push(...body.map((o) => `${prefix}/${o.name}`));
    if (body.length < LIST_PAGE) return out;
  }
}
