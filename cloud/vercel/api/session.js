// GET /api/session -> {authenticated}; lets the login page skip itself when already signed in
import { SESSION_COOKIE, handler, json, readCookie, sessionValid } from "../lib/server.js";

export const GET = handler(async (request) => json({ authenticated: sessionValid(readCookie(request, SESSION_COOKIE)) }));
