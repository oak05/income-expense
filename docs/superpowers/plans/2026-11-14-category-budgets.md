# Category Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional monthly budget per expense category, shown on the overview and as "remaining" in the add/edit window.

**Architecture:** One nullable `budget_satang` column on `categories` (migration 0003). The categories API reads/writes it as baht. The frontend works out spent/remaining from data it already loads (`/api/summary` → `by_category.expense`), using one pure helper in `common.js` so the maths is unit-tested.

**Tech Stack:** FastAPI + SQLite (Python), vanilla JS/CSS, pytest, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-14-category-budgets-design.md`

## Global Constraints

- Budgets only on `type = 'expense'` categories; income → HTTP 400, Thai message.
- Money stored in satang (int), sent to the client as baht numbers via `baht()`; parsed with `Decimal` and `to_satang()`, the same as transaction amounts.
- Same amount every month. NULL = no budget. Empty/0 clears it.
- Colour levels match the spend meter: `warn` at ≥ 80% and ≤ 100%, `over` at > 100%.
- All user-facing copy in Thai. Bump `APP_VERSION` to `1.3.0` and the `?v=` asset query strings.
- Never block saving a transaction because of a budget.

## Review Focus

1. A PUT from the existing name/colour save (no `budget` key) must not wipe a budget → `test_update_without_budget_keeps_it`.
2. Editing a transaction must not count its own original amount twice; moving it to another month or category must count the new place fully → `budgetSpent` unit tests (Task 3).
3. A date in a month other than the one on screen → the line uses that month's totals, not the visible month's → covered by `budgetSpent` taking the month summary as input + browser check (Task 5).
4. A budget on a category that is later deleted or has its transactions moved → the card simply drops it (row removed with the category); no orphan rows.
5. Restoring a v1.2 backup (schema 2) → upgraded to schema 3 with budgets NULL → `test_v11_database_needs_nothing` becomes "applies only 0003".

---

### Task 1: Migration 0003

**Files:**
- Create: `app/migrations/0003_category_budgets.sql`
- Modify: `tests/test_migrations.py` (expected version lists; test-only migrations use the next free number)

- [ ] Step 1: Update tests: `test_fresh_database_gets_every_migration_once` expects `[1, 2, 3]`; `test_v10_database_is_recognised_then_upgraded` expects `[2, 3]` and applied `[1, 2, 3]`; `test_v11_database_needs_nothing` → rename `test_v11_database_only_gets_budgets`, expects `[3]`. Tests that write `0003_*.sql` into `migrations_copy` use `NEXT = migrate.latest_version() + 1` for the file name and expected list. Add to the v10 test: `budget_satang` of the upgraded category is `None`.
- [ ] Step 2: Run `pytest tests/test_migrations.py -q` → FAIL (no 0003 yet).
- [ ] Step 3: Create the migration: `ALTER TABLE categories ADD COLUMN budget_satang INTEGER CHECK (budget_satang IS NULL OR budget_satang > 0);` with a `-- 0003: ...` header comment like the others.
- [ ] Step 4: Run `pytest tests/test_migrations.py -q` → PASS.

### Task 2: Categories API

**Files:** Modify `app/main.py` (`CategoryUpdate`, `list_categories`, `create_category`, `update_category`, `APP_VERSION`); Test: `tests/test_api.py`

**Produces:** every category dict from GET/POST/PUT has `budget: float | None` (baht); the raw `budget_satang` is not exposed.
PUT body: `{name, color, budget?: Decimal | None}` — key absent = unchanged; `null`/`0`/`""` = clear; > 0 = set; < 0 or not a number → 422 (Thai, via the existing validation handler).

- [ ] Step 1: Tests:
  - `test_category_budget_set_and_clear`: PUT food with `budget: "6000"` → 200, `budget == 6000.0`; GET shows it; PUT `budget: null` → `budget is None`; PUT `budget: "0"` after setting → `None`.
  - `test_update_without_budget_keeps_it`: set 6000, then PUT `{name, color}` only → still 6000.
  - `test_budget_rejected_on_income_category`: PUT salary with `budget: "100"` → 400, `"รายรับ"` in detail.
  - `test_budget_must_be_a_positive_amount`: `budget: "-5"` → 422.
  - `test_new_category_has_no_budget`: POST → `budget is None`.
- [ ] Step 2: Run `pytest tests/test_api.py -q -k budget` → FAIL.
- [ ] Step 3: Implement. Use `model_fields_set` to tell "absent" from `null`. A helper `category_out(row) -> dict` replaces `budget_satang` with `budget` and is used by all three endpoints. Set `APP_VERSION = "1.3.0"`.
- [ ] Step 4: Run the whole `pytest -q` → all pass except the known-failing real-OCR test (fails before this change too: local Tesseract).

### Task 3: Budget maths helper (common.js)

**Files:** Modify `app/static/common.js`; Test: `tests/js/common.test.mjs` (add names to the `__exports` line)

**Produces:**
- `budgetStatus(budget: number, spent: number) -> { spent, budget, remaining, pct, level }`; `remaining = budget - spent` (rounded to satang), `pct = round(spent / budget * 100)`, `level` is `"ok" | "warn" | "over"` per Global Constraints.
- `budgetSpent(byCategoryExpense: {id,total}[], categoryId: number, minus = 0) -> number` = that category's total (0 if missing) minus `minus`, never below 0.

- [ ] Step 1: Tests: `budgetStatus(6000, 4750)` → remaining 1250, pct 79, level ok; `(6000, 4800)` → warn; `(6000, 6000)` → warn, remaining 0; `(2000, 2300)` → over, remaining -300; `budgetSpent([{id:1,total:500}], 1, 120)` → 380; missing id → 0; `minus` bigger than total → 0.
- [ ] Step 2: `node --test tests/js/common.test.mjs` → FAIL.
- [ ] Step 3: Implement both functions in `common.js`.
- [ ] Step 4: Re-run → PASS.

### Task 4: Setting budgets + overview card

**Files:** Modify `app/static/index.html`, `app/static/app.js`, `app/static/style.css`

**Consumes:** `budget` on categories (Task 2), `budgetStatus` / `budgetSpent` (Task 3).

- [ ] Step 1: Categories window: expense rows get `<input class="input budget-input" inputmode="decimal" placeholder="งบ/เดือน" aria-label="งบประมาณต่อเดือนของ <name>">` before the count, showing `fmt(budget)` or empty. `saveCategoryRow` reads it with `readAmount`: invalid → toast error and restore the old value; otherwise send `budget` (amount, or `null` when empty) along with name/colour; skip the request when nothing changed.
- [ ] Step 2: Overview card `<article class="card budget-card" id="budget-card">` after `.kpis`. Title "งบประมาณเดือนนี้", or "งบประมาณ <monthName>" when not the current month. `renderBudgetCard()` is called wherever the overview is rendered. One `<li>` per expense category with a budget, in category order: colour dot, name, "เหลือ ฿x" or "เกิน ฿x" (class `over`), meter (reuse `.meter`/`.meter-fill` with `warn`/`over` classes, `role="meter"` + `aria-valuetext`), "฿spent / ฿budget". With no budgets: hint "ตั้งงบรายหมวดเพื่อดูว่าเหลือใช้เท่าไร" + button `data-open="categories"` labelled "ตั้งงบประมาณ".
- [ ] Step 3: The `.meter` base style targets the dark hero; add `.budget-card .meter` with a light track (`--color-surface-3`) and a normal fill of `--color-primary`, keeping the warn/over colours.
- [ ] Step 4: Browser check (phone 390 px + desktop 1280 px): no budgets → hint; set 6000 on อาหาร with 4750 spent → "เหลือ ฿1,250.00"; over budget → red; saving name/colour keeps the budget.

### Task 5: Remaining line in the add/edit window

**Files:** Modify `app/static/index.html`, `app/static/app.js`, `app/static/style.css`

- [ ] Step 1: Markup: `<p class="field-hint budget-hint" id="budget-hint" aria-live="polite" hidden></p>` directly under `#category-chips` in the category fieldset.
- [ ] Step 2: `updateBudgetHint()` in `app.js`, called on chip selection, type change, amount input, date change, `openEntry`, and after the month loads. Hidden unless type is expense and the selected category has a budget. Month = `form.elements.date.value.slice(0, 7)`. Summary source: `state.summary` when that month equals `state.month`, otherwise `await api('/api/summary?month=…')` cached in a `Map` (cleared after any save/delete). Use a request counter so a late response can't overwrite a newer one; hide while loading or on error. `minus` = the edited transaction's original amount when its original month and category equal the current ones, else 0. Text: `งบ<name> <monthShort>: เหลือ ฿x` plus ` → หลังบันทึก ฿y` when the amount field reads a valid amount (the "after" part gets class `over` when y < 0).
- [ ] Step 3: Browser check: add mode on a budgeted category; typing 45 updates "หลังบันทึก"; switching to income hides the line; editing an existing transaction doesn't double-count it; a date in last month uses last month's spending.

### Task 6: Wrap-up

- [ ] Bump `?v=` for `style.css`, `common.js`, `app.js` in `index.html`, and `style.css`/`common.js` in `receipts.html`.
- [ ] Add one line on budgets to `README.md` features, if it lists features.
- [ ] `ruff check .`, `pytest -q`, `node --test tests/js/common.test.mjs` → clean (except the known OCR test).
- [ ] Final browser pass at phone and desktop sizes, then hand over. Commit only when the user asks.
