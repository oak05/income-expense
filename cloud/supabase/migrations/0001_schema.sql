-- สมุดรายรับรายจ่าย — tables, per-account row-level security and the default categories of a new account.
-- Every row belongs to one account (user_id). The policies below let a signed-in user see and change only
-- their own rows; composite foreign keys (id, user_id) make it impossible to point at another account's row.

create table public.categories (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 50),
  type text not null check (type in ('income', 'expense')),
  color text not null check (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order integer not null default 0,
  budget numeric(14, 2) check (budget > 0),
  unique (user_id, type, name),
  unique (id, user_id),
  check (budget is null or type = 'expense')
);

create table public.transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  type text not null check (type in ('income', 'expense')),
  amount numeric(14, 2) not null check (amount > 0 and amount <= 9999999999.99),
  category_id bigint not null,
  date date not null,
  note text not null default '' check (char_length(note) <= 500),
  receipt_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (category_id, user_id) references public.categories (id, user_id)
);

create table public.receipts (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'saved')),
  merchant text not null default '' check (char_length(merchant) <= 200),
  amount numeric(14, 2) check (amount > 0 and amount <= 9999999999.99),
  date date not null,
  category_id bigint,
  included boolean not null default true,
  transaction_id bigint,
  storage_path text,
  size integer not null default 0 check (size >= 0),
  mime text not null check (mime in ('image/jpeg', 'image/png', 'application/pdf')),
  original_name text not null default '' check (char_length(original_name) <= 200),
  text_source text not null default '',
  confidence text,
  candidates jsonb not null default '[]',
  flags jsonb not null default '[]',
  error text not null default '',
  ocr_text text not null default '' check (char_length(ocr_text) <= 4000),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (category_id, user_id) references public.categories (id, user_id) on delete set null (category_id)
);

alter table public.transactions
  add foreign key (receipt_id, user_id) references public.receipts (id, user_id) on delete set null (receipt_id);
alter table public.receipts
  add foreign key (transaction_id, user_id) references public.transactions (id, user_id) on delete set null (transaction_id);

create index transactions_user_date on public.transactions (user_id, date);
create index transactions_user_category on public.transactions (user_id, category_id);
create index receipts_user_status on public.receipts (user_id, status);

alter table public.categories enable row level security;
alter table public.transactions enable row level security;
alter table public.receipts enable row level security;

create policy categories_select on public.categories for select to authenticated using (user_id = (select auth.uid()));
create policy categories_insert on public.categories for insert to authenticated with check (user_id = (select auth.uid()));
create policy categories_update on public.categories for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy categories_delete on public.categories for delete to authenticated using (user_id = (select auth.uid()));

create policy transactions_select on public.transactions for select to authenticated using (user_id = (select auth.uid()));
create policy transactions_insert on public.transactions for insert to authenticated with check (user_id = (select auth.uid()));
create policy transactions_update on public.transactions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy transactions_delete on public.transactions for delete to authenticated using (user_id = (select auth.uid()));

create policy receipts_select on public.receipts for select to authenticated using (user_id = (select auth.uid()));
create policy receipts_insert on public.receipts for insert to authenticated with check (user_id = (select auth.uid()));
create policy receipts_update on public.receipts for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy receipts_delete on public.receipts for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.categories, public.transactions, public.receipts from anon, public;
grant select, insert, update, delete on public.categories, public.transactions, public.receipts to authenticated;

-- A new account starts with the same categories the Google Sheet version created in setup().
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.categories (user_id, name, type, color, sort_order)
  select new.id, d.name, d.type, d.color, d.ord
  from (values
    (0, 'อาหารและเครื่องดื่ม', 'expense', '#E07A3F'), (1, 'เดินทาง', 'expense', '#3A86C8'),
    (2, 'ที่พัก / ค่าเช่า', 'expense', '#7B61C9'), (3, 'ค่าน้ำ ค่าไฟ ค่าเน็ต', 'expense', '#D4A72C'),
    (4, 'ช้อปปิ้ง', 'expense', '#D2588E'), (5, 'สุขภาพ', 'expense', '#2E9E83'), (6, 'บันเทิง', 'expense', '#C8463D'),
    (7, 'การศึกษา', 'expense', '#4F5BD5'), (8, 'อื่นๆ', 'expense', '#7A8290'),
    (9, 'เงินเดือน', 'income', '#2F8F5B'), (10, 'งานฟรีแลนซ์', 'income', '#1F8A8A'), (11, 'โบนัส', 'income', '#7FA33A'),
    (12, 'ขายของ', 'income', '#3E9E3E'), (13, 'ดอกเบี้ย / เงินปันผล', 'income', '#4C7A5A'), (14, 'อื่นๆ', 'income', '#7A8290')
  ) as d (ord, name, type, color)
  order by d.ord;
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
