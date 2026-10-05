-- Add network messaging and event notifications to an existing CineVault database.

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  check (sender_id <> receiver_id)
);

create index if not exists messages_sender_receiver_created_idx
  on public.messages(sender_id, receiver_id, created_at desc);
create index if not exists messages_receiver_unread_idx
  on public.messages(receiver_id, created_at desc) where read_at is null;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  notification_type text not null check (notification_type in (
    'library_shared',
    'library_access_revoked',
    'library_access_updated',
    'message_received'
  )),
  resource_id uuid,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists notifications_user_created_idx
  on public.notifications(user_id, created_at desc);
create index if not exists notifications_user_unread_idx
  on public.notifications(user_id, created_at desc) where read_at is null;

alter table public.messages enable row level security;
alter table public.notifications enable row level security;
grant select, insert on public.messages to authenticated;
grant select on public.notifications to authenticated;

drop policy if exists messages_select_participant on public.messages;
create policy messages_select_participant on public.messages
for select to authenticated
using (sender_id = auth.uid() or receiver_id = auth.uid());

drop policy if exists messages_insert_sender on public.messages;
create policy messages_insert_sender on public.messages
for insert to authenticated
with check (
  sender_id = auth.uid()
  and receiver_id <> auth.uid()
  and char_length(btrim(body)) between 1 and 2000
);

drop policy if exists notifications_select_recipient on public.notifications;
create policy notifications_select_recipient on public.notifications
for select to authenticated
using (user_id = auth.uid());

create or replace function public.mark_notifications_read(p_notification_id uuid default null)
returns void
language sql
security definer
set search_path = public
as $$
  update public.notifications
  set read_at = coalesce(read_at, now())
  where user_id = auth.uid()
    and (p_notification_id is null or id = p_notification_id);
$$;

create or replace function public.mark_messages_read(p_sender_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.messages
  set read_at = now()
  where sender_id = p_sender_id
    and receiver_id = auth.uid()
    and read_at is null;

  update public.notifications n
  set read_at = coalesce(n.read_at, now())
  where n.user_id = auth.uid()
    and n.actor_id = p_sender_id
    and n.notification_type = 'message_received'
    and n.read_at is null
    and exists (
      select 1 from public.messages m
      where m.id = n.resource_id
        and m.sender_id = p_sender_id
        and m.receiver_id = auth.uid()
    );
  return;
end;
$$;

revoke all on function public.mark_notifications_read(uuid) from public;
revoke all on function public.mark_messages_read(uuid) from public;
grant execute on function public.mark_notifications_read(uuid) to authenticated;
grant execute on function public.mark_messages_read(uuid) to authenticated;

create or replace function public.notify_library_share_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  recipient uuid;
  kind text;
  resource uuid;
begin
  if tg_op = 'INSERT' then
    recipient := new.receiver_id;
    actor := new.sender_id;
    kind := 'library_shared';
    resource := new.id;
  elsif tg_op = 'UPDATE' then
    if old.expires_at is not distinct from new.expires_at then
      return new;
    end if;
    recipient := new.receiver_id;
    actor := new.sender_id;
    kind := 'library_access_updated';
    resource := new.id;
  else
    if actor is null then
      return old;
    end if;
    recipient := case when actor = old.sender_id then old.receiver_id else old.sender_id end;
    kind := 'library_access_revoked';
    resource := old.id;
  end if;

  if recipient is not null and actor is not null then
    insert into public.notifications(user_id, actor_id, notification_type, resource_id)
    values (recipient, actor, kind, resource);
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists library_share_insert_notification on public.library_shares;
create trigger library_share_insert_notification
after insert on public.library_shares
for each row execute function public.notify_library_share_change();

drop trigger if exists library_share_update_notification on public.library_shares;
create trigger library_share_update_notification
after update of expires_at on public.library_shares
for each row execute function public.notify_library_share_change();

drop trigger if exists library_share_delete_notification on public.library_shares;
create trigger library_share_delete_notification
after delete on public.library_shares
for each row execute function public.notify_library_share_change();

create or replace function public.notify_new_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications(user_id, actor_id, notification_type, resource_id)
  values (new.receiver_id, new.sender_id, 'message_received', new.id);
  return new;
end;
$$;

drop trigger if exists message_notification on public.messages;
create trigger message_notification
after insert on public.messages
for each row execute function public.notify_new_message();
