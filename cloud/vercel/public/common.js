"use strict";
/* Shared helpers for every page (loaded before page scripts). */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const pad = (n) => String(n).padStart(2, "0");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const money = new Intl.NumberFormat("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 0 });
const monthLong = new Intl.DateTimeFormat("th-TH", { month: "long", year: "numeric" });
const monthShort = new Intl.DateTimeFormat("th-TH", { month: "short" });
const yearFmt = new Intl.DateTimeFormat("th-TH", { year: "numeric" });

const fmt = (n) => money.format(n);
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d || 1); };
const thisMonth = () => isoDate(new Date()).slice(0, 7);
const shiftMonth = (m, delta) => { const d = parseISO(m + "-01"); d.setMonth(d.getMonth() + delta); return isoDate(d).slice(0, 7); };
const monthName = (m) => monthLong.format(parseISO(m + "-01"));
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const TYPE_TH = { income: "รายรับ", expense: "รายจ่าย" };

/** Low-level call to this app's own /api functions. Sends the header the server requires for changes. */
async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "fetch" },
    body: JSON.stringify(body ?? {}),
    credentials: "same-origin",
  });
  const isJson = (res.headers.get("content-type") || "").includes("json");
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    const msg = (data && typeof data.detail === "string" && data.detail)
      || (res.status === 413 ? "ไฟล์หรือข้อมูลใหญ่เกินไป" : `เกิดข้อผิดพลาด (รหัส ${res.status})`);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

function goToLogin() {
  const next = location.pathname + location.search + location.hash;
  location.replace("/login.html" + (next && next !== "/" ? "?next=" + encodeURIComponent(next) : ""));
}

/** Calls the backend (Google Sheet) through /api/rpc, e.g. rpc("month.get", {month: "2026-11"}). */
async function rpc(action, params = {}) {
  try {
    return await apiPost("/api/rpc", { action, params });
  } catch (err) {
    if (err.status === 401) {
      goToLogin(); // session expired or not signed in
      err.message = "กำลังไปหน้าเข้าสู่ระบบ…";
    }
    throw err;
  }
}

async function logout() {
  try {
    await apiPost("/api/logout");
  } finally {
    location.replace("/login.html");
  }
}

function downloadText(filename, text, mime = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const receiptFileUrl = (id) => `/api/file?id=${id}`;

let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 5000 : 2600);
}

const NUM = String.raw`(?:\d+(?:\.\d*)?|\.\d+)`;
const AMOUNT_RE = new RegExp(String.raw`^${NUM}(?:[+\-]${NUM})*$`);
/** "45+60-5" -> 100. Commas, spaces and ฿ are ignored. Returns NaN if invalid. */
function evalAmount(text) {
  const s = String(text).replace(/[,\s฿]/g, "");
  if (!AMOUNT_RE.test(s)) return NaN;
  const total = s.match(/[+\-]?[^+\-]+/g).reduce((sum, p) => sum + Number(p), 0);
  return Math.round(total * 100) / 100;
}

/**
 * Reads an amount field. Empty -> {amount: null, valid: true}; "12a", "0" or "-5" -> {amount: null, valid: false}.
 * A field that doesn't hold a positive amount never keeps an older value, so it can't be saved by mistake.
 */
function readAmount(text) {
  const s = String(text ?? "").trim();
  if (!s) return { amount: null, valid: true };
  const v = evalAmount(s);
  return v > 0 ? { amount: v, valid: true } : { amount: null, valid: false };
}



document.addEventListener("click", (e) => {
  if (e.target.closest("[data-logout]")) logout();
});
