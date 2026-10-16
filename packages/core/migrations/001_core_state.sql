-- Hackathon persistence: one atomic JSONB aggregate per configured site.
-- FOR UPDATE serializes read/modify/write operations across server instances.
-- Migrate to normalized event/outbox tables before high-volume production use.
CREATE TABLE IF NOT EXISTS recyclone_core_state (
  site_id text PRIMARY KEY,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  revision bigint NOT NULL DEFAULT 0,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
