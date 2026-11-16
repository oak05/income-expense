// POST /api/recover {email} -> Supabase emails a password-reset link if the account exists. Always {ok: true}.
import { config, handler, json, readJson, requireSameOrigin } from "../lib/server.js";
import { recover } from "../lib/supabase.js";
import { limitEmailRequests, readEmail } from "../lib/throttle.js";

export const POST = handler(async (request) => {
  requireSameOrigin(request);
  const cfg = config();
  const email = readEmail(await readJson(request, 2000));
  await limitEmailRequests(request, "recover", cfg);
  await recover(email, cfg);
  return json({ ok: true });
});
