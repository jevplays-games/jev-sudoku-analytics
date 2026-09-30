-- JEV Sudoku on Cloudflare D1. Derived from the container-era db/schema.sql (now removed) with the changes the Workers
-- runtime needs: optimistic-concurrency revision, durable decision leases, D1-backed quotas, a practice puzzle pool and a
-- compact per-result summary. D1 does not accept PRAGMA statements in migrations, so foreign keys are always on (as in D1).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, avatar TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  csrf TEXT NOT NULL, context_json TEXT CHECK(context_json IS NULL OR json_valid(context_json)),
  telemetry_consent INTEGER NOT NULL DEFAULT 0 CHECK(telemetry_consent IN(0,1)), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS security_tokens (
  hash TEXT PRIMARY KEY, kind TEXT NOT NULL, session_hash TEXT, user_id TEXT, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  expires_at INTEGER NOT NULL, used_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS token_expiry ON security_tokens(expires_at);
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY, utc_date TEXT NOT NULL, difficulty TEXT NOT NULL CHECK(difficulty IN('easy','normal','hard','jev')),
  givens TEXT NOT NULL CHECK(length(givens)=81 AND givens NOT GLOB '*[^0-9]*'), puzzle_hash TEXT NOT NULL,
  private_seed TEXT NOT NULL, config_json TEXT NOT NULL CHECK(json_valid(config_json)), created_at INTEGER NOT NULL,
  UNIQUE(utc_date,difficulty)
) STRICT;
-- Practice puzzles are drawn from this pool and given a random symmetry transform per match (server/puzzles.js), so the
-- Worker never runs the generator. Ranked daily puzzles live in `challenges` and are published out of band (never committed).
CREATE TABLE IF NOT EXISTS puzzle_pool (
  id INTEGER PRIMARY KEY, givens TEXT NOT NULL CHECK(length(givens)=81 AND givens NOT GLOB '*[^0-9]*'),
  puzzle_hash TEXT NOT NULL UNIQUE, generator_version TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  challenge_id TEXT REFERENCES challenges(id), guild_id TEXT, channel_id TEXT,
  official INTEGER NOT NULL CHECK(official IN(0,1)), create_key TEXT NOT NULL,
  initial_json TEXT NOT NULL CHECK(json_valid(initial_json)), state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  status TEXT NOT NULL CHECK(status IN('ready','running','settling','finished')),
  -- Compare-and-swap counter (equals state.sequence) plus the integrity heads checked on every append.
  revision INTEGER NOT NULL DEFAULT 0, head_hash TEXT NOT NULL, chain_head TEXT NOT NULL,
  decision_json TEXT CHECK(decision_json IS NULL OR json_valid(decision_json)),
  created_at INTEGER NOT NULL, started_at INTEGER, deadline_at INTEGER, last_seen_at INTEGER NOT NULL,
  CHECK((guild_id IS NULL)=(channel_id IS NULL)), UNIQUE(owner_hash,create_key)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_official_attempt ON matches(user_id,challenge_id) WHERE official=1;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_session ON matches(owner_hash) WHERE status!='finished';
CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_user ON matches(user_id) WHERE status!='finished' AND user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS match_scope ON matches(challenge_id,guild_id,channel_id);
CREATE INDEX IF NOT EXISTS match_user ON matches(user_id,created_at);
CREATE INDEX IF NOT EXISTS match_owner ON matches(owner_hash,created_at);
CREATE INDEX IF NOT EXISTS match_status ON matches(status,last_seen_at);
CREATE TABLE IF NOT EXISTS match_events (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE, sequence INTEGER NOT NULL,
  request_id TEXT NOT NULL, event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  previous_hash TEXT NOT NULL, resulting_hash TEXT NOT NULL, chain_hash TEXT NOT NULL,
  PRIMARY KEY(match_id,sequence), UNIQUE(match_id,request_id)
) STRICT;
-- The opponent's next decision, prepared ahead of its due time. status='inflight' is a durable lease (lease_until) so two
-- requests never spend two provider calls on the same board; status='ready' holds the validated decision and candidate set.
CREATE TABLE IF NOT EXISTS pending_decisions (
  match_id TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE, revision INTEGER NOT NULL, state_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('inflight','ready')), lease_until INTEGER NOT NULL,
  decision_json TEXT CHECK(decision_json IS NULL OR json_valid(decision_json)), bundle_json TEXT CHECK(bundle_json IS NULL OR json_valid(bundle_json)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS results (
  match_id TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE, eligible INTEGER NOT NULL CHECK(eligible IN(0,1)),
  winner TEXT NOT NULL CHECK(winner IN('human','jev','draw','pending')), human_ms INTEGER, human_bucket INTEGER, jev_ms INTEGER,
  -- The stored view of a result is deliberately small (state-derived summary plus provider usage). The full analytics report is
  -- rebuilt from the recorded events on demand, so retention or consent withdrawal can never leave a stale cached copy behind.
  summary_json TEXT NOT NULL CHECK(json_valid(summary_json)), replay_hash TEXT NOT NULL, verified_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS result_rank ON results(eligible,human_bucket,match_id);
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY, match_id TEXT REFERENCES matches(id) ON DELETE CASCADE, name TEXT NOT NULL,
  trust TEXT NOT NULL CHECK(trust IN('server','client')), properties_json TEXT NOT NULL CHECK(json_valid(properties_json)),
  client_event_id TEXT, created_at INTEGER NOT NULL, UNIQUE(match_id,client_event_id)
) STRICT;
CREATE INDEX IF NOT EXISTS telemetry_match ON telemetry(match_id,id);
CREATE INDEX IF NOT EXISTS telemetry_age ON telemetry(trust,created_at);
CREATE TABLE IF NOT EXISTS operations (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, properties_json TEXT NOT NULL CHECK(json_valid(properties_json)), created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS operations_age ON operations(created_at);
CREATE INDEX IF NOT EXISTS operations_name ON operations(name,created_at);
-- Fixed-window counters used for quota reservations (provider calls, match creation, sign-in). Keys are salted hashes.
CREATE TABLE IF NOT EXISTS quotas (id TEXT PRIMARY KEY, n INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS quota_expiry ON quotas(expires_at);
-- Gate for the lazy maintenance sweep (no cron triggers on this deployment).
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT;
-- Short-lived cache for the operator report, the one read whose cost grows with total history. Rebuilt at most once per TTL.
CREATE TABLE IF NOT EXISTS report_cache (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body))) STRICT;
