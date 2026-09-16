CREATE TABLE IF NOT EXISTS upstreams (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  api_key TEXT NOT NULL,
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS credentials (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  kind VARCHAR(32) NOT NULL CHECK(kind IN ('gotify','webhook')),
  secret VARCHAR(512) NOT NULL UNIQUE,
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS credential_bindings (
  credential_id INT NOT NULL,
  upstream_id INT NOT NULL,
  PRIMARY KEY (credential_id, upstream_id),
  CONSTRAINT fk_cb_credential FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE CASCADE,
  CONSTRAINT fk_cb_upstream FOREIGN KEY (upstream_id) REFERENCES upstreams(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  id_hash VARCHAR(128) PRIMARY KEY,
  expires_at VARCHAR(64) NOT NULL,
  created_at VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS login_attempts (
  ip VARCHAR(64) PRIMARY KEY,
  failed_count INT NOT NULL,
  first_failed_at VARCHAR(64) NOT NULL,
  locked_until VARCHAR(64)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notification_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
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
  handled_at VARCHAR(64),
  INDEX idx_history_created_at (created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS system_settings (
  `key` VARCHAR(128) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
