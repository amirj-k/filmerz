'use strict';

/**
 * Cinematic homepage hero slider data.
 *
 * A small, randomized selection drawn *exclusively* from the existing IMDb
 * Top 250 collection (top 250.txt matched against the local catalog by
 * `src/top250.js`). No new tables, no external services, no hardcoded movies.
 *
 * Design notes / data reality:
 * - The crawl only ever stored 2:3 portrait posters (no landscape backdrops),
 *   so a movie's highest available image is used as the "backdrop" and the
 *   front-end crops it. `hiResPoster()` upgrades the WordPress thumbnail
 *   (`-360x480`) to the largest stored original (usually 600x900).
 * - The catalog does not store an IMDb score. The badge therefore shows the
 *   movie's real IMDb Top 250 rank, and would show `rating` automatically if
 *   one is ever added to a movie row.
 * - The selection is cached for a short TTL: random across visits, but stable
 *   within a page session (and cheap — `top250.getTop250` is itself cached).
 */

const top250 = require('./top250');

// ---------------------------------------------------------------------------
// Single, easily-changed configuration for the hero slider.
// ---------------------------------------------------------------------------
const HERO = {
  /** How many movies the slideshow cycles through. */
  count: 6,
  /** How long a random selection stays cached (stability window). */
  ttlMs: 5 * 60 * 1000,
};

/**
 * Autoplay interval in milliseconds — THE single place to change the speed.
 * Rendered into the markup as `data-autoplay` for public/js/hero-slider.js.
 */
const AUTOPLAY_MS = 2000;

let cache = null; // { at: number, slides: object[] }

/** A movie can appear in the hero only if it has a usable poster. */
function isUsable(movie) {
  return Boolean(movie && movie.id && movie.poster_url && movie.poster_valid);
}

/** Upgrade a WordPress thumbnail poster to the largest stored original. */
function hiResPoster(url) {
  if (!url) return '';
  return String(url).replace(/-\d+x\d+(\.(?:jpe?g|png|webp|gif))$/i, '$1');
}

/** Route a poster through the existing on-disk, host-allowlisted proxy. */
function posterSrc(movie, url) {
  if (!url) return '';
  if (movie.poster_valid === 2) return url; // locally uploaded file
  if (movie.poster_valid === 1) return `/poster?u=${encodeURIComponent(url)}`;
  return '';
}

/** Fisher–Yates shuffle (returns a new array). */
function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** First readable sentence of a synopsis, capped for a hero blurb. */
function firstSentence(text, max = 180) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const match = clean.match(/^.*?[.!?؟…](?:\s|$)/);
  const sentence = match ? match[0].trim() : clean;
  if (sentence.length <= max) return sentence;
  return sentence.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

/** Build the enriched slide list from the cached Top 250 catalog. */
function buildSlides(db) {
  const items = top250.getTop250(db);
  const seen = new Set();
  const candidates = [];

  for (const item of items) {
    const movie = item.movie;
    // Skip unmatched entries and neutralize duplicate matches (a few Top 250
    // titles resolve to the same local movie).
    if (!isUsable(movie) || seen.has(movie.id)) continue;
    seen.add(movie.id);
    candidates.push({ movie, rank: item.rank });
  }

  if (!candidates.length) return [];

  const chosen = shuffle(candidates).slice(0, Math.max(1, HERO.count));
  const ids = chosen.map((c) => c.movie.id);
  const placeholders = ids.map(() => '?').join(',');

  // Genres (rich but optional) — one query for the whole selection.
  const genresById = new Map();
  try {
    const rows = db.prepare(
      `SELECT mg.movie_id AS id, g.name AS name, g.slug AS slug
         FROM movie_genres mg
         JOIN genres g ON g.id = mg.genre_id
        WHERE mg.movie_id IN (${placeholders})
        ORDER BY g.name`
    ).all(...ids);
    for (const row of rows) {
      if (!genresById.has(row.id)) genresById.set(row.id, []);
      genresById.get(row.id).push({ name: row.name, slug: row.slug });
    }
  } catch { /* genres are optional — never fail the hero over them */ }

  // Synopsis (almost always empty in this crawl) — optional.
  const plotById = new Map();
  try {
    const rows = db.prepare(`SELECT id, plot FROM movies WHERE id IN (${placeholders})`).all(...ids);
    for (const row of rows) plotById.set(row.id, row.plot || '');
  } catch { /* optional */ }

  return chosen.map(({ movie, rank }) => {
    // The catalog stores only portrait posters; use the largest available.
    const bestImage = hiResPoster(movie.poster_url);
    const src = posterSrc(movie, bestImage);
    return {
      id: movie.id,
      slug: movie.slug,
      href: `/movie/${movie.id}-${movie.slug}`,
      title: movie.title_en || movie.title_fa || '',
      titleFa: movie.title_fa || '',
      year: movie.year || null,
      rank,
      // No IMDb score in the catalog; the view falls back to the rank badge.
      rating: null,
      // Landscape "backdrop" fallback = best available poster (shared URL).
      backdrop: src,
      poster: src,
      genres: genresById.get(movie.id) || [],
      description: firstSentence(plotById.get(movie.id)),
    };
  });
}

/**
 * Return the current stable selection of hero slides. Never throws — a hero
 * failure must never break the homepage.
 */
function heroSlides(db) {
  if (cache && Date.now() - cache.at < HERO.ttlMs) return cache.slides;
  let slides = [];
  try {
    slides = buildSlides(db);
  } catch (err) {
    console.error('[hero] selection failed:', err && err.message);
    slides = [];
  }
  cache = { at: Date.now(), slides };
  return slides;
}

module.exports = { heroSlides, HERO, AUTOPLAY_MS, hiResPoster };
