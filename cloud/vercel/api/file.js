// GET /api/file?id=12 -> the receipt image or PDF kept in Google Drive, for a signed-in user
import { callBackend, handler, HttpError, requireSession } from "../lib/server.js";

const TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);

export const GET = handler(async (request) => {
  requireSession(request);
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "ไม่พบไฟล์");
  const file = await callBackend("receipts.file", { id });
  if (!TYPES.has(file.mime)) throw new HttpError(415, "ไฟล์ชนิดนี้เปิดดูไม่ได้");
  return new Response(Buffer.from(file.data, "base64"), {
    headers: {
      "content-type": file.mime,
      "content-disposition": `inline; filename="receipt-${id}.${file.mime === "application/pdf" ? "pdf" : file.mime === "image/png" ? "png" : "jpg"}"`,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
});
