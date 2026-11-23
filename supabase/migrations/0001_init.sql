-- =============================================================================
-- Vennata initial schema
--
-- Ground rules enforced here, not just in app code:
--   * Every table has Row Level Security (RLS) on. With RLS on and no matching
--     policy, the database returns nothing. "Deny by default."
--   * The browser can only READ. All writes go through our server, which checks
--     permissions and uses the secret key.
--   * activity_events has no text column for message/email/doc content, so
--     content can't be stored even by accident.
--   * OAuth tokens live in connection_secrets, which has NO policies at all:
--     no logged-in user can ever read it, only our server.
-- =============================================================================

-- ---------- Enums (fixed lists of allowed values) ----------------------------
create type public.member_role as enum ('owner', 'admin', 'member');
create type public.join_policy as enum ('domain', 'invite_only');
create type public.provider as enum ('google', 'slack', 'microsoft', 'zoom', 'github');
create type public.connection_status as enum ('active', 'expired', 'revoked');
create type public.activity_kind as enum (
  'meeting', 'message', 'thread_start', 'thread_reply', 'reaction',
  'email_sent', 'doc_created', 'doc_edited',
  'commit', 'pr_opened', 'pr_merged', 'review_given'
);
create type public.poster_period as enum ('week', 'month', 'year');
create type public.poster_visibility as enum ('private', 'teams', 'company', 'public');

-- ---------- Companies ---------------------------------------------------------
-- Solo users get a personal company of one (is_personal = true), so the whole
-- app has a single code path for individuals and teams.
create table public.companies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email_domain  text,
  join_policy   public.join_policy not null default 'invite_only',
  is_personal   boolean not null default false,
  allow_public_posters boolean not null default true,
  created_at    timestamptz not null default now()
);
-- Only one real company can claim a domain (for auto-join).
create unique index companies_domain_unique on public.companies (email_domain)
  where email_domain is not null and not is_personal;

-- ---------- Profiles (one per person, 1:1 with Supabase auth.users) -----------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null,
  display_name  text,
  avatar_url    text,
  timezone      text not null default 'UTC',  -- needed for "after hours" and "peak hour"
  created_at    timestamptz not null default now()
);

-- ---------- Memberships (person <-> company, with a role) ---------------------
-- Team Lead is per team (see team_members.is_lead), not company-wide.
create table public.memberships (
  company_id  uuid not null references public.companies (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  role        public.member_role not null default 'member',
  joined_at   timestamptz not null default now(),
  left_at     timestamptz,  -- set on offboarding; data deleted 30 days later
  primary key (company_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

-- ---------- Teams -------------------------------------------------------------
create table public.teams (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  name         text not null,
  source       text not null default 'manual',  -- manual | slack | microsoft | google | github
  external_id  text,                            -- id in the source tool, for re-sync
  created_at   timestamptz not null default now(),
  unique (company_id, source, external_id)
);

create table public.team_members (
  team_id  uuid not null references public.teams (id) on delete cascade,
  user_id  uuid not null references public.profiles (id) on delete cascade,
  is_lead  boolean not null default false,
  primary key (team_id, user_id)
);
create index team_members_user_idx on public.team_members (user_id);

-- ---------- Connections (a user's linked tool account) ------------------------
-- external_email is what identity resolution matches on.
create table public.connections (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles (id) on delete cascade,
  company_id           uuid not null references public.companies (id) on delete cascade,
  provider             public.provider not null,
  external_account_id  text not null,
  external_email       text,
  scopes               text[] not null default '{}',
  status               public.connection_status not null default 'active',
  last_synced_at       timestamptz,
  created_at           timestamptz not null default now(),
  unique (provider, external_account_id)
);
create index connections_user_idx on public.connections (user_id);

-- Tokens are encrypted by our server (AES-256-GCM) before they get here, so
-- even a database leak doesn't expose usable tokens.
create table public.connection_secrets (
  connection_id            uuid primary key references public.connections (id) on delete cascade,
  access_token_encrypted   text not null,
  refresh_token_encrypted  text,
  expires_at               timestamptz
);

-- ---------- Activity events (METADATA ONLY) -----------------------------------
-- One row per meeting / message / commit / etc. Counts, times, participants.
-- Deliberately no title, subject, body, or free-text column.
create table public.activity_events (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  company_id      uuid not null references public.companies (id) on delete cascade,
  connection_id   uuid not null references public.connections (id) on delete cascade,
  provider        public.provider not null,
  kind            public.activity_kind not null,
  external_id     text not null,           -- source's id, so re-syncing never double counts
  started_at      timestamptz not null,
  ended_at        timestamptz,             -- meetings only
  attendee_count  integer,                 -- meetings only
  participant_emails text[] not null default '{}',  -- for "#1 collaborator"
  created_at      timestamptz not null default now(),
  unique (connection_id, kind, external_id)
);
create index activity_user_time_idx on public.activity_events (user_id, started_at);

-- ---------- Posters -----------------------------------------------------------
-- stats is a snapshot of computed numbers (counts only), frozen at generation
-- time so a poster never changes after it's shared.
create table public.posters (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  user_id       uuid references public.profiles (id) on delete cascade,  -- null for team posters
  team_id       uuid references public.teams (id) on delete cascade,     -- set for team posters
  period        public.poster_period not null,
  period_start  date not null,
  period_end    date not null,
  stats         jsonb not null,
  visibility    public.poster_visibility not null default 'private',  -- PRIVATE BY DEFAULT
  public_slug   text unique,  -- only set when shared via public link
  created_at    timestamptz not null default now(),
  check ((user_id is null) <> (team_id is null))  -- exactly one owner: a person OR a team
);
create unique index posters_user_period_unique on public.posters (user_id, period, period_start)
  where user_id is not null;
create unique index posters_team_period_unique on public.posters (team_id, period, period_start)
  where team_id is not null;

-- Which of my teams can see a poster with visibility = 'teams'.
create table public.poster_team_shares (
  poster_id  uuid not null references public.posters (id) on delete cascade,
  team_id    uuid not null references public.teams (id) on delete cascade,
  primary key (poster_id, team_id)
);

-- =============================================================================
-- Helper functions for RLS.
-- "security definer" runs them with elevated rights so policies can look up
-- memberships without triggering RLS on memberships itself (which would loop).
-- "set search_path = ''" blocks a known hijacking trick on definer functions.
-- =============================================================================
create function public.is_company_member(cid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.company_id = cid and m.user_id = (select auth.uid()) and m.left_at is null
  );
$$;

create function public.is_team_member(tid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_members tm
    where tm.team_id = tid and tm.user_id = (select auth.uid())
  );
$$;

create function public.shares_company_with(other uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships a
    join public.memberships b on a.company_id = b.company_id
    where a.user_id = (select auth.uid()) and b.user_id = other
      and a.left_at is null and b.left_at is null
  );
$$;

-- =============================================================================
-- Row Level Security: read-only policies for logged-in users.
-- No insert/update/delete policies = the browser can't write anything yet.
-- =============================================================================
alter table public.companies          enable row level security;
alter table public.profiles           enable row level security;
alter table public.memberships        enable row level security;
alter table public.teams              enable row level security;
alter table public.team_members       enable row level security;
alter table public.connections        enable row level security;
alter table public.connection_secrets enable row level security;  -- no policies, ever
alter table public.activity_events    enable row level security;
alter table public.posters            enable row level security;
alter table public.poster_team_shares enable row level security;

create policy "members read their companies" on public.companies
  for select to authenticated using (public.is_company_member(id));

create policy "read own profile and coworkers" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.shares_company_with(id));

create policy "members read company memberships" on public.memberships
  for select to authenticated using (public.is_company_member(company_id));

create policy "members read teams" on public.teams
  for select to authenticated using (public.is_company_member(company_id));

create policy "members read team members" on public.team_members
  for select to authenticated
  using (exists (select 1 from public.teams t
                 where t.id = team_id and public.is_company_member(t.company_id)));

-- Only you can see your own connections and raw activity. Not admins, not anyone.
create policy "read own connections" on public.connections
  for select to authenticated using (user_id = (select auth.uid()));

create policy "read own activity" on public.activity_events
  for select to authenticated using (user_id = (select auth.uid()));

-- Posters: yours always; others only if their visibility lets you in.
-- Note there is NO admin exception: a private poster is private, period.
-- Public-link posters are served by our server by slug, not through this policy.
create policy "read visible posters" on public.posters
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (team_id is not null and public.is_team_member(team_id))
    or (visibility = 'company' and public.is_company_member(company_id))
    or (visibility = 'teams' and exists (
          select 1 from public.poster_team_shares s
          where s.poster_id = posters.id and public.is_team_member(s.team_id)))
  );

create policy "read shares of own posters" on public.poster_team_shares
  for select to authenticated
  using (exists (select 1 from public.posters p
                 where p.id = poster_id and p.user_id = (select auth.uid())));

-- =============================================================================
-- On signup: create profile + personal company + owner membership.
-- Runs inside the database, so it can't be skipped or half-done.
-- =============================================================================
create function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  personal_company uuid;
  name text := coalesce(new.raw_user_meta_data ->> 'full_name',
                        new.raw_user_meta_data ->> 'name',
                        split_part(new.email, '@', 1));
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (new.id, new.email, name, new.raw_user_meta_data ->> 'avatar_url');

  insert into public.companies (name, is_personal)
  values (name || '''s space', true)
  returning id into personal_company;

  insert into public.memberships (company_id, user_id, role)
  values (personal_company, new.id, 'owner');

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
