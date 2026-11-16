// Limits on requests that send email (sign-up, password reset, resend confirmation): 5 per hour per caller address.
// Supabase sees every request coming from Vercel, so its own per-address limits can't tell users apart.
import { clientKey, HttpError } from "./server.js";
import { serviceRpc } from "./supabase.js";

/** Counts one request of `kind` from this caller; throws 429 once the hour's allowance is used up. */
export async function limitEmailRequests(request, kind, cfg) {
  const { blocked } = await serviceRpc("auth_throttle", { p_kind: kind, p_key: clientKey(request), p_outcome: "hit" }, cfg);
  if (blocked) throw new HttpError(429, "ขอบ่อยเกินไป รอ 1 ชั่วโมงแล้วลองใหม่");
}

export function readEmail(body) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || email.length > 254) throw new HttpError(422, "อีเมลไม่ถูกต้อง");
  return email;
}

export function readNewPassword(body) {
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8) throw new HttpError(422, "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร");
  if (password.length > 72) throw new HttpError(422, "รหัสผ่านยาวเกินไป (ไม่เกิน 72 ตัวอักษร)");
  return password;
}
