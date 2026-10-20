'use strict';
/**
 * backup.js — online SQLite backup via `VACUUM INTO` (safe while the app runs).
 * Keeps the newest KEEP files, deletes older ones.
 *
 * Usage: node scripts/backup.js [--out dir] [--keep N]
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
const getArg = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};

const appDb = process.env.APP_DB || path.join(__dirname, '..', 'data', 'app.db');
const outDir = path.resolve(getArg('--out', path.join(__dirname, '..', 'backups')));
const keep = parseInt(getArg('--keep', '7'), 10) || 7;

if (!fs.existsSync(appDb)) {
  console.error(`App database not found at ${appDb}`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(outDir, `app-${stamp}.db`);

const db = new DatabaseSync(appDb, { readOnly: false });
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();

const files = fs.readdirSync(outDir)
  .filter((f) => /^app-.*\.db$/.test(f))
  .sort()
  .reverse();
for (const old of files.slice(keep)) fs.unlinkSync(path.join(outDir, old));

const size = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`[backup] OK — ${target} (${size} MB). Kept ${Math.min(keep, files.length)} newest backup(s).`);
