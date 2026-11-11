"use strict";
/* Receipts page: upload -> OCR on the server -> review -> running total -> save as expenses */

const MAX_BYTES = 25 * 1024 * 1024;
const PDF_ICON = '<svg class="pdf-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/><text x="7.5" y="17" font-size="5" stroke="none" fill="currentColor" font-family="sans-serif">PDF</text></svg>';
const FLAG_TEXT = {
  no_amount: "อ่านยอดรวมไม่ได้ — ดูรูปแล้วพิมพ์ยอดเอง",
  check_amount: "ไม่พบคำว่า “รวม” หรือ “Total” ระบบใช้ยอดที่มากที่สุด — ตรวจกับรูปอีกครั้ง",
  no_date: "ไม่พบวันที่ในใบเสร็จ ใช้วันที่อัปโหลดแทน",
};

const rs = {
  categories: [],
  slips: [], // {key, status: uploading|ready|error, name, file, localUrl, isPdf, data, error}
  queue: [],
  active: 0,
  seq: 0,
  timers: new Map(),
  pendingChanges: new Map(),
};

/* ---------------- loading ---------------- */
async function init() {
  try {
    const s = await api("/api/ocr/status");
    $("#ocr-warning").hidden = s.available;
  } catch { /* ignore */ }
  try {
    const [cats, pending] = await Promise.all([api("/api/categories"), api("/api/receipts?status=pending")]);
    rs.categories = cats.filter((c) => c.type === "expense");
    rs.slips = pending.map((r) => ({ key: "r" + r.id, status: "ready", data: r }));
  } catch (e) {
    toast(e.message, true);
  }
  renderAll();
}

/* ---------------- adding files ---------------- */
function addFiles(files) {
  const list = [...files].filter((f) => f && f.size !== undefined);
  if (!list.length) return;
  for (const file of list) {
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const slip = { key: "u" + ++rs.seq, status: "uploading", name: file.name || "ใบเสร็จ", file, isPdf, localUrl: null };
    if (file.size > MAX_BYTES) {
      Object.assign(slip, { status: "error", error: "ไฟล์ใหญ่เกิน 25 MB", file: null });
    } else {
      if (!isPdf && /^image\/(jpeg|png|webp|gif|bmp)$/.test(file.type)) slip.localUrl = URL.createObjectURL(file);
      rs.queue.push(slip);
    }
    rs.slips.unshift(slip);
  }
  renderAll();
  pump();
}

function pump() {
  while (rs.active < 2 && rs.queue.length) {
    const slip = rs.queue.shift();
    rs.active++;
    upload(slip).finally(() => { rs.active--; pump(); renderTape(); });
  }
  renderTape();
}

async function upload(slip) {
  try {
    slip.data = await api("/api/receipts", {
      method: "POST",
      body: slip.file,
      headers: { "x-filename": encodeURIComponent(slip.name), "content-type": slip.file.type || "application/octet-stream" },
    });
    slip.status = "ready";
  } catch (e) {
    slip.status = "error";
    slip.error = e.message;
  }
  if (slip.localUrl) URL.revokeObjectURL(slip.localUrl);
  slip.localUrl = null;
  slip.file = null;
  if (rs.slips.includes(slip)) replaceSlip(slip);
}

/* ---------------- rendering ---------------- */
function categoryOptions(selected) {
  const opts = rs.categories.map((c) => `<option value="${c.id}"${c.id === selected ? " selected" : ""}>${esc(c.name)}</option>`).join("");
  return (selected ? "" : '<option value="" selected disabled>เลือกหมวด</option>') + opts;
}

function slipHTML(slip) {
  if (slip.status === "uploading") {
    return `<li class="slip loading" data-key="${slip.key}">
      <div class="slip-thumb">${slip.localUrl ? `<img src="${slip.localUrl}" alt="">` : PDF_ICON}</div>
      <div class="slip-body">
        <p class="slip-name">${esc(slip.name)}</p>
        <p class="slip-status"><span class="spinner" aria-hidden="true"></span>กำลังอ่านใบเสร็จ…</p>
      </div></li>`;
  }
  if (slip.status === "error") {
    return `<li class="slip failed" data-key="${slip.key}">
      <div class="slip-thumb">${PDF_ICON}</div>
      <div class="slip-body">
        <p class="slip-name">${esc(slip.name)}</p>
        <p class="slip-flag">${esc(slip.error)}</p>
        <button class="text-btn small" type="button" data-act="dismiss">นำออก</button>
      </div></li>`;
  }
  const d = slip.data;
  const flags = [...d.flags.map((f) => FLAG_TEXT[f]).filter(Boolean), d.error].filter(Boolean);
  const cands = d.candidates.filter((v) => v !== d.amount).slice(0, 5);
  const label = d.merchant || d.original_name || "ใบเสร็จ";
  return `<li class="slip${d.included ? "" : " excluded"}" data-key="${slip.key}">
    <button type="button" class="slip-thumb" data-act="view" aria-label="ดูรูปใบเสร็จ ${esc(label)}">
      <img src="${d.image_url}" alt="" loading="lazy">
    </button>
    <div class="slip-body">
      <div class="slip-top">
        <input class="slip-merchant" data-field="merchant" value="${esc(d.merchant)}" placeholder="ชื่อร้าน" maxlength="200" aria-label="ชื่อร้าน">
        <label class="slip-include"><input type="checkbox" data-field="included"${d.included ? " checked" : ""}> รวมยอด</label>
      </div>
      <div class="slip-fields">
        <label class="field"><span class="field-label">ยอดรวม (บาท)</span>
          <input class="slip-amount${d.amount ? "" : " invalid"}" data-field="amount" inputmode="decimal" autocomplete="off"
                 value="${d.amount != null ? d.amount.toFixed(2) : ""}" placeholder="ใส่ยอด"></label>
        <label class="field"><span class="field-label">วันที่</span>
          <input type="date" data-field="date" value="${esc(d.date || "")}"></label>
        <label class="field"><span class="field-label">หมวดหมู่</span>
          <select data-field="category_id">${categoryOptions(d.category_id)}</select></label>
      </div>
      ${cands.length ? `<div class="slip-cands"><span>ยอดอื่นที่พบ</span>${cands.map((v) =>
        `<button type="button" class="cand" data-act="pick" data-v="${v}">${fmt(v)}</button>`).join("")}</div>` : ""}
      ${flags.map((f) => `<p class="slip-flag">${esc(f)}</p>`).join("")}
      <div class="slip-foot">
        <details><summary>ข้อความที่อ่านได้</summary><pre>${esc(d.ocr_text || "(ไม่มีข้อความ)")}</pre></details>
        <button class="text-btn small danger-text" type="button" data-act="remove">ลบใบนี้</button>
      </div>
    </div></li>`;
}

function renderAll() {
  $("#slips").innerHTML = rs.slips.map(slipHTML).join("");
  $("#rc-empty").hidden = rs.slips.length > 0;
  $("#rc-toolbar").hidden = rs.slips.length === 0;
  renderTape();
}

function replaceSlip(slip) {
  const li = $(`#slips [data-key="${slip.key}"]`);
  if (!li) return renderAll();
  li.outerHTML = slipHTML(slip);
}

function readySlips() {
  return rs.slips.filter((s) => s.status === "ready");
}

function renderTape() {
  const ready = readySlips();
  const inc = ready.filter((s) => s.data.included);
  const uploading = rs.slips.filter((s) => s.status === "uploading").length;
  const missing = inc.filter((s) => !(s.data.amount > 0)).length;
  const sum = inc.reduce((t, s) => t + (s.data.amount > 0 ? s.data.amount : 0), 0);

  $("#slips-title").textContent = uploading && !ready.length ? `กำลังอ่าน ${uploading} ใบ…` : `รอตรวจ ${ready.length} ใบ`;
  $("#tape-lines").innerHTML = [...inc].reverse().map((s) => `<li>
      <span class="t-name">${esc(s.data.merchant || "ไม่มีชื่อร้าน")}</span>
      <span class="t-amt${s.data.amount > 0 ? "" : " t-missing"}">${s.data.amount > 0 ? fmt(s.data.amount) : "ยอดไม่ครบ"}<i aria-hidden="true">+</i></span>
    </li>`).join("") || `<li class="t-blank">ใบที่เลือกจะมาบวกกันที่นี่</li>`;
  $("#tape-count").textContent = `รวม ${inc.length} ใบ`;
  $("#tape-sum").textContent = fmt(sum);

  const byCat = new Map();
  for (const s of inc) {
    if (!(s.data.amount > 0)) continue;
    const c = rs.categories.find((x) => x.id === s.data.category_id);
    const key = c ? c.id : 0;
    const row = byCat.get(key) || { name: c ? c.name : "ยังไม่เลือกหมวด", color: c ? c.color : "#8590A3", total: 0 };
    row.total += s.data.amount;
    byCat.set(key, row);
  }
  $("#tape-cats").innerHTML = [...byCat.values()].sort((a, b) => b.total - a.total)
    .map((c) => `<li style="--c:${esc(c.color)}"><span><i></i>${esc(c.name)}</span><span>${fmt(c.total)}</span></li>`).join("");

  const btn = $("#save-all");
  const noCat = inc.some((s) => !s.data.category_id);
  btn.disabled = inc.length === 0 || missing > 0 || noCat;
  btn.textContent = inc.length ? `บันทึก ${inc.length} ใบเป็นรายจ่าย` : "บันทึกเป็นรายจ่าย";
  const hints = [];
  if (uploading) hints.push(`กำลังอ่านอีก ${uploading} ใบ…`);
  if (missing) hints.push(`มี ${missing} ใบที่ยอดว่างหรือไม่ถูกต้อง แก้ยอดหรือเอาเครื่องหมาย “รวมยอด” ออกก่อน`);
  if (noCat) hints.push("เลือกหมวดหมู่ให้ครบทุกใบ");
  $("#tape-hint").textContent = hints.join(" · ") || "ลงสมุดบัญชีตามวันที่บนใบเสร็จ แนบรูปไว้ดูภายหลังได้";
}

/* ---------------- editing ---------------- */
function slipFromEl(el) {
  const li = el.closest(".slip");
  return li && rs.slips.find((s) => s.key === li.dataset.key);
}

function queueSave(slip, changes, delay = 500) {
  const id = slip.data.id;
  rs.pendingChanges.set(id, { ...(rs.pendingChanges.get(id) || {}), ...changes });
  clearTimeout(rs.timers.get(id));
  rs.timers.set(id, setTimeout(async () => {
    const body = rs.pendingChanges.get(id);
    rs.pendingChanges.delete(id);
    rs.timers.delete(id);
    try {
      await api(`/api/receipts/${id}`, { method: "PUT", json: body });
    } catch (e) {
      toast(e.message, true);
    }
  }, delay));
}

function cancelSave(id) {
  clearTimeout(rs.timers.get(id));
  rs.timers.delete(id);
  rs.pendingChanges.delete(id);
}

function applyField(slip, field, el) {
  const d = slip.data;
  if (field === "amount") {
    const { amount, valid } = readAmount(el.value);
    el.classList.toggle("invalid", amount === null);
    d.amount = amount; // invalid text clears the amount, which blocks saving until it is fixed
    if (valid) queueSave(slip, { amount: amount === null ? null : amount.toFixed(2) });
  } else if (field === "merchant") {
    d.merchant = el.value;
    queueSave(slip, { merchant: el.value });
  } else if (field === "date") {
    if (!el.value) return;
    d.date = el.value;
    queueSave(slip, { date: el.value }, 0);
  } else if (field === "category_id") {
    d.category_id = Number(el.value);
    queueSave(slip, { category_id: d.category_id }, 0);
  } else if (field === "included") {
    d.included = el.checked;
    el.closest(".slip").classList.toggle("excluded", !el.checked);
    queueSave(slip, { included: el.checked }, 0);
  }
  renderTape();
}

const slipsEl = $("#slips");
slipsEl.addEventListener("input", (e) => {
  const field = e.target.dataset.field;
  const slip = slipFromEl(e.target);
  if (field && slip?.data && (field === "amount" || field === "merchant")) applyField(slip, field, e.target);
});
slipsEl.addEventListener("change", (e) => {
  const field = e.target.dataset.field;
  const slip = slipFromEl(e.target);
  if (!field || !slip?.data) return;
  if (field === "amount") {
    const { amount } = readAmount(e.target.value);
    if (amount !== null) e.target.value = amount.toFixed(2); // show "45+60" as 105.00
  }
  if (field !== "merchant") applyField(slip, field, e.target);
});
slipsEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const slip = slipFromEl(btn);
  if (!slip) return;
  const act = btn.dataset.act;
  if (act === "view") {
    $("#viewer-img").src = slip.data.image_url;
    $("#viewer-img").alt = `ใบเสร็จ ${slip.data.merchant || ""}`;
    $("#viewer-title").textContent = slip.data.merchant || slip.data.original_name || "ใบเสร็จ";
    $("#viewer-open").href = slip.data.file_url;
    $("#viewer").showModal();
  } else if (act === "pick") {
    const input = btn.closest(".slip").querySelector('[data-field="amount"]');
    input.value = Number(btn.dataset.v).toFixed(2);
    applyField(slip, "amount", input);
  } else if (act === "dismiss") {
    rs.slips = rs.slips.filter((s) => s !== slip);
    renderAll();
  } else if (act === "remove") {
    if (!confirm(`ลบใบเสร็จ “${slip.data.merchant || slip.data.original_name || "ไม่มีชื่อ"}” ?`)) return;
    try {
      cancelSave(slip.data.id);
      await api(`/api/receipts/${slip.data.id}`, { method: "DELETE" });
      rs.slips = rs.slips.filter((s) => s !== slip);
      renderAll();
      toast("ลบใบเสร็จแล้ว");
    } catch (err) {
      toast(err.message, true);
    }
  }
});

function setAllIncluded(on) {
  for (const s of readySlips()) {
    if (s.data.included === on) continue;
    s.data.included = on;
    queueSave(s, { included: on }, 0);
  }
  renderAll();
}
$("#include-all").addEventListener("click", () => setAllIncluded(true));
$("#exclude-all").addEventListener("click", () => setAllIncluded(false));

/* ---------------- saving ---------------- */
$("#save-all").addEventListener("click", async () => {
  const items = readySlips().filter((s) => s.data.included);
  const bad = items.find((s) => !(s.data.amount > 0) || !s.data.category_id || !s.data.date);
  if (bad) {
    toast("ยังมีใบที่ข้อมูลไม่ครบ", true);
    $(`#slips [data-key="${bad.key}"] [data-field="amount"]`)?.focus();
    return;
  }
  const btn = $("#save-all");
  btn.disabled = true;
  try {
    items.forEach((s) => cancelSave(s.data.id));
    const res = await api("/api/receipts/commit", {
      method: "POST",
      json: {
        items: items.map((s) => ({
          id: s.data.id, amount: s.data.amount.toFixed(2), date: s.data.date,
          category_id: s.data.category_id, merchant: s.data.merchant || "",
        })),
      },
    });
    const latest = items.map((s) => s.data.date).sort().pop();
    rs.slips = rs.slips.filter((s) => !items.includes(s));
    renderAll();
    showSaved(res, latest.slice(0, 7));
  } catch (e) {
    toast(e.message, true);
    renderTape();
  }
});

function showSaved(res, month) {
  let banner = $("#saved-banner");
  if (!banner) {
    banner = document.createElement("p");
    banner.id = "saved-banner";
    banner.className = "saved-banner";
    banner.setAttribute("role", "status");
    $(".rc-head").after(banner);
  }
  banner.innerHTML = `บันทึก ${res.saved} ใบ รวม <b>${fmt(res.total)}</b> บาท ลงสมุดบัญชีแล้ว
    <a href="/#${month}">ดูใน${esc(monthName(month))}</a>`;
  toast(`บันทึก ${res.saved} ใบแล้ว`);
}

/* ---------------- file inputs, drag & drop, paste ---------------- */
$("#file-input").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
$("#camera-input").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });

const dz = $("#dropzone");
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  dragDepth++;
  dz.classList.add("over");
});
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; dz.classList.remove("over"); } });
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dz.classList.remove("over");
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});
document.addEventListener("paste", (e) => {
  if (e.target.closest?.("input, textarea")) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) addFiles(files.map((f, i) => (f.name && f.name !== "image.png" ? f
    : new File([f], `วางจากคลิปบอร์ด-${Date.now()}-${i}.png`, { type: f.type }))));
});
window.addEventListener("beforeunload", (e) => {
  if (rs.active || rs.queue.length || rs.timers.size) { e.preventDefault(); e.returnValue = ""; }
});

init();
