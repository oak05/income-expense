// POST /api/logout -> clears the session cookie
import { handler, json, requireSameOrigin, sessionCookie } from "../lib/server.js";

export const POST = handler(async (request) => {
  requireSameOrigin(request);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
});
