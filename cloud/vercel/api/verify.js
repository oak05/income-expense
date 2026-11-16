// POST /api/verify {token_hash, type} -> uses the one-time link from an email and signs the user in.
// confirm.html calls this when the user presses its button, never on page load: mail scanners that open every
// link would otherwise use the token up, and cookies set during the cross-site arrival from a mail app would not
// be sent on the next page (SameSite=Strict).
import { config, handler, HttpError, json, readJson, requireSameOrigin } from "../lib/server.js";
import { verify } from "../lib/supabase.js";
import { sessionCookies } from "../lib/session.js";

const NEXT = { email: "/", recovery: "/password.html?reset=1" };

export const POST = handler(async (request) => {
  requireSameOrigin(request);
  const cfg = config();
  const body = await readJson(request, 2000);
  const type = typeof body.type === "string" ? body.type : "";
  const tokenHash = typeof body.token_hash === "string" ? body.token_hash : "";
  if (!NEXT[type] || !/^[A-Za-z0-9_-]{6,200}$/.test(tokenHash)) {
    throw new HttpError(410, "ลิงก์นี้ใช้แล้วหรือหมดอายุ — ขอลิงก์ใหม่", "link_expired");
  }
  const session = await verify(type, tokenHash, cfg);
  // the page shows whose account this is before going on, so a link someone else sent can't quietly sign you
  // into their account
  return json({ ok: true, next: NEXT[type], email: session.user.email }, 200, { "set-cookie": sessionCookies(session) });
});
