-- One row per install. Containers and CI jobs send no install ID, so they
-- are counted in daily_pings only and never appear here.
CREATE TABLE installs (
  id TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  days_seen INTEGER NOT NULL
) WITHOUT ROWID;

-- Pings per UTC day.
CREATE TABLE daily_pings (
  date TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  context TEXT NOT NULL,
  pings INTEGER NOT NULL,
  PRIMARY KEY (date, version, platform, context)
) WITHOUT ROWID;

-- Installs seen per UTC day, and how many of those were seen for the first time.
CREATE TABLE daily_installs (
  date TEXT PRIMARY KEY,
  active_installs INTEGER NOT NULL,
  new_installs INTEGER NOT NULL
) WITHOUT ROWID;

-- The last seven days of pings, pruned daily. Holds no install IDs.
CREATE TABLE ping_log (
  ts TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  context TEXT NOT NULL,
  id_state TEXT NOT NULL,
  user_agent TEXT NOT NULL
);

-- Counters carried over from the previous store, so totals and history
-- continue across the move.
CREATE TABLE legacy_totals (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE legacy_daily (
  date TEXT NOT NULL,
  field TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (date, field)
) WITHOUT ROWID;

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
