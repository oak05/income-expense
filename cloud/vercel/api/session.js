// GET /api/session -> {authenticated, email}; lets the login page skip itself when already signed in
import { handler, json } from "../lib/server.js";
import { AuthExpired, getUser } from "../lib/supabase.js";
import { clearSessionCookies, hasSessionCookie, withUser } from "../lib/session.js";

export const GET = handler(async (request) => {
  if (!hasSessionCookie(request)) return json({ authenticated: false });
  const res = await withUser(request, async (user) => {
    const u = await getUser(user.token);
    if (!u) throw new AuthExpired(); // e.g. the account was deleted
    return json({ authenticated: true, email: u.email });
  });
  if (res.status === 401) return json({ authenticated: false }, 200, { "set-cookie": clearSessionCookies() });
  return res;
});
