// Shared code for the Vercel Functions in /api: sessions, request checks and the call to Apps Script.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "session";
export const SESSION_DAYS = 30;
const BACKEND_TIMEOUT_MS = 55_000;

/** Settings come from Vercel environment variables. Missing ones are reported clearly instead of half-working. */
export function config() {
  const env = process.env;
  const missing = ["APP_PASSWORD", "SESSION_SECRET", "APPS_SCRIPT_URL", "APPS_SCRIPT_SECRET"].filter((k) => !env[k]);
  if (missing.length) {
    throw new HttpError(500, `ยังตั้งค่าไม่ครบ: เพิ่ม ${missing.join(", ")} ใน Environment Variables ของ Vercel แล้ว deploy ใหม่`);
  }
  if (env.SESSION_SECRET.length < 32) throw new HttpError(500, "SESSION_SECRET ต้องยาวอย่างน้อย 32 ตัวอักษร");
  if (env.APP_PASSWORD.length < 8) throw new HttpError(500, "APP_PASSWORD ต้องยาวอย่างน้อย 8 ตัวอักษร");
  return {
    password: env.APP_PASSWORD,
    sessionSecret: env.SESSION_SECRET,
    backendUrl: env.APPS_SCRIPT_URL,
    backendSecret: env.APPS_SCRIPT_SECRET,
  };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** Wraps a handler so every failure becomes a JSON error the page can show. */
export function handler(fn) {
  return async (request) => {
    try {
      return await fn(request);
    } catch (err) {
      if (err instanceof HttpError) return json({ detail: err.message }, err.status);
      console.error(err);
      return json({ detail: "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์" }, 500);
    }
  };
}

/* ---------------------------------------------------------------- request checks */

function requestHost(request) {
  return (request.headers.get("x-forwarded-host") || request.headers.get("host") || new URL(request.url).host).toLowerCase();
}

/**
 * Requests that change something must come from this app's own pages:
 *  - the custom header can't be added by another website without a CORS preflight, which this app never grants
 *  - Origin / Sec-Fetch-Site, when the browser sends them, must say "same origin"
 */
export function requireSameOrigin(request) {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  let originHost = null;
  if (origin !== null) {
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      originHost = "";
    }
  }
  if (
    !request.headers.get("x-requested-with")
    || (site !== null && site !== "same-origin" && site !== "none")
    || (origin !== null && originHost !== requestHost(request))
  ) {
    throw new HttpError(403, "คำขอถูกปฏิเสธ: ต้องส่งจากหน้าเว็บของแอปเท่านั้น");
  }
}

export async function readJson(request, maxBytes) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new HttpError(413, "ข้อมูลที่ส่งมาใหญ่เกินไป");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "ข้อมูลที่ส่งมาใหญ่เกินไป");
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch { /* fall through */ }
  throw new HttpError(400, "รูปแบบข้อมูลไม่ถูกต้อง");
}

export function clientKey(request) {
  // Vercel sets x-forwarded-for itself; the first entry is the caller's address
  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

/* ---------------------------------------------------------------- sessions */

function sign(secret, text) {
  return createHmac("sha256", secret).update(text).digest("base64url");
}

function safeEqual(a, b) {
  const x = createHash("sha256").update(String(a)).digest();
  const y = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(x, y);
}

export function passwordMatches(given, cfg = config()) {
  return typeof given === "string" && given.length > 0 && safeEqual(given, cfg.password);
}

/** Cookie value: "<expiry in seconds>.<HMAC of it>". Changing APP_PASSWORD or SESSION_SECRET signs everyone out. */
export function createSession(cfg = config(), now = Date.now()) {
  const expires = Math.floor(now / 1000) + SESSION_DAYS * 86400;
  return `${expires}.${sign(cfg.sessionSecret + "\n" + cfg.password, "session." + expires)}`;
}

export function sessionValid(token, cfg = config(), now = Date.now()) {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{20,100})$/.exec(String(token || ""));
  if (!m) return false;
  if (Number(m[1]) * 1000 <= now) return false;
  return safeEqual(m[2], sign(cfg.sessionSecret + "\n" + cfg.password, "session." + m[1]));
}

export function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(value, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function requireSession(request) {
  if (!sessionValid(readCookie(request, SESSION_COOKIE))) throw new HttpError(401, "ยังไม่ได้เข้าสู่ระบบ");
}

/* ---------------------------------------------------------------- Apps Script backend */

/** POSTs {secret, action, params} to the Apps Script web app and returns its data, or throws HttpError. */
export async function callBackend(action, params = {}, cfg = config()) {
  let res;
  try {
    res = await fetch(cfg.backendUrl, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ secret: cfg.backendSecret, action, params }),
      redirect: "follow", // Apps Script answers with a redirect to the real response
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
  } catch (err) {
    console.error("backend unreachable:", err?.name, err?.message);
    throw new HttpError(504, "ติดต่อหลังบ้าน (Apps Script) ไม่ได้หรือใช้เวลานานเกินไป ลองใหม่อีกครั้ง");
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // Apps Script answers with an HTML page when the URL is wrong, the deployment is not public, or the script crashed
    console.error("backend returned non-JSON:", res.status, text.slice(0, 300));
    throw new HttpError(502, "หลังบ้าน (Apps Script) ตอบกลับผิดรูปแบบ — ตรวจ APPS_SCRIPT_URL และการ deploy แบบ Web app (Anyone)");
  }
  if (body && body.ok === true) return body.data;
  if (body && body.status === 401) {
    throw new HttpError(502, "หลังบ้านไม่ยอมรับรหัสลับ — ตรวจว่า APPS_SCRIPT_SECRET ใน Vercel ตรงกับที่ setup() แสดง");
  }
  const status = Number(body?.status);
  throw new HttpError(status >= 400 && status <= 599 ? status : 502, String(body?.error || "หลังบ้านทำงานไม่สำเร็จ"));
}
