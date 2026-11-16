// A small in-memory stand-in for the Google services that cloud/apps-script/*.gs uses, so the backend can run
// under Node for tests and for the local dev server. It copies the Sheets behaviours that bite in practice:
//   - a cell that is not formatted as plain text turns "2026-11-10" into a Date, "007" into 7 and "=A1" into a formula
//   - a leading apostrophe marks text and is not part of the stored value
// It is a model of how the real services behave, not the real thing.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const signed = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const unsigned = (bytes) => Buffer.from(bytes.map((b) => b & 0xff));

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.rows = []; // 2D array of stored values
    this.maxRows = 1000;
    this.plainTextCols = new Set();
    this.frozen = 0;
  }
  getName() { return this.name; }
  getLastRow() {
    for (let r = this.rows.length; r > 0; r--) if (this.rows[r - 1].some((v) => v !== "" && v !== undefined)) return r;
    return 0;
  }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(_row, count) { this.maxRows += count; }
  setFrozenRows(n) { this.frozen = n; }
  deleteRow(r) {
    if (r < 1 || r > this.maxRows) throw new Error("deleteRow: out of bounds");
    this.rows.splice(r - 1, 1);
    this.maxRows -= 1;
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1) throw new Error("getRange: bad coordinates");
    if (row + numRows - 1 > this.maxRows) throw new Error("The coordinates of the range are outside the dimensions of the sheet.");
    const sheet = this;
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const src = sheet.rows[row - 1 + r] || [];
          out.push(Array.from({ length: numCols }, (_, c) => (src[col - 1 + c] === undefined ? "" : src[col - 1 + c])));
        }
        return out;
      },
      setValues(values) {
        if (values.length !== numRows || values.some((v) => v.length !== numCols)) {
          throw new Error("The number of rows or columns in the data does not match the range.");
        }
        for (let r = 0; r < numRows; r++) {
          while (sheet.rows.length < row + r) sheet.rows.push([]);
          for (let c = 0; c < numCols; c++) {
            sheet.rows[row - 1 + r][col - 1 + c] = sheet.store(values[r][c], col + c);
          }
        }
        return this;
      },
      setNumberFormat(format) {
        for (let c = 0; c < numCols; c++) {
          if (format === "@") sheet.plainTextCols.add(col + c);
          else sheet.plainTextCols.delete(col + c);
        }
        return this;
      },
    };
  }
  /** What Sheets keeps when a script writes `value` into a cell of this column. */
  store(value, col) {
    if (value === null || value === undefined) return "";
    if (typeof value !== "string") return value;
    if (value.startsWith("'")) return value.slice(1); // text marker, not stored
    if (this.plainTextCols.has(col)) return value;
    if (value.startsWith("=") || value.startsWith("+")) return "#FORMULA!";
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(value + "T00:00:00+07:00");
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
    return value;
  }
}

class FakeSpreadsheet {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.sheets = new Map();
  }
  getId() { return this.id; }
  getUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}/edit`; }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) {
    const s = new FakeSheet(name);
    this.sheets.set(name, s);
    return s;
  }
}

/**
 * @param {object} [opts]
 * @param {(bytes: Buffer, mime: string) => string} [opts.ocr]  what "Drive OCR" returns for an uploaded file
 * @param {boolean} [opts.bound]  true = the script is attached to a spreadsheet (getActiveSpreadsheet works)
 */
export function createFakeGoogle(opts = {}) {
  const state = {
    spreadsheets: new Map(),
    active: null,
    props: new Map(),
    cache: new Map(),
    files: new Map(), // id -> {bytes, mime, name, trashed}
    folders: new Map(),
    docs: new Map(), // temporary OCR docs: id -> text
    locks: 0,
    now: null, // set to a Date to freeze time
    ocr: opts.ocr || (() => ""),
    ocrFails: false,
    failNextAppend: false,
  };
  if (opts.bound !== false) {
    state.active = new FakeSpreadsheet("sheet-" + randomUUID().slice(0, 8), "bound");
    state.spreadsheets.set(state.active.id, state.active);
  }
  const clock = () => (state.now ? state.now.getTime() : Date.now());
  const blobOf = (bytes, mime, name) => ({
    getBytes: () => bytes,
    getContentType: () => mime,
    getName: () => name,
  });
  const fileApi = (id) => {
    const f = state.files.get(id);
    if (!f || f.trashed) throw new Error("File not found: " + id);
    return {
      getId: () => id,
      getName: () => f.name,
      getMimeType: () => f.mime,
      getBlob: () => blobOf(f.bytes, f.mime, f.name),
      setTrashed(v) { f.trashed = v; return this; },
    };
  };

  const globals = {
    console,
    Logger: { log: () => {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => state.active,
      openById(id) {
        const ss = state.spreadsheets.get(id);
        if (!ss) throw new Error("Spreadsheet not found: " + id);
        return ss;
      },
      create(name) {
        const ss = new FakeSpreadsheet("sheet-" + randomUUID().slice(0, 8), name);
        state.spreadsheets.set(ss.id, ss);
        return ss;
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (state.props.has(k) ? state.props.get(k) : null),
        setProperty(k, v) { state.props.set(k, String(v)); return this; },
        deleteProperty(k) { state.props.delete(k); return this; },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() {
          if (state.locks > 0) throw new Error("Lock timeout");
          state.locks += 1;
        },
        releaseLock() { state.locks -= 1; },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get(k) {
          const e = state.cache.get(k);
          if (!e || e.expires <= clock()) return null;
          return e.value;
        },
        put(k, v, seconds = 600) { state.cache.set(k, { value: String(v), expires: clock() + seconds * 1000 }); },
        remove(k) { state.cache.delete(k); },
      }),
    },
    Session: { getScriptTimeZone: () => "Asia/Bangkok" },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" },
      formatDate(date, tz, format) {
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
          timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
        }).formatToParts(date).map((p) => [p.type, p.value]));
        return format.replace("yyyy", parts.year).replace("MM", parts.month).replace("dd", parts.day)
          .replace("HH", parts.hour).replace("mm", parts.minute).replace("ss", parts.second);
      },
      getUuid: () => randomUUID(),
      base64Decode(s) {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("Could not decode string.");
        return signed(Buffer.from(s, "base64"));
      },
      base64Encode: (bytes) => unsigned(bytes).toString("base64"),
      newBlob: (bytes, mime, name) => blobOf(bytes, mime, name),
      computeDigest: (_algo, text) => signed(createHash("sha256").update(String(text), "utf8").digest()),
    },
    DriveApp: {
      createFolder(name) {
        const id = "folder-" + randomUUID().slice(0, 8);
        state.folders.set(id, name);
        return { getId: () => id, getUrl: () => `https://drive.google.com/drive/folders/${id}` };
      },
      getFolderById(id) {
        if (!state.folders.has(id)) throw new Error("Folder not found: " + id);
        return {
          getUrl: () => `https://drive.google.com/drive/folders/${id}`,
          createFile(blob) {
            const fid = "file-" + randomUUID().slice(0, 8);
            state.files.set(fid, { bytes: blob.getBytes(), mime: blob.getContentType(), name: blob.getName(), trashed: false, folder: id });
            return fileApi(fid);
          },
        };
      },
      getFileById: (id) => fileApi(id),
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

const GS_DIR = new URL("../apps-script/", import.meta.url);

/** Loads Code.gs + Parser.gs into one scope, in the editor's file order (as Apps Script does), on top of the fake services. */
export function loadBackend(opts = {}) {
  const fake = createFakeGoogle(opts);
  const context = vm.createContext({ ...fake.globals });
  const source = ["Code.gs", "Parser.gs"].map((f) => readFileSync(new URL(f, GS_DIR), "utf8")).join("\n");
  vm.runInContext(source + "\n;globalThis.__gs = { doPost, doGet, setup, showSecret, rotateSecret, parseReceiptText, toSatang_ };", context, { filename: "apps-script.gs" });
  const gs = context.__gs;
  const backend = {
    ...fake,
    context,
    gs,
    /** Freeze "now" for the backend (dates on receipts are judged against today). */
    setNow(date) {
      fake.state.now = date;
      context.now_ = () => new Date(date.getTime());
    },
    setup() {
      const result = gs.setup();
      backend.secret = result.secret;
      return result;
    },
    /** Calls the web app the way Vercel does. Returns the parsed JSON envelope. */
    post(action, params = {}, ...rest) {
      const secret = rest.length ? rest[0] : backend.secret; // pass undefined explicitly to send no secret
      const out = gs.doPost({ postData: { contents: JSON.stringify({ secret, action, params }), type: "text/plain" } });
      return JSON.parse(out.getContent());
    },
    /** Like post() but returns data or throws, for readable tests. */
    call(action, params) {
      const r = backend.post(action, params);
      if (!r.ok) {
        const err = new Error(r.error);
        err.status = r.status;
        throw err;
      }
      return r.data;
    },
    sheet(name) {
      const id = fake.state.props.get("SHEET_ID");
      return fake.state.spreadsheets.get(id).getSheetByName(name);
    },
  };
  return backend;
}
