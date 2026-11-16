"use strict";
/* Login page: POST the password, get a session cookie, go back to where the user was heading. */

function nextPage() {
  const next = new URLSearchParams(location.search).get("next") || "/";
  // only paths on this site: "/receipts.html" is fine, "//evil.example" or "https://..." is not
  return /^\/(?![/\\])/.test(next) && !next.startsWith("/login") ? next : "/";
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#login-btn"), error = $("#login-error");
  error.hidden = true;
  btn.disabled = true;
  btn.textContent = "กำลังตรวจสอบ…";
  try {
    await apiPost("/api/login", { password: $("#password").value });
    location.replace(nextPage());
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    btn.disabled = false;
    btn.textContent = "เข้าสู่ระบบ";
    $("#password").select();
  }
});

// already signed in? skip this page
fetch("/api/session", { credentials: "same-origin" })
  .then((r) => (r.ok ? r.json() : null))
  .then((s) => { if (s && s.authenticated) location.replace(nextPage()); })
  .catch(() => {});
