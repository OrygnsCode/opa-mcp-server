-- Counts per UTC day. Every key is one of a fixed list, a version, a band,
-- or a tool name, so a row can never hold anything that identifies an
-- install.
--
--   metric          key
--   reports         ''                       reports received that day
--   version, os, arch, node, app, install, ctx, country, files, age
--                   the value
--   opa             source|minor             how opa was found, its version
--   regal, conftest minor or missing
--   setting         name                     a documented setting that is
--                                            set to something other than
--                                            its default (never the value)
--   first_week, first_month, first_ever
--                   ctx                      installs whose first active day
--                                            of that span this was, by
--                                            context (default, container)
--   active          ''                       installs whose counts for that
--                                            day arrived (day = the day used)
--   tool            name|band                installs that called the tool
--   failure         tool|code|band           failed calls, by error code
--   crash           tool|site|band           unexpected errors, by where in
--                                            the server's code they happened
--   active_app      app                      AI apps used that day
--   dev_reports     ''                       reports from source checkouts,
--                                            counted apart from everything
CREATE TABLE daily (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  key TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, metric, key)
) WITHOUT ROWID;

-- Each report's random number, so a report sent again is counted once.
-- fresh is 1 while the first copy is being counted and 0 once the same
-- number comes again. Pruned after three days; nothing links one day's
-- number to another's.
CREATE TABLE nonces (
  nonce TEXT PRIMARY KEY,
  seen TEXT NOT NULL,
  fresh INTEGER NOT NULL
) WITHOUT ROWID;

-- The last seven days of reports as received, after validation, for
-- looking into anything odd in the counts. No address and no report number
-- is stored.
CREATE TABLE log (
  ts TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE INDEX log_ts ON log (ts);
