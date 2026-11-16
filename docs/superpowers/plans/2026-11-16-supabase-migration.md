# Cloud on Supabase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Cloud version's Google Sheet backend and shared password with Supabase Postgres, Supabase Auth (open sign-up, one book per account) and Supabase Storage. Apps Script is kept only for receipt OCR.

**Architecture:**
- Vercel Functions stay the only API the browser talks to.
- Sign-in uses Supabase Auth over plain `fetch`. Its tokens live in HttpOnly cookies.
- Every `/api/rpc` action is a Postgres function `public.api_<action>(p jsonb) returns jsonb`. Vercel calls it through PostgREST with the user's JWT, so RLS applies and each action is one transaction.
- Receipt files go to Supabase Storage under `<user_id>/`. OCR text comes from an Apps Script that stores nothing.

**Tech Stack:**
- Node ≥ 22 (ES modules, `node:test`), PostgreSQL / PL/pgSQL.
- `@electric-sql/pglite@0.5.16` as a devDependency for tests and dev only.
- Apps Script (Drive OCR), Vercel Functions, static HTML/CSS/JS with no build step.

**Spec:** `docs/superpowers/specs/2026-11-16-supabase-migration-design.md`

## Global Constraints

- Scope is `cloud/` plus the CI file, the root README pointer and these docs. `app/` (local SQLite app) is not touched.
- `cloud/vercel/package.json` gets **no runtime dependencies**. Supabase is reached through `fetch` only. PGlite goes in `cloud/package.json` `devDependencies`.
- Browser never contacts Supabase or Google; `vercel.json` CSP stays exactly as it is (`connect-src 'self'`).
- No inline `<script>` or `on*=` handlers in any HTML page (CSP).
- Every user-facing message is Thai. Existing messages from `cloud/apps-script/Code.gs` are reused **verbatim**.
- `/api/rpc` response shapes equal today's `a_*_` return values in `Code.gs`, except `info` (→ `{version, email}`). Amounts are JSON numbers in baht. Dates are `YYYY-MM-DD`. Timestamps are `YYYY-MM-DD HH24:MI:SS` in Asia/Bangkok.
- Amount rule: input matches `^\d{1,10}(\.\d{1,6})?$`, rounded half-up to 2 decimals, must be > 0 and ≤ 9999999999.99.
- **Cookies:**
  - `sb_access` and `sb_refresh`, both `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000` (30 days).
  - Clearing them sets `Max-Age=0`.
- **Vercel env:**
  - Required: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APPS_SCRIPT_URL`, `APPS_SCRIPT_SECRET`.
  - `APP_PASSWORD` and `SESSION_SECRET` are gone.
- **Throttles:**
  - Login: 8 failures per sha256(ip + "\n" + lowercased email) → blocked 15 min after the last failure; success clears.
  - Sign-up / recover / resend: 5 per sha256(ip) per kind per rolling hour.
- **Limits:**
  - Receipt file ≤ 2.5 MB.
  - Account receipt quota 104857600 bytes (100 MB).
  - Import ≤ 5000 rows; commit ≤ 500 items.
  - Password ≥ 8 characters.
- `SUPABASE_SERVICE_ROLE_KEY` is used **only** for `auth_throttle`.
- **Supabase keys:**
  - Always send `apikey: <key>`.
  - Send `Authorization: Bearer <jwt>` only with a user JWT, or with the service key when that key starts with `eyJ` (legacy JWT keys). New `sb_secret_`/`sb_publishable_` keys must not go in `Authorization`.
- Version `3.0.0` (`cloud/vercel/package.json`, `?v=` query strings on CSS/JS, `Ocr.gs`).

## Review Focus

1. **Two tabs refresh the same session at once.** The second refresh uses the already-rotated refresh token. Expect both requests to succeed. The fake honours a 10-second reuse window like Supabase, and the session layer must not clear cookies on a refresh that races. Test owned by Task 8.
2. **Email link opened twice, or after it expired.** The second click on `confirm.html` shows a Thai "ลิงก์นี้ใช้แล้วหรือหมดอายุ — ขอลิงก์ใหม่" message with links to login / forgot, not a 500 or an English error. Test owned by Task 11.
3. **A user forges ids from another account** in `transactions.update`, `receipts.commit`, `categories.delete` `move_to`, or `/api/file?id=`. Expect 404 / 400 exactly as if the row did not exist; never a change or a file. Tests owned by Tasks 3, 5 and 9.
4. **The OCR backend is down, misconfigured or slow** during upload. The receipt is still saved with an error message and the amount can be typed in, as today. A Storage upload failure gives a clear Thai 502 and leaves no orphan receipt row. Test owned by Task 9.
5. **Deleting an account while receipt files exist** removes every Storage object under `<uid>/`, including more than one listing page (> 100 objects). Afterwards the old cookies give 401 and signing in fails. Test owned by Task 11.

---

## File map

```
cloud/
  package.json                      modify: devDependencies.pglite, scripts unchanged
  supabase/
    migrations/0001_schema.sql      tables, RLS, default-category trigger
    migrations/0002_api_core.sql    helpers + categories + transactions (+ import)
    migrations/0003_api_summaries.sql  month.get, yearly.get
    migrations/0004_api_receipts.sql   receipts create/list/update/delete/commit/file, quota, hint
    migrations/0005_auth.sql        private.auth_attempts, auth_throttle, api_delete_account
    migrations/0006_storage.sql     bucket + storage policies
    templates/confirm-signup.html   Thai email templates (pasted into dashboard)
    templates/reset-password.html
    test/auth-stub.sql              PGlite-only stand-in for Supabase's auth/storage schemas and roles
  dev/
    pg.mjs                          PGlite bootstrap + callApi (tests + fake)
    fake-supabase.mjs               GoTrue / PostgREST-rpc / Storage subset over HTTP
    fake-google.mjs                 modify: load Ocr.gs instead of Code.gs + Parser.gs
    server.mjs                      modify: wire fake Supabase + fake OCR + real Vercel functions
  apps-script/
    Ocr.gs                          new (replaces Code.gs)
    Code.gs, Parser.gs              delete
    appsscript.json                 keep (Drive API advanced service)
  vercel/
    lib/server.js                   modify: config, HttpError(code), keep request checks; drop sessions + callBackend
    lib/supabase.js                 Auth / PostgREST / Storage clients
    lib/session.js                  cookies, refresh, withUser
    lib/ocr.js                      Apps Script OCR client
    lib/parser.js                   ES-module port of Parser.gs
    lib/receipts.js                 sniffMime, todayBangkok, uploadReceipt
    api/login.js logout.js session.js rpc.js file.js   modify
    api/signup.js recover.js resend.js verify.js password.js account.js   new
    public/login.html login.js       modify (email field, links, resend)
    public/signup.html signup.js forgot.html forgot.js confirm.html confirm.js password.html password.js   new
    public/common.js app.js index.html receipts.html style.css   modify (account menu, info, err.code)
    package.json                    version 3.0.0
  tests/
    sql.test.mjs                    replaces backend.test.mjs (deleted)
    ocr.test.mjs                    new
    parser.test.mjs                 modify import
    vercel.test.mjs                 rewrite on fake Supabase
    auth-flows.test.mjs             new
  README.md                         rewrite setup / migration / security (Thai)
README.md (root)                    Cloud line
.github/workflows/ci.yml            add cloud job
```

---

### Task 1: Branch, PGlite harness and Supabase stand-ins

**Files:**
- Create: `cloud/supabase/test/auth-stub.sql`, `cloud/dev/pg.mjs`, `cloud/tests/sql.test.mjs`
- Modify: `cloud/package.json`

**Interfaces:**
- Produces:
  - `createDb(): Promise<PGlite>`: fresh in-memory DB with the stub, then every `cloud/supabase/migrations/*.sql` in filename order.
  - `createUser(db, {email, password?, confirmed=true}): Promise<string /*uuid*/>`: inserts into `auth.users`. Stores `encrypted_password` as the scrypt hash `scrypt$<salt hex>$<hash hex>` (Node `crypto.scryptSync`, keylen 32).
  - `callApi(db, userId|null, fn, params={}, {role='authenticated', email}={}): Promise<any>`: runs `select public.<fn>($1::jsonb) as r` inside `begin; set local role <role>; select set_config('request.jwt.claims', <json {sub, role, email}>, true); … commit`, rolling back on error. Throws `ApiError {status, message}`, where SQLSTATE `PTxyz` → status `xyz` and anything else → 500 with the original message.
  - `class ApiError extends Error { status }`.
  - Stub objects:
    - roles `anon`, `authenticated`, `service_role` (nologin);
    - `auth.users(id uuid pk default gen_random_uuid(), email text unique, encrypted_password text, email_confirmed_at timestamptz, created_at timestamptz default now())`;
    - `auth.uid()`, `auth.jwt()`, `auth.role()` reading `current_setting('request.jwt.claims', true)` exactly like Supabase;
    - `storage.buckets(id text pk, name text, public bool)`, `storage.objects(id uuid default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz default now())` with RLS enabled;
    - `storage.foldername(name text) returns text[]` (all path segments but the last).

- [ ] **Step 1:** Create branch `feat/supabase` from `main`. Add `"devDependencies": {"@electric-sql/pglite": "0.5.16"}` to `cloud/package.json` and run `cd cloud && npm install`. Add `node_modules/` under `cloud/` to `.gitignore` if it is not covered.
- [ ] **Step 2: Write the failing test** in `cloud/tests/sql.test.mjs`:
  ```js
  test("harness: auth.uid() follows the claims and roles exist", async () => {
    const db = await createDb();
    const id = await createUser(db, { email: "a@example.com" });
    const results = await db.exec(`begin; set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${id}"}', true); select auth.uid()::text as u; commit;`);
    assert.equal(results.at(-2).rows[0].u, id); // db.exec returns one result per statement
    assert.equal(await callApi(db, id, "pg_typeof", {}).catch((e) => e.status), 500); // unknown → ApiError 500
  });
  ```
- [ ] **Step 3:** Run `cd cloud && node --test tests/sql.test.mjs`. Expected: FAIL (`dev/pg.mjs` missing).
- [ ] **Step 4:** Implement `auth-stub.sql` and `dev/pg.mjs` as specified. The migrations folder may be empty at this point; `createDb` must tolerate that.
- [ ] **Step 5:** Run the test. Expected: PASS. If PGlite lacks the `Asia/Bangkok` zone (check `select now() at time zone 'Asia/Bangkok'`), stop and report. Every later task depends on it.
- [ ] **Step 6:** Commit `chore(cloud): PGlite test harness with Supabase auth/storage stand-ins`.

### Task 2: Schema, RLS and default categories

**Files:**
- Create: `cloud/supabase/migrations/0001_schema.sql`
- Test: `cloud/tests/sql.test.mjs`

**Interfaces:**
- Produces:
  - Tables `public.categories`, `public.transactions` and `public.receipts`, exactly as in the spec's Data model section.
  - Receipts also get `size integer not null default 0 check (size >= 0)` and `storage_path text`.
  - `transactions.receipt_id` → `foreign key (receipt_id, user_id) references receipts (id, user_id) on delete set null (receipt_id)`.
  - `receipts.transaction_id` → `(transaction_id, user_id) references transactions (id, user_id) on delete set null (transaction_id)`.
  - `receipts.category_id` → `(category_id, user_id) references categories (id, user_id) on delete set null (category_id)`. Uses PG15+ column-list `set null`; PGlite is PG17.
  - Every table has `unique (id, user_id)`.
  - RLS on all three tables, with four policies each for `authenticated`: `using/with check (user_id = (select auth.uid()))`.
  - `grant select, insert, update, delete on all three to authenticated`; nothing to `anon`.
  - Trigger `on_auth_user_created` `after insert on auth.users`, calling `public.handle_new_user()` (`security definer`, `set search_path = ''`). It inserts the 15 defaults from `Code.gs` `DEFAULT_CATEGORIES` with `sort_order` 0..14.

- [ ] **Step 1: Write failing tests:**
  - `"a new user gets the 15 default categories in order"`: `select name, type, color from categories order by sort_order` as that user equals `DEFAULT_CATEGORIES`.
  - `"user B sees none of A's rows and cannot write rows for A"`:
    - insert a transaction as A, then `select count(*)` as B = 0;
    - B `update … where id = <A's tx>` affects 0 rows;
    - B inserting with `user_id = A` fails (RLS);
    - B inserting a transaction with A's `category_id` fails (FK).
  - `"anon cannot read anything"`: role `anon` select → permission error.
- [ ] **Step 2:** Run. Expected FAIL.
- [ ] **Step 3:** Write `0001_schema.sql`.
- [ ] **Step 4:** Run. Expected PASS.
- [ ] **Step 5:** Commit `feat(cloud): Supabase schema with per-user RLS and default categories`.

### Task 3: Core API: helpers, categories, transactions, import

**Files:**
- Create: `cloud/supabase/migrations/0002_api_core.sql`
- Test: `cloud/tests/sql.test.mjs`

**Interfaces:**
- Consumes: Task 2 tables; `callApi` from Task 1.
- Produces:
  - Helpers in schema `public`, prefixed `api__` (double underscore) and not granted to anyone:
    - `api__fail(status int, msg text)` raises `errcode = 'PT' || status`;
    - `api__type(jsonb)`, `api__amount(jsonb) → numeric`, `api__date(jsonb) → date`, `api__month(jsonb) → text`, `api__id(jsonb, label text) → bigint`, `api__text(jsonb, max int, label text) → text`, `api__name(jsonb)`, `api__color(jsonb)`, `api__budget(jsonb) → numeric|null`, `api__stamp(timestamptz) → text`, `api__tx_json(transactions, categories) → jsonb`.
    - Each validator reproduces the matching `v*_` in `Code.gs`: same status codes, same messages.
  - Actions, each `public.api_<x>(p jsonb default '{}') returns jsonb language plpgsql security invoker set search_path = public`:
    - `api_categories_list`, `api_categories_create`, `api_categories_update`, `api_categories_delete`;
    - `api_transactions_list`, `api_transactions_create`, `api_transactions_update`, `api_transactions_delete`, `api_transactions_import`.
  - `api_transactions_delete` returns `{ok, receipts_removed, removed_files: text[]}`, where `removed_files` are the `storage_path`s of the receipt rows it deleted. Task 7 strips `removed_files` before replying.
  - Grants: `revoke execute on all functions in schema public from public, anon`, then `grant execute on function api_<each> to authenticated`. Put this pattern at the end of every API migration.

- [ ] **Step 1: Port tests from `cloud/tests/backend.test.mjs`** into `sql.test.mjs` with a helper `start()` that creates users A and B, builds `cats` from `api_categories_list`, and wraps `callApi`. Port these cases with the same assertions and the same Thai message regexes:
  - transaction create/update/delete with half-up rounding (`"120.505"` → `120.51`);
  - ids never reused;
  - bad input rejected with Thai messages;
  - tricky text round trip, dropping the Sheet-formula assertion;
  - categories create/duplicate/rename/delete with move;
  - category budgets;
  - last category of a type can't be deleted;
  - import skips duplicates, keeps in-file repeats, creates categories.

  Drop the Sheet-, secret-, lock- and setup-specific cases. Add:
  - `"B cannot update, delete or move into A's rows"`: B's `transactions.update {id: A's tx}` → 404; `transactions.delete` → 404; B's `categories.delete {id: B's cat, move_to: A's cat}` → 400 `/หมวดหมู่ปลายทางไม่ถูกต้อง/`; B's `transactions.create` with A's `category_id` → 400 `/ไม่พบหมวดหมู่นี้/`.
  - `"import is all-or-nothing on a database error"`: make the 2nd fresh row violate a check by calling with a stubbed constraint (e.g. `alter table transactions add constraint t check (note <> 'boom')` in the test). After the 400, the row count and the category count are unchanged.
- [ ] **Step 2:** Run. Expected FAIL.
- [ ] **Step 3:** Implement `0002_api_core.sql`.
  - The import de-dup key is `(date, type, category_id, amount, note)`, with multiset counting as in `a_transactionsImport_`.
  - New category colours cycle through `NEW_CATEGORY_COLORS` starting at index `(existing category count) % 7`.
  - Error reporting is unchanged: the first 20 errors, plus `error_count`.
- [ ] **Step 4:** Run. Expected PASS.
- [ ] **Step 5:** Commit `feat(cloud): categories and transactions as Postgres functions`.

### Task 4: Month and year summaries

**Files:**
- Create: `cloud/supabase/migrations/0003_api_summaries.sql`
- Test: `cloud/tests/sql.test.mjs`

**Interfaces:**
- Produces `api_month_get(p {month})` and `api_yearly_get(p {year})`, returning exactly the shapes of `a_monthGet_` and `a_yearlyGet_`:
  - `daily` has one entry per day of the month;
  - `by_category` items are sorted by total, descending;
  - `top_expense_categories` has at most 8 entries;
  - `cumulative_balance` covers everything before the first day of the next month;
  - `previous` is the totals of the previous month;
  - `transactions` are sorted newest first (date desc, id desc).

- [ ] **Step 1:** Port `"month summary: totals, previous month, cumulative balance, daily and per category"` and the yearly test from `backend.test.mjs` (same numbers). Add `"summaries never include another user's rows"`.
- [ ] **Step 2:** Run. Expected FAIL.
- [ ] **Step 3:** Implement. Year validation is `1900..2999`, else 422 `'ข้อมูลไม่ถูกต้อง: ปี'`.
- [ ] **Step 4:** Run. Expected PASS.
- [ ] **Step 5:** Commit `feat(cloud): month and year summaries in SQL`.

### Task 5: Receipts API and quota

**Files:**
- Create: `cloud/supabase/migrations/0004_api_receipts.sql`
- Test: `cloud/tests/sql.test.mjs`

**Interfaces:**
- Produces:
  - `api_receipts_create(p)`.
    - Params: `{merchant, amount|null, date, hint_names: text[], storage_path, size, mime, original_name, text_source, confidence, candidates: jsonb[], flags: jsonb[], error, ocr_text}`.
    - Validation:
      - `mime ∈ {image/jpeg, image/png, application/pdf}`;
      - `storage_path` starts with `auth.uid()::text || '/'`, else 400 `'ข้อมูลไม่ถูกต้อง: ไฟล์'`;
      - `ocr_text` is truncated to 4000 characters;
      - if the account's current `sum(size)` plus the new `size` exceeds 104857600 → 413 `'พื้นที่เก็บใบเสร็จของบัญชีนี้เต็มแล้ว (100 MB) — ลบใบเสร็จเก่าก่อน'`.
    - Category from `hint_names`, porting `categoryForHint_`: exact name match in hint order, then substring either way, then `'อื่นๆ'`, then the first expense category by `(sort_order, id)`.
    - Returns `receiptOut_` shape (`is_pdf`, `candidates`/`flags` as arrays).
  - `api_receipts_list`, `api_receipts_update`, `api_receipts_commit`: ports of the `a_*_` functions.
  - `api_receipts_delete` → `{ok, removed_files: text[]}`.
  - `api_receipts_file(p {id})` → `{storage_path, mime, original_name}`, or 404 `'ไม่พบไฟล์ใบเสร็จ'`.
  - Deleting a category already sets pending receipts' `category_id` to null via the FK.

- [ ] **Step 1: Port tests:**
  - draft edits stored, saved receipts can't be edited;
  - commit writes nothing unless every item is valid;
  - deleting a transaction removes its receipt row (and returns the path in `removed_files`);
  - deleting a pending receipt returns its path;
  - deleting a category clears it from pending receipts.

  Add:
  - `"category hint picks the matching expense category"` (`hint_names: ['อาหารและเครื่องดื่ม']` → that id; `[]` → `อื่นๆ` expense);
  - `"quota: the upload that crosses 100 MB is refused"`;
  - `"storage_path outside the user's folder is refused"`;
  - `"B cannot commit, update, delete or fetch the file of A's receipt"` (404 each).
- [ ] **Step 2:** Run. Expected FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected PASS.
- [ ] **Step 5:** Commit `feat(cloud): receipts functions with per-account storage quota`.

### Task 6: Throttle, account deletion, storage policies

**Files:**
- Create: `cloud/supabase/migrations/0005_auth.sql`, `cloud/supabase/migrations/0006_storage.sql`
- Test: `cloud/tests/sql.test.mjs`

**Interfaces:**
- Produces:
  - `private.auth_attempts(kind text, key text, count int, window_end timestamptz, primary key (kind, key))`. Schema `private` has no grants.
  - `public.auth_throttle(p_kind text, p_key text, p_outcome text) returns jsonb {blocked: bool}`, `security definer`, `set search_path = ''`, execute granted to `service_role` only.
    - For `kind = 'login'`:
      - `outcome 'check'` → blocked iff count ≥ 8 and `window_end > now()`;
      - `'fail'` → count+1, `window_end = now() + 15 min` (count resets first if the window has passed);
      - `'ok'` → delete the row.
    - For kinds `signup|recover|resend`, only `outcome 'hit'` is accepted:
      - if the window has passed, reset to count 1 with `window_end = now() + 1 hour`;
      - otherwise count+1;
      - blocked iff count > 5 after the increment.
    - Anything else → `PT400`.
  - `public.api_delete_account(p {email})`: `security definer`, `set search_path = ''`, owner = the migration's role.
    - Refuses with 400 `'อีเมลไม่ตรงกับบัญชีนี้'` unless `lower(p->>'email') = lower(auth.jwt()->>'email')`.
    - Otherwise `delete from auth.users where id = auth.uid()` and returns `{ok: true}`. Granted to `authenticated`.
  - `0006_storage.sql`:
    - `insert into storage.buckets (id, name, public) values ('receipts','receipts',false) on conflict do nothing`;
    - policies on `storage.objects` for `authenticated`: select / insert / delete where `bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text`.
- [ ] **Step 1: Failing tests:**
  - `"login throttle blocks after 8 failures and a success clears it"`;
  - `"signup throttle allows 5 per hour per key"`;
  - `"authenticated users cannot call auth_throttle"` (→ 500 or permission error);
  - `"delete account needs the matching email and removes every row"` (A's rows gone, B's intact, `auth.users` row gone);
  - `"storage policy: B cannot see A's objects"` (insert into `storage.objects` as A under `A/…`; select as B → 0; insert as B under `A/…` → error).

  To test windows without waiting, update `window_end` directly as superuser.
- [ ] **Step 2:** Run. Expected FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected PASS.
- [ ] **Step 5:** Commit `feat(cloud): sign-in throttle, account deletion and storage policies`.

### Task 7: Fake Supabase server

**Files:**
- Create: `cloud/dev/fake-supabase.mjs`
- Test: `cloud/tests/fake-supabase.test.mjs` (small; it proves the fake honours the contract Vercel relies on)

**Interfaces:**
- Consumes: `createDb`, `createUser`, `callApi`, `ApiError` (Task 1).
- Produces:
  - `startFakeSupabase({db, siteUrl, accessTtlSeconds = 3600, port = 0, log = false}) → Promise<{url, anonKey, serviceKey, mailbox: Array<{to, type: 'email'|'recovery', link}>, close()}>`.
  - `anonKey` = `"sb_publishable_fake"`, `serviceKey` = `"sb_secret_fake"`.
  - Every request needs `apikey` equal to one of them, else 401 `{message: "Invalid API key"}`.
  - **Auth (`/auth/v1`):**
    - `POST /token?grant_type=password {email,password}`:
      - success → 200 `{access_token, token_type:"bearer", expires_in, expires_at, refresh_token, user:{id,email}}`;
      - bad credentials → 400 `{error_code:"invalid_credentials", msg}`;
      - unconfirmed → 400 `{error_code:"email_not_confirmed"}`.
    - `POST /token?grant_type=refresh_token {refresh_token}`: rotates. The old token stays valid for 10 s (reuse interval), after which it's 400 `{error_code:"refresh_token_already_used"}`; unknown → 400 `{error_code:"refresh_token_not_found"}`.
    - `POST /logout` (Bearer): revokes all of that user's refresh tokens → 204.
    - `GET /user` (Bearer) → 200 user, or 401 `{error_code:"bad_jwt"}`.
    - `PUT /user {password}` (Bearer): password < 6 → 422 `{error_code:"weak_password"}`.
    - `POST /signup {email,password}`:
      - new email → creates an unconfirmed user and pushes a mailbox entry `link = siteUrl + "/confirm.html?token_hash=<hex>&type=email"` → 200 `{id, email}`;
      - existing email → the same 200 shape with no mail;
      - invalid email → 400 `{error_code:"email_address_invalid"}`;
      - weak password → 422 `weak_password`.
    - `POST /recover {email}`: always 200 `{}`; mails a `type=recovery` link only if the user exists.
    - `POST /resend {type:"signup", email}`: 200 `{}`; mails again if the user is unconfirmed.
    - `POST /verify {type, token_hash}`: one-time use. Confirms the email for `type=email` and returns a session like the password grant. A used or unknown token gives 403 `{error_code:"otp_expired"}`.
    - JWTs are HS256 signed with an internal secret, with claims `{sub, email, role:"authenticated", exp, aud:"authenticated"}`.
  - **PostgREST:** `POST /rest/v1/rpc/<fn>` with body `{p}`.
    - User JWT → `callApi(db, sub, fn, body.p, {email})`. Service key → role `service_role`, with args passed as named parameters (`auth_throttle` takes `{p_kind, p_key, p_outcome}`).
    - Expired or invalid JWT → 401 `{code:"PGRST301", message:"JWT expired"}`.
    - `ApiError` → its status with `{code:"PT"+status, message}`. Other errors → 400 `{code, message}`.
  - **Storage (`/storage/v1`):**
    - `POST /object/receipts/<path>` (Bearer, raw body, `content-type`) → 200 `{Key}`. Allowed only when the first path segment equals `sub`, else 403 `{statusCode:"403", error:"Unauthorized"}`. Also inserts the `storage.objects` row via the superuser so policy tests stay meaningful.
    - `GET /object/receipts/<path>` → bytes with the stored content-type, 404 if missing or not the owner.
    - `DELETE /object/receipts {prefixes:[paths]}` → 200 `[{name}]` for the deleted objects; ignores paths the caller doesn't own.
    - `POST /object/list/receipts {prefix, limit, offset}` → `[{name}]` (names relative to the prefix), at most `limit`, default 100.
- [ ] **Step 1: Failing tests:**
  - password grant then `GET /user`;
  - refresh rotation plus the 10 s reuse window (inject a clock: the fake reads time through an exported `setFakeNow(ms|null)`);
  - rpc maps `PT404` to HTTP 404;
  - expired access token → 401 `PGRST301`;
  - signup → mailbox link → verify → session; a second verify → 403 `otp_expired`;
  - storage owner-only access and list pagination.
- [ ] **Step 2:** Run. Expected FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected PASS.
- [ ] **Step 5:** Commit `test(cloud): fake Supabase (auth, rpc, storage) on PGlite`.

### Task 8: Vercel: config, Supabase client, sessions, login/logout/session/rpc

**Files:**
- Create: `cloud/vercel/lib/supabase.js`, `cloud/vercel/lib/session.js`
- Modify: `cloud/vercel/lib/server.js`, `cloud/vercel/api/login.js`, `logout.js`, `session.js`, `rpc.js`; `cloud/dev/server.mjs`
- Test: rewrite `cloud/tests/vercel.test.mjs`

**Interfaces:**
- Consumes: `startFakeSupabase` (Task 7), `createDb`, `createUser`.
- Produces:
  - `server.js`:
    - keeps `HttpError`, `json`, `handler`, `requireSameOrigin`, `readJson`, `clientKey`, `readCookie`;
    - `HttpError(status, message, code?)`; `handler` adds `code` to the JSON body when it is set;
    - `config() → {supabaseUrl, anonKey, serviceKey, ocrUrl, ocrSecret}`, naming missing variables in Thai as today;
    - removes `passwordMatches`, `createSession`, `sessionValid`, `sessionCookie`, `requireSession`, `callBackend`;
    - `export const VERSION = "3.0.0"`.
  - `supabase.js` (all functions take `cfg = config()` last):
    - **Auth:** `signIn(email, password)`, `refresh(refreshToken)`, `signOut(accessToken)`, `getUser(accessToken)`, `updatePassword(accessToken, password)`, `signUp(email, password)`, `recover(email)`, `resend(email)`, `verify(type, tokenHash)`.
      - Sessions are `{access_token, refresh_token, expires_at, user:{id,email}}`.
      - Failures are thrown as `HttpError` via `authError(body, status)`, which maps `error_code`:

        | `error_code` | Status | Message | `code` |
        |---|---|---|---|
        | `invalid_credentials` | 401 | `'อีเมลหรือรหัสผ่านไม่ถูกต้อง'` | — |
        | `email_not_confirmed` | 403 | `'ยังไม่ได้ยืนยันอีเมล — เปิดลิงก์ในอีเมลที่เราส่งให้ หรือกดส่งอีกครั้ง'` | `email_not_confirmed` |
        | `weak_password` | 422 | `'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร'` | — |
        | `email_address_invalid` | 422 | `'อีเมลไม่ถูกต้อง'` | — |
        | `otp_expired` | 410 | `'ลิงก์นี้ใช้แล้วหรือหมดอายุ — ขอลิงก์ใหม่'` | `link_expired` |
        | `over_email_send_rate_limit` / 429 | 429 | `'ส่งอีเมลบ่อยเกินไป รอสักครู่แล้วลองใหม่'` | — |
        | refresh-token errors | — | throw `AuthExpired` | — |
        | anything else | 502 | `'ระบบบัญชีผู้ใช้ (Supabase) ทำงานไม่สำเร็จ'` | — |

      - Network failure or a 10 s timeout → 504 `'ติดต่อ Supabase ไม่ได้ ลองใหม่อีกครั้ง'`.
    - **Data:** `rpc(fn, params, accessToken) → data`. PostgREST errors become `HttpError(status, body.message)`; 401 throws `AuthExpired`.
    - `serviceRpc(fn, args)`.
    - **Storage:** `storageUpload(token, path, bytes, mime)`, `storageDownload(token, path) → {bytes, mime}`, `storageRemove(token, paths)`, `storageList(token, prefix) → string[]`, which pages through all results 100 at a time.
    - `class AuthExpired extends Error`.
  - `session.js`:
    - `ACCESS_COOKIE = "sb_access"`, `REFRESH_COOKIE = "sb_refresh"`;
    - `sessionCookies(session) → string[]`, `clearSessionCookies() → string[]`;
    - `jwtPayload(token) → object|null` (base64url decode, no verification);
    - `withUser(request, fn: (user:{token, id, email}) => Promise<Response>) → Promise<Response>`:
      1. Read the cookies. With no refresh cookie → 401 `'ยังไม่ได้เข้าสู่ระบบ'` plus cleared cookies.
      2. Refresh first if the access token is missing or `exp*1000 - now < 60_000`.
      3. Call `fn`. On `AuthExpired`, refresh once and retry once.
      4. If any refresh throws `AuthExpired` → 401 plus cleared cookies.
      5. Append the refreshed `set-cookie` headers to `fn`'s response.
  - `api/login.js POST {email, password}`:
    1. `requireSameOrigin`.
    2. Key = `sha256(clientKey(request) + "\n" + email.trim().toLowerCase())`; `serviceRpc('auth_throttle', {p_kind:'login', p_key, p_outcome:'check'})`. If blocked → 429 `'ใส่รหัสผ่านผิดหลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่'`.
    3. `signIn`. Record `fail` only on `invalid_credentials` and `ok` on success, then set the cookies.
  - `api/logout.js`: best-effort `signOut`, then clear the cookies.
  - `api/session.js GET` → `{authenticated, email}`, using `withUser` to refresh when needed (it never throws a 401 body to this page; `{authenticated:false}` instead).
  - `api/rpc.js`:
    - same `ALLOWED` set, keeping `info` and adding nothing;
    - `info` is answered in Vercel as `{version: VERSION, email}`;
    - every other action → `rpc('api_' + action.replace('.', '_'), params, user.token)`;
    - for `transactions.delete` / `receipts.delete`, call `storageRemove` on `removed_files` (log, never fail) and drop the field from the reply;
    - `receipts.upload` goes to Task 9's `uploadReceipt`.
  - `dev/server.mjs` `startDev({port, ocr, accessTtlSeconds}) → {url, db, supabase, users: {a:{email:"dev@example.com", password:"dev-password"}, b:{email:"dev2@example.com", password:"dev-password"}}, mailbox, close}`:
    - creates the DB and users, starts the fake Supabase and the fake OCR (Task 10; until then a stub that returns `""`), and sets the `process.env` vars;
    - the CLI banner prints both accounts and says sent emails are printed to this console.
- [ ] **Step 1: Rewrite `vercel.test.mjs`.** Keep the intent and assertions of these existing tests:
  - nothing readable without signing in;
  - wrong password refused, right password sets locked-down cookies (now two cookies, both with `HttpOnly`, `Secure`, `SameSite=Strict`, `Max-Age=2592000`);
  - signed-in rpc read/write;
  - forged/tampered cookies refused;
  - logout clears both cookies and a later rpc with the old cookies is 401;
  - 8 wrong passwords block that email from that address even with the right password, while another email from the same address is not blocked;
  - same-origin checks;
  - only listed actions pass (`auth_throttle`, `api__fail` and `delete_account` as actions → 404);
  - validation errors keep status and Thai message;
  - missing settings named;
  - size limit;
  - security headers;
  - no inline scripts.

  New:
  - `"an expired access token is refreshed transparently and new cookies are set"` (`accessTtlSeconds: 1`, wait > 1 s or use `setFakeNow`);
  - `"two requests refreshing with the same refresh token both succeed"` (Review Focus 1);
  - `"each account sees only its own book through /api/rpc"`;
  - `"Supabase unreachable gives 504 with a Thai message"` (point `SUPABASE_URL` at a closed port).
- [ ] **Step 2:** Run `node --test tests/vercel.test.mjs`. Expected FAIL.
- [ ] **Step 3:** Implement the files above. Before writing `signIn`, check Supabase's current docs for whether Auth honours a forwarded client IP from server-side callers. Record the finding in a comment in `login.js`. Keep our own throttle either way (spec).
- [ ] **Step 4:** Run `npm test`. Expected: `vercel`, `sql` and `fake-supabase` tests PASS. `parser`/`csv` are untouched and still PASS; `backend.test.mjs` is deleted in Task 10.
- [ ] **Step 5:** Commit `feat(cloud): Vercel signs in with Supabase Auth and runs actions as the user`.

### Task 9: Receipt upload and file serving through Storage

**Files:**
- Create: `cloud/vercel/lib/parser.js`, `cloud/vercel/lib/receipts.js`, `cloud/vercel/lib/ocr.js`
- Modify: `cloud/vercel/api/rpc.js`, `cloud/vercel/api/file.js`, `cloud/tests/parser.test.mjs`
- Test: `cloud/tests/vercel.test.mjs`

**Interfaces:**
- Produces:
  - `parser.js`: `export { parseReceiptText, HINT_CATEGORY_NAMES }`, the body of `Parser.gs` unchanged apart from the exports. `parser.test.mjs` imports it directly instead of using `vm`.
  - `ocr.js`: `ocrText(bytes: Buffer, mime) → Promise<string>`.
    - POSTs `{secret, mime, data: base64}` to `APPS_SCRIPT_URL` (`redirect: follow`, 55 s timeout) and expects `{ok:true, data:{text}}`.
    - On failure, throws `HttpError` with the same messages as today's `callBackend` (wrong secret / non-JSON / unreachable). A backend error with status 503 passes its message through; this is how the Drive-API-missing message arrives.
  - `receipts.js`:
    - `sniffMime(bytes) → '' | mime` (port of `sniffMime_`);
    - `todayBangkok(now = Date.now()) → 'YYYY-MM-DD'`;
    - `uploadReceipt(user, {name, data}, cfg) → receipt json`:
      1. Validate: no data → 400 `'ไม่มีไฟล์'`; base64 length > 2.5 MB × 4/3 + 8 → 413 `'ไฟล์ใหญ่เกิน 2.5 MB'`; unknown mime → 400 `'รองรับเฉพาะรูป JPG, PNG และไฟล์ PDF'`.
      2. `path = user.id + '/' + randomUUID() + '.' + ext`; `storageUpload`. On failure → 502 `'เก็บไฟล์ใบเสร็จไม่สำเร็จ ลองใหม่อีกครั้ง'`.
      3. `ocrText` in try/catch. The error text is the 503 message if one came back, else `'อ่านตัวอักษรจากไฟล์ไม่สำเร็จ ใส่ยอดเองได้'`.
      4. `parseReceiptText(text, todayBangkok())`; flags as in `a_receiptsUpload_`.
      5. `rpc('api_receipts_create', {…, date: parsed.date || today, hint_names: HINT_CATEGORY_NAMES[parsed.category_hint] || [], size: bytes.length, text_source: pdf ? 'drive-pdf' : 'drive-ocr'})`.
      6. If step 5 throws, `storageRemove([path])` and rethrow.
  - `api/file.js GET ?id=`: `withUser`, then `rpc('api_receipts_file', {id})`, then `storageDownload`, then today's response headers.
- [ ] **Step 1: Failing tests** in `vercel.test.mjs`:
  - port `"a receipt goes up as base64, is read, and its file comes back through /api/file"`;
  - `"B cannot fetch A's receipt file"` → 404;
  - `"OCR down: the receipt is still saved with an error and no amount"` (Review Focus 4; `startDev({ocr: () => { throw … }})` or point `APPS_SCRIPT_URL` at a closed port);
  - `"storage failure leaves no receipt row"` (fake upload fails: give the test a hook `supabase.failNextUpload()`);
  - `"deleting the transaction removes the stored file"` (file → 404 afterwards).
- [ ] **Step 2:** Run. Expected FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected PASS.
- [ ] **Step 5:** Commit `feat(cloud): receipts stored in Supabase Storage, OCR via Apps Script`.

### Task 10: OCR-only Apps Script

**Files:**
- Create: `cloud/apps-script/Ocr.gs`, `cloud/tests/ocr.test.mjs`
- Delete: `cloud/apps-script/Code.gs`, `cloud/apps-script/Parser.gs`, `cloud/tests/backend.test.mjs`
- Modify: `cloud/dev/fake-google.mjs` (`loadOcr({ocr, driveApi = 'v3'|'v2'|null})` loads only `Ocr.gs`; drop the Sheets/Cache/Lock fakes that nothing uses any more), `cloud/dev/server.mjs` (the fake OCR web app keeps today's 302-to-echo behaviour)

**Interfaces:**
- Produces, in `Ocr.gs`:
  - `doPost(e)` with body `{secret, mime, data}`:
    - bad JSON → `{ok:false,status:400}`;
    - wrong secret → `{ok:false,status:401,error:'unauthorized'}`;
    - mime not jpeg/png/pdf, or decoded bytes > 2.5 MB → 400;
    - Drive service missing → `{ok:false,status:503,error:'ยังไม่ได้เพิ่มบริการ Drive API ใน Apps Script (Services → + → Drive API) จึงอ่านตัวอักษรไม่ได้ ใส่ยอดเองได้'}`;
    - success → `{ok:true,data:{text}}`.
  - It reuses `ocrText_` (v3 and v2 paths) and `secretOk_`.
  - `doGet()` → `'income-expense ocr 3.0.0'`.
  - `setup()` creates `API_SECRET` only and logs it. `showSecret()` and `rotateSecret()` are unchanged.
- [ ] **Step 1: Failing tests** in `ocr.test.mjs`:
  - `"requests without the right secret get nothing"` (ported);
  - `"returns the OCR text and leaves no file behind"` (the fake Drive has 0 files afterwards);
  - `"v2 Drive API is used when v3 is not there"` (ported);
  - `"missing Drive service gives 503 with the Thai message"`;
  - `"oversized or unknown files are refused"`.
- [ ] **Step 2:** Run. Expected FAIL.
- [ ] **Step 3:** Implement, delete the old files, and simplify `fake-google.mjs`.
- [ ] **Step 4:** Run `npm test`. Expected: everything PASSES, and no test references `Code.gs`.
- [ ] **Step 5:** Commit `feat(cloud): Apps Script reduced to a stateless OCR endpoint`.

### Task 11: Sign-up, email links, password and account deletion (API + pages)

**Files:**
- Create: `cloud/vercel/api/signup.js`, `recover.js`, `resend.js`, `verify.js`, `password.js`, `account.js`; `cloud/vercel/public/signup.html` + `signup.js`, `forgot.html` + `forgot.js`, `confirm.html` + `confirm.js`, `password.html` + `password.js`; `cloud/supabase/templates/confirm-signup.html`, `reset-password.html`
- Modify: `cloud/vercel/public/login.html`, `login.js`, `common.js` (`apiPost` error gets `err.code = data.code`), `style.css` (only if the new pages need anything beyond the existing `.login-*` classes)
- Test: create `cloud/tests/auth-flows.test.mjs`; extend the inline-script page list in `vercel.test.mjs` to every `*.html` in `public/` (glob)

**Interfaces:**
- Consumes: `supabase.js` auth functions and `withUser`, `sessionCookies`, `clearSessionCookies` (Task 8).
- Produces (every POST runs `requireSameOrigin` first):
  - `POST /api/signup {email, password}`:
    1. Password < 8 → 422 `'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร'`.
    2. `auth_throttle('signup', sha256(ip), 'hit')`; blocked → 429 `'ขอบ่อยเกินไป รอ 1 ชั่วโมงแล้วลองใหม่'`.
    3. `signUp` → `{ok:true}`.
  - `POST /api/recover {email}`: throttle kind `recover`, then `recover` → `{ok:true}`. Always `{ok:true}`, even for unknown emails.
  - `POST /api/resend {email}`: throttle kind `resend`, then `resend` → `{ok:true}`.
  - `POST /api/verify {token_hash, type ∈ {email, recovery}}` → `verify` → sets the cookies → `{ok:true, next: type === 'recovery' ? '/password.html?reset=1' : '/'}`.
  - `POST /api/password {password}`: `withUser`, then `updatePassword` → `{ok:true}`.
  - `POST /api/account {action:'delete', email}`, under `withUser`:
    1. If the email doesn't match the user's (case-insensitive) → 400 `'อีเมลไม่ตรงกับบัญชีนี้'`, without touching Storage.
    2. `storageList(token, user.id)` → `storageRemove` in batches of 100.
    3. `rpc('api_delete_account', {email})`.
    4. Clear the cookies → `{ok:true}`.
  - **Pages:** the same head, logo and card markup as `login.html`, the scripts `common.js` + their own file, `?v=3.0.0`.
    - `login.html`:
      - fields `#email` (`autocomplete="email"`) and `#password`; the hidden `username` field and the APP_PASSWORD hint are removed;
      - links "สมัครสมาชิก" → `/signup.html` and "ลืมรหัสผ่าน?" → `/forgot.html`;
      - on `err.code === 'email_not_confirmed'`, show a `#resend-btn` that calls `/api/resend`.
    - `confirm.html`: reads `token_hash` and `type` from the query and shows one button.
      - `type=email` → "ยืนยันอีเมล"; `type=recovery` → "ตั้งรหัสผ่านใหม่".
      - Missing params → the expired message straight away.
      - On `err.code === 'link_expired'`, show the message plus links to `/login.html` and `/forgot.html` (Review Focus 2).
    - `password.html`: new password and repeat (they must match on the client); success → `/`.
  - **Email templates:**
    - Thai text. Links: `{{ .SiteURL }}/confirm.html?token_hash={{ .TokenHash }}&type=email` and `…&type=recovery`.
    - Subjects: `ยืนยันอีเมล — สมุดรายรับรายจ่าย` and `ตั้งรหัสผ่านใหม่ — สมุดรายรับรายจ่าย`.
- [ ] **Step 1: Failing tests** in `auth-flows.test.mjs`, over real HTTP against `startDev`:
  - `"sign up → email link → confirm → signed in with own default categories"`;
  - `"sign up with an existing email looks the same and sends nothing"`;
  - `"unconfirmed login gets code email_not_confirmed; resend sends another link"`;
  - `"a used or bogus link gives 410 link_expired"` (Review Focus 2);
  - `"forgot password → link → new password works, old one doesn't"`;
  - `"recover for an unknown email still answers ok and sends nothing"`;
  - `"sign-up is limited to 5 per hour per address"`;
  - `"change password needs a session"`;
  - `"delete account: wrong email refused; right email removes rows and all files (150 receipts → > 1 list page), old cookies get 401, sign-in fails"` (Review Focus 5; to keep it fast, seed 150 objects straight into the fake storage rather than uploading).
- [ ] **Step 2:** Run. Expected FAIL.
- [ ] **Step 3:** Implement the APIs, pages and templates.
- [ ] **Step 4:** Run `npm test`. Expected PASS.
- [ ] **Step 5:** Commit `feat(cloud): open sign-up, email confirmation, password reset and account deletion`.

### Task 12: Signed-in pages: account menu and info

**Files:**
- Modify: `cloud/vercel/public/index.html`, `receipts.html`, `app.js`, `common.js`, `receipts.js` (only the version strings)

**Interfaces:**
- Consumes: `info` → `{version, email}` (Task 8), `/api/account` and `/password.html` (Task 11).
- Produces:
  - **Import/Export dialog** (`index.html` around lines 410-423):
    - replace the Google Sheet backup paragraph and the `#sheet-link`/`#folder-link` buttons with `<p id="account-line">เข้าสู่ระบบด้วย <strong id="account-email"></strong></p>` (filled by `showAccount()` in `app.js`, which replaces `showSheetLinks()`);
    - one sentence on backups: "สำรองข้อมูลได้ด้วยปุ่มดาวน์โหลด CSV ด้านบน" (back up with the download CSV button above).
  - **Sidebar and ⋯ menu on both pages:** next to each `data-logout` button add
    - `<a … href="/password.html">เปลี่ยนรหัสผ่าน</a>` (icon `i-lock` if it is in `icons.svg`, else `i-settings`; check the sprite), and
    - `<button data-delete-account>ลบบัญชี</button>`.
  - **`common.js`:** `data-delete-account` opens a `<dialog id="delete-account-dialog">`. The dialog markup goes in both pages and follows the existing dialog pattern.
    - Copy: "ลบบัญชีและข้อมูลทั้งหมด (รายการ หมวดหมู่ ใบเสร็จ) ย้อนกลับไม่ได้ — พิมพ์อีเมลของคุณเพื่อยืนยัน" (delete the account and all its data, cannot be undone, type your email to confirm).
    - Has an email input, a red confirm button and a cancel button.
    - Success → `location.replace('/login.html?deleted=1')`, where the login page shows "ลบบัญชีแล้ว" (account deleted).
  - The `rpc()` doc comment in `common.js` no longer mentions Google Sheet.
- [ ] **Step 1: Failing test** in `vercel.test.mjs`: `"signed-in pages offer change password and delete account, and no Google Sheet link"`. Read `index.html` and `receipts.html` and assert `/password.html` and `data-delete-account` are present and `sheet-link` is absent.
- [ ] **Step 2:** Run. Expected FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected PASS. Then `npm run dev`, sign in as `dev@example.com`, and in a browser check:
  - add a transaction;
  - upload `tests/fixtures/receipt-restaurant.jpg`, commit it, open its file;
  - change the password;
  - sign up a new user via the console link;
  - delete that user.

  Note any visual issue and fix it in this task.
- [ ] **Step 5:** Commit `feat(cloud): account menu (change password, delete account) on signed-in pages`.

### Task 13: Docs, CI, version, cleanup

**Files:**
- Modify: `cloud/README.md`, `README.md` (the root "มี 2 เวอร์ชัน" bullet), `.github/workflows/ci.yml`, `cloud/vercel/package.json` (version, description)

**Interfaces:** none.

- [ ] **Step 1: Rewrite `cloud/README.md` in Thai:**
  - the new architecture diagram (spec);
  - local try-out (two dev accounts; emails print to the console);
  - real setup:
    1. Supabase project in Singapore; run the migrations in order in the SQL editor, or `supabase db push` with `cloud/supabase` as the project dir.
    2. Auth settings: Site URL, Confirm email on, minimum password length 8, step-by-step custom SMTP with Resend, the two templates.
    3. Apps Script OCR: paste `Ocr.gs`, add the Drive API, run `setup`, deploy a web app (Anyone).
    4. Vercel env table (the 5 variables).
  - migration from the Sheet version (CSV export → sign up → import; images don't move; the old Sheet stays as an archive);
  - security section updated:
    - RLS per account; the service key is used only for the throttle;
    - cookies; throttles; 100 MB quota; account deletion;
    - free-plan pause after about a week idle and how to resume it;
  - troubleshooting table: missing env vars, `Invalid API key`, emails not arriving (SMTP), "Email not confirmed", OCR errors, paused project;
  - real-Supabase smoke checklist: sign up, confirm, add, upload, view file, second account can't see the first, reset password, delete account;
  - internal API table: `info` changed; new `/api/signup|recover|resend|verify|password|account`.
- [ ] **Step 2:** Root `README.md`: the Cloud bullet becomes "หน้าเว็บบน Vercel + ฐานข้อมูลและบัญชีผู้ใช้บน Supabase + อ่านใบเสร็จด้วย Google Apps Script — สมัครใช้ได้หลายคน แต่ละคนมีสมุดของตัวเอง" (web on Vercel, database and accounts on Supabase, receipt reading with Google Apps Script; open to many people, each with their own book).
- [ ] **Step 3:** Add a CI job `cloud` to `.github/workflows/ci.yml`: `actions/setup-node` with Node 22 and an npm cache on `cloud/package-lock.json`, then `npm ci` and `npm test` in `cloud/`. It needs no Python.
- [ ] **Step 4:** Set `cloud/vercel/package.json` version to `3.0.0` with description "สมุดรายรับรายจ่าย — Vercel front end on Supabase (database + auth + storage) with Apps Script OCR". Run `grep -rn "APP_PASSWORD\|SESSION_SECRET\|Google Sheet\|2\.1\.0" cloud/ --include=*.js --include=*.html --include=*.mjs --include=*.gs`. Expected: no hits except the CSV-import comments that refer to the old version on purpose.
- [ ] **Step 5:** Run `cd cloud && npm test`. Expected: all PASS. Run `graphify update .` from the project root (CLAUDE.md rule).
- [ ] **Step 6:** Commit `docs(cloud): Supabase setup, migration and CI`.
