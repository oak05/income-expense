// POST /api/account {action: "delete", email} -> deletes the signed-in account: every receipt file in Storage,
// then the account itself (its rows go with it). The user types their email to confirm.
import { handler, HttpError, json, readJson, requireSameOrigin } from "../lib/server.js";
import { rpc, signOut, storageList, storageRemove } from "../lib/supabase.js";
import { clearSessionCookies, hasSessionCookie, withUser } from "../lib/session.js";

export const POST = handler(async (request) => {
  requireSameOrigin(request);
  if (!hasSessionCookie(request)) throw new HttpError(401, "ยังไม่ได้เข้าสู่ระบบ");
  const body = await readJson(request, 2000);
  if (body.action !== "delete") throw new HttpError(400, "ไม่รู้จักคำสั่งนี้");
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  return withUser(request, async (user) => {
    if (!email || email !== String(user.email || "").toLowerCase()) throw new HttpError(400, "อีเมลไม่ตรงกับบัญชีนี้");
    const files = await storageList(user.token, user.id);
    if (files.length) await storageRemove(user.token, files);
    await rpc("api_delete_account", { email }, user.token);
    await signOut(user.token);
    const res = json({ ok: true }, 200, { "set-cookie": clearSessionCookies() });
    return res;
  });
});
