'use strict';

const config = require('./config');

/**
 * Sitemap generation system.
 * Generates XML sitemaps for the Filmerz website.
 *
 * Notes:
 * - Every value interpolated into XML is escaped: a single unescaped `&`
 *   (or `<`) in a slug/date makes the whole document unreadable for Google
 *   Search Console ("Start tag expected, '<' not found").
 * - Empty sitemaps are not advertised in the index; GSC reports them as
 *   "0 URLs discovered", which looks like a failure.
 * - Only canonical, indexable URLs are listed. Filtered listing URLs and
 *   internal search pages are excluded on purpose.
 * - Files are cached in memory for a short TTL: generating a 9k-row sitemap
 *   on every crawler hit is pure waste, and the underlying data changes only
 *   when an import runs.
 */

const SITEMAP_BATCH_SIZE = 50000;
const CACHE_TTL_MS = 10 * 60 * 1000;

function xmlEscape(value) {
  return String(value === null || value === undefined ? '' : value)
    // XML 1.0 forbids most C0 control characters outright; one of them in a
    // slug makes the whole sitemap unreadable ("Start tag expected").
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function today() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Normalise a DB timestamp into something a sitemap validator accepts.
 * Falls back to today when the value is missing or unparseable.
 */
function normalizeLastmod(value) {
  if (!value) return today();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return today();
  return d.toISOString();
}

function urlEntry(loc, lastmod, changefreq, priority) {
  return `  <url>
    <loc>${xmlEscape(loc)}</loc>
    <lastmod>${xmlEscape(lastmod)}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

function urlset(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>
`;
}

class SitemapGenerator {
  constructor(db) {
    this.db = db;
    // Must match SEOEngine.canonicalUrl so sitemap <loc> values and <link
    // rel="canonical"> never disagree.
    this.siteUrl = config.appBaseUrl;
    this.cache = new Map();
  }

  /**
   * SQLite bumps `data_version` when another connection commits. The importer
   * runs in its own process, so this is how the HTTP process notices that the
   * catalogue changed and drops its sitemap cache without a restart.
   */
  dataVersion() {
    try {
      const row = this.db.prepare('PRAGMA data_version').get();
      return row && row.data_version !== undefined ? String(row.data_version) : '';
    } catch {
      return '';
    }
  }

  /** Read through the short-lived in-memory cache. */
  async cached(key, producer) {
    const hit = this.cache.get(key);
    const now = Date.now();
    const version = this.dataVersion();
    if (hit && hit.expires > now && hit.version === version) return hit.value;
    const value = await producer();
    this.cache.set(key, { value, expires: now + CACHE_TTL_MS, version });
    return value;
  }

  /** Drop every cached sitemap (called after an import). */
  invalidate() {
    this.cache.clear();
  }

  /**
   * Sitemaps worth advertising: only ones that currently contain URLs.
   * Keeps `empty` sitemaps out of the index so GSC doesn't flag them.
   */
  listSitemaps() {
    const has = (sql, ...params) => !!this.db.prepare(sql).get(...params);
    const count = (sql) => this.db.prepare(sql).get().c;
    const pagesOf = (total) => Math.max(1, Math.ceil(total / SITEMAP_BATCH_SIZE));

    const sitemaps = [];

    const movies = count('SELECT COUNT(*) AS c FROM movies WHERE published = 1');
    for (let page = 1; page <= pagesOf(movies); page++) {
      sitemaps.push({ name: `movies-${page}`, loc: `${this.siteUrl}/sitemaps/movies-${page}.xml` });
    }

    const series = count('SELECT COUNT(*) AS c FROM series WHERE published = 1');
    for (let page = 1; page <= pagesOf(series); page++) {
      sitemaps.push({ name: `series-${page}`, loc: `${this.siteUrl}/sitemaps/series-${page}.xml` });
    }

    if (has(`SELECT 1 AS x FROM genres g
      WHERE EXISTS (
        SELECT 1 FROM movie_genres mg
          JOIN movies m ON m.id = mg.movie_id
         WHERE mg.genre_id = g.id AND m.published = 1
      ) LIMIT 1`)) {
      sitemaps.push({ name: 'genres-1', loc: `${this.siteUrl}/sitemaps/genres-1.xml` });
    }

    if (has('SELECT 1 AS x FROM movies WHERE published = 1 AND country_id IS NOT NULL LIMIT 1')) {
      sitemaps.push({ name: 'countries-1', loc: `${this.siteUrl}/sitemaps/countries-1.xml` });
    }

    if (has('SELECT 1 AS x FROM movies WHERE published = 1 AND year IS NOT NULL LIMIT 1')) {
      sitemaps.push({ name: 'years-1', loc: `${this.siteUrl}/sitemaps/years-1.xml` });
    }

    // Always non-empty: the home page and the three main archives exist.
    sitemaps.push({ name: 'pages-1', loc: `${this.siteUrl}/sitemaps/pages-1.xml` });

    if (has('SELECT 1 AS x FROM movies WHERE published = 1 LIMIT 1')) {
      sitemaps.push({ name: 'top250-1', loc: `${this.siteUrl}/sitemaps/top250-1.xml` });
    }

    return sitemaps;
  }

  /**
   * Generate movies sitemap.
   */
  async generateMoviesSitemap(page = 1, limit = SITEMAP_BATCH_SIZE) {
    const offset = (page - 1) * limit;
    const movies = this.db.prepare(
      `SELECT id, slug, year, last_link_at, last_seen FROM movies
        WHERE published = 1
        ORDER BY id DESC
        LIMIT ? OFFSET ?`
    ).all(limit, offset);

    if (movies.length === 0) {
      // Page 1 always exists (possibly empty); later pages are 404s.
      return page === 1 ? urlset([]) : null;
    }

    const entries = movies.map((movie) => urlEntry(
      `${this.siteUrl}/movie/${movie.id}-${movie.slug}`,
      normalizeLastmod(movie.last_link_at || movie.last_seen),
      'weekly',
      '0.9'
    ));

    return urlset(entries);
  }

  /**
   * Generate series sitemap.
   */
  async generateSeriesSitemap(page = 1, limit = SITEMAP_BATCH_SIZE) {
    const offset = (page - 1) * limit;
    const series = this.db.prepare(
      `SELECT id, slug, year, last_link_at, last_seen FROM series
        WHERE published = 1
        ORDER BY id DESC
        LIMIT ? OFFSET ?`
    ).all(limit, offset);

    if (series.length === 0) {
      return page === 1 ? urlset([]) : null;
    }

    const entries = series.map((s) => urlEntry(
      `${this.siteUrl}/series/${s.id}-${s.slug}`,
      normalizeLastmod(s.last_link_at || s.last_seen),
      'weekly',
      '0.8'
    ));

    return urlset(entries);
  }

  /**
   * Generate people sitemap.
   * Kept for completeness, but not advertised until /person routes exist.
   */
  async generatePeopleSitemap(page = 1, limit = SITEMAP_BATCH_SIZE) {
    const offset = (page - 1) * limit;
    const people = this.db.prepare(
      `SELECT id, slug, name FROM people
        ORDER BY id DESC
        LIMIT ? OFFSET ?`
    ).all(limit, offset);

    if (people.length === 0) {
      return page === 1 ? urlset([]) : null;
    }

    const entries = people.map((p) => urlEntry(
      `${this.siteUrl}/person/${p.id}-${p.slug}`,
      today(),
      'monthly',
      '0.5'
    ));

    return urlset(entries);
  }

  /** Main static pages: one canonical URL each. */
  async generatePagesSitemap() {
    const entries = [
      urlEntry(`${this.siteUrl}/`, today(), 'daily', '1.0'),
      urlEntry(`${this.siteUrl}/movies`, today(), 'daily', '0.9'),
      urlEntry(`${this.siteUrl}/series`, today(), 'daily', '0.9'),
    ];
    // /genres is a thin page (and noindex) until genres have movies.
    const hasGenres = this.db.prepare(
      `SELECT 1 AS x FROM genres g
        WHERE EXISTS (
          SELECT 1 FROM movie_genres mg
            JOIN movies m ON m.id = mg.movie_id
           WHERE mg.genre_id = g.id AND m.published = 1
        ) LIMIT 1`
    ).get();
    if (hasGenres) entries.push(urlEntry(`${this.siteUrl}/genres`, today(), 'weekly', '0.7'));
    return urlset(entries);
  }

  /**
   * Genre archives: /genre/:slug, the canonical home of a genre filter.
   * Only genres that actually have published movies are listed; an empty
   * archive returns a real 404 and must never appear in a sitemap.
   */
  async generateGenresSitemap() {
    const genres = this.db.prepare(
      `SELECT g.slug, g.name FROM genres g
        WHERE EXISTS (
          SELECT 1 FROM movie_genres mg
            JOIN movies m ON m.id = mg.movie_id
           WHERE mg.genre_id = g.id AND m.published = 1
        )
        ORDER BY g.name`
    ).all();

    if (genres.length === 0) {
      return urlset([]);
    }

    return urlset(genres.map((g) => urlEntry(
      `${this.siteUrl}/genre/${encodeURIComponent(g.slug)}`,
      today(),
      'weekly',
      '0.6'
    )));
  }

  /** Country archives: /country/:slug. */
  async generateCountriesSitemap() {
    const countries = this.db.prepare(
      `SELECT c.slug FROM countries c
        WHERE EXISTS (
          SELECT 1 FROM movies m
           WHERE m.country_id = c.id AND m.published = 1
        )
        ORDER BY c.name`
    ).all();

    if (countries.length === 0) return urlset([]);

    return urlset(countries.map((c) => urlEntry(
      `${this.siteUrl}/country/${encodeURIComponent(c.slug)}`,
      today(),
      'monthly',
      '0.6'
    )));
  }

  /** Year archives: /year/:year. */
  async generateYearsSitemap() {
    const years = this.db.prepare(
      `SELECT year FROM movies
        WHERE published = 1 AND year IS NOT NULL
        GROUP BY year
        ORDER BY year DESC`
    ).all();

    if (years.length === 0) return urlset([]);

    return urlset(years.map((row) => urlEntry(
      `${this.siteUrl}/year/${row.year}`,
      today(),
      'monthly',
      '0.5'
    )));
  }

  /**
   * Generate top250 sitemap.
   */
  async generateTop250Sitemap() {
    return urlset([
      urlEntry(`${this.siteUrl}/top250`, today(), 'monthly', '0.9'),
    ]);
  }
}

module.exports = { SitemapGenerator, xmlEscape, SITEMAP_BATCH_SIZE, CACHE_TTL_MS };
