"use strict";
/* Ledger app: overview / transactions / year views + entry sheet. Helpers come from common.js. */

const VIEWS = { overview: "ภาพรวม", tx: "รายการทั้งหมด", year: "รายงานทั้งปี" };
const dayLong = new Intl.DateTimeFormat("th-TH", { weekday: "long", day: "numeric", month: "long" });
const dayShort = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short" });
const AMOUNT_HINT = "พิมพ์ 45+60 ได้ ระบบจะรวมให้";

/** "#2026-11", "#2026-11/tx", "#tx" or "#new" (open a new entry; links from the receipts page) */
function readHash() {
  const m = location.hash.match(/^#(\d{4}-\d{2})?\/?(overview|tx|year|new)?$/);
  const view = m?.[2] || "overview";
  return { month: m?.[1] || thisMonth(), view: view === "new" ? "overview" : view, openNew: view === "new" };
}

/* ===================== state ===================== */
const state = {
  ...readHash(),
  categories: [],
  transactions: [],
  summary: null,
  yearly: null,
  editingId: null,
  lastCategory: { income: null, expense: null },
  catType: "expense",
  filters: { type: "", category: "", q: "" },
  highlightId: null,
  charts: {},
};

function writeHash() {
  history.replaceState(null, "", `#${state.month}${state.view === "overview" ? "" : "/" + state.view}`);
}

/* ===================== loading ===================== */
async function loadCategories() {
  state.categories = await api("/api/categories");
  renderChips();
  renderCategoryFilter();
  if ($("#categories-dialog").open) renderCategoryDialog();
}

async function loadMonth() {
  const m = state.month;
  writeHash();
  $("#month-text").textContent = monthName(m);
  $("#month-input").value = m;
  $("#this-month").hidden = m === thisMonth();
  const exp = $("#export-month");
  exp.href = `/api/export.csv?month=${m}`;
  exp.setAttribute("aria-label", `ดาวน์โหลด CSV ${monthName(m)}`);
  exp.title = `ดาวน์โหลด CSV ${monthName(m)}`;

  const content = $("#main");
  if (state.summary) content.classList.add("loading");
  try {
    const [summary, txs] = await Promise.all([
      api(`/api/summary?month=${m}`),
      api(`/api/transactions?month=${m}`),
    ]);
    if (m !== state.month) return; // user moved on
    state.summary = summary;
    state.transactions = txs;
    $("#load-error").hidden = true;
    renderTotals();
    renderRecent();
    renderTxList();
    renderNoteSuggestions();
    if (state.view === "overview") renderOverviewCharts();
    if (state.view === "year") await loadYear();
  } catch (e) {
    if (m !== state.month) return;
    $("#load-error-text").textContent = `โหลดข้อมูลไม่สำเร็จ — ${e.message}`;
    $("#load-error").hidden = false;
  } finally {
    if (m === state.month) content.classList.remove("loading");
  }
}

async function loadYear() {
  const year = Number(state.month.slice(0, 4));
  state.yearly = await api(`/api/yearly?year=${year}`);
  if (state.view === "year") renderYearView();
}

$("#retry").addEventListener("click", () => loadMonth());

/* ===================== views ===================== */
function setView(view, { focus = false } = {}) {
  if (!VIEWS[view]) view = "overview";
  state.view = view;
  for (const v of Object.keys(VIEWS)) $(`#view-${v}`).hidden = v !== view;
  $$(".nav-item[data-view], .tab-item[data-view]").forEach((b) => {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("#view-title").textContent = VIEWS[view];
  document.title = view === "overview" ? "สมุดรายรับรายจ่าย" : `${VIEWS[view]} — สมุดรายรับรายจ่าย`;
  writeHash();
  window.scrollTo({ top: 0 });
  if (view === "overview" && state.summary) renderOverviewCharts();
  if (view === "year") loadYear().catch((e) => toast(e.message, true));
  if (focus) $("#view-title").focus({ preventScroll: true });
}

/* ===================== overview: KPIs ===================== */
function compareNote(now, prev) {
  if (!prev) return "";
  const pct = Math.round(((now - prev) / prev) * 100);
  if (pct === 0) return "เท่ากับเดือนก่อน";
  return `${pct > 0 ? "มากกว่า" : "น้อยกว่า"}เดือนก่อน ${Math.abs(pct)}%`;
}
const setText = (sel, text) => { $(sel).textContent = text || " "; };

function renderTotals() {
  const { totals, previous, cumulative_balance } = state.summary;
  setText("#t-income", baht(totals.income));
  setText("#t-expense", baht(totals.expense));
  const bal = $("#t-balance");
  bal.textContent = baht(totals.balance);
  bal.classList.toggle("neg", totals.balance < 0);
  const cum = $("#t-cumulative");
  cum.textContent = baht(cumulative_balance);
  cum.classList.toggle("neg", cumulative_balance < 0);

  setText("#t-income-note", compareNote(totals.income, previous.income));
  setText("#t-expense-note", compareNote(totals.expense, previous.expense));
  let balNote = "";
  if (totals.income > 0 && totals.balance >= 0) balNote = `เก็บได้ ${Math.round((totals.balance / totals.income) * 100)}% ของรายรับ`;
  else if (totals.balance < 0) balNote = "ใช้จ่ายเกินรายรับ";
  setText("#t-balance-note", balNote);

  // how much of this month's income has been spent
  const { income, expense } = totals;
  let pct = 0;
  let label = "ยังไม่มีรายการในเดือนนี้";
  if (income > 0) {
    pct = Math.round((expense / income) * 100);
    label = pct > 100 ? `ใช้จ่ายเกินรายรับ ฿${fmt(expense - income)}` : `ใช้ไป ฿${fmt(expense)} จาก ฿${fmt(income)} (${pct}%)`;
  } else if (expense > 0) {
    pct = 101;
    label = "ยังไม่มีรายรับในเดือนนี้";
  }
  const meter = $("#spend-meter");
  meter.querySelector(".meter-fill").style.width = `${Math.min(pct, 100)}%`;
  meter.classList.toggle("warn", pct >= 80 && pct <= 100);
  meter.classList.toggle("over", pct > 100);
  meter.setAttribute("aria-valuenow", String(Math.min(pct, 100)));
  meter.setAttribute("aria-valuetext", label);
  $("#spend-label").textContent = label;
}

/* ===================== transactions ===================== */
function txRowHTML(t, withDate = false) {
  const isIn = t.type === "income";
  const d = parseISO(t.date);
  const meta = [];
  if (withDate) meta.push(`<span>${esc(dayShort.format(d))}</span>`);
  if (t.note) meta.push(`<span>${esc(t.category_name)}</span>`);
  else if (!withDate) meta.push(`<span>${TYPE_TH[t.type]}</span>`);
  if (t.receipt_id) meta.push(`<span class="has-receipt">${icon("clip")}ใบเสร็จ</span>`);
  const cls = ["tx-row"];
  if (t.id === state.editingId) cls.push("selected");
  if (t.id === state.highlightId) cls.push("new");
  const label = `${d.getDate()} ${monthShort.format(d)} ${t.category_name} ${TYPE_TH[t.type]} ${fmt(t.amount)} บาท ${t.note}`;
  return `<li><button type="button" class="${cls.join(" ")}" data-id="${t.id}" style="--c:${esc(t.category_color)}" aria-label="${esc(label)} — แก้ไข">
    <span class="tx-ico">${icon(isIn ? "in" : "out")}</span>
    <span class="tx-main">
      <span class="tx-title">${esc(t.note || t.category_name)}</span>
      <span class="tx-meta">${meta.join('<i class="sep"></i>')}</span>
    </span>
    <span class="tx-amt num${isIn ? " in" : ""}">${isIn ? "+" : "−"}฿${fmt(t.amount)}</span>
  </button></li>`;
}

function renderRecent() {
  const recent = [...state.transactions]
    .sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1))
    .slice(0, 5);
  $("#recent-list").innerHTML = recent.length
    ? recent.map((t) => txRowHTML(t, true)).join("")
    : `<li class="empty-line">ยังไม่มีรายการใน${esc(monthName(state.month))}</li>`;
}

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

const sumItem = (label, value, cls = "") => `<dl class="sum-item"><dt>${label}</dt><dd class="num ${cls}">${value}</dd></dl>`;

function renderTxList() {
  const filtered = filtersActive();
  const rows = filteredTransactions(); // oldest first, so the running balance adds up
  const { totals, cumulative_balance } = state.summary;

  const opening = cumulative_balance - totals.balance; // balance brought forward
  let running = opening;
  let sumIn = 0, sumOut = 0;
  const groups = [];
  for (const t of rows) {
    const isIn = t.type === "income";
    const delta = isIn ? t.amount : -t.amount;
    running += delta;
    if (isIn) sumIn += t.amount; else sumOut += t.amount;
    let g = groups[groups.length - 1];
    if (!g || g.date !== t.date) { g = { date: t.date, rows: [], net: 0 }; groups.push(g); }
    g.rows.push(t);
    g.net += delta;
    g.end = running;
  }

  $("#tx-summary").innerHTML = filtered
    ? sumItem("แสดง", `${rows.length} รายการ`) + sumItem("รายรับ", baht(sumIn, { sign: true }), "in")
      + sumItem("รายจ่าย", baht(-sumOut)) + sumItem("สุทธิ", baht(sumIn - sumOut, { sign: true }), sumIn - sumOut < 0 ? "neg" : "")
    : sumItem("ยอดยกมา", baht(opening), opening < 0 ? "neg" : "") + sumItem("รายรับ", baht(sumIn, { sign: true }), "in")
      + sumItem("รายจ่าย", baht(-sumOut)) + sumItem("คงเหลือ", baht(running), running < 0 ? "neg" : "");

  const groupsEl = $("#tx-groups");
  const empty = $("#tx-empty");
  if (!rows.length) {
    groupsEl.innerHTML = "";
    empty.hidden = false;
    $("#tx-empty-text").textContent = filtered
      ? "ไม่พบรายการที่ตรงกับตัวกรอง ลองล้างช่องค้นหาหรือเลือก “ทุกหมวดหมู่”"
      : `ยังไม่มีรายการใน${monthName(state.month)} — เริ่มจดรายการแรกได้เลย`;
    $("#tx-empty-cta").hidden = filtered;
    $("#tx-clear-filters").hidden = !filtered;
    return;
  }
  empty.hidden = true;

  const today = isoDate(new Date());
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yesterday = isoDate(y);
  groupsEl.innerHTML = groups.reverse().map((g) => {
    const rel = g.date === today ? "วันนี้ · " : g.date === yesterday ? "เมื่อวาน · " : "";
    const right = filtered
      ? `<span class="day-bal num">${baht(g.net, { sign: true })}</span>`
      : `<span class="day-bal">คงเหลือ <b class="num${g.end < 0 ? " neg" : ""}">${baht(g.end)}</b></span>`;
    return `<section class="tx-group">
      <header class="tx-group-head"><h3>${rel}${esc(dayLong.format(parseISO(g.date)))}</h3>${right}</header>
      <ul class="tx-list">${[...g.rows].reverse().map((t) => txRowHTML(t)).join("")}</ul>
    </section>`;
  }).join("");
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

function clearFilters() {
  state.filters = { type: "", category: "", q: "" };
  $('input[name="f-type"][value=""]').checked = true;
  $("#f-category").value = "";
  $("#f-q").value = "";
  renderTxList();
}

$("#main").addEventListener("click", (e) => {
  const row = e.target.closest(".tx-row");
  if (row) openEntry(Number(row.dataset.id));
});
$$('input[name="f-type"]').forEach((r) => r.addEventListener("change", () => { state.filters.type = r.value; renderTxList(); }));
$("#f-category").addEventListener("change", (e) => { state.filters.category = e.target.value; renderTxList(); });
$("#f-q").addEventListener("input", (e) => { state.filters.q = e.target.value; renderTxList(); });
$("#tx-clear-filters").addEventListener("click", clearFilters);

/* ===================== entry sheet ===================== */
const entryDialog = $("#entry-dialog");
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
    box.innerHTML = `<span class="field-hint">ยังไม่มีหมวด${TYPE_TH[type]} — เพิ่มได้ที่เมนู “หมวดหมู่”</span>`;
    return;
  }
  box.innerHTML = cats.map((c) => `<button type="button" class="chip" role="radio" style="--c:${esc(c.color)}"
      data-id="${c.id}" aria-checked="${c.id === selected}" tabindex="${c.id === selected ? 0 : -1}"><i></i>${esc(c.name)}</button>`).join("");
}

function updateFormMode() {
  const type = currentType();
  form.dataset.type = type;
  $("#submit-btn").textContent = state.editingId ? "บันทึกการแก้ไข" : `บันทึก${TYPE_TH[type]}`;
  $("#save-again").hidden = Boolean(state.editingId);
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

function resetAmountHint() {
  $("#amount-hint").textContent = AMOUNT_HINT;
  form.elements.amount.classList.remove("invalid");
}

function resetForm({ keepDate = true } = {}) {
  state.editingId = null;
  $("#entry-title").textContent = "จดรายการ";
  $("#delete-btn").hidden = true;
  $("#edit-receipt-link").hidden = true;
  form.elements.amount.value = "";
  form.elements.note.value = "";
  if (!keepDate || !form.elements.date.value) setDate(0);
  resetAmountHint();
  showFormError("");
  updateFormMode();
  $$(".tx-row.selected").forEach((r) => r.classList.remove("selected"));
}

function startEdit(id) {
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return false;
  state.editingId = id;
  form.elements.type.value = t.type;
  state.lastCategory[t.type] = t.category_id;
  renderChips();
  form.elements.amount.value = t.amount.toFixed(2);
  form.elements.date.value = t.date;
  form.elements.note.value = t.note;
  $("#entry-title").textContent = "แก้ไขรายการ";
  $("#delete-btn").hidden = false;
  const link = $("#edit-receipt-link");
  link.hidden = !t.receipt_id;
  if (t.receipt_id) link.href = `/api/receipts/${t.receipt_id}/file`;
  resetAmountHint();
  showFormError("");
  updateFormMode();
  $$(".tx-row").forEach((r) => r.classList.toggle("selected", Number(r.dataset.id) === id));
  return true;
}

function openEntry(id = null) {
  if (id === null) resetForm();
  else if (!startEdit(id)) return;
  if (!entryDialog.open) entryDialog.showModal();
  form.elements.amount.focus();
  if (id !== null) form.elements.amount.select();
}

entryDialog.addEventListener("close", () => resetForm());
$("#entry-close").addEventListener("click", () => entryDialog.close());

form.addEventListener("change", (e) => {
  if (e.target.name === "type") { renderChips(); updateFormMode(); }
});

form.elements.amount.addEventListener("input", () => {
  const raw = form.elements.amount.value;
  const v = evalAmount(raw);
  const hint = $("#amount-hint");
  const isFormula = /\d[+\-]\d/.test(raw.replace(/[,\s]/g, ""));
  form.elements.amount.classList.toggle("invalid", raw.trim() !== "" && Number.isNaN(v));
  if (isFormula) hint.textContent = Number.isNaN(v) ? "สูตรไม่ถูกต้อง" : `รวม = ${fmt(v)} บาท`;
  else hint.textContent = AMOUNT_HINT;
});

$("#category-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  state.lastCategory[currentType()] = Number(chip.dataset.id);
  $$("#category-chips .chip").forEach((c) => {
    const on = c === chip;
    c.setAttribute("aria-checked", on);
    c.tabIndex = on ? 0 : -1;
  });
});
$("#category-chips").addEventListener("keydown", (e) => {
  if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
  const chips = $$("#category-chips .chip");
  const i = chips.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = chips[(i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) + chips.length) % chips.length];
  next.focus();
  next.click();
});

$$("[data-days-ago]").forEach((b) => b.addEventListener("click", () => setDate(Number(b.dataset.daysAgo))));

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const editing = state.editingId;
  const again = !editing && e.submitter?.value === "again";
  const type = currentType();
  const amount = evalAmount(form.elements.amount.value);
  const category_id = state.lastCategory[type];
  const date = form.elements.date.value;
  if (!(amount > 0)) {
    showFormError("ใส่จำนวนเงินที่มากกว่า 0");
    form.elements.amount.classList.add("invalid");
    form.elements.amount.focus();
    return;
  }
  if (!category_id) { showFormError("เลือกหมวดหมู่ก่อนบันทึก"); return; }
  if (!date) { showFormError("เลือกวันที่"); form.elements.date.focus(); return; }
  showFormError("");

  const payload = { type, amount: amount.toFixed(2), category_id, date, note: form.elements.note.value };
  const buttons = $$('#tx-form [type="submit"]');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const saved = editing
      ? await api(`/api/transactions/${editing}`, { method: "PUT", json: payload })
      : await api("/api/transactions", { method: "POST", json: payload });
    const otherMonth = saved.date.slice(0, 7) !== state.month;
    toast((editing ? "บันทึกการแก้ไขแล้ว" : `บันทึก${TYPE_TH[type]} ฿${fmt(amount)} แล้ว`)
      + (otherMonth ? ` (อยู่ใน${monthName(saved.date.slice(0, 7))})` : ""));
    state.highlightId = saved.id;
    if (again) {
      resetForm();
      form.elements.amount.focus();
    } else {
      entryDialog.close();
    }
    await loadMonth();
  } catch (err) {
    showFormError(err.message);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
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
    entryDialog.close();
    await loadMonth();
  } catch (err) {
    toast(err.message, true);
  }
});

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

window.addEventListener("hashchange", () => {
  const h = readHash();
  if (h.view !== state.view) setView(h.view);
  goMonth(h.month);
  if (h.openNew) { writeHash(); openEntry(); }
});

/* ===================== charts ===================== */
function replaceChart(key, canvas, config) {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 12;
  Chart.defaults.color = cssVar("--color-text-subtle");
  Chart.defaults.borderColor = cssVar("--color-border");
  state.charts[key]?.destroy();
  state.charts[key] = new Chart(canvas, config);
}
const moneyTick = (v) => (Math.abs(v) >= 1000 ? money0.format(v / 1000) + "k" : money0.format(v));
const tooltipStyle = () => ({
  backgroundColor: cssVar("--color-inverse"), titleColor: cssVar("--color-inverse-text"), bodyColor: cssVar("--color-inverse-text"),
  padding: 10, cornerRadius: 8, boxPadding: 4,
});
const barScales = () => ({
  x: { grid: { display: false }, border: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 8 } },
  y: { beginAtZero: true, border: { display: false }, grid: { color: cssVar("--color-border") }, ticks: { callback: moneyTick, maxTicksLimit: 5 } },
});

function renderBreakdown(el, items) {
  const total = items.reduce((s, x) => s + x.total, 0);
  if (!items.length) { el.innerHTML = `<li class="b-empty">ไม่มีรายการ</li>`; return; }
  el.innerHTML = items.map((x) => {
    const pct = total ? (x.total / total) * 100 : 0;
    return `<li style="--c:${esc(x.color)}">
      <span class="b-name"><i></i><span>${esc(x.name)}</span></span>
      <span class="b-val num">${baht(x.total)}<span class="b-pct">${pct.toFixed(0)}%</span></span>
      <span class="b-track"><span style="width:${pct.toFixed(1)}%"></span></span>
    </li>`;
  }).join("");
}

function renderCategoryCard() {
  const items = state.summary.by_category[state.catType];
  renderBreakdown($("#cat-breakdown"), items);
  const total = items.reduce((s, x) => s + x.total, 0);
  $("#donut-label").textContent = `${TYPE_TH[state.catType]}รวม`;
  $("#donut-total").textContent = baht(total);
  replaceChart("cat", $("#chart-categories"), {
    type: "doughnut",
    data: items.length
      ? { labels: items.map((x) => x.name), datasets: [{ data: items.map((x) => x.total), backgroundColor: items.map((x) => x.color), borderColor: cssVar("--color-surface"), borderWidth: 3, hoverOffset: 4 }] }
      : { labels: ["ยังไม่มีรายการ"], datasets: [{ data: [1], backgroundColor: [cssVar("--color-surface-3")], borderWidth: 0 }] },
    options: {
      maintainAspectRatio: false, cutout: "74%",
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipStyle(), enabled: items.length > 0, callbacks: { label: (c) => ` ${c.label}: ${fmt(c.parsed)} บาท` } },
      },
    },
  });
}

function renderDailyChart() {
  const s = state.summary;
  const spentDays = s.daily.filter((d) => d.expense > 0).length;
  $("#daily-meta").textContent = spentDays ? `เฉลี่ย ฿${fmt(s.totals.expense / s.daily.length)} ต่อวัน` : "";
  replaceChart("daily", $("#chart-daily"), {
    type: "bar",
    data: {
      labels: s.daily.map((d) => d.day),
      datasets: [{ label: "รายจ่าย", data: s.daily.map((d) => d.expense), backgroundColor: cssVar("--color-primary"), borderRadius: 4, maxBarThickness: 18 }],
    },
    options: {
      maintainAspectRatio: false,
      scales: barScales(),
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipStyle(), callbacks: { title: (c) => `วันที่ ${c[0].label}`, label: (c) => ` รายจ่าย ${fmt(c.parsed.y)} บาท` } },
      },
    },
  });
}

function renderOverviewCharts() {
  renderCategoryCard();
  renderDailyChart();
}

$$('input[name="cat-type"]').forEach((r) => r.addEventListener("change", () => {
  state.catType = r.value;
  if (state.summary) renderCategoryCard();
}));

/* ===================== year ===================== */
const statCard = (ico, icoCls, label, value, valueCls = "") => `<article class="card stat">
    <span class="stat-icon ${icoCls}">${icon(ico)}</span>
    <p class="stat-label">${label}</p>
    <p class="stat-value num ${valueCls}">${value}</p>
  </article>`;

function renderYearView() {
  const y = state.yearly;
  const beYear = yearFmt.format(new Date(y.year, 0, 1));
  $("#view-title").textContent = `รายงานปี ${beYear}`;
  $("#year-caption").textContent = `รายรับ–รายจ่ายรายเดือน ${beYear}`;
  const t = y.totals;
  $("#year-totals").innerHTML = statCard("in", "in", "รายรับทั้งปี", baht(t.income), "in")
    + statCard("out", "out", "รายจ่ายทั้งปี", baht(t.expense))
    + statCard("wallet", "bal", "เหลือทั้งปี", baht(t.balance), t.balance < 0 ? "neg" : "");
  renderBreakdown($("#year-top"), y.top_expense_categories);

  replaceChart("year", $("#chart-year"), {
    type: "bar",
    data: {
      labels: y.months.map((m) => monthShort.format(parseISO(m.month + "-01"))),
      datasets: [
        { label: "รายรับ", data: y.months.map((m) => m.income), backgroundColor: cssVar("--color-income"), borderRadius: 4, maxBarThickness: 22 },
        { label: "รายจ่าย", data: y.months.map((m) => m.expense), backgroundColor: cssVar("--color-expense"), borderRadius: 4, maxBarThickness: 22 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      onClick: (_e, els) => {
        if (!els.length) return;
        goMonth(y.months[els[0].index].month);
        setView("overview");
      },
      onHover: (e, els) => { e.native.target.style.cursor = els.length ? "pointer" : "default"; },
      scales: barScales(),
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: "rectRounded" } },
        tooltip: { ...tooltipStyle(), callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)} บาท` } },
      },
    },
  });
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (state.view === "overview" && state.summary) renderOverviewCharts();
  if (state.view === "year" && state.yearly) renderYearView();
});

/* ===================== shell: nav, menu, dialogs ===================== */
const moreBtn = $("#more-btn");
const moreMenu = $("#more-menu");
function closeMenu() {
  moreMenu.hidden = true;
  moreBtn.setAttribute("aria-expanded", "false");
}
moreBtn.addEventListener("click", () => {
  const open = moreMenu.hidden;
  moreMenu.hidden = !open;
  moreBtn.setAttribute("aria-expanded", String(open));
  if (open) moreMenu.querySelector("button").focus();
});
moreMenu.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeMenu(); moreBtn.focus(); }
});

const catDialog = $("#categories-dialog");
const dataDialog = $("#data-dialog");
function openPanel(name) {
  if (name === "categories") {
    renderCategoryDialog();
    catDialog.showModal();
  } else if (name === "data") {
    $("#import-result").textContent = "";
    $("#restore-result").textContent = "";
    dataDialog.showModal();
  }
}

document.addEventListener("click", (e) => {
  if (!moreMenu.hidden && !e.target.closest(".menu-wrap")) closeMenu();
  const viewBtn = e.target.closest("[data-view]");
  if (viewBtn) { setView(viewBtn.dataset.view, { focus: true }); return; }
  if (e.target.closest("[data-open-entry]")) { openEntry(); return; }
  const panel = e.target.closest("[data-open]");
  if (panel) { closeMenu(); openPanel(panel.dataset.open); }
});

// tap on the dimmed backdrop closes a sheet (only when the press also started there)
$$("dialog.sheet").forEach((d) => {
  let downOnBackdrop = false;
  d.addEventListener("pointerdown", (e) => { downOnBackdrop = e.target === d; });
  d.addEventListener("click", (e) => { if (downOnBackdrop && e.target === d) d.close(); downOnBackdrop = false; });
});

// iOS Safari leaves position:fixed elements on the layout viewport when the keyboard opens,
// so a bottom sheet ends up behind the keyboard, below the visible area. Expose how much of the
// layout viewport is hidden under the keyboard (and the visible height) so the CSS can lift the
// sheet back into view. Stays 0 on desktop and on Android, where the keyboard resizes the page.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  const syncViewport = () => {
    root.setProperty("--kb-inset", `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
    root.setProperty("--vv-height", `${Math.round(vv.height)}px`);
  };
  vv.addEventListener("resize", syncViewport);
  vv.addEventListener("scroll", syncViewport);
  syncViewport();
}

// "N" opens a new entry from anywhere (KeyN also matches the Thai layout)
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  if ($("dialog[open]") || e.target.closest?.("input, select, textarea, [contenteditable]")) return;
  if (e.code === "KeyN" || e.key === "+") { e.preventDefault(); openEntry(); }
});

const topbar = $(".topbar");
window.addEventListener("scroll", () => topbar.classList.toggle("scrolled", window.scrollY > 4), { passive: true });

/* ===================== categories dialog ===================== */
function renderCategoryDialog() {
  for (const type of ["expense", "income"]) {
    $(`#cat-list-${type}`).innerHTML = state.categories.filter((c) => c.type === type).map((c) => `
      <li class="cat-row" data-id="${c.id}">
        <input type="color" value="${esc(c.color)}" aria-label="สีของ ${esc(c.name)}">
        <input type="text" value="${esc(c.name)}" maxlength="50" aria-label="ชื่อหมวดหมู่">
        <span class="count">${c.tx_count} รายการ</span>
        <button type="button" class="icon-btn" data-action="delete" aria-label="ลบหมวด ${esc(c.name)}">${icon("trash")}</button>
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
  setView(state.view);
  try {
    await loadCategories();
  } catch (e) {
    toast(e.message, true);
  }
  await loadMonth();
  if (state.openNew) openEntry();
})();
