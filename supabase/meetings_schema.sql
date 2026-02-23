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

create table if not exists public.meeting_transcript_segments (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  user_id text not null,
  segment_id text not null,
  timestamp_ms bigint not null,
  source text not null check (source in ('user', 'interviewer')),
  text text not null,
  provider text not null default 'unknown',
  latency_ms integer,
  dropped boolean not null default false,
  created_at timestamptz not null default now(),
  constraint meeting_segments_unique unique (meeting_id, segment_id)
);

create table if not exists public.meeting_detected_questions (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  user_id text not null,
  question_id text not null,
  question text not null,
  source text not null check (source in ('user', 'interviewer')),
  confidence real not null default 0,
  detected_at bigint not null,
  context_window text,
  understanding jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint meeting_questions_unique unique (meeting_id, question_id)
);

create table if not exists public.meeting_ai_answers (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  user_id text not null,
  answer_id text not null,
  question_id text,
  question text not null,
  answer text not null,
  follow_ups jsonb not null default '[]'::jsonb,
  provider text not null default 'unknown',
  model text not null default 'unknown',
  latency_ms integer not null default 0,
  draft_latency_ms integer,
  refine_latency_ms integer,
  generation_stage text check (generation_stage in ('draft', 'refined')),
  quality jsonb not null default '{}'::jsonb,
  quality_judge_provider text,
  quality_judge_model text,
  created_at timestamptz not null default now(),
  constraint meeting_answers_unique unique (meeting_id, answer_id)
);

create table if not exists public.meeting_session_metrics (
  meeting_id uuid primary key references public.meetings(id) on delete cascade,
  user_id text not null,
  controls jsonb not null default '{}'::jsonb,
  performance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists meetings_user_started_idx
  on public.meetings (user_id, started_at desc);

create index if not exists meeting_segments_meeting_idx
  on public.meeting_transcript_segments (meeting_id, timestamp_ms asc);

create index if not exists meeting_questions_meeting_idx
  on public.meeting_detected_questions (meeting_id, detected_at desc);

create index if not exists meeting_answers_meeting_idx
  on public.meeting_ai_answers (meeting_id, created_at desc);

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

drop trigger if exists meeting_session_metrics_set_updated_at on public.meeting_session_metrics;
create trigger meeting_session_metrics_set_updated_at
before update on public.meeting_session_metrics
for each row
execute function public.set_updated_at();

-- Because app auth is currently Firebase (not Supabase Auth), keep this table open
-- only if you trust the client key usage. For production, proxy writes through your backend.
alter table public.meetings enable row level security;
alter table public.meeting_transcript_segments enable row level security;
alter table public.meeting_detected_questions enable row level security;
alter table public.meeting_ai_answers enable row level security;
alter table public.meeting_session_metrics enable row level security;

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

drop policy if exists meeting_segments_select_all on public.meeting_transcript_segments;
create policy meeting_segments_select_all on public.meeting_transcript_segments
for select
to anon, authenticated
using (true);

drop policy if exists meeting_segments_insert_all on public.meeting_transcript_segments;
create policy meeting_segments_insert_all on public.meeting_transcript_segments
for insert
to anon, authenticated
with check (true);

drop policy if exists meeting_segments_update_all on public.meeting_transcript_segments;
create policy meeting_segments_update_all on public.meeting_transcript_segments
for update
to anon, authenticated
using (true)
with check (true);

drop policy if exists meeting_segments_delete_all on public.meeting_transcript_segments;
create policy meeting_segments_delete_all on public.meeting_transcript_segments
for delete
to anon, authenticated
using (true);

drop policy if exists meeting_questions_select_all on public.meeting_detected_questions;
create policy meeting_questions_select_all on public.meeting_detected_questions
for select
to anon, authenticated
using (true);

drop policy if exists meeting_questions_insert_all on public.meeting_detected_questions;
create policy meeting_questions_insert_all on public.meeting_detected_questions
for insert
to anon, authenticated
with check (true);

drop policy if exists meeting_questions_update_all on public.meeting_detected_questions;
create policy meeting_questions_update_all on public.meeting_detected_questions
for update
to anon, authenticated
using (true)
with check (true);

drop policy if exists meeting_questions_delete_all on public.meeting_detected_questions;
create policy meeting_questions_delete_all on public.meeting_detected_questions
for delete
to anon, authenticated
using (true);

drop policy if exists meeting_answers_select_all on public.meeting_ai_answers;
create policy meeting_answers_select_all on public.meeting_ai_answers
for select
to anon, authenticated
using (true);

drop policy if exists meeting_answers_insert_all on public.meeting_ai_answers;
create policy meeting_answers_insert_all on public.meeting_ai_answers
for insert
to anon, authenticated
with check (true);

drop policy if exists meeting_answers_update_all on public.meeting_ai_answers;
create policy meeting_answers_update_all on public.meeting_ai_answers
for update
to anon, authenticated
using (true)
with check (true);

drop policy if exists meeting_answers_delete_all on public.meeting_ai_answers;
create policy meeting_answers_delete_all on public.meeting_ai_answers
for delete
to anon, authenticated
using (true);

drop policy if exists meeting_metrics_select_all on public.meeting_session_metrics;
create policy meeting_metrics_select_all on public.meeting_session_metrics
for select
to anon, authenticated
using (true);

drop policy if exists meeting_metrics_insert_all on public.meeting_session_metrics;
create policy meeting_metrics_insert_all on public.meeting_session_metrics
for insert
to anon, authenticated
with check (true);

drop policy if exists meeting_metrics_update_all on public.meeting_session_metrics;
create policy meeting_metrics_update_all on public.meeting_session_metrics
for update
to anon, authenticated
using (true)
with check (true);
