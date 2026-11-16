// GET /api/file?id=12 -> the receipt image or PDF kept in Supabase Storage, for its owner
import { handler, HttpError } from "../lib/server.js";
import { rpc, storageDownload } from "../lib/supabase.js";
import { hasSessionCookie, withUser } from "../lib/session.js";

const EXT = { "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf" };

export const GET = handler(async (request) => {
  if (!hasSessionCookie(request)) throw new HttpError(401, "ยังไม่ได้เข้าสู่ระบบ");
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "ไม่พบไฟล์");
  return withUser(request, async (user) => {
    const info = await rpc("api_receipts_file", { id }, user.token);
    if (!EXT[info.mime]) throw new HttpError(415, "ไฟล์ชนิดนี้เปิดดูไม่ได้");
    const file = await storageDownload(user.token, info.storage_path);
    if (!file) throw new HttpError(404, "ไม่พบไฟล์ใบเสร็จ");
    return new Response(file.bytes, {
      headers: {
        "content-type": info.mime, // what the database recorded from the file's bytes, not what Storage says
        "content-disposition": `inline; filename="receipt-${id}.${EXT[info.mime]}"`,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  });
});
