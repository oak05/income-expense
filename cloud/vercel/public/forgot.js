"use strict";
/* Forgot-password page: Supabase emails a reset link (to confirm.html) if the account exists. */

$("#forgot-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#submit-btn"), error = $("#form-error");
  error.hidden = true;
  btn.disabled = true;
  btn.textContent = "กำลังส่ง…";
  try {
    await apiPost("/api/recover", { email: $("#email").value });
    $("#forgot-form").hidden = true;
    $("#done").hidden = false;
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    btn.disabled = false;
    btn.textContent = "ส่งลิงก์";
  }
});
