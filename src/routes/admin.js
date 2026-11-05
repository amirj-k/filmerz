'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const queries = require('../queries');
const catalog = require('../catalog');
const seriesCatalog = require('../series-catalog');
const adminContent = require('../admin-content');
const { createSession, destroySession } = require('../session');
const { rateLimiter } = require('../ratelimit');

const loginLimiter = rateLimiter({ windowMs: 15 * 60000, max: 10, name: 'admin-login' });
const adminLimiter = rateLimiter({ windowMs: 60000, max: 120, name: 'admin' });

function requireAdmin(req, res, next) {
  if (req.session && req.session.data && req.session.data.adminId) return next();
  if (req.method === 'GET') return res.redirect('/admin/login');
  return res.status(403).send('دسترسی مجاز نیست.');
}

function dashboardData(db) {
  const recentMovies = db.prepare(
    `SELECT id, slug, title_en, title_fa, year, published, featured, link_count
       FROM movies ORDER BY id DESC LIMIT 6`
  ).all();
  const recentSeries = db.prepare(
    `SELECT id, slug, title_en, title_fa, year, published, featured,
            season_count, episode_count, link_count
       FROM series ORDER BY id DESC LIMIT 6`
  ).all();
  return { recentMovies, recentSeries };
}

/** Every known genre name, used as the admin form's autocomplete list. */
function genreNames(db) {
  return db.prepare('SELECT name FROM genres ORDER BY name').all().map((r) => r.name);
}

/** Aggregate health numbers for the admin health page. */
function linkHealth(db) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  return {
    movies: one('SELECT COUNT(*) c FROM movies').c,
    published: one('SELECT COUNT(*) c FROM movies WHERE published = 1').c,
    links: one('SELECT COUNT(*) c FROM links').c,
    withPlayUrl: one('SELECT COUNT(*) c FROM links WHERE play_url IS NOT NULL AND play_url != \'\'').c,
    series: one('SELECT COUNT(*) c FROM series').c,
    seriesPublished: one('SELECT COUNT(*) c FROM series WHERE published = 1').c,
    seasons: one('SELECT COUNT(*) c FROM seasons').c,
    episodes: one('SELECT COUNT(*) c FROM episodes').c,
    episodeLinks: one('SELECT COUNT(*) c FROM episode_links').c,
    people: one('SELECT COUNT(*) c FROM people').c,
    genres: one('SELECT COUNT(*) c FROM genres').c,
    lastScrape: one('SELECT MAX(scraped_at) m FROM episode_links').m,
  };
}

function adminRoutes(app, db) {
  const r = express.Router(); // mounted at /admin (see bottom of this function)



  // ---- login ---------------------------------------------------------
  r.get('/login', (req, res) => {
    if (req.session && req.session.data && req.session.data.adminId) return res.redirect('/admin');
    res.render('admin/login', { title: 'ورود مدیر — فیلمرز', error: null });
  });

  r.post('/login', loginLimiter, (req, res) => {
    const { username, password } = req.body || {};
    const row = db.prepare('SELECT id, username, password_hash FROM admin_users WHERE username = ?').get(String(username || '').trim());
    const ok = row && bcrypt.compareSync(String(password || ''), row.password_hash);
    if (!ok) {
      return res.status(401).render('admin/login', { title: 'ورود مدیر — فیلمرز', error: 'نام کاربری یا گذرواژه نادرست است.' });
    }
    // Rotate the session id on privilege change (fixation defence).
    destroySession(req, res);
    createSession(res, req, { adminId: row.id, username: row.username });
    res.redirect('/admin');
  });

  r.post('/logout', requireAdmin, (req, res) => {
    destroySession(req, res);
    res.redirect('/');
  });

  // Everything below needs an admin session.
  r.use(requireAdmin, (req, res, next) => {
    res.locals.username = req.session.data.username;
    next();
  });

  r.get('/', adminLimiter, (req, res) => {
    const q = String(req.query.q || '').slice(0, 100);
    if (q) return res.redirect(303, '/admin/movies?q=' + encodeURIComponent(q));
    const stats = linkHealth(db);
    const { recentMovies, recentSeries } = dashboardData(db);
    res.render('admin/dashboard', {
      title: 'داشبورد مدیریت — فیلمرز', stats, recentMovies, recentSeries,
    });
  });

  // ---- movies ---------------------------------------------------------
  r.get('/movies', adminLimiter, (req, res) => {
    const q = String(req.query.q || '').slice(0, 100);
    const page = parseInt(req.query.page, 10) || 1;
    const result = queries.adminSearchMovies(db, q, page, 20);
    res.render('admin/movies', { title: 'مدیریت فیلم‌ها — فیلمرز', q, page, result, stats: linkHealth(db) });
  });

  r.get('/movies/new', (req, res) => {
    res.render('admin/edit', {
      title: 'افزودن فیلم — فیلمرز',
      movie: adminContent.blankMovie(),
      genreNames: genreNames(db),
      isnew: true,
      linkRows: [adminContent.blankLink('movie'), adminContent.blankLink('movie'), adminContent.blankLink('movie')],
    });
  });

  r.post('/movies/new', (req, res) => {
    try {
      const id = adminContent.saveMovie(db, req.body || {}, null);
      res.json({ ok: true, id });
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err.message || err) });
    }
  });

  r.get('/movies/:id/edit', (req, res) => {
    const movie = catalog.getMovieFull(db, parseInt(req.params.id, 10) || 0);
    if (!movie) return res.status(404).render('404', { title: 'پیدا نشد' });
    res.render('admin/edit', {
      title: `ویرایش: ${movie.title_en || movie.title_fa} — فیلمرز`,
      movie,
      genreNames: genreNames(db),
      isnew: false,
      linkRows: [adminContent.blankLink('movie')],
    });
  });

  r.post('/movies/:id/edit', (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    try {
      adminContent.saveMovie(db, req.body || {}, id);
      res.json({ ok: true, id });
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err.message || err) });
    }
  });

  r.post('/movies/:id/links', (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    try {
      res.json({ ok: true, ...adminContent.addMovieLinks(db, id, req.body && req.body.links) });
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err.message || err) });
    }
  });

  r.post('/movies/:id/links/:linkId/delete', (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    const linkId = parseInt(req.params.linkId, 10) || 0;
    try {
      res.json({ ok: true, ...adminContent.deleteMovieLink(db, id, linkId) });
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err.message || err) });
    }
  });

  r.post('/movies/:id/toggle-publish', (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    queries.setMoviePublished(db, id, req.body && req.body.published ? 1 : 0);
    res.json({ ok: true });
  });

  r.post('/movies/:id/toggle-featured', (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    queries.setMovieFeatured(db, id, req.body && req.body.featured ? 1 : 0);
    res.json({ ok: true });
  });

  // ---- series ---------------------------------------------------------
  r.get('/series', adminLimiter, (req, res) => {
    const q = String(req.query.q || '').slice(0, 100);
    const page = parseInt(req.query.page, 10) || 1;
    const result = seriesCatalog.adminSearchSeries(db, q, page, 20);
    res.render('admin/series', { title: 'مدیریت سریال‌ها — فیلمرز', q, page, result, stats: linkHealth(db) });
  });

  r.get('/series/new', (req, res) => {
    res.render('admin/series-edit', {
      title: 'افزودن سریال — فیلمرز',
      series: adminContent.blankSeries(),
      genreNames: genreNames(db),
      seriesLinks: [],
      isnew: true,
      linkRows: [adminContent.blankLink('series'), adminContent.blankLink('series'), adminContent.blankLink('series')],
    });
  });

  r.post('/series/new', (req, res) => {
    try {
      const id = adminContent.saveSeries(db, req.body || {}, null);
      res.json({ ok: true, id });
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err.message || err) });
    }
  });

  r.get('/series/:id/edit', (req, res) => {
    const series = seriesCatalog.getSeriesFull(db, parseInt(req.params.id, 10) || 0);
    if (!series) return res.status(404).render('404', { title: 'پیدا نشد' });
    res.render('admin/series-edit', {
      title: `ویرایش سریال: ${series.title_en || series.title_fa} — فیلمرز`,
      series,
      genreNames: genreNames(db),
      seriesLinks: seriesCatalog.adminSeriesLinks(db, series.id),
      isnew: false,
      linkRows: [adminContent.blankLink('series')],
    });
  });

  r.post('/series/:id/edit', (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    try {
      adminContent.saveSeries(db, req.body || {}, id);
      res.json({ ok: true, id });
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err.message || err) });
    }
  });

  r.post('/series/:id/links', (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    try {
      res.json({ ok: true, ...adminContent.addSeriesLinks(db, id, req.body && req.body.links) });
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err.message || err) });
    }
  });

  r.post('/series/:id/links/:linkId/delete', (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    const linkId = parseInt(req.params.linkId, 10) || 0;
    try {
      res.json({ ok: true, ...adminContent.deleteEpisodeLink(db, id, linkId) });
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err.message || err) });
    }
  });

  r.post('/series/:id/toggle-publish', (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    db.prepare('UPDATE series SET published = ? WHERE id = ?')
      .run(req.body && req.body.published ? 1 : 0, id);
    res.json({ ok: true });
  });

  r.post('/series/:id/toggle-featured', (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    db.prepare('UPDATE series SET featured = ? WHERE id = ?')
      .run(req.body && req.body.featured ? 1 : 0, id);
    res.json({ ok: true });
  });

  r.get('/merge', (req, res) => {
    res.render('admin/merge', { title: 'ادغام رکوردها — فیلمرز', result: null, error: null });
  });

  r.post('/merge', (req, res) => {
    const keep = parseInt(req.body.keep, 10) || 0;
    const dup = parseInt(req.body.dup, 10) || 0;
    if (!keep || !dup || keep === dup) {
      return res.render('admin/merge', { title: 'ادغام رکوردها — فیلمرز', result: null, error: 'شناسه‌ها نامعتبرند.' });
    }
    try {
      const n = queries.mergeMovies(db, keep, dup);
      res.render('admin/merge', { title: 'ادغام رکوردها — فیلمرز', result: { keep, dup, moved: n }, error: null });
    } catch (err) {
      res.render('admin/merge', { title: 'ادغام رکوردها — فیلمرز', result: null, error: String(err.message || err) });
    }
  });

  r.get('/health', (req, res) => {
    res.render('admin/health', { title: 'سلامت لینک‌ها — فیلمرز', health: linkHealth(db), test: null });
  });

  r.post('/health/test', adminLimiter, (req, res) => {
    const id = parseInt(req.body.movie_id, 10) || 0;
    const link = catalog.bestLinkForMovie(db, id);
    let test = { movieId: id, ok: false, message: 'لینکی ثبت نشده است.' };
    if (link) {
      if (link.play_url) {
        test = { movieId: id, ok: true, message: 'play_url ثبت شده است (تست زنده از resolver در صفحه فیلم انجام می‌شود).' };
      } else if (require('../resolver').isProbablyFresh(link.url)) {
        test = { movieId: id, ok: true, message: 'لینک مستقیم ذخیره‌شده قابل استفاده است (بدون انقضا یا هنوز معتبر).' };
      } else {
        test = { movieId: id, ok: false, message: 'لینک مستقیم منقضی شده و play_url ثبت نشده است.' };
      }
    }
    res.render('admin/health', { title: 'سلامت لینک‌ها — فیلمرز', health: linkHealth(db), test });
  });

  app.use('/admin', r);
}

module.exports = {
  adminRoutes,
  requireAdmin,
  saveMovie: adminContent.saveMovie,
  saveSeries: adminContent.saveSeries,
  linkHealth,
};
