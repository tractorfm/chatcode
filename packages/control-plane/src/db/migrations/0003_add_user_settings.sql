CREATE TABLE IF NOT EXISTS user_settings (
  user_id           TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences_json  TEXT    NOT NULL,
  updated_at        INTEGER NOT NULL
);
