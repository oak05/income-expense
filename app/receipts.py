"""Receipt reading: image/PDF -> text (Tesseract / PDF text layer) -> total, date, shop, category."""
from __future__ import annotations

import datetime as dt
import io
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from functools import lru_cache

from PIL import Image, ImageFilter, ImageOps

try:  # iPhone HEIC photos
    from pillow_heif import register_heif_opener

    register_heif_opener()
except Exception:  # pragma: no cover - optional
    pass

MAX_PIXELS = 2000  # stored preview long edge
Image.MAX_IMAGE_PIXELS = 80_000_000


# --------------------------------------------------------------------------- #
# File -> preview image + text
# --------------------------------------------------------------------------- #
class ReceiptFileError(ValueError):
    pass


def is_pdf(raw: bytes) -> bool:
    return raw[:5] == b"%PDF-"


def load_image(raw: bytes) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(raw))
        img = ImageOps.exif_transpose(img)
        img.load()
    except Exception as e:
        raise ReceiptFileError("เปิดไฟล์รูปไม่ได้ (รองรับ JPG, PNG, WEBP, HEIC และ PDF)") from e
    if img.mode not in ("RGB", "L"):
        bg = Image.new("RGB", img.size, "white")
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            bg.paste(img, mask=img.split()[-1])
            img = bg
        else:
            img = img.convert("RGB")
    return img


def preview_jpeg(img: Image.Image) -> bytes:
    im = img.copy()
    im.thumbnail((MAX_PIXELS, MAX_PIXELS), Image.LANCZOS)
    out = io.BytesIO()
    im.convert("RGB").save(out, "JPEG", quality=85, optimize=True)
    return out.getvalue()


def pdf_to_image_and_text(raw: bytes) -> tuple[Image.Image, str]:
    import pypdfium2 as pdfium

    try:
        pdf = pdfium.PdfDocument(raw)
    except Exception as e:
        raise ReceiptFileError("เปิดไฟล์ PDF ไม่ได้") from e
    try:
        if len(pdf) == 0:
            raise ReceiptFileError("ไฟล์ PDF ไม่มีหน้า")
        texts = []
        for i in range(min(len(pdf), 3)):
            page = pdf[i]
            texts.append(page.get_textpage().get_text_range())
        first = pdf[0].render(scale=2).to_pil()
        return first, "\n".join(texts)
    finally:
        pdf.close()


@lru_cache(maxsize=1)
def tesseract_langs() -> str:
    exe = shutil.which("tesseract")
    if not exe:
        return ""
    try:
        out = subprocess.run([exe, "--list-langs"], capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return ""
    have = {line.strip() for line in out.splitlines()}
    langs = [lang for lang in ("tha", "eng") if lang in have]
    return "+".join(langs)


def ocr_available() -> bool:
    return bool(tesseract_langs())


def prepare_for_ocr(img: Image.Image) -> Image.Image:
    g = ImageOps.grayscale(img)
    # receipts photographed small -> upscale; huge photos -> downscale for speed
    long_edge = max(g.size)
    if long_edge < 1600:
        f = 1600 / long_edge
        g = g.resize((round(g.width * f), round(g.height * f)), Image.LANCZOS)
    elif long_edge > 3000:
        f = 3000 / long_edge
        g = g.resize((round(g.width * f), round(g.height * f)), Image.LANCZOS)
    g = ImageOps.autocontrast(g, cutoff=1)
    return g.filter(ImageFilter.SHARPEN)


def ocr_image(img: Image.Image) -> str:
    langs = tesseract_langs()
    if not langs:
        raise ReceiptFileError("ไม่พบโปรแกรมอ่านตัวอักษร (Tesseract) ในเครื่อง")
    buf = io.BytesIO()
    prepare_for_ocr(img).save(buf, "PNG")
    proc = subprocess.run(
        ["tesseract", "stdin", "stdout", "-l", langs, "--psm", "4"],
        input=buf.getvalue(),
        capture_output=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise ReceiptFileError("อ่านตัวอักษรจากรูปไม่สำเร็จ")
    return proc.stdout.decode("utf-8", "replace")


def read_receipt_file(raw: bytes) -> tuple[bytes, str, str]:
    """Returns (preview_jpeg_bytes, text, source) where source is 'pdf-text' | 'ocr'."""
    if is_pdf(raw):
        img, text = pdf_to_image_and_text(raw)
        preview = preview_jpeg(img)
        if len(re.sub(r"\s", "", text)) >= 20:  # e-receipt with a real text layer
            return preview, text, "pdf-text"
        return preview, ocr_image(img), "ocr"
    img = load_image(raw)
    return preview_jpeg(img), ocr_image(img), "ocr"


# --------------------------------------------------------------------------- #
# Text -> fields
# --------------------------------------------------------------------------- #
THAI_DIGITS = str.maketrans("๐๑๒๓๔๕๖๗๘๙", "0123456789")
THAI = r"฀-๿"

# money with 2 decimals: 1,250.00 / 125.00 / 125,00 (OCR'd comma) — thousands only with commas
MONEY_RE = re.compile(r"(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)\s?[.,]\s?(\d{2})(?![\d])")
# whole-baht amounts, only trusted on total lines: "รวม 125 บาท", "TOTAL ฿125"
WHOLE_RE = re.compile(r"(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d{1,7})(?![\d.,])")

STRONG = [
    "ยอดสุทธิ", "รวมทั้งสิ้น", "รวมสุทธิ", "ยอดรวมสุทธิ", "ยอดชำระ", "ยอดที่ต้องชำระ", "ชำระทั้งสิ้น",
    "รวมเงินทั้งสิ้น", "ยอดเงินสุทธิ", "จำนวนเงินรวมทั้งสิ้น", "จำนวนเงินทั้งสิ้น", "สุทธิ",
    "grandtotal", "nettotal", "totaldue", "amountdue", "totalamount", "netamount", "totalpayment",
    "totalpaid", "amountpaid", "balancedue", "totalthb", "totalbaht",
]
MEDIUM = ["ยอดรวม", "รวมเงิน", "total", "รวม", "ทั้งหมด", "amount", "ยอดเงิน"]
NEGATIVE = [
    "subtotal", "sub-total", "ก่อนภาษี", "ก่อนvat", "beforevat", "beforetax", "excl", "vat", "ภาษี",
    "ส่วนลด", "discount", "ทอน", "change", "เงินสด", "cash", "รับเงิน", "received", "tendered",
    "service", "ค่าบริการ", "ปัดเศษ", "rounding", "คะแนน", "point", "ประหยัด", "saving", "saved",
    "มูลค่าสินค้า", "ราคาต่อหน่วย", "unitprice", "@",
]
INCLUSIVE = ["incl", "includ", "inc.vat", "incvat", "vatinc", "รวมภาษีแล้ว", "รวมvatแล้ว"]

TH_MONTHS = {
    "มกราคม": 1, "มค": 1, "กุมภาพันธ์": 2, "กพ": 2, "มีนาคม": 3, "มีค": 3, "เมษายน": 4, "เมย": 4,
    "พฤษภาคม": 5, "พค": 5, "มิถุนายน": 6, "มิย": 6, "กรกฎาคม": 7, "กค": 7, "สิงหาคม": 8, "สค": 8,
    "กันยายน": 9, "กย": 9, "ตุลาคม": 10, "ตค": 10, "พฤศจิกายน": 11, "พย": 11, "ธันวาคม": 12, "ธค": 12,
}
EN_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}

# (pattern on compact lower-case text, display name, category hint)
BRANDS = [
    (r"7-?eleven|7-?11|เซเว่น|cpall|ซีพีออลล์|ซีพีออล", "7-Eleven", "food"),
    (r"familymart|แฟมิลี่มาร์ท", "FamilyMart", "food"),
    (r"lawson|ลอว์สัน", "Lawson 108", "food"),
    (r"lotus'?s|โลตัส|tesco", "Lotus's", "shopping"),
    (r"bigc|บิ๊กซี", "Big C", "shopping"),
    (r"makro|แม็คโคร|แมคโคร", "Makro", "shopping"),
    (r"topsmarket|\btops\b|ท็อปส์", "Tops", "shopping"),
    (r"villamarket|วิลล่ามาร์เก็ต", "Villa Market", "shopping"),
    (r"starbucks|สตาร์บัคส์", "Starbucks", "food"),
    (r"cafeamazon|caféamazon|คาเฟ่อเมซอน", "Café Amazon", "food"),
    (r"mcdonald|แมคโดนัลด์", "McDonald's", "food"),
    (r"kfc|เคเอฟซี", "KFC", "food"),
    (r"mksuki|mkrestaurant|เอ็มเคสุกี้|เอ็มเค", "MK", "food"),
    (r"swensen|สเวนเซ่นส์", "Swensen's", "food"),
    (r"pizzacompany|pizzahut|พิซซ่า", "Pizza", "food"),
    (r"after\s?you|อาฟเตอร์ยู", "After You", "food"),
    (r"grabfood", "GrabFood", "food"),
    (r"\bgrab\b|grabtaxi|grabcar", "Grab", "transport"),
    (r"lineman|ไลน์แมน", "LINE MAN", "food"),
    (r"foodpanda", "foodpanda", "food"),
    (r"\bbolt\b", "Bolt", "transport"),
    (r"btsskytrain|\bbts\b|รถไฟฟ้าบีทีเอส", "BTS", "transport"),
    (r"\bmrt\b|bemetro|รถไฟฟ้ามหานคร", "MRT", "transport"),
    (r"\bptt\b|pttstation|ปตท", "PTT", "transport"),
    (r"shell|เชลล์", "Shell", "transport"),
    (r"bangchak|บางจาก", "Bangchak", "transport"),
    (r"esso|เอสโซ่", "Esso", "transport"),
    (r"caltex|คาลเท็กซ์", "Caltex", "transport"),
    (r"watsons|วัตสัน", "Watsons", "health"),
    (r"boots|บู๊ทส์", "Boots", "health"),
    (r"โรงพยาบาล|hospital", "", "health"),
    (r"คลินิก|clinic", "", "health"),
    (r"ร้านยา|pharmacy|เภสัช", "", "health"),
    (r"การไฟฟ้านครหลวง|การไฟฟ้าส่วนภูมิภาค|\bmea\b|\bpea\b", "การไฟฟ้า", "utilities"),
    (r"การประปา|\bmwa\b|\bpwa\b", "การประปา", "utilities"),
    (r"advancedinfo|\bais\b|เอไอเอส", "AIS", "utilities"),
    (r"truemove|trueonline|ทรูมูฟ|ทรูออนไลน์", "True", "utilities"),
    (r"dtac|ดีแทค", "dtac", "utilities"),
    (r"3bb|ทริปเปิลที", "3BB", "utilities"),
    (r"majorcineplex|เมเจอร์ซีนีเพล็กซ์|sfcinema|เอสเอฟ", "โรงภาพยนตร์", "entertainment"),
    (r"shopee|ช้อปปี้", "Shopee", "shopping"),
    (r"lazada|ลาซาด้า", "Lazada", "shopping"),
    (r"homepro|โฮมโปร", "HomePro", "shopping"),
    (r"ikea|อิเกีย", "IKEA", "shopping"),
    (r"uniqlo|ยูนิโคล่", "Uniqlo", "shopping"),
    (r"central|เซ็นทรัล|robinson|โรบินสัน", "", "shopping"),
    (r"se-?ed|ซีเอ็ด|asiabooks|kinokuniya|นายอินทร์|naiin", "", "education"),
]
TEXT_HINTS = [
    (r"ร้านอาหาร|restaurant|cafe|café|coffee|กาแฟ|ก๋วยเตี๋ยว|ข้าว|ชานม|bakery|เบเกอรี่|อาหาร|food|drink|เครื่องดื่ม|"
     r"servicecharge|ค่าบริการ\d|table\d|โต๊ะ\d|guests?\d|ส้มตำ|somtum|ชาบู|shabu|หมูกระทะ|สุกี้|sushi|ซูชิ|ramen|ราเมน|"
     r"steak|สเต็ก|bistro|kitchen|noodle|ปิ้งย่าง|bbq|บุฟเฟ่ต์|buffet|ชา|tea|เบียร์|beer", "food"),
    (r"น้ำมัน|fuel|gasohol|แก๊สโซฮอล์|ดีเซล|diesel|e20|e85|เบนซิน|ค่าทางด่วน|ทางพิเศษ|taxi|แท็กซี่|parking|ที่จอดรถ", "transport"),
    (r"ค่าไฟ|ไฟฟ้า|electricity|ค่าน้ำประปา|internet|อินเทอร์เน็ต|ค่าโทรศัพท์|mobile|broadband", "utilities"),
    (r"โรงพยาบาล|hospital|clinic|คลินิก|pharmacy|ยา|dental|ทันตกรรม", "health"),
    (r"cinema|movie|ภาพยนตร์|ตั๋วหนัง|ticket|concert|คอนเสิร์ต|game|เกม", "entertainment"),
    (r"หนังสือ|book|course|คอร์ส|tuition|ค่าเรียน|ค่าเทอม|seminar|สัมมนา", "education"),
    (r"ค่าเช่า|rent|ค่าห้อง|หอพัก|condo|คอนโด|ค่าส่วนกลาง", "housing"),
]
# which default category each hint maps to (by name; falls back to a keyword match)
HINT_CATEGORY_NAMES = {
    "food": ["อาหารและเครื่องดื่ม", "อาหาร"],
    "transport": ["เดินทาง"],
    "utilities": ["ค่าน้ำ ค่าไฟ ค่าเน็ต", "ค่าน้ำ", "ค่าไฟ", "สาธารณูปโภค"],
    "shopping": ["ช้อปปิ้ง"],
    "health": ["สุขภาพ"],
    "entertainment": ["บันเทิง"],
    "education": ["การศึกษา"],
    "housing": ["ที่พัก / ค่าเช่า", "ที่พัก", "ค่าเช่า"],
}

BOILERPLATE = re.compile(
    r"ใบเสร็จ|ใบกำกับ|receipt|tax|invoice|สาขา|branch|tel|โทร|เลขประจำตัว|เลขที่|pos|vat|date|วันที่|เวลา|time|"
    r"abb|cashier|พนักงาน|สำนักงานใหญ่|head\s?office|welcome|ยินดีต้อนรับ|copy|สำเนา|order|table|โต๊ะ|"
    r"^\W*$|\d{5,}", re.I)


@dataclass
class ParsedReceipt:
    amount: float | None = None
    confidence: str = "none"  # high | medium | low | none
    candidates: list[float] = field(default_factory=list)
    date: str | None = None
    merchant: str = ""
    category_hint: str | None = None


def normalize_text(text: str) -> str:
    text = text.translate(THAI_DIGITS).replace("​", "").replace("\r", "")
    # Tesseract often spaces out Thai glyphs: "ย อ ด ร ว ม" -> "ยอดรวม"
    text = re.sub(rf"(?<=[{THAI}])[ \t]+(?=[{THAI}])", "", text)
    # "1 2 5 . 0 0"-style splits are rare; fix "125 .00" / "125. 00"
    text = re.sub(r"(\d)\s+([.,]\d{2})(?!\d)", r"\1\2", text)
    text = re.sub(r"(\d[.,])\s+(\d{2})(?!\d)", r"\1\2", text)
    # common OCR letter/digit confusions inside numbers: O/o->0, l/I->1 when surrounded by digits
    text = re.sub(r"(?<=\d)[Oo](?=[\d.,])|(?<=[\d.,])[Oo](?=\d)", "0", text)
    text = re.sub(r"(?<=\d)[lI|](?=[\d.,])|(?<=[\d.,])[lI|](?=\d)", "1", text)
    return text


def _compact(s: str) -> str:
    return re.sub(r"\s+", "", s.lower())


COUNT_WORDS = re.compile(r"^\s*(ชิ้น|รายการ|อัน|items?|pcs|qty|ea\b|x\b|%)", re.I)


def _money_on(line: str, allow_whole: bool) -> tuple[list[float], bool]:
    """Money amounts on a line -> (values, used_whole_numbers)."""
    vals = []
    for m in MONEY_RE.finditer(line):
        v = float(m.group(1).replace(",", "") + "." + m.group(2))
        if 0 < v < 10_000_000:
            vals.append(v)
    if vals or not allow_whole:
        return vals, False
    # strip dates/times so "10/11/69 12:30" doesn't look like money
    cleaned = re.sub(r"\d{1,4}[/\-.:]\d{1,2}(?:[/\-.:]\d{1,4})?", " ", line)
    for m in WHOLE_RE.finditer(cleaned):
        if COUNT_WORDS.match(cleaned[m.end():]):  # "4 ชิ้น", "3 items", "10%"
            continue
        v = float(m.group(1).replace(",", ""))
        if 0 < v < 10_000_000:
            vals.append(v)
    return vals, bool(vals)


def _line_score(compact: str, line: str = "") -> tuple[int, str]:
    strong = any(k in compact for k in STRONG)
    medium = any(k in compact for k in MEDIUM) or bool(re.search(r"\bnet\b", line.lower()))
    score = 10 if strong else 6 if medium else 0
    negs = [k for k in NEGATIVE if k in compact]
    if negs and any(k in compact for k in INCLUSIVE):
        negs = [k for k in negs if k not in ("vat", "ภาษี")]
    if negs:
        score -= 8
    level = "high" if strong and not negs else "medium" if score > 0 else ""
    return score, level


def find_total(lines: list[str]) -> tuple[float | None, str, list[float]]:
    n = len(lines)
    scored: list[tuple[float, float, str]] = []  # (score, value, level)
    all_vals: list[tuple[float, float]] = []  # (score, value) for candidates
    cash = change = None

    for i, line in enumerate(lines):
        c = _compact(line)
        score, level = _line_score(c, line)
        vals, whole = _money_on(line, allow_whole=score > 0)
        if whole:
            score -= 2  # "รวม 125" is less certain than "รวม 125.00"
        position = 2.0 * i / max(n - 1, 1)  # totals sit near the bottom
        if score > 0 and not vals and i + 1 < n:
            nxt, _ = _money_on(lines[i + 1], allow_whole=True)
            if nxt and _line_score(_compact(lines[i + 1]), lines[i + 1])[0] <= 0:
                vals, score = nxt[-1:], score - 1
        for v in vals:
            all_vals.append((score + position, v))
        if score > 0 and vals:
            scored.append((score + position, max(vals), level))
        if ("เงินสด" in c or "cash" in c) and vals:
            cash = vals[-1]
        if ("ทอน" in c or "change" in c) and vals:
            change = vals[-1]

    chosen, confidence = None, "none"
    if scored:
        scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
        chosen, confidence = scored[0][1], scored[0][2] or "medium"
    elif cash is not None and change is not None and cash > change:
        chosen, confidence = round(cash - change, 2), "medium"
    else:
        plain = [v for s, v in all_vals if s >= 0 and v != cash]
        if plain:
            chosen, confidence = max(plain), "low"

    seen, candidates = set(), []
    for _, v in sorted(all_vals, key=lambda x: (x[0], x[1]), reverse=True):
        if v != chosen and v not in seen:
            seen.add(v)
            candidates.append(v)
    return chosen, confidence, candidates[:6]


def _resolve_year(y: int, today: dt.date) -> list[int]:
    if y >= 2400:
        return [y - 543]
    if y >= 1900:
        return [y]
    if y < 100:  # 2-digit: could be ค.ศ. (26) or พ.ศ. (69)
        return sorted({2000 + y, 2500 + y - 543}, key=lambda c: abs(c - today.year))
    return []


def _valid(y: int, m: int, d: int, today: dt.date) -> dt.date | None:
    try:
        date = dt.date(y, m, d)
    except ValueError:
        return None
    if date > today + dt.timedelta(days=1) or date < today - dt.timedelta(days=365 * 3):
        return None
    return date


def find_date(text: str, today: dt.date | None = None) -> str | None:
    today = today or dt.date.today()
    found: list[tuple[int, dt.date]] = []

    def add(pos: int, y: int, m: int, d: int, swap_ok: bool = True):
        for yy in _resolve_year(y, today):
            date = _valid(yy, m, d, today) or (swap_ok and _valid(yy, d, m, today))
            if date:
                found.append((pos, date))
                return

    for m in re.finditer(r"(?<!\d)(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?!\d)", text):
        add(m.start(), int(m.group(1)), int(m.group(2)), int(m.group(3)), swap_ok=False)
    for m in re.finditer(r"(?<![\d.])(\d{1,2})\s?[/\-.]\s?(\d{1,2})\s?[/\-.]\s?(\d{4}|\d{2})(?![\d])", text):
        add(m.start(), int(m.group(3)), int(m.group(2)), int(m.group(1)))

    flat = re.sub(r"[.\s]", "", text.lower())
    th_alt = "|".join(sorted(TH_MONTHS, key=len, reverse=True))
    for m in re.finditer(rf"(?<!\d)(\d{{1,2}})({th_alt})(\d{{4}}|\d{{2}})(?!\d)", flat):
        add(m.start(), int(m.group(3)), TH_MONTHS[m.group(2)], int(m.group(1)), swap_ok=False)
    low = text.lower()
    en_alt = "|".join(EN_MONTHS)
    for m in re.finditer(rf"(?<!\d)(\d{{1,2}})[\s\-]*({en_alt})[a-z]*\.?[\s\-,]*(\d{{4}}|\d{{2}})(?!\d)", low):
        add(m.start(), int(m.group(3)), EN_MONTHS[m.group(2)], int(m.group(1)), swap_ok=False)
    for m in re.finditer(rf"\b({en_alt})[a-z]*\.?\s+(\d{{1,2}}),?\s+(\d{{4}})(?!\d)", low):
        add(m.start(), int(m.group(3)), EN_MONTHS[m.group(1)], int(m.group(2)), swap_ok=False)

    if not found:
        return None
    found.sort(key=lambda x: x[0])
    return found[0][1].isoformat()


def find_merchant(lines: list[str], compact_all: str) -> tuple[str, str | None]:
    haystack = "\n".join(lines).lower() + "\n" + compact_all
    for pattern, name, hint in BRANDS:
        if re.search(pattern, haystack):
            if name:
                return name, hint
            break
    for line in lines[:8]:
        s = re.sub(r"[^\w\s&'.\-/()" + THAI + "]", " ", line).strip(" .-/")
        s = re.sub(r"\s{2,}", " ", s)
        letters = re.findall(rf"[A-Za-z{THAI}]", s)
        if len(letters) >= 3 and not BOILERPLATE.search(s) and not _money_on(s, False)[0]:
            return s[:60], None
    return "", None


def guess_hint(compact_all: str, brand_hint: str | None) -> str | None:
    if brand_hint:
        return brand_hint
    for pattern, hint in TEXT_HINTS:
        if re.search(pattern, compact_all):
            return hint
    return None


def parse_receipt_text(text: str, today: dt.date | None = None) -> ParsedReceipt:
    text = normalize_text(text or "")
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    compact_all = _compact(text)
    amount, confidence, candidates = find_total(lines)
    merchant, brand_hint = find_merchant(lines, compact_all)
    return ParsedReceipt(
        amount=amount,
        confidence=confidence,
        candidates=candidates,
        date=find_date(text, today),
        merchant=merchant,
        category_hint=guess_hint(compact_all, brand_hint),
    )
