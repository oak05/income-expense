// The Apps Script OCR endpoint (Ocr.gs) running on the fake Google services.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadOcr } from "../dev/fake-google.mjs";

const JPEG = readFileSync(new URL("../../tests/fixtures/receipt-restaurant.jpg", import.meta.url));
const TEXT = "7-ELEVEN\nรวม 2 ชิ้น 125.00";

function start(opts = {}) {
  const o = loadOcr({ ocr: () => TEXT, ...opts });
  o.setup();
  return o;
}
const req = (o, extra = {}) => o.post({ secret: o.secret, mime: "image/jpeg", data: JPEG.toString("base64"), ...extra });

test("setup creates a secret once; re-running keeps it; rotateSecret replaces it", () => {
  const o = start();
  assert.match(o.secret, /^[0-9a-f]{64}$/);
  const first = o.secret;
  o.setup();
  assert.equal(o.secret, first);
  o.gs.rotateSecret();
  assert.notEqual(o.state.props.get("API_SECRET"), first);
});

test("requests without the right secret get nothing", () => {
  const o = start();
  for (const secret of [undefined, "", "wrong", o.secret + "x", 12345]) {
    assert.deepEqual(req(o, { secret }), { ok: false, status: 401, error: "unauthorized" });
  }
  assert.equal(JSON.parse(o.gs.doPost({ postData: { contents: "not json" } }).getContent()).status, 400);
  assert.equal(JSON.parse(o.gs.doPost({}).getContent()).status, 400);
  assert.match(o.gs.doGet().getContent(), /^income-expense ocr 3\.0\.0/);
});

test("returns the OCR text and leaves no file behind", () => {
  let seen;
  const o = start({ ocr: (bytes, mime, options) => { seen = { bytes, mime, options }; return TEXT; } });
  assert.deepEqual(req(o), { ok: true, data: { text: TEXT } });
  assert.ok(seen.bytes.equals(JPEG), "the bytes reach Drive unchanged");
  assert.equal(seen.mime, "image/jpeg");
  assert.equal(seen.options.ocrLanguage, "th");
  assert.equal(o.state.docs.size, 0, "the temporary OCR document is removed");
});

test("v2 Drive API is used when v3 is not there", () => {
  const o = start();
  const v3 = o.context.Drive.Files.create;
  o.context.Drive.Files.insert = (meta, blob, opts) => v3({ mimeType: meta.mimeType }, blob, opts);
  delete o.context.Drive.Files.create;
  assert.deepEqual(req(o), { ok: true, data: { text: TEXT } });
});

test("missing Drive service gives 503 with the Thai message", () => {
  const o = start();
  delete o.context.Drive;
  const r = req(o);
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.match(r.error, /Drive API/);
});

test("a Drive failure is a 502, not a crash", () => {
  const o = start();
  o.state.ocrFails = true;
  const r = req(o);
  assert.equal(r.status, 502);
  assert.equal(o.state.docs.size, 0);
});

test("oversized or unknown files are refused", () => {
  const o = start();
  assert.equal(req(o, { mime: "image/gif" }).status, 400);
  assert.equal(req(o, { data: "###" }).status, 400);
  assert.equal(req(o, { data: "" }).status, 400);
  assert.equal(req(o, { data: Buffer.alloc(2.6 * 1024 * 1024).toString("base64") }).status, 413);
});
