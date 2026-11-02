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
function boolEnv(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

const ROOT = path.join(__dirname, '..');
const NODE_ENV = env('NODE_ENV', 'development');
const isProduction = NODE_ENV === 'production';
const PORT = intEnv('PORT', 3000);
const APP_BASE_URL = env('APP_BASE_URL', isProduction ? 'https://filmerz.ir' : `http://localhost:${PORT}`).replace(/\/+$/, '');

const config = {
  env: NODE_ENV,
  isProduction,
  port: PORT,
  host: env('HOST', '0.0.0.0'),
  trustProxy: env('TRUST_PROXY', '0') === '1',
  rootDir: ROOT,
  dataDir: env('DATA_DIR', path.join(ROOT, 'data')),
  appDbPath: env('APP_DB_PATH', path.join(ROOT, 'data', 'app.db')),
  linksDbPath: env('LINKS_DB_PATH', path.join(ROOT, 'links.db')),
  sessionSecret: env('SESSION_SECRET', ''),
  siteName: 'فیلمرز',
  perPage: intEnv('PER_PAGE', 24),
  appBaseUrl: APP_BASE_URL,

  // Secure cookies are on by default in production (the site runs behind
  // Caddy over HTTPS). COOKIE_SECURE=0 is an explicit opt-out for local
  // production testing over plain HTTP.
  cookieSecure: boolEnv('COOKIE_SECURE', isProduction),

  auth: {
    sessionTtlMs: intEnv('AUTH_SESSION_TTL_MS', 30 * 24 * 60 * 60 * 1000),
    emailVerificationRequired: boolEnv('REQUIRE_EMAIL_VERIFICATION', true),
    emailVerificationTtlMs: intEnv('EMAIL_VERIFICATION_TTL_MS', 24 * 60 * 60 * 1000),
    passwordResetTtlMs: intEnv('PASSWORD_RESET_TTL_MS', 30 * 60 * 1000),
    oauthStateTtlMs: intEnv('OAUTH_STATE_TTL_MS', 10 * 60 * 1000),
    minPasswordLength: 12,
    maxPasswordLength: 128,
    // scrypt (Node built-in) — versioned format, per-password salt.
    // OWASP-friendly: N=2^16, r=8, p=1, 64 MiB. Raise via env if the host
    // has headroom; hashes keep their own parameters so upgrades are safe.
    scrypt: {
      N: intEnv('SCRYPT_N', 65536),
      r: intEnv('SCRYPT_R', 8),
      p: intEnv('SCRYPT_P', 1),
      keylen: 32,
      maxmem: intEnv('SCRYPT_MAXMEM', 160 * 1024 * 1024),
    },
    login: {
      ipWindowMs: intEnv('LOGIN_IP_WINDOW_MS', 15 * 60 * 1000),
      ipMax: intEnv('LOGIN_IP_MAX', 40),
      accountWindowMs: intEnv('LOGIN_ACCOUNT_WINDOW_MS', 15 * 60 * 1000),
      accountMax: intEnv('LOGIN_ACCOUNT_MAX', 10),
    },
  },

  mail: {
    host: env('SMTP_HOST', ''),
    port: intEnv('SMTP_PORT', 587),
    secure: boolEnv('SMTP_SECURE', false),
    user: env('SMTP_USER', ''),
    pass: env('SMTP_PASS', ''),
    from: env('MAIL_FROM', ''),
    replyTo: env('MAIL_REPLY_TO', ''),
  },

  google: {
    clientId: env('GOOGLE_CLIENT_ID', ''),
    clientSecret: env('GOOGLE_CLIENT_SECRET', ''),
    callbackUrl: env('GOOGLE_CALLBACK_URL', `${APP_BASE_URL}/auth/google/callback`),
    // Optional proxy used only for Google's OAuth endpoints. Accepts
    // http(s):// and socks5:// / socks5h:// URLs. Needed when the app server
    // cannot reach oauth2.googleapis.com directly.
    proxyUrl: env('GOOGLE_PROXY_URL', ''),
    // Token endpoint. Some networks block oauth2.googleapis.com while
    // www.googleapis.com stays reachable; the app retries there automatically.
    tokenUrl: env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
  },

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
  // tdmm2.ir = older crawl; abrtech.top + mehracdn.com = current crawl/redirects.
  allowedDlHosts: env('ALLOWED_DL_HOSTS', '(^|\\.)(tdmm2\\.ir|abrtech\\.top|mehracdn\\.com)$'),
  posterHosts: env('POSTER_HOSTS', '(^|\\.)(findmylinkes\\.ir|intocdn\\.top)$'),
  uploadsDir: env('UPLOADS_DIR', path.join(ROOT, 'data', 'uploads')),
};

config.mailConfigured = Boolean(config.mail.host && config.mail.from);
config.google.configured = Boolean(
  config.google.clientId && config.google.clientSecret && config.google.callbackUrl
);

if (!config.sessionSecret) {
  if (config.isProduction) {
    console.warn('[config] SESSION_SECRET is not set — generating an ephemeral secret (admin sessions reset on restart).');
  }
  config.sessionSecret = crypto.randomBytes(32).toString('hex');
}

module.exports = config;
