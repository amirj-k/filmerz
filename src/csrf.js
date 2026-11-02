'use strict';
const { csrfMiddleware } = require('./auth/csrf');

/**
 * Backwards-compatible entry point. The implementation lives in
 * src/auth/csrf.js and is shared by the public site and the admin panel.
 */
module.exports = { csrfMiddleware };
