-- Docker deployments (src/containers.ts).

-- Each project's choices: what it is built as (auto, static, workers or
-- docker), its Dockerfile's path when not one g1t finds by itself, and the
-- size its container runs at (a Cloudflare Containers instance type).
ALTER TABLE settings ADD COLUMN build_as TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE settings ADD COLUMN dockerfile TEXT;
ALTER TABLE settings ADD COLUMN instance_type TEXT NOT NULL DEFAULT 'lite';

-- What each build found the project built with, next to `detected`: a
-- framework's id (`astro`), or for a container `dockerfile` or the server
-- g1t wrote a Dockerfile for (`flask`). And a container's image, by digest.
ALTER TABLE deployments ADD COLUMN framework TEXT;
ALTER TABLE deployments ADD COLUMN image TEXT;

-- An app that is a container: its Container application, the size it runs
-- at, and the hash of the token its Worker reports its running time with.
-- `runtime` is `worker` for every other app.
ALTER TABLE apps ADD COLUMN runtime TEXT NOT NULL DEFAULT 'worker';
ALTER TABLE apps ADD COLUMN container_app_id TEXT;
ALTER TABLE apps ADD COLUMN instance_type TEXT;
ALTER TABLE apps ADD COLUMN meter_hash TEXT;

-- How long each app's container ran in a month, and what it sent, as its
-- Worker reports them: one row per counter (`epoch`, the Durable Object's
-- own, which starts again at zero if it is ever new), each only ever
-- raised, so a report repeated or out of order changes nothing.
CREATE TABLE container_meters (
  script TEXT NOT NULL,
  epoch TEXT NOT NULL,
  month TEXT NOT NULL,
  workspace TEXT NOT NULL,
  instance_type TEXT NOT NULL,
  awake_seconds INTEGER NOT NULL DEFAULT 0,
  egress_bytes INTEGER NOT NULL DEFAULT 0,
  reported_at TEXT NOT NULL,
  PRIMARY KEY (script, epoch, month)
);
CREATE INDEX container_meters_by_month ON container_meters (month, workspace);
