/**
 * Receipt text -> total, date, shop, category hint.
 * A JavaScript port of app/receipts.py (same rules, same test cases). Used by the receipt upload in Vercel;
 * the Apps Script side only turns the image into text.
 */

const THAI = '\\u0E00-\\u0E7F';
const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

// money with 2 decimals: 1,250.00 / 125.00 / 125,00 (OCR'd comma)
const MONEY_SRC = '(?<![\\d.,])(\\d{1,3}(?:,\\d{3})+|\\d+)\\s?[.,]\\s?(\\d{2})(?![\\d])';
// whole-baht amounts, only trusted on total lines: "รวม 125 บาท"
const WHOLE_SRC = '(?<![\\d.,])(\\d{1,3}(?:,\\d{3})+|\\d{1,7})(?![\\d.,])';

const STRONG = [
  'ยอดสุทธิ', 'รวมทั้งสิ้น', 'รวมสุทธิ', 'ยอดรวมสุทธิ', 'ยอดชำระ', 'ยอดที่ต้องชำระ', 'ชำระทั้งสิ้น',
  'รวมเงินทั้งสิ้น', 'ยอดเงินสุทธิ', 'จำนวนเงินรวมทั้งสิ้น', 'จำนวนเงินทั้งสิ้น', 'สุทธิ',
  'grandtotal', 'nettotal', 'totaldue', 'amountdue', 'totalamount', 'netamount', 'totalpayment',
  'totalpaid', 'amountpaid', 'balancedue', 'totalthb', 'totalbaht',
];
const MEDIUM = ['ยอดรวม', 'รวมเงิน', 'total', 'รวม', 'ทั้งหมด', 'amount', 'ยอดเงิน'];
const NEGATIVE = [
  'subtotal', 'sub-total', 'ก่อนภาษี', 'ก่อนvat', 'beforevat', 'beforetax', 'excl', 'vat', 'ภาษี',
  'ส่วนลด', 'discount', 'ทอน', 'change', 'เงินสด', 'cash', 'รับเงิน', 'received', 'tendered',
  'service', 'ค่าบริการ', 'ปัดเศษ', 'rounding', 'คะแนน', 'point', 'ประหยัด', 'saving', 'saved',
  'มูลค่าสินค้า', 'ราคาต่อหน่วย', 'unitprice', '@',
];
const INCLUSIVE = ['incl', 'includ', 'inc.vat', 'incvat', 'vatinc', 'รวมภาษีแล้ว', 'รวมvatแล้ว'];

const TH_MONTHS = {
  'มกราคม': 1, 'มค': 1, 'กุมภาพันธ์': 2, 'กพ': 2, 'มีนาคม': 3, 'มีค': 3, 'เมษายน': 4, 'เมย': 4,
  'พฤษภาคม': 5, 'พค': 5, 'มิถุนายน': 6, 'มิย': 6, 'กรกฎาคม': 7, 'กค': 7, 'สิงหาคม': 8, 'สค': 8,
  'กันยายน': 9, 'กย': 9, 'ตุลาคม': 10, 'ตค': 10, 'พฤศจิกายน': 11, 'พย': 11, 'ธันวาคม': 12, 'ธค': 12,
};
const EN_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// [pattern on lower-case text, display name, category hint]
const BRANDS = [
  ['7-?eleven|7-?11|เซเว่น|cpall|ซีพีออลล์|ซีพีออล', '7-Eleven', 'food'],
  ['familymart|แฟมิลี่มาร์ท', 'FamilyMart', 'food'],
  ['lawson|ลอว์สัน', 'Lawson 108', 'food'],
  ["lotus'?s|โลตัส|tesco", "Lotus's", 'shopping'],
  ['bigc|บิ๊กซี', 'Big C', 'shopping'],
  ['makro|แม็คโคร|แมคโคร', 'Makro', 'shopping'],
  ['topsmarket|\\btops\\b|ท็อปส์', 'Tops', 'shopping'],
  ['villamarket|วิลล่ามาร์เก็ต', 'Villa Market', 'shopping'],
  ['starbucks|สตาร์บัคส์', 'Starbucks', 'food'],
  ['cafeamazon|caféamazon|คาเฟ่อเมซอน', 'Café Amazon', 'food'],
  ['mcdonald|แมคโดนัลด์', "McDonald's", 'food'],
  ['kfc|เคเอฟซี', 'KFC', 'food'],
  ['mksuki|mkrestaurant|เอ็มเคสุกี้|เอ็มเค', 'MK', 'food'],
  ['swensen|สเวนเซ่นส์', "Swensen's", 'food'],
  ['pizzacompany|pizzahut|พิซซ่า', 'Pizza', 'food'],
  ['after\\s?you|อาฟเตอร์ยู', 'After You', 'food'],
  ['grabfood', 'GrabFood', 'food'],
  ['\\bgrab\\b|grabtaxi|grabcar', 'Grab', 'transport'],
  ['lineman|ไลน์แมน', 'LINE MAN', 'food'],
  ['foodpanda', 'foodpanda', 'food'],
  ['\\bbolt\\b', 'Bolt', 'transport'],
  ['btsskytrain|\\bbts\\b|รถไฟฟ้าบีทีเอส', 'BTS', 'transport'],
  ['\\bmrt\\b|bemetro|รถไฟฟ้ามหานคร', 'MRT', 'transport'],
  ['\\bptt\\b|pttstation|ปตท', 'PTT', 'transport'],
  ['shell|เชลล์', 'Shell', 'transport'],
  ['bangchak|บางจาก', 'Bangchak', 'transport'],
  ['esso|เอสโซ่', 'Esso', 'transport'],
  ['caltex|คาลเท็กซ์', 'Caltex', 'transport'],
  ['watsons|วัตสัน', 'Watsons', 'health'],
  ['boots|บู๊ทส์', 'Boots', 'health'],
  ['โรงพยาบาล|hospital', '', 'health'],
  ['คลินิก|clinic', '', 'health'],
  ['ร้านยา|pharmacy|เภสัช', '', 'health'],
  ['การไฟฟ้านครหลวง|การไฟฟ้าส่วนภูมิภาค|\\bmea\\b|\\bpea\\b', 'การไฟฟ้า', 'utilities'],
  ['การประปา|\\bmwa\\b|\\bpwa\\b', 'การประปา', 'utilities'],
  ['advancedinfo|\\bais\\b|เอไอเอส', 'AIS', 'utilities'],
  ['truemove|trueonline|ทรูมูฟ|ทรูออนไลน์', 'True', 'utilities'],
  ['dtac|ดีแทค', 'dtac', 'utilities'],
  ['3bb|ทริปเปิลที', '3BB', 'utilities'],
  ['majorcineplex|เมเจอร์ซีนีเพล็กซ์|sfcinema|เอสเอฟ', 'โรงภาพยนตร์', 'entertainment'],
  ['shopee|ช้อปปี้', 'Shopee', 'shopping'],
  ['lazada|ลาซาด้า', 'Lazada', 'shopping'],
  ['homepro|โฮมโปร', 'HomePro', 'shopping'],
  ['ikea|อิเกีย', 'IKEA', 'shopping'],
  ['uniqlo|ยูนิโคล่', 'Uniqlo', 'shopping'],
  ['central|เซ็นทรัล|robinson|โรบินสัน', '', 'shopping'],
  ['se-?ed|ซีเอ็ด|asiabooks|kinokuniya|นายอินทร์|naiin', '', 'education'],
];
const TEXT_HINTS = [
  ['ร้านอาหาร|restaurant|cafe|café|coffee|กาแฟ|ก๋วยเตี๋ยว|ข้าว|ชานม|bakery|เบเกอรี่|อาหาร|food|drink|เครื่องดื่ม|' +
   'servicecharge|ค่าบริการ\\d|table\\d|โต๊ะ\\d|guests?\\d|ส้มตำ|somtum|ชาบู|shabu|หมูกระทะ|สุกี้|sushi|ซูชิ|ramen|ราเมน|' +
   'steak|สเต็ก|bistro|kitchen|noodle|ปิ้งย่าง|bbq|บุฟเฟ่ต์|buffet|ชา|tea|เบียร์|beer', 'food'],
  ['น้ำมัน|fuel|gasohol|แก๊สโซฮอล์|ดีเซล|diesel|e20|e85|เบนซิน|ค่าทางด่วน|ทางพิเศษ|taxi|แท็กซี่|parking|ที่จอดรถ', 'transport'],
  ['ค่าไฟ|ไฟฟ้า|electricity|ค่าน้ำประปา|internet|อินเทอร์เน็ต|ค่าโทรศัพท์|mobile|broadband', 'utilities'],
  ['โรงพยาบาล|hospital|clinic|คลินิก|pharmacy|ยา|dental|ทันตกรรม', 'health'],
  ['cinema|movie|ภาพยนตร์|ตั๋วหนัง|ticket|concert|คอนเสิร์ต|game|เกม', 'entertainment'],
  ['หนังสือ|book|course|คอร์ส|tuition|ค่าเรียน|ค่าเทอม|seminar|สัมมนา', 'education'],
  ['ค่าเช่า|rent|ค่าห้อง|หอพัก|condo|คอนโด|ค่าส่วนกลาง', 'housing'],
];
// which default category each hint maps to (by name; falls back to a keyword match)
const HINT_CATEGORY_NAMES = {
  food: ['อาหารและเครื่องดื่ม', 'อาหาร'],
  transport: ['เดินทาง'],
  utilities: ['ค่าน้ำ ค่าไฟ ค่าเน็ต', 'ค่าน้ำ', 'ค่าไฟ', 'สาธารณูปโภค'],
  shopping: ['ช้อปปิ้ง'],
  health: ['สุขภาพ'],
  entertainment: ['บันเทิง'],
  education: ['การศึกษา'],
  housing: ['ที่พัก / ค่าเช่า', 'ที่พัก', 'ค่าเช่า'],
};

const BOILERPLATE = new RegExp(
  'ใบเสร็จ|ใบกำกับ|receipt|tax|invoice|สาขา|branch|tel|โทร|เลขประจำตัว|เลขที่|pos|vat|date|วันที่|เวลา|time|' +
  'abb|cashier|พนักงาน|สำนักงานใหญ่|head\\s?office|welcome|ยินดีต้อนรับ|copy|สำเนา|order|table|โต๊ะ|' +
  '^[^\\p{L}\\p{N}_]*$|\\d{5,}', 'iu');
const COUNT_WORDS = /^\s*(ชิ้น|รายการ|อัน|items?|pcs|qty|ea\b|x\b|%)/i;

function normalizeText_(text) {
  let t = String(text || '').replace(/[๐-๙]/g, function (d) { return String(THAI_DIGITS.indexOf(d)); });
  t = t.replace(/​/g, '').replace(/\r/g, '');
  // OCR often spaces out Thai glyphs: "ย อ ด ร ว ม" -> "ยอดรวม"
  t = t.replace(new RegExp('(?<=[' + THAI + '])[ \\t]+(?=[' + THAI + '])', 'g'), '');
  // "125 .00" / "125. 00"
  t = t.replace(/(\d)\s+([.,]\d{2})(?!\d)/g, '$1$2');
  t = t.replace(/(\d[.,])\s+(\d{2})(?!\d)/g, '$1$2');
  // OCR letter/digit confusions inside numbers: O/o -> 0, l/I/| -> 1
  t = t.replace(/(?<=\d)[Oo](?=[\d.,])|(?<=[\d.,])[Oo](?=\d)/g, '0');
  t = t.replace(/(?<=\d)[lI|](?=[\d.,])|(?<=[\d.,])[lI|](?=\d)/g, '1');
  return t;
}

function compact_(s) {
  return s.toLowerCase().replace(/\s+/g, '');
}

/** Money amounts on a line -> { vals, whole } (whole = fell back to whole-baht numbers). */
function moneyOn_(line, allowWhole) {
  const vals = [];
  let m;
  const moneyRe = new RegExp(MONEY_SRC, 'g');
  while ((m = moneyRe.exec(line)) !== null) {
    const v = parseFloat(m[1].replace(/,/g, '') + '.' + m[2]);
    if (v > 0 && v < 10000000) vals.push(v);
  }
  if (vals.length || !allowWhole) return { vals: vals, whole: false };
  // strip dates/times so "10/11/69 12:30" doesn't look like money
  const cleaned = line.replace(/\d{1,4}[/\-.:]\d{1,2}(?:[/\-.:]\d{1,4})?/g, ' ');
  const wholeRe = new RegExp(WHOLE_SRC, 'g');
  while ((m = wholeRe.exec(cleaned)) !== null) {
    if (COUNT_WORDS.test(cleaned.slice(m.index + m[0].length))) continue; // "4 ชิ้น", "3 items", "10%"
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (v > 0 && v < 10000000) vals.push(v);
  }
  return { vals: vals, whole: vals.length > 0 };
}

function lineScore_(compact, line) {
  const has = function (k) { return compact.indexOf(k) !== -1; };
  const strong = STRONG.some(has);
  const medium = MEDIUM.some(has) || /\bnet\b/.test(String(line || '').toLowerCase());
  let score = strong ? 10 : medium ? 6 : 0;
  let negs = NEGATIVE.filter(has);
  if (negs.length && INCLUSIVE.some(has)) {
    negs = negs.filter(function (k) { return k !== 'vat' && k !== 'ภาษี'; });
  }
  if (negs.length) score -= 8;
  const level = strong && !negs.length ? 'high' : score > 0 ? 'medium' : '';
  return { score: score, level: level };
}

function round2_(v) {
  return Math.round(v * 100) / 100;
}

function findTotal_(lines) {
  const n = lines.length;
  const scored = []; // {s, v, level}
  const allVals = []; // {s, v}
  let cash = null, change = null;

  for (let i = 0; i < n; i++) {
    const line = lines[i];
    const c = compact_(line);
    const ls = lineScore_(c, line);
    let score = ls.score;
    const found = moneyOn_(line, score > 0);
    let vals = found.vals;
    if (found.whole) score -= 2; // "รวม 125" is less certain than "รวม 125.00"
    const position = 2.0 * i / Math.max(n - 1, 1); // totals sit near the bottom
    if (score > 0 && !vals.length && i + 1 < n) {
      const next = moneyOn_(lines[i + 1], true).vals;
      if (next.length && lineScore_(compact_(lines[i + 1]), lines[i + 1]).score <= 0) {
        vals = next.slice(-1);
        score -= 1;
      }
    }
    vals.forEach(function (v) { allVals.push({ s: score + position, v: v }); });
    if (score > 0 && vals.length) scored.push({ s: score + position, v: Math.max.apply(null, vals), level: ls.level });
    if ((c.indexOf('เงินสด') !== -1 || c.indexOf('cash') !== -1) && vals.length) cash = vals[vals.length - 1];
    if ((c.indexOf('ทอน') !== -1 || c.indexOf('change') !== -1) && vals.length) change = vals[vals.length - 1];
  }

  const desc = function (a, b) { return b.s - a.s || b.v - a.v; };
  let chosen = null, confidence = 'none';
  if (scored.length) {
    scored.sort(desc);
    chosen = scored[0].v;
    confidence = scored[0].level || 'medium';
  } else if (cash !== null && change !== null && cash > change) {
    chosen = round2_(cash - change);
    confidence = 'medium';
  } else {
    const plain = allVals.filter(function (x) { return x.s >= 0 && x.v !== cash; }).map(function (x) { return x.v; });
    if (plain.length) {
      chosen = Math.max.apply(null, plain);
      confidence = 'low';
    }
  }

  const seen = {}, candidates = [];
  allVals.slice().sort(desc).forEach(function (x) {
    if (x.v !== chosen && !seen[x.v]) {
      seen[x.v] = true;
      candidates.push(x.v);
    }
  });
  return { amount: chosen, confidence: confidence, candidates: candidates.slice(0, 6) };
}

function dayNumber_(y, m, d) {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function isoFromParts_(y, m, d) {
  const p = function (x) { return (x < 10 ? '0' : '') + x; };
  return y + '-' + p(m) + '-' + p(d);
}

/** today: 'YYYY-MM-DD'. Dates in the future or more than 3 years old are ignored. */
function findDate_(text, today) {
  const t = today.split('-').map(Number);
  const todayNum = dayNumber_(t[0], t[1], t[2]);
  const found = [];

  const valid = function (y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    const num = dayNumber_(y, m, d);
    if (num > todayNum + 1 || num < todayNum - 365 * 3) return null;
    return isoFromParts_(y, m, d);
  };
  const years = function (y) {
    if (y >= 2400) return [y - 543];
    if (y >= 1900) return [y];
    if (y < 100) { // 2-digit: could be ค.ศ. (26) or พ.ศ. (69)
      const a = 2000 + y, b = 2500 + y - 543;
      const list = a === b ? [a] : [a, b].sort(function (p, q) { return p - q; });
      return list.sort(function (p, q) { return Math.abs(p - t[0]) - Math.abs(q - t[0]); });
    }
    return [];
  };
  const add = function (pos, y, m, d, swapOk) {
    const ys = years(y);
    for (let i = 0; i < ys.length; i++) {
      const iso = valid(ys[i], m, d) || (swapOk && valid(ys[i], d, m));
      if (iso) {
        found.push({ pos: pos, iso: iso });
        return;
      }
    }
  };
  const each = function (re, str, fn) {
    let m;
    while ((m = re.exec(str)) !== null) fn(m);
  };

  each(/(?<!\d)(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?!\d)/g, text, function (m) {
    add(m.index, +m[1], +m[2], +m[3], false);
  });
  each(/(?<![\d.])(\d{1,2})\s?[/\-.]\s?(\d{1,2})\s?[/\-.]\s?(\d{4}|\d{2})(?![\d])/g, text, function (m) {
    add(m.index, +m[3], +m[2], +m[1], true);
  });

  const flat = text.toLowerCase().replace(/[.\s]/g, '');
  const thAlt = Object.keys(TH_MONTHS).sort(function (a, b) { return b.length - a.length; }).join('|');
  each(new RegExp('(?<!\\d)(\\d{1,2})(' + thAlt + ')(\\d{4}|\\d{2})(?!\\d)', 'g'), flat, function (m) {
    add(m.index, +m[3], TH_MONTHS[m[2]], +m[1], false);
  });
  const low = text.toLowerCase();
  const enAlt = Object.keys(EN_MONTHS).join('|');
  each(new RegExp('(?<!\\d)(\\d{1,2})[\\s\\-]*(' + enAlt + ')[a-z]*\\.?[\\s\\-,]*(\\d{4}|\\d{2})(?!\\d)', 'g'), low, function (m) {
    add(m.index, +m[3], EN_MONTHS[m[2]], +m[1], false);
  });
  each(new RegExp('\\b(' + enAlt + ')[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})(?!\\d)', 'g'), low, function (m) {
    add(m.index, +m[3], EN_MONTHS[m[1]], +m[2], false);
  });

  if (!found.length) return null;
  found.sort(function (a, b) { return a.pos - b.pos; });
  return found[0].iso;
}

function findMerchant_(lines, compactAll) {
  const haystack = lines.join('\n').toLowerCase() + '\n' + compactAll;
  for (let i = 0; i < BRANDS.length; i++) {
    if (new RegExp(BRANDS[i][0]).test(haystack)) {
      if (BRANDS[i][1]) return { merchant: BRANDS[i][1], hint: BRANDS[i][2] };
      break;
    }
  }
  const junk = new RegExp("[^\\p{L}\\p{N}_\\s&'.\\-/()" + THAI + ']', 'gu');
  const letters = new RegExp('[A-Za-z' + THAI + ']', 'g');
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    let s = lines[i].replace(junk, ' ').replace(/^[ .\-/]+|[ .\-/]+$/g, '');
    s = s.replace(/\s{2,}/g, ' ');
    if ((s.match(letters) || []).length >= 3 && !BOILERPLATE.test(s) && !moneyOn_(s, false).vals.length) {
      return { merchant: s.slice(0, 60), hint: null };
    }
  }
  return { merchant: '', hint: null };
}

function guessHint_(compactAll, brandHint) {
  if (brandHint) return brandHint;
  for (let i = 0; i < TEXT_HINTS.length; i++) {
    if (new RegExp(TEXT_HINTS[i][0]).test(compactAll)) return TEXT_HINTS[i][1];
  }
  return null;
}

/**
 * @param {string} text  OCR text
 * @param {string} today 'YYYY-MM-DD' (used to judge 2-digit years and reject future dates)
 * @return {{amount: ?number, confidence: string, candidates: number[], date: ?string, merchant: string, category_hint: ?string}}
 */
function parseReceiptText(text, today) {
  const clean = normalizeText_(text);
  const lines = clean.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  const compactAll = compact_(clean);
  const total = findTotal_(lines);
  const shop = findMerchant_(lines, compactAll);
  return {
    amount: total.amount,
    confidence: total.confidence,
    candidates: total.candidates,
    date: findDate_(clean, today),
    merchant: shop.merchant,
    category_hint: guessHint_(compactAll, shop.hint),
  };
}

export { parseReceiptText, HINT_CATEGORY_NAMES };
