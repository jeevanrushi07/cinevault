-- Run this once in Supabase SQL Editor to enable favorite people on an existing database.
create table if not exists public.favorite_people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tmdb_id bigint not null,
  name text not null,
  department text,
  profile_path text,
  created_at timestamptz not null default now(),
  unique(user_id, tmdb_id)
);

create index if not exists favorite_people_user_created_idx
  on public.favorite_people(user_id, created_at desc);

alter table public.favorite_people enable row level security;

drop policy if exists favorite_people_select_own on public.favorite_people;
create policy favorite_people_select_own on public.favorite_people
  for select to authenticated using (user_id = auth.uid());

drop policy if exists favorite_people_insert_own on public.favorite_people;
create policy favorite_people_insert_own on public.favorite_people
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists favorite_people_update_own on public.favorite_people;
create policy favorite_people_update_own on public.favorite_people
  for update to authenticated using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists favorite_people_delete_own on public.favorite_people;
create policy favorite_people_delete_own on public.favorite_people
  for delete to authenticated using (user_id = auth.uid());
