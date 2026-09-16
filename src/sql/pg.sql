CREATE TABLE IF NOT EXISTS upstreams (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  api_key TEXT NOT NULL,
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  kind VARCHAR(32) NOT NULL CHECK(kind IN ('gotify','webhook')),
  secret TEXT NOT NULL UNIQUE,
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS credential_bindings (
  credential_id INT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  upstream_id INT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  PRIMARY KEY (credential_id, upstream_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash VARCHAR(128) PRIMARY KEY,
  expires_at VARCHAR(64) NOT NULL,
  created_at VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip VARCHAR(64) PRIMARY KEY,
  failed_count INT NOT NULL,
  first_failed_at VARCHAR(64) NOT NULL,
  locked_until VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS notification_history (
  id SERIAL PRIMARY KEY,
  created_at VARCHAR(64) NOT NULL,
  source VARCHAR(64) NOT NULL,
  credential_id INT,
  upstream_id INT,
  status VARCHAR(64) NOT NULL,
  title TEXT,
  content TEXT,
  media_type VARCHAR(64),
  message_id VARCHAR(255),
  error TEXT,
  handled_at VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS idx_history_created_at ON notification_history(created_at DESC);

CREATE TABLE IF NOT EXISTS system_settings (
  key VARCHAR(128) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at VARCHAR(64) NOT NULL
);
