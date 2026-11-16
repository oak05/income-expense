// Sessions: the Supabase access and refresh tokens live in two HttpOnly cookies that page scripts cannot read.
// withUser() refreshes them when needed and sends the renewed cookies back with whatever the handler answers.
import { errorResponse, HttpError, readCookie } from "./server.js";
import { AuthExpired, refresh } from "./supabase.js";

export const ACCESS_COOKIE = "sb_access";
export const REFRESH_COOKIE = "sb_refresh";
const MAX_AGE = 30 * 86400;
const REFRESH_EARLY_MS = 60_000;

const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

export function sessionCookies(session) {
  return [cookie(ACCESS_COOKIE, session.access_token, MAX_AGE), cookie(REFRESH_COOKIE, session.refresh_token, MAX_AGE)];
}

export function clearSessionCookies() {
  return [cookie(ACCESS_COOKIE, "", 0), cookie(REFRESH_COOKIE, "", 0)];
}

/** The claims of a JWT, read without checking the signature (Supabase checks it on every call). */
export function jwtPayload(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

export const hasSessionCookie = (request) => Boolean(readCookie(request, ACCESS_COOKIE) || readCookie(request, REFRESH_COOKIE));

const signedOut = () => errorResponse(new HttpError(401, "ยังไม่ได้เข้าสู่ระบบ"), { "set-cookie": clearSessionCookies() });

/**
 * Runs fn({token, id, email}) for the signed-in user.
 *  - refreshes first when the access token is missing or about to expire
 *  - if Supabase still refuses the token (AuthExpired), refreshes once and runs fn once more
 *  - renewed cookies are added to every answer, errors included, so the browser never keeps a used refresh token
 *  - when the session cannot be renewed: 401 and the cookies are cleared
 */
export async function withUser(request, fn) {
  let access = readCookie(request, ACCESS_COOKIE);
  let refreshToken = readCookie(request, REFRESH_COOKIE);
  let renewed = null;

  const renew = async () => {
    if (!refreshToken) throw new AuthExpired();
    renewed = await refresh(refreshToken);
    access = renewed.access_token;
    refreshToken = renewed.refresh_token;
  };
  const user = () => {
    const claims = jwtPayload(access) || {};
    return { token: access, id: claims.sub, email: claims.email };
  };

  let response;
  try {
    const claims = jwtPayload(access);
    if (!claims || !claims.sub || !(claims.exp * 1000 - Date.now() > REFRESH_EARLY_MS)) await renew();
    try {
      response = await fn(user());
    } catch (err) {
      if (!(err instanceof AuthExpired)) throw err;
      await renew();
      response = await fn(user());
    }
  } catch (err) {
    if (err instanceof AuthExpired) return signedOut();
    response = errorResponse(err);
  }
  // a handler that sets the session cookies itself (e.g. clears them after deleting the account) has the last word
  const handlerSetsSession = response.headers.getSetCookie().some((c) => c.startsWith(ACCESS_COOKIE + "="));
  if (renewed && !handlerSetsSession) for (const c of sessionCookies(renewed)) response.headers.append("set-cookie", c);
  return response;
}
