-- Sign-in throttling and account deletion.
--
-- Every sign-in reaches Supabase Auth from Vercel's servers, so Supabase's own per-address limits would see one
-- caller for all users. Vercel counts attempts per real caller here instead, with the service key; nobody else
-- can call auth_throttle or read the counts.

create table private.auth_attempts (
  kind text not null,
  key text not null,
  count integer not null default 0,
  window_end timestamptz not null,
  primary key (kind, key)
);
revoke all on private.auth_attempts from public, anon, authenticated;

/**
 * kind 'login'  : outcome 'check' -> blocked after 8 failures until 15 minutes after the last one;
 *                 'fail' counts one; 'ok' clears the key.
 * kind 'signup' | 'recover' | 'resend' : outcome 'hit' counts one request; more than 5 in an hour is blocked.
 */
create function public.auth_throttle(p_kind text, p_key text, p_outcome text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a private.auth_attempts;
begin
  if p_key is null or p_key = '' or char_length(p_key) > 200 then
    raise exception using errcode = 'PT400', message = 'bad key';
  end if;
  select * into a from private.auth_attempts where kind = p_kind and key = p_key for update;
  if found and a.window_end <= now() then
    delete from private.auth_attempts where kind = p_kind and key = p_key;
    a := null;
  end if;

  if p_kind = 'login' then
    if p_outcome = 'check' then
      return jsonb_build_object('blocked', coalesce(a.count, 0) >= 8);
    elsif p_outcome = 'fail' then
      insert into private.auth_attempts (kind, key, count, window_end) values (p_kind, p_key, 1, now() + interval '15 minutes')
      on conflict (kind, key) do update set count = private.auth_attempts.count + 1, window_end = excluded.window_end;
      return jsonb_build_object('blocked', coalesce(a.count, 0) + 1 >= 8);
    elsif p_outcome = 'ok' then
      delete from private.auth_attempts where kind = p_kind and key = p_key;
      return jsonb_build_object('blocked', false);
    end if;
  elsif p_kind in ('signup', 'recover', 'resend') and p_outcome = 'hit' then
    insert into private.auth_attempts (kind, key, count, window_end) values (p_kind, p_key, 1, now() + interval '1 hour')
    on conflict (kind, key) do update set count = private.auth_attempts.count + 1;
    return jsonb_build_object('blocked', coalesce(a.count, 0) + 1 > 5);
  end if;
  raise exception using errcode = 'PT400', message = 'bad throttle request';
end;
$$;
revoke execute on function public.auth_throttle(text, text, text) from public, anon, authenticated;
grant execute on function public.auth_throttle(text, text, text) to service_role;

/**
 * Deletes the signed-in account and, through the foreign keys, every row it owns. The caller types their email
 * to confirm. Receipt files in Storage are removed by Vercel before it calls this.
 */
create function public.api_delete_account(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null
     or lower(regexp_replace(coalesce(p ->> 'email', ''), '^\s+|\s+$', '', 'g')) <> lower(coalesce(auth.jwt() ->> 'email', ''))
     or coalesce(auth.jwt() ->> 'email', '') = '' then
    raise exception using errcode = 'PT400', message = 'อีเมลไม่ตรงกับบัญชีนี้';
  end if;
  delete from auth.users where id = v_uid;
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.api_delete_account(jsonb) from public, anon;
grant execute on function public.api_delete_account(jsonb) to authenticated;
