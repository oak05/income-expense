"use strict";
/* Sign-up page: create an account. Either Supabase emails a confirmation link to confirm.html, or (with email
   confirmation off in Supabase) the account is ready at once and the answer says where to go. */

$("#signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#submit-btn"), error = $("#form-error");
  error.hidden = true;
  if ($("#password").value !== $("#password2").value) {
    error.textContent = "รหัสผ่านสองช่องไม่ตรงกัน";
    error.hidden = false;
    return;
  }
  btn.disabled = true;
  btn.textContent = "กำลังสมัคร…";
  try {
    const res = await apiPost("/api/signup", { email: $("#email").value, password: $("#password").value });
    if (res && res.next === "/") {
      location.replace("/");
      return;
    }
    $("#done-email").textContent = $("#email").value.trim();
    $("#signup-form").hidden = true;
    $("#done").hidden = false;
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    btn.disabled = false;
    btn.textContent = "สมัครสมาชิก";
  }
});
