-- Meeting history storage for Firebase-authenticated users.
-- Run in Supabase SQL Editor.

create extension if not exists "pgcrypto";

create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  remote_meeting_id text not null,
  title text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_seconds integer not null default 0,
  note_count integer not null default 0,
  transcript_count integer not null default 0,
  summary jsonb,
  mind_map jsonb,
  notes jsonb not null default '[]'::jsonb,
  transcripts jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meetings_user_remote_unique unique (user_id, remote_meeting_id)
);

alter table public.meetings
  drop column if exists transcript_segments,
  drop column if exists detected_questions,
  drop column if exists answer_analytics,
  drop column if exists performance_metrics,
  drop column if exists session_memory;

create index if not exists meetings_user_started_idx
  on public.meetings (user_id, started_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists meetings_set_updated_at on public.meetings;
create trigger meetings_set_updated_at
before update on public.meetings
for each row
execute function public.set_updated_at();

-- Because app auth is currently Firebase (not Supabase Auth), keep this table open
-- only if you trust the client key usage. For production, proxy writes through your backend.
alter table public.meetings enable row level security;

drop policy if exists meetings_select_all on public.meetings;
create policy meetings_select_all on public.meetings
for select
to anon, authenticated
using (true);

drop policy if exists meetings_insert_all on public.meetings;
create policy meetings_insert_all on public.meetings
for insert
to anon, authenticated
with check (true);

drop policy if exists meetings_update_all on public.meetings;
create policy meetings_update_all on public.meetings
for update
to anon, authenticated
using (true)
with check (true);
