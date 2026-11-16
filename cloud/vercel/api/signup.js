// POST /api/signup {email, password} -> Supabase sends a confirmation email. The answer is the same whether or
// not the email already has an account, so this page can't be used to find out who is registered.
import { config, handler, json, readJson, requireSameOrigin } from "../lib/server.js";
import { signUp } from "../lib/supabase.js";
import { limitEmailRequests, readEmail, readNewPassword } from "../lib/throttle.js";

export const POST = handler(async (request) => {
  requireSameOrigin(request);
  const cfg = config();
  const body = await readJson(request, 2000);
  const email = readEmail(body);
  const password = readNewPassword(body);
  await limitEmailRequests(request, "signup", cfg);
  await signUp(email, password, cfg);
  return json({ ok: true });
});
