'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const { openAppDb } = require('./db');
const { configureAdminSessionStore, sessionMiddleware } = require('./session');
const authSession = require('./auth/users-session');
const { csrfMiddleware } = require('./auth/csrf');
const lists = require('./auth/lists');
const tokens = require('./auth/tokens');
const google = require('./auth/google');
const mail = require('./auth/mail');
const { middleware: wishlistMiddleware } = require('./wishlist');
const { authRoutes } = require('./routes/auth');
const { publicRoutes } = require('./routes/public');
const { viewHelpers } = require('./routes/public');
const { adminRoutes } = require('./routes/admin');
const { SourceClient } = require('./resolver');
const { SEOEngine } = require('./seo');
const { IndexabilityEvaluator } = require('./indexability');
const { SitemapGenerator } = require('./sitemap');

function createApp({ db, sourceClient } = {}) {
  db = db || openAppDb(config.appDbPath);
  sourceClient = sourceClient || new SourceClient(config.source);

  configureAdminSessionStore(db);

  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.rootDir, 'views'));
  app.set('view cache', config.env === 'production');
  if (config.trustProxy) app.set('trust proxy', 1);

  // Initialize SEO engine and indexability evaluator
  const seoEngine = new SEOEngine(db);
  const indexabilityEvaluator = new IndexabilityEvaluator(db);
  const sitemapGenerator = new SitemapGenerator(db);

  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use(express.json({ limit: '4mb' }));

  // Static assets first: no session/CSRF work for CSS, JS, images.
  app.use(express.static(path.join(config.rootDir, 'public'), { maxAge: '7d' }));
  app.use('/uploads', express.static(config.uploadsDir, { maxAge: '1d' }));

  app.use(sessionMiddleware);            // admin sessions (separate cookie)
  app.use(authSession.sessionMiddleware(db)); // account sessions
  app.use(csrfMiddleware);               // token exposure + enforcement

  // Anonymous wishlist cookie (guests keep the existing behaviour).
  app.use(wishlistMiddleware(db));

  // Template locals + baseline security headers.
  app.use((req, res, next) => {
    res.locals.nonce = crypto.randomBytes(16).toString('base64');
    res.locals.siteName = config.siteName;
    res.locals.admin = req.session && req.session.data && req.session.data.adminId
      ? req.session.data
      : null;
    res.locals.currentUser = req.user || null;
    // Kept for older templates: `user` now always means the site account.
    res.locals.user = req.user || null;
    res.locals.csrfToken = req.csrfToken || res.locals.csrfToken || '';
    res.locals.csrf = res.locals.csrfToken;
    res.locals.currentPath = req.path;
    res.locals.query = req.query;
    res.locals.googleEnabled = google.isConfigured();
    res.locals.mailConfigured = mail.isConfigured();
    res.locals.requireEmailVerification = config.auth.emailVerificationRequired;

    // Members' star list is account-backed; guests keep the cookie list.
    if (req.user) {
      try { res.locals.wishlistCount = lists.count(db, 'favorites', req.user.id); } catch { /* ignore */ }
    }

    // Canonical URLs are produced by SEOEngine per route (see
    // generateCanonicalUrl); never from an arbitrary originalUrl here.
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
      "img-src 'self' data: https:",
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

  // Shared template helpers must exist before auth/account views render.
  const helpers = viewHelpers(db);
  app.use((req, res, next) => {
    Object.assign(res.locals, helpers);
    res.locals.currentPath = req.path;
    res.locals.query = req.query;
    next();
  });

  authRoutes(app, db);
  publicRoutes(app, db, sourceClient, seoEngine, indexabilityEvaluator);
  adminRoutes(app, db);

  // Periodic housekeeping for sessions and one-time tokens.
  const sweeper = setInterval(() => {
    try {
      authSession.sweepExpiredSessions(db);
      tokens.sweepExpiredTokens(db);
    } catch { /* never let housekeeping break the app */ }
  }, 6 * 60 * 60 * 1000);
  sweeper.unref?.();
  app.locals._sweeper = sweeper;

  /**
   * A sitemap URL must always answer with XML. Returning HTML (the 404 page)
   * or a plain-text error for a URL Google submitted is exactly what produces
   * "error on line 1 at column 1: Start tag expected, '<' not found" in
   * Search Console / the browser.
   */
  function sitemapFailure(res, error) {
    console.error('Error generating sitemap:', error);
    if (res.headersSent) return;
    res.status(503).type('application/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></sitemapindex>\n'
    );
  }

  function sitemapIndexXml() {
    const sitemaps = sitemapGenerator.listSitemaps();
    let lastmod = '';
    try {
      const row = db.prepare(
        `SELECT MAX(t) AS t FROM (
           SELECT MAX(last_link_at) AS t FROM movies WHERE published = 1
           UNION ALL SELECT MAX(last_link_at) FROM series WHERE published = 1
         )`
      ).get();
      const parsed = row && row.t ? new Date(row.t) : null;
      if (parsed && !Number.isNaN(parsed.getTime())) lastmod = parsed.toISOString();
    } catch { /* fall back to now */ }
    if (!lastmod) lastmod = new Date().toISOString();

    const entries = sitemaps.map((sitemap) => `  <sitemap>
    <loc>${sitemap.loc.replace(/&/g, '&amp;')}</loc>
    <lastmod>${lastmod}</lastmod>
  </sitemap>`);

    return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</sitemapindex>
`;
  }

  async function buildSitemap(name, pageNum) {
    const cached = (key, fn) => sitemapGenerator.cached(`${key}:${pageNum}`, fn);
    switch (name) {
      case 'movies': return cached('movies', () => sitemapGenerator.generateMoviesSitemap(pageNum));
      case 'series': return cached('series', () => sitemapGenerator.generateSeriesSitemap(pageNum));
      case 'people': return cached('people', () => sitemapGenerator.generatePeopleSitemap(pageNum));
      case 'genres': return pageNum === 1 ? sitemapGenerator.cached('genres', () => sitemapGenerator.generateGenresSitemap()) : null;
      case 'countries': return pageNum === 1 ? sitemapGenerator.cached('countries', () => sitemapGenerator.generateCountriesSitemap()) : null;
      case 'years': return pageNum === 1 ? sitemapGenerator.cached('years', () => sitemapGenerator.generateYearsSitemap()) : null;
      case 'pages': return pageNum === 1 ? sitemapGenerator.cached('pages', () => sitemapGenerator.generatePagesSitemap()) : null;
      case 'top250': return pageNum === 1 ? sitemapGenerator.cached('top250', () => sitemapGenerator.generateTop250Sitemap()) : null;
      default: return null;
    }
  }

  async function sendSitemapFile(res, name, pageNum) {
    res.set('Cache-Control', 'public, max-age=3600');
    let xml = null;
    try {
      xml = await buildSitemap(name, pageNum);
    } catch (error) {
      return sitemapFailure(res, error);
    }
    if (!xml) {
      // A sitemap URL must never answer with HTML (browser/GSC: "Start tag
      // expected, '<' not found") or plain text ("couldn't read sitemap").
      // An empty, valid urlset with 404 is the correct "not found" signal.
      return res.status(404).type('application/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n'
      );
    }
    return res.type('application/xml').send(xml);
  }

  function sendSitemapIndex(res) {
    res.set('Cache-Control', 'public, max-age=3600');
    try {
      res.type('application/xml').send(sitemapIndexXml());
    } catch (error) {
      sitemapFailure(res, error);
    }
  }

  // robots.txt is generated so its Sitemap line always matches APP_BASE_URL.
  // A 404 here makes Google re-crawl more aggressively and forget the sitemap.
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').set('Cache-Control', 'public, max-age=3600');
    res.send([
      'User-agent: *',
      'Disallow: /admin',
      'Disallow: /account',
      'Disallow: /api/',
      'Disallow: /login',
      'Disallow: /register',
      'Disallow: /forgot-password',
      'Disallow: /reset-password',
      'Disallow: /verify-email',
      'Disallow: /wishlist',
      // Search result pages carry a noindex meta tag instead of being
      // disallowed, so crawlers can actually read it.
      'Allow: /',
      'Allow: /css/',
      'Allow: /js/',
      '',
      `Sitemap: ${sitemapGenerator.siteUrl}/sitemap.xml`,
      '',
    ].join('\n'));
  });

  // Sitemap index. Several conventional spellings are accepted (with and
  // without a trailing slash) because a wrong guess used to fall through to
  // the HTML 404 page, which browsers and Search Console report as:
  // "error on line 1 at column 1: Start tag expected, '<' not found".
  const indexPaths = [
    '/sitemap.xml', '/sitemap.xml/',
    '/sitemap_index.xml', '/sitemap_index.xml/',
    '/sitemap-index.xml', '/sitemap-index.xml/',
    '/sitemaps/index.xml', '/sitemaps/index.xml/',
  ];
  for (const indexPath of indexPaths) {
    app.get(indexPath, (req, res) => sendSitemapIndex(res));
  }
  for (const legacyPath of ['/sitemap', '/sitemaps']) {
    app.get(legacyPath, (req, res) => res.redirect(301, '/sitemap.xml'));
  }

  // Individual sitemap files: /sitemaps/movies.xml and /sitemaps/movies-2.xml
  app.get('/sitemaps/:name-:page?.xml', async (req, res) => {
    const pageNum = Math.max(1, parseInt(req.params.page, 10) || 1);
    return sendSitemapFile(res, req.params.name, pageNum);
  });

  // Convenience alias: /sitemaps/movies.xml (page 1) — a very common guess.
  app.get('/sitemaps/:name.xml', async (req, res) => {
    return sendSitemapFile(res, req.params.name, 1);
  });

  // Alias without the extension: /sitemaps/movies → still XML, never HTML.
  app.get('/sitemaps/:name', async (req, res) => {
    const raw = String(req.params.name || '');
    const match = raw.match(/^(.+?)-(\d+)$/);
    if (match) return sendSitemapFile(res, match[1], Math.max(1, parseInt(match[2], 10) || 1));
    return sendSitemapFile(res, raw, 1);
  });

  // Flat names that older setups / GSC submissions commonly use:
  // /sitemap-movies.xml, /sitemap-movies-2.xml, /sitemap-movies, /sitemap-index.
  // Answering with the real sitemap lets GSC recover instead of failing again.
  const sendFlatSitemap = (req, res) => {
    const raw = String(req.params.name || '');
    if (/^index(?:\.xml)?$/i.test(raw)) return sendSitemapIndex(res);
    const match = raw.match(/^(.+?)-(\d+)$/);
    if (match) return sendSitemapFile(res, match[1], Math.max(1, parseInt(match[2], 10) || 1));
    return sendSitemapFile(res, raw, 1);
  };
  app.get('/sitemap-:name.xml', sendFlatSitemap);
  app.get('/sitemap-:name', sendFlatSitemap);

  // Last line of defence: nothing sitemap-shaped may ever reach the HTML 404
  // renderer. An unknown sitemap must fail as XML, not as an HTML document.
  app.get(/^\/sitemap/i, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(404).type('application/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n'
    );
  });

  // 404
  app.use((req, res) => {
    const pageType = '404';
    const pathname = req.path;
    const seoData = {};
    const seoMetadata = seoEngine.generateMetadata(pageType, seoData, pathname);

    res.status(404).render('404', {
      title: 'پیدا نشد — فیلمرز - Filmerz',
      seoMetadata,
      indexability: res.locals.indexability,
    });
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

    const pageType = '500';
    const pathname = req.path;
    const seoData = {};
    const seoMetadata = seoEngine.generateMetadata(pageType, seoData, pathname);

    res.status(status).render('500', {
      title: 'خطا — فیلمرز - Filmerz',
      seoMetadata,
      indexability: res.locals.indexability,
    });
  });

  return app;
}

function start() {
  const db = openAppDb(config.appDbPath);
  const app = createApp({ db });
  const server = app.listen(config.port, config.host, () => {
    console.log(`[filmerz] ${config.siteName} listening on http://${config.host}:${config.port} (${config.env})`);
    if (config.auth.emailVerificationRequired && !mail.isConfigured()) {
      console.warn('[auth] REQUIRE_EMAIL_VERIFICATION is on but SMTP is not configured — registration is disabled.');
    }
    if (!google.isConfigured()) {
      console.log('[auth] Google Sign-In is not configured (email/password still works).');
    }
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
