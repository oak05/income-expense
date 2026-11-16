// POST /api/rpc {action, params} -> forwards to the Apps Script backend for a signed-in user
import { callBackend, handler, HttpError, json, readJson, requireSameOrigin, requireSession } from "../lib/server.js";

// What the web pages may ask for. "auth.*" is for the login function only and is not listed here.
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
  requireSession(request);
  const body = await readJson(request, MAX_BODY);
  if (typeof body.action !== "string" || !ALLOWED.has(body.action)) throw new HttpError(404, "ไม่รู้จักคำสั่งนี้");
  const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {};
  return json(await callBackend(body.action, params));
});
