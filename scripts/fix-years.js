'use strict';
/**
 * fix-years.js — repair impossible or wrong crawl years.
 * Re-parses the original crawl row with the current parser and stores the
 * valid year, or NULL when no plausible year exists.
 *
 * Usage:
 *   node scripts/fix-years.js                # impossible years only
 *   node scripts/fix-years.js --all          # re-derive every year
 *   node scripts/fix-years.js --all --movies-only
 *   node scripts/fix-years.js --all --series-only
 */
const config = require('../src/config');
const { openAppDb, openLinksDbReadOnly } = require('../src/db');
const { parseRow, plausibleYear, MAX_FUTURE_YEAR } = require('../src/parser');

const QUIET = process.argv.includes('--quiet');
const ALL = process.argv.includes('--all');
const MOVIES_ONLY = process.argv.includes('--movies-only');
const SERIES_ONLY = process.argv.includes('--series-only');
const log = (m) => { if (!QUIET) console.log(m); };

const db = openAppDb(config.appDbPath);
const src = openLinksDbReadOnly(config.linksDbPath);

const isImpossible = `year IS NOT NULL AND (year > ? OR (year < 1880 AND year NOT BETWEEN 1300 AND 1499))`;

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

function repair(table, kind, sourceByPage) {
  const rows = ALL
    ? db.prepare(`SELECT id, source_page, year FROM ${table}`).all()
    : db.prepare(`SELECT id, source_page, year FROM ${table} WHERE ${isImpossible}`).all(MAX_FUTURE_YEAR);
  let checked = 0;
  let changed = 0;
  const update = db.prepare(`UPDATE ${table} SET year = ? WHERE id = ?`);
  for (const row of rows) {
    let year = null;
    const source = row.source_page ? sourceByPage.get(row.source_page) : null;
    if (source) year = parseRow(source).year;
    // --all must not wipe a plausible stored year when the crawl row simply
    // has no year information; only impossible values are cleared.
    if (year == null && ALL && row.year != null && plausibleYear(row.year)) year = row.year;
    checked++;
    if (year !== row.year) {
      update.run(year, row.id);
      changed++;
      log(`[years] ${table}#${row.id}: ${row.year == null ? 'NULL' : row.year} → ${year == null ? 'NULL' : year}`);
    }
  }
  log(`[years] ${table}: ${checked} checked, ${changed} repaired`);
  return changed;
}

let total = 0;
db.exec('BEGIN');
try {
  if (!SERIES_ONLY) {
    total += repair('movies', 'movie', collectSource('movie'));
  }
  if (!MOVIES_ONLY) {
    total += repair('series', 'series', collectSource('series'));
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

log(`[years] done — ${total} record(s) repaired`);
src.close();
db.close();
