// POST /api/login {email, password} -> signs in with Supabase Auth and sets the session cookies
//
// Every sign-in reaches Supabase from Vercel's servers, so Supabase's own per-address limit would count all users
// together. Failures are therefore counted here per caller address + email (8 wrong passwords = wait 15 minutes),
// in the database through auth_throttle with the service key.
// (Checked 2026-11: Supabase Auth can take the real address from an "Sb-Forwarded-For" header, but only on
// requests made with a secret API key and after a project security setting is switched on; sign-in here uses the
// publishable/anon key, so this app keeps its own throttle. See supabase.com/docs/guides/auth/rate-limits.)
import { clientKey, config, handler, HttpError, json, readJson, requireSameOrigin, sha256 } from "../lib/server.js";
import { serviceRpc, signIn } from "../lib/supabase.js";
import { sessionCookies } from "../lib/session.js";

export const POST = handler(async (request) => {
  requireSameOrigin(request);
  const cfg = config();
  const body = await readJson(request, 2000);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) throw new HttpError(401, "อีเมลหรือรหัสผ่านไม่ถูกต้อง");

  const throttle = (outcome) => serviceRpc("auth_throttle", { p_kind: "login", p_key: sha256(clientKey(request) + "\n" + email), p_outcome: outcome }, cfg);
  if ((await throttle("check")).blocked) throw new HttpError(429, "ใส่รหัสผ่านผิดหลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่");
  let session;
  try {
    session = await signIn(email, password, cfg);
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) await throttle("fail");
    throw err;
  }
  await throttle("ok");
  return json({ ok: true }, 200, { "set-cookie": sessionCookies(session) });
});
