"use strict";

const CLIP_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11l-8.5 8.5a5 5 0 01-7-7L14 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 7"/></svg>';

/* ===================== state ===================== */
const state = {
  month: /^#\d{4}-\d{2}$/.test(location.hash) ? location.hash.slice(1) : thisMonth(),
  categories: [],
  transactions: [],
  summary: null,
  yearly: null,
  editingId: null,
  lastCategory: { income: null, expense: null },
  tab: "ledger",
  filters: { type: "", category: "", q: "" },
  highlightId: null,
  charts: {},
};

/* ===================== loading ===================== */
async function loadCategories() {
  state.categories = await api("/api/categories");
  renderChips();
  renderCategoryFilter();
  if ($("#categories-dialog").open) renderCategoryDialog();
}

async function loadMonth() {
  const m = state.month;
  history.replaceState(null, "", "#" + m);
  $("#month-text").textContent = monthName(m);
  $("#month-input").value = m;
  $("#export-month").href = `/api/export.csv?month=${m}`;
  $("#export-month").textContent = `ดาวน์โหลด CSV ${monthName(m)}`;
  try {
    const [summary, txs] = await Promise.all([
      api(`/api/summary?month=${m}`),
      api(`/api/transactions?month=${m}`),
    ]);
    if (m !== state.month) return; // user moved on
    state.summary = summary;
    state.transactions = txs;
    renderTotals();
    renderLedger();
    renderNoteSuggestions();
    if (state.tab === "month") renderMonthView();
    if (state.tab === "year") await loadYear();
  } catch (e) {
    toast(e.message, true);
  }
}

async function loadYear() {
  const year = Number(state.month.slice(0, 4));
  state.yearly = await api(`/api/yearly?year=${year}`);
  renderYearView();
}

/* ===================== totals band ===================== */
function compareNote(now, prev) {
  if (!prev) return "";
  const pct = Math.round(((now - prev) / prev) * 100);
  if (pct === 0) return "เท่ากับเดือนก่อน";
  return `${pct > 0 ? "มากกว่า" : "น้อยกว่า"}เดือนก่อน ${Math.abs(pct)}%`;
}

function renderTotals() {
  const { totals, previous, cumulative_balance } = state.summary;
  $("#t-income").textContent = fmt(totals.income);
  $("#t-expense").textContent = fmt(totals.expense);
  const bal = $("#t-balance");
  bal.textContent = fmt(totals.balance);
  bal.classList.toggle("neg", totals.balance < 0);
  const cum = $("#t-cumulative");
  cum.textContent = fmt(cumulative_balance);
  cum.classList.toggle("neg", cumulative_balance < 0);

  $("#t-income-note").textContent = compareNote(totals.income, previous.income);
  $("#t-expense-note").textContent = compareNote(totals.expense, previous.expense);
  let balNote = "";
  if (totals.income > 0 && totals.balance >= 0) balNote = `เก็บได้ ${Math.round((totals.balance / totals.income) * 100)}% ของรายรับ`;
  else if (totals.balance < 0) balNote = "ใช้จ่ายเกินรายรับ";
  $("#t-balance-note").textContent = balNote;
}

/* ===================== ledger (passbook) ===================== */
function filtersActive() {
  const f = state.filters;
  return Boolean(f.type || f.category || f.q.trim());
}

function filteredTransactions() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  return state.transactions
    .filter((t) => (!f.type || t.type === f.type)
      && (!f.category || String(t.category_id) === f.category)
      && (!q || t.note.toLowerCase().includes(q) || t.category_name.toLowerCase().includes(q)))
    .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
}

function renderLedger() {
  const body = $("#ledger-body");
  const table = $(".ledger");
  const empty = $("#ledger-empty");
  const filtered = filtersActive();
  const rows = filteredTransactions();
  const { totals, cumulative_balance } = state.summary;
  table.classList.toggle("filtered", filtered);

  if (!rows.length) {
    body.innerHTML = "";
    table.hidden = true;
    empty.hidden = false;
    empty.textContent = filtered
      ? "ไม่พบรายการที่ตรงกับตัวกรอง ลองล้างช่องค้นหาหรือเลือก “ทุกหมวดหมู่”"
      : `ยังไม่มีรายการใน${monthName(state.month)} — เริ่มจดรายการแรกจากแบบฟอร์มได้เลย`;
    return;
  }
  table.hidden = false;
  empty.hidden = true;

  let running = cumulative_balance - totals.balance; // balance brought forward
  let html = "";
  if (!filtered) {
    html += `<tr class="bf"><td></td><td>ยอดยกมา</td><td class="num out"></td><td class="num in"></td>
      <td class="num amt">${fmt(running)}</td>
      <td class="num bal${running < 0 ? " neg" : ""}">${fmt(running)}</td></tr>`;
  }
  let lastDate = "";
  let sumIn = 0, sumOut = 0;
  for (const t of rows) {
    const isIn = t.type === "income";
    running += isIn ? t.amount : -t.amount;
    if (isIn) sumIn += t.amount; else sumOut += t.amount;
    const d = parseISO(t.date);
    const dateCell = t.date === lastDate ? "" : `<span class="dd">${d.getDate()}</span> ${esc(monthShort.format(d))}`;
    lastDate = t.date;
    const cls = ["tx"];
    if (t.id === state.editingId) cls.push("selected");
    if (t.id === state.highlightId) cls.push("new");
    html += `<tr class="${cls.join(" ")}" data-id="${t.id}" tabindex="0"
        aria-label="${esc(`${d.getDate()} ${monthShort.format(d)} ${t.category_name} ${TYPE_TH[t.type]} ${fmt(t.amount)} บาท ${t.note}`)}">
      <td class="date">${dateCell}</td>
      <td class="desc" style="--c:${esc(t.category_color)}">${t.note
        ? `<span class="desc-main">${esc(t.note)}</span><span class="desc-tag"><i></i>${esc(t.category_name)}</span>`
        : `<span class="desc-main"><i></i>${esc(t.category_name)}</span>`}${t.receipt_id
        ? `<a class="clip" href="/api/receipts/${t.receipt_id}/file" target="_blank" rel="noopener" title="ดูใบเสร็จ" aria-label="ดูใบเสร็จ">${CLIP_SVG}</a>` : ""}</td>
      <td class="num out">${isIn ? "" : fmt(t.amount)}</td>
      <td class="num in">${isIn ? fmt(t.amount) : ""}</td>
      <td class="num amt ${isIn ? "in" : "out"}">${isIn ? "+" : "−"}${fmt(t.amount)}</td>
      <td class="num bal${running < 0 ? " neg" : ""}">${fmt(running)}</td>
    </tr>`;
  }
  const net = sumIn - sumOut;
  html += `<tr class="cf"><td></td><td>${filtered ? `รวม ${rows.length} รายการที่แสดง` : "รวมเดือนนี้"}</td>
    <td class="num out">${fmt(sumOut)}</td><td class="num in">${fmt(sumIn)}</td>
    <td class="num amt${net < 0 ? " out" : ""}">${net < 0 ? "−" : "+"}${fmt(Math.abs(net))}</td>
    <td class="num bal${running < 0 ? " neg" : ""}">${fmt(running)}</td></tr>`;
  body.innerHTML = html;
  state.highlightId = null;
}

function renderNoteSuggestions() {
  const notes = [...new Set(state.transactions.map((t) => t.note).filter(Boolean))].slice(0, 40);
  $("#note-suggestions").innerHTML = notes.map((n) => `<option value="${esc(n)}">`).join("");
}

function renderCategoryFilter() {
  const sel = $("#f-category");
  const current = sel.value;
  const group = (type) => state.categories.filter((c) => c.type === type)
    .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  sel.innerHTML = `<option value="">ทุกหมวดหมู่</option>
    <optgroup label="รายจ่าย">${group("expense")}</optgroup>
    <optgroup label="รายรับ">${group("income")}</optgroup>`;
  sel.value = state.categories.some((c) => String(c.id) === current) ? current : "";
  state.filters.category = sel.value;
}

/* ===================== entry form ===================== */
const form = $("#tx-form");
const currentType = () => form.elements.type.value;

function renderChips() {
  const type = currentType();
  const cats = state.categories.filter((c) => c.type === type);
  let selected = state.lastCategory[type];
  if (!cats.some((c) => c.id === selected)) selected = cats[0]?.id ?? null;
  state.lastCategory[type] = selected;
  const box = $("#category-chips");
  if (!cats.length) {
    box.innerHTML = `<span class="field-hint">ยังไม่มีหมวด${TYPE_TH[type]} — เพิ่มได้ที่ปุ่ม “หมวดหมู่” ด้านบน</span>`;
    return;
  }
  box.innerHTML = cats.map((c) => `<button type="button" class="chip" role="radio" style="--c:${esc(c.color)}"
      data-id="${c.id}" aria-checked="${c.id === selected}" tabindex="${c.id === selected ? 0 : -1}"><i></i>${esc(c.name)}</button>`).join("");
}

function updateFormMode() {
  const type = currentType();
  form.dataset.type = type;
  $("#submit-btn").textContent = state.editingId ? "บันทึกการแก้ไข" : `บันทึก${TYPE_TH[type]}`;
}

function setDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  form.elements.date.value = isoDate(d);
}

function showFormError(msg) {
  const el = $("#form-error");
  el.textContent = msg || "";
  el.hidden = !msg;
}

function resetForm({ keepDate = true } = {}) {
  state.editingId = null;
  $(".entry").classList.remove("editing");
  $("#entry-title").textContent = "จดรายการ";
  $("#cancel-edit").hidden = true;
  $("#delete-btn").hidden = true;
  $("#edit-receipt-link").hidden = true;
  form.elements.amount.value = "";
  form.elements.note.value = "";
  if (!keepDate || !form.elements.date.value) setDate(0);
  $("#amount-hint").textContent = "พิมพ์ 45+60 ได้ ระบบจะรวมให้";
  showFormError("");
  updateFormMode();
  $$(".ledger tr.selected").forEach((r) => r.classList.remove("selected"));
}

function startEdit(id) {
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return;
  state.editingId = id;
  form.elements.type.value = t.type;
  state.lastCategory[t.type] = t.category_id;
  renderChips();
  form.elements.amount.value = t.amount.toFixed(2);
  form.elements.date.value = t.date;
  form.elements.note.value = t.note;
  $(".entry").classList.add("editing");
  $("#entry-title").textContent = "แก้ไขรายการ";
  $("#cancel-edit").hidden = false;
  $("#delete-btn").hidden = false;
  const link = $("#edit-receipt-link");
  link.hidden = !t.receipt_id;
  if (t.receipt_id) link.href = `/api/receipts/${t.receipt_id}/file`;
  showFormError("");
  updateFormMode();
  $$(".ledger tr.tx").forEach((r) => r.classList.toggle("selected", Number(r.dataset.id) === id));
  if (window.matchMedia("(max-width: 960px)").matches) $(".entry").scrollIntoView({ behavior: "smooth", block: "start" });
  form.elements.amount.focus();
}

form.addEventListener("change", (e) => {
  if (e.target.name === "type") { renderChips(); updateFormMode(); }
});

form.elements.amount.addEventListener("input", () => {
  const raw = form.elements.amount.value;
  const v = evalAmount(raw);
  const hint = $("#amount-hint");
  if (/\d[+\-]\d/.test(raw.replace(/[,\s]/g, ""))) hint.textContent = Number.isNaN(v) ? "สูตรไม่ถูกต้อง" : `รวม = ${fmt(v)} บาท`;
  else hint.textContent = "พิมพ์ 45+60 ได้ ระบบจะรวมให้";
});

$("#category-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  state.lastCategory[currentType()] = Number(chip.dataset.id);
  $$(".chip").forEach((c) => {
    const on = c === chip;
    c.setAttribute("aria-checked", on);
    c.tabIndex = on ? 0 : -1;
  });
});
$("#category-chips").addEventListener("keydown", (e) => {
  if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
  const chips = $$(".chip");
  const i = chips.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = chips[(i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) + chips.length) % chips.length];
  next.focus();
  next.click();
});

$$("[data-days-ago]").forEach((b) => b.addEventListener("click", () => setDate(Number(b.dataset.daysAgo))));
$("#cancel-edit").addEventListener("click", () => resetForm());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.editingId && !document.querySelector("dialog[open]")) resetForm();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const type = currentType();
  const amount = evalAmount(form.elements.amount.value);
  const category_id = state.lastCategory[type];
  const date = form.elements.date.value;
  if (!(amount > 0)) { showFormError("ใส่จำนวนเงินที่มากกว่า 0"); form.elements.amount.focus(); return; }
  if (!category_id) { showFormError("เลือกหมวดหมู่ก่อนบันทึก"); return; }
  if (!date) { showFormError("เลือกวันที่"); form.elements.date.focus(); return; }
  showFormError("");

  const payload = { type, amount: amount.toFixed(2), category_id, date, note: form.elements.note.value };
  const editing = state.editingId;
  const btn = $("#submit-btn");
  btn.disabled = true;
  try {
    const saved = editing
      ? await api(`/api/transactions/${editing}`, { method: "PUT", json: payload })
      : await api("/api/transactions", { method: "POST", json: payload });
    const otherMonth = saved.date.slice(0, 7) !== state.month;
    toast((editing ? "บันทึกการแก้ไขแล้ว" : `บันทึก${TYPE_TH[type]}แล้ว`)
      + (otherMonth ? ` (อยู่ใน${monthName(saved.date.slice(0, 7))})` : ""));
    state.highlightId = saved.id;
    resetForm();
    form.elements.amount.focus();
    await loadMonth();
  } catch (err) {
    showFormError(err.message);
  } finally {
    btn.disabled = false;
  }
});

$("#delete-btn").addEventListener("click", async () => {
  const t = state.transactions.find((x) => x.id === state.editingId);
  if (!t) return;
  const extra = t.receipt_id ? "\nรูปใบเสร็จที่แนบไว้จะถูกลบด้วย" : "";
  if (!confirm(`ลบรายการ “${t.note || t.category_name}” ${fmt(t.amount)} บาท วันที่ ${t.date} ?${extra}`)) return;
  try {
    await api(`/api/transactions/${t.id}`, { method: "DELETE" });
    toast("ลบรายการแล้ว");
    resetForm();
    await loadMonth();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ledger interactions */
$("#ledger-body").addEventListener("click", (e) => {
  if (e.target.closest("a")) return; // receipt link opens in a new tab
  const row = e.target.closest("tr.tx");
  if (row) startEdit(Number(row.dataset.id));
});
$("#ledger-body").addEventListener("keydown", (e) => {
  const row = e.target.closest("tr.tx");
  if (row && !e.target.closest("a") && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); startEdit(Number(row.dataset.id)); }
});
$("#f-type").addEventListener("change", (e) => { state.filters.type = e.target.value; renderLedger(); });
$("#f-category").addEventListener("change", (e) => { state.filters.category = e.target.value; renderLedger(); });
$("#f-q").addEventListener("input", (e) => { state.filters.q = e.target.value; renderLedger(); });

/* ===================== month navigation ===================== */
function goMonth(m) {
  if (!/^\d{4}-\d{2}$/.test(m) || m === state.month) return;
  state.month = m;
  loadMonth();
}
$("#prev-month").addEventListener("click", () => goMonth(shiftMonth(state.month, -1)));
$("#next-month").addEventListener("click", () => goMonth(shiftMonth(state.month, 1)));
$("#this-month").addEventListener("click", () => goMonth(thisMonth()));
$("#month-input").addEventListener("change", (e) => goMonth(e.target.value));
$(".month-label").addEventListener("click", () => { try { $("#month-input").showPicker(); } catch { /* older browsers */ } });

/* ===================== tabs ===================== */
const tabs = $$('[role="tab"]');
function selectTab(tab) {
  tabs.forEach((t) => {
    const on = t === tab;
    t.setAttribute("aria-selected", on);
    t.tabIndex = on ? 0 : -1;
    $("#" + t.getAttribute("aria-controls")).hidden = !on;
  });
  state.tab = tab.id.replace("tab-", "");
  if (state.tab === "month" && state.summary) renderMonthView();
  if (state.tab === "year") loadYear().catch((e) => toast(e.message, true));
}
tabs.forEach((t) => {
  t.addEventListener("click", () => selectTab(t));
  t.addEventListener("keydown", (e) => {
    const i = tabs.indexOf(t);
    let next = null;
    if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
    if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
    if (next) { e.preventDefault(); next.focus(); selectTab(next); }
  });
});

/* ===================== charts ===================== */
function chartBase() {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 13;
  Chart.defaults.color = cssVar("--ink-2");
  Chart.defaults.borderColor = cssVar("--rule");
}
function replaceChart(key, canvas, config) {
  state.charts[key]?.destroy();
  state.charts[key] = new Chart(canvas, config);
}
const moneyTick = (v) => (Math.abs(v) >= 1000 ? money0.format(v / 1000) + "k" : money0.format(v));

function renderBreakdown(el, items) {
  const total = items.reduce((s, x) => s + x.total, 0);
  if (!items.length) { el.innerHTML = `<li class="b-empty">ไม่มีรายการ</li>`; return; }
  el.innerHTML = items.map((x) => {
    const pct = total ? (x.total / total) * 100 : 0;
    return `<li style="--c:${esc(x.color)}">
      <span class="b-name"><i></i>${esc(x.name)}</span>
      <span class="b-val">${fmt(x.total)}<span class="b-pct">${pct.toFixed(0)}%</span></span>
      <span class="b-track"><span style="width:${pct.toFixed(1)}%"></span></span>
    </li>`;
  }).join("");
}

function renderMonthView() {
  chartBase();
  const s = state.summary;
  const exp = s.by_category.expense;
  renderBreakdown($("#expense-breakdown"), exp);
  renderBreakdown($("#income-breakdown"), s.by_category.income);

  replaceChart("cat", $("#chart-categories"), {
    type: "doughnut",
    data: exp.length
      ? { labels: exp.map((x) => x.name), datasets: [{ data: exp.map((x) => x.total), backgroundColor: exp.map((x) => x.color), borderColor: cssVar("--page"), borderWidth: 2 }] }
      : { labels: ["ยังไม่มีรายจ่าย"], datasets: [{ data: [1], backgroundColor: [cssVar("--rule")], borderWidth: 0 }] },
    options: {
      maintainAspectRatio: false, cutout: "62%",
      plugins: {
        legend: { display: false },
        tooltip: { enabled: exp.length > 0, callbacks: { label: (c) => ` ${c.label}: ${fmt(c.parsed)} บาท` } },
      },
    },
  });

  const spentDays = s.daily.filter((d) => d.expense > 0).length;
  $("#daily-caption").textContent = spentDays
    ? `รายจ่ายรายวัน — เฉลี่ย ${fmt(s.totals.expense / s.daily.length)} บาทต่อวัน`
    : "รายจ่ายรายวัน";
  replaceChart("daily", $("#chart-daily"), {
    type: "bar",
    data: {
      labels: s.daily.map((d) => d.day),
      datasets: [
        { label: "รายจ่าย", data: s.daily.map((d) => d.expense), backgroundColor: cssVar("--out"), borderRadius: 2 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: moneyTick } } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: (c) => `วันที่ ${c[0].label}`, label: (c) => ` รายจ่าย ${fmt(c.parsed.y)} บาท` } },
      },
    },
  });
}

function renderYearView() {
  chartBase();
  const y = state.yearly;
  const beYear = yearFmt.format(new Date(y.year, 0, 1));
  $("#year-caption").textContent = `รายรับ–รายจ่ายรายเดือน ${beYear} (คลิกแท่งเพื่อเปิดเดือนนั้น)`;
  const t = y.totals;
  $("#year-totals").innerHTML = `
    <div><span>รายรับทั้งปี</span><span style="color:var(--in)">${fmt(t.income)}</span></div>
    <div><span>รายจ่ายทั้งปี</span><span style="color:var(--out)">${fmt(t.expense)}</span></div>
    <div><span>เหลือทั้งปี</span><span style="${t.balance < 0 ? "color:var(--out)" : ""}">${fmt(t.balance)}</span></div>`;
  renderBreakdown($("#year-top"), y.top_expense_categories);

  replaceChart("year", $("#chart-year"), {
    type: "bar",
    data: {
      labels: y.months.map((m) => monthShort.format(parseISO(m.month + "-01"))),
      datasets: [
        { label: "รายรับ", data: y.months.map((m) => m.income), backgroundColor: cssVar("--in"), borderRadius: 2 },
        { label: "รายจ่าย", data: y.months.map((m) => m.expense), backgroundColor: cssVar("--out"), borderRadius: 2 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      onClick: (_e, els) => {
        if (!els.length) return;
        goMonth(y.months[els[0].index].month);
        selectTab($("#tab-ledger"));
      },
      onHover: (e, els) => { e.native.target.style.cursor = els.length ? "pointer" : "default"; },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: moneyTick } } },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10 } },
        tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)} บาท` } },
      },
    },
  });
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (state.tab === "month") renderMonthView();
  if (state.tab === "year" && state.yearly) renderYearView();
});

/* ===================== categories dialog ===================== */
const catDialog = $("#categories-dialog");
$("#open-categories").addEventListener("click", () => { renderCategoryDialog(); catDialog.showModal(); });

function renderCategoryDialog() {
  for (const type of ["expense", "income"]) {
    $(`#cat-list-${type}`).innerHTML = state.categories.filter((c) => c.type === type).map((c) => `
      <li class="cat-row" data-id="${c.id}">
        <input type="color" value="${esc(c.color)}" aria-label="สีของ ${esc(c.name)}">
        <input type="text" value="${esc(c.name)}" maxlength="50" aria-label="ชื่อหมวดหมู่">
        <span class="count">${c.tx_count} รายการ</span>
        <button type="button" class="icon-btn" data-action="delete" aria-label="ลบหมวด ${esc(c.name)}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/></svg>
        </button>
      </li>`).join("");
  }
}

async function saveCategoryRow(row) {
  const id = Number(row.dataset.id);
  const cat = state.categories.find((c) => c.id === id);
  const name = row.querySelector('input[type="text"]').value.trim();
  const color = row.querySelector('input[type="color"]').value;
  if (!cat || (name === cat.name && color.toLowerCase() === cat.color.toLowerCase())) return;
  if (!name) { row.querySelector('input[type="text"]').value = cat.name; return; }
  try {
    await api(`/api/categories/${id}`, { method: "PUT", json: { name, color } });
    toast("บันทึกหมวดหมู่แล้ว");
    await loadCategories();
    await loadMonth();
  } catch (err) {
    toast(err.message, true);
    renderCategoryDialog();
  }
}

catDialog.addEventListener("change", (e) => {
  const row = e.target.closest(".cat-row");
  if (row) saveCategoryRow(row);
});
catDialog.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches('.cat-row input[type="text"]')) { e.preventDefault(); e.target.blur(); }
});
catDialog.addEventListener("click", async (e) => {
  const btn = e.target.closest('[data-action="delete"]');
  if (!btn) return;
  const id = Number(btn.closest(".cat-row").dataset.id);
  const cat = state.categories.find((c) => c.id === id);
  const sameType = state.categories.filter((c) => c.type === cat.type && c.id !== id);
  if (!sameType.length) { toast(`ต้องมีหมวด${TYPE_TH[cat.type]}อย่างน้อย 1 หมวด`, true); return; }
  let moveTo = null;
  if (cat.tx_count > 0) {
    moveTo = await askMoveTarget(cat, sameType);
    if (moveTo === null) return;
  } else if (!confirm(`ลบหมวด “${cat.name}” ?`)) {
    return;
  }
  try {
    await api(`/api/categories/${id}${moveTo ? `?move_to=${moveTo}` : ""}`, { method: "DELETE" });
    toast(`ลบหมวด “${cat.name}” แล้ว`);
    await loadCategories();
    await loadMonth();
  } catch (err) {
    toast(err.message, true);
  }
});

function askMoveTarget(cat, options) {
  const dlg = $("#cat-delete-dialog");
  $("#cat-del-text").textContent = `หมวด “${cat.name}” มี ${cat.tx_count} รายการ เลือกหมวดที่จะย้ายรายการเหล่านี้ไปก่อนลบ`;
  const sel = $("#cat-del-target");
  sel.innerHTML = options.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  const other = options.find((c) => c.name === "อื่นๆ");
  if (other) sel.value = other.id;
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "confirm" ? Number(sel.value) : null), { once: true });
  });
}

$("#cat-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#cat-new-name").value.trim();
  if (!name) return;
  const type = $("#cat-new-type").value;
  try {
    const created = await api("/api/categories", { method: "POST", json: { name, type, color: $("#cat-new-color").value } });
    $("#cat-new-name").value = "";
    toast(`เพิ่มหมวด “${created.name}” แล้ว`);
    await loadCategories();
    $("#cat-new-name").focus();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ===================== import / backup dialog ===================== */
const dataDialog = $("#data-dialog");
$("#open-data").addEventListener("click", () => {
  $("#import-result").textContent = "";
  $("#restore-result").textContent = "";
  dataDialog.showModal();
});

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const out = $("#import-result");
  out.textContent = "กำลังนำเข้า…";
  try {
    const r = await api("/api/import", { method: "POST", body: await file.arrayBuffer() });
    let msg = `นำเข้า ${r.imported} รายการ`;
    if (r.skipped_duplicates) msg += `, ข้าม ${r.skipped_duplicates} รายการที่มีอยู่แล้ว`;
    if (r.error_count) msg += `\nมี ${r.error_count} บรรทัดที่อ่านไม่ได้:\n` + r.errors.join("\n");
    out.textContent = msg;
    await loadCategories();
    await loadMonth();
  } catch (err) {
    out.textContent = err.message;
  }
});

$("#restore-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (!confirm(`กู้คืนจาก “${file.name}” ?\nข้อมูลปัจจุบันทั้งหมดจะถูกแทนที่`)) return;
  const out = $("#restore-result");
  out.textContent = "กำลังกู้คืน…";
  try {
    const r = await api("/api/restore", { method: "POST", body: await file.arrayBuffer() });
    out.textContent = `กู้คืนแล้ว${r.receipts_restored ? ` พร้อมรูปใบเสร็จ ${r.receipts_restored} ไฟล์` : ""} — ข้อมูลเดิมถูกเก็บไว้ที่ ${r.safety_copy} ในโฟลเดอร์ข้อมูลของแอป`;
    resetForm();
    await loadCategories();
    await loadMonth();
  } catch (err) {
    out.textContent = err.message;
  }
});

/* ===================== start ===================== */
(async function init() {
  setDate(0);
  updateFormMode();
  try {
    await loadCategories();
  } catch (e) {
    toast(e.message, true);
  }
  await loadMonth();
})();
