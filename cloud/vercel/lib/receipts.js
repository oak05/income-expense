// Receipt upload: store the file in Supabase Storage, read it with OCR, find the total/date/shop, save a draft.
import { randomUUID } from "node:crypto";
import { config, HttpError } from "./server.js";
import { ocrText } from "./ocr.js";
import { HINT_CATEGORY_NAMES, parseReceiptText } from "./parser.js";
import { rpc, storageRemove, storageUpload } from "./supabase.js";

const MAX_RECEIPT_BYTES = 2.5 * 1024 * 1024; // Drive OCR works best under ~2 MB; the browser shrinks photos first
const EXT = { "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf" };
const OCR_FAILED = "อ่านตัวอักษรจากไฟล์ไม่สำเร็จ ใส่ยอดเองได้";

/** The file type from its first bytes, never from the name or what the browser claims. */
export function sniffMime(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 7 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
  return "";
}

/** Today's date in Thailand, YYYY-MM-DD. */
export function todayBangkok(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(now));
}

/** receipts.upload {name, data: base64} for the signed-in user -> the new draft (api_receipts_create's answer). */
export async function uploadReceipt(user, params, cfg = config()) {
  const data = typeof params.data === "string" ? params.data : "";
  if (!data) throw new HttpError(400, "ไม่มีไฟล์");
  if (data.length > MAX_RECEIPT_BYTES * 4 / 3 + 8) throw new HttpError(413, "ไฟล์ใหญ่เกิน 2.5 MB");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new HttpError(400, "อ่านไฟล์ไม่ได้");
  const bytes = Buffer.from(data, "base64");
  const mime = sniffMime(bytes);
  if (!EXT[mime]) throw new HttpError(400, "รองรับเฉพาะรูป JPG, PNG และไฟล์ PDF");

  const path = `${user.id}/${randomUUID()}.${EXT[mime]}`;
  await storageUpload(user.token, path, bytes, mime, cfg);

  let text = "", error = "";
  try {
    text = await ocrText(bytes, mime, cfg);
  } catch (err) { // keep the receipt; the amount can be typed in
    console.warn("OCR failed:", err?.status, err?.message);
    error = err instanceof HttpError && err.status === 503 ? err.message : OCR_FAILED;
  }
  const today = todayBangkok();
  const parsed = parseReceiptText(text, today);
  const flags = [];
  if (parsed.amount === null) flags.push("no_amount");
  else if (parsed.confidence === "low") flags.push("check_amount");
  if (parsed.date === null) flags.push("no_date");

  try {
    return await rpc("api_receipts_create", {
      merchant: parsed.merchant || "", amount: parsed.amount, date: parsed.date || today,
      hint_names: HINT_CATEGORY_NAMES[parsed.category_hint] || [], storage_path: path, size: bytes.length, mime,
      original_name: typeof params.name === "string" ? params.name.slice(0, 200) : "",
      text_source: mime === "application/pdf" ? "drive-pdf" : "drive-ocr", confidence: parsed.confidence,
      candidates: parsed.candidates || [], flags, error, ocr_text: text.slice(0, 4000),
    }, user.token, cfg);
  } catch (err) {
    try {
      await storageRemove(user.token, [path], cfg); // don't leave a file nobody points at
    } catch (cleanup) {
      console.error("could not remove orphan receipt file", path, cleanup?.message);
    }
    throw err;
  }
}
