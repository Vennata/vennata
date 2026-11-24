-- Some sources only give daily totals (e.g. GitHub's contribution graph for
-- repos where the Vennata app isn't installed). One row can now represent
-- several actions on a day, and stats that need exact times can skip it.
create type public.event_precision as enum ('exact', 'day');

alter table public.activity_events
  add column quantity  integer not null default 1 check (quantity > 0),
  add column precision public.event_precision not null default 'exact';

-- GitHub reports private contributions in repos we can't see only as daily
-- totals with no type (commit? issue? review?), so they get their own kind.
alter type public.activity_kind add value 'contribution';
