// POST /api/login {password} -> sets the session cookie
import {
  SESSION_DAYS, callBackend, clientKey, config, createSession, handler, HttpError, json,
  passwordMatches, readJson, requireSameOrigin, sessionCookie,
} from "../lib/server.js";

export const POST = handler(async (request) => {
  requireSameOrigin(request);
  const cfg = config();
  const body = await readJson(request, 2000);
  const ok = passwordMatches(body.password, cfg);
  // the backend counts failures per caller address and blocks for 15 minutes after 8 of them
  const { blocked } = await callBackend("auth.attempt", { key: clientKey(request), ok }, cfg);
  if (blocked) throw new HttpError(429, "ใส่รหัสผ่านผิดหลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่");
  if (!ok) throw new HttpError(401, "รหัสผ่านไม่ถูกต้อง");
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(createSession(cfg), SESSION_DAYS * 86400) });
});
