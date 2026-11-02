'use strict';
/**
 * seo-audit.js — read-only SEO inventory for the local catalogue.
 *
 * Usage:
 *   node scripts/seo-audit.js [--db path/to/app.db] [--json] [--sample N]
 *
 * This script never writes: the database is opened with readOnly: true and
 * no schema/import function is called. It is safe to run against the
 * production file (still make a backup before big changes, as always).
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}

const dbPath = path.resolve(argValue('--db') || process.env.APP_DB_PATH || path.join(__dirname, '..', 'data', 'app.db'));
const jsonOut = process.argv.includes('--json');
const sampleSize = Math.max(1, parseInt(argValue('--sample'), 10) || 5);
const baseUrl = argValue('--base-url');
if (baseUrl) process.env.APP_BASE_URL = baseUrl;

if (!fs.existsSync(dbPath)) {
  console.error(`[seo-audit] database not found: ${dbPath}`);
  process.exit(2);
}

const config = require('../src/config');
const { SitemapGenerator } = require('../src/sitemap');
const { SEOEngine } = require('../src/seo');
const catalog = require('../src/catalog');
const seriesCatalog = require('../src/series-catalog');

const db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false });
const one = (sql, ...params) => db.prepare(sql).get(...params) || {};
const all = (sql, ...params) => db.prepare(sql).all(...params);

function pct(part, total) {
  if (!total) return '0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

async function main() {
  const movies = one('SELECT COUNT(*) c FROM movies WHERE published = 1').c;
  const series = one('SELECT COUNT(*) c FROM series WHERE published = 1').c;

  const coverage = {
    movies: {
      plot: one("SELECT COUNT(*) c FROM movies WHERE published = 1 AND plot != ''").c,
      poster: one('SELECT COUNT(*) c FROM movies WHERE published = 1 AND poster_valid = 1 AND poster_url != \'\'').c,
      links: one('SELECT COUNT(*) c FROM movies m WHERE m.published = 1 AND EXISTS (SELECT 1 FROM links l WHERE l.movie_id = m.id)').c,
      country: one('SELECT COUNT(*) c FROM movies WHERE published = 1 AND country_id IS NOT NULL').c,
      genres: one(`SELECT COUNT(*) c FROM movies m WHERE m.published = 1
        AND EXISTS (SELECT 1 FROM movie_genres mg WHERE mg.movie_id = m.id)`).c,
      directors: one(`SELECT COUNT(*) c FROM movies m WHERE m.published = 1
        AND EXISTS (SELECT 1 FROM movie_people mp WHERE mp.movie_id = m.id AND mp.role = 'director')`).c,
      actors: one(`SELECT COUNT(*) c FROM movies m WHERE m.published = 1
        AND EXISTS (SELECT 1 FROM movie_people mp WHERE mp.movie_id = m.id AND mp.role = 'actor')`).c,
    },
    series: {
      plot: one("SELECT COUNT(*) c FROM series WHERE published = 1 AND plot != ''").c,
      poster: one('SELECT COUNT(*) c FROM series WHERE published = 1 AND poster_valid = 1 AND poster_url != \'\'').c,
      links: one('SELECT COUNT(*) c FROM series s WHERE s.published = 1 AND EXISTS (SELECT 1 FROM episode_links el WHERE el.series_id = s.id)').c,
      country: one('SELECT COUNT(*) c FROM series WHERE published = 1 AND country_id IS NOT NULL').c,
      genres: one(`SELECT COUNT(*) c FROM series s WHERE s.published = 1
        AND EXISTS (SELECT 1 FROM series_genres sg WHERE sg.series_id = s.id)`).c,
      directors: one(`SELECT COUNT(*) c FROM series s WHERE s.published = 1
        AND EXISTS (SELECT 1 FROM series_people sp WHERE sp.series_id = s.id AND sp.role = 'director')`).c,
    },
  };

  const duplicates = {
    movieTitleEn: all(`SELECT title_en AS value, COUNT(*) AS c FROM movies
      WHERE published = 1 AND title_en != '' GROUP BY title_en HAVING c > 1
      ORDER BY c DESC LIMIT 15`),
    movieTitleFa: all(`SELECT title_fa AS value, COUNT(*) AS c FROM movies
      WHERE published = 1 AND title_fa != '' GROUP BY title_fa HAVING c > 1
      ORDER BY c DESC LIMIT 15`),
    seriesTitleEn: all(`SELECT title_en AS value, COUNT(*) AS c FROM series
      WHERE published = 1 AND title_en != '' GROUP BY title_en HAVING c > 1
      ORDER BY c DESC LIMIT 15`),
    // A title+year pair is the page identity used in titles/metadata.
    movieTitleYear: all(`SELECT title_en || ' (' || COALESCE(year, '?') || ')' AS value, COUNT(*) AS c
      FROM movies WHERE published = 1 AND title_en != ''
      GROUP BY title_en, year HAVING c > 1 ORDER BY c DESC LIMIT 15`),
  };

  const archives = {
    genresWithMovies: one(`SELECT COUNT(*) c FROM genres g WHERE EXISTS (
      SELECT 1 FROM movie_genres mg JOIN movies m ON m.id = mg.movie_id
      WHERE mg.genre_id = g.id AND m.published = 1)`).c,
    countriesWithMovies: one(`SELECT COUNT(*) c FROM countries c WHERE EXISTS (
      SELECT 1 FROM movies m WHERE m.country_id = c.id AND m.published = 1)`).c,
    yearsWithMovies: one(`SELECT COUNT(DISTINCT year) c FROM movies
      WHERE published = 1 AND year IS NOT NULL`).c,
    totalGenres: one('SELECT COUNT(*) c FROM genres').c,
    totalCountries: one('SELECT COUNT(*) c FROM countries').c,
  };

  const generator = new SitemapGenerator(db);
  const sitemaps = [];
  for (const s of generator.listSitemaps()) {
    const match = s.name.match(/^(.+)-(\d+)$/);
    const name = match ? match[1] : s.name;
    const page = match ? parseInt(match[2], 10) : 1;
    let xml = null;
    switch (name) {
      case 'movies': xml = await generator.generateMoviesSitemap(page); break;
      case 'series': xml = await generator.generateSeriesSitemap(page); break;
      case 'genres': xml = page === 1 ? await generator.generateGenresSitemap() : null; break;
      case 'countries': xml = page === 1 ? await generator.generateCountriesSitemap() : null; break;
      case 'years': xml = page === 1 ? await generator.generateYearsSitemap() : null; break;
      case 'pages': xml = page === 1 ? await generator.generatePagesSitemap() : null; break;
      case 'top250': xml = page === 1 ? await generator.generateTop250Sitemap() : null; break;
      default: xml = null;
    }
    const urls = xml ? (xml.match(/<loc>/g) || []).length : 0;
    sitemaps.push({ name: s.name, loc: s.loc, urls });
  }

  // Sample canonical/robots/title metadata for real detail pages. This uses
  // the same functions the HTTP routes use, so it catches regressions without
  // starting a server.
  const engine = new SEOEngine(db);
  const samples = [];
  const movieRows = all('SELECT id, slug FROM movies WHERE published = 1 ORDER BY id DESC LIMIT ?', sampleSize);
  for (const row of movieRows) {
    const movie = catalog.getMovieFull(db, row.id);
    if (!movie) continue;
    const pathname = `/movie/${movie.id}-${movie.slug}`;
    const meta = engine.generateMetadata('movie', { movie }, pathname);
    samples.push({
      path: pathname,
      title: meta.title,
      titleLength: meta.title.length,
      descriptionLength: meta.description.length,
      robots: meta.robots,
      canonical: meta.canonicalUrl,
      canonicalMatchesPath: meta.canonicalUrl === `${config.appBaseUrl}${pathname}`,
      hasStructuredData: Boolean(meta.structuredData),
      breadcrumbs: meta.breadcrumbs.length,
    });
  }

  const seriesRows = all('SELECT id, slug FROM series WHERE published = 1 ORDER BY id DESC LIMIT ?', Math.min(2, sampleSize));
  for (const row of seriesRows) {
    const series = seriesCatalog.getSeriesFull(db, row.id, { withSeasons: false });
    if (!series) continue;
    const pathname = `/series/${series.id}-${series.slug}`;
    const meta = engine.generateMetadata('seriesDetail', { series }, pathname);
    samples.push({
      path: pathname,
      title: meta.title,
      titleLength: meta.title.length,
      descriptionLength: meta.description.length,
      robots: meta.robots,
      canonical: meta.canonicalUrl,
      canonicalMatchesPath: meta.canonicalUrl === `${config.appBaseUrl}${pathname}`,
      hasStructuredData: Boolean(meta.structuredData),
      breadcrumbs: meta.breadcrumbs.length,
    });
  }

  const report = {
    database: dbPath,
    baseUrl: config.appBaseUrl,
    generatedAt: new Date().toISOString(),
    totals: { movies, series },
    coverage,
    duplicates,
    archives,
    sitemaps,
    sitemapTotalUrls: sitemaps.reduce((sum, s) => sum + s.urls, 0),
    samples,
  };

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`SEO audit — ${dbPath}`);
  console.log(`Base URL: ${config.appBaseUrl}`);
  console.log(`Movies: ${movies}, Series: ${series}\n`);

  console.log('Coverage:');
  for (const [kind, fields] of Object.entries(coverage)) {
    const total = kind === 'movies' ? movies : series;
    console.log(`  ${kind}`);
    for (const [field, count] of Object.entries(fields)) {
      console.log(`    ${field.padEnd(10)} ${String(count).padStart(6)}  (${pct(count, total)})`);
    }
  }

  console.log('\nDuplicate entity titles (top 15):');
  for (const [kind, rows] of Object.entries(duplicates)) {
    if (!rows.length) { console.log(`  ${kind}: none`); continue; }
    console.log(`  ${kind}:`);
    for (const row of rows) console.log(`    ${row.c}× ${row.value}`);
  }

  console.log('\nArchives:');
  console.log(`  genres with movies:    ${archives.genresWithMovies} / ${archives.totalGenres}`);
  console.log(`  countries with movies: ${archives.countriesWithMovies} / ${archives.totalCountries}`);
  console.log(`  years with movies:     ${archives.yearsWithMovies}`);

  console.log('\nSitemaps:');
  for (const s of sitemaps) console.log(`  ${s.name.padEnd(12)} ${String(s.urls).padStart(6)} URLs`);
  console.log(`  total: ${report.sitemapTotalUrls} URLs`);

  console.log('\nSampled detail metadata:');
  for (const s of samples) {
    console.log(`  ${s.path}`);
    console.log(`    title (${s.titleLength}): ${s.title}`);
    console.log(`    desc (${s.descriptionLength}), robots: ${s.robots}, canonical ok: ${s.canonicalMatchesPath}, json-ld: ${s.hasStructuredData}, crumbs: ${s.breadcrumbs}`);
  }

  const missingPlot = movies - coverage.movies.plot;
  if (missingPlot > 0) {
    console.log(`\nNote: ${missingPlot} published movies have an empty synopsis.`);
    console.log('Run the importer to backfill prose synopses/genres (read-only audit does not write):');
    console.log('  node scripts/import.js');
  }
}

main()
  .catch((err) => {
    console.error('[seo-audit] failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try { db.close(); } catch { /* ignore */ }
  });
