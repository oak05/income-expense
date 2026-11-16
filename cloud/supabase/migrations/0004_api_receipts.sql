-- Receipts: drafts made from an uploaded file (stored by Vercel in Supabase Storage), edited, then saved as expenses.

create function private.receipt_json(r public.receipts) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'id', r.id, 'status', r.status, 'merchant', r.merchant, 'amount', r.amount,
    'date', to_char(r.date, 'YYYY-MM-DD'), 'category_id', r.category_id, 'included', r.included,
    'transaction_id', r.transaction_id, 'is_pdf', r.mime = 'application/pdf', 'original_name', r.original_name,
    'text_source', r.text_source, 'confidence', r.confidence, 'candidates', r.candidates, 'flags', r.flags,
    'error', r.error, 'ocr_text', r.ocr_text, 'created_at', private.stamp(r.created_at))
$$;

/** categoryForHint_: exact name, then partial name either way, then "อื่นๆ", then the first expense category. */
create function private.category_for_hint(names text[]) returns bigint language plpgsql stable as $$
declare
  v_id bigint;
  n text;
begin
  foreach n in array coalesce(names, '{}') loop
    select id into v_id from public.categories where type = 'expense' and name = n order by sort_order, id limit 1;
    if found then return v_id; end if;
  end loop;
  foreach n in array coalesce(names, '{}') loop
    continue when n = '';
    select id into v_id from public.categories
    where type = 'expense' and (strpos(name, n) > 0 or strpos(n, name) > 0) order by sort_order, id limit 1;
    if found then return v_id; end if;
  end loop;
  select id into v_id from public.categories where type = 'expense' and name = 'อื่นๆ' order by sort_order, id limit 1;
  if found then return v_id; end if;
  select id into v_id from public.categories where type = 'expense' order by sort_order, id limit 1;
  return v_id;
end;
$$;

create function private.pending_receipt(v_id bigint) returns public.receipts language plpgsql as $$
declare
  r public.receipts;
begin
  select * into r from public.receipts where id = v_id for update;
  if not found then
    perform private.fail(404, 'ไม่พบใบเสร็จ');
  end if;
  if r.status <> 'pending' then
    perform private.fail(409, 'ใบเสร็จนี้บันทึกไปแล้ว');
  end if;
  return r;
end;
$$;

/** Called by Vercel after the file is in Storage and OCR has run. */
create function public.api_receipts_create(p jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path = public, private as $$
declare
  v_path text := private.str(p -> 'storage_path');
  v_mime text := private.str(p -> 'mime');
  v_size bigint;
  v_amount numeric;
  v_names text[];
  row receipts;
begin
  if v_mime not in ('image/jpeg', 'image/png', 'application/pdf') then
    perform private.fail(400, 'รองรับเฉพาะรูป JPG, PNG และไฟล์ PDF');
  end if;
  if auth.uid() is null or v_path !~ ('^' || auth.uid()::text || '/[A-Za-z0-9_-]+\.(jpg|png|pdf)$') then
    perform private.fail(400, 'ข้อมูลไม่ถูกต้อง: ไฟล์');
  end if;
  v_size := case when private.str(p -> 'size') ~ '^[0-9]{1,9}$' then private.str(p -> 'size')::bigint end;
  if v_size is null then
    perform private.fail(400, 'ข้อมูลไม่ถูกต้อง: ไฟล์');
  end if;
  if (select coalesce(sum(size), 0) from receipts) + v_size > 104857600 then
    perform private.fail(413, 'พื้นที่เก็บใบเสร็จของบัญชีนี้เต็มแล้ว (100 MB) — ลบใบเสร็จเก่าก่อน');
  end if;
  if private.str(p -> 'amount') <> '' then
    v_amount := private.v_amount(p -> 'amount');
  end if;
  if jsonb_typeof(p -> 'hint_names') = 'array' then
    select array_agg(value) into v_names from jsonb_array_elements_text(p -> 'hint_names');
  end if;

  insert into receipts (status, merchant, amount, date, category_id, included, storage_path, size, mime, original_name,
    text_source, confidence, candidates, flags, error, ocr_text)
  values ('pending', left(private.str(p -> 'merchant'), 200), v_amount, private.v_date(p -> 'date'),
    private.category_for_hint(v_names), true, v_path, v_size, v_mime,
    coalesce(nullif(left(private.str(p -> 'original_name'), 200), ''), 'receipt'),
    left(private.str(p -> 'text_source'), 50), nullif(left(private.str(p -> 'confidence'), 20), ''),
    case when jsonb_typeof(p -> 'candidates') = 'array' then p -> 'candidates' else '[]' end,
    case when jsonb_typeof(p -> 'flags') = 'array' then p -> 'flags' else '[]' end,
    left(private.str(p -> 'error'), 500), left(coalesce(p ->> 'ocr_text', ''), 4000))
  returning * into row;
  return private.receipt_json(row);
end;
$$;

create function public.api_receipts_list(p jsonb default '{}') returns jsonb
language sql stable security invoker set search_path = public, private as $$
  select coalesce(jsonb_agg(private.receipt_json(r) order by r.id desc), '[]'::jsonb)
  from receipts r
  where r.status = case when p ->> 'status' = 'saved' then 'saved' else 'pending' end
$$;

create function public.api_receipts_update(p jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path = public, private as $$
declare
  row receipts := private.pending_receipt(private.v_id(p -> 'id'));
  v_category bigint;
begin
  if p ? 'merchant' then
    row.merchant := private.v_text(p -> 'merchant', 200, 'ชื่อร้าน');
  end if;
  if p ? 'amount' then
    row.amount := case when private.str(p -> 'amount') = '' then null else private.v_amount(p -> 'amount') end;
  end if;
  if private.str(p -> 'date') <> '' then
    row.date := private.v_date(p -> 'date');
  end if;
  if private.str(p -> 'category_id') not in ('', '0', 'false') then
    v_category := private.v_id(p -> 'category_id', 'หมวดหมู่');
    perform private.check_category(v_category, 'expense');
    row.category_id := v_category;
  end if;
  if p ? 'included' and jsonb_typeof(p -> 'included') <> 'null' then
    row.included := (p -> 'included') = 'true'::jsonb;
  end if;
  update receipts set merchant = row.merchant, amount = row.amount, date = row.date, category_id = row.category_id,
    included = row.included
  where id = row.id returning * into row;
  return private.receipt_json(row);
end;
$$;

/** Deletes a receipt (a saved one's transaction stays, without the receipt) and returns the file path to remove. */
create function public.api_receipts_delete(p jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path = public, private as $$
declare
  v_id bigint := private.v_id(p -> 'id');
  v_path text;
begin
  delete from receipts where id = v_id returning storage_path into v_path;
  if not found then
    perform private.fail(404, 'ไม่พบใบเสร็จ');
  end if;
  return jsonb_build_object('ok', true,
    'removed_files', case when v_path is null then '[]'::jsonb else jsonb_build_array(v_path) end);
end;
$$;

/** Saves reviewed receipts as expenses. One transaction: any invalid item means nothing is written. */
create function public.api_receipts_commit(p jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path = public, private as $$
declare
  v_items jsonb := p -> 'items';
  item jsonb;
  v_id bigint;
  r receipts;
  v_amount numeric;
  v_date date;
  v_category bigint;
  v_merchant text;
  v_tx bigint;
  v_total numeric := 0;
  v_saved integer := 0;
begin
  if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) = 0 or jsonb_array_length(v_items) > 500 then
    perform private.fail(422, 'ข้อมูลไม่ถูกต้อง: รายการใบเสร็จ');
  end if;
  for item in select value from jsonb_array_elements(v_items) loop
    v_id := private.v_id(case when jsonb_typeof(item) = 'object' then item -> 'id' end);
    select * into r from receipts where id = v_id for update;
    if not found then
      perform private.fail(404, 'ไม่พบใบเสร็จ #' || v_id);
    end if;
    if r.status <> 'pending' then -- also catches the same receipt twice in one request
      perform private.fail(409, 'ใบเสร็จ #' || v_id || ' บันทึกไปแล้ว');
    end if;
    v_amount := private.v_amount(item -> 'amount');
    v_date := private.v_date(item -> 'date');
    v_category := private.v_id(item -> 'category_id', 'หมวดหมู่');
    perform private.check_category(v_category, 'expense');
    v_merchant := private.v_text(item -> 'merchant', 200, 'ชื่อร้าน');

    insert into transactions (type, amount, category_id, date, note, receipt_id)
    values ('expense', v_amount, v_category, v_date, coalesce(nullif(v_merchant, ''), 'ใบเสร็จ'), v_id)
    returning id into v_tx;
    update receipts set status = 'saved', transaction_id = v_tx, amount = v_amount, date = v_date,
      category_id = v_category, merchant = v_merchant
    where id = v_id;
    v_total := v_total + v_amount;
    v_saved := v_saved + 1;
  end loop;
  return jsonb_build_object('saved', v_saved, 'total', v_total);
end;
$$;

/** Where a receipt's file is, for /api/file. */
create function public.api_receipts_file(p jsonb default '{}') returns jsonb
language plpgsql stable security invoker set search_path = public, private as $$
declare
  r receipts;
begin
  select * into r from receipts where id = private.v_id(p -> 'id');
  if not found or r.storage_path is null then
    perform private.fail(404, 'ไม่พบไฟล์ใบเสร็จ');
  end if;
  return jsonb_build_object('storage_path', r.storage_path, 'mime', r.mime, 'original_name', r.original_name);
end;
$$;

revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.api_receipts_create(jsonb), public.api_receipts_list(jsonb), public.api_receipts_update(jsonb),
  public.api_receipts_delete(jsonb), public.api_receipts_commit(jsonb), public.api_receipts_file(jsonb)
to authenticated;
