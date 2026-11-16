// POST /api/signup {email, password}
//  - Supabase "Confirm email" on: Supabase sends a confirmation email -> {ok: true}. The answer is the same whether or
//    not the email already has an account, so this page can't be used to find out who is registered.
//  - "Confirm email" off: the account is ready at once -> signed in, {ok: true, next: "/"}.
import { config, handler, json, readJson, requireSameOrigin } from "../lib/server.js";
import { sessionCookies } from "../lib/session.js";
import { signUp } from "../lib/supabase.js";
import { limitEmailRequests, readEmail, readNewPassword } from "../lib/throttle.js";

export const POST = handler(async (request) => {
  requireSameOrigin(request);
  const cfg = config();
  const body = await readJson(request, 2000);
  const email = readEmail(body);
  const password = readNewPassword(body);
  await limitEmailRequests(request, "signup", cfg);
  const session = await signUp(email, password, cfg);
  if (session) return json({ ok: true, next: "/" }, 200, { "set-cookie": sessionCookies(session) });
  return json({ ok: true });
});
