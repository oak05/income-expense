// A small in-memory stand-in for the Google services that cloud/apps-script/Ocr.gs uses, so the OCR web app can
// run under Node for tests and for the local dev server: script properties, Utilities, Drive OCR (a temporary
// Google Doc holding the text) and ContentService. It is a model of how the real services behave, not the real thing.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const signed = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const unsigned = (bytes) => Buffer.from(bytes.map((b) => b & 0xff));

/**
 * @param {object} [opts]
 * @param {(bytes: Buffer, mime: string, options: object) => string} [opts.ocr]  what "Drive OCR" returns for a file
 */
export function createFakeGoogle(opts = {}) {
  const state = {
    props: new Map(),
    docs: new Map(), // temporary OCR docs: id -> text
    ocr: opts.ocr || (() => ""),
    ocrFails: false,
  };
  const blobOf = (bytes, mime, name) => ({
    getBytes: () => bytes,
    getContentType: () => mime,
    getName: () => name,
  });

  const globals = {
    console,
    Logger: { log: () => {} },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (state.props.has(k) ? state.props.get(k) : null),
        setProperty(k, v) { state.props.set(k, String(v)); return this; },
        deleteProperty(k) { state.props.delete(k); return this; },
      }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" },
      getUuid: () => randomUUID(),
      base64Decode(s) {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("Could not decode string.");
        return signed(Buffer.from(s, "base64"));
      },
      newBlob: (bytes, mime, name) => blobOf(typeof bytes === "string" ? signed(Buffer.from(bytes, "utf8")) : bytes, mime, name),
      computeDigest: (_algo, text) => signed(createHash("sha256").update(String(text), "utf8").digest()),
    },
    Drive: {
      Files: {
        create(meta, blob, options) {
          if (state.ocrFails) throw new Error("OCR backend error");
          if (meta.mimeType !== "application/vnd.google-apps.document") throw new Error("fake Drive only converts to Docs");
          const id = "doc-" + randomUUID().slice(0, 8);
          state.docs.set(id, state.ocr(unsigned(blob.getBytes()), blob.getContentType(), options));
          return { id };
        },
        remove(id) { state.docs.delete(id); },
      },
    },
    DocumentApp: {
      openById(id) {
        if (!state.docs.has(id)) throw new Error("Document not found: " + id);
        return { getBody: () => ({ getText: () => state.docs.get(id) }) };
      },
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput(text) {
        return { content: text, mime: "text/plain", setMimeType(m) { this.mime = m; return this; }, getContent() { return this.content; } };
      },
    },
  };
  return { globals, state };
}

/** Loads Ocr.gs on top of the fake services. */
export function loadOcr(opts = {}) {
  const fake = createFakeGoogle(opts);
  const context = vm.createContext({ ...fake.globals });
  const source = readFileSync(new URL("../apps-script/Ocr.gs", import.meta.url), "utf8");
  vm.runInContext(source + "\n;globalThis.__gs = { doPost, doGet, setup, showSecret, rotateSecret, testOcr };", context, { filename: "Ocr.gs" });
  const gs = context.__gs;
  const ocr = {
    ...fake,
    context,
    gs,
    setup() {
      ocr.secret = gs.setup().secret;
      return ocr.secret;
    },
    /** Calls the web app the way Vercel does; returns the parsed JSON envelope. */
    post(body) {
      return JSON.parse(gs.doPost({ postData: { contents: JSON.stringify(body), type: "text/plain" } }).getContent());
    },
  };
  return ocr;
}
