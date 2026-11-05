'use strict';

/**
 * Write-side helpers for the admin panel.
 *
 * All catalogue writes from the panel go through this module so that:
 *   - a movie/series and its links are saved in one transaction,
 *   - the same validation and link classification as the importer is used,
 *   - counts (link_count / season_count / episode_count / last_link_at) stay
 *     consistent after every manual change.
 *
 * Imported rows are never rewritten here; only admin-created/edited content.
 */

const config = require('./config');
const queries = require('./queries');
const { normSearch, slugify } = require('./normalizer');
const { classifyLink, dedupeKeyOf } = require('./link-classify');

const MEDIA_KINDS = new Set(['video', 'audio', 'subtitle', 'archive']);
const POSTER_HOSTS_RE = new RegExp(config.posterHosts, 'i');

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function clip(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function integer(value, min, max, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.trunc(n);
  if (v < min || v > max) return fallback;
  return v;
}

function yearOf(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return null;
  if (n < 1900 || n > 2100) throw new Error('سال نامعتبر است (بین ۱۹۰۰ تا ۲۱۰۰).');
  return n;
}

function httpUrl(raw, label) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { throw new Error(`${label} نامعتبر است.`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`${label} باید با http:// یا https:// شروع شود.`);
  }
  return u.toString();
}

/**
 * poster_valid: 0 = none, 1 = proxy through /poster (allow-listed hosts),
 * 2 = render the URL directly (local uploads and other trusted hosts).
 */
function posterFlag(raw) {
  const s = String(raw || '').trim();
  if (!s) return 0;
  if (s.startsWith('/')) {
    if (!s.startsWith('/uploads/')) {
      throw new Error('آدرس پوستر باید کامل (https://…) یا از پوشه uploads باشد.');
    }
    return 2;
  }
  let u;
  try { u = new URL(s); } catch { throw new Error('آدرس پوستر نامعتبر است.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('آدرس پوستر باید با http:// یا https:// شروع شود.');
  }
  return POSTER_HOSTS_RE.test(u.hostname) ? 1 : 2;
}

function normalizeResolution(raw, fallback) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return fallback || '';
  const m = s.match(/^(\d{3,4})p?$/);
  return m ? `${m[1]}p` : (fallback || '');
}

function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

function movieSlug(titleEn, titleFa, id) {
  const base = slugify(titleEn || titleFa || 'movie').slice(0, 60).replace(/-+$/, '') || 'movie';
  return `${base}-${id}`;
}

function seriesSlug(titleEn, titleFa, id) {
  const base = slugify(titleEn || titleFa || 'series').slice(0, 60).replace(/-+$/, '') || 'series';
  return `${base}-${id}`;
}

/* ------------------------------------------------------------------ *
 * Blank records for the forms
 * ------------------------------------------------------------------ */

function blankLink(scope) {
  return {
    id: 0,
    url: '',
    play_url: '',
    quality_text: '',
    quality_res: '',
    resolution: '',
    server: '',
    codec: '',
    media_kind: '',
    is_dub: 0,
    is_sub: 0,
    part: 0,
    season_no: 1,
    episode_no: 1,
    episode_title: '',
    scope,
  };
}

function blankMovie() {
  return {
    id: 0, slug: '', title_en: '', title_fa: '', alt_titles: '', year: '',
    country_id: null, country_name: '', country_slug: '', age_rating: '',
    poster_url: '', poster_valid: 0, plot: '', published: 1, featured: 0,
    genres: [], directors: [], writers: [], actors: [], links: [],
    link_count: 0,
  };
}

function blankSeries() {
  return {
    id: 0, slug: '', title_en: '', title_fa: '', year: '',
    country_id: null, country_name: '', country_slug: '', age_rating: '',
    poster_url: '', poster_valid: 0, plot: '', status_text: '',
    published: 1, featured: 0, season_count: 0, episode_count: 0, link_count: 0,
    genres: [], directors: [], writers: [], actors: [], seasons: [], links: [],
  };
}

/* ------------------------------------------------------------------ *
 * Link normalization
 * ------------------------------------------------------------------ */

function normalizeLinkRow(row) {
  const url = httpUrl(row && row.url, 'آدرس لینک');
  if (!url) throw new Error('آدرس لینک لازم است.');
  const playUrl = httpUrl(row && row.play_url, 'لینک پایدار');
  const qualityText = clip(row && row.quality_text, 300);
  const cls = classifyLink({ url, text: qualityText, quality: '' });

  let mediaKind = String((row && row.media_kind) || '').trim();
  if (!MEDIA_KINDS.has(mediaKind)) mediaKind = cls.mediaKind;

  let isDub = row && row.is_dub ? 1 : cls.isDub;
  let isSub = row && row.is_sub ? 1 : cls.isSub;
  if (mediaKind === 'subtitle') isSub = 1;
  if (isDub) isSub = 0;

  return {
    url,
    play_url: playUrl,
    quality_text: qualityText,
    quality_res: normalizeResolution(row && row.resolution, cls.resolution),
    part: integer(row && row.part, 0, 9999, 0),
    extension: cls.extension,
    media_kind: mediaKind,
    resolution: normalizeResolution(row && row.resolution, cls.resolution),
    is_dub: isDub,
    is_sub: isSub,
    codec: clip(row && row.codec, 60) || cls.codec,
    source_tag: cls.sourceTag,
    server: clip(row && row.server, 120) || cls.server,
    file_name: cls.fileName,
    audio_label: cls.audioLabel,
    mirror_key: cls.mirrorKey,
    dedupe_key: '',
  };
}

function upsertMovieLink(db, movieId, link) {
  const dedupe = dedupeKeyOf(`m:${movieId}`, link.url);
  const existing = db.prepare('SELECT id FROM links WHERE movie_id = ? AND url = ? ORDER BY id LIMIT 1')
    .get(movieId, link.url);
  if (existing) {
    db.prepare(
      `UPDATE links SET dedupe_key = ?, play_url = ?, quality_text = ?, part = ?, extension = ?,
         scraped_at = datetime('now'), media_kind = ?, resolution = ?, is_dub = ?, is_sub = ?,
         codec = ?, source_tag = ?, server = ?, file_name = ?, audio_label = ?, mirror_key = ?
       WHERE id = ?`
    ).run(dedupe, link.play_url, link.quality_text, link.part, link.extension,
      link.media_kind, link.resolution, link.is_dub, link.is_sub, link.codec, link.source_tag,
      link.server, link.file_name, link.audio_label, link.mirror_key, existing.id);
    return 'updated';
  }
  db.prepare(
    `INSERT INTO links (movie_id, dedupe_key, url, play_url, quality_text, part, extension,
       scraped_at, media_kind, resolution, is_dub, is_sub, codec, source_tag, server,
       file_name, audio_label, mirror_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(movieId, dedupe, link.url, link.play_url, link.quality_text, link.part, link.extension,
    link.media_kind, link.resolution, link.is_dub, link.is_sub, link.codec, link.source_tag,
    link.server, link.file_name, link.audio_label, link.mirror_key);
  return 'added';
}

function addMovieLinksUnsafe(db, movieId, rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && String(r.url || '').trim());
  if (!list.length) return { added: 0, updated: 0 };
  let added = 0;
  let updated = 0;
  for (const row of list) {
    const result = upsertMovieLink(db, movieId, normalizeLinkRow(row));
    if (result === 'added') added += 1;
    else updated += 1;
  }
  db.prepare("UPDATE movies SET last_link_at = datetime('now') WHERE id = ?").run(movieId);
  queries.recomputeMovieCounts(db, movieId);
  return { added, updated };
}

function addMovieLinks(db, movieId, rows) {
  if (!db.prepare('SELECT id FROM movies WHERE id = ?').get(movieId)) {
    throw new Error('فیلمی با این شناسه وجود ندارد.');
  }
  return withTransaction(db, () => addMovieLinksUnsafe(db, movieId, rows));
}

/* ------------------------------------------------------------------ *
 * Series: seasons, episodes, links
 * ------------------------------------------------------------------ */

function seasonNoOf(value) {
  const n = integer(value, 0, 999, 1);
  return n;
}

function episodeNoOf(value) {
  return integer(value, 0, 9999, 1);
}

function ensureSeason(db, seriesId, seasonNo) {
  let row = db.prepare('SELECT id FROM seasons WHERE series_id = ? AND season_no = ?').get(seriesId, seasonNo);
  if (row) return row.id;
  const info = db.prepare('INSERT INTO seasons (series_id, season_no) VALUES (?, ?)').run(seriesId, seasonNo);
  return Number(info.lastInsertRowid);
}

function ensureEpisode(db, seriesId, seasonId, seasonNo, episodeNo, title) {
  let row = db.prepare(
    'SELECT id, title FROM episodes WHERE series_id = ? AND season_no = ? AND episode_no = ?'
  ).get(seriesId, seasonNo, episodeNo);
  if (row) {
    if (title && title !== row.title) {
      db.prepare('UPDATE episodes SET title = ? WHERE id = ?').run(title, row.id);
    }
    return row.id;
  }
  const info = db.prepare(
    'INSERT INTO episodes (series_id, season_id, season_no, episode_no, title) VALUES (?, ?, ?, ?, ?)'
  ).run(seriesId, seasonId, seasonNo, episodeNo, title);
  return Number(info.lastInsertRowid);
}

function upsertEpisodeLink(db, seriesId, episodeId, link) {
  const dedupe = dedupeKeyOf(`e:${episodeId}`, link.url);
  const existing = db.prepare('SELECT id FROM episode_links WHERE episode_id = ? AND url = ? ORDER BY id LIMIT 1')
    .get(episodeId, link.url);
  if (existing) {
    db.prepare(
      `UPDATE episode_links SET dedupe_key = ?, play_url = ?, quality_text = ?, quality_res = ?,
         extension = ?, scraped_at = datetime('now'), media_kind = ?, resolution = ?, is_dub = ?,
         is_sub = ?, codec = ?, source_tag = ?, server = ?, file_name = ?, audio_label = ?, mirror_key = ?
       WHERE id = ?`
    ).run(dedupe, link.play_url, link.quality_text, link.quality_res, link.extension,
      link.media_kind, link.resolution, link.is_dub, link.is_sub, link.codec, link.source_tag,
      link.server, link.file_name, link.audio_label, link.mirror_key, existing.id);
    return 'updated';
  }
  db.prepare(
    `INSERT INTO episode_links (episode_id, series_id, dedupe_key, url, play_url, quality_text,
       quality_res, extension, scraped_at, media_kind, resolution, is_dub, is_sub, codec,
       source_tag, server, file_name, audio_label, mirror_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(episodeId, seriesId, dedupe, link.url, link.play_url, link.quality_text, link.quality_res,
    link.extension, link.media_kind, link.resolution, link.is_dub, link.is_sub, link.codec,
    link.source_tag, link.server, link.file_name, link.audio_label, link.mirror_key);
  return 'added';
}

function refreshSeasonCounts(db, seriesId) {
  db.prepare(
    `UPDATE seasons SET episode_count =
       (SELECT COUNT(*) FROM episodes e WHERE e.season_id = seasons.id)
     WHERE series_id = ?`
  ).run(seriesId);
  db.prepare(
    `UPDATE episodes SET link_count =
       (SELECT COUNT(*) FROM episode_links l WHERE l.episode_id = episodes.id)
     WHERE series_id = ?`
  ).run(seriesId);
}

function pruneEmptyTree(db, seriesId) {
  db.prepare(
    `DELETE FROM episodes
      WHERE series_id = ?
        AND NOT EXISTS (SELECT 1 FROM episode_links l WHERE l.episode_id = episodes.id)`
  ).run(seriesId);
  db.prepare(
    `DELETE FROM seasons
      WHERE series_id = ?
        AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.season_id = seasons.id)`
  ).run(seriesId);
}

function refreshSeriesLastLink(db, seriesId) {
  db.prepare(
    `UPDATE series SET last_link_at = COALESCE(
       (SELECT MAX(scraped_at) FROM episode_links WHERE series_id = ? AND scraped_at != ''), '')
     WHERE id = ?`
  ).run(seriesId, seriesId);
}

function addSeriesLinksUnsafe(db, seriesId, rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && String(r.url || '').trim());
  if (!list.length) return { added: 0, updated: 0, episodes: 0 };
  let added = 0;
  let updated = 0;
  const touchedEpisodes = new Set();

  for (const row of list) {
    const link = normalizeLinkRow(row);
    const seasonNo = seasonNoOf(row.season_no);
    const episodeNo = episodeNoOf(row.episode_no);
    const episodeTitle = clip(row.episode_title, 200);
    const seasonId = ensureSeason(db, seriesId, seasonNo);
    const episodeId = ensureEpisode(db, seriesId, seasonId, seasonNo, episodeNo, episodeTitle);
    touchedEpisodes.add(episodeId);

    const result = upsertEpisodeLink(db, seriesId, episodeId, link);
    if (result === 'added') added += 1;
    else updated += 1;
  }

  refreshSeasonCounts(db, seriesId);
  db.prepare("UPDATE series SET last_link_at = datetime('now') WHERE id = ?").run(seriesId);
  queries.recomputeSeriesCounts(db, seriesId);
  return { added, updated, episodes: touchedEpisodes.size };
}

function addSeriesLinks(db, seriesId, rows) {
  if (!db.prepare('SELECT id FROM series WHERE id = ?').get(seriesId)) {
    throw new Error('سریالی با این شناسه وجود ندارد.');
  }
  return withTransaction(db, () => addSeriesLinksUnsafe(db, seriesId, rows));
}

/* ------------------------------------------------------------------ *
 * Movie + series persistence
 * ------------------------------------------------------------------ */

function applyCountry(db, table, rowId, country, column) {
  if (country === undefined) return;
  const name = String(country || '').trim();
  const countryName = name ? (require('./canon').canonCountries(name)[0] || '') : '';
  const c = countryName ? queries.getOrCreateCountry(db, countryName) : null;
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(c ? c.id : null, rowId);
}

function applyPeople(db, setter, rowId, people) {
  if (!Array.isArray(people)) return;
  const byRole = { director: [], writer: [], actor: [] };
  for (const p of people) {
    if (!p || !p.name) continue;
    const role = ['director', 'writer', 'actor'].includes(p.role) ? p.role : 'actor';
    byRole[role].push(String(p.name));
  }
  for (const role of Object.keys(byRole)) setter(db, rowId, role, byRole[role]);
}

/** Persist the movie form (JSON body from the admin UI). */
function saveMovie(db, body, id) {
  const data = {
    title_en: clip(body.title_en, 300),
    title_fa: clip(body.title_fa, 300),
    other_titles: clip(body.other_titles, 1000),
    year: yearOf(body.year),
    age_rating: clip(body.age_rating, 30),
    poster_url: String(body.poster_url || '').trim(),
    plot: String(body.plot || '').trim(),
  };
  if (!data.title_en && !data.title_fa) throw new Error('دست‌کم یکی از عنوان‌ها لازم است.');
  const posterValid = posterFlag(data.poster_url);

  return withTransaction(db, () => {
    let movieId;
    if (id) {
      if (!db.prepare('SELECT id FROM movies WHERE id = ?').get(id)) {
        throw new Error('فیلمی با این شناسه وجود ندارد.');
      }
      movieId = queries.updateMovie(db, id, data);
    } else {
      movieId = queries.insertMovie(db, data);
    }

    db.prepare('UPDATE movies SET poster_valid = ? WHERE id = ?').run(posterValid, movieId);
    applyCountry(db, 'movies', movieId, body.country, 'country_id');
    if (Array.isArray(body.genres)) {
      queries.setMovieGenres(db, movieId, body.genres.map((g) => String(g).trim()).filter(Boolean));
    }
    applyPeople(db, queries.setMoviePeople, movieId, body.people);
    if (body.published !== undefined) queries.setMoviePublished(db, movieId, body.published ? 1 : 0);
    if (body.featured !== undefined) queries.setMovieFeatured(db, movieId, body.featured ? 1 : 0);
    if (Array.isArray(body.links)) addMovieLinksUnsafe(db, movieId, body.links);
    queries.syncMovieFts(db, movieId);
    queries.recomputeMovieCounts(db, movieId);
    return movieId;
  });
}

/** Create or persist a series form (JSON body from the admin UI). */
function saveSeries(db, body, id) {
  const data = {
    title_en: clip(body.title_en, 300),
    title_fa: clip(body.title_fa, 300),
    year: yearOf(body.year),
    age_rating: clip(body.age_rating, 30),
    poster_url: String(body.poster_url || '').trim(),
    plot: String(body.plot || '').trim(),
    status_text: clip(body.status_text, 120),
  };
  if (!data.title_en && !data.title_fa) throw new Error('دست‌کم یکی از عنوان‌ها لازم است.');
  const posterValid = posterFlag(data.poster_url);

  return withTransaction(db, () => {
    let seriesId = id;
    if (id) {
      if (!db.prepare('SELECT id FROM series WHERE id = ?').get(id)) {
        throw new Error('سریالی با این شناسه وجود ندارد.');
      }
      db.prepare(
        `UPDATE series SET title_en = ?, title_en_norm = ?, title_fa = ?, title_fa_norm = ?,
           year = ?, age_rating = ?, poster_url = ?, poster_valid = ?, plot = ?, status_text = ?
         WHERE id = ?`
      ).run(data.title_en, normSearch(data.title_en), data.title_fa, normSearch(data.title_fa),
        data.year, data.age_rating, data.poster_url, posterValid, data.plot, data.status_text, id);
    } else {
      const info = db.prepare(
        `INSERT INTO series (slug, title_en, title_en_norm, title_fa, title_fa_norm,
           year, age_rating, poster_url, poster_valid, plot, status_text, published, featured)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`
      ).run(
        'tmp-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
        data.title_en, normSearch(data.title_en), data.title_fa, normSearch(data.title_fa),
        data.year, data.age_rating, data.poster_url, posterValid, data.plot, data.status_text
      );
      seriesId = Number(info.lastInsertRowid);
    }

    db.prepare('UPDATE series SET slug = ? WHERE id = ?')
      .run(seriesSlug(data.title_en, data.title_fa, seriesId), seriesId);
    applyCountry(db, 'series', seriesId, body.country, 'country_id');
    if (Array.isArray(body.genres)) {
      queries.setSeriesGenres(db, seriesId, body.genres.map((g) => String(g).trim()).filter(Boolean));
    }
    applyPeople(db, queries.setSeriesPeople, seriesId, body.people);
    if (body.published !== undefined) {
      db.prepare('UPDATE series SET published = ? WHERE id = ?').run(body.published ? 1 : 0, seriesId);
    }
    if (body.featured !== undefined) {
      db.prepare('UPDATE series SET featured = ? WHERE id = ?').run(body.featured ? 1 : 0, seriesId);
    }
    if (Array.isArray(body.links)) addSeriesLinksUnsafe(db, seriesId, body.links);
    queries.syncSeriesFts(db, seriesId);
    queries.recomputeSeriesCounts(db, seriesId);
    return seriesId;
  });
}

/* ------------------------------------------------------------------ *
 * Link deletion
 * ------------------------------------------------------------------ */

function deleteMovieLink(db, movieId, linkId) {
  return withTransaction(db, () => {
    const row = db.prepare('SELECT id, movie_id FROM links WHERE id = ?').get(linkId);
    if (!row || row.movie_id !== movieId) throw new Error('لینک مورد نظر پیدا نشد.');
    db.prepare('DELETE FROM links WHERE id = ?').run(linkId);
    queries.recomputeMovieCounts(db, movieId);
    db.prepare(
      `UPDATE movies SET last_link_at = COALESCE(
         (SELECT MAX(scraped_at) FROM links WHERE movie_id = ? AND scraped_at != ''), '')
       WHERE id = ?`
    ).run(movieId, movieId);
    return { ok: true };
  });
}

function deleteEpisodeLink(db, seriesId, linkId) {
  return withTransaction(db, () => {
    const row = db.prepare('SELECT id, series_id FROM episode_links WHERE id = ?').get(linkId);
    if (!row || row.series_id !== seriesId) throw new Error('لینک مورد نظر پیدا نشد.');
    db.prepare('DELETE FROM episode_links WHERE id = ?').run(linkId);
    refreshSeasonCounts(db, seriesId);
    pruneEmptyTree(db, seriesId);
    refreshSeriesLastLink(db, seriesId);
    queries.recomputeSeriesCounts(db, seriesId);
    return { ok: true };
  });
}

module.exports = {
  blankMovie,
  blankSeries,
  blankLink,
  saveMovie,
  saveSeries,
  addMovieLinks,
  addSeriesLinks,
  deleteMovieLink,
  deleteEpisodeLink,
  normalizeLinkRow,
  posterFlag,
  movieSlug,
  seriesSlug,
};
