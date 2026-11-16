// Receipt parser (cloud/vercel/lib/parser.js) — the same 8 cases as tests/test_receipt_parser.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReceiptText, HINT_CATEGORY_NAMES } from "../vercel/lib/parser.js";
const TODAY = "2026-11-10";

const CASES = [
  ["7-Eleven with cash/change, BE 2-digit year", `7-ELEVEN
        บริษัท ซีพี ออลล์ จำกัด (มหาชน)
        TAX#0107542000011 (VAT Included)
        สาขา 12345 POS#00321
        โออิชิ กรีนที 20.00
        ข้าวกะเพราไก่ 45.00
        2 @ 30.00 60.00
        รวม 4 ชิ้น 125.00
        เงินสด 200.00
        ทอน 75.00
        10/11/69 12:30`, { amount: 125.0, date: "2026-11-10", merchant: "7-Eleven", hint: "food" }],
  ["Restaurant: subtotal + service + VAT -> grand total", `Somtum Der Silom
        Table 5  Guests 2
        Date: 08/11/2026 19:42
        Som Tum Thai        120.00
        Larb Moo            150.00
        Sticky Rice x2       40.00
        Sub Total           310.00
        Service Charge 10%   31.00
        VAT 7%               23.87
        Grand Total         364.87
        Cash                400.00
        Change               35.13`, { amount: 364.87, date: "2026-11-08", merchant: "Somtum Der Silom", hint: "food" }],
  ["Thai OCR with spaced glyphs, Thai digits, Thai month", `ร้ า น ก า แ ฟ บ้ า น ส ว น
        ใบเสร็จรับเงิน
        วันที่ ๕ พ.ย. ๒๕๖๙
        ลาเต้เย็น ๖๕.๐๐
        ครัวซองต์ ๕๕.๐๐
        ย อ ด ร ว ม ๑๒๐.๐๐`, { amount: 120.0, date: "2026-11-05", merchant: "ร้านกาแฟบ้านสวน", hint: "food" }],
  ["Fuel receipt, total on next line, ISO date", `บริษัท บางจาก คอร์ปอเรชั่น จำกัด
        2026-11-03 07:15
        แก๊สโซฮอล์ 95  32.45 ลิตร
        ราคา/ลิตร 37.85
        จำนวนเงินรวมทั้งสิ้น
        1,228.23
        VAT 7% 80.35`, { amount: 1228.23, date: "2026-11-03", merchant: "Bangchak", hint: "transport" }],
  ["OCR noise: O instead of 0, comma decimal, TOTAL in English", `TOPS market
        Central World
        MILK 1L          52.O0
        BREAD            45,00
        EGGS 10          89.00
        TOTAL           186,00
        VISA ****1234   186.00
        Nov 7, 2026`, { amount: 186.0, date: "2026-11-07", merchant: "Tops", hint: "shopping" }],
  ["No keyword: cash minus change", `ร้านป้าแดง ข้าวแกง
        ข้าว+แกง 2 อย่าง 50.00
        ไข่ดาว 10.00
        เงินสด 100.00
        ทอน 40.00`, { amount: 60.0, hint: "food" }],
  ["Whole-baht total, item count must not win", `ร้านก๋วยเตี๋ยวเรือ
        ก๋วยเตี๋ยว 3 ชาม
        รวม 3 รายการ
        ยอดรวม 135 บาท`, { amount: 135.0, hint: "food" }],
  ["Electricity bill, Thai full month, net amount", `การไฟฟ้านครหลวง
        ใบเสร็จรับเงิน/ใบกำกับภาษี
        วันที่ 2 พฤศจิกายน 2569
        ค่าพลังงานไฟฟ้า 812.40
        ค่า Ft 31.20
        ภาษีมูลค่าเพิ่ม 59.05
        ยอดเงินสุทธิ 902.65`, { amount: 902.65, date: "2026-11-02", merchant: "การไฟฟ้า", hint: "utilities" }],
];

for (const [name, text, expect] of CASES) {
  test(name, () => {
    const r = parseReceiptText(text, TODAY);
    assert.equal(r.amount, expect.amount, `candidates ${r.candidates}`);
    if ("date" in expect) assert.equal(r.date, expect.date);
    if ("merchant" in expect) assert.equal(r.merchant, expect.merchant);
    if ("hint" in expect) assert.equal(r.category_hint, expect.hint);
  });
}

test("no text at all gives no amount and no date", () => {
  const r = parseReceiptText("", TODAY);
  assert.equal(r.amount, null);
  assert.equal(r.date, null);
  assert.equal(r.confidence, "none");
});

test("dates in the future are ignored", () => {
  assert.equal(parseReceiptText("รวม 50.00\n01/12/2027", TODAY).date, null);
});

test("every category hint names at least one default expense category", () => {
  for (const names of Object.values(HINT_CATEGORY_NAMES)) assert.ok(Array.isArray(names) && names.length > 0);
});
