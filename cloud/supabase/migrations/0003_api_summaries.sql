-- Month and year summaries (the overview and yearly pages), same shapes as the Google Sheet version.

create function private.totals(rows public.transactions[]) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'income', coalesce(sum(t.amount) filter (where t.type = 'income'), 0),
    'expense', coalesce(sum(t.amount) filter (where t.type = 'expense'), 0),
    'balance', coalesce(sum(case when t.type = 'income' then t.amount else -t.amount end), 0),
    'count', count(t.id))
  from unnest(rows) t
$$;

create function public.api_month_get(p jsonb default '{}') returns jsonb
language plpgsql stable security invoker set search_path = public, private as $$
declare
  v_month text := private.v_month(p -> 'month');
  v_start date := (v_month || '-01')::date;
  v_end date := (v_start + interval '1 month')::date;
  v_prev date := (v_start - interval '1 month')::date;
  in_month transactions[];
  in_prev transactions[];
begin
  select coalesce(array_agg(t), '{}') into in_month from transactions t where t.date >= v_start and t.date < v_end;
  select coalesce(array_agg(t), '{}') into in_prev from transactions t where t.date >= v_prev and t.date < v_start;
  return jsonb_build_object(
    'month', v_month,
    'totals', private.totals(in_month),
    'previous', private.totals(in_prev),
    'cumulative_balance', (select coalesce(sum(case when type = 'income' then amount else -amount end), 0)
                           from transactions where date < v_end),
    'by_category', (
      select jsonb_build_object(
        'income', coalesce(jsonb_agg(item order by total desc, id) filter (where type = 'income'), '[]'::jsonb),
        'expense', coalesce(jsonb_agg(item order by total desc, id) filter (where type = 'expense'), '[]'::jsonb))
      from (
        select t.category_id as id, t.type, sum(t.amount) as total,
          jsonb_build_object('id', t.category_id, 'name', coalesce(c.name, '(ไม่มีหมวด)'),
            'color', coalesce(c.color, '#7A8290'), 'total', sum(t.amount), 'count', count(*)) as item
        from unnest(in_month) t
        left join categories c on c.id = t.category_id
        group by t.category_id, t.type, c.name, c.color
      ) per_cat),
    'daily', (
      select jsonb_agg(jsonb_build_object('day', d,
          'income', coalesce((select sum(amount) from unnest(in_month) t where extract(day from t.date) = d and t.type = 'income'), 0),
          'expense', coalesce((select sum(amount) from unnest(in_month) t where extract(day from t.date) = d and t.type = 'expense'), 0))
        order by d)
      from generate_series(1, extract(day from v_end - interval '1 day')::int) d),
    'transactions', coalesce((
      select jsonb_agg(private.tx_json(t) order by t.date desc, t.id desc) from unnest(in_month) t), '[]'::jsonb));
end;
$$;

create function public.api_yearly_get(p jsonb default '{}') returns jsonb
language plpgsql stable security invoker set search_path = public, private as $$
declare
  v_text text := private.str(p -> 'year');
  v_year integer;
  in_year transactions[];
begin
  if v_text !~ '^[0-9]{4}(\.0*)?$' or trunc(v_text::numeric) not between 1900 and 2999 then
    perform private.fail(422, 'ข้อมูลไม่ถูกต้อง: ปี');
  end if;
  v_year := trunc(v_text::numeric)::int;
  select coalesce(array_agg(t), '{}') into in_year from transactions t where extract(year from t.date) = v_year;
  return jsonb_build_object(
    'year', v_year,
    'totals', private.totals(in_year),
    'months', (
      select jsonb_agg(jsonb_build_object('month', v_year || '-' || lpad(m::text, 2, '0'),
          'income', coalesce((select sum(amount) from unnest(in_year) t where extract(month from t.date) = m and t.type = 'income'), 0),
          'expense', coalesce((select sum(amount) from unnest(in_year) t where extract(month from t.date) = m and t.type = 'expense'), 0))
        order by m)
      from generate_series(1, 12) m),
    'top_expense_categories', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'color', color, 'total', total) order by total desc, id)
      from (
        select t.category_id as id, coalesce(c.name, '(ไม่มีหมวด)') as name, coalesce(c.color, '#7A8290') as color,
          sum(t.amount) as total
        from unnest(in_year) t
        left join categories c on c.id = t.category_id
        where t.type = 'expense'
        group by t.category_id, c.name, c.color
        order by total desc, id
        limit 8
      ) top), '[]'::jsonb));
end;
$$;

revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on function public.api_month_get(jsonb), public.api_yearly_get(jsonb) to authenticated;
