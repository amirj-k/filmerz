'use strict';
const { normSearch, slugify } = require('./normalizer');

/**
 * Write-side helpers + FTS sync. All SQL uses positional `?` parameters —
 * never string-concatenated with user input.
 */

/* ------------------------------------------------------------------ *
 * FTS helpers
 * ------------------------------------------------------------------ */

function syncMovieFts(db, movieId) {
  const m = db.prepare('SELECT * FROM movies WHERE id = ?').get(movieId);
  if (!m) return;
  const genres = db.prepare(
    'SELECT g.name FROM genres g JOIN movie_genres mg ON mg.genre_id = g.id WHERE mg.movie_id = ? ORDER BY g.name'
  ).all(movieId).map((r) => r.name).join(' ');
  const people = db.prepare(
    'SELECT p.name FROM people p JOIN movie_people mp ON mp.person_id = p.id WHERE mp.movie_id = ?'
  ).all(movieId).map((r) => r.name).join(' ');
  const fa = [m.title_fa, m.alt_titles].filter(Boolean).map(normSearch).join(' ');
  const en = normSearch(m.title_en);
  db.prepare('DELETE FROM movies_fts WHERE movie_id = ?').run(movieId);
  db.prepare('INSERT INTO movies_fts (movie_id, fa, en, people, genres, plot) VALUES (?, ?, ?, ?, ?, ?)')
    .run(movieId, fa, en, normSearch(people), normSearch(genres), normSearch(m.plot));
}

function deleteMovieFts(db, movieId) {
  db.prepare('DELETE FROM movies_fts WHERE movie_id = ?').run(movieId);
}

function syncSeriesFts(db, seriesId) {
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
  if (!s) return;
  const genres = db.prepare(
    'SELECT g.name FROM genres g JOIN series_genres sg ON sg.genre_id = g.id WHERE sg.series_id = ? ORDER BY g.name'
  ).all(seriesId).map((r) => r.name).join(' ');
  const people = db.prepare(
    'SELECT p.name FROM people p JOIN series_people sp ON sp.person_id = p.id WHERE sp.series_id = ?'
  ).all(seriesId).map((r) => r.name).join(' ');
  db.prepare('DELETE FROM series_fts WHERE series_id = ?').run(seriesId);
  db.prepare('INSERT INTO series_fts (series_id, fa, en, people, genres, plot) VALUES (?, ?, ?, ?, ?, ?)')
    .run(seriesId, normSearch(s.title_fa), normSearch(s.title_en), normSearch(people), normSearch(genres), normSearch(s.plot));
}

/** Build an FTS MATCH query from free user input (all words ANDed). */
function ftsQuery(q) {
  const words = normSearch(q).split(' ').filter((w) => w.length >= 3).slice(0, 6);
  if (!words.length) return null;
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' ');
}

function escapeLike(q) {
  return normSearch(q).replace(/[%_\\]/g, (c) => '\\' + c);
}

/* ------------------------------------------------------------------ *
 * Reference data (genres / countries / people)
 * ------------------------------------------------------------------ */

function getOrCreateGenre(db, name) {
  const name_ = String(name || '').trim();
  if (!name_) return null;
  const norm = normSearch(name_);
  db.prepare('INSERT OR IGNORE INTO genres (name, slug, name_norm) VALUES (?, ?, ?)')
    .run(name_, slugify(name_), norm);
  let row = db.prepare('SELECT id FROM genres WHERE name = ?').get(name_)
    || db.prepare('SELECT id FROM genres WHERE name_norm = ?').get(norm);
  if (!row) {
    // Slug collided with a different label (ZWNJ vs space folds the same) — uniquify.
    const base = slugify(name_);
    let s2 = base;
    let i = 2;
    while (db.prepare('SELECT 1 FROM genres WHERE slug = ?').get(s2)) s2 = `${base}-${i++}`;
    db.prepare('INSERT INTO genres (name, slug, name_norm) VALUES (?, ?, ?)').run(name_, s2, norm);
    row = db.prepare('SELECT id FROM genres WHERE name = ?').get(name_);
  }
  return row;
}

function getOrCreateCountry(db, name) {
  const name_ = String(name || '').trim();
  if (!name_) return null;
  const norm = normSearch(name_);
  db.prepare('INSERT OR IGNORE INTO countries (name, slug, name_norm) VALUES (?, ?, ?)')
    .run(name_, slugify(name_), norm);
  let row = db.prepare('SELECT id FROM countries WHERE name = ?').get(name_)
    || db.prepare('SELECT id FROM countries WHERE name_norm = ?').get(norm);
  if (!row) {
    const base = slugify(name_);
    let s2 = base;
    let i = 2;
    while (db.prepare('SELECT 1 FROM countries WHERE slug = ?').get(s2)) s2 = `${base}-${i++}`;
    db.prepare('INSERT INTO countries (name, slug, name_norm) VALUES (?, ?, ?)').run(name_, s2, norm);
    row = db.prepare('SELECT id FROM countries WHERE name = ?').get(name_);
  }
  return row;
}

function getOrCreatePerson(db, name) {
  const name_ = String(name || '').trim();
  if (!name_) return null;
  const norm = normSearch(name_);
  db.prepare('INSERT OR IGNORE INTO people (name, slug, name_norm) VALUES (?, ?, ?)')
    .run(name_, slugify(name_), norm);
  let row = db.prepare('SELECT id FROM people WHERE name = ?').get(name_)
    || db.prepare('SELECT id FROM people WHERE name_norm = ?').get(norm);
  if (!row) {
    const base = slugify(name_);
    let s2 = base;
    let i = 2;
    while (db.prepare('SELECT 1 FROM people WHERE slug = ?').get(s2)) s2 = `${base}-${i++}`;
    db.prepare('INSERT INTO people (name, slug, name_norm) VALUES (?, ?, ?)').run(name_, s2, norm);
    row = db.prepare('SELECT id FROM people WHERE name = ?').get(name_);
  }
  return row;
}

/* ------------------------------------------------------------------ *
 * Movie write helpers used by the importer and admin
 * ------------------------------------------------------------------ */

function movieSlug(titleEn, titleFa, id) {
  const base = slugify(titleEn || titleFa || 'movie').slice(0, 60).replace(/-+$/, '') || 'movie';
  return `${base}-${id}`;
}

function setMovieGenres(db, movieId, genreNames) {
  db.prepare('DELETE FROM movie_genres WHERE movie_id = ?').run(movieId);
  for (const name of genreNames || []) {
    const g = getOrCreateGenre(db, name);
    if (g) db.prepare('INSERT OR IGNORE INTO movie_genres (movie_id, genre_id) VALUES (?, ?)').run(movieId, g.id);
  }
}

function setMoviePeople(db, movieId, role, names) {
  db.prepare('DELETE FROM movie_people WHERE movie_id = ? AND role = ?').run(movieId, role);
  for (const name of names || []) {
    const p = getOrCreatePerson(db, name);
    if (p) db.prepare('INSERT OR IGNORE INTO movie_people (movie_id, person_id, role) VALUES (?, ?, ?)')
      .run(movieId, p.id, role);
  }
}

function recomputeMovieCounts(db, movieId) {
  db.prepare(`UPDATE movies SET
      link_count = (SELECT COUNT(*) FROM links WHERE movie_id = ?),
      part_count = (SELECT COUNT(DISTINCT part) FROM links WHERE movie_id = ? AND part > 0)
    WHERE id = ?`).run(movieId, movieId, movieId);
}

function setSeriesGenres(db, seriesId, genreNames) {
  db.prepare('DELETE FROM series_genres WHERE series_id = ?').run(seriesId);
  for (const name of genreNames || []) {
    const g = getOrCreateGenre(db, name);
    if (g) db.prepare('INSERT OR IGNORE INTO series_genres (series_id, genre_id) VALUES (?, ?)').run(seriesId, g.id);
  }
}

function setSeriesPeople(db, seriesId, role, names) {
  db.prepare('DELETE FROM series_people WHERE series_id = ? AND role = ?').run(seriesId, role);
  for (const name of names || []) {
    const p = getOrCreatePerson(db, name);
    if (p) db.prepare('INSERT OR IGNORE INTO series_people (series_id, person_id, role) VALUES (?, ?, ?)')
      .run(seriesId, p.id, role);
  }
}

function recomputeSeriesCounts(db, seriesId) {
  db.prepare(`UPDATE series SET
      season_count  = (SELECT COUNT(*) FROM seasons WHERE series_id = ?),
      episode_count = (SELECT COUNT(*) FROM episodes WHERE series_id = ?),
      link_count    = (SELECT COUNT(*) FROM episode_links WHERE series_id = ?)
    WHERE id = ?`).run(seriesId, seriesId, seriesId, seriesId);
}

/* ------------------------------------------------------------------ *
 * Admin-side movie writes
 * ------------------------------------------------------------------ */

function insertMovie(db, d) {
  const tmpSlug = 'tmp-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const info = db.prepare(
    `INSERT INTO movies (slug, title_en, title_en_norm, title_fa, title_fa_norm,
       alt_titles, year, age_rating, poster_url, plot, published, featured)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`
  ).run(tmpSlug, d.title_en, normSearch(d.title_en), d.title_fa, normSearch(d.title_fa),
    d.other_titles || '', d.year, d.age_rating || '', d.poster_url || '', d.plot || '');
  const id = Number(info.lastInsertRowid);
  db.prepare('UPDATE movies SET slug = ? WHERE id = ?').run(movieSlug(d.title_en, d.title_fa, id), id);
  return id;
}

function updateMovie(db, id, d) {
  db.prepare(
    `UPDATE movies SET title_en = ?, title_en_norm = ?, title_fa = ?, title_fa_norm = ?,
       alt_titles = ?, year = ?, age_rating = ?, poster_url = ?, plot = ?
     WHERE id = ?`
  ).run(d.title_en, normSearch(d.title_en), d.title_fa, normSearch(d.title_fa),
    d.other_titles || '', d.year, d.age_rating || '', d.poster_url || '', d.plot || '', id);
  db.prepare('UPDATE movies SET slug = ? WHERE id = ?').run(movieSlug(d.title_en, d.title_fa, id), id);
  return id;
}

function setMoviePublished(db, movieId, published) {
  db.prepare('UPDATE movies SET published = ? WHERE id = ?').run(published ? 1 : 0, movieId);
}

function setMovieFeatured(db, movieId, featured) {
  db.prepare('UPDATE movies SET featured = ? WHERE id = ?').run(featured ? 1 : 0, movieId);
}

/** Merge duplicate movie `dupId` into `keepId`; returns moved link count. */
function mergeMovies(db, keepId, dupId) {
  const keep = db.prepare('SELECT id FROM movies WHERE id = ?').get(keepId);
  const dup = db.prepare('SELECT id FROM movies WHERE id = ?').get(dupId);
  if (!keep || !dup) throw new Error('فیلمی با این شناسه وجود ندارد.');
  const moved = db.prepare('SELECT COUNT(*) AS c FROM links WHERE movie_id = ?').get(dupId).c;
  db.transaction(() => {
    db.prepare('UPDATE links SET movie_id = ? WHERE movie_id = ?').run(keepId, dupId);
    db.prepare('INSERT OR IGNORE INTO movie_genres (movie_id, genre_id) SELECT ?, genre_id FROM movie_genres WHERE movie_id = ?').run(keepId, dupId);
    db.prepare('INSERT OR IGNORE INTO movie_people (movie_id, person_id, role) SELECT ?, person_id, role FROM movie_people WHERE movie_id = ?').run(keepId, dupId);
    const k = db.prepare('SELECT * FROM movies WHERE id = ?').get(keepId);
    const d = db.prepare('SELECT * FROM movies WHERE id = ?').get(dupId);
    db.prepare('UPDATE movies SET plot = ?, poster_url = ?, poster_valid = ?, year = ?, alt_titles = ? WHERE id = ?')
      .run(
        k.plot || d.plot,
        k.poster_url || d.poster_url,
        k.poster_url ? k.poster_valid : d.poster_valid,
        k.year || d.year,
        [k.alt_titles, d.alt_titles].filter(Boolean).join(' | '),
        keepId,
      );
    deleteMovieFts(db, dupId);
    db.prepare('DELETE FROM movies WHERE id = ?').run(dupId);
    syncMovieFts(db, keepId);
    recomputeMovieCounts(db, keepId);
  })();
  return moved;
}

/** Admin search across published AND unpublished movies. */
function adminSearchMovies(db, q, page, perPage) {
  const like = `%${escapeLike(q)}%`;
  const idq = parseInt(q, 10);
  const byId = Number.isFinite(idq) && idq > 0;
  const where = byId
    ? "(m.title_fa_norm LIKE ? ESCAPE '\\' OR m.title_en_norm LIKE ? ESCAPE '\\' OR m.id = ?)"
    : "(m.title_fa_norm LIKE ? ESCAPE '\\' OR m.title_en_norm LIKE ? ESCAPE '\\')";
  const params = byId ? [like, like, idq] : [like, like];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM movies m WHERE ${where}`).get(...params).c;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const cur = Math.min(Math.max(1, page || 1), pages);
  const items = db.prepare(
    `SELECT m.id, m.slug, m.title_en, m.title_fa, m.year, m.published, m.featured,
            m.link_count, m.poster_url, m.poster_valid
       FROM movies m WHERE ${where}
      ORDER BY m.id DESC LIMIT ? OFFSET ?`
  ).all(...params, perPage, (cur - 1) * perPage);
  return { items, total, page: cur, pages };
}

module.exports = {
  syncMovieFts,
  deleteMovieFts,
  syncSeriesFts,
  ftsQuery,
  escapeLike,
  getOrCreateGenre,
  getOrCreateCountry,
  getOrCreatePerson,
  movieSlug,
  setMovieGenres,
  setMoviePeople,
  recomputeMovieCounts,
  setSeriesGenres,
  setSeriesPeople,
  recomputeSeriesCounts,
  insertMovie,
  updateMovie,
  setMoviePublished,
  setMovieFeatured,
  mergeMovies,
  adminSearchMovies,
};
