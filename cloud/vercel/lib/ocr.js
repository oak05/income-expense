// Receipt OCR: the Apps Script web app (cloud/apps-script/Ocr.gs) turns an image or PDF into text with Google Drive.
// It keeps nothing; the file itself is stored in Supabase Storage.
import { config, HttpError } from "./server.js";

const TIMEOUT_MS = 55_000;

/** POSTs {secret, mime, data} and returns the text, or throws HttpError (503 = Apps Script set up incompletely). */
export async function ocrText(bytes, mime, cfg = config()) {
  let res;
  try {
    res = await fetch(cfg.ocrUrl, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" }, // a "simple" body Apps Script accepts as-is
      body: JSON.stringify({ secret: cfg.ocrSecret, mime, data: Buffer.from(bytes).toString("base64") }),
      redirect: "follow", // Apps Script answers with a redirect to the real response
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error("ocr unreachable:", err?.name, err?.message);
    throw new HttpError(504, "ติดต่อ Apps Script (อ่านใบเสร็จ) ไม่ได้หรือใช้เวลานานเกินไป");
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // Apps Script answers with an HTML page when the URL is wrong, the deployment is not public, or the script crashed
    console.error("ocr returned non-JSON:", res.status, text.slice(0, 300));
    throw new HttpError(502, "Apps Script (อ่านใบเสร็จ) ตอบกลับผิดรูปแบบ — ตรวจ APPS_SCRIPT_URL และการ deploy แบบ Web app (Anyone)");
  }
  if (body && body.ok === true) return String(body.data?.text || "");
  if (body && body.status === 401) {
    console.error("ocr refused the secret");
    throw new HttpError(502, "Apps Script ไม่ยอมรับรหัสลับ — ตรวจว่า APPS_SCRIPT_SECRET ใน Vercel ตรงกับที่ setup() แสดง");
  }
  if (body?.detail) console.warn("ocr failed in Apps Script:", String(body.detail).slice(0, 500)); // for the logs only
  const status = Number(body?.status);
  throw new HttpError(status >= 400 && status <= 599 ? status : 502, String(body?.error || "อ่านใบเสร็จไม่สำเร็จ"));
}
