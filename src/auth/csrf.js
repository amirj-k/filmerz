'use strict';
const crypto = require('crypto');
const config = require('../config');
const { parseCookies } = require('../session');
const { safeEqual } = require('./util');

/**
 * Synchronizer-token CSRF protection that does not need a session row.
 *
 * The token lives in an HttpOnly cookie and is also rendered into every form
 * (and into <meta name="csrf-token"> for fetch calls). A cross-site request
 * cannot read either value, and SameSite=Lax remains a second layer — it is
 * never the only layer.
 */

const COOKIE_BASE = 'fmz_csrf';
const MAX_AGE_SEC = 7 * 24 * 60 * 60;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Crawler-only documents must stay cookie-free so they remain CDN-cacheable
// and so Googlebot is not handed a new cookie on every fetch.
const COOKIE_FREE = /^\/(?:robots\.txt|sitemap(?:[^/]*\.xml)?|sitemaps(?:\/|$))/i;

function cookieName() {
  return config.cookieSecure ? `__Host-${COOKIE_BASE}` : COOKIE_BASE;
}

function cookieAttrs() {
  return [
    `Max-Age=${MAX_AGE_SEC}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(config.cookieSecure ? ['Secure'] : []),
  ].join('; ');
}

function setCookie(res, token) {
  res.append('Set-Cookie', `${cookieName()}=${encodeURIComponent(token)}; ${cookieAttrs()}`);
}

function validToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,100}$/.test(value);
}

function readToken(req) {
  const value = parseCookies(req)[cookieName()];
  return validToken(value) ? value : '';
}

/** Return the request's CSRF token, creating one when absent. */
function ensureToken(req, res) {
  const existing = readToken(req);
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('base64url');
  setCookie(res, token);
  return token;
}

/** Replace the token (after login/logout) to prevent token fixation. */
function rotateToken(req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  setCookie(res, token);
  res.locals.csrfToken = token;
  res.locals.csrf = token;
  return token;
}

function clearToken(res) {
  res.append('Set-Cookie', `${cookieName()}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${config.cookieSecure ? '; Secure' : ''}`);
}

function submittedToken(req) {
  const body = req.body && typeof req.body === 'object' ? req.body._csrf : '';
  return req.get('x-csrf-token') || req.get('x-xsrf-token') || body || '';
}

/**
 * Global middleware: expose the token to templates and enforce it on every
 * state-changing request. Must run after the body parsers.
 */
function csrfMiddleware(req, res, next) {
  if (SAFE_METHODS.has(req.method) && COOKIE_FREE.test(req.path)) return next();

  const expected = ensureToken(req, res);
  res.locals.csrfToken = expected;
  res.locals.csrf = expected; // backwards compatible template local
  req.csrfToken = expected;

  if (SAFE_METHODS.has(req.method)) return next();

  const supplied = submittedToken(req);
  if (!expected || !supplied || !safeEqual(expected, supplied)) {
    req.csrfFailed = true;
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ ok: false, error: 'CSRF_INVALID', message: 'درخواست معتبر نیست. صفحه را دوباره بارگذاری کنید.' });
    }
    return res.status(403).type('text/plain; charset=utf-8')
      .send('درخواست معتبر نیست (CSRF). صفحه را دوباره بارگذاری کنید.');
  }
  return next();
}

module.exports = {
  csrfMiddleware,
  ensureToken,
  rotateToken,
  clearToken,
  readToken,
  cookieName,
};
