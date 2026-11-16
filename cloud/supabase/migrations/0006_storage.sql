-- Receipt files: a private bucket, one folder per account (<user id>/<random>.<jpg|png|pdf>).
-- A signed-in user can read, add and delete only the files in their own folder.

insert into storage.buckets (id, name, public) values ('receipts', 'receipts', false)
on conflict (id) do nothing;

create policy receipts_files_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy receipts_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy receipts_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
