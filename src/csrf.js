'use strict';
const { createSession } = require('./session');

/**
 * CSRF protection for admin forms.
 * - GET  requests: guarantee a session exists (even anonymous) and expose
 *   its token to templates as `csrf`.
 * - POST requests: require `_csrf` in the body to match the session token.
 */

function csrfMiddleware(req, res, next) {
  if (!req.session) {
    req.session = createSession(res, req, { anonymous: true });
  }
  res.locals.csrf = req.session.csrf;

  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  const token = (req.body && typeof req.body === 'object' && req.body._csrf) || req.get('x-csrf-token') || '';
  if (!req.session.csrf || token !== req.session.csrf) {
    return res.status(403).send('CSRF token mismatch — صفحه را دوباره بارگذاری کنید.');
  }
  next();
}

module.exports = { csrfMiddleware };
