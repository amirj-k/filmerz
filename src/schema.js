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
`;

function applySchema(db) {
  db.exec(SCHEMA_SQL);
  ensureColumn(db, 'movies', 'series_key TEXT NOT NULL DEFAULT \'\'');
  ensureColumn(db, 'movies', 'episode_no INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_movies_series ON movies(series_key, episode_no)');
}

/** Add `colDef` ("name TYPE ...") to `table` when the column is missing. */
function ensureColumn(db, table, colDef) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const name = colDef.split(/\s+/)[0];
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef};`);
}

module.exports = { applySchema, SCHEMA_SQL };
