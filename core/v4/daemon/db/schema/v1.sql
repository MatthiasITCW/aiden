-- v4.5 Phase 1 — daemon SQLite schema v1.
-- Bundled as a string at build time; applied by migrations.ts.

CREATE TABLE IF NOT EXISTS schema_version (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  version         INTEGER NOT NULL,
  applied_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daemon_instances (
  instance_id     TEXT PRIMARY KEY,
  pid             INTEGER NOT NULL,
  hostname        TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  last_heartbeat  INTEGER NOT NULL,
  shutdown_at     INTEGER,
  shutdown_reason TEXT,
  exit_code       INTEGER,
  version         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daemon_instances_alive
  ON daemon_instances(shutdown_at) WHERE shutdown_at IS NULL;

CREATE TABLE IF NOT EXISTS runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_event_id INTEGER,
  session_id       TEXT NOT NULL,
  instance_id      TEXT NOT NULL,
  status           TEXT NOT NULL,
  finish_reason    TEXT,
  started_at       INTEGER NOT NULL,
  completed_at     INTEGER,
  resume_pending   INTEGER NOT NULL DEFAULT 0,
  resume_reason    TEXT,
  FOREIGN KEY (instance_id) REFERENCES daemon_instances(instance_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_active
  ON runs(status) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS trigger_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source            TEXT NOT NULL,
  source_key        TEXT NOT NULL,
  idempotency_key   TEXT,
  payload_json      TEXT NOT NULL,
  status            TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  claim_owner       TEXT,
  claim_expires_at  INTEGER,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  completed_at      INTEGER,
  run_id            INTEGER,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_events_idem
  ON trigger_events(source, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trigger_events_pending
  ON trigger_events(status, created_at) WHERE status IN ('pending','claimed');
CREATE INDEX IF NOT EXISTS idx_trigger_events_claim_expiry
  ON trigger_events(claim_expires_at) WHERE status = 'claimed';

CREATE TABLE IF NOT EXISTS run_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, ts);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope           TEXT NOT NULL,
  key             TEXT NOT NULL,
  fingerprint     TEXT,
  response_json   TEXT NOT NULL,
  status_code     INTEGER NOT NULL DEFAULT 200,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS idx_idem_expiry ON idempotency_keys(expires_at);

CREATE TABLE IF NOT EXISTS crash_reports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id         TEXT NOT NULL,
  detected_at         INTEGER NOT NULL,
  prev_started_at     INTEGER,
  prev_last_heartbeat INTEGER,
  prev_pid            INTEGER,
  affected_sessions   TEXT NOT NULL,
  ps_snapshot         TEXT,
  details             TEXT NOT NULL,
  FOREIGN KEY (instance_id) REFERENCES daemon_instances(instance_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS restart_failure_counts (
  session_id      TEXT PRIMARY KEY,
  count           INTEGER NOT NULL,
  last_failure    INTEGER NOT NULL,
  auto_suspended  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS triggers (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  name            TEXT NOT NULL,
  spec_json       TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  fire_rate_limit INTEGER,
  prompt_template TEXT,
  deliver_only    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_source_enabled ON triggers(source, enabled);
