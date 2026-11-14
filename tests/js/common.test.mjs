// Unit tests for app/static/common.js (a browser script) using Node's built-in runner:
//   node --test tests/js/common.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../app/static/common.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(`${source}\n;globalThis.__exports = { evalAmount, readAmount, fmt, shiftMonth, parseISO, isoDate, budgetStatus, budgetSpent };`, context);
const { evalAmount, readAmount, fmt, shiftMonth, parseISO, isoDate, budgetStatus, budgetSpent } = context.__exports;

test("evalAmount adds and subtracts, ignores commas, spaces and ฿", () => {
  assert.equal(evalAmount("45+60"), 105);
  assert.equal(evalAmount("10-3.5"), 6.5);
  assert.equal(evalAmount("1,250.50"), 1250.5);
  assert.equal(evalAmount("฿ 99"), 99);
  assert.equal(evalAmount(".5+.25"), 0.75);
});

test("evalAmount rejects anything that isn't a sum of numbers", () => {
  for (const bad of ["", "abc", "45+", "-5", "12..3", "12a", "1e3"]) {
    assert.ok(Number.isNaN(evalAmount(bad)), bad);
  }
});

test("readAmount: empty field is valid but has no amount", () => {
  const r = readAmount("   ");
  assert.equal(r.amount, null);
  assert.equal(r.valid, true);
});

test("readAmount: invalid or non-positive text gives no amount (regression: stale value was saved)", () => {
  for (const bad of ["12a", "0", "0.00", "45+", "-5"]) {
    const r = readAmount(bad);
    assert.equal(r.amount, null, bad);
    assert.equal(r.valid, false, bad);
  }
});

test("readAmount: good input gives the rounded amount", () => {
  const r = readAmount(" 45+60.005 ");
  assert.equal(r.amount, 105.01);
  assert.equal(r.valid, true);
});

test("fmt always shows two decimals with thousands separators", () => {
  assert.equal(fmt(1234.5), "1,234.50");
  assert.equal(fmt(0), "0.00");
});

test("shiftMonth crosses year boundaries", () => {
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
});

test("parseISO/isoDate round-trip in local time (no off-by-one day)", () => {
  assert.equal(isoDate(parseISO("2026-11-10")), "2026-11-10");
  assert.equal(isoDate(parseISO("2026-03-01")), "2026-03-01");
});

test("budgetStatus: remaining, percent and level (warn from 80%, over above 100%)", () => {
  const ok = budgetStatus(6000, 4750);
  assert.equal(ok.remaining, 1250);
  assert.equal(ok.pct, 79);
  assert.equal(ok.level, "ok");
  assert.equal(budgetStatus(6000, 4800).level, "warn");
  const full = budgetStatus(6000, 6000);
  assert.equal(full.level, "warn");
  assert.equal(full.remaining, 0);
  const over = budgetStatus(2000, 2300);
  assert.equal(over.level, "over");
  assert.equal(over.remaining, -300);
  assert.equal(budgetStatus(0.3, 0.1).remaining, 0.2); // no float noise like 0.19999…
});

test("budgetSpent: category total minus the edited entry, never below zero", () => {
  const byCat = [{ id: 1, total: 500 }, { id: 2, total: 80 }];
  assert.equal(budgetSpent(byCat, 1), 500);
  assert.equal(budgetSpent(byCat, 1, 120), 380);
  assert.equal(budgetSpent(byCat, 9), 0);
  assert.equal(budgetSpent(byCat, 2, 100), 0);
  assert.equal(budgetSpent(undefined, 1), 0);
});
