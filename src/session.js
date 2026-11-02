'use strict';
const crypto = require('crypto');
const config = require('./config');

/**
 * Admin sessions — server-side, persisted in SQLite (`admin_sessions`).
 * Account sessions are a separate table/cookie (see src/auth/users-session.js);
 * the two identity systems never share a token.
 *
 * The cookie holds an opaque 256-bit random value; only its SHA-256 hash is
 * stored. Sessions are rotated on login.
 */

const COOKIE_BASE = 'fmz_admin';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let store = null;      // { db }
let sweepTimer = null;
const memorySessions = new Map(); // fallback when no DB was configured (tests)

function configureAdminSessionStore(db) {
  store = { db };
  startSweep();
}

function cookieName() {
  return config.cookieSecure ? `__Host-${COOKIE_BASE}` : COOKIE_BASE;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function startSweep() {
  if (sweepTimer || !store) return;
  sweepTimer = setInterval(() => {
    const now = new Date().toISOString();
    try {
      store.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now);
    } catch { /* ignore sweeper errors */ }
  }, 60 * 60 * 1000);
  sweepTimer.unref?.();
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  }
  return out;
}

function cookieAttrs(maxAgeMs) {
  return [
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(config.cookieSecure ? ['Secure'] : []),
  ].join('; ');
}

function createSession(res, req, data) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  const adminId = Number(data && data.adminId);

  if (store) {
    // Rotate: any presented admin token is discarded.
    const previous = parseCookies(req)[cookieName()];
    if (previous) {
      try {
        store.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(previous));
      } catch { /* ignore */ }
    }
    store.db.prepare(
      `INSERT INTO admin_sessions (admin_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(adminId, hashToken(token), new Date(now).toISOString(), new Date(now).toISOString(), expiresAt);
  } else {
    memorySessions.set(token, { data, expiresAt });
  }

  res.setHeader('Set-Cookie', `${cookieName()}=${encodeURIComponent(token)}; ${cookieAttrs(SESSION_TTL_MS)}`);
  return { data, expiresAt, csrf: '' };
}

function destroySession(req, res) {
  const token = parseCookies(req)[cookieName()];
  if (token) {
    if (store) {
      try {
        store.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
      } catch { /* ignore */ }
    }
    memorySessions.delete(token);
  }
  res.setHeader('Set-Cookie', `${cookieName()}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${config.cookieSecure ? '; Secure' : ''}`);
}

function getSession(req) {
  const token = parseCookies(req)[cookieName()];
  if (!token) return null;

  if (!store) {
    const s = memorySessions.get(token);
    if (!s || s.expiresAt <= Date.now()) {
      memorySessions.delete(token);
      return null;
    }
    return s;
  }

  const row = store.db.prepare(
    `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, a.id AS admin_id, a.username
       FROM admin_sessions s
       JOIN admin_users a ON a.id = s.admin_id
      WHERE s.token_hash = ?`
  ).get(hashToken(token));
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    try { store.db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(row.session_id); } catch { /* ignore */ }
    return null;
  }
  const lastSeen = Date.parse(row.last_seen_at);
  if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > 5 * 60 * 1000) {
    try {
      store.db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?')
        .run(new Date().toISOString(), row.session_id);
    } catch { /* ignore */ }
  }
  return { data: { adminId: row.admin_id, username: row.username }, expiresAt: Date.parse(row.expires_at) };
}

/** Middleware: attach req.session (or null). */
function sessionMiddleware(req, res, next) {
  req.session = getSession(req);
  req.isAdmin = Boolean(req.session && req.session.data && req.session.data.adminId);
  next();
}

module.exports = {
  COOKIE_NAME: COOKIE_BASE,
  configureAdminSessionStore,
  sessionMiddleware,
  createSession,
  destroySession,
  getSession,
  parseCookies,
};
