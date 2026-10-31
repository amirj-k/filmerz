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
const { SEOEngine } = require('./seo');
const { IndexabilityEvaluator } = require('./indexability');
const { SitemapGenerator } = require('./sitemap');

function createApp({ db, sourceClient } = {}) {
  db = db || openAppDb(config.appDbPath);
  sourceClient = sourceClient || new SourceClient(config.source);

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
  app.use(sessionMiddleware);
  app.use(wishlistMiddleware(db));

  // Template locals + baseline security headers.
  app.use((req, res, next) => {
    res.locals.nonce = crypto.randomBytes(16).toString('base64');
    res.locals.siteName = config.siteName;
    res.locals.user = req.session && req.session.data && req.session.data.userId ? req.session.data : null;
    res.locals.csrf = (req.session && req.session.csrf) || '';
    res.locals.currentPath = req.path;
    res.locals.query = req.query;
    
    // Add SEO metadata to locals
    const pageType = req.path.split('/')[1] || 'home';
    const pathname = req.path;
    
    // Determine data for SEO generation
    let seoData = {};
    
    // Get data for different page types
    switch (pageType) {
      case 'search':
        seoData = {
          q: req.query.q || '',
        };
        break;
    }
    
    // Generate SEO metadata
    res.locals.seoMetadata = seoEngine.generateMetadata(pageType, seoData, pathname);
    
    // Evaluate indexability
    const evaluation = indexabilityEvaluator.evaluate(pageType, seoData, pathname);
    res.locals.indexability = evaluation;
    
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

  publicRoutes(app, db, sourceClient, seoEngine, indexabilityEvaluator);
  adminRoutes(app, db);

  // robots.txt
  app.get('/robots.txt', (req, res) => {
    res.set('Content-Type', 'text/plain');
    res.sendFile(path.join(config.rootDir, 'robots.txt'));
  });

  // Sitemap index
  app.get('/sitemap.xml', async (req, res) => {
    res.set('Content-Type', 'application/xml');
    
    const sitemapFiles = await sitemapGenerator.getAllSitemapFiles();
    
    let sitemapIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;
    
    for (const sitemap of sitemapFiles) {
      sitemapIndex += `  <sitemap>
    <loc>${config.env === 'production' ? 'https://filmerz.amirjk.ir' : `http://localhost:${config.port}`}/sitemaps/${sitemap.name}.xml</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
  </sitemap>
`;
    }
    
    sitemapIndex += '</sitemapindex>';
    
    res.send(sitemapIndex);
  });

  // Individual sitemap files
  app.get('/sitemaps/:name-:page?.xml', async (req, res) => {
    const { name, page } = req.params;
    res.set('Content-Type', 'application/xml');
    
    try {
      let xml = null;
      
      switch (name) {
        case 'movies-1':
          xml = await sitemapGenerator.generateMoviesSitemap(parseInt(page) || 1);
          break;
        case 'series-1':
          xml = await sitemapGenerator.generateSeriesSitemap(parseInt(page) || 1);
          break;
        case 'people-1':
          xml = await sitemapGenerator.generatePeopleSitemap(parseInt(page) || 1);
          break;
        case 'genres-1':
          xml = await sitemapGenerator.generateGenresSitemap();
          break;
        case 'top250-1':
          xml = await sitemapGenerator.generateTop250Sitemap();
          break;
        default:
          return res.status(404).send('Sitemap not found');
      }
      
      if (!xml) {
        return res.status(404).send('Sitemap not found');
      }
      
      res.send(xml);
    } catch (error) {
      console.error('Error generating sitemap:', error);
      res.status(500).send('Error generating sitemap');
    }
  });

  // 404
  app.use((req, res) => {
    const pageType = '404';
    const pathname = req.path;
    const seoData = {};
    const seoMetadata = seoEngine.generateMetadata(pageType, seoData, pathname);
    
    res.status(404).render('404', {
      title: 'پیدا نشد — فیلمرز',
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
      title: 'خطا — فیلمرز',
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
