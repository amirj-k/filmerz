'use strict';

/**
 * Import real series from the crawler DB.
 *
 * Every `links.db` row with kind='series' is one downloadable file for a
 * specific (page, season, episode). One crawl page = one series; each page
 * carries many episode links (mirrors / qualities). We normalize that into:
 *
 *   series → seasons → episodes → episode_links
 *
 * Idempotent: series are upserted by source_page, links by source_row_id.
 */

const config = require('./config');
const { parseRow } = require('./parser');
const { normSearch, cleanValue } = require('./normalizer');
const { canonCountries, cleanTitle } = require('./canon');
const { extFromUrl, hostOf } = require('./urls');
const queries = require('./queries');

const posterHostsRe = new RegExp(config.posterHosts, 'i');

function isLatin(s) { return /[A-Za-z]/.test(String(s || '')); }

/** Split parsed titles into (english, persian) when the crawl mixes scripts. */
function splitScriptTitles(parsed, fallbackTitle) {
  let en = cleanValue(parsed.titleEn || '');
  let fa = cleanValue(parsed.titleFa || '');
  const fallback = cleanTitle(fallbackTitle || '') || cleanValue(fallbackTitle || '');
  if (!en && !fa) {
    if (isLatin(fallback)) en = fallback; else fa = fallback;
  }
  if (en && !isLatin(en)) {
    if (!fa) fa = en;
    en = '';
  }
  if (fa && isLatin(fa) && !en) {
    en = fa;
    fa = '';
  }
  return { titleEn: en, titleFa: fa };
}

function seriesSlug(titleEn, titleFa, id) {
  const base = cleanValue(titleEn || titleFa || 'series').toLowerCase()
    .replace(/[^\w\u0600-\u06FF]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'series';
  return `${base}-${id}`;
}

/** Numeric resolution ranking so «1080p» beats «720p» regardless of text. */
function resRank(res) {
  const n = parseInt(String(res || '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function importSeries(db, src, opts = {}) {
  const { fresh = false, limit = 0, quiet = false } = opts;
  const log = (m) => { if (!quiet) console.log(m); };

  if (fresh) {
    log('[series] --fresh: clearing series/seasons/episodes/episode links');
    db.exec(`
      DELETE FROM episode_links;
      DELETE FROM episodes;
      DELETE FROM seasons;
      DELETE FROM series_genres;
      DELETE FROM series_people;
      DELETE FROM series_fts;
      DELETE FROM series;
    `);
  }

  // The crawler may or may not expose the stable play_url yet. Support both
  // shapes so a future crawl can populate it without another migration.
  const sourceCols = src.prepare('PRAGMA table_info(links)').all().map((c) => c.name);
  const playUrlExpr = sourceCols.includes('play_url') ? 'play_url' : "'' AS play_url";

  const selectRows = src.prepare(
    `SELECT id, page, title, img_url, description, url, text, scraped_at, season, episode, quality,
            ${playUrlExpr}
       FROM links WHERE kind = 'series'
      ORDER BY page, season, episode, id ${limit ? 'LIMIT ' + limit : ''}`
  );

  const upsertSeries = db.prepare(
    `INSERT INTO series (slug, source_page, title_en, title_en_norm, title_fa, title_fa_norm,
       year, age_rating, plot, poster_url, poster_valid, status_text, quality_res,
       last_link_at, country_id)
     VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_page) DO UPDATE SET
       title_en = CASE WHEN excluded.title_en != '' AND series.title_en = '' THEN excluded.title_en ELSE series.title_en END,
       title_fa = CASE WHEN excluded.title_fa != '' AND series.title_fa = '' THEN excluded.title_fa ELSE series.title_fa END,
       year = COALESCE(series.year, excluded.year),
       country_id = COALESCE(series.country_id, excluded.country_id),
       age_rating = CASE WHEN excluded.age_rating != '' AND series.age_rating = '' THEN excluded.age_rating ELSE series.age_rating END,
       plot = CASE WHEN excluded.plot != '' AND series.plot = '' THEN excluded.plot ELSE series.plot END,
       poster_url = CASE WHEN series.poster_url = '' THEN excluded.poster_url ELSE series.poster_url END,
       poster_valid = MAX(series.poster_valid, excluded.poster_valid),
       status_text = CASE WHEN excluded.status_text != '' AND series.status_text = '' THEN excluded.status_text ELSE series.status_text END,
       quality_res = CASE WHEN excluded.quality_res != '' AND series.quality_res = '' THEN excluded.quality_res ELSE series.quality_res END,
       last_seen = datetime('now')`
  );
  const findSeriesId = db.prepare('SELECT id FROM series WHERE source_page = ?');

  const insertSeason = db.prepare(
    'INSERT OR IGNORE INTO seasons (series_id, season_no) VALUES (?, ?)'
  );
  const findSeasonId = db.prepare('SELECT id FROM seasons WHERE series_id = ? AND season_no = ?');
  const insertEpisode = db.prepare(
    'INSERT OR IGNORE INTO episodes (series_id, season_id, season_no, episode_no, title) VALUES (?, ?, ?, ?, ?)'
  );
  const findEpisodeId = db.prepare(
    'SELECT id FROM episodes WHERE series_id = ? AND season_no = ? AND episode_no = ?'
  );

  const upsertLink = db.prepare(
    `INSERT INTO episode_links (episode_id, series_id, source_row_id, url, play_url,
       quality_text, quality_res, extension, scraped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_row_id) DO UPDATE SET
       episode_id = excluded.episode_id,
       series_id = excluded.series_id,
       url = excluded.url,
       play_url = CASE WHEN excluded.play_url != '' THEN excluded.play_url ELSE episode_links.play_url END,
       quality_text = excluded.quality_text,
       quality_res = excluded.quality_res,
       extension = excluded.extension,
       scraped_at = excluded.scraped_at`
  );

  let newSeries = 0;
  let seenSeries = 0;
  let linksUpserted = 0;
  let currentPage = null;
  let buffered = [];

  function flush(rows) {
    if (!rows.length) return;
    const page = rows[0].page;
    const desc = rows.reduce((a, b) => ((b.description || '').length > (a.description || '').length ? b : a));
    const parsed = parseRow({
      title: desc.title,
      url: desc.url,
      text: desc.text,
      description: desc.description || '',
    });
    const titles = splitScriptTitles(parsed, desc.title);
    const titleEn = titles.titleEn;
    const titleFa = titles.titleFa;

    const poster = String(desc.img_url || '').trim();
    const posterOk = poster && posterHostsRe.test(hostOf(poster));
    const countryName = canonCountries(parsed.country)[0] || '';
    const countryId = countryName ? (queries.getOrCreateCountry(db, countryName)?.id || null) : null;

    let bestRes = '';
    const seenEpisodes = new Set();
    for (const r of rows) {
      const res = String(r.quality || '').trim();
      if (res && resRank(res) > resRank(bestRes)) bestRes = res;
      seenEpisodes.add(`${r.season}:${r.episode}`);
    }

    const existing = findSeriesId.get(page);
    if (!existing) newSeries++;
    seenSeries++;

    upsertSeries.run(
      page,
      titleEn, normSearch(titleEn),
      titleFa, normSearch(titleFa),
      parsed.year,
      parsed.ageRating || '',
      parsed.plot || '',
      posterOk ? poster : '',
      posterOk ? 1 : 0,
      cleanValue(parsed.statusText || ''),
      bestRes,
      rows[0].scraped_at || '',
      countryId,
    );
    const seriesId = findSeriesId.get(page).id;

    if (!existing) {
      const slug = seriesSlug(titleEn, titleFa, seriesId);
      db.prepare('UPDATE series SET slug = ? WHERE id = ?').run(slug, seriesId);
      if (parsed.genres.length) queries.setSeriesGenres(db, seriesId, parsed.genres);
      if (parsed.directors.length) queries.setSeriesPeople(db, seriesId, 'director', parsed.directors);
      if (parsed.writers.length) queries.setSeriesPeople(db, seriesId, 'writer', parsed.writers);
      if (parsed.actors.length) queries.setSeriesPeople(db, seriesId, 'actor', parsed.actors);
    }
    queries.syncSeriesFts(db, seriesId);

    // Rows arrive ordered by (page, season, episode, id), so one-entry caches
    // avoid a SELECT per episode link.
    let lastSeasonNo = null;
    let lastSeasonId = null;
    let lastEpisodeNo = null;
    let lastEpisodeId = null;

    for (const r of rows) {
      const seasonNo = Number(r.season) || 1;
      const episodeNo = Number(r.episode) || 1;

      if (seasonNo !== lastSeasonNo) {
        insertSeason.run(seriesId, seasonNo);
        lastSeasonId = findSeasonId.get(seriesId, seasonNo).id;
        lastSeasonNo = seasonNo;
        lastEpisodeNo = null;
        lastEpisodeId = null;
      }
      if (episodeNo !== lastEpisodeNo) {
        insertEpisode.run(seriesId, lastSeasonId, seasonNo, episodeNo, '');
        lastEpisodeId = findEpisodeId.get(seriesId, seasonNo, episodeNo).id;
        lastEpisodeNo = episodeNo;
      }

      upsertLink.run(
        lastEpisodeId,
        seriesId,
        r.id,
        String(r.url || ''),
        String(r.play_url || ''),
        String(r.text || ''),
        String(r.quality || ''),
        extFromUrl(r.url),
        r.scraped_at || '',
      );
      linksUpserted++;
    }
  }

  const RUN_BATCH = 200;
  let batch = [];
  let doneSeries = 0;

  function commitBatch() {
    if (!batch.length) return;
    db.exec('BEGIN');
    try {
      for (const pageRows of batch) flush(pageRows);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    batch = [];
    if (doneSeries && doneSeries % 500 === 0) log(`[series] … ${doneSeries} series`);
  }

  for (const row of selectRows.iterate()) {
    if (currentPage !== null && row.page !== currentPage) {
      batch.push(buffered);
      buffered = [];
      doneSeries++;
      if (batch.length >= RUN_BATCH) commitBatch();
    }
    currentPage = row.page;
    buffered.push(row);
  }
  if (buffered.length) { batch.push(buffered); doneSeries++; }
  commitBatch();

  log('[series] recomputing counts…');
  db.exec(`
    UPDATE episodes SET link_count = (
      SELECT COUNT(*) FROM episode_links el WHERE el.episode_id = episodes.id
    );
    UPDATE seasons SET episode_count = (
      SELECT COUNT(*) FROM episodes e WHERE e.season_id = seasons.id
    );
    UPDATE series SET
      season_count  = (SELECT COUNT(*) FROM seasons s WHERE s.series_id = series.id),
      episode_count = (SELECT COUNT(*) FROM episodes e WHERE e.series_id = series.id),
      link_count    = (SELECT COUNT(*) FROM episode_links el WHERE el.series_id = series.id),
      last_link_at  = COALESCE((SELECT MAX(el.scraped_at) FROM episode_links el WHERE el.series_id = series.id), '');
  `);

  const totals = {
    series: db.prepare('SELECT COUNT(*) c FROM series').get().c,
    seasons: db.prepare('SELECT COUNT(*) c FROM seasons').get().c,
    episodes: db.prepare('SELECT COUNT(*) c FROM episodes').get().c,
    links: db.prepare('SELECT COUNT(*) c FROM episode_links').get().c,
  };
  log(`[series] done — ${totals.series} series, ${totals.seasons} seasons, ${totals.episodes} episodes, ${totals.links} episode links`);
  return { newSeries, seenSeries, linksUpserted, totals };
}

module.exports = { importSeries, splitScriptTitles, seriesSlug };
