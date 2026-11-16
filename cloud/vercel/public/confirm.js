"use strict";
/*
 * Where the links in our emails land (?token_hash=…&type=email|recovery).
 * Nothing happens until the button is pressed: mail scanners that open every link would otherwise use up the
 * one-time token, and cookies set during the arrival from a mail app would not be sent on the next page.
 * Afterwards the page says which account is now signed in, so a link someone else sent can't quietly put you
 * into their account.
 */

const params = new URLSearchParams(location.search);
const type = params.get("type") === "recovery" ? "recovery" : params.get("type") === "email" ? "email" : "";
const tokenHash = params.get("token_hash") || "";
const btn = $("#confirm-btn");

function expired(message) {
  $("#form-error").textContent = message || "ลิงก์นี้ใช้แล้วหรือหมดอายุ — ขอลิงก์ใหม่";
  $("#form-error").hidden = false;
  $("#expired-links").hidden = false;
  btn.hidden = true;
}

if (type === "recovery") {
  $("#confirm-title").textContent = "ตั้งรหัสผ่านใหม่";
  $("#confirm-sub").textContent = "กดปุ่มด้านล่างเพื่อไปตั้งรหัสผ่านใหม่";
  btn.textContent = "ตั้งรหัสผ่านใหม่";
}
if (!type || !tokenHash) expired();

btn.addEventListener("click", async () => {
  btn.disabled = true;
  $("#form-error").hidden = true;
  try {
    const r = await apiPost("/api/verify", { token_hash: tokenHash, type });
    $("#confirm-title").textContent = type === "recovery" ? "ยืนยันตัวตนแล้ว" : "ยืนยันอีเมลแล้ว";
    $("#confirm-sub").hidden = true;
    $("#signed-in-email").textContent = r.email || "";
    $("#signed-in").hidden = false;
    $("#continue-link").href = r.next || "/";
    btn.hidden = true;
  } catch (err) {
    if (err.code === "link_expired") return expired(err.message);
    $("#form-error").textContent = err.message;
    $("#form-error").hidden = false;
    btn.disabled = false;
  }
});
