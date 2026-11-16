// POST /api/logout -> ends this browser's session on Supabase and clears the cookies (other devices stay signed in)
import { handler, json, readCookie, requireSameOrigin } from "../lib/server.js";
import { refresh, signOut } from "../lib/supabase.js";
import { ACCESS_COOKIE, clearSessionCookies, jwtPayload, REFRESH_COOKIE } from "../lib/session.js";

export const POST = handler(async (request) => {
  requireSameOrigin(request);
  let access = readCookie(request, ACCESS_COOKIE);
  const refreshToken = readCookie(request, REFRESH_COOKIE);
  const claims = jwtPayload(access);
  if ((!claims || claims.exp * 1000 <= Date.now()) && refreshToken) {
    // after an idle hour the access token has expired; get a fresh one so Supabase can revoke the session
    try {
      access = (await refresh(refreshToken)).access_token;
    } catch {
      access = null; // already unusable: nothing to revoke
    }
  }
  if (access) await signOut(access);
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookies() });
});
