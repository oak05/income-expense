// POST /api/password {password} -> sets a new password for the signed-in user (after a reset link, or from the menu)
import { handler, HttpError, json, readJson, requireSameOrigin } from "../lib/server.js";
import { updatePassword } from "../lib/supabase.js";
import { hasSessionCookie, withUser } from "../lib/session.js";
import { readNewPassword } from "../lib/throttle.js";

export const POST = handler(async (request) => {
  requireSameOrigin(request);
  if (!hasSessionCookie(request)) throw new HttpError(401, "ยังไม่ได้เข้าสู่ระบบ");
  const password = readNewPassword(await readJson(request, 2000));
  return withUser(request, async (user) => {
    await updatePassword(user.token, password);
    return json({ ok: true });
  });
});
