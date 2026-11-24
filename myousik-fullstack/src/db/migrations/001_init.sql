-- 001_init.sql — initial schema for Myousik 2.0
-- Timestamps for user-facing rows are ISO-8601 UTC strings; session expiry is
-- stored as integer milliseconds so it can be compared with Date.now().

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,          -- hex scrypt output
  password_salt TEXT    NOT NULL,          -- hex, 16 random bytes per user
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
  id         TEXT    PRIMARY KEY,          -- SHA-256 of the cookie token (never the raw token)
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user    ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE songs (
  id           INTEGER PRIMARY KEY,
  title        TEXT    NOT NULL,
  artist       TEXT    NOT NULL,
  album        TEXT,
  genre        TEXT,
  duration_sec INTEGER NOT NULL CHECK (duration_sec > 0),
  year         INTEGER,
  cover_url    TEXT,
  audio_url    TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_songs_title  ON songs(title COLLATE NOCASE);
CREATE INDEX idx_songs_artist ON songs(artist COLLATE NOCASE);

CREATE TABLE playlists (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  description TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_playlists_user ON playlists(user_id);

-- Join table: which songs are in which playlist, and in what order.
-- A song can appear once per playlist (composite primary key).
CREATE TABLE playlist_songs (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  song_id     INTEGER NOT NULL REFERENCES songs(id)     ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  added_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (playlist_id, song_id)
);
CREATE INDEX idx_playlist_songs_order ON playlist_songs(playlist_id, position);
CREATE INDEX idx_playlist_songs_song  ON playlist_songs(song_id);

CREATE TABLE feedback (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  email      TEXT    NOT NULL,
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 3),
  comments   TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
