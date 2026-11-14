# Category budgets — design

Date: 2026-11-14 · Status: awaiting approval

## Intent

Let the user give individual **expense categories** a monthly budget (e.g. อาหาร ฿6,000,
ช้อปปิ้ง ฿2,000) and see how much is left as spending in that category is recorded. The point
is to keep specific categories that tend to run over under control, at the moment of spending.

## Goals

- Optional budget per expense category, same amount every month.
- Overview shows, for the viewed month, each budgeted category's spent / budget / remaining.
- The add/edit transaction window shows the remaining budget of the selected category.

## Non-goals

- Budgets for income categories.
- Different amounts per month, budget history, rollover of unspent budget.
- One overall budget across several categories.
- Notifications / alerts outside the app screens.

## Approaches considered

- **A. Budget column on the category, same every month — chosen.** Least to set up and maintain;
  changing a budget also re-measures past months against the new amount (accepted trade-off).
- B. Budget per month (own table + "copy last month"). Accurate history, but ~2× the work and
  monthly upkeep for the user.
- C. Budget with an "effective from" month. Accurate history with one-time setup, but more
  complex for a benefit only visible when browsing old months.

## Design

**Data.** Migration `0003_category_budgets.sql`: `ALTER TABLE categories ADD COLUMN
budget_satang INTEGER CHECK (budget_satang IS NULL OR budget_satang > 0)`. NULL = no budget.
Backups need no change (they copy the DB file).

**API.**
- `GET /api/categories` also returns `budget` (baht number, or `null`).
- `PUT /api/categories/{id}` accepts an optional `budget` (decimal string/number; empty or 0 clears it).
  Setting a budget on an income category → 400 with a Thai message. Omitting `budget` leaves it unchanged,
  so the existing name/colour saves keep working.
- No new summary endpoint: the month's per-category expense totals already come from `by_category`.

**Setting budgets.** In the หมวดหมู่ window, each expense category row gets a budget input
(`฿ งบ/เดือน`, blank = none), saved on change like the name and colour. Same `45+60` sum
parsing as the amount field.

**Overview card — "งบประมาณเดือนนี้"** (or "งบประมาณ <month>" when viewing another month),
placed after the KPI cards. One row per budgeted category, in category order:

```
งบประมาณเดือนนี้
● อาหาร     เหลือ ฿1,250   ████████░░  ฿4,750 / ฿6,000
● ช้อปปิ้ง   เกิน ฿300     ██████████  ฿2,300 / ฿2,000
```

Bar colours match the existing spend meter: normal < 80%, amber 80–100%, red over 100%.
With no budgets set, the card shows a one-line hint and a "ตั้งงบประมาณ" button that opens the
หมวดหมู่ window *(my call: keeps the feature discoverable)*.

**Add/edit window.** Under the category chips, when the selected expense category has a budget:

```
งบอาหาร พ.ย.: เหลือ ฿1,250 → หลังบันทึก ฿1,205
```

- Updates live as the amount, category or date changes.
- Spending is taken from the month of the entry's date. When editing, the transaction's own
  original amount is excluded so it isn't counted twice.
- If the date is in a month other than the one loaded on screen, the app fetches that month's
  totals for the line *(my call)*; while loading or on error the line is hidden.
- "หลังบันทึก" turns red when it goes below zero; nothing blocks saving.
- Hidden for income and for categories without a budget.

## Testing

- pytest: migration applies to an existing DB; budget set/clear/validation (income rejected,
  negative/invalid rejected, omitted leaves unchanged); `GET` returns it.
- Browser check at phone and desktop sizes: card states (none / under / near / over), the
  remaining line in add and edit, and the categories window input.

## Left to the builder

Exact markup/CSS following existing card, meter and field styles; Thai copy wording tweaks.
