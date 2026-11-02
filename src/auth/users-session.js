'use strict';
const config = require('../config');
const { parseCookies } = require('../session');
const { nowIso, isoAfter, sha256, randomToken, isExpired } = require('./util');
const { normalizeUser } = require('./users');

/**
 * Persistent, server-side account sessions.
 *
 * - 256 bits of entropy in the cookie value; only its SHA-256 hash in SQLite.
 * - The cookie is opaque and HttpOnly; there is no JWT or token in JS storage.
 * - Sessions are rotated on login and after password changes.
 * - Expired rows are swept on access and periodically.
 */

const COOKIE_BASE = 'fmz_auth';

function cookieName() {
  return config.cookieSecure ? `__Host-${COOKIE_BASE}` : COOKIE_BASE;
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

function setSessionCookie(res, token) {
  res.append('Set-Cookie', `${cookieName()}=${encodeURIComponent(token)}; ${cookieAttrs(config.auth.sessionTtlMs)}`);
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', `${cookieName()}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${config.cookieSecure ? '; Secure' : ''}`);
}

function requestToken(req) {
  const raw = parseCookies(req)[cookieName()];
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{32,120}$/.test(raw) ? raw : '';
}

/**
 * Create a brand-new session, deleting any session the browser presented
 * first (session-fixation defence).
 */
function createSession(db, req, res, userId) {
  const previous = requestToken(req);
  if (previous) {
    db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(sha256(previous));
  }
  const token = randomToken(32);
  const now = Date.now();
  db.prepare(
    `INSERT INTO user_sessions (user_id, token_hash, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, sha256(token), new Date(now).toISOString(), new Date(now).toISOString(),
    new Date(now + config.auth.sessionTtlMs).toISOString());
  setSessionCookie(res, token);
  return token;
}

/** Rotate in place while keeping the account logged in. */
function rotateSession(db, req, res, userId) {
  return createSession(db, req, res, userId);
}

function destroySession(db, req, res) {
  const token = requestToken(req);
  if (token) db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(sha256(token));
  clearSessionCookie(res);
}

function revokeAllSessions(db, userId) {
  db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
}

function revokeOtherSessions(db, userId, currentToken) {
  const keep = currentToken ? sha256(currentToken) : '';
  if (!keep) {
    revokeAllSessions(db, userId);
    return;
  }
  db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND token_hash != ?').run(userId, keep);
}

function sweepExpiredSessions(db) {
  db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(nowIso());
  db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(nowIso());
}

/** Load and validate the session behind the request cookie. */
function loadSession(db, req) {
  const token = requestToken(req);
  if (!token) return null;
  const hash = sha256(token);
  const row = db.prepare(
    `SELECT s.id AS session_id, s.token_hash, s.last_seen_at, s.expires_at,
            u.id, u.email, u.email_original, u.password_hash, u.display_name, u.avatar_url,
            u.role, u.status, u.email_verified_at, u.created_at, u.last_login_at
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  ).get(hash);
  if (!row) return null;
  if (isExpired(row.expires_at) || row.status !== 'active') {
    db.prepare('DELETE FROM user_sessions WHERE id = ?').run(row.session_id);
    return null;
  }
  // Cheap write amplification guard: touch at most once every five minutes.
  const lastSeen = Date.parse(row.last_seen_at);
  if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > 5 * 60 * 1000) {
    db.prepare('UPDATE user_sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), row.session_id);
  }
  return { user: normalizeUser(row), tokenHash: hash };
}

function sessionMiddleware(db) {
  return (req, res, next) => {
    req.user = null;
    req.userSession = null;
    try {
      const loaded = loadSession(db, req);
      if (loaded) {
        req.user = loaded.user;
        req.userSession = loaded;
      } else if (requestToken(req)) {
        // Expired/revoked/disabled: drop the stale cookie on the way out.
        clearSessionCookie(res);
      }
    } catch (err) {
      // A broken session must never take the public site down.
      console.error('[auth] session load failed:', (err && err.message) || 'error');
    }
    res.locals.currentUser = req.user;
    next();
  };
}

/** Require an authenticated account for HTML pages. */
function requireUser(req, res, next) {
  if (req.user) return next();
  const nextPath = encodeURIComponent(req.originalUrl || '/account');
  return res.redirect(`/login?next=${nextPath}`);
}

/** Require an authenticated account for JSON endpoints. */
function requireUserApi(req, res, next) {
  if (req.user) return next();
  return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED', message: 'برای این کار باید وارد شوید.' });
}

module.exports = {
  cookieName,
  createSession,
  rotateSession,
  destroySession,
  revokeAllSessions,
  revokeOtherSessions,
  sweepExpiredSessions,
  sessionMiddleware,
  requireUser,
  requireUserApi,
  loadSession,
  requestToken,
  normalizeUser,
};
