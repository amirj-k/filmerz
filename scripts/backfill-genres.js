'use strict';
/**
 * backfill-genres.js — rebuild movie → genre associations from the crawl.
 *
 * The normalized catalogue only stores `movie_genres`; genres live in the
 * crawler prose (e.g. «فیلمی در ژانر اکشن جنایی …»). When that relation table
 * is empty (or partially filled), this script re-parses one row per source
 * page and unions the parsed genres into `movie_genres` without touching any
 * other movie field or removing genres that were added by hand.
 *
 * Usage:
 *   node scripts/backfill-genres.js             # write
 *   node scripts/backfill-genres.js --dry-run   # report only
 *   node scripts/backfill-genres.js --quiet
 */
const config = require('../src/config');
const { openAppDb, openLinksDbReadOnly } = require('../src/db');
const { parseRow } = require('../src/parser');
const queries = require('../src/queries');

const QUIET = process.argv.includes('--quiet');
const DRY_RUN = process.argv.includes('--dry-run');
const log = (m) => { if (!QUIET) console.log(m); };

const db = openAppDb(config.appDbPath);
const src = openLinksDbReadOnly(config.linksDbPath);

/** One source row per page: the one with the richest description. */
function collectSource(kind) {
  const byPage = new Map();
  const rows = src.prepare(
    'SELECT page, title, url, text, description FROM links WHERE kind = ?'
  );
  for (const row of rows.iterate(kind)) {
    const prev = byPage.get(row.page);
    if (!prev || (row.description || '').length > (prev.description || '').length) {
      byPage.set(row.page, row);
    }
  }
  return byPage;
}

const sourceByPage = collectSource('movie');
const movies = db.prepare('SELECT id, source_page FROM movies').all();
const insertGenre = db.prepare(
  'INSERT OR IGNORE INTO movie_genres (movie_id, genre_id) VALUES (?, ?)'
);
const findGenre = db.prepare('SELECT 1 FROM movie_genres WHERE movie_id = ? AND genre_id = ?');

let withSource = 0;
let withGenres = 0;
let linksAdded = 0;
let moviesChanged = 0;
let skippedNoSource = 0;

if (!DRY_RUN) db.exec('BEGIN');
try {
  for (const movie of movies) {
    const source = movie.source_page ? sourceByPage.get(movie.source_page) : null;
    if (!source) { skippedNoSource++; continue; }
    withSource++;

    const parsed = parseRow(source);
    if (!parsed.genres.length) continue;
    withGenres++;

    let added = 0;
    for (const name of parsed.genres) {
      const genre = queries.getOrCreateGenre(db, name);
      if (!genre) continue;
      if (findGenre.get(movie.id, genre.id)) continue;
      if (!DRY_RUN) insertGenre.run(movie.id, genre.id);
      added++;
    }
    if (added) {
      linksAdded += added;
      moviesChanged++;
    }
  }
  if (!DRY_RUN) db.exec('COMMIT');
} catch (err) {
  if (!DRY_RUN) db.exec('ROLLBACK');
  throw err;
}

log(`[genres] source pages: ${sourceByPage.size}, matched movies: ${withSource}, without source page: ${skippedNoSource}`);
log(`[genres] movies with parsed genres: ${withGenres}, movies changed: ${moviesChanged}, links added: ${linksAdded}`);
if (DRY_RUN) log('[genres] dry run — no changes written');

src.close();
db.close();
