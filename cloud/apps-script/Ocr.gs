/**
 * สมุดรายรับรายจ่าย — receipt OCR on Google Apps Script.
 *
 * Google Drive turns an image or PDF into a temporary Google Doc; its text is the OCR result. The Doc is deleted
 * straight away and nothing else is kept: receipt files and all data live in Supabase.
 *
 * The Vercel app is the only caller: it POSTs {secret, mime, data (base64)} and gets {ok, data: {text}}.
 * First-time use: add the Drive API service, run setup() once, deploy as a web app (see cloud/README.md).
 */

const OCR_VERSION = '3.0.0';
const MAX_RECEIPT_BYTES = 2.5 * 1024 * 1024; // Drive OCR works best under ~2 MB; the browser shrinks photos first
const RECEIPT_MIMES = { 'image/jpeg': 1, 'image/png': 1, 'application/pdf': 1 };

function ApiError(status, message) {
  this.status = status;
  this.message = message;
}

function fail_(status, message) {
  throw new ApiError(status, message);
}

function props_() {
  return PropertiesService.getScriptProperties();
}

/** Drive turns an image or PDF into a temporary Google Doc; its text is the OCR result. */
function ocrText_(blob) {
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

function read_(params) {
  const mime = String(params.mime || '');
  if (!RECEIPT_MIMES[mime]) fail_(400, 'รองรับเฉพาะรูป JPG, PNG และไฟล์ PDF');
  const data = String(params.data || '');
  if (!data) fail_(400, 'ไม่มีไฟล์');
  if (data.length > MAX_RECEIPT_BYTES * 4 / 3 + 8) fail_(413, 'ไฟล์ใหญ่เกิน 2.5 MB');
  let bytes;
  try {
    bytes = Utilities.base64Decode(data);
  } catch (e) {
    fail_(400, 'อ่านไฟล์ไม่ได้');
  }
  if (!bytes.length) fail_(400, 'ไม่มีไฟล์');
  if (bytes.length > MAX_RECEIPT_BYTES) fail_(413, 'ไฟล์ใหญ่เกิน 2.5 MB');
  if (typeof Drive === 'undefined') {
    fail_(503, 'ยังไม่ได้เพิ่มบริการ Drive API ใน Apps Script (Services → + → Drive API) จึงอ่านตัวอักษรไม่ได้ ใส่ยอดเองได้');
  }
  try {
    return { text: ocrText_(Utilities.newBlob(bytes, mime, 'receipt')) || '' };
  } catch (e) {
    console.warn('OCR failed: ' + e);
    fail_(502, 'อ่านตัวอักษรจากไฟล์ไม่สำเร็จ ใส่ยอดเองได้');
  }
}

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
    if (!body || typeof body !== 'object') fail_(400, 'bad request');
    if (!secretOk_(body.secret)) fail_(401, 'unauthorized');
    out = { ok: true, data: read_(body) };
  } catch (err) {
    if (err instanceof ApiError) {
      out = { ok: false, status: err.status, error: err.message };
    } else {
      console.error(err && err.stack ? err.stack : err);
      out = { ok: false, status: 500, error: 'เกิดข้อผิดพลาดที่ Apps Script: ' + (err && err.message ? err.message : err) };
    }
  }
  return json_(out);
}

/** Opening the web app URL in a browser shows nothing useful: OCR needs the secret, by POST. */
function doGet() {
  return ContentService.createTextOutput('income-expense ocr ' + OCR_VERSION);
}

/* ------------------------------------------------------------------ run from the editor */

/** Run once: creates the secret Vercel needs (APPS_SCRIPT_SECRET). Safe to re-run. */
function setup() {
  const p = props_();
  if (!p.getProperty('API_SECRET')) p.setProperty('API_SECRET', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  Logger.log('ตั้งค่าเสร็จแล้ว');
  Logger.log('APPS_SCRIPT_SECRET (ใส่ใน Vercel): ' + p.getProperty('API_SECRET'));
  return { secret: p.getProperty('API_SECRET') };
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
