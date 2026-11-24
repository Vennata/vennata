-- Lines added/removed per commit (GitHub, repos where the app is installed).
-- Stored raw; stats code skips outliers like lockfiles and generated code.
alter table public.activity_events
  add column lines_added   integer check (lines_added >= 0),
  add column lines_removed integer check (lines_removed >= 0);
