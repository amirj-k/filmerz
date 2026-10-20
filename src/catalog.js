'use strict';

/**
 * Read queries for the public site. All values are bound parameters;
 * the only dynamic fragment is ORDER BY, which comes from the SORTS
 * whitelist — never from user input.
 */

const SORTS = {
  newest: 'last_link_at DESC, id DESC',
  oldest: 'last_link_at ASC, id ASC',
  year: 'year DESC, id DESC',
  year_asc: 'year ASC, id ASC',
  title: 'title_en_norm ASC',
};

const CARD_FIELDS = `m.id, m.slug, m.title_en, m.title_fa, m.year, m.poster_url, m.poster_valid,
  m.quality_res, m.quality_codec, m.hardsub, m.censored, m.part_count, m.link_count, m.last_link_at`;

function sortSql(sort) {
  return SORTS[sort] || SORTS.newest;
}

function homeData(db) {
  const featured = db.prepare(
    `SELECT ${CARD_FIELDS} FROM movies m WHERE m.featured = 1 AND m.published = 1 ORDER BY m.id DESC LIMIT 6`
  ).all();
  const newest = db.prepare(
    `SELECT ${CARD_FIELDS} FROM movies m WHERE m.published = 1 ORDER BY m.last_link_at DESC, m.id DESC LIMIT 14`
  ).all();
  const suggested = db.prepare(
    `SELECT ${CARD_FIELDS} FROM movies m WHERE m.published = 1 ORDER BY RANDOM() LIMIT 14`
  ).all();
  const topGenres = db.prepare(
    `SELECT g.id, g.name, g.slug, COUNT(*) AS c
       FROM genres g
       JOIN movie_genres mg ON mg.genre_id = g.id
       JOIN movies m ON m.id = mg.movie_id AND m.published = 1
      GROUP BY g.id ORDER BY c DESC LIMIT 3`
  ).all();
  const genreRows = topGenres.map((g) => ({
    genre: g,
    movies: db.prepare(
      `SELECT ${CARD_FIELDS} FROM movies m
        JOIN movie_genres mg ON mg.movie_id = m.id
       WHERE mg.genre_id = ? AND m.published = 1
       ORDER BY m.id DESC LIMIT 14`
    ).all(g.id),
  }));
  const yearChips = db.prepare(
    `SELECT year, COUNT(*) AS c FROM movies WHERE published = 1 AND year IS NOT NULL
      GROUP BY year ORDER BY year DESC LIMIT 12`
  ).all();
  return { featured, newest, suggested, genreRows, yearChips };
}

function browseMovies(db, { genre, year, country, person, sort, page, perPage }) {
  const where = ['m.published = 1'];
  const params = [];
  if (genre) {
    where.push('EXISTS (SELECT 1 FROM movie_genres mg JOIN genres g ON g.id = mg.genre_id WHERE mg.movie_id = m.id AND g.slug = ?)');
    params.push(String(genre));
  }
  if (year !== undefined && year !== null && year !== '') {
    const y = parseInt(year, 10);
    if (Number.isFinite(y)) { where.push('m.year = ?'); params.push(y); }
  }
  if (country) {
    where.push('m.country_id = (SELECT id FROM countries WHERE slug = ?)');
    params.push(String(country));
  }
  if (person) {
    const p = parseInt(person, 10);
    if (Number.isFinite(p)) { where.push('EXISTS (SELECT 1 FROM movie_people mp WHERE mp.movie_id = m.id AND mp.person_id = ?)'); params.push(p); }
  }
  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS c FROM movies m WHERE ${whereSql}`).get(...params).c;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const cur = Math.min(Math.max(1, parseInt(page, 10) || 1), pages);
  const items = db.prepare(
    `SELECT ${CARD_FIELDS} FROM movies m WHERE ${whereSql}
      ORDER BY ${sortSql(sort)} LIMIT ? OFFSET ?`
  ).all(...params, perPage, (cur - 1) * perPage);
  return { items, total, page: cur, pages, perPage };
}

function searchMovies(db, q, page, perPage) {
  const { ftsQuery, escapeLike } = require('./queries');
  const normQ = (q || '').trim();
  if (!normQ) return { items: [], total: 0, page: 1, pages: 1 };
  const match = ftsQuery(normQ);
  let sql;
  let params;
  if (match) {
    sql = `SELECT ${CARD_FIELDS} FROM movies_fts f JOIN movies m ON m.id = f.movie_id
            WHERE movies_fts MATCH ? AND m.published = 1`;
    params = [match];
  } else {
    const like = `%${escapeLike(normQ)}%`;
    sql = `SELECT ${CARD_FIELDS} FROM movies m
            WHERE m.published = 1 AND (m.title_fa_norm LIKE ? ESCAPE '\\' OR m.title_en_norm LIKE ? ESCAPE '\\')`;
    params = [like, like];
  }
  const total = db.prepare(`SELECT COUNT(*) AS c FROM (${sql})`).get(...params).c;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const cur = Math.min(Math.max(1, parseInt(page, 10) || 1), pages);
  const items = db.prepare(`${sql} ORDER BY m.last_link_at DESC, m.id DESC LIMIT ? OFFSET ?`)
    .all(...params, perPage, (cur - 1) * perPage);
  return { items, total, page: cur, pages };
}

function suggest(db, q, limit = 8) {
  const { escapeLike } = require('./queries');
  const normQ = (q || '').trim();
  if (normQ.length < 2) return [];
  const like = `%${escapeLike(normQ)}%`;
  return db.prepare(
    `SELECT ${CARD_FIELDS} FROM movies m
      WHERE m.published = 1 AND (m.title_fa_norm LIKE ? ESCAPE '\\' OR m.title_en_norm LIKE ? ESCAPE '\\')
      ORDER BY m.last_link_at DESC, m.id DESC LIMIT ?`
  ).all(like, like, limit);
}

function getMovieFull(db, id) {
  const movie = db.prepare(
    `SELECT m.*, c.name AS country_name, c.slug AS country_slug
       FROM movies m LEFT JOIN countries c ON c.id = m.country_id
      WHERE m.id = ?`
  ).get(id);
  if (!movie) return null;
  movie.genres = db.prepare(
    'SELECT g.id, g.name, g.slug FROM genres g JOIN movie_genres mg ON mg.genre_id = g.id WHERE mg.movie_id = ? ORDER BY g.name'
  ).all(id);
  movie.directors = db.prepare(
    "SELECT p.id, p.name FROM people p JOIN movie_people mp ON mp.person_id = p.id WHERE mp.movie_id = ? AND mp.role = 'director'"
  ).all(id);
  movie.actors = db.prepare(
    "SELECT p.id, p.name FROM people p JOIN movie_people mp ON mp.person_id = p.id WHERE mp.movie_id = ? AND mp.role = 'actor' LIMIT 20"
  ).all(id);
  movie.writers = db.prepare(
    "SELECT p.id, p.name FROM people p JOIN movie_people mp ON mp.person_id = p.id WHERE mp.movie_id = ? AND mp.role = 'writer'"
  ).all(id);
  movie.links = db.prepare(
    'SELECT id, url, play_url, quality_text, part, extension, scraped_at FROM links WHERE movie_id = ? ORDER BY (part = 0) DESC, part ASC, id DESC'
  ).all(id);
  return movie;
}

function similarMovies(db, id, limit = 8) {
  return db.prepare(
    `SELECT ${CARD_FIELDS}, COUNT(*) AS shared
       FROM movie_genres mg1
       JOIN movie_genres mg2 ON mg2.genre_id = mg1.genre_id AND mg2.movie_id != mg1.movie_id
       JOIN movies m ON m.id = mg2.movie_id AND m.published = 1
      WHERE mg1.movie_id = ?
      GROUP BY m.id ORDER BY shared DESC, m.id DESC LIMIT ?`
  ).all(id, limit);
}

/** Best link row for the resolver: prefer one with play_url, then main part. */
function bestLinkForMovie(db, movieId) {
  return db.prepare(
    `SELECT * FROM links WHERE movie_id = ?
      ORDER BY (play_url != '') DESC, (part = 0) DESC, part ASC, id DESC LIMIT 1`
  ).get(movieId);
}

/** Check a play_url actually belongs to a row in our DB (SSRF guard). */
function playUrlExists(db, playUrl) {
  return Boolean(db.prepare('SELECT id FROM links WHERE play_url = ? LIMIT 1').get(playUrl));
}

function genreList(db) {
  return db.prepare(
    `SELECT g.id, g.name, g.slug, COUNT(mg.movie_id) AS c
       FROM genres g LEFT JOIN movie_genres mg ON mg.genre_id = g.id
      GROUP BY g.id HAVING c > 0 ORDER BY g.name`
  ).all();
}

function yearList(db) {
  return db.prepare(
    'SELECT year, COUNT(*) AS c FROM movies WHERE published = 1 AND year IS NOT NULL GROUP BY year ORDER BY year DESC'
  ).all();
}

module.exports = {
  SORTS,
  sortSql,
  CARD_FIELDS,
  homeData,
  browseMovies,
  searchMovies,
  suggest,
  getMovieFull,
  similarMovies,
  bestLinkForMovie,
  playUrlExists,
  genreList,
  yearList,
};

