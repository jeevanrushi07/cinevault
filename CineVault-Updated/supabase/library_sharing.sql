-- Add expiring, read-only library sharing to an existing CineVault database.

create table if not exists public.library_shares (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  unique(sender_id, receiver_id),
  check(sender_id <> receiver_id),
  check(expires_at is null or expires_at > created_at)
);

create index if not exists library_shares_receiver_idx on public.library_shares(receiver_id, created_at desc);
create index if not exists library_shares_sender_idx on public.library_shares(sender_id, created_at desc);

alter table public.library_shares enable row level security;

drop policy if exists library_shares_select_participant on public.library_shares;
create policy library_shares_select_participant on public.library_shares
for select to authenticated
using (sender_id = auth.uid() or receiver_id = auth.uid());

drop policy if exists library_shares_insert_sender on public.library_shares;
create policy library_shares_insert_sender on public.library_shares
for insert to authenticated
with check (
  sender_id = auth.uid()
  and receiver_id <> auth.uid()
  and (expires_at is null or expires_at > now())
);

drop policy if exists library_shares_update_sender on public.library_shares;
create policy library_shares_update_sender on public.library_shares
for update to authenticated
using (sender_id = auth.uid())
with check (
  sender_id = auth.uid()
  and receiver_id <> auth.uid()
  and (expires_at is null or expires_at > now())
);

drop policy if exists library_shares_delete_participant on public.library_shares;
create policy library_shares_delete_participant on public.library_shares
for delete to authenticated
using (sender_id = auth.uid() or receiver_id = auth.uid());

create or replace function public.get_shared_library(p_share_id uuid)
returns table (
  tmdb_id bigint,
  title text,
  type text,
  poster_path text,
  backdrop_path text,
  year text,
  overview text,
  genres jsonb,
  cast_members jsonb,
  director text,
  imdb_id text,
  tmdb_rating numeric,
  trailer_key text,
  status text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    m.tmdb_id, m.title, m.type, m.poster_path, m.backdrop_path, m.year,
    m.overview, m.genres, m.cast_members, m.director, m.imdb_id,
    m.tmdb_rating, m.trailer_key, m.status, m.created_at
  from public.movies m
  join public.library_shares s on s.sender_id = m.user_id
  where s.id = p_share_id
    and s.receiver_id = auth.uid()
    and (s.expires_at is null or s.expires_at > now())
  order by m.created_at desc;
$$;

revoke all on function public.get_shared_library(uuid) from public;
grant execute on function public.get_shared_library(uuid) to authenticated;
