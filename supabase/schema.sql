-- CHATLAB-only datastore. Deploy to a dedicated Supabase project.
-- Do not run this script against an unrelated app's database.
create table if not exists public.chatlab_reports (
  report_id text primary key,
  session_id text not null,
  model_id text not null,
  transcript_included boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  report jsonb not null check (jsonb_typeof(report) = 'object'),
  constraint chatlab_report_id_length check (char_length(report_id) between 8 and 180)
);

create index if not exists chatlab_reports_updated_idx
  on public.chatlab_reports(updated_at desc);

-- Reports must never be exposed to the anonymous/authenticated Data API.
alter table public.chatlab_reports enable row level security;
revoke all on public.chatlab_reports from public, anon, authenticated;
grant select, insert, update on public.chatlab_reports to service_role;

-- No permissive policies. A private Edge Function validates its own key and
-- writes using server-side service_role; report reading is through the
-- authenticated Supabase administration connector / SQL console.
