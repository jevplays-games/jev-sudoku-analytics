PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, avatar TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  csrf TEXT NOT NULL, context_json TEXT CHECK(context_json IS NULL OR json_valid(context_json)),
  telemetry_consent INTEGER NOT NULL DEFAULT 0 CHECK(telemetry_consent IN(0,1)), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS security_tokens (
  hash TEXT PRIMARY KEY, kind TEXT NOT NULL, session_hash TEXT, user_id TEXT, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  expires_at INTEGER NOT NULL, used_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY, utc_date TEXT NOT NULL, difficulty TEXT NOT NULL CHECK(difficulty IN('easy','normal','hard','jev')),
  givens TEXT NOT NULL CHECK(length(givens)=81 AND givens NOT GLOB '*[^0-9]*'), puzzle_hash TEXT NOT NULL,
  private_seed TEXT NOT NULL, config_json TEXT NOT NULL CHECK(json_valid(config_json)), created_at INTEGER NOT NULL,
  UNIQUE(utc_date,difficulty)
) STRICT;
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  challenge_id TEXT REFERENCES challenges(id), guild_id TEXT, channel_id TEXT,
  official INTEGER NOT NULL CHECK(official IN(0,1)), create_key TEXT NOT NULL,
  initial_json TEXT NOT NULL CHECK(json_valid(initial_json)), state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  status TEXT NOT NULL CHECK(status IN('ready','running','settling','finished')),
  created_at INTEGER NOT NULL, started_at INTEGER, deadline_at INTEGER,
  CHECK((guild_id IS NULL)=(channel_id IS NULL)), UNIQUE(owner_hash,create_key)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_official_attempt ON matches(user_id,challenge_id) WHERE official=1;
CREATE INDEX IF NOT EXISTS match_scope ON matches(challenge_id,guild_id,channel_id);
CREATE INDEX IF NOT EXISTS match_user ON matches(user_id,created_at);
CREATE INDEX IF NOT EXISTS match_status ON matches(status);
CREATE TABLE IF NOT EXISTS match_events (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE, sequence INTEGER NOT NULL,
  request_id TEXT NOT NULL, event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  previous_hash TEXT NOT NULL, resulting_hash TEXT NOT NULL,
  PRIMARY KEY(match_id,sequence), UNIQUE(match_id,request_id)
) STRICT;
CREATE TABLE IF NOT EXISTS results (
  match_id TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE, eligible INTEGER NOT NULL CHECK(eligible IN(0,1)),
  winner TEXT NOT NULL CHECK(winner IN('human','jev','draw','pending')), human_ms INTEGER, human_bucket INTEGER, jev_ms INTEGER,
  analytics_json TEXT NOT NULL CHECK(json_valid(analytics_json)), replay_hash TEXT NOT NULL, verified_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS result_rank ON results(eligible,human_bucket,match_id);
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY, match_id TEXT REFERENCES matches(id) ON DELETE CASCADE, name TEXT NOT NULL,
  trust TEXT NOT NULL CHECK(trust IN('server','client')), properties_json TEXT NOT NULL CHECK(json_valid(properties_json)),
  client_event_id TEXT, created_at INTEGER NOT NULL, UNIQUE(match_id,client_event_id)
) STRICT;
CREATE INDEX IF NOT EXISTS telemetry_match ON telemetry(match_id,id);
CREATE INDEX IF NOT EXISTS telemetry_age ON telemetry(created_at);
CREATE TABLE IF NOT EXISTS operations (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, properties_json TEXT NOT NULL CHECK(json_valid(properties_json)), created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS operations_age ON operations(created_at);
PRAGMA user_version=1;
