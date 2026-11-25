-- A tool installed on a whole workspace/org (e.g. the Vennata Slack app).
-- Its bot token belongs to the company, not to any one person, so it lives
-- here instead of in connections. RLS on with NO policies: only our server
-- can read it, same as connection_secrets.
create table public.workspace_installs (
  id                     uuid primary key default gen_random_uuid(),
  provider               public.provider not null,
  external_workspace_id  text not null,  -- e.g. Slack team id "T0123ABC"
  company_id             uuid not null references public.companies (id) on delete cascade,
  installed_by           uuid references public.profiles (id) on delete set null,
  bot_token_encrypted    text not null,
  scopes                 text[] not null default '{}',
  created_at             timestamptz not null default now(),
  unique (provider, external_workspace_id)
);

alter table public.workspace_installs enable row level security;
