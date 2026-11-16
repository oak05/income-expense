/**
 * สมุดรายรับรายจ่าย — Apps Script backend.
 *
 *   Google Sheet  = database (one tab per table)
 *   Google Drive  = receipt files + OCR (Drive converts an image/PDF to text)
 *
 * The Vercel app is the only caller: it POSTs {secret, action, params} to this web app.
 * First-time use: run setup() once from the editor, then deploy as a web app (see cloud/README.md).
 */

const BACKEND_VERSION = '2.0.0';
const SCHEMA_VERSION = 1;

const TABLES = {
  categories: ['id', 'name', 'type', 'color', 'sort_order'],
  transactions: ['id', 'type', 'amount', 'category_id', 'date', 'note', 'receipt_id', 'created_at', 'updated_at'],
  receipts: ['id', 'status', 'merchant', 'amount', 'date', 'category_id', 'included', 'transaction_id', 'file_id',
    'mime', 'original_name', 'text_source', 'confidence', 'candidates', 'flags', 'error', 'ocr_text', 'created_at'],
  meta: ['key', 'value'],
};
const INT_COLUMNS = { id: 1, category_id: 1, sort_order: 1, transaction_id: 1, receipt_id: 1 };
const NUMBER_COLUMNS = { amount: 1 };
const BOOL_COLUMNS = { included: 1 };
// every other column is text and is stored in cells formatted as plain text, so Sheets never
// turns "2026-11-10" into a date, "007" into 7 or "=A1" into a formula

const DEFAULT_CATEGORIES = [
  ['อาหารและเครื่องดื่ม', 'expense', '#E07A3F'], ['เดินทาง', 'expense', '#3A86C8'],
  ['ที่พัก / ค่าเช่า', 'expense', '#7B61C9'], ['ค่าน้ำ ค่าไฟ ค่าเน็ต', 'expense', '#D4A72C'],
  ['ช้อปปิ้ง', 'expense', '#D2588E'], ['สุขภาพ', 'expense', '#2E9E83'], ['บันเทิง', 'expense', '#C8463D'],
  ['การศึกษา', 'expense', '#4F5BD5'], ['อื่นๆ', 'expense', '#7A8290'],
  ['เงินเดือน', 'income', '#2F8F5B'], ['งานฟรีแลนซ์', 'income', '#1F8A8A'], ['โบนัส', 'income', '#7FA33A'],
  ['ขายของ', 'income', '#3E9E3E'], ['ดอกเบี้ย / เงินปันผล', 'income', '#4C7A5A'], ['อื่นๆ', 'income', '#7A8290'],
];
const NEW_CATEGORY_COLORS = ['#5B8DB8', '#B86F5B', '#6FA06B', '#9A6FB0', '#C29A3D', '#4E9A9A', '#B05B7A'];
const TYPE_TH = { income: 'รายรับ', expense: 'รายจ่าย' };

const MAX_SATANG = 999999999999;
const MAX_RECEIPT_BYTES = 2.5 * 1024 * 1024; // Drive OCR works best under ~2 MB; the browser shrinks photos first
const RECEIPT_MIMES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
const MAX_IMPORT_ROWS = 5000;
const LOGIN_MAX_FAILS = 8;
const LOGIN_BLOCK_SECONDS = 15 * 60;

/* ------------------------------------------------------------------ errors */

function ApiError(status, message) {
  this.status = status;
  this.message = message;
}

function fail_(status, message) {
  throw new ApiError(status, message);
}

/* ------------------------------------------------------------------ small helpers */

function props_() {
  return PropertiesService.getScriptProperties();
}

function now_() {
  return new Date();
}

function tz_() {
  // fixed instead of the project's time zone setting, so "today" is right even if that setting was never changed;
  // set a TIME_ZONE script property (e.g. Asia/Tokyo) to use another one
  return props_().getProperty('TIME_ZONE') || 'Asia/Bangkok';
}

function today_() {
  return Utilities.formatDate(now_(), tz_(), 'yyyy-MM-dd');
}

function stamp_() {
  return Utilities.formatDate(now_(), tz_(), 'yyyy-MM-dd HH:mm:ss');
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function baht_(satang) {
  return Math.round(satang || 0) / 100;
}

function satangOf_(cell) {
  return cell === null || cell === '' ? null : Math.round(Number(cell) * 100);
}

/** "120.505" -> 12051 (half-up, done on the digits so there is no floating-point drift). */
function toSatang_(value) {
  const m = /^(\d{1,10})(?:\.(\d{1,6}))?$/.exec(String(value === null || value === undefined ? '' : value).trim());
  if (!m) return NaN;
  const frac = ((m[2] || '') + '000').slice(0, 3);
  return Number(m[1]) * 100 + Number(frac.slice(0, 2)) + (Number(frac.charAt(2)) >= 5 ? 1 : 0);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (e) {
    fail_(503, 'ระบบกำลังบันทึกรายการอื่นอยู่ ลองใหม่อีกครั้ง');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ validation */

function vType_(v) {
  if (v !== 'income' && v !== 'expense') fail_(422, 'ข้อมูลไม่ถูกต้อง: ประเภท');
  return v;
}

function vAmount_(v) {
  const s = toSatang_(v);
  if (!(s > 0) || s > MAX_SATANG) fail_(422, 'ข้อมูลไม่ถูกต้อง: จำนวนเงิน');
  return s;
}

function isIsoDate_(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return +m[1] >= 1000 && d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function vDate_(v) {
  if (!isIsoDate_(v)) fail_(422, 'ข้อมูลไม่ถูกต้อง: วันที่');
  return String(v);
}

function vMonth_(v) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v))) fail_(400, 'รูปแบบเดือนต้องเป็น YYYY-MM');
  return String(v);
}

function vId_(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) fail_(422, 'ข้อมูลไม่ถูกต้อง: ' + (label || 'รหัส'));
  return n;
}

function vText_(v, max, label) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (s.length > max) fail_(422, 'ข้อมูลไม่ถูกต้อง: ' + label + ' ยาวเกินไป');
  return s;
}

function vName_(v) {
  const s = vText_(v, 50, 'ชื่อหมวดหมู่');
  if (!s) fail_(422, 'ข้อมูลไม่ถูกต้อง: ชื่อหมวดหมู่');
  return s;
}

function vColor_(v) {
  if (!/^#[0-9A-Fa-f]{6}$/.test(String(v))) fail_(422, 'ข้อมูลไม่ถูกต้อง: สี');
  return String(v);
}

function shiftMonth_(month, delta) {
  const idx = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  const m = idx % 12 + 1;
  return Math.floor(idx / 12) + '-' + (m < 10 ? '0' : '') + m;
}

/* ------------------------------------------------------------------ sheet storage */

let SS_ = null;

function spreadsheet_() {
  if (SS_) return SS_;
  const id = props_().getProperty('SHEET_ID');
  SS_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!SS_) fail_(500, 'ยังไม่ได้ตั้งค่าหลังบ้าน: เปิดตัวแก้ไข Apps Script แล้วรันฟังก์ชัน setup หนึ่งครั้ง');
  return SS_;
}

function fromCell_(col, v) {
  if (INT_COLUMNS[col]) return v === '' || v === null ? null : Number(v);
  if (NUMBER_COLUMNS[col]) return v === '' || v === null ? null : Number(v);
  if (BOOL_COLUMNS[col]) return v === true || v === 1 || String(v).toLowerCase() === 'true';
  if (isDate_(v)) { // someone reformatted the column in the Sheet; read it back the way we store it
    return Utilities.formatDate(v, tz_(), col === 'date' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm:ss');
  }
  return v === null ? '' : String(v);
}

function toCell_(v) {
  if (v === null || v === undefined) return '';
  // a leading apostrophe marks the cell as text, so "=1+1" or "+66..." can never run as a formula
  if (typeof v === 'string' && /^[=+\-@']/.test(v)) return "'" + v;
  return v;
}

function table_(name) {
  const cols = TABLES[name];
  const sheet = spreadsheet_().getSheetByName(name);
  if (!sheet) fail_(500, 'ไม่พบแผ่นงาน "' + name + '" ใน Google Sheet — รันฟังก์ชัน setup อีกครั้ง');
  const rowOf = function (obj) { return cols.map(function (c) { return toCell_(obj[c]); }); };
  return {
    sheet: sheet,
    all: function () {
      const last = sheet.getLastRow();
      if (last < 2) return [];
      const values = sheet.getRange(2, 1, last - 1, cols.length).getValues();
      const out = [];
      for (let i = 0; i < values.length; i++) {
        if (values[i][0] === '' || values[i][0] === null) continue; // an emptied row
        const obj = { _row: i + 2 };
        for (let j = 0; j < cols.length; j++) obj[cols[j]] = fromCell_(cols[j], values[i][j]);
        out.push(obj);
      }
      return out;
    },
    append: function (objs) {
      if (!objs.length) return;
      const start = sheet.getLastRow() + 1;
      const missing = start + objs.length - 1 - sheet.getMaxRows();
      if (missing > 0) sheet.insertRowsAfter(sheet.getMaxRows(), missing);
      sheet.getRange(start, 1, objs.length, cols.length).setValues(objs.map(rowOf));
    },
    update: function (obj) {
      sheet.getRange(obj._row, 1, 1, cols.length).setValues([rowOf(obj)]);
    },
    remove: function (objs) {
      objs.map(function (o) { return o._row; }).sort(function (a, b) { return b - a; })
        .forEach(function (r) { sheet.deleteRow(r); });
    },
  };
}

function nextIds_(tableName, count) {
  const meta = table_('meta');
  const key = 'next_' + tableName;
  const rows = meta.all();
  let row = null;
  for (let i = 0; i < rows.length; i++) if (rows[i].key === key) row = rows[i];
  let next = row ? Number(row.value) : 0;
  if (!(next >= 1)) { // first use: continue after whatever is already in the table
    next = 1;
    table_(tableName).all().forEach(function (r) { if (r.id >= next) next = r.id + 1; });
  }
  const ids = [];
  for (let i = 0; i < count; i++) ids.push(next + i);
  if (row) {
    row.value = String(next + count);
    meta.update(row);
  } else {
    meta.append([{ key: key, value: String(next + count) }]);
  }
  return ids;
}

function byId_(rows) {
  const map = {};
  rows.forEach(function (r) { map[r.id] = r; });
  return map;
}

/* ------------------------------------------------------------------ categories */

function a_categoriesList_() {
  const counts = {};
  table_('transactions').all().forEach(function (t) { counts[t.category_id] = (counts[t.category_id] || 0) + 1; });
  return table_('categories').all()
    .sort(function (a, b) { return a.sort_order - b.sort_order || a.id - b.id; })
    .map(function (c) {
      return { id: c.id, name: c.name, type: c.type, color: c.color, sort_order: c.sort_order, tx_count: counts[c.id] || 0 };
    });
}

function a_categoriesCreate_(p) {
  const name = vName_(p.name), type = vType_(p.type), color = vColor_(p.color || '#7A8290');
  const cats = table_('categories');
  const rows = cats.all();
  if (rows.some(function (c) { return c.name === name && c.type === type; })) fail_(409, 'มีหมวดหมู่ "' + name + '" อยู่แล้ว');
  const order = rows.reduce(function (m, c) { return Math.max(m, c.sort_order || 0); }, 0) + 1;
  const row = { id: nextIds_('categories', 1)[0], name: name, type: type, color: color, sort_order: order };
  cats.append([row]);
  return { id: row.id, name: name, type: type, color: color, sort_order: order, tx_count: 0 };
}

function a_categoriesUpdate_(p) {
  const id = vId_(p.id), name = vName_(p.name), color = vColor_(p.color);
  const cats = table_('categories');
  const rows = cats.all();
  const row = byId_(rows)[id];
  if (!row) fail_(404, 'ไม่พบหมวดหมู่');
  if (rows.some(function (c) { return c.id !== id && c.name === name && c.type === row.type; })) {
    fail_(409, 'มีหมวดหมู่ "' + name + '" อยู่แล้ว');
  }
  row.name = name;
  row.color = color;
  cats.update(row);
  return { id: id, name: name, type: row.type, color: color, sort_order: row.sort_order };
}

function a_categoriesDelete_(p) {
  const id = vId_(p.id);
  const cats = table_('categories');
  const rows = cats.all();
  const cat = byId_(rows)[id];
  if (!cat) fail_(404, 'ไม่พบหมวดหมู่');
  if (rows.filter(function (c) { return c.type === cat.type; }).length <= 1) {
    fail_(400, 'ต้องมีหมวดหมู่' + TYPE_TH[cat.type] + 'อย่างน้อย 1 หมวด');
  }
  const txs = table_('transactions');
  const used = txs.all().filter(function (t) { return t.category_id === id; });
  let moved = 0;
  if (used.length) {
    if (p.move_to === null || p.move_to === undefined || p.move_to === '') {
      fail_(409, 'หมวดหมู่นี้มี ' + used.length + ' รายการ — เลือกหมวดที่จะย้ายรายการไปก่อนลบ');
    }
    const target = byId_(rows)[Number(p.move_to)];
    if (!target || target.id === id || target.type !== cat.type) fail_(400, 'หมวดหมู่ปลายทางไม่ถูกต้อง');
    const when = stamp_();
    used.forEach(function (t) {
      t.category_id = target.id;
      t.updated_at = when;
      txs.update(t);
    });
    moved = used.length;
  }
  const receipts = table_('receipts');
  receipts.all().filter(function (r) { return r.category_id === id; }).forEach(function (r) {
    r.category_id = null;
    receipts.update(r);
  });
  cats.remove([cat]);
  return { ok: true, moved: moved };
}

/* ------------------------------------------------------------------ transactions */

function txOut_(t, cats) {
  const c = cats[t.category_id] || { name: '(ไม่มีหมวด)', color: '#7A8290' };
  return {
    id: t.id, type: t.type, amount: baht_(satangOf_(t.amount)), category_id: t.category_id,
    category_name: c.name, category_color: c.color, date: t.date, note: t.note,
    receipt_id: t.receipt_id, created_at: t.created_at, updated_at: t.updated_at,
  };
}

function checkCategory_(cats, categoryId, type) {
  const c = cats[categoryId];
  if (!c) fail_(400, 'ไม่พบหมวดหมู่นี้');
  if (c.type !== type) fail_(400, 'หมวดหมู่ไม่ตรงกับประเภทรายการ (รายรับ/รายจ่าย)');
}

function txInput_(p, cats) {
  const type = vType_(p.type);
  const satang = vAmount_(p.amount);
  const categoryId = vId_(p.category_id, 'หมวดหมู่');
  const date = vDate_(p.date);
  const note = vText_(p.note, 500, 'หมายเหตุ');
  checkCategory_(cats, categoryId, type);
  return { type: type, amount: baht_(satang), category_id: categoryId, date: date, note: note };
}

function sortNewestFirst_(a, b) {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id;
}

function a_transactionsList_(p) {
  const cats = byId_(table_('categories').all());
  let rows = table_('transactions').all();
  if (p.month) {
    const month = vMonth_(p.month);
    rows = rows.filter(function (t) { return t.date.slice(0, 7) === month; });
  }
  return rows.sort(sortNewestFirst_).map(function (t) { return txOut_(t, cats); });
}

function a_transactionsCreate_(p) {
  const cats = byId_(table_('categories').all());
  const row = txInput_(p, cats);
  row.id = nextIds_('transactions', 1)[0];
  row.receipt_id = null;
  row.created_at = row.updated_at = stamp_();
  table_('transactions').append([row]);
  return txOut_(row, cats);
}

function a_transactionsUpdate_(p) {
  const id = vId_(p.id);
  const cats = byId_(table_('categories').all());
  const txs = table_('transactions');
  const row = byId_(txs.all())[id];
  if (!row) fail_(404, 'ไม่พบรายการ');
  const input = txInput_(p, cats);
  Object.keys(input).forEach(function (k) { row[k] = input[k]; });
  row.updated_at = stamp_();
  txs.update(row);
  return txOut_(row, cats);
}

function a_transactionsDelete_(p) {
  const id = vId_(p.id);
  const txs = table_('transactions');
  const row = byId_(txs.all())[id];
  if (!row) fail_(404, 'ไม่พบรายการ');
  const receipts = table_('receipts');
  const attached = receipts.all().filter(function (r) { return r.transaction_id === id; });
  txs.remove([row]);
  receipts.remove(attached);
  attached.forEach(trashFile_); // the receipt image goes with its transaction
  return { ok: true, receipts_removed: attached.length };
}

function a_transactionsImport_(p) {
  const input = Array.isArray(p.rows) ? p.rows : [];
  if (!input.length) fail_(400, 'ไม่มีรายการให้นำเข้า');
  if (input.length > MAX_IMPORT_ROWS) fail_(413, 'นำเข้าได้ครั้งละไม่เกิน ' + MAX_IMPORT_ROWS + ' รายการ');

  const catTable = table_('categories');
  const catRows = catTable.all();
  const catKey = {};
  catRows.forEach(function (c) { catKey[c.type + '\n' + c.name] = c.id; });
  let nextOrder = catRows.reduce(function (m, c) { return Math.max(m, c.sort_order || 0); }, 0) + 1;

  const existing = {};
  const keyOf = function (date, type, categoryId, satang, note) { return [date, type, categoryId, satang, note].join('\n'); };
  table_('transactions').all().forEach(function (t) {
    const k = keyOf(t.date, t.type, t.category_id, satangOf_(t.amount), t.note);
    existing[k] = (existing[k] || 0) + 1;
  });

  const errors = [], newCats = [], pending = [];
  let skipped = 0;
  input.forEach(function (r, i) {
    const line = r && r.line ? r.line : i + 2;
    const type = r && r.type, satang = toSatang_(r && r.amount);
    if (!r || !isIsoDate_(r.date) || (type !== 'income' && type !== 'expense') || !(satang > 0) || satang > MAX_SATANG) {
      errors.push('บรรทัด ' + line + ': ข้อมูลไม่ถูกต้อง');
      return;
    }
    const name = String(r.category || '').trim().slice(0, 50) || 'อื่นๆ';
    const note = String(r.note || '').trim().slice(0, 500);
    let cid = catKey[type + '\n' + name];
    if (!cid) { // id filled in below once we know how many new categories there are
      cid = 'new:' + type + '\n' + name;
      if (!newCats.some(function (c) { return c.key === cid; })) newCats.push({ key: cid, name: name, type: type });
    }
    pending.push({ type: type, satang: satang, cid: cid, date: r.date, note: note });
  });

  if (newCats.length) {
    const ids = nextIds_('categories', newCats.length);
    const rows = newCats.map(function (c, i) {
      const row = { id: ids[i], name: c.name, type: c.type, sort_order: nextOrder++,
        color: NEW_CATEGORY_COLORS[(catRows.length + i) % NEW_CATEGORY_COLORS.length] };
      catKey[c.key] = row.id;
      return row;
    });
    catTable.append(rows);
  }

  const fresh = [];
  pending.forEach(function (r) {
    const cid = typeof r.cid === 'string' ? catKey[r.cid] : r.cid;
    const k = keyOf(r.date, r.type, cid, r.satang, r.note);
    if (existing[k] > 0) { // the same row is already in the sheet -> skip it
      existing[k] -= 1;
      skipped += 1;
      return;
    }
    fresh.push({ type: r.type, amount: baht_(r.satang), category_id: cid, date: r.date, note: r.note });
  });
  if (fresh.length) {
    const ids = nextIds_('transactions', fresh.length);
    const when = stamp_();
    fresh.forEach(function (row, i) {
      row.id = ids[i];
      row.receipt_id = null;
      row.created_at = row.updated_at = when;
    });
    table_('transactions').append(fresh);
  }
  return { imported: fresh.length, skipped_duplicates: skipped, errors: errors.slice(0, 20), error_count: errors.length };
}

/* ------------------------------------------------------------------ summaries */

function totals_(rows) {
  let income = 0, expense = 0;
  rows.forEach(function (t) {
    if (t.type === 'income') income += satangOf_(t.amount);
    else expense += satangOf_(t.amount);
  });
  return { income: baht_(income), expense: baht_(expense), balance: baht_(income - expense), count: rows.length };
}

function a_monthGet_(p) {
  const month = vMonth_(p.month);
  const prev = shiftMonth_(month, -1);
  const cats = byId_(table_('categories').all());
  const all = table_('transactions').all();
  const inMonth = all.filter(function (t) { return t.date.slice(0, 7) === month; });

  let cumulative = 0;
  const end = shiftMonth_(month, 1) + '-01';
  all.forEach(function (t) {
    if (t.date < end) cumulative += (t.type === 'income' ? 1 : -1) * satangOf_(t.amount);
  });

  const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const daily = [];
  for (let d = 1; d <= days; d++) daily.push({ day: d, income: 0, expense: 0 });
  const dailySatang = {}, perCat = {};
  inMonth.forEach(function (t) {
    const s = satangOf_(t.amount);
    const k = Number(t.date.slice(8, 10)) + ':' + t.type;
    dailySatang[k] = (dailySatang[k] || 0) + s;
    const c = perCat[t.category_id] || (perCat[t.category_id] = { type: t.type, s: 0, n: 0 });
    c.s += s;
    c.n += 1;
  });
  Object.keys(dailySatang).forEach(function (k) {
    const parts = k.split(':');
    if (daily[Number(parts[0]) - 1]) daily[Number(parts[0]) - 1][parts[1]] = baht_(dailySatang[k]);
  });
  const byCategory = { income: [], expense: [] };
  Object.keys(perCat).map(function (id) {
    const c = cats[id] || { name: '(ไม่มีหมวด)', color: '#7A8290' };
    return { id: Number(id), name: c.name, color: c.color, type: perCat[id].type, s: perCat[id].s, count: perCat[id].n };
  }).sort(function (a, b) { return b.s - a.s; }).forEach(function (c) {
    byCategory[c.type].push({ id: c.id, name: c.name, color: c.color, total: baht_(c.s), count: c.count });
  });

  return {
    month: month,
    totals: totals_(inMonth),
    previous: totals_(all.filter(function (t) { return t.date.slice(0, 7) === prev; })),
    cumulative_balance: baht_(cumulative),
    by_category: byCategory,
    daily: daily,
    transactions: inMonth.sort(sortNewestFirst_).map(function (t) { return txOut_(t, cats); }),
  };
}

function a_yearlyGet_(p) {
  const year = Number(p.year);
  if (!Number.isInteger(year) || year < 1900 || year > 2999) fail_(422, 'ข้อมูลไม่ถูกต้อง: ปี');
  const cats = byId_(table_('categories').all());
  const rows = table_('transactions').all().filter(function (t) { return Number(t.date.slice(0, 4)) === year; });
  const monthSatang = [], top = {};
  for (let i = 0; i < 12; i++) monthSatang.push({ income: 0, expense: 0 });
  rows.forEach(function (t) {
    const s = satangOf_(t.amount);
    monthSatang[Number(t.date.slice(5, 7)) - 1][t.type] += s;
    if (t.type === 'expense') top[t.category_id] = (top[t.category_id] || 0) + s;
  });
  return {
    year: year,
    totals: totals_(rows),
    months: monthSatang.map(function (m, i) {
      return { month: year + '-' + (i < 9 ? '0' : '') + (i + 1), income: baht_(m.income), expense: baht_(m.expense) };
    }),
    top_expense_categories: Object.keys(top).map(function (id) {
      const c = cats[id] || { name: '(ไม่มีหมวด)', color: '#7A8290' };
      return { name: c.name, color: c.color, s: top[id] };
    }).sort(function (a, b) { return b.s - a.s; }).slice(0, 8).map(function (c) {
      return { name: c.name, color: c.color, total: baht_(c.s) };
    }),
  };
}

/* ------------------------------------------------------------------ receipts */

function parseJson_(text, fallback) {
  try {
    const v = JSON.parse(text || '');
    return Array.isArray(v) ? v : fallback;
  } catch (e) {
    return fallback;
  }
}

function receiptOut_(r) {
  return {
    id: r.id, status: r.status, merchant: r.merchant, amount: r.amount === null ? null : baht_(satangOf_(r.amount)),
    date: r.date || null, category_id: r.category_id, included: r.included, transaction_id: r.transaction_id,
    is_pdf: r.mime === 'application/pdf', original_name: r.original_name, text_source: r.text_source,
    confidence: r.confidence, candidates: parseJson_(r.candidates, []), flags: parseJson_(r.flags, []),
    error: r.error, ocr_text: r.ocr_text, created_at: r.created_at,
  };
}

function receiptsFolder_() {
  const id = props_().getProperty('FOLDER_ID');
  if (!id) fail_(500, 'ยังไม่ได้ตั้งค่าโฟลเดอร์ใบเสร็จ — รันฟังก์ชัน setup อีกครั้ง');
  return DriveApp.getFolderById(id);
}

function trashFile_(receipt) {
  if (!receipt.file_id) return;
  try {
    DriveApp.getFileById(receipt.file_id).setTrashed(true);
  } catch (e) {
    console.warn('could not trash receipt file ' + receipt.file_id + ': ' + e);
  }
}

/** Drive turns an image or PDF into a temporary Google Doc; its text is the OCR result. */
function ocrText_(blob) {
  if (typeof Drive === 'undefined') throw new Error('Drive API service is not added to this Apps Script project');
  const docType = 'application/vnd.google-apps.document';
  const doc = Drive.Files.create
    ? Drive.Files.create({ name: 'ocr-tmp-' + Date.now(), mimeType: docType }, blob, { ocrLanguage: 'th', fields: 'id' })
    : Drive.Files.insert({ title: 'ocr-tmp-' + Date.now(), mimeType: docType }, blob, { ocr: true, ocrLanguage: 'th' }); // Drive API v2
  try {
    return DocumentApp.openById(doc.id).getBody().getText();
  } finally {
    try {
      Drive.Files.remove(doc.id);
    } catch (e) {
      console.warn('could not remove temporary OCR doc ' + doc.id + ': ' + e);
    }
  }
}

function sniffMime_(bytes) {
  const b = function (i) { return bytes[i] & 0xff; };
  if (bytes.length > 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (bytes.length > 7 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if (bytes.length > 4 && b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) return 'application/pdf';
  return '';
}

function categoryForHint_(hint) {
  const cats = table_('categories').all().filter(function (c) { return c.type === 'expense'; })
    .sort(function (a, b) { return a.sort_order - b.sort_order || a.id - b.id; });
  if (!cats.length) return null;
  const names = HINT_CATEGORY_NAMES[hint] || [];
  for (let i = 0; i < names.length; i++) {
    for (let j = 0; j < cats.length; j++) if (cats[j].name === names[i]) return cats[j].id;
  }
  for (let i = 0; i < names.length; i++) {
    for (let j = 0; j < cats.length; j++) {
      if (cats[j].name.indexOf(names[i]) !== -1 || names[i].indexOf(cats[j].name) !== -1) return cats[j].id;
    }
  }
  for (let j = 0; j < cats.length; j++) if (cats[j].name === 'อื่นๆ') return cats[j].id;
  return cats[0].id;
}

function a_receiptsList_(p) {
  const status = p.status === 'saved' ? 'saved' : 'pending';
  return table_('receipts').all().filter(function (r) { return r.status === status; })
    .sort(function (a, b) { return b.id - a.id; }).map(receiptOut_);
}

function a_receiptsUpload_(p) {
  const data = String(p.data || '');
  if (!data) fail_(400, 'ไม่มีไฟล์');
  if (data.length > MAX_RECEIPT_BYTES * 4 / 3 + 8) fail_(413, 'ไฟล์ใหญ่เกิน 2.5 MB');
  let bytes;
  try {
    bytes = Utilities.base64Decode(data);
  } catch (e) {
    fail_(400, 'อ่านไฟล์ไม่ได้');
  }
  const mime = sniffMime_(bytes); // decided from the file's first bytes, never from what the client claims
  if (!RECEIPT_MIMES[mime]) fail_(400, 'รองรับเฉพาะรูป JPG, PNG และไฟล์ PDF');

  const id = nextIds_('receipts', 1)[0];
  const name = vText_(p.name, 200, 'ชื่อไฟล์') || 'receipt';
  const blob = Utilities.newBlob(bytes, mime, 'receipt-' + id + '.' + RECEIPT_MIMES[mime]);
  const file = receiptsFolder_().createFile(blob);

  let text = '', error = '';
  try {
    text = ocrText_(blob) || '';
  } catch (e) { // keep the receipt; the amount can be typed in
    console.warn('OCR failed: ' + e);
    error = typeof Drive === 'undefined'
      ? 'ยังไม่ได้เพิ่มบริการ Drive API ใน Apps Script (Services → + → Drive API) จึงอ่านตัวอักษรไม่ได้ ใส่ยอดเองได้'
      : 'อ่านตัวอักษรจากไฟล์ไม่สำเร็จ ใส่ยอดเองได้';
  }
  const parsed = parseReceiptText(text, today_());
  const flags = [];
  if (parsed.amount === null) flags.push('no_amount');
  else if (parsed.confidence === 'low') flags.push('check_amount');
  if (parsed.date === null) flags.push('no_date');

  const row = {
    id: id, status: 'pending', merchant: parsed.merchant, amount: parsed.amount, date: parsed.date || today_(),
    category_id: categoryForHint_(parsed.category_hint), included: true, transaction_id: null, file_id: file.getId(),
    mime: mime, original_name: name, text_source: mime === 'application/pdf' ? 'drive-pdf' : 'drive-ocr',
    confidence: parsed.confidence, candidates: JSON.stringify(parsed.candidates), flags: JSON.stringify(flags),
    error: error, ocr_text: text.slice(0, 4000), created_at: stamp_(),
  };
  try {
    table_('receipts').append([row]);
  } catch (e) {
    trashFile_(row); // don't leave a file nobody points at
    throw e;
  }
  return receiptOut_(row);
}

function pendingReceipt_(receipts, id) {
  const row = byId_(receipts.all())[id];
  if (!row) fail_(404, 'ไม่พบใบเสร็จ');
  if (row.status !== 'pending') fail_(409, 'ใบเสร็จนี้บันทึกไปแล้ว');
  return row;
}

function a_receiptsUpdate_(p) {
  const receipts = table_('receipts');
  const row = pendingReceipt_(receipts, vId_(p.id));
  if ('merchant' in p) row.merchant = vText_(p.merchant, 200, 'ชื่อร้าน');
  if ('amount' in p) row.amount = p.amount === null || p.amount === '' ? null : baht_(vAmount_(p.amount));
  if ('date' in p && p.date) row.date = vDate_(p.date);
  if ('category_id' in p && p.category_id) {
    checkCategory_(byId_(table_('categories').all()), vId_(p.category_id, 'หมวดหมู่'), 'expense');
    row.category_id = Number(p.category_id);
  }
  if ('included' in p && p.included !== null) row.included = p.included === true;
  receipts.update(row);
  return receiptOut_(row);
}

function a_receiptsDelete_(p) {
  const id = vId_(p.id);
  const receipts = table_('receipts');
  const row = byId_(receipts.all())[id];
  if (!row) fail_(404, 'ไม่พบใบเสร็จ');
  if (row.transaction_id) {
    const txs = table_('transactions');
    const tx = byId_(txs.all())[row.transaction_id];
    if (tx) {
      tx.receipt_id = null;
      txs.update(tx);
    }
  }
  receipts.remove([row]);
  trashFile_(row);
  return { ok: true };
}

/** Save reviewed receipts as expenses. Everything is checked first; nothing is written unless all items are valid. */
function a_receiptsCommit_(p) {
  const items = Array.isArray(p.items) ? p.items : [];
  if (!items.length || items.length > 500) fail_(422, 'ข้อมูลไม่ถูกต้อง: รายการใบเสร็จ');
  const cats = byId_(table_('categories').all());
  const receipts = table_('receipts');
  const rows = byId_(receipts.all());
  const seen = {};

  const plan = items.map(function (item) {
    const id = vId_(item && item.id);
    const row = rows[id];
    if (!row) fail_(404, 'ไม่พบใบเสร็จ #' + id);
    if (row.status !== 'pending' || seen[id]) fail_(409, 'ใบเสร็จ #' + id + ' บันทึกไปแล้ว');
    seen[id] = true;
    const satang = vAmount_(item.amount);
    const date = vDate_(item.date);
    const categoryId = vId_(item.category_id, 'หมวดหมู่');
    checkCategory_(cats, categoryId, 'expense');
    return { row: row, satang: satang, date: date, categoryId: categoryId, merchant: vText_(item.merchant, 200, 'ชื่อร้าน') };
  });

  const ids = nextIds_('transactions', plan.length);
  const when = stamp_();
  let total = 0;
  table_('transactions').append(plan.map(function (x, i) {
    total += x.satang;
    return { id: ids[i], type: 'expense', amount: baht_(x.satang), category_id: x.categoryId, date: x.date,
      note: x.merchant || 'ใบเสร็จ', receipt_id: x.row.id, created_at: when, updated_at: when };
  }));
  plan.forEach(function (x, i) {
    x.row.status = 'saved';
    x.row.transaction_id = ids[i];
    x.row.amount = baht_(x.satang);
    x.row.date = x.date;
    x.row.category_id = x.categoryId;
    x.row.merchant = x.merchant;
    receipts.update(x.row);
  });
  return { saved: plan.length, total: baht_(total) };
}

function a_receiptsFile_(p) {
  const row = byId_(table_('receipts').all())[vId_(p.id)];
  if (!row || !row.file_id) fail_(404, 'ไม่พบไฟล์ใบเสร็จ');
  let blob;
  try {
    blob = DriveApp.getFileById(row.file_id).getBlob();
  } catch (e) {
    fail_(404, 'ไม่พบไฟล์ใบเสร็จใน Google Drive');
  }
  return { mime: row.mime, name: row.original_name, data: Utilities.base64Encode(blob.getBytes()) };
}

/* ------------------------------------------------------------------ login throttling + info */

function a_authAttempt_(p) {
  const key = 'login:' + String(p.key || 'unknown').slice(0, 80);
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get(key) || 0);
  if (fails >= LOGIN_MAX_FAILS) return { blocked: true };
  if (p.ok === true) cache.remove(key);
  else cache.put(key, String(fails + 1), LOGIN_BLOCK_SECONDS);
  return { blocked: false };
}

function a_info_() {
  let folderUrl = '';
  try {
    folderUrl = receiptsFolder_().getUrl();
  } catch (e) { /* folder missing: the sheet link is still useful */ }
  return { version: BACKEND_VERSION, schema: SCHEMA_VERSION, sheet_url: spreadsheet_().getUrl(), folder_url: folderUrl };
}

/* ------------------------------------------------------------------ web app entry points */

const ACTIONS = {
  'info': { fn: a_info_ },
  'auth.attempt': { fn: a_authAttempt_ },
  'categories.list': { fn: a_categoriesList_ },
  'categories.create': { fn: a_categoriesCreate_, write: true },
  'categories.update': { fn: a_categoriesUpdate_, write: true },
  'categories.delete': { fn: a_categoriesDelete_, write: true },
  'month.get': { fn: a_monthGet_ },
  'yearly.get': { fn: a_yearlyGet_ },
  'transactions.list': { fn: a_transactionsList_ },
  'transactions.create': { fn: a_transactionsCreate_, write: true },
  'transactions.update': { fn: a_transactionsUpdate_, write: true },
  'transactions.delete': { fn: a_transactionsDelete_, write: true },
  'transactions.import': { fn: a_transactionsImport_, write: true },
  'receipts.list': { fn: a_receiptsList_ },
  'receipts.upload': { fn: a_receiptsUpload_, write: true },
  'receipts.update': { fn: a_receiptsUpdate_, write: true },
  'receipts.delete': { fn: a_receiptsDelete_, write: true },
  'receipts.commit': { fn: a_receiptsCommit_, write: true },
  'receipts.file': { fn: a_receiptsFile_ },
};

function secretOk_(given) {
  const want = props_().getProperty('API_SECRET');
  if (!want || typeof given !== 'string' || !given) return false;
  const a = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, given);
  const b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, want);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; // compare every byte: no early exit to time
  return diff === 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let out;
  try {
    let body;
    try {
      body = JSON.parse((e && e.postData && e.postData.contents) || '');
    } catch (err) {
      fail_(400, 'bad request');
    }
    if (!body || !secretOk_(body.secret)) fail_(401, 'unauthorized');
    if (typeof body.action !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS, body.action)) {
      fail_(404, 'ไม่รู้จักคำสั่งนี้');
    }
    const action = ACTIONS[body.action];
    const params = body.params && typeof body.params === 'object' ? body.params : {};
    const run = function () { return action.fn(params); };
    out = { ok: true, data: action.write ? withLock_(run) : run() };
  } catch (err) {
    if (err instanceof ApiError) {
      out = { ok: false, status: err.status, error: err.message };
    } else {
      console.error(err && err.stack ? err.stack : err);
      out = { ok: false, status: 500, error: 'เกิดข้อผิดพลาดที่หลังบ้าน (Apps Script): ' + (err && err.message ? err.message : err) };
    }
  }
  return json_(out);
}

/** Opening the web app URL in a browser shows nothing useful: all data needs the secret, by POST. */
function doGet() {
  return ContentService.createTextOutput('income-expense backend ' + BACKEND_VERSION);
}

/* ------------------------------------------------------------------ run from the editor */

/**
 * Run once (and again after an update): creates the tabs, default categories, the Drive folder for receipts
 * and the API secret. Safe to re-run: existing data is kept.
 */
function setup() {
  const p = props_();
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss && p.getProperty('SHEET_ID')) ss = SpreadsheetApp.openById(p.getProperty('SHEET_ID'));
  if (!ss) ss = SpreadsheetApp.create('สมุดรายรับรายจ่าย');
  p.setProperty('SHEET_ID', ss.getId());
  SS_ = ss;

  Object.keys(TABLES).forEach(function (name) {
    const cols = TABLES[name];
    const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    sheet.getRange(1, 1, 1, cols.length).setValues([cols]);
    sheet.setFrozenRows(1);
    cols.forEach(function (c, i) {
      const column = sheet.getRange(1, i + 1, sheet.getMaxRows(), 1);
      if (NUMBER_COLUMNS[c]) column.setNumberFormat('0.00');
      else if (INT_COLUMNS[c]) column.setNumberFormat('0');
      else if (!BOOL_COLUMNS[c]) column.setNumberFormat('@'); // plain text
    });
  });

  const cats = table_('categories');
  if (!cats.all().length) {
    const ids = nextIds_('categories', DEFAULT_CATEGORIES.length);
    cats.append(DEFAULT_CATEGORIES.map(function (c, i) {
      return { id: ids[i], name: c[0], type: c[1], color: c[2], sort_order: i };
    }));
  }
  const meta = table_('meta');
  if (!meta.all().some(function (r) { return r.key === 'schema_version'; })) {
    meta.append([{ key: 'schema_version', value: String(SCHEMA_VERSION) }]);
  }

  if (!p.getProperty('FOLDER_ID')) p.setProperty('FOLDER_ID', DriveApp.createFolder('รายรับรายจ่าย - ใบเสร็จ').getId());
  if (!p.getProperty('API_SECRET')) p.setProperty('API_SECRET', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));

  Logger.log('ตั้งค่าเสร็จแล้ว');
  Logger.log('Google Sheet: ' + ss.getUrl());
  Logger.log('APPS_SCRIPT_SECRET (ใส่ใน Vercel): ' + p.getProperty('API_SECRET'));
  return { sheet_url: ss.getUrl(), secret: p.getProperty('API_SECRET') };
}

/** Prints the API secret again (Vercel needs it as APPS_SCRIPT_SECRET). */
function showSecret() {
  Logger.log('APPS_SCRIPT_SECRET: ' + props_().getProperty('API_SECRET'));
}

/** Replaces the API secret, e.g. if it leaked. Update APPS_SCRIPT_SECRET in Vercel afterwards. */
function rotateSecret() {
  props_().setProperty('API_SECRET', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  showSecret();
}
