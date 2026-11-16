// POST /api/rpc {action, params} -> runs the matching database function as the signed-in user
import { handler, HttpError, json, readJson, requireSameOrigin, VERSION } from "../lib/server.js";
import { rpc, storageRemove } from "../lib/supabase.js";
import { hasSessionCookie, withUser } from "../lib/session.js";
import { uploadReceipt } from "../lib/receipts.js";

// What the web pages may ask for; each becomes public.api_<action with "." -> "_"> in the database.
const ALLOWED = new Set([
  "info",
  "categories.list", "categories.create", "categories.update", "categories.delete",
  "month.get", "yearly.get",
  "transactions.list", "transactions.create", "transactions.update", "transactions.delete", "transactions.import",
  "receipts.list", "receipts.upload", "receipts.update", "receipts.delete", "receipts.commit",
]);
const MAX_BODY = 4 * 1024 * 1024; // Vercel refuses bodies over 4.5 MB before they reach this code

export const POST = handler(async (request) => {
  requireSameOrigin(request);
  if (!hasSessionCookie(request)) throw new HttpError(401, "ยังไม่ได้เข้าสู่ระบบ");
  const body = await readJson(request, MAX_BODY);
  if (typeof body.action !== "string" || !ALLOWED.has(body.action)) throw new HttpError(404, "ไม่รู้จักคำสั่งนี้");
  const action = body.action;
  const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {};

  return withUser(request, async (user) => {
    if (action === "info") return json({ version: VERSION, email: user.email });
    if (action === "receipts.upload") return json(await uploadReceipt(user, params));
    const data = await rpc("api_" + action.replace(".", "_"), params, user.token);
    if (data && Array.isArray(data.removed_files)) { // transactions.delete / receipts.delete: the files go too
      const files = data.removed_files;
      delete data.removed_files;
      if (files.length) {
        try {
          await storageRemove(user.token, files);
        } catch (err) {
          console.error("could not remove receipt files:", files.join(", "), err?.message);
        }
      }
    }
    return json(data);
  });
});
