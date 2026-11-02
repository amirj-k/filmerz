'use strict';
/**
 * migrate.js — safe, repeatable schema upgrade for the application database.
 *
 *   1. Takes an online backup with `VACUUM INTO` (works while the app runs).
 *   2. Applies the idempotent schema (CREATE TABLE/INDEX IF NOT EXISTS + the
 *      additive column checks). Existing catalogue rows are never modified.
 *   3. Prints a short verification report.
 *
 * Usage:
 *   node scripts/migrate.js [--no-backup] [--out dir] [--keep N]
 *
 * The same schema also self-applies on every application boot, so running
 * this script is optional — it exists so operators can take a verified
 * backup *before* a deploy and confirm the result.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { applySchema } = require('../src/schema');

const args = process.argv.slice(2);
const getArg = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const noBackup = args.includes('--no-backup');
const appDb = process.env.APP_DB_PATH || process.env.APP_DB || path.join(__dirname, '..', 'data', 'app.db');
const outDir = path.resolve(getArg('--out', path.join(__dirname, '..', 'backups')));
const keep = parseInt(getArg('--keep', '7'), 10) || 7;

if (!fs.existsSync(appDb)) {
  console.error(`[migrate] App database not found at ${appDb}`);
  console.error('[migrate] Start the app once, or set APP_DB_PATH to the existing app.db.');
  process.exit(1);
}

function backup() {
  fs.mkdirSync(outDir, { recursive: true });
  // Millisecond precision + a collision suffix: two runs in the same second
  // must never make VACUUM INTO fail with "output file already exists".
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = path.join(outDir, `app-pre-migrate-${stamp}.db`);
  let n = 1;
  while (fs.existsSync(target)) {
    n += 1;
    target = path.join(outDir, `app-pre-migrate-${stamp}-${n}.db`);
  }
  const conn = new DatabaseSync(appDb);
  try {
    conn.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    conn.close();
  }
  const files = fs.readdirSync(outDir)
    .filter((f) => /^app-.*\.db$/.test(f))
    .sort()
    .reverse();
  for (const old of files.slice(keep)) {
    try { fs.unlinkSync(path.join(outDir, old)); } catch { /* ignore */ }
  }
  const size = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
  console.log(`[migrate] backup OK → ${target} (${size} MB)`);
  return target;
}

function tableCounts(db) {
  const tables = ['movies', 'series', 'episodes', 'users', 'user_sessions', 'user_favorites'];
  const out = {};
  for (const table of tables) {
    try {
      out[table] = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    } catch {
      out[table] = null;
    }
  }
  return out;
}

if (!noBackup) {
  try {
    backup();
  } catch (err) {
    console.error('[migrate] backup FAILED:', (err && err.message) || err);
    console.error('[migrate] Aborting without touching the database. Fix the backup path or use --no-backup (not recommended).');
    process.exit(1);
  }
}

const db = new DatabaseSync(appDb);
try {
  applySchema(db);
  console.log('[migrate] schema applied (idempotent)');
  console.log('[migrate] row counts:', tableCounts(db));
  console.log('[migrate] schema_version:', db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 'unset');
  const integrity = db.prepare('PRAGMA quick_check').get();
  console.log('[migrate] quick_check:', Object.values(integrity)[0]);
} catch (err) {
  console.error('[migrate] FAILED:', (err && err.message) || err);
  console.error('[migrate] The database was not modified destructively; restore the backup above if needed.');
  process.exitCode = 1;
} finally {
  db.close();
}
