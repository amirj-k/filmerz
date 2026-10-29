'use strict';

/**
 * Canonical "Top 250" list loaded from top 250.txt and matched against the
 * local catalog. Entries without a local movie are kept (rank + title + year)
 * so the page still shows the full list, but they are not linked.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { normSearch } = require('./normalizer');
const { plausibleYear } = require('./parser');

const LIST_PATH = path.join(config.rootDir, 'top 250.txt');
const CACHE_TTL = 5 * 60 * 1000;

let cache = null;

function compactKey(title) {
  let n = normSearch(title);
  n = n.replace(/^the\s+/, '');
  return n.replace(/\s+/g, '');
}

/** Compact key plus a variant with a trailing 4-digit year removed («City of God 2002»). */
function keyVariants(title) {
  const base = compactKey(title);
  const out = new Set([base]);
  const noYear = base.replace(/\d{4}$/, '');
  if (noYear) out.add(noYear);
  return [...out].filter(Boolean);
}

/** Only strip a trailing year when it is the film's actual year («City of God 2002»). */
function movieKeyVariants(movie) {
  const base = compactKey(movie.title_en || movie.title_fa || '');
  const out = new Set([base]);
  const m = base.match(/(\d{4})$/);
  if (m && movie.year && Number(m[1]) === movie.year) {
    const noYear = base.slice(0, -4);
    if (noYear) out.add(noYear);
  }
  return [...out].filter(Boolean);
}

function parseList() {
  const text = fs.readFileSync(LIST_PATH, 'utf8');
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\.\s+(.*?)\s*\((\d{4})\)\s*$/);
    if (!m) continue;
    entries.push({
      rank: parseInt(m[1], 10),
      title: m[2].trim(),
      year: parseInt(m[3], 10),
      key: compactKey(m[2]),
    });
  }
  return entries;
}

function urlYears(url) {
  const years = [];
  try {
    const file = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    const re = /(?<!\d)(1[234]\d{2}|18\d{2}|19\d{2}|20\d{2})(?!\d)/g;
    let m;
    while ((m = re.exec(file)) !== null) {
      const y = parseInt(m[1], 10);
      if (plausibleYear(y) && !years.includes(y)) years.push(y);
    }
  } catch { /* ignore malformed urls */ }
  return years;
}

function build(db, entries) {
  const movies = db.prepare(
    `SELECT id, slug, title_en, title_fa, year, poster_url, poster_valid
       FROM movies
      WHERE published = 1 AND (title_en != '' OR title_fa != '')`
  ).all();

  // The crawl description often has a wrong year, but the download file name
  // usually carries the real release year. Use it as a second signal.
  const fileYears = new Map();
  const linkRows = db.prepare('SELECT movie_id, url FROM links').all();
  for (const link of linkRows) {
    const years = urlYears(link.url);
    if (!years.length) continue;
    if (!fileYears.has(link.movie_id)) fileYears.set(link.movie_id, new Set());
    for (const y of years) fileYears.get(link.movie_id).add(y);
  }

  const byYearKey = new Map();
  const byYear = new Map();
  const byFileYearKey = new Map();
  const byFileYear = new Map();
  const byKey = new Map();

  for (const movie of movies) {
    const keys = movieKeyVariants(movie);
    if (!keys.length) continue;
    const fys = fileYears.get(movie.id);
    if (movie.year) {
      if (!byYear.has(movie.year)) byYear.set(movie.year, []);
      byYear.get(movie.year).push({ movie, keys });
      for (const key of keys) byYearKey.set(`${movie.year}|${key}`, movie);
    }
    if (fys && fys.size) {
      for (const fy of fys) {
        if (!byFileYear.has(fy)) byFileYear.set(fy, []);
        byFileYear.get(fy).push({ movie, keys });
        for (const key of keys) byFileYearKey.set(`${fy}|${key}`, movie);
      }
    }
    for (const key of keys) {
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key).add(movie);
    }
  }

  const matchYear = (map, year, entryKeys) => {
    for (const key of entryKeys) {
      const hit = map.get(`${year}|${key}`);
      if (hit) return hit;
    }
    return null;
  };

  const matchPrefix = (map, year, entryKeys) => (
    (map.get(year) || []).find(({ keys }) => keys.some((k) => entryKeys.some((ek) => (
      k.length >= 5 && ek.length >= 5 && (k.startsWith(ek) || ek.startsWith(k))
    ))))?.movie || null
  );

  const matchNear = (year, entryKeys) => {
    let best = null;
    let bestDist = Infinity;
    for (const key of entryKeys) {
      for (const candidate of byKey.get(key) || []) {
        const candidateYears = [candidate.year, ...(fileYears.get(candidate.id) || [])].filter(Boolean);
        for (const cy of candidateYears) {
          const dist = Math.abs(cy - year);
          if (dist <= 2 && dist < bestDist) { best = candidate; bestDist = dist; }
        }
      }
    }
    return best;
  };

  return entries.map((entry) => {
    const entryKeys = keyVariants(entry.title);
    let movie = matchYear(byYearKey, entry.year, entryKeys)
      || matchYear(byFileYearKey, entry.year, entryKeys)
      || matchPrefix(byYear, entry.year, entryKeys)
      || matchPrefix(byFileYear, entry.year, entryKeys)
      || matchNear(entry.year, entryKeys);

    // Exact title present exactly once and no usable year at all → accept.
    if (!movie) {
      const unique = new Set();
      for (const key of entryKeys) for (const m of byKey.get(key) || []) unique.add(m);
      if (unique.size === 1) {
        const only = [...unique][0];
        if (only.year == null && !fileYears.has(only.id)) movie = only;
      }
    }

    return { rank: entry.rank, title: entry.title, year: entry.year, movie };
  });
}

function getTop250(db) {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.items;
  const items = build(db, parseList());
  cache = { at: Date.now(), items };
  return items;
}

module.exports = { getTop250, parseList, compactKey };
