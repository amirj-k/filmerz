'use strict';
/**
 * create-admin.js — create or update an admin user (bcrypt hash).
 *
 * Usage:
 *   node scripts/create-admin.js <username> <password>
 *   ADMIN_USER=... ADMIN_PASS=... node scripts/create-admin.js
 */
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');

const [user, pass] = [
  process.argv[2] || process.env.ADMIN_USER || '',
  process.argv[3] || process.env.ADMIN_PASS || '',
];
if (!user || !pass) {
  console.error('Usage: node scripts/create-admin.js <username> <password>');
  process.exit(1);
}
if (pass.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const dbPath = process.env.APP_DB || path.join(__dirname, '..', 'data', 'app.db');
if (!fs.existsSync(dbPath)) {
  console.error(`App database not found at ${dbPath} — run scripts/import.js first.`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const hash = bcrypt.hashSync(pass, 12);
db.prepare(
  `INSERT INTO admin_users (username, password_hash) VALUES (?, ?)
   ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`
).run(user, hash);
const row = db.prepare('SELECT id, username, created_at FROM admin_users WHERE username = ?').get(user);
console.log(`[create-admin] OK — user "${row.username}" (id ${row.id}) ready.`);
db.close();
