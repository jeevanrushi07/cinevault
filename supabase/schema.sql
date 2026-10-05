-- CineVault Supabase schema
-- Run this entire file once in Supabase -> SQL Editor.

create extension if not exists pgcrypto;

drop function if exists public.handle_new_user() cascade;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (username ~ '^[a-z0-9_.-]{3,30}$'),
  display_name text,
  avatar text,
  created_at timestamptz not null default now()
);

create table if not exists public.movies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tmdb_id bigint not null,
  title text not null,
  type text not null default 'movie',
  poster_path text,
  backdrop_path text,
  year text,
  overview text,
  genres jsonb not null default '[]'::jsonb,
  cast_members jsonb not null default '[]'::jsonb,
  director text,
  imdb_id text,
  tmdb_rating numeric,
  trailer_key text,
  personal_note text,
  status text not null default 'watched' check (status in ('watched','want')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, tmdb_id)
);

create table if not exists public.characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_name text not null,
  actor_name text,
  poster text,
  movie_title text,
  created_at timestamptz not null default now()
);

create table if not exists public.shares (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  tmdb_id bigint not null,
  movie_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique(sender_id, receiver_id, tmdb_id),
  check(sender_id <> receiver_id)
);

create index if not exists movies_user_status_idx on public.movies(user_id, status);
create index if not exists movies_user_tmdb_idx on public.movies(user_id, tmdb_id);
create index if not exists profiles_username_idx on public.profiles(username);
create index if not exists shares_receiver_idx on public.shares(receiver_id, created_at desc);
create index if not exists shares_sender_idx on public.shares(sender_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.movies enable row level security;
alter table public.characters enable row level security;
alter table public.shares enable row level security;

drop policy if exists profiles_select_authenticated on public.profiles;
create policy profiles_select_authenticated on public.profiles for select to authenticated using (true);
drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles for insert to authenticated with check (id = auth.uid());
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists movies_select_own on public.movies;
create policy movies_select_own on public.movies for select to authenticated using (user_id = auth.uid());
drop policy if exists movies_insert_own on public.movies;
create policy movies_insert_own on public.movies for insert to authenticated with check (user_id = auth.uid());
drop policy if exists movies_update_own on public.movies;
create policy movies_update_own on public.movies for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists movies_delete_own on public.movies;
create policy movies_delete_own on public.movies for delete to authenticated using (user_id = auth.uid());

drop policy if exists characters_select_own on public.characters;
create policy characters_select_own on public.characters for select to authenticated using (user_id = auth.uid());
drop policy if exists characters_insert_own on public.characters;
create policy characters_insert_own on public.characters for insert to authenticated with check (user_id = auth.uid());
drop policy if exists characters_delete_own on public.characters;
create policy characters_delete_own on public.characters for delete to authenticated using (user_id = auth.uid());

drop policy if exists shares_select_participant on public.shares;
create policy shares_select_participant on public.shares for select to authenticated using (sender_id = auth.uid() or receiver_id = auth.uid());
drop policy if exists shares_insert_sender on public.shares;
create policy shares_insert_sender on public.shares for insert to authenticated with check (sender_id = auth.uid());
drop policy if exists shares_delete_sender on public.shares;
create policy shares_delete_sender on public.shares for delete to authenticated using (sender_id = auth.uid());

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, display_name)
  values (new.id, lower(new.raw_user_meta_data->>'username'), new.raw_user_meta_data->>'username')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();
