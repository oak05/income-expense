-- The app's actions as database functions: public.api_<action>(p jsonb) returns jsonb.
-- Vercel calls them through PostgREST as the signed-in user, so row-level security applies to every query
-- and each call is one transaction. Errors use SQLSTATE 'PT<http status>' and carry the Thai message the
-- page shows; PostgREST turns that SQLSTATE into the HTTP status.
-- Shared helpers live in schema "private", which PostgREST does not expose.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

/* ------------------------------------------------------------------ helpers */

create function private.fail(status integer, msg text) returns void language plpgsql as $$
begin
  raise exception using errcode = 'PT' || status::text, message = msg;
end;
$$;

/** JS String(v).trim(): JSON null or missing -> ''. */
create function private.str(v jsonb) returns text language sql immutable as $$
  select regexp_replace(coalesce(v #>> '{}', ''), '^\s+|\s+$', '', 'g')
$$;

/** "120.505" -> 120.51: 1-10 digits, up to 6 decimals, half-up on the third decimal. NULL if not a plain number. */
create function private.parse_amount(s text) returns numeric language sql immutable as $$
  select case when s ~ '^[0-9]{1,10}(\.[0-9]{1,6})?$' then round(trunc(s::numeric, 3), 2) end
$$;

create function private.is_iso_date(s text) returns boolean language plpgsql immutable as $$
declare
  d date;
begin
  if s is null or s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or left(s, 4)::int < 1000 then
    return false;
  end if;
  d := s::date;
  return to_char(d, 'YYYY-MM-DD') = s;
exception when others then
  return false;
end;
$$;

create function private.v_type(v jsonb) returns text language plpgsql immutable as $$
begin
  if jsonb_typeof(v) is distinct from 'string' or v #>> '{}' not in ('income', 'expense') then
    perform private.fail(422, 'ข้อมูลไม่ถูกต้อง: ประเภท');
  end if;
  return v #>> '{}';
end;
$$;

create function private.v_amount(v jsonb) returns numeric language plpgsql immutable as $$
declare
  a numeric := private.parse_amount(private.str(v));
begin
  if a is null or a <= 0 or a > 9999999999.99 then
    perform private.fail(422, 'ข้อมูลไม่ถูกต้อง: จำนวนเงิน');
  end if;
  return a;
end;
$$;

create function private.v_date(v jsonb) returns date language plpgsql immutable as $$
begin
  if not private.is_iso_date(v #>> '{}') then
    perform private.fail(422, 'ข้อมูลไม่ถูกต้อง: วันที่');
  end if;
  return (v #>> '{}')::date;
end;
$$;

create function private.v_month(v jsonb) returns text language plpgsql immutable as $$
begin
  if coalesce(v #>> '{}', '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    perform private.fail(400, 'รูปแบบเดือนต้องเป็น YYYY-MM');
  end if;
  return v #>> '{}';
end;
$$;

/** A positive whole number (JS Number(v) is an integer >= 1). */
create function private.v_id(v jsonb, label text default 'รหัส') returns bigint language plpgsql immutable as $$
declare
  s text := private.str(v);
begin
  if s !~ '^[0-9]{1,18}(\.0*)?$' or trunc(s::numeric) < 1 then
    perform private.fail(422, 'ข้อมูลไม่ถูกต้อง: ' || label);
  end if;
  return trunc(s::numeric)::bigint;
end;
$$;

create function private.v_text(v jsonb, max integer, label text) returns text language plpgsql immutable as $$
declare
  s text := private.str(v);
begin
  if char_length(s) > max then
    perform private.fail(422, 'ข้อมูลไม่ถูกต้อง: ' || label || ' ยาวเกินไป');
  end if;
  return s;
end;
$$;

create function private.v_name(v jsonb) returns text language plpgsql immutable as $$
declare
  s text := private.v_text(v, 50, 'ชื่อหมวดหมู่');
begin
  if s = '' then
    perform private.fail(422, 'ข้อมูลไม่ถูกต้อง: ชื่อหมวดหมู่');
  end if;
  return s;
end;
$$;

create function private.v_color(v jsonb) returns text language plpgsql immutable as $$
begin
  if coalesce(v #>> '{}', '') !~ '^#[0-9A-Fa-f]{6}$' then
    perform private.fail(422, 'ข้อมูลไม่ถูกต้อง: สี');
  end if;
  return v #>> '{}';
end;
$$;

/** Monthly budget: null, '' or 0 = no budget (NULL); otherwise a positive amount. */
create function private.v_budget(v jsonb) returns numeric language plpgsql immutable as $$
declare
  s text := private.str(v);
  a numeric;
begin
  if s = '' then
    return null;
  end if;
  a := private.parse_amount(s);
  if a is null or a > 9999999999.99 then
    perform private.fail(422, 'ข้อมูลไม่ถูกต้อง: งบประมาณ');
  end if;
  return nullif(a, 0);
end;
$$;

create function private.stamp(t timestamptz) returns text language sql immutable as $$
  select to_char(t at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS')
$$;

create function private.type_th(t text) returns text language sql immutable as $$
  select case t when 'income' then 'รายรับ' else 'รายจ่าย' end
$$;

create function private.tx_json(t public.transactions) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', t.id, 'type', t.type, 'amount', t.amount, 'category_id', t.category_id,
    'category_name', coalesce(c.name, '(ไม่มีหมวด)'), 'category_color', coalesce(c.color, '#7A8290'),
    'date', to_char(t.date, 'YYYY-MM-DD'), 'note', t.note, 'receipt_id', t.receipt_id,
    'created_at', private.stamp(t.created_at), 'updated_at', private.stamp(t.updated_at))
  from (select 1) one
  left join public.categories c on c.id = t.category_id
$$;

/** checkCategory_: the category exists for this user and matches the type. */
create function private.check_category(category_id bigint, tx_type text) returns void language plpgsql stable as $$
declare
  c_type text;
begin
  select type into c_type from public.categories where id = category_id;
  if not found then
    perform private.fail(400, 'ไม่พบหมวดหมู่นี้');
  end if;
  if c_type <> tx_type then
    perform private.fail(400, 'หมวดหมู่ไม่ตรงกับประเภทรายการ (รายรับ/รายจ่าย)');
  end if;
end;
$$;

/* ------------------------------------------------------------------ categories */

create function public.api_categories_list(p jsonb default '{}') returns jsonb
language sql stable security invoker set search_path = public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'type', c.type, 'color', c.color, 'sort_order', c.sort_order,
      'budget', c.budget, 'tx_count', (select count(*) from transactions t where t.category_id = c.id)
    ) order by c.sort_order, c.id), '[]'::jsonb)
  from categories c
$$;

create function public.api_categories_create(p jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path = public, private as $$
declare
  v_name text := private.v_name(p -> 'name');
  v_type text := private.v_type(p -> 'type');
  v_color text := private.v_color(case when coalesce(p ->> 'color', '') = '' then '"#7A8290"'::jsonb else p -> 'color' end);
  v_order integer;
  v_id bigint;
begin
  if exists (select 1 from categories where name = v_name and type = v_type) then
    perform private.fail(409, 'มีหมวดหมู่ "' || v_name || '" อยู่แล้ว');
  end if;
  select coalesce(max(greatest(sort_order, 0)), 0) + 1 into v_order from categories;
  insert into categories (name, type, color, sort_order) values (v_name, v_type, v_color, v_order) returning id into v_id;
  return jsonb_build_object('id', v_id, 'name', v_name, 'type', v_type, 'color', v_color, 'sort_order', v_order,
    'budget', null, 'tx_count', 0);
end;
$$;

create function public.api_categories_update(p jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path = public, private as $$
declare
  v_id bigint := private.v_id(p -> 'id');
  v_name text := private.v_name(p -> 'name');
  v_color text := private.v_color(p -> 'color');
  v_budget numeric;
  row categories;
begin
  select * into row from categories where id = v_id for update;
  if not found then
    perform private.fail(404, 'ไม่พบหมวดหมู่');
  end if;
  if exists (select 1 from categories where id <> v_id and name = v_name and type = row.type) then
    perform private.fail(409, 'มีหมวดหมู่ "' || v_name || '" อยู่แล้ว');
  end if;
  row.name := v_name;
  row.color := v_color;
  if p ? 'budget' then -- left out = unchanged, so a rename never clears a budget
    v_budget := private.v_budget(p -> 'budget');
    if v_budget is not null and row.type <> 'expense' then
      perform private.fail(400, 'ตั้งงบประมาณได้เฉพาะหมวดรายจ่าย ไม่ใช่หมวดรายรับ');
    end if;
    row.budget := v_budget;
  end if;
  update categories set name = row.name, color = row.color, budget = row.budget where id = v_id;
  return jsonb_build_object('id', v_id, 'name', row.name, 'type', row.type, 'color', row.color,
    'sort_order', row.sort_order, 'budget', row.budget);
end;
$$;

create function public.api_categories_delete(p jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path = public, private as $$
declare
  v_id bigint := private.v_id(p -> 'id');
  cat categories;
  v_used integer;
  v_target categories;
  v_move text := private.str(p -> 'move_to');
begin
  select * into cat from categories where id = v_id for update;
  if not found then
    perform private.fail(404, 'ไม่พบหมวดหมู่');
  end if;
  if (select count(*) from categories where type = cat.type) <= 1 then
    perform private.fail(400, 'ต้องมีหมวดหมู่' || private.type_th(cat.type) || 'อย่างน้อย 1 หมวด');
  end if;
  select count(*) into v_used from transactions where category_id = v_id;
  if v_used > 0 then
    if v_move = '' then
      perform private.fail(409, 'หมวดหมู่นี้มี ' || v_used || ' รายการ — เลือกหมวดที่จะย้ายรายการไปก่อนลบ');
    end if;
    if v_move ~ '^[0-9]{1,18}$' then
      select * into v_target from categories where id = v_move::bigint;
    end if;
    if v_target.id is null or v_target.id = v_id or v_target.type <> cat.type then
      perform private.fail(400, 'หมวดหมู่ปลายทางไม่ถูกต้อง');
    end if;
    update transactions set category_id = v_target.id, updated_at = now() where category_id = v_id;
  end if;
  delete from categories where id = v_id; -- receipts pointing at it get category_id = null (foreign key)
  return jsonb_build_object('ok', true, 'moved', v_used);
end;
$$;

/* ------------------------------------------------------------------ transactions */

create function public.api_transactions_list(p jsonb default '{}') returns jsonb
language plpgsql stable security invoker set search_path = public, private as $$
declare
  v_month text;
begin
  if private.str(p -> 'month') <> '' then
    v_month := private.v_month(p -> 'month');
  end if;
  return coalesce((
    select jsonb_agg(private.tx_json(t) order by t.date desc, t.id desc)
    from transactions t
    where v_month is null or to_char(t.date, 'YYYY-MM') = v_month
  ), '[]'::jsonb);
end;
$$;

create function public.api_transactions_create(p jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path = public, private as $$
declare
  v_type text := private.v_type(p -> 'type');
  v_amount numeric := private.v_amount(p -> 'amount');
  v_category bigint := private.v_id(p -> 'category_id', 'หมวดหมู่');
  v_date date := private.v_date(p -> 'date');
  v_note text := private.v_text(p -> 'note', 500, 'หมายเหตุ');
  row transactions;
begin
  perform private.check_category(v_category, v_type);
  insert into transactions (type, amount, category_id, date, note)
  values (v_type, v_amount, v_category, v_date, v_note) returning * into row;
  return private.tx_json(row);
end;
$$;

create function public.api_transactions_update(p jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path = public, private as $$
declare
  v_id bigint := private.v_id(p -> 'id');
  v_type text;
  v_amount numeric;
  v_category bigint;
  v_date date;
  v_note text;
  row transactions;
begin
  perform 1 from transactions where id = v_id for update;
  if not found then
    perform private.fail(404, 'ไม่พบรายการ');
  end if;
  v_type := private.v_type(p -> 'type');
  v_amount := private.v_amount(p -> 'amount');
  v_category := private.v_id(p -> 'category_id', 'หมวดหมู่');
  v_date := private.v_date(p -> 'date');
  v_note := private.v_text(p -> 'note', 500, 'หมายเหตุ');
  perform private.check_category(v_category, v_type);
  update transactions
  set type = v_type, amount = v_amount, category_id = v_category, date = v_date, note = v_note, updated_at = now()
  where id = v_id returning * into row;
  return private.tx_json(row);
end;
$$;

/** Deletes a transaction and the receipt rows attached to it; returns their storage paths so Vercel removes the files. */
create function public.api_transactions_delete(p jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path = public, private as $$
declare
  v_id bigint := private.v_id(p -> 'id');
  v_files text[];
  v_count integer;
begin
  perform 1 from transactions where id = v_id for update;
  if not found then
    perform private.fail(404, 'ไม่พบรายการ');
  end if;
  with gone as (delete from receipts where transaction_id = v_id returning storage_path)
  select count(*), coalesce(array_agg(storage_path) filter (where storage_path is not null), '{}') into v_count, v_files from gone;
  delete from transactions where id = v_id;
  return jsonb_build_object('ok', true, 'receipts_removed', v_count, 'removed_files', to_jsonb(v_files));
end;
$$;

/**
 * CSV import. Rows already in the book (same date, type, category, amount and note) are skipped, one for one;
 * repeats inside the file are kept. Unknown categories are created. Bad rows are reported, not fatal.
 */
create function public.api_transactions_import(p jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path = public, private as $$
declare
  v_rows jsonb := p -> 'rows';
  v_colors text[] := array['#5B8DB8', '#B86F5B', '#6FA06B', '#9A6FB0', '#C29A3D', '#4E9A9A', '#B05B7A'];
  v_existing jsonb;
  v_cat_count integer;
  v_new_cats integer := 0;
  v_next_order integer;
  v_errors text[] := '{}';
  v_imported integer := 0;
  v_skipped integer := 0;
  r jsonb;
  i integer := 0;
  v_line text;
  v_type text;
  v_amount numeric;
  v_name text;
  v_note text;
  v_cid bigint;
  v_key text;
begin
  if jsonb_typeof(v_rows) is distinct from 'array' or jsonb_array_length(v_rows) = 0 then
    perform private.fail(400, 'ไม่มีรายการให้นำเข้า');
  end if;
  if jsonb_array_length(v_rows) > 5000 then
    perform private.fail(413, 'นำเข้าได้ครั้งละไม่เกิน 5000 รายการ');
  end if;

  select coalesce(jsonb_object_agg(k, n), '{}') into v_existing
  from (select concat_ws(E'\n', date, type, category_id, amount, note) as k, count(*) as n
        from transactions group by 1) e;
  select count(*), coalesce(max(greatest(sort_order, 0)), 0) + 1 into v_cat_count, v_next_order from categories;

  for r in select value from jsonb_array_elements(v_rows) loop
    i := i + 1;
    v_line := case when jsonb_typeof(r) = 'object' and coalesce(r ->> 'line', '') not in ('', '0', 'false')
                   then r ->> 'line' else (i + 1)::text end;
    v_type := case when jsonb_typeof(r) = 'object' then r ->> 'type' end;
    v_amount := case when jsonb_typeof(r) = 'object' then private.parse_amount(private.str(r -> 'amount')) end;
    if jsonb_typeof(r) is distinct from 'object' or not private.is_iso_date(r ->> 'date')
       or v_type is null or v_type not in ('income', 'expense')
       or v_amount is null or v_amount <= 0 or v_amount > 9999999999.99 then
      v_errors := v_errors || ('บรรทัด ' || v_line || ': ข้อมูลไม่ถูกต้อง');
      continue;
    end if;
    v_name := coalesce(nullif(left(private.str(r -> 'category'), 50), ''), 'อื่นๆ');
    v_note := left(private.str(r -> 'note'), 500);

    select id into v_cid from categories where type = v_type and name = v_name;
    if not found then
      insert into categories (name, type, color, sort_order)
      values (v_name, v_type, v_colors[(v_cat_count + v_new_cats) % 7 + 1], v_next_order)
      returning id into v_cid;
      v_new_cats := v_new_cats + 1;
      v_next_order := v_next_order + 1;
    end if;

    v_key := concat_ws(E'\n', (r ->> 'date')::date, v_type, v_cid, v_amount::numeric(14, 2), v_note);
    if coalesce((v_existing ->> v_key)::int, 0) > 0 then -- the same row is already in the book -> skip it
      v_existing := jsonb_set(v_existing, array[v_key], to_jsonb((v_existing ->> v_key)::int - 1));
      v_skipped := v_skipped + 1;
      continue;
    end if;
    insert into transactions (type, amount, category_id, date, note)
    values (v_type, v_amount, v_cid, (r ->> 'date')::date, v_note);
    v_imported := v_imported + 1;
  end loop;

  return jsonb_build_object('imported', v_imported, 'skipped_duplicates', v_skipped,
    'errors', to_jsonb(v_errors[1:20]), 'error_count', coalesce(array_length(v_errors, 1), 0));
end;
$$;

/* ------------------------------------------------------------------ grants */

revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.api_categories_list(jsonb), public.api_categories_create(jsonb), public.api_categories_update(jsonb),
  public.api_categories_delete(jsonb), public.api_transactions_list(jsonb), public.api_transactions_create(jsonb),
  public.api_transactions_update(jsonb), public.api_transactions_delete(jsonb), public.api_transactions_import(jsonb)
to authenticated;
