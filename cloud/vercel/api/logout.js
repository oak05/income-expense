// POST /api/logout -> ends the session on Supabase and clears the cookies
import { handler, json, readCookie, requireSameOrigin } from "../lib/server.js";
import { signOut } from "../lib/supabase.js";
import { ACCESS_COOKIE, clearSessionCookies } from "../lib/session.js";

export const POST = handler(async (request) => {
  requireSameOrigin(request);
  const access = readCookie(request, ACCESS_COOKIE);
  if (access) await signOut(access);
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookies() });
});
