"use strict";
/* Login page: email + password -> session cookies, then back to where the user was heading. */

function nextPage() {
  const next = new URLSearchParams(location.search).get("next") || "/";
  // only paths on this site: "/receipts.html" is fine, "//evil.example" or "https://..." is not
  return /^\/(?![/\\])/.test(next) && !next.startsWith("/login") ? next : "/";
}

const notices = { deleted: "ลบบัญชีและข้อมูลทั้งหมดแล้ว", password: "เปลี่ยนรหัสผ่านแล้ว เข้าสู่ระบบด้วยรหัสผ่านใหม่" };
const notice = Object.keys(notices).find((k) => new URLSearchParams(location.search).has(k));
if (notice) {
  $("#login-notice").textContent = notices[notice];
  $("#login-notice").hidden = false;
}

function showError(message) {
  $("#login-error").textContent = message;
  $("#login-error").hidden = false;
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#login-btn");
  $("#login-error").hidden = true;
  $("#resend-btn").hidden = true;
  btn.disabled = true;
  btn.textContent = "กำลังตรวจสอบ…";
  try {
    await apiPost("/api/login", { email: $("#email").value, password: $("#password").value });
    location.replace(nextPage());
  } catch (err) {
    showError(err.message);
    $("#resend-btn").hidden = err.code !== "email_not_confirmed";
    btn.disabled = false;
    btn.textContent = "เข้าสู่ระบบ";
    $("#password").select();
  }
});

$("#resend-btn").addEventListener("click", async () => {
  const btn = $("#resend-btn");
  btn.disabled = true;
  try {
    await apiPost("/api/resend", { email: $("#email").value });
    btn.hidden = true;
    $("#login-error").hidden = true;
    $("#login-notice").textContent = "ส่งอีเมลยืนยันอีกครั้งแล้ว — เปิดลิงก์ในอีเมลก่อนเข้าสู่ระบบ";
    $("#login-notice").hidden = false;
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
});

// already signed in? skip this page
fetch("/api/session", { credentials: "same-origin" })
  .then((r) => (r.ok ? r.json() : null))
  .then((s) => { if (s && s.authenticated) location.replace(nextPage()); })
  .catch(() => {});
