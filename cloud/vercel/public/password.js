"use strict";
/* Set a new password: after a reset link (?reset=1) or from the account menu. Needs a signed-in session. */

const isReset = new URLSearchParams(location.search).has("reset");
if (isReset) {
  $("#password-title").textContent = "ตั้งรหัสผ่านใหม่";
  $("#password-sub").textContent = "ตั้งรหัสผ่านใหม่อย่างน้อย 8 ตัวอักษร แล้วใช้รหัสนี้เข้าสู่ระบบครั้งต่อไป";
}

fetch("/api/session", { credentials: "same-origin" })
  .then((r) => (r.ok ? r.json() : null))
  .then((s) => {
    if (!s || !s.authenticated) return goToLogin();
    $("#account-email").value = s.email || ""; // lets password managers save the new password for this account
  })
  .catch(() => {});

$("#password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#submit-btn"), error = $("#form-error");
  error.hidden = true;
  if ($("#password").value !== $("#password2").value) {
    error.textContent = "รหัสผ่านสองช่องไม่ตรงกัน";
    error.hidden = false;
    return;
  }
  btn.disabled = true;
  try {
    await apiPost("/api/password", { password: $("#password").value });
    location.replace("/");
  } catch (err) {
    if (err.status === 401) return goToLogin();
    error.textContent = err.message;
    error.hidden = false;
    btn.disabled = false;
  }
});
