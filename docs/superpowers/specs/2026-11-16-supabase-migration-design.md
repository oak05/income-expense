# Cloud version on Supabase — design

Date: 2026-11-16 · Status: draft for approval · Scope: `cloud/` only (the local Windows app in `app/` is untouched)

## Intent

The Cloud version currently keeps its data in a Google Sheet. Everyone signs in with one shared password (`APP_PASSWORD`). Move it to:

- **Supabase Postgres** for the data,
- **Supabase Auth** for sign-in, with real accounts. **Anyone can sign up, and each person gets their own separate book.**
- **Supabase Storage** for receipt files,
- **Google Apps Script only for receipt OCR.** It receives a file, returns its text and keeps nothing.

The user chose the architecture in which Vercel stays in the middle (approach A below).

## Goals

1. Each account sees and changes only its own categories, transactions and receipts. The database enforces this, not just the Vercel code.
2. The pages (`index.html`, `receipts.html` and their JS) keep working with the same `/api/rpc` actions and response shapes. Only the login page and the "Import / Export" links change.
3. Operations that write several rows are all-or-nothing: receipts commit, CSV import, deleting a category and moving its transactions, and deleting a transaction together with its receipt.
4. A new account starts with the same 15 default categories that `setup()` creates today.
4a. Anyone can create an account with email and password, confirm it by email, reset a forgotten password by email, change their password, and delete their account with all its data.
5. Receipt scanning works as it does today: upload, OCR, parse, review, commit, and view the file later.
6. `npm run dev` and `npm test` still work offline with no Supabase or Google account (see Testing).

## Non-goals

- Changing the local app (`app/`) or its SQLite database.
- Letting the browser talk to Supabase directly, realtime updates, offline use.
- Social / OAuth sign-in (Google, LINE, …).
- CAPTCHA on sign-up (it would need the CSP opened to a third party). Our own per-address limits come first. CAPTCHA is the next step if bots show up.
- Shared books between accounts (a household book). Each account is one book.
- Moving receipt images out of Google Drive. Existing data moves with the existing CSV export/import, which already leaves images behind.
- Keeping the Google Sheet backend running in parallel. This version replaces it.

## Anti-goals (failures even if it "works")

- Any account can read or change another account's rows or files.
- A Supabase key or session token can be read by page JavaScript.
- A multi-row operation can stop halfway and leave the book inconsistent.
- The Thai error messages users see today become generic or English.

## Constraints

- Vercel Functions: Node, request body ≤ 4.5 MB, no build step for `public/`. `cloud/vercel/package.json` currently has no dependencies. Prefer plain `fetch` against Supabase's HTTP APIs over adding `@supabase/supabase-js`.
- CSP stays `connect-src 'self'`. The browser never contacts Supabase or Google.
- Supabase free plan: the project pauses after about a week with no requests and has to be resumed in the dashboard. Limits are 500 MB database and 1 GB storage. README must say this.
- Amounts are baht with 2 decimals, rounded half-up to satang (as today). Dates are `YYYY-MM-DD`, and "today" is Asia/Bangkok.
- User-facing docs (`cloud/README.md`) are in Thai, like the rest of the project.
- **Email needs your own SMTP.** Supabase's built-in email only delivers to the project team's own addresses and is heavily rate-limited, so public sign-up requires a custom SMTP provider configured in the dashboard (for example Resend or Brevo, both with free tiers). The README must walk through this. Without it, sign-up confirmation and password-reset emails never arrive.
- Emails are opened in mail apps that may pre-fetch links. Some security scanners "click" every link, which would use up a one-time token. Email links therefore open a page with a button, never a URL that acts on a plain GET.

## Approaches considered

| | Approach | Trade-off | Decision |
|---|---|---|---|
| **A** | Vercel stays the API. Pages call `/api/rpc`. Vercel signs in with Supabase Auth, keeps the tokens in HttpOnly cookies, and calls Supabase as the signed-in user, so row-level security applies. | One extra hop, but faster than Apps Script. Pages barely change, and secrets and tokens stay server-side. | **Chosen by the user** |
| B | The browser uses Supabase directly, and Vercel only proxies OCR. | Most of `app.js` / `receipts.js` would be rewritten, tokens would be readable by page JS, the CSP would have to open up, and the current tests would be lost. | Rejected |
| C | Like A, but all business logic lives in Postgres functions. | — | Folded into A as an implementation choice (below) |

**Inside A, the business logic lives in Postgres functions (my call).** Each `/api/rpc` action maps to one SQL function, called through PostgREST (`POST /rest/v1/rpc/api_<name>`) with the user's access token. The functions are `SECURITY INVOKER`, so RLS applies to everything they touch. Every action runs in one transaction, which gives goal 3 for free. Vercel never holds a database password. The cost: about 600 lines of Apps Script logic (validation with Thai messages, month/year summaries, import de-duplication, commit) get ported to PL/pgSQL. The alternative, JS in Vercel calling table endpoints, cannot make multi-row writes atomic.

## Architecture

```
Browser ──/api/*──> Vercel Functions ──┬─ Supabase Auth     /auth/v1/*      (sign in, refresh, sign out, user)
 (same pages)       (cookies, checks)  ├─ Supabase PostgREST /rest/v1/rpc/* (all data, as the user → RLS)
                                       ├─ Supabase Storage  /storage/v1/*   (receipt files, as the user)
                                       └─ Apps Script (OCR only) {secret, mime, data} → {text}
```

### Sign-in and sessions

- **Login page:** email and password fields. `POST /api/login {email, password}` calls `POST /auth/v1/token?grant_type=password`.
  - On success: two cookies, `sb_access` (the JWT) and `sb_refresh`. Both are `HttpOnly; Secure; SameSite=Strict; Path=/`, with Max-Age 30 days (today's session length).
  - On failure: the same Thai message as today, "รหัสผ่านไม่ถูกต้อง", worded so it does not reveal whether the email exists.
- **Each API call:**
  - Read `sb_access`. If it is missing or within 60 s of its `exp`, read without verifying the signature, refresh with `grant_type=refresh_token` and set both new cookies on the response. Supabase verifies every token it receives, so skipping the local check is safe.
  - If Supabase answers 401, refresh once and retry once. If the refresh fails, return 401 and the page redirects to login (existing behaviour in `common.js`).
  - Supabase rotates refresh tokens. Its reuse interval covers two tabs refreshing at once.
- **Logout:** `POST /auth/v1/logout` with the access token, which revokes the refresh token, then clear both cookies.
- **`/api/session`:** `GET /auth/v1/user`, returning `{authenticated, email}`.
- **Login throttle:** keep today's rule of 8 failures per caller, then a 15-minute block.
  - Store the counts in table `private.login_attempts`, behind function `login_attempt(key, ok)`, executable only by `service_role`. Vercel calls it with `SUPABASE_SERVICE_ROLE_KEY`. That is the only use of this key; nothing else gets service-role access.
  - Key the count on caller IP plus email, so one attacker cannot lock out everyone.
  - The same table and function (`auth_throttle(kind, key, ok)`) also limit sign-up, "forgot password" and "resend confirmation" to 5 requests per hour per caller IP. That stops one address from mass-creating accounts or spamming inboxes through your SMTP quota.
  - Reason: every sign-in reaches Supabase from Vercel's IPs, so Supabase's own per-IP limits treat all users as one client. *Builder: check whether Supabase Auth honours a forwarded client IP from server-side callers; if it does, note it but keep this throttle.*
- `requireSameOrigin`, `readJson`, the size limits and the security headers stay as they are.

### Data model (`cloud/supabase/migrations/0001_init.sql`)

All tables live in `public`. Each has `user_id uuid not null default auth.uid() references auth.users on delete cascade`, RLS enabled, and one policy per command for role `authenticated`: `user_id = (select auth.uid())`. Grant nothing to `anon`.

- **categories:**
  - `id bigint identity`, `name text` (1–50 chars), `type text check in ('income','expense')`, `color text check ~ '^#[0-9A-Fa-f]{6}$'`, `sort_order int`, `budget numeric(14,2) null check (budget > 0)`.
  - `unique (user_id, type, name)`, `unique (id, user_id)`.
  - Check: budget only on expense categories.
- **transactions:**
  - `id bigint identity`, `type`, `amount numeric(14,2) check (amount > 0 and amount <= 9999999999.99)`, `category_id`, `date date`, `note text` (≤ 500), `receipt_id bigint null`, `created_at timestamptz default now()`, `updated_at timestamptz`.
  - `foreign key (category_id, user_id) references categories (id, user_id)`. The composite key makes it impossible to point at another user's category.
- **receipts:**
  - Columns: `id bigint identity`, `status text check in ('pending','saved')`, `merchant`, `amount numeric(14,2) null`, `date date`, `category_id bigint null`, `included bool`, `transaction_id bigint null`, `storage_path text`, `mime`, `original_name`, `text_source`, `confidence`, `candidates jsonb`, `flags jsonb`, `error`, `ocr_text`, `created_at`.
  - Composite FKs to categories and transactions, as above.
- **Indexes:** `transactions (user_id, date)` and `receipts (user_id, status)`.
- **Default categories:** an `after insert on auth.users` trigger (`SECURITY DEFINER`, fixed `search_path`) inserts the 15 defaults from `Code.gs` for the new user.
- **Storage:** private bucket `receipts`. Policies allow `select`/`insert`/`delete` for `authenticated` only where `(storage.foldername(name))[1] = auth.uid()::text`. Object paths look like `<user_id>/<uuid>.<jpg|png|pdf>`.

### Actions → functions

Each action becomes `public.api_<action>(p jsonb) returns jsonb`, for example `api_month_get`. Each one returns exactly the JSON shape the matching `a_*_` function in `Code.gs` returns today. Amounts are JSON numbers in baht and dates are `YYYY-MM-DD` strings.

- **Validation errors:** raise with `ERRCODE 'PT4xx'`. PostgREST turns that into HTTP status `4xx`, and Vercel passes the status and Thai message through unchanged. The messages are the ones in `Code.gs`.
- **Ported 1:1:**
  - categories list / create / update / delete (with `move_to`, and "keep at least one category per type")
  - transactions list / create / update / delete / import (same de-duplication and auto-created categories, max 5000 rows)
  - month.get, yearly.get
  - receipts list / update / delete / commit
- **Deletes that remove files** (`transactions.delete`, `receipts.delete`): the function also returns the `storage_path`s it removed. Vercel then deletes those objects. That is best effort; failures are logged, the same as `trashFile_` today.
- **`receipts.upload` is orchestrated in Vercel:**
  1. Check the size.
  2. Sniff the MIME type from the first bytes (move `sniffMime_` to JS).
  3. Upload the file to Storage.
  4. Call OCR. On failure, keep going with an error message, as today.
  5. Run `parseReceiptText(text, todayBangkok)`.
  6. Call `api_receipts_create` with the parsed fields and the category hint. The SQL port of `categoryForHint_` picks the category.
  7. If step 6 fails, delete the uploaded object.
- **`info`** now returns `{version, email}`. In `app.js`, the "open Google Sheet / Drive folder" links are replaced by "signed in as <email>".
- **`/api/file?id=`:** look up the receipt through `api_receipts_file` (RLS applies), download the object from Storage with the user's token, and stream it back with today's headers.
- **Execute grants:** revoke execute on `api_*` from `public` and `anon`, and grant it to `authenticated`.

### OCR on Apps Script

- Replace `Code.gs` with a small `Ocr.gs`:
  - `doPost {secret, mime, data}` returns `{ok, data: {text}}`, using the same Drive OCR code (`ocrText_`), which deletes its temporary Doc.
  - The secret check and the `setup()` / `showSecret()` / `rotateSecret()` helpers stay.
  - No Sheet, no folder, no stored data.
- `Parser.gs` moves to `cloud/vercel/lib/parser.js` as an ES module (same rules, same tests), because parsing now happens in Vercel.

### Configuration (Vercel env)

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (sign-in throttle only), `APPS_SCRIPT_URL`, `APPS_SCRIPT_SECRET`. `APP_PASSWORD` and `SESSION_SECRET` are removed. `config()` keeps naming whatever is missing, in Thai.

### Accounts (open sign-up, decided by the user)

Email and password only. Public sign-up is **on**, and "Confirm email" is **on** in Supabase.

**Pages** (all static, no inline scripts, same look as `login.html`):

| Page | What it does |
|---|---|
| `login.html` | Email and password, plus links to "สมัครสมาชิก" (sign up) and "ลืมรหัสผ่าน" (forgot password). An unconfirmed email gets a Thai message and a "send confirmation again" button. |
| `signup.html` | Email, password (min 8) and repeated password → `POST /api/signup` → `POST /auth/v1/signup`. Always shows "check your email" afterwards. Supabase answers the same way for an existing email, so the page reveals nothing about which emails are registered. |
| `forgot.html` | Email → `POST /api/recover` → `POST /auth/v1/recover`. Always shows "if this email has an account, we sent a link". |
| `confirm.html` | The target of both email links (`?token_hash=…&type=signup\|recovery`). Shows one button. Clicking it does `POST /api/verify` → `POST /auth/v1/verify {type, token_hash}`, sets the session cookies, then goes to `/` (signup) or `/password.html` (recovery). The button is there so link scanners can't use up the token, and so the cookies are set by a same-site request (`SameSite=Strict` cookies set during a cross-site redirect chain wouldn't be sent on the next hop). |
| `password.html` | Signed in only: new password and repeat → `POST /api/password` → `PUT /auth/v1/user`. Used after a reset and from a "เปลี่ยนรหัสผ่าน" (change password) menu item. |

**Email templates:**
- Thai versions of the "Confirm signup" and "Reset password" templates live in `cloud/supabase/templates/` and are pasted into the dashboard.
- They link to `{{ .SiteURL }}/confirm.html?token_hash={{ .TokenHash }}&type=…` instead of `{{ .ConfirmationURL }}`, so the token goes to our page, not straight to Supabase.
- The Supabase **Site URL** is set to the Vercel URL.

**Delete account:**
- A "ลบบัญชี" (delete account) item lives in the account menu. It asks for confirmation by typing the email.
- Vercel first deletes the user's Storage folder with the user's token, then calls `api_delete_account()`. That function is `SECURITY DEFINER`, owned by `postgres`, with a fixed `search_path`, and only deletes `auth.users where id = auth.uid()`. The cascade removes all the user's rows.
- Then Vercel clears the cookies.
- Reason (my call): with open sign-up, people need a way to remove their financial data without asking you. Thailand's PDPA expects this.

**Storage quota per account (my call):** at most 100 MB of receipt files per account. Each receipt stores its byte `size`, and `api_receipts_create` refuses with 413 and a Thai message once the account is over the limit. Reason: one account must not be able to fill the shared 1 GB free-plan storage.

## Testing and local dev

- **SQL:** run the migration in **PGlite** (`@electric-sql/pglite`, a devDependency of `cloud/package.json` only). It needs a small stub of Supabase's `auth` schema: an `auth.users` table and `auth.uid()` reading `request.jwt.claims`, the same way Supabase does it. Port the existing `backend.test.mjs` cases to call the `api_*` functions as two different users. Add:
  - user B cannot read, update or delete user A's rows, or reference A's categories;
  - the default categories appear for a new user;
  - a failed commit or import writes nothing.
- **Vercel:** `dev/fake-supabase.mjs` serves the small slice of GoTrue, PostgREST and Storage that Vercel uses, on top of PGlite. Port `vercel.test.mjs` to it: cookies, refresh, logout, same-origin checks, the throttle, the file round trip and size limits. Add a test that an expired access token is refreshed transparently.
- **OCR:** `dev/fake-ocr.mjs` returns the existing sample receipt texts. `Ocr.gs` gets a small test with the fake Drive.
- **Dev users:** `npm run dev` creates two confirmed accounts, `dev@example.com` / `dev-password` and `dev2@example.com` / `dev-password`.
- **Dev email:** the fake GoTrue prints confirmation and reset links to the console instead of sending email, so sign-up, reset and delete can be clicked through locally.
- **Auth-flow tests:** sign-up → confirm → signed in; reset → new password works and the old one doesn't; unconfirmed login is refused with the Thai message; sign-up/recover throttling; delete account removes rows and files, and the user can't sign in afterwards; the 100 MB quota.
- **Real Supabase:** add a smoke-test checklist to the README, because PGlite and the fake are models, not Supabase itself.
- **CI:** add a `node --test` job for `cloud/` to `.github/workflows/ci.yml`. It currently only runs `tests/js/common.test.mjs`.

## Migration and rollout (README, Thai)

1. In the current Cloud app: **Import / Export → download all as CSV**.
2. Create a Supabase project (region: Singapore). Run `cloud/supabase/migrations/*.sql` in the SQL editor, or use `supabase db push`.
3. Configure Auth:
   - Site URL = the Vercel URL.
   - Keep "Confirm email" on.
   - Set up custom SMTP (step-by-step for one free provider).
   - Paste the two Thai email templates.
4. Replace the Apps Script code with `Ocr.gs`, run `setup`, and deploy a new version. The old Sheet stays as an archive.
5. Set the new Vercel env vars, remove the old ones, and redeploy.
6. Sign up, confirm, sign in and use **Import CSV**. Receipt images do not come across, as today.

Version: `cloud/vercel/package.json` → `3.0.0`. Also update the root `README.md` line describing the Cloud version.

## Left to the builder

- Exact PL/pgSQL structure and helper functions, and how Thai messages are centralised.
- How `parser.js` is shared between Vercel and tests. It no longer needs to run in Apps Script.
- The details of the fake Supabase server, as long as Vercel's code paths are the real ones.
- Whether `categories.list`'s `tx_count` comes from a join or a subquery.
