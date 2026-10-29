'use strict';
/**
 * import.js — links.db (messy crawl) → data/app.db (normalized)
 * Re-runnable: movies upsert by source_page, links upsert by source_row_id,
 * series upsert by page + season + episode (see src/series-import.js).
 *
 * Usage: node scripts/import.js [--limit N] [--fresh] [--quiet]
 *          [--movies-only | --series-only]
 */
const config = require('../src/config');
const { openAppDb, openLinksDbReadOnly } = require('../src/db');
const { applySchema } = require('../src/schema');
const { parseRow, parseQuality } = require('../src/parser');
const { normSearch } = require('../src/normalizer');
const { parseSeries, seriesKeyOf, canonCountries } = require('../src/canon');
const { extFromUrl, hostOf } = require('../src/urls');
const { importSeries } = require('../src/series-import');
const queries = require('../src/queries');

const args = process.argv.slice(2);
const LIMIT = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) || 0 : 0;
const FRESH = args.includes('--fresh');
const QUIET = args.includes('--quiet');
const MOVIES_ONLY = args.includes('--movies-only');
const SERIES_ONLY = args.includes('--series-only');
const posterHostsRe = new RegExp(config.posterHosts, 'i');

function log(msg) { if (!QUIET) console.log(msg); }

module.exports = { extFromUrl, hostOf };

function main() {
  const src = openLinksDbReadOnly(config.linksDbPath);
  const db = openAppDb(config.appDbPath);
  applySchema(db);

  let movieCount = 0;
  let linkCount = 0;

  if (FRESH && !SERIES_ONLY) {
    log('[import] --fresh: clearing movies/links/FTS (reference tables kept)');
    db.exec('DELETE FROM links; DELETE FROM movies; DELETE FROM movies_fts;');
  }

  if (!SERIES_ONLY) {
    // Support both crawler shapes: with an optional stable `play_url` column
    // and with only the (possibly expiring) direct `url`.
    const sourceCols = src.prepare('PRAGMA table_info(links)').all().map((c) => c.name);
    const playUrlExpr = sourceCols.includes('play_url') ? 'play_url' : "'' AS play_url";
    const selectPages = src.prepare(
      `SELECT id, page, title, img_url, description, url, text, scraped_at, ${playUrlExpr}
         FROM links WHERE kind = 'movie' ORDER BY page, id ${LIMIT ? 'LIMIT ' + LIMIT : ''}`
    );

    const insertMovie = db.prepare(
      `INSERT INTO movies (slug, source_page, title_en, title_en_norm, title_fa, title_fa_norm,
         alt_titles, year, age_rating, plot, poster_url, poster_valid, quality_res, quality_codec,
         hardsub, censored, last_link_at, country_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_page) DO UPDATE SET
         title_en = CASE WHEN excluded.title_en != '' AND movies.title_en = '' THEN excluded.title_en ELSE movies.title_en END,
         title_fa = CASE WHEN excluded.title_fa != '' AND movies.title_fa = '' THEN excluded.title_fa ELSE movies.title_fa END,
         alt_titles = CASE WHEN excluded.alt_titles != '' AND movies.alt_titles = '' THEN excluded.alt_titles ELSE movies.alt_titles END,
         year = COALESCE(movies.year, excluded.year),
         country_id = COALESCE(movies.country_id, excluded.country_id),
         age_rating = CASE WHEN excluded.age_rating != '' AND movies.age_rating = '' THEN excluded.age_rating ELSE movies.age_rating END,
         plot = CASE WHEN excluded.plot != '' AND movies.plot = '' THEN excluded.plot ELSE movies.plot END,
         poster_url = CASE WHEN movies.poster_url = '' THEN excluded.poster_url ELSE movies.poster_url END,
         poster_valid = MAX(movies.poster_valid, excluded.poster_valid)`
    );
    const findMovieId = db.prepare('SELECT id FROM movies WHERE source_page = ?');
    const insertLink = db.prepare(
      `INSERT INTO links (movie_id, source_row_id, url, play_url, quality_text, part, extension, scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_row_id) DO UPDATE SET
         movie_id = excluded.movie_id,
         url = excluded.url,
         play_url = CASE WHEN excluded.play_url != '' THEN excluded.play_url ELSE links.play_url END,
         quality_text = excluded.quality_text,
         part = excluded.part,
         extension = excluded.extension,
         scraped_at = excluded.scraped_at`
    );
    const setRes = db.prepare('UPDATE movies SET quality_res = ? WHERE id = ?');
    const setLastLink = db.prepare(
      'UPDATE movies SET last_link_at = COALESCE((SELECT MAX(scraped_at) FROM links WHERE movie_id = ?), ?) WHERE id = ?'
    );

    let currentPage = null;
    let buffered = []; // rows grouped by source page

    function flush(rows) {
      if (!rows.length) return;
      // Parse movie fields from the row with the richest description.
      const desc = rows.reduce((a, b) => ((b.description || '').length > (a.description || '').length ? b : a));
      const parsed = parseRow({ title: desc.title, url: desc.url, text: desc.text, description: desc.description || '' });

      const poster = String(desc.img_url || '').trim();
      const posterOk = poster && posterHostsRe.test(hostOf(poster));
      const page = rows[0].page;

      const existing = findMovieId.get(page);
      if (!existing) movieCount++;

      const countryName = canonCountries(parsed.country)[0] || '';
      const countryId = countryName ? queries.getOrCreateCountry(db, countryName)?.id || null : null;
      insertMovie.run(
        page,
        parsed.titleEn, normSearch(parsed.titleEn),
        parsed.titleFa, normSearch(parsed.titleFa),
        parsed.altTitles || '',
        parsed.year,
        parsed.ageRating || '',
        parsed.plot || '',
        posterOk ? poster : '',
        posterOk ? 1 : 0,
        parsed.quality.resolution || '',
        parsed.quality.codec || '',
        parsed.quality.hardsub ? 1 : 0,
        parsed.quality.censored ? 1 : 0,
        rows[0].scraped_at || '',
        countryId,
      );
      const movieId = findMovieId.get(page).id;

      // Franchise key (sequel chains) — kept separate from real series.
      const series = parseSeries(parsed.titleEn, parsed.titleFa);
      const seriesKey = seriesKeyOf(series);
      if (seriesKey) {
        db.prepare('UPDATE movies SET series_key = ?, episode_no = ? WHERE id = ?')
          .run(seriesKey, series.episode || 0, movieId);
      }

      if (!existing) {
        const slug = queries.movieSlug(parsed.titleEn, parsed.titleFa, movieId);
        db.prepare('UPDATE movies SET slug = ? WHERE id = ?').run(slug, movieId);
        if (parsed.genres.length) queries.setMovieGenres(db, movieId, parsed.genres);
        if (parsed.directors.length) queries.setMoviePeople(db, movieId, 'director', parsed.directors);
        if (parsed.writers.length) queries.setMoviePeople(db, movieId, 'writer', parsed.writers);
        if (parsed.actors.length) queries.setMoviePeople(db, movieId, 'actor', parsed.actors);
        queries.syncMovieFts(db, movieId);
      }

      let bestRes = '';
      for (const r of rows) {
        const q = parseQuality(r.text);
        const res = insertLink.run(movieId, r.id, r.url, r.play_url || '', q.label || '', q.part || 0, extFromUrl(r.url), r.scraped_at || '');
        linkCount += res.changes;
        if (!bestRes && q.resolution) bestRes = q.resolution;
      }
      if (bestRes) setRes.run(bestRes, movieId);
      setLastLink.run(movieId, rows[0].scraped_at || '', movieId);
    }

    db.exec('BEGIN');
    try {
      for (const row of selectPages.iterate()) {
        if (currentPage !== null && row.page !== currentPage) {
          flush(buffered);
          buffered = [];
          if (movieCount && movieCount % 500 === 0) log(`[import] … ${movieCount} movies`);
        }
        currentPage = row.page;
        buffered.push(row);
      }
      flush(buffered);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    log(`[import] movies done — total: ${db.prepare('SELECT COUNT(*) c FROM movies').get().c} (new this run: ${movieCount}), links stored this run: ${linkCount}`);
  }

  let seriesStats = null;
  if (!MOVIES_ONLY) {
    seriesStats = importSeries(db, src, { fresh: FRESH, limit: LIMIT, quiet: QUIET });
  }

  const totalMovies = db.prepare('SELECT COUNT(*) c FROM movies').get().c;
  const totalLinks = db.prepare('SELECT COUNT(*) c FROM links').get().c;
  const totalSeries = db.prepare('SELECT COUNT(*) c FROM series').get().c;
  const totalEpisodes = db.prepare('SELECT COUNT(*) c FROM episodes').get().c;
  const totalEpisodeLinks = db.prepare('SELECT COUNT(*) c FROM episode_links').get().c;
  const sourceRows = src.prepare('SELECT COUNT(*) c FROM links').get().c;
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .run('last_import', JSON.stringify({
      at: new Date().toISOString(),
      movies: totalMovies, links: totalLinks,
      series: totalSeries, episodes: totalEpisodes, episodeLinks: totalEpisodeLinks,
      sourceRows,
    }));

  log(`[import] done — movies: ${totalMovies}, series: ${totalSeries}, episodes: ${totalEpisodes}, episode links: ${totalEpisodeLinks}, source rows: ${sourceRows}`);
  if (seriesStats) log(`[import] series this run — new: ${seriesStats.newSeries}, links upserted: ${seriesStats.linksUpserted}`);
  src.close();
  db.close();
}

if (require.main === module) main();

