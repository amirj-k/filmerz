'use strict';

/**
 * Read-side catalog for real series (series → seasons → episodes → links).
 * All values are bound parameters; ORDER BY only comes from a whitelist.
 */

const SERIES_SORTS = {
  newest: 's.last_link_at DESC, s.id DESC',
  oldest: 's.last_link_at ASC, s.id ASC',
  year: 's.year DESC, s.id DESC',
  year_asc: 's.year ASC, s.id ASC',
  title: 's.title_en_norm ASC, s.id ASC',
  episodes: 's.episode_count DESC, s.id DESC',
};

const SERIES_CARD_FIELDS = `s.id, s.slug, s.title_en, s.title_fa, s.year, s.poster_url, s.poster_valid,
  s.season_count, s.episode_count, s.link_count, s.featured, s.quality_res, s.last_link_at`;

function seriesSortSql(sort) {
  return SERIES_SORTS[sort] || SERIES_SORTS.newest;
}

function resRank(res) {
  const n = parseInt(String(res || '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function sortLinks(links) {
  return links.sort((a, b) => {
    if (Boolean(a.play_url) !== Boolean(b.play_url)) return a.play_url ? -1 : 1;
    const r = resRank(b.quality_res) - resRank(a.quality_res);
    if (r) return r;
    return String(a.quality_text || '').localeCompare(String(b.quality_text || ''), 'fa') || b.id - a.id;
  });
}

function seriesList(db, { genre, year, country, sort, page, perPage } = {}) {
  const per = Math.max(1, parseInt(perPage, 10) || 24);
  const where = ['s.published = 1'];
  const params = [];
  if (genre) {
    where.push('EXISTS (SELECT 1 FROM series_genres sg JOIN genres g ON g.id = sg.genre_id WHERE sg.series_id = s.id AND g.slug = ?)');
    params.push(String(genre));
  }
  if (country) {
    where.push('s.country_id = (SELECT id FROM countries WHERE slug = ?)');
    params.push(String(country));
  }
  if (year !== undefined && year !== null && year !== '') {
    const y = parseInt(year, 10);
    if (Number.isFinite(y)) { where.push('s.year = ?'); params.push(y); }
  }
  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM series s WHERE ${whereSql}`).get(...params).c;
  const pages = Math.max(1, Math.ceil(total / per));
  const cur = Math.min(Math.max(1, parseInt(page, 10) || 1), pages);
  const items = db.prepare(
    `SELECT ${SERIES_CARD_FIELDS} FROM series s WHERE ${whereSql}
      ORDER BY ${seriesSortSql(sort)} LIMIT ? OFFSET ?`
  ).all(...params, per, (cur - 1) * per);
  return { items, total, page: cur, pages, perPage: per };
}

function searchSeries(db, q, page, perPage) {
  const { ftsQuery, escapeLike } = require('./queries');
  const normQ = String(q || '').trim();
  if (!normQ) return { items: [], total: 0, page: 1, pages: 1 };
  const per = Math.max(1, parseInt(perPage, 10) || 24);
  const match = ftsQuery(normQ);
  let sql;
  let params;
  if (match) {
    sql = `SELECT ${SERIES_CARD_FIELDS} FROM series_fts f JOIN series s ON s.id = f.series_id
            WHERE series_fts MATCH ? AND s.published = 1`;
    params = [match];
  } else {
    const like = `%${escapeLike(normQ)}%`;
    sql = `SELECT ${SERIES_CARD_FIELDS} FROM series s
            WHERE s.published = 1 AND (s.title_fa_norm LIKE ? ESCAPE '\\' OR s.title_en_norm LIKE ? ESCAPE '\\')`;
    params = [like, like];
  }
  const total = db.prepare(`SELECT COUNT(*) c FROM (${sql})`).get(...params).c;
  const pages = Math.max(1, Math.ceil(total / per));
  const cur = Math.min(Math.max(1, parseInt(page, 10) || 1), pages);
  const items = db.prepare(`${sql} ORDER BY s.last_link_at DESC, s.id DESC LIMIT ? OFFSET ?`)
    .all(...params, per, (cur - 1) * per);
  return { items, total, page: cur, pages };
}

function suggestSeries(db, q, limit = 6) {
  const { escapeLike } = require('./queries');
  const normQ = String(q || '').trim();
  if (normQ.length < 2) return [];
  const like = `%${escapeLike(normQ)}%`;
  return db.prepare(
    `SELECT ${SERIES_CARD_FIELDS} FROM series s
      WHERE s.published = 1 AND (s.title_fa_norm LIKE ? ESCAPE '\\' OR s.title_en_norm LIKE ? ESCAPE '\\')
      ORDER BY s.last_link_at DESC, s.id DESC LIMIT ?`
  ).all(like, like, limit);
}

function getSeriesFull(db, id) {
  const series = db.prepare(
    `SELECT s.*, c.name AS country_name, c.slug AS country_slug
       FROM series s LEFT JOIN countries c ON c.id = s.country_id
      WHERE s.id = ?`
  ).get(id);
  if (!series) return null;
  series.genres = db.prepare(
    'SELECT g.id, g.name, g.slug FROM genres g JOIN series_genres sg ON sg.genre_id = g.id WHERE sg.series_id = ? ORDER BY g.name'
  ).all(id);
  series.directors = db.prepare(
    "SELECT p.id, p.name FROM people p JOIN series_people sp ON sp.person_id = p.id WHERE sp.series_id = ? AND sp.role = 'director'"
  ).all(id);
  series.actors = db.prepare(
    "SELECT p.id, p.name FROM people p JOIN series_people sp ON sp.person_id = p.id WHERE sp.series_id = ? AND sp.role = 'actor' LIMIT 30"
  ).all(id);
  series.writers = db.prepare(
    "SELECT p.id, p.name FROM people p JOIN series_people sp ON sp.person_id = p.id WHERE sp.series_id = ? AND sp.role = 'writer'"
  ).all(id);
  series.seasons = db.prepare(
    `SELECT id, season_no, episode_count FROM seasons WHERE series_id = ? ORDER BY season_no`
  ).all(id);
  if (!series.seasons.length) {
    series.seasons = db.prepare(
      `SELECT season_no AS season_no, COUNT(*) AS episode_count,
              MIN(id) AS id
         FROM episodes WHERE series_id = ? GROUP BY season_no ORDER BY season_no`
    ).all(id);
  }
  return series;
}

function episodesForSeason(db, seriesId, seasonNo) {
  return db.prepare(
    `SELECT id, season_no, episode_no, title, link_count
       FROM episodes WHERE series_id = ? AND season_no = ?
      ORDER BY episode_no`
  ).all(seriesId, seasonNo);
}

function episodeLinks(db, episodeId) {
  const links = db.prepare(
    `SELECT id, url, play_url, quality_text, quality_res, extension, scraped_at
       FROM episode_links WHERE episode_id = ?`
  ).all(episodeId);
  return sortLinks(links);
}

function getEpisode(db, episodeId) {
  return db.prepare(
    `SELECT e.*, s.published AS series_published, s.slug AS series_slug,
            s.title_en AS series_title_en, s.title_fa AS series_title_fa
       FROM episodes e JOIN series s ON s.id = e.series_id
      WHERE e.id = ?`
  ).get(episodeId);
}

function bestEpisodeLink(db, episodeId) {
  const links = episodeLinks(db, episodeId);
  return links[0] || null;
}

function episodePlayUrlExists(db, playUrl) {
  return Boolean(db.prepare('SELECT id FROM episode_links WHERE play_url = ? LIMIT 1').get(playUrl));
}

function seriesGenreList(db) {
  return db.prepare(
    `SELECT g.id, g.name, g.slug, COUNT(sg.series_id) AS c
       FROM genres g JOIN series_genres sg ON sg.genre_id = g.id
       JOIN series s ON s.id = sg.series_id AND s.published = 1
      GROUP BY g.id ORDER BY c DESC, g.name`
  ).all();
}

function seriesYearList(db) {
  return db.prepare(
    `SELECT year, COUNT(*) AS c FROM series
      WHERE published = 1 AND year IS NOT NULL
      GROUP BY year ORDER BY year DESC`
  ).all();
}

function homeSeries(db, limit = 6) {
  return db.prepare(
    `SELECT ${SERIES_CARD_FIELDS} FROM series s
      WHERE s.published = 1
      ORDER BY s.featured DESC, s.last_link_at DESC, s.id DESC LIMIT ?`
  ).all(limit);
}

function relatedSeries(db, seriesId, limit = 8) {
  return db.prepare(
    `SELECT ${SERIES_CARD_FIELDS}, COUNT(*) AS shared
       FROM series_genres sg1
       JOIN series_genres sg2 ON sg2.genre_id = sg1.genre_id AND sg2.series_id != sg1.series_id
       JOIN series s ON s.id = sg2.series_id AND s.published = 1
      WHERE sg1.series_id = ?
      GROUP BY s.id ORDER BY shared DESC, s.id DESC LIMIT ?`
  ).all(seriesId, limit);
}

function adminSearchSeries(db, q, page, perPage) {
  const { escapeLike } = require('./queries');
  const like = `%${escapeLike(q)}%`;
  const idq = parseInt(q, 10);
  const byId = Number.isFinite(idq) && idq > 0;
  const where = byId
    ? "(s.title_fa_norm LIKE ? ESCAPE '\\' OR s.title_en_norm LIKE ? ESCAPE '\\' OR s.id = ?)"
    : "(s.title_fa_norm LIKE ? ESCAPE '\\' OR s.title_en_norm LIKE ? ESCAPE '\\')";
  const params = byId ? [like, like, idq] : [like, like];
  const per = Math.max(1, parseInt(perPage, 10) || 20);
  const total = db.prepare(`SELECT COUNT(*) c FROM series s WHERE ${where}`).get(...params).c;
  const pages = Math.max(1, Math.ceil(total / per));
  const cur = Math.min(Math.max(1, parseInt(page, 10) || 1), pages);
  const items = db.prepare(
    `SELECT ${SERIES_CARD_FIELDS}, s.published, s.season_count, s.episode_count
       FROM series s WHERE ${where}
      ORDER BY s.id DESC LIMIT ? OFFSET ?`
  ).all(...params, per, (cur - 1) * per);
  return { items, total, page: cur, pages };
}

module.exports = {
  SERIES_SORTS,
  seriesSortSql,
  SERIES_CARD_FIELDS,
  seriesList,
  searchSeries,
  suggestSeries,
  getSeriesFull,
  episodesForSeason,
  episodeLinks,
  getEpisode,
  bestEpisodeLink,
  episodePlayUrlExists,
  seriesGenreList,
  seriesYearList,
  homeSeries,
  relatedSeries,
  adminSearchSeries,
  sortLinks,
  resRank,
};
