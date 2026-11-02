'use strict';
/**
 * Technical SEO regression tests.
 *
 * Runs the real Express app against a throwaway SQLite file with its own
 * movies/series/genres/countries/years, so canonical/robots/JSON-LD/sitemap
 * expectations are checked against real rendered HTML (not mocks).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filmerz-seo-'));
process.env.APP_DB_PATH = path.join(dir, 'app.db');
process.env.NODE_ENV = 'test';

const config = require('../src/config');
const { openAppDb } = require('../src/db');
const { createApp } = require('../src/server');

let db;
let server;
let base;

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function seed() {
  const addCountry = db.prepare('INSERT INTO countries (name, slug, name_norm) VALUES (?, ?, ?)');
  const addGenre = db.prepare('INSERT INTO genres (name, slug, name_norm) VALUES (?, ?, ?)');
  const addPerson = db.prepare('INSERT INTO people (name, slug, name_norm) VALUES (?, ?, ?)');

  addCountry.run('آمریکا', 'usa', 'امریکا');
  addGenre.run('اکشن', 'action', 'اکشن');
  addGenre.run('درام', 'drama', 'درام');
  addPerson.run('کارگردان تست', 'test-director', 'کارگردان تست');
  addPerson.run('بازیگر تست', 'test-actor', 'بازیگر تست');

  const insertMovie = db.prepare(`
    INSERT INTO movies (id, slug, source_page, title_en, title_en_norm, title_fa, title_fa_norm,
      year, country_id, plot, poster_valid, link_count, published, featured, last_link_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, 1, ?, ?)
  `);
  insertMovie.run(
    1, 'main-movie-1', 1, 'Main Movie', 'main movie', 'فیلم اصلی', 'فیلم اصلی',
    2020, 'داستان فیلم آزمایشی برای بررسی متادیتا و ساختار صفحه.', 1, 0, '2024-01-01'
  );

  // Enough rows to exercise pagination with the real perPage value.
  const total = config.perPage + 8;
  for (let i = 2; i <= total; i++) {
    insertMovie.run(
      i, `paged-movie-${i}`, i, `Paged Movie ${i}`, `paged movie ${i}`, '', '',
      2020, `خلاصه فیلم شماره ${i}.`, 0, 0, '2024-01-01'
    );
  }

  db.prepare('INSERT INTO movie_genres (movie_id, genre_id) VALUES (1, 1)').run();
  db.prepare("UPDATE movies SET poster_url = 'https://example.test/poster.jpg', poster_valid = 1 WHERE id = 1").run();
  db.prepare("INSERT INTO movie_people (movie_id, person_id, role) VALUES (1, 1, 'director')").run();
  db.prepare("INSERT INTO movie_people (movie_id, person_id, role) VALUES (1, 2, 'actor')").run();
  db.prepare("INSERT INTO links (movie_id, dedupe_key, url, quality_text, resolution) VALUES (1, 'main', 'https://example.test/main.mkv', '1080p', '1080p')").run();
  db.prepare("UPDATE movies SET link_count = 1 WHERE id = 1").run();

  db.prepare(`
    INSERT INTO series (id, slug, source_page, title_en, title_en_norm, title_fa, title_fa_norm,
      year, country_id, plot, season_count, episode_count, link_count, published, last_link_at)
    VALUES (1, 'test-series-1', 1000, 'Test Series', 'test series', 'سریال تست', 'سریال تست',
      2021, 1, 'داستان سریال آزمایشی برای بررسی صفحه سریال.', 2, 10, 4, 1, '2024-02-01')
  `).run();
  db.prepare('INSERT INTO series_genres (series_id, genre_id) VALUES (1, 1)').run();
  db.prepare("INSERT INTO series_people (series_id, person_id, role) VALUES (1, 1, 'director')").run();
}

function request(pathname, opts = {}) {
  return fetch(base + pathname, { ...opts, redirect: 'manual' });
}

async function html(pathname) {
  const res = await request(pathname);
  return { res, status: res.status, text: await res.text() };
}

function canonicalOf(text) {
  const m = text.match(/<link rel="canonical" href="([^"]+)">/);
  return m ? m[1].replace(/&amp;/g, '&') : '';
}

function robotsOf(text) {
  const m = text.match(/<meta name="robots" content="([^"]+)">/);
  return m ? m[1] : '';
}

function titleOf(text) {
  const m = text.match(/<title>([\s\S]*?)<\/title>/);
  return m ? m[1].trim() : '';
}

function jsonLd(text) {
  return [...text.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => {
      try { return JSON.parse(m[1]); } catch { return null; }
    })
    .filter(Boolean);
}

function h1s(text) {
  return [...text.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)]
    .map((m) => m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
}

test.before(async () => {
  db = openAppDb(config.appDbPath);
  seed();
  server = createApp({ db }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  try { if (db) db.close(); } catch { /* ignore */ }
});

test('home renders one H1, absolute canonical and site JSON-LD', async () => {
  const { res, status, text } = await html('/');
  assert.strictEqual(status, 200);
  assert.strictEqual(h1s(text).length, 1);
  assert.match(h1s(text)[0], /دانلود فیلم/);
  assert.match(robotsOf(text), /index, follow/);
  assert.strictEqual(canonicalOf(text), `${config.appBaseUrl}/`);
  assert.ok(titleOf(text).includes('فیلمرز'));
  const graphs = jsonLd(text);
  const site = graphs.find((g) => Array.isArray(g['@graph']));
  assert.ok(site, 'Organization/WebSite graph present');
  assert.ok(site['@graph'].some((n) => n['@type'] === 'Organization'));
  assert.ok(site['@graph'].some((n) => n['@type'] === 'WebSite'));
  assert.ok(!/meta name="keywords"/i.test(text));
});

test('movie page has entity H1, canonical, Movie JSON-LD and real links', async () => {
  const { status, text } = await html('/movie/1-main-movie-1');
  assert.strictEqual(status, 200);
  assert.strictEqual(h1s(text).length, 1);
  assert.match(h1s(text)[0], /فیلم Main Movie \(2020\)/);
  assert.strictEqual(canonicalOf(text), `${config.appBaseUrl}/movie/1-main-movie-1`);
  assert.match(robotsOf(text), /index, follow/);
  assert.ok(text.includes('/genre/action'));
  assert.ok(text.includes('/country/usa'));
  assert.ok(text.includes('/year/2020'));
  assert.ok(/<h2[^>]*>داستان فیلم<\/h2>/.test(text));
  assert.ok(/<h2[^>]*>بازیگران و عوامل<\/h2>/.test(text));

  const movie = jsonLd(text).find((x) => x['@type'] === 'Movie');
  assert.ok(movie, 'Movie JSON-LD present');
  assert.strictEqual(movie.name, 'Main Movie');
  assert.deepStrictEqual(movie.genre, ['اکشن']);
  assert.ok(movie.director.some((d) => d.name === 'کارگردان تست'));
  assert.ok(movie.actor.some((a) => a.name === 'بازیگر تست'));
  assert.strictEqual(movie.aggregateRating, undefined, 'no fabricated rating');
  assert.strictEqual(movie.datePublished, undefined, 'no fabricated date');
  assert.ok(jsonLd(text).some((x) => x['@type'] === 'BreadcrumbList'));

  const img = text.match(/<img[^>]*class="[^"]*series-poster[^"]*"|<img[^>]*fetchpriority="high"[^>]*>/);
  assert.ok(text.includes('fetchpriority="high"'), 'main poster is not lazy');
  assert.match(text, /<img[^>]*alt="پوستر فیلم Main Movie \(2020\)"[^>]*>/);
  assert.match(text, /<img[^>]*width="300"[^>]*height="450"[^>]*>/);
});

test('series page uses seriesDetail metadata and TVSeries JSON-LD', async () => {
  const { status, text } = await html('/series/1-test-series-1');
  assert.strictEqual(status, 200);
  assert.strictEqual(h1s(text).length, 1);
  assert.match(h1s(text)[0], /^سریال Test Series$/);
  assert.strictEqual(canonicalOf(text), `${config.appBaseUrl}/series/1-test-series-1`);
  assert.match(robotsOf(text), /index, follow/);
  const tv = jsonLd(text).find((x) => x['@type'] === 'TVSeries');
  assert.ok(tv, 'TVSeries JSON-LD present');
  assert.strictEqual(tv.numberOfSeasons, 2);
  assert.strictEqual(tv.numberOfEpisodes, 10);
  assert.ok(/<h2[^>]*>داستان سریال<\/h2>/.test(text));
});

test('genre/country/year archives are canonical and indexable', async () => {
  const genre = await html('/genre/action');
  assert.strictEqual(genre.status, 200);
  assert.strictEqual(canonicalOf(genre.text), `${config.appBaseUrl}/genre/action`);
  assert.match(robotsOf(genre.text), /index, follow/);
  assert.strictEqual(h1s(genre.text).length, 1);
  assert.match(h1s(genre.text)[0], /اکشن/);

  const country = await html('/country/usa');
  assert.strictEqual(country.status, 200);
  assert.strictEqual(canonicalOf(country.text), `${config.appBaseUrl}/country/usa`);
  assert.match(h1s(country.text)[0], /آمریکا/);

  const year = await html('/year/2020');
  assert.strictEqual(year.status, 200);
  assert.strictEqual(canonicalOf(year.text), `${config.appBaseUrl}/year/2020`);
  assert.match(h1s(year.text)[0], /2020/);
});

test('single filters canonicalise to their dedicated archive URL', async () => {
  const genre = await html('/movies?genre=action');
  assert.strictEqual(canonicalOf(genre.text), `${config.appBaseUrl}/genre/action`);

  const year = await html('/movies?year=2020');
  assert.strictEqual(canonicalOf(year.text), `${config.appBaseUrl}/year/2020`);

  const country = await html('/movies?country=usa');
  assert.strictEqual(canonicalOf(country.text), `${config.appBaseUrl}/country/usa`);

  // Tracking/sort parameters never enter the canonical.
  const detail = await html('/movie/1-main-movie-1?utm_source=test&sort=year');
  assert.strictEqual(canonicalOf(detail.text), `${config.appBaseUrl}/movie/1-main-movie-1`);
});

test('pagination canonicalises to itself and out-of-range pages 301', async () => {
  const page2 = await html('/movies?page=2');
  assert.strictEqual(page2.status, 200);
  assert.strictEqual(canonicalOf(page2.text), `${config.appBaseUrl}/movies?page=2`);
  assert.match(robotsOf(page2.text), /index, follow/);

  const page1 = await html('/movies?page=1');
  assert.strictEqual(canonicalOf(page1.text), `${config.appBaseUrl}/movies`);

  const overflow = await request('/movies?page=999');
  assert.strictEqual(overflow.status, 301);
  assert.match(overflow.headers.get('location'), /\/movies(\?page=\d+)?$/);
});

test('internal search is always noindex, canonical to /search, and out of sitemaps', async () => {
  const { status, text } = await html('/search?q=main');
  assert.strictEqual(status, 200);
  assert.strictEqual(robotsOf(text), 'noindex, follow');
  assert.strictEqual(canonicalOf(text), `${config.appBaseUrl}/search`);
  assert.strictEqual(h1s(text).length, 1);

  const index = await html('/sitemap.xml');
  assert.strictEqual(index.status, 200);
  assert.ok(index.text.includes('<sitemapindex'));
  assert.ok(!index.text.includes('/search'));
});

test('empty archives return a real 404 with no canonical', async () => {
  for (const p of ['/genre/does-not-exist', '/country/does-not-exist', '/year/1800', '/year/9999']) {
    const { status, text } = await html(p);
    assert.strictEqual(status, 404, p);
    assert.strictEqual(robotsOf(text), 'noindex, follow', p);
    assert.strictEqual(canonicalOf(text), '', p);
  }
});

test('sitemaps advertise only canonical archive URLs and stay XML', async () => {
  const index = await html('/sitemap.xml');
  assert.strictEqual(index.status, 200);
  assert.ok(index.text.includes('/sitemaps/movies-1.xml'));
  assert.ok(index.text.includes('/sitemaps/genres-1.xml'));
  assert.ok(index.text.includes('/sitemaps/countries-1.xml'));
  assert.ok(index.text.includes('/sitemaps/years-1.xml'));
  assert.ok(index.text.includes('/sitemaps/pages-1.xml'));

  const movies = await html('/sitemaps/movies-1.xml');
  assert.strictEqual(movies.status, 200);
  assert.ok(movies.text.includes('/movie/1-main-movie-1'));
  assert.ok(!movies.text.includes('/search'));

  const genres = await html('/sitemaps/genres-1.xml');
  assert.ok(genres.text.includes('/genre/action'));
  assert.ok(!genres.text.includes('/movies?genre='));

  const countries = await html('/sitemaps/countries-1.xml');
  assert.ok(countries.text.includes('/country/usa'));

  const years = await html('/sitemaps/years-1.xml');
  assert.ok(years.text.includes('/year/2020'));

  const pages = await html('/sitemaps/pages-1.xml');
  assert.ok(pages.text.includes(`${config.appBaseUrl}/movies`));
  assert.ok(pages.text.includes(`${config.appBaseUrl}/genres`));

  const unknown = await html('/sitemaps/does-not-exist.xml');
  assert.strictEqual(unknown.status, 404);
  assert.ok(unknown.text.startsWith('<?xml'));
});

test('robots.txt allows public assets, blocks private areas and points at the sitemap', async () => {
  const { status, text } = await html('/robots.txt');
  assert.strictEqual(status, 200);
  assert.ok(text.includes('User-agent: *'));
  assert.ok(text.includes('Disallow: /admin'));
  assert.ok(text.includes('Disallow: /account'));
  assert.ok(text.includes('Allow: /css/'));
  assert.ok(text.includes('Allow: /js/'));
  assert.ok(text.includes(`Sitemap: ${config.appBaseUrl}/sitemap.xml`));
  assert.ok(!/Disallow: \/$/m.test(text));
});

test('unknown routes return status 404 and zero canonical tags', async () => {
  const { status, text } = await html('/this-page-does-not-exist');
  assert.strictEqual(status, 404);
  assert.strictEqual(robotsOf(text), 'noindex, follow');
  assert.strictEqual(canonicalOf(text), '');
  assert.strictEqual(h1s(text).length, 1);
});

test('titles/descriptions differ for list, entity and archive pages', async () => {
  const pages = await Promise.all([
    html('/movies'),
    html('/movie/1-main-movie-1'),
    html('/series/1-test-series-1'),
    html('/genre/action'),
    html('/country/usa'),
    html('/year/2020'),
    html('/genres'),
  ]);
  const titles = pages.map((p) => titleOf(p.text));
  const descriptions = pages.map((p) => {
    const m = p.text.match(/<meta name="description" content="([^"]*)">/);
    return m ? m[1] : '';
  });
  assert.strictEqual(new Set(titles).size, titles.length, `titles must be unique: ${escape(titles.join(' | '))}`);
  assert.ok(descriptions.every(Boolean), 'every page has a description');
  assert.strictEqual(new Set(descriptions).size, descriptions.length, 'descriptions must be unique');
});

test('sitemap cache refreshes when another connection writes the database', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { SitemapGenerator } = require('../src/sitemap');
  const { applySchema } = require('../src/schema');

  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filmerz-sitemap-cache-'));
  const cacheDb = path.join(cacheDir, 'app.db');
  const reader = new DatabaseSync(cacheDb);
  applySchema(reader);
  const writer = new DatabaseSync(cacheDb);
  const insert = writer.prepare("INSERT INTO movies (slug, title_en, published) VALUES (?, ?, 1)");
  insert.run('cache-1', 'Cache One');

  const generator = new SitemapGenerator(reader);
  const locs = (xml) => (xml.match(/<loc>/g) || []).length;
  const a = locs(await generator.cached('movies:1', () => generator.generateMoviesSitemap(1)));
  const b = locs(await generator.cached('movies:1', () => generator.generateMoviesSitemap(1)));
  assert.strictEqual(a, 1);
  assert.strictEqual(b, 1, 'cache hit while the database is unchanged');

  insert.run('cache-2', 'Cache Two');
  const c = locs(await generator.cached('movies:1', () => generator.generateMoviesSitemap(1)));
  assert.strictEqual(c, 2, 'external write invalidates the cached sitemap');

  reader.close();
  writer.close();
});
