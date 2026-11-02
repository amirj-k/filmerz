'use strict';

/**
 * Application database schema (normalized, built from links.db).
 * Every statement is CREATE IF NOT EXISTS → applying is idempotent.
 */

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS countries (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  slug      TEXT NOT NULL UNIQUE,
  name_norm TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS genres (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  slug      TEXT NOT NULL UNIQUE,
  name_norm TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  slug      TEXT NOT NULL UNIQUE,
  name_norm TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS movies (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  source_page   INTEGER UNIQUE,
  title_en      TEXT NOT NULL DEFAULT '',
  title_fa      TEXT NOT NULL DEFAULT '',
  title_en_norm TEXT NOT NULL DEFAULT '',
  title_fa_norm TEXT NOT NULL DEFAULT '',
  alt_titles    TEXT NOT NULL DEFAULT '',
  year          INTEGER,
  country_id    INTEGER REFERENCES countries(id),
  plot          TEXT NOT NULL DEFAULT '',
  poster_url    TEXT NOT NULL DEFAULT '',
  poster_valid  INTEGER NOT NULL DEFAULT 0,
  age_rating    TEXT NOT NULL DEFAULT '',
  quality_res   TEXT NOT NULL DEFAULT '',
  quality_codec TEXT NOT NULL DEFAULT '',
  hardsub       INTEGER NOT NULL DEFAULT 0,
  censored      INTEGER NOT NULL DEFAULT 0,
  part_count    INTEGER NOT NULL DEFAULT 0,
  link_count    INTEGER NOT NULL DEFAULT 0,
  published     INTEGER NOT NULL DEFAULT 1,
  featured      INTEGER NOT NULL DEFAULT 0,
  first_seen    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen     TEXT NOT NULL DEFAULT (datetime('now')),
  last_link_at  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_movies_pub_id      ON movies(published, id DESC);
CREATE INDEX IF NOT EXISTS idx_movies_pub_year    ON movies(published, year DESC);
CREATE INDEX IF NOT EXISTS idx_movies_pub_country ON movies(published, country_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_movies_featured    ON movies(featured, published);
CREATE INDEX IF NOT EXISTS idx_movies_fa_norm     ON movies(title_fa_norm);
CREATE INDEX IF NOT EXISTS idx_movies_en_norm     ON movies(title_en_norm);

CREATE TABLE IF NOT EXISTS movie_genres (
  movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (movie_id, genre_id)
);
CREATE INDEX IF NOT EXISTS idx_movie_genres_genre ON movie_genres(genre_id);

CREATE TABLE IF NOT EXISTS movie_people (
  movie_id  INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('director','actor','writer')),
  PRIMARY KEY (movie_id, person_id, role)
);
CREATE INDEX IF NOT EXISTS idx_movie_people_person ON movie_people(person_id);
CREATE INDEX IF NOT EXISTS idx_movie_people_movie  ON movie_people(movie_id, role);

CREATE TABLE IF NOT EXISTS links (
  id            INTEGER PRIMARY KEY,
  movie_id      INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  source_row_id INTEGER UNIQUE,
  url           TEXT NOT NULL,
  play_url      TEXT NOT NULL DEFAULT '',
  quality_text  TEXT NOT NULL DEFAULT '',
  part          INTEGER NOT NULL DEFAULT 0,
  extension     TEXT NOT NULL DEFAULT '',
  scraped_at    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_links_movie ON links(movie_id);

CREATE VIRTUAL TABLE IF NOT EXISTS movies_fts USING fts5 (
  movie_id UNINDEXED,
  fa,
  en,
  people,
  genres,
  plot,
  tokenize = 'trigram'
);

/* ------------------------------------------------------------------ *
 * Real series (kind = 'series' in the crawl) — NOT sequel franchises.
 * links.db groups every episode link by page + season + episode.
 * ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS series (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  source_page  INTEGER UNIQUE,
  title_en     TEXT NOT NULL DEFAULT '',
  title_fa     TEXT NOT NULL DEFAULT '',
  title_en_norm TEXT NOT NULL DEFAULT '',
  title_fa_norm TEXT NOT NULL DEFAULT '',
  year         INTEGER,
  country_id   INTEGER REFERENCES countries(id),
  plot         TEXT NOT NULL DEFAULT '',
  poster_url   TEXT NOT NULL DEFAULT '',
  poster_valid INTEGER NOT NULL DEFAULT 0,
  age_rating   TEXT NOT NULL DEFAULT '',
  status_text  TEXT NOT NULL DEFAULT '',
  quality_res  TEXT NOT NULL DEFAULT '',
  published    INTEGER NOT NULL DEFAULT 1,
  featured     INTEGER NOT NULL DEFAULT 0,
  season_count INTEGER NOT NULL DEFAULT 0,
  episode_count INTEGER NOT NULL DEFAULT 0,
  link_count   INTEGER NOT NULL DEFAULT 0,
  first_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen    TEXT NOT NULL DEFAULT (datetime('now')),
  last_link_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_series_pub_id       ON series(published, id DESC);
CREATE INDEX IF NOT EXISTS idx_series_pub_year     ON series(published, year DESC);
CREATE INDEX IF NOT EXISTS idx_series_pub_country  ON series(published, country_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_series_featured     ON series(featured, published);
CREATE INDEX IF NOT EXISTS idx_series_fa_norm      ON series(title_fa_norm);
CREATE INDEX IF NOT EXISTS idx_series_en_norm      ON series(title_en_norm);

CREATE TABLE IF NOT EXISTS series_genres (
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  genre_id  INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (series_id, genre_id)
);
CREATE INDEX IF NOT EXISTS idx_series_genres_genre ON series_genres(genre_id);

CREATE TABLE IF NOT EXISTS series_people (
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('director','actor','writer')),
  PRIMARY KEY (series_id, person_id, role)
);
CREATE INDEX IF NOT EXISTS idx_series_people_person ON series_people(person_id);
CREATE INDEX IF NOT EXISTS idx_series_people_series ON series_people(series_id, role);

CREATE TABLE IF NOT EXISTS seasons (
  id            INTEGER PRIMARY KEY,
  series_id     INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  season_no     INTEGER NOT NULL,
  episode_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (series_id, season_no)
);
CREATE INDEX IF NOT EXISTS idx_seasons_series ON seasons(series_id, season_no);

CREATE TABLE IF NOT EXISTS episodes (
  id         INTEGER PRIMARY KEY,
  series_id  INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  season_id  INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  season_no  INTEGER NOT NULL,
  episode_no INTEGER NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  link_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (series_id, season_no, episode_no)
);
CREATE INDEX IF NOT EXISTS idx_episodes_season ON episodes(season_id, episode_no);
CREATE INDEX IF NOT EXISTS idx_episodes_series ON episodes(series_id, season_no, episode_no);

CREATE TABLE IF NOT EXISTS episode_links (
  id           INTEGER PRIMARY KEY,
  episode_id   INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  series_id    INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  source_row_id INTEGER UNIQUE,
  url          TEXT NOT NULL,
  play_url     TEXT NOT NULL DEFAULT '',
  quality_text TEXT NOT NULL DEFAULT '',
  quality_res  TEXT NOT NULL DEFAULT '',
  extension    TEXT NOT NULL DEFAULT '',
  scraped_at   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_episode_links_episode ON episode_links(episode_id);
CREATE INDEX IF NOT EXISTS idx_episode_links_series  ON episode_links(series_id);

CREATE VIRTUAL TABLE IF NOT EXISTS series_fts USING fts5 (
  series_id UNINDEXED,
  fa,
  en,
  people,
  genres,
  plot,
  tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS wishlist_items (
  id         INTEGER PRIMARY KEY,
  owner_key  TEXT NOT NULL,
  item_type  TEXT NOT NULL CHECK (item_type IN ('movie','series')),
  item_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_key, item_type, item_id)
);
CREATE INDEX IF NOT EXISTS idx_wishlist_owner ON wishlist_items(owner_key, id DESC);

CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

/* ------------------------------------------------------------------ *
 * Accounts & authentication (added on top of the catalog schema).
 * Everything here is CREATE IF NOT EXISTS, so it is a safe, repeatable,
 * non-destructive migration: catalog data is never touched.
 * ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,          -- normalised (trim + lowercase)
  email_original    TEXT NOT NULL DEFAULT '',      -- as the user typed it
  password_hash     TEXT NOT NULL DEFAULT '',      -- empty for Google-only accounts
  display_name      TEXT NOT NULL,
  avatar_url        TEXT NOT NULL DEFAULT '',
  role              TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  email_verified_at TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_login_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at DESC);

-- Opaque server-side session tokens. Only the SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS user_sessions (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_exp  ON user_sessions(expires_at);

-- Admin sessions (kept separate from account sessions, same safety rules).
CREATE TABLE IF NOT EXISTS admin_sessions (
  id           INTEGER PRIMARY KEY,
  admin_id     INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_exp   ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_verify_user ON email_verification_tokens(user_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);

-- One shared polymorphic list design for both content kinds. Item existence
-- and publication are validated in the application layer; user_id cascades.
CREATE TABLE IF NOT EXISTS user_favorites (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type  TEXT NOT NULL CHECK (item_type IN ('movie','series')),
  item_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, item_type, item_id)
);
CREATE INDEX IF NOT EXISTS idx_user_favorites_user ON user_favorites(user_id, id DESC);

CREATE TABLE IF NOT EXISTS user_watchlist (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type  TEXT NOT NULL CHECK (item_type IN ('movie','series')),
  item_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, item_type, item_id)
);
CREATE INDEX IF NOT EXISTS idx_user_watchlist_user ON user_watchlist(user_id, id DESC);

CREATE TABLE IF NOT EXISTS user_watch_history (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type        TEXT NOT NULL CHECK (item_type IN ('movie','series')),
  item_id          INTEGER NOT NULL,
  episode_id       INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
  last_watched_at  TEXT NOT NULL,
  progress_seconds REAL,
  duration_seconds REAL,
  watch_count      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (user_id, item_type, item_id, episode_id)
);
CREATE INDEX IF NOT EXISTS idx_user_history_user ON user_watch_history(user_id, last_watched_at DESC);
-- NULL episode_id (movies) must still be unique per user/item.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_history_unique
  ON user_watch_history(user_id, item_type, item_id, COALESCE(episode_id, 0));

-- External identities (Google). Identity is keyed on provider + subject,
-- never on the mutable email address.
CREATE TABLE IF NOT EXISTS user_identities (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  email            TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  UNIQUE (provider, provider_subject)
);
CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id, provider);

-- Short-lived, one-time OAuth state (CSRF) + nonce + PKCE verifier.
CREATE TABLE IF NOT EXISTS oauth_states (
  id             INTEGER PRIMARY KEY,
  state_hash     TEXT NOT NULL UNIQUE,
  nonce          TEXT NOT NULL,
  code_verifier  TEXT NOT NULL,
  redirect_after TEXT NOT NULL DEFAULT '',
  link_user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  used_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_exp ON oauth_states(expires_at);
`;

function applySchema(db) {
  db.exec(SCHEMA_SQL);
  ensureColumn(db, 'movies', 'series_key TEXT NOT NULL DEFAULT \'\'');
  ensureColumn(db, 'movies', 'episode_no INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_movies_series ON movies(series_key, episode_no)');
  try {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', '2') " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run();
  } catch {
    /* meta is part of the schema above; never fail the boot over this. */
  }
}

/** Add `colDef` ("name TYPE ...") to `table` when the column is missing. */
function ensureColumn(db, table, colDef) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const name = colDef.split(/\s+/)[0];
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef};`);
}

module.exports = { applySchema, SCHEMA_SQL };
