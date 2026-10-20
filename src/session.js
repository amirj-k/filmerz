'use strict';
const crypto = require('crypto');

/**
 * Server-side sessions backed by an in-memory Map and an opaque random id
 * in an HttpOnly cookie. CSRF tokens are bound to the session.
 * (Single-process, no external store — restart logs admins out, by design.)
 */

const COOKIE_NAME = 'fmz_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const sessions = new Map(); // sid -> { data, expiresAt }
let sweepTimer = null;

function startSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) if (s.expiresAt <= now) sessions.delete(sid);
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
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function cookieAttrs(req, maxAgeSec) {
  const secure = req.secure || (process.env.TRUST_PROXY === '1' && (req.headers['x-forwarded-proto'] || '').includes('https'));
  return [
    `Max-Age=${Math.floor(maxAgeSec / 1000)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function createSession(res, req, data) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  sessions.set(sid, { data, expiresAt: now + SESSION_TTL_MS, csrf: crypto.randomBytes(24).toString('base64url') });
  startSweep();
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(sid)}; ${cookieAttrs(req, SESSION_TTL_MS)}`);
  return sessions.get(sid);
}

function destroySession(req, res) {
  const sid = parseCookies(req)[COOKIE_NAME];
  if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

function getSession(req) {
  const sid = parseCookies(req)[COOKIE_NAME];
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s || s.expiresAt <= Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return s;
}

/** Middleware: attach req.session (or null). */
function sessionMiddleware(req, res, next) {
  req.session = getSession(req);
  next();
}

module.exports = {
  COOKIE_NAME,
  sessionMiddleware,
  createSession,
  destroySession,
  getSession,
  parseCookies,
};
