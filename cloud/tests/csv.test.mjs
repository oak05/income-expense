// CSV import/export helpers and the shared page helpers (browser scripts, loaded into a sandbox).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function load(file, names) {
  const src = readFileSync(new URL(`../vercel/public/${file}`, import.meta.url), "utf8");
  const ctx = vm.createContext({ TextDecoder, document: { addEventListener() {} }, location: {} });
  vm.runInContext(`${src}\n;globalThis.__x = { ${names.join(", ")} };`, ctx);
  return ctx.__x;
}
const { parseCsv, csvToRows, toCsv, decodeCsvBytes, parseCsvDate, parseCsvAmount } =
  load("csv.js", ["parseCsv", "csvToRows", "toCsv", "decodeCsvBytes", "parseCsvDate", "parseCsvAmount"]);
const { evalAmount, readAmount, shiftMonth } = load("common.js", ["evalAmount", "readAmount", "shiftMonth"]);
const plain = (v) => JSON.parse(JSON.stringify(v));

test("parseCsv handles quotes, doubled quotes, commas and newlines inside cells", () => {
  assert.deepEqual(plain(parseCsv('a,b\r\n"1,250.00","say ""hi"""\n"two\nlines",x\n')),
    [["a", "b"], ["1,250.00", 'say "hi"'], ["two\nlines", "x"]]);
  assert.deepEqual(plain(parseCsv("a;b\n1;2")), [["a", "b"], ["1", "2"]], "semicolon files from Excel");
  assert.deepEqual(plain(parseCsv("a\tb\n1\t2")), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(plain(parseCsv("")), []);
});

test("dates: ISO, day/month/year, Buddhist Era; impossible dates are errors", () => {
  assert.equal(parseCsvDate("2026-11-10"), "2026-11-10");
  assert.equal(parseCsvDate("10/11/2569"), "2026-11-10");
  assert.equal(parseCsvDate("1.2.2026"), "2026-02-01");
  assert.equal(parseCsvDate("2026-11-10 12:30"), "2026-11-10");
  for (const bad of ["31/02/2026", "10/11/69", "tomorrow", "", "2026-13-01"]) assert.throws(() => parseCsvDate(bad), bad);
});

test("amounts: separators, currency marks, brackets and minus signs", () => {
  assert.deepEqual(plain(parseCsvAmount("1,250.00")), { text: "1250.00", negative: false, zero: false });
  assert.deepEqual(plain(parseCsvAmount("฿ 99 บาท")), { text: "99", negative: false, zero: false });
  assert.equal(parseCsvAmount("(300)").negative, true);
  assert.equal(parseCsvAmount("-300").negative, true);
  assert.equal(parseCsvAmount(".5").text, "0.5");
  for (const bad of ["abc", "", "1e3", "12..3"]) assert.throws(() => parseCsvAmount(bad), bad);
});

test("csvToRows maps Thai/English headers, guesses the type from the sign and reports bad lines", () => {
  const text = "วันที่,ประเภท,หมวดหมู่,จำนวนเงิน,หมายเหตุ\r\n"
    + '10/11/2569,รายจ่าย,กาแฟ,"1,250.00",ลาเต้\r\n'
    + "2026-11-09,,,-300,ถอนเงิน\r\n"
    + "2026-11-09,,,300,\r\n"
    + "\r\n"
    + "31/02/2026,รายจ่าย,x,5,bad\r\n"
    + "2026-11-09,foo,,300,\r\n"
    + "2026-11-09,รายจ่าย,,0,\r\n";
  const { rows, errors } = csvToRows(text);
  assert.deepEqual(plain(rows), [
    { line: 2, date: "2026-11-10", type: "expense", amount: "1250.00", category: "กาแฟ", note: "ลาเต้" },
    { line: 3, date: "2026-11-09", type: "expense", amount: "300", category: "อื่นๆ", note: "ถอนเงิน" },
    { line: 4, date: "2026-11-09", type: "income", amount: "300", category: "อื่นๆ", note: "" },
  ]);
  assert.deepEqual(plain(errors).map((e) => e.split(":")[0]), ["บรรทัด 6", "บรรทัด 7", "บรรทัด 8"]);
  assert.equal(csvToRows("Date,Amount\n2026-11-01,5\n").rows.length, 1);
  assert.throws(() => csvToRows("name,price\nx,5\n"), /ไม่พบคอลัมน์/);
  assert.throws(() => csvToRows(""), /ไฟล์ว่าง/);
});

test("Windows-874 files from Thai Excel are decoded", () => {
  // "วันที่" in Windows-874
  const bytes = Uint8Array.from([0xc7, 0xd1, 0xb9, 0xb7, 0xd5, 0xe8]);
  assert.equal(decodeCsvBytes(bytes.buffer), "วันที่");
  assert.equal(decodeCsvBytes(new TextEncoder().encode("﻿วันที่").buffer), "วันที่");
});

test("export has a BOM, quotes where needed and cannot smuggle formulas into Excel", () => {
  const csv = toCsv([
    { id: 2, date: "2026-11-10", type: "expense", category_name: "กาแฟ, ชา", amount: 1250, note: '=HYPERLINK("http://x.example","click")' },
    { id: 1, date: "2026-11-09", type: "income", category_name: "เงินเดือน", amount: 28000.5, note: "-โบนัส" },
  ]);
  assert.ok(csv.startsWith("﻿วันที่,ประเภท,หมวดหมู่,จำนวนเงิน,หมายเหตุ\r\n"));
  const lines = csv.trim().split("\r\n");
  assert.equal(lines[1], "2026-11-09,รายรับ,เงินเดือน,28000.50,'-โบนัส");
  assert.equal(lines[2], '2026-11-10,รายจ่าย,"กาแฟ, ชา",1250.00,"\'=HYPERLINK(""http://x.example"",""click"")"');
});

test("export then import gives back the same rows (including text that was protected)", () => {
  const original = [
    { id: 1, date: "2026-11-09", type: "income", category_name: "เงินเดือน", amount: 28000.5, note: "-โบนัส" },
    { id: 2, date: "2026-11-10", type: "expense", category_name: "กาแฟ, ชา", amount: 1250, note: '=1+1 "quoted"\nline 2' },
  ];
  const { rows, errors } = csvToRows(decodeCsvBytes(new TextEncoder().encode(toCsv(original)).buffer));
  assert.equal(errors.length, 0);
  assert.deepEqual(plain(rows).map((r) => [r.date, r.type, r.category, Number(r.amount), r.note]),
    original.map((t) => [t.date, t.type, t.category_name, t.amount, t.note]));
});

test("page helpers behave as in the Docker version", () => {
  assert.equal(evalAmount("45+60"), 105);
  assert.ok(Number.isNaN(evalAmount("12a")));
  assert.deepEqual(plain(readAmount("12a")), { amount: null, valid: false });
  assert.deepEqual(plain(readAmount(" 45+60.005 ")), { amount: 105.01, valid: true });
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
});
