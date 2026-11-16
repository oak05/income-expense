// Local stand-in for the whole cloud setup, with no Supabase, Google or Vercel account needed:
//   - "Supabase": dev/fake-supabase.mjs over PGlite with the real migrations in cloud/supabase/migrations
//   - "Apps Script OCR": the real Ocr.gs on fake Google services, whose "Drive OCR" returns sample receipt texts
//   - "Vercel": the real functions from cloud/vercel/api and the static files from cloud/vercel/public
//
//   node cloud/dev/server.mjs            -> http://localhost:3000  (dev@example.com / dev-password)
//
// Used by the tests and for trying the app before deploying. Data is gone when the process stops.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, createUser } from "./pg.mjs";
import { startFakeSupabase } from "./fake-supabase.mjs";
import { loadOcr } from "./fake-google.mjs";

const VERCEL_DIR = fileURLToPath(new URL("../vercel/", import.meta.url));
const PUBLIC_DIR = join(VERCEL_DIR, "public");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".svg": "image/svg+xml", ".json": "application/json", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};
const SAMPLE_OCR = [
  "7-ELEVEN\nบริษัท ซีพี ออลล์ จำกัด (มหาชน)\nโออิชิ กรีนที 20.00\nข้าวกะเพราไก่ 45.00\nรวม 2 ชิ้น 65.00\nเงินสด 100.00\nทอน 35.00",
  "Somtum Der\nTable 5 Guests 2\nSom Tum Thai 120.00\nLarb Moo 150.00\nSub Total 270.00\nService Charge 10% 27.00\nVAT 7% 20.79\nGrand Total 317.79",
  "บริษัท บางจาก คอร์ปอเรชั่น จำกัด\nแก๊สโซฮอล์ 95 32.45 ลิตร\nจำนวนเงินรวมทั้งสิ้น\n1,228.23",
];

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * The OCR web app: the real Ocr.gs on the fake Google services. Like the real deployment, a POST is answered with
 * a redirect to the JSON. `ocr()` plays Drive OCR: it returns the text, or throws to act like a Drive failure.
 */
async function startOcrServer(ocr, port = 0) {
  const backend = loadOcr({ ocr });
  backend.setup();
  const responses = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/macros/s/FAKE/exec") {
      const body = (await readBody(req)).toString("utf8");
      const out = backend.gs.doPost({ postData: { contents: body, type: req.headers["content-type"] } });
      const id = randomUUID();
      responses.set(id, out.getContent());
      res.writeHead(302, { location: `/macros/echo?id=${id}` }).end();
    } else if (req.method === "GET" && url.pathname === "/macros/echo" && responses.has(url.searchParams.get("id"))) {
      const text = responses.get(url.searchParams.get("id"));
      responses.delete(url.searchParams.get("id"));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(text);
    } else {
      res.writeHead(404, { "content-type": "text/html" }).end("<html><body>Page not found</body></html>");
    }
  });
  const actualPort = await listen(server, port);
  return { server, backend, secret: backend.secret, url: `http://127.0.0.1:${actualPort}/macros/s/FAKE/exec` };
}

function staticHeaders(pathname) {
  const config = JSON.parse(readFileSync(join(VERCEL_DIR, "vercel.json"), "utf8"));
  const out = {};
  for (const rule of config.headers || []) {
    if (new RegExp("^" + rule.source + "$").test(pathname)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

async function sendWebResponse(res, response, extraHeaders = {}) {
  const headers = {};
  for (const [k, v] of Object.entries(extraHeaders)) headers[k.toLowerCase()] = v; // one value per header name
  response.headers.forEach((value, key) => { if (key !== "set-cookie") headers[key] = value; });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** The fake Vercel: /api/<name> runs cloud/vercel/api/<name>.js, everything else is a file from public/. */
async function startAppServer(port = 3000) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const extra = staticHeaders(url.pathname);
      const api = /^\/api\/([a-z]+)$/.exec(url.pathname);
      if (api) {
        let mod;
        try {
          mod = await import(pathToFileURL(join(VERCEL_DIR, "api", api[1] + ".js")).href);
        } catch (err) {
          if (err.code !== "ERR_MODULE_NOT_FOUND") throw err;
        }
        const handler = mod && mod[req.method];
        if (!handler) return void res.writeHead(mod ? 405 : 404, extra).end();
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
        if (body && body.length > 4.5 * 1024 * 1024) { // what Vercel itself does before the function runs
          return void res.writeHead(413, { ...extra, "content-type": "text/plain" }).end("FUNCTION_PAYLOAD_TOO_LARGE");
        }
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
        headers.set("x-forwarded-for", req.socket.remoteAddress || "127.0.0.1"); // Vercel sets this itself
        const request = new Request(url, { method: req.method, headers, body });
        return void (await sendWebResponse(res, await handler(request), extra));
      }
      if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, extra).end();
      const rel = normalize(decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
      const file = join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR)) return void res.writeHead(403, extra).end();
      try {
        const data = await readFile(file);
        res.writeHead(200, { ...extra, "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(data);
      } catch {
        res.writeHead(404, { ...extra, "content-type": "text/plain; charset=utf-8" }).end("Not found");
      }
    } catch (err) {
      console.error(err);
      res.writeHead(500).end("dev server error");
    }
  });
  const actualPort = await listen(server, port);
  return { server, url: `http://localhost:${actualPort}` };
}

export const DEV_USERS = {
  a: { email: "dev@example.com", password: "dev-password" },
  b: { email: "dev2@example.com", password: "dev-password" },
};

/**
 * Starts the fake Supabase, the fake OCR and the app, and points the Vercel functions at them through process.env.
 * @returns {Promise<{url: string, db: object, supabase: object, ocr: object, users: typeof DEV_USERS, mailbox: object[], close: () => Promise<void>}>}
 */
export async function startDev({ port = 3000, ocr, accessTtlSeconds = 3600, log = false } = {}) {
  let n = 0;
  const db = await createDb();
  for (const u of Object.values(DEV_USERS)) await createUser(db, u);
  const supabase = await startFakeSupabase({ db, accessTtlSeconds, log });
  const ocrServer = await startOcrServer(ocr || (() => SAMPLE_OCR[n++ % SAMPLE_OCR.length]));
  Object.assign(process.env, {
    SUPABASE_URL: supabase.url,
    SUPABASE_ANON_KEY: supabase.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: supabase.serviceKey,
    APPS_SCRIPT_URL: ocrServer.url,
    APPS_SCRIPT_SECRET: ocrServer.secret,
  });
  const app = await startAppServer(port);
  supabase.siteUrl = app.url;
  const stop = (s) => new Promise((r) => { s.closeAllConnections(); s.close(r); });
  const close = async () => {
    await Promise.all([stop(app.server), stop(ocrServer.server), supabase.close()]);
    await db.close();
  };
  return { url: app.url, db, supabase, ocr: ocrServer, users: DEV_USERS, mailbox: supabase.mailbox, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dev = await startDev({ port: Number(process.env.PORT) || 3000, log: true });
  console.log(`\n  สมุดรายรับรายจ่าย (โหมดทดลองในเครื่อง)\n  เปิด: ${dev.url}`
    + `\n  บัญชีทดลอง: ${DEV_USERS.a.email} / ${DEV_USERS.a.password}  และ  ${DEV_USERS.b.email} / ${DEV_USERS.b.password}`
    + "\n  อีเมล (ยืนยันการสมัคร / ตั้งรหัสผ่านใหม่) จะแสดงในหน้าต่างนี้แทนการส่งจริง"
    + "\n  ข้อมูลอยู่ในหน่วยความจำ ปิดโปรแกรมแล้วหาย — OCR เป็นข้อความตัวอย่าง ไม่ได้อ่านรูปจริง\n");
}
