"""Receipt text parser. Run: pytest tests/test_receipt_parser.py  (or python tests/test_receipt_parser.py)"""
import datetime as dt
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.receipts import parse_receipt_text  # noqa: E402

TODAY = dt.date(2026, 11, 10)

CASES = [
    (
        "7-Eleven with cash/change, BE 2-digit year",
        """7-ELEVEN
        บริษัท ซีพี ออลล์ จำกัด (มหาชน)
        TAX#0107542000011 (VAT Included)
        สาขา 12345 POS#00321
        โออิชิ กรีนที 20.00
        ข้าวกะเพราไก่ 45.00
        2 @ 30.00 60.00
        รวม 4 ชิ้น 125.00
        เงินสด 200.00
        ทอน 75.00
        10/11/69 12:30""",
        dict(amount=125.0, date="2026-11-10", merchant="7-Eleven", hint="food"),
    ),
    (
        "Restaurant: subtotal + service + VAT -> grand total",
        """Somtum Der Silom
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
        Change               35.13""",
        dict(amount=364.87, date="2026-11-08", merchant="Somtum Der Silom", hint="food"),
    ),
    (
        "Thai OCR with spaced glyphs, Thai digits, Thai month",
        """ร้ า น ก า แ ฟ บ้ า น ส ว น
        ใบเสร็จรับเงิน
        วันที่ ๕ พ.ย. ๒๕๖๙
        ลาเต้เย็น ๖๕.๐๐
        ครัวซองต์ ๕๕.๐๐
        ย อ ด ร ว ม ๑๒๐.๐๐""",
        dict(amount=120.0, date="2026-11-05", merchant="ร้านกาแฟบ้านสวน", hint="food"),
    ),
    (
        "Fuel receipt, total on next line, ISO date",
        """บริษัท บางจาก คอร์ปอเรชั่น จำกัด
        2026-11-03 07:15
        แก๊สโซฮอล์ 95  32.45 ลิตร
        ราคา/ลิตร 37.85
        จำนวนเงินรวมทั้งสิ้น
        1,228.23
        VAT 7% 80.35""",
        dict(amount=1228.23, date="2026-11-03", merchant="Bangchak", hint="transport"),
    ),
    (
        "OCR noise: O instead of 0, comma decimal, 'TOTAL' in English",
        """TOPS market
        Central World
        MILK 1L          52.O0
        BREAD            45,00
        EGGS 10          89.00
        TOTAL           186,00
        VISA ****1234   186.00
        Nov 7, 2026""",
        dict(amount=186.0, date="2026-11-07", merchant="Tops", hint="shopping"),
    ),
    (
        "No keyword: cash minus change",
        """ร้านป้าแดง ข้าวแกง
        ข้าว+แกง 2 อย่าง 50.00
        ไข่ดาว 10.00
        เงินสด 100.00
        ทอน 40.00""",
        dict(amount=60.0, hint="food"),
    ),
    (
        "Whole-baht total, item count must not win",
        """ร้านก๋วยเตี๋ยวเรือ
        ก๋วยเตี๋ยว 3 ชาม
        รวม 3 รายการ
        ยอดรวม 135 บาท""",
        dict(amount=135.0, hint="food"),
    ),
    (
        "Electricity bill, Thai full month, net amount",
        """การไฟฟ้านครหลวง
        ใบเสร็จรับเงิน/ใบกำกับภาษี
        วันที่ 2 พฤศจิกายน 2569
        ค่าพลังงานไฟฟ้า 812.40
        ค่า Ft 31.20
        ภาษีมูลค่าเพิ่ม 59.05
        ยอดเงินสุทธิ 902.65""",
        dict(amount=902.65, date="2026-11-02", merchant="การไฟฟ้า", hint="utilities"),
    ),
]


def check(case):
    name, text, expect = case
    r = parse_receipt_text(text, TODAY)
    problems = []
    if r.amount != expect["amount"]:
        problems.append(f"amount {r.amount} != {expect['amount']} (candidates {r.candidates})")
    if "date" in expect and r.date != expect["date"]:
        problems.append(f"date {r.date} != {expect['date']}")
    if "merchant" in expect and r.merchant != expect["merchant"]:
        problems.append(f"merchant {r.merchant!r} != {expect['merchant']!r}")
    if "hint" in expect and r.category_hint != expect["hint"]:
        problems.append(f"hint {r.category_hint} != {expect['hint']}")
    return name, r, problems


@pytest.mark.parametrize("case", CASES, ids=[c[0] for c in CASES])
def test_parser(case):
    name, result, problems = check(case)
    assert not problems, problems


if __name__ == "__main__":
    bad = 0
    for case in CASES:
        name, r, problems = check(case)
        status = "OK " if not problems else "FAIL"
        bad += bool(problems)
        print(f"[{status}] {name}: amount={r.amount} ({r.confidence}) date={r.date} merchant={r.merchant!r} hint={r.category_hint}")
        for p in problems:
            print("        -", p)
    print(f"\n{len(CASES) - bad}/{len(CASES)} passed")
    sys.exit(1 if bad else 0)
