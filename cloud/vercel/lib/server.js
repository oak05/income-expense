// Shared code for the Vercel Functions in /api: settings, errors, JSON responses and request checks.
import { createHash } from "node:crypto";

export const VERSION = "3.0.0";

/** Settings come from Vercel environment variables. Missing ones are reported clearly instead of half-working. */
export function config() {
  const env = process.env;
  const names = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "APPS_SCRIPT_URL", "APPS_SCRIPT_SECRET"];
  const missing = names.filter((k) => !env[k]);
  if (missing.length) {
    throw new HttpError(500, `ยังตั้งค่าไม่ครบ: เพิ่ม ${missing.join(", ")} ใน Environment Variables ของ Vercel แล้ว deploy ใหม่`);
  }
  return {
    supabaseUrl: env.SUPABASE_URL.replace(/\/+$/, ""),
    anonKey: env.SUPABASE_ANON_KEY,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    ocrUrl: env.APPS_SCRIPT_URL,
    ocrSecret: env.APPS_SCRIPT_SECRET,
  };
}

export class HttpError extends Error {
  /** @param {string} [code] a machine-readable reason the page can act on, e.g. "email_not_confirmed" */
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A JSON response. `headers` values may be arrays (several set-cookie headers). */
export function json(data, status = 200, headers = {}) {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  for (const [k, v] of Object.entries(headers)) for (const one of [].concat(v)) h.append(k, one);
  return new Response(JSON.stringify(data), { status, headers: h });
}

export function errorResponse(err, headers = {}) {
  if (err instanceof HttpError) return json({ detail: err.message, ...(err.code ? { code: err.code } : {}) }, err.status, headers);
  console.error(err);
  return json({ detail: "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์" }, 500, headers);
}

/** Wraps a handler so every failure becomes a JSON error the page can show. */
export function handler(fn) {
  return async (request) => {
    try {
      return await fn(request);
    } catch (err) {
      return errorResponse(err);
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
  return sha256(ip).slice(0, 32);
}

export function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export const sha256 = (text) => createHash("sha256").update(String(text)).digest("hex");
