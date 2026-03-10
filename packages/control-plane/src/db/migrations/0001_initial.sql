-- Users
CREATE TABLE users (
  id         TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE email_identities (
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT    NOT NULL UNIQUE CHECK (email = lower(email)),
  verified_at INTEGER,
  PRIMARY KEY (user_id, email)
);

CREATE TABLE auth_identities (
  provider         TEXT    NOT NULL CHECK (provider IN ('email', 'google', 'github', 'digitalocean')),
  provider_user_id TEXT    NOT NULL,
  user_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_verified   INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_login_at    INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);

-- DigitalOcean OAuth tokens (one row per user).
-- access_token and refresh_token are AES-GCM encrypted at application layer
-- using DO_TOKEN_KEK wrangler secret. See lib/do-tokens.ts.
CREATE TABLE do_connections (
  user_id           TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token_enc  TEXT    NOT NULL,
  refresh_token_enc TEXT    NOT NULL,
  token_key_version INTEGER NOT NULL DEFAULT 1,
  team_uuid         TEXT,
  expires_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- VPS / Droplet records
CREATE TABLE vps (
  id                        TEXT    PRIMARY KEY,
  user_id                   TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  droplet_id                INTEGER NOT NULL,
  region                    TEXT    NOT NULL,
  size                      TEXT    NOT NULL,
  ipv4                      TEXT,
  status                    TEXT    NOT NULL DEFAULT 'provisioning',
  provisioning_deadline_at  INTEGER,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL
);

-- Gateway daemon records (one per VPS)
CREATE TABLE gateways (
  id              TEXT    PRIMARY KEY,
  vps_id          TEXT    NOT NULL REFERENCES vps(id) ON DELETE CASCADE,
  auth_token_hash TEXT    NOT NULL,
  version         TEXT,
  last_seen_at    INTEGER,
  connected       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

-- Sessions (tmux sessions)
CREATE TABLE sessions (
  id               TEXT    PRIMARY KEY,
  user_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vps_id           TEXT    NOT NULL REFERENCES vps(id) ON DELETE CASCADE,
  title            TEXT    NOT NULL,
  agent_type       TEXT    NOT NULL DEFAULT 'claude-code',
  workdir          TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'starting',
  created_at       INTEGER NOT NULL,
  last_activity_at INTEGER
);

-- Authorized SSH keys (no private keys stored)
CREATE TABLE authorized_keys (
  id          TEXT    PRIMARY KEY,
  vps_id      TEXT    NOT NULL REFERENCES vps(id) ON DELETE CASCADE,
  fingerprint TEXT    NOT NULL,
  public_key  TEXT    NOT NULL,
  label       TEXT    NOT NULL,
  key_type    TEXT    NOT NULL DEFAULT 'user',
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE (vps_id, fingerprint)
);

CREATE INDEX idx_sessions_vps  ON sessions(vps_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_vps_user      ON vps(user_id);
CREATE INDEX idx_auth_id_user  ON auth_identities(user_id);
