'use strict';

/**
 * Anonymous, persistent «نشان‌ها» wishlist.
 * The owner key lives in a long-lived HttpOnly cookie; items live in SQLite,
 * so lists survive server restarts without user accounts.
 */

const crypto = require('crypto');
const config = require('./config');
const { parseCookies } = require('./session');

const COOKIE_NAME = 'fmz_wishlist';
const MAX_AGE_SEC = 365 * 24 * 60 * 60;
const TYPES = new Set(['movie', 'series']);

function secureCookie(req) {
  return req.secure || (process.env.TRUST_PROXY === '1'
    && (req.headers['x-forwarded-proto'] || '').includes('https'));
}

function ensureKey(req, res) {
  const existing = parseCookies(req)[COOKIE_NAME];
  if (existing && /^[A-Za-z0-9_-]{20,80}$/.test(existing)) return existing;
  const key = crypto.randomBytes(24).toString('base64url');
  const attrs = [
    `Max-Age=${MAX_AGE_SEC}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secureCookie(req) ? ['Secure'] : []),
  ].join('; ');
  res.append('Set-Cookie', `${COOKIE_NAME}=${key}; ${attrs}`);
  return key;
}

function tokenFor(key) {
  return crypto.createHmac('sha256', config.sessionSecret)
    .update(`wishlist:${key}`)
    .digest('base64url');
}

function countFor(db, key) {
  return db.prepare('SELECT COUNT(*) AS c FROM wishlist_items WHERE owner_key = ?').get(key).c;
}

function itemExists(db, type, id) {
  const table = type === 'movie' ? 'movies' : 'series';
  return Boolean(db.prepare(`SELECT id FROM ${table} WHERE id = ? AND published = 1`).get(id));
}

function isIn(db, key, type, id) {
  if (!TYPES.has(type)) return false;
  return Boolean(db.prepare(
    'SELECT id FROM wishlist_items WHERE owner_key = ? AND item_type = ? AND item_id = ?'
  ).get(key, type, id));
}

function toggle(db, key, type, id) {
  if (!TYPES.has(type) || !itemExists(db, type, id)) return null;
  const row = db.prepare(
    'SELECT id FROM wishlist_items WHERE owner_key = ? AND item_type = ? AND item_id = ?'
  ).get(key, type, id);
  if (row) {
    db.prepare('DELETE FROM wishlist_items WHERE id = ?').run(row.id);
  } else {
    db.prepare('INSERT INTO wishlist_items (owner_key, item_type, item_id) VALUES (?, ?, ?)')
      .run(key, type, id);
  }
  return { active: !row, count: countFor(db, key) };
}

function listFor(db, key) {
  const rows = db.prepare(
    'SELECT item_type, item_id, created_at FROM wishlist_items WHERE owner_key = ? ORDER BY id DESC'
  ).all(key);
  const out = [];
  for (const row of rows) {
    if (row.item_type === 'movie') {
      const item = db.prepare(
        `SELECT id, slug, title_en, title_fa, year, poster_url, poster_valid
           FROM movies WHERE id = ? AND published = 1`
      ).get(row.item_id);
      if (item) out.push({ type: 'movie', item, createdAt: row.created_at });
    } else if (row.item_type === 'series') {
      const item = db.prepare(
        `SELECT id, slug, title_en, title_fa, year, poster_url, poster_valid,
                season_count, episode_count
           FROM series WHERE id = ? AND published = 1`
      ).get(row.item_id);
      if (item) out.push({ type: 'series', item, createdAt: row.created_at });
    }
  }
  return out;
}

const SKIP_PATHS = new Set(['/poster', '/healthz', '/api/suggest']);

function middleware(db) {
  return (req, res, next) => {
    if (SKIP_PATHS.has(req.path)) return next();
    const key = ensureKey(req, res);
    res.locals.wishlistKey = key;
    res.locals.wishlistToken = tokenFor(key);
    try {
      res.locals.wishlistCount = countFor(db, key);
    } catch {
      res.locals.wishlistCount = 0;
    }
    next();
  };
}

function removeOrphans(db) {
  db.exec(`
    DELETE FROM wishlist_items WHERE item_type = 'movie'
      AND item_id NOT IN (SELECT id FROM movies);
    DELETE FROM wishlist_items WHERE item_type = 'series'
      AND item_id NOT IN (SELECT id FROM series);
  `);
}

module.exports = {
  middleware,
  toggle,
  isIn,
  listFor,
  countFor,
  tokenFor,
  removeOrphans,
  COOKIE_NAME,
};
