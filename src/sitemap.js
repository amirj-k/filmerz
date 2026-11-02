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
 */

const SITEMAP_BATCH_SIZE = 50000;

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
  }

  /**
   * Sitemaps worth advertising: only ones that currently contain URLs.
   * Keeps `empty` sitemaps out of the index so GSC doesn't flag them.
   */
  listSitemaps() {
    const has = (sql) => !!this.db.prepare(sql).get();
    const names = [
      ['movies-1', 'SELECT 1 AS x FROM movies WHERE published = 1 LIMIT 1'],
      ['series-1', 'SELECT 1 AS x FROM series WHERE published = 1 LIMIT 1'],
      ['genres-1', `SELECT 1 AS x FROM genres g
        WHERE EXISTS (
          SELECT 1 FROM movie_genres mg
            JOIN movies m ON m.id = mg.movie_id
           WHERE mg.genre_id = g.id AND m.published = 1
        ) LIMIT 1`],
      // /person/:idSlug has no route yet, so those URLs would be 404s.
      // Re-add 'people-1' here once the person pages exist.
      ['top250-1', null],
    ];

    return names
      .filter(([, sql]) => (sql ? has(sql) : true))
      .map(([name]) => ({
        name,
        loc: `${this.siteUrl}/sitemaps/${name}.xml`,
      }));
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

  /**
   * Generate genres sitemap (genre-filtered movie listings).
   */
  async generateGenresSitemap() {
    // Only genres that actually have published movies: an empty listing is
    // a soft-404 for Google.
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

    const entries = genres.map((g) => urlEntry(
      `${this.siteUrl}/movies?genre=${encodeURIComponent(g.slug)}`,
      today(),
      'monthly',
      '0.6'
    ));

    entries.push(urlEntry(`${this.siteUrl}/genres`, today(), 'weekly', '0.7'));

    return urlset(entries);
  }

  /**
   * Generate top250 sitemap.
   */
  async generateTop250Sitemap() {
    return urlset([
      urlEntry(`${this.siteUrl}/top250`, today(), 'monthly', '0.9'),
    ]);
  }

  /**
   * Get all static sitemap definitions.
   */
  getSitemapFiles() {
    return [
      { name: 'movies-1', generator: () => this.generateMoviesSitemap(1) },
      { name: 'series-1', generator: () => this.generateSeriesSitemap(1) },
      { name: 'genres-1', generator: () => this.generateGenresSitemap() },
      { name: 'top250-1', generator: () => this.generateTop250Sitemap() },
    ];
  }

  /**
   * Get every non-empty sitemap (used by tests / single-file exports).
   */
  async getAllSitemapFiles() {
    const files = [];

    for (const sitemap of this.getSitemapFiles()) {
      const xml = await sitemap.generator();
      if (xml) {
        files.push({
          name: sitemap.name,
          xml,
          contentType: 'application/xml',
        });
      }
    }

    return files;
  }
}

module.exports = { SitemapGenerator, xmlEscape };
