// POST /api/resend {email} -> sends the sign-up confirmation email again (only for unconfirmed accounts).
import { config, handler, json, readJson, requireSameOrigin } from "../lib/server.js";
import { resend } from "../lib/supabase.js";
import { limitEmailRequests, readEmail } from "../lib/throttle.js";

export const POST = handler(async (request) => {
  requireSameOrigin(request);
  const cfg = config();
  const email = readEmail(await readJson(request, 2000));
  await limitEmailRequests(request, "resend", cfg);
  await resend(email, cfg);
  return json({ ok: true });
});
