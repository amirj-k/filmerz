'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const { openAppDb } = require('./db');
const { sessionMiddleware } = require('./session');
const { middleware: wishlistMiddleware } = require('./wishlist');
const { publicRoutes } = require('./routes/public');
const { adminRoutes } = require('./routes/admin');
const { SourceClient } = require('./resolver');

function createApp({ db, sourceClient } = {}) {
  db = db || openAppDb(config.appDbPath);
  sourceClient = sourceClient || new SourceClient(config.source);

  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.rootDir, 'views'));
  app.set('view cache', config.env === 'production');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use(express.json({ limit: '4mb' }));
  app.use(sessionMiddleware);
  app.use(wishlistMiddleware(db));

  // Template locals + baseline security headers.
  app.use((req, res, next) => {
    res.locals.nonce = crypto.randomBytes(16).toString('base64');
    res.locals.siteName = config.siteName;
    res.locals.user = req.session && req.session.data && req.session.data.userId ? req.session.data : null;
    res.locals.csrf = (req.session && req.session.csrf) || '';
    res.locals.currentPath = req.path;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // CSP: everything is file-based; the only inline script is the nonce'd
  // theme bootstrap (avoids the dark-mode flash).
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      `script-src 'self' 'nonce-${res.locals.nonce}'`,
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "media-src 'self' https:",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '));
    next();
  });

  app.use(express.static(path.join(config.rootDir, 'public'), { maxAge: '7d' }));
  app.use('/uploads', express.static(config.uploadsDir, { maxAge: '1d' }));

  publicRoutes(app, db, sourceClient);
  adminRoutes(app, db);

  // 404
  app.use((req, res) => {
    res.status(404).render('404', { title: 'پیدا نشد — فیلمرز' });
  });

  // Central error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || (err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error('[error]', req.method, req.originalUrl, err);
    if (res.headersSent) return;
    if (req.path.startsWith('/api/') || req.path.startsWith('/admin/movies/')) {
      return res.status(status).json({ ok: false, message: status === 413 ? 'حجم درخواست زیاد است.' : 'خطای داخلی سرور.' });
    }
    res.status(status).render('500', { title: 'خطا — فیلمرز' });
  });

  return app;
}

function start() {
  const db = openAppDb(config.appDbPath);
  const app = createApp({ db });
  const server = app.listen(config.port, config.host, () => {
    console.log(`[filmerz] ${config.siteName} listening on http://${config.host}:${config.port} (${config.env})`);
  });
  server.keepAliveTimeout = 65000;

  const shutdown = () => {
    console.log('[filmerz] shutting down…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (require.main === module) start();
module.exports = { createApp, start };
