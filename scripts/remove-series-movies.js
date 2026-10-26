'use strict';
/**
 * remove-series-movies.js — delete movie rows that are really crawler series.
 *
 * The first import ran before kind filtering, so every series page in links.db
 * also got a `/movie/...` row. This script removes those duplicate movie
 * records (links, genres, people and FTS entries) and leaves the real series
 * tables untouched.
 *
 * Usage: node scripts/remove-series-movies.js [--quiet]
 */
const config = require('../src/config');
const { openAppDb, openLinksDbReadOnly } = require('../src/db');

const QUIET = process.argv.includes('--quiet');
const log = (m) => { if (!QUIET) console.log(m); };

const db = openAppDb(config.appDbPath);
const src = openLinksDbReadOnly(config.linksDbPath);

const seriesPages = new Set(
  src.prepare("SELECT DISTINCT page FROM links WHERE kind = 'series'").all().map((r) => r.page)
);
const rows = db.prepare('SELECT id, source_page, title_en, title_fa FROM movies WHERE source_page IS NOT NULL').all()
  .filter((m) => seriesPages.has(m.source_page));

const before = db.prepare('SELECT COUNT(*) c FROM movies').get().c;
if (!rows.length) {
  log('[movies] no series-backed movie rows found');
  src.close();
  db.close();
  return;
}

const delFts = db.prepare('DELETE FROM movies_fts WHERE movie_id = ?');
const delLinks = db.prepare('DELETE FROM links WHERE movie_id = ?');
const delGenres = db.prepare('DELETE FROM movie_genres WHERE movie_id = ?');
const delPeople = db.prepare('DELETE FROM movie_people WHERE movie_id = ?');
const delMovie = db.prepare('DELETE FROM movies WHERE id = ?');

db.exec('BEGIN');
try {
  for (const row of rows) {
    delFts.run(row.id);
    delLinks.run(row.id);
    delGenres.run(row.id);
    delPeople.run(row.id);
    delMovie.run(row.id);
  }
  db.exec("DELETE FROM wishlist_items WHERE item_type = 'movie' AND item_id NOT IN (SELECT id FROM movies)");
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

const after = db.prepare('SELECT COUNT(*) c FROM movies').get().c;
const links = db.prepare('SELECT COUNT(*) c FROM links').get().c;
log(`[movies] removed ${rows.length} series-backed movie rows (${before} → ${after}); movie links left: ${links}`);
if (rows.length) {
  log(`[movies] examples: ${rows.slice(0, 5).map((r) => `${r.id}:${r.title_en || r.title_fa}`).join(' | ')}`);
}

src.close();
db.close();
