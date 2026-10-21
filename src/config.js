'use strict';
const path = require('path');
const crypto = require('crypto');

function env(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

const ROOT = path.join(__dirname, '..');

const config = {
  env: env('NODE_ENV', 'development'),
  port: intEnv('PORT', 3000),
  host: env('HOST', '0.0.0.0'),
  trustProxy: env('TRUST_PROXY', '0') === '1',
  rootDir: ROOT,
  dataDir: env('DATA_DIR', path.join(ROOT, 'data')),
  appDbPath: env('APP_DB_PATH', path.join(ROOT, 'data', 'app.db')),
  linksDbPath: env('LINKS_DB_PATH', path.join(ROOT, 'links.db')),
  sessionSecret: env('SESSION_SECRET', ''),
  siteName: 'فیلمرز',
  perPage: intEnv('PER_PAGE', 24),
  source: {
    baseUrl: env('SOURCE_BASE_URL', 'https://flzios.com'),
    loginPath: env('SOURCE_LOGIN_PATH', '/login'),
    phone: env('SOURCE_PHONE', ''),
    password: env('SOURCE_PASSWORD', ''),
    phoneField: env('SOURCE_PHONE_FIELD', 'phone'),
    passwordField: env('SOURCE_PASSWORD_FIELD', 'password'),
    ttlMs: intEnv('RESOLVE_TTL_MS', 3 * 60 * 1000),
    timeoutMs: intEnv('SOURCE_TIMEOUT_MS', 8000),
  },
  // Regex source strings; matched against hostnames. Editable via env.
  allowedDlHosts: env('ALLOWED_DL_HOSTS', '(^|\\.)tdmm2\\.ir$'),
  posterHosts: env('POSTER_HOSTS', '(^|\\.)findmylinkes\\.ir$'),
  uploadsDir: env('UPLOADS_DIR', path.join(ROOT, 'data', 'uploads')),
};

if (!config.sessionSecret) {
  if (config.env === 'production') {
    console.warn('[config] SESSION_SECRET is not set — generating an ephemeral secret (admin sessions reset on restart).');
  }
  config.sessionSecret = crypto.randomBytes(32).toString('hex');
}

module.exports = config;
