'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const queries = require('../queries');
const catalog = require('../catalog');
const seriesCatalog = require('../series-catalog');
const { canonCountries } = require('../canon');
const { createSession, destroySession } = require('../session');
const { csrfMiddleware } = require('../csrf');
const { rateLimiter } = require('../ratelimit');

const loginLimiter = rateLimiter({ windowMs: 15 * 60000, max: 10, name: 'admin-login' });
const adminLimiter = rateLimiter({ windowMs: 60000, max: 120, name: 'admin' });

function requireAdmin(req, res, next) {
  if (req.session && req.session.data && req.session.data.userId) return next();
  if (req.method === 'GET') return res.redirect('/admin/login');
  return res.status(403).send('دسترسی مجاز نیست.');
}
function blankMovie() {
  return {
    id: 0, slug: '', title_en: '', title_fa: '', alt_titles: '', year: '',
    country_id: null, age_rating: '', poster_url: '', poster_valid: 0,
    plot: '', published: 1, featured: 0,
    genres: [], directors: [], writers: [], actors: [], links: [],
  };
}

/** Persist the movie edit form (JSON body from admin UI). */
function saveMovie(db, body, id) {
  const data = {
    title_en: String(body.title_en || '').trim(),
    title_fa: String(body.title_fa || '').trim(),
    other_titles: String(body.other_titles || '').trim(),
    year: parseInt(body.year, 10) || null,
    age_rating: String(body.age_rating || '').trim(),
    poster_url: String(body.poster_url || '').trim(),
    plot: String(body.plot || '').trim(),
  };
  if (!data.title_en && !data.title_fa) throw new Error('عنوان لازم است.');
  if (data.year && (data.year < 1900 || data.year > 2100)) throw new Error('سال نامعتبر است.');

  let movieId;
  if (id) {
    movieId = queries.updateMovie(db, id, data);
  } else {
    movieId = queries.insertMovie(db, data);
  }
  if (body.country) {
    const countryName = canonCountries(String(body.country))[0] || '';
    const c = countryName ? queries.getOrCreateCountry(db, countryName) : null;
    if (c) db.prepare('UPDATE movies SET country_id = ? WHERE id = ?').run(c.id, movieId);
  }
  if (Array.isArray(body.genres)) {
    queries.setMovieGenres(db, movieId, body.genres.map((g) => String(g).trim()).filter(Boolean));
  }
  if (Array.isArray(body.people)) {
    const byRole = { director: [], writer: [], actor: [] };
    for (const p of body.people) {
      if (!p || !p.name) continue;
      const role = ['director', 'writer', 'actor'].includes(p.role) ? p.role : 'actor';
      byRole[role].push(String(p.name));
    }
    for (const role of Object.keys(byRole)) queries.setMoviePeople(db, movieId, role, byRole[role]);
  }
  if (body.published !== undefined) queries.setMoviePublished(db, movieId, body.published ? 1 : 0);
  if (body.featured !== undefined) queries.setMovieFeatured(db, movieId, body.featured ? 1 : 0);
  syncMovieFts(db, movieId);
  queries.recomputeMovieCounts(db, movieId);
  return movieId;
}

/** Persist an admin edit for a series (series themselves come from import). */
function saveSeries(db, body, id) {
  const row = db.prepare('SELECT id FROM series WHERE id = ?').get(id);
  if (!row) throw new Error('سریالی با این شناسه وجود ندارد.');
  const data = {
    title_en: String(body.title_en || '').trim(),
    title_fa: String(body.title_fa || '').trim(),
    year: parseInt(body.year, 10) || null,
    age_rating: String(body.age_rating || '').trim(),
    poster_url: String(body.poster_url || '').trim(),
    plot: String(body.plot || '').trim(),
    status_text: String(body.status_text || '').trim(),
  };
  if (!data.title_en && !data.title_fa) throw new Error('عنوان لازم است.');
  if (data.year && (data.year < 1900 || data.year > 2100)) throw new Error('سال نامعتبر است.');

  db.prepare(
    `UPDATE series SET title_en = ?, title_en_norm = ?, title_fa = ?, title_fa_norm = ?,
       year = ?, age_rating = ?, poster_url = ?, plot = ?, status_text = ?
     WHERE id = ?`
  ).run(data.title_en, normSeries(data.title_en), data.title_fa, normSeries(data.title_fa),
    data.year, data.age_rating, data.poster_url, data.plot, data.status_text, id);

  const slug = seriesSlug(data.title_en, data.title_fa, id);
  db.prepare('UPDATE series SET slug = ? WHERE id = ?').run(slug, id);

  if (body.country) {
    const countryName = canonCountries(String(body.country))[0] || '';
    const c = countryName ? queries.getOrCreateCountry(db, countryName) : null;
    if (c) db.prepare('UPDATE series SET country_id = ? WHERE id = ?').run(c.id, id);
  }
  if (Array.isArray(body.genres)) {
    queries.setSeriesGenres(db, id, body.genres.map((g) => String(g).trim()).filter(Boolean));
  }
  if (Array.isArray(body.people)) {
    const byRole = { director: [], writer: [], actor: [] };
    for (const p of body.people) {
      if (!p || !p.name) continue;
      const role = ['director', 'writer', 'actor'].includes(p.role) ? p.role : 'actor';
      byRole[role].push(String(p.name));
    }
    for (const role of Object.keys(byRole)) queries.setSeriesPeople(db, id, role, byRole[role]);
  }
  if (body.published !== undefined) {
    db.prepare('UPDATE series SET published = ? WHERE id = ?').run(body.published ? 1 : 0, id);
  }
  if (body.featured !== undefined) {
    db.prepare('UPDATE series SET featured = ? WHERE id = ?').run(body.featured ? 1 : 0, id);
  }
  queries.syncSeriesFts(db, id);
  queries.recomputeSeriesCounts(db, id);
  return id;
}

function normSeries(s) { return require('../normalizer').normSearch(s); }
function seriesSlug(en, fa, id) {
  const base = String(en || fa || 'series').toLowerCase()
    .replace(/[^\w\u0600-\u06FF]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'series';
  return `${base}-${id}`;
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
  r.get('/login', csrfMiddleware, (req, res) => {
    if (req.session.data.userId) return res.redirect('/admin');
    res.render('admin/login', { title: 'ورود مدیر — فیلمرز', error: null });
  });

  r.post('/login', loginLimiter, csrfMiddleware, (req, res) => {
    const { username, password } = req.body || {};
    const row = db.prepare('SELECT id, username, password_hash FROM admin_users WHERE username = ?').get(String(username || '').trim());
    const ok = row && bcrypt.compareSync(String(password || ''), row.password_hash);
    if (!ok) {
      return res.status(401).render('admin/login', { title: 'ورود مدیر — فیلمرز', error: 'نام کاربری یا گذرواژه نادرست است.' });
    }
    // Rotate the session id on privilege change (fixation defence).
    destroySession(req, res);
    createSession(res, req, { userId: row.id, username: row.username });
    res.redirect('/admin');
  });

  r.post('/logout', requireAdmin, csrfMiddleware, (req, res) => {
    destroySession(req, res);
    res.redirect('/');
  });

  // Everything below needs an admin session + CSRF on writes.
  r.use(requireAdmin, (req, res, next) => {
    res.locals.username = req.session.data.username;
    if (req.method === 'POST') return csrfMiddleware(req, res, next);
    next();
  });

  r.get('/', adminLimiter, (req, res) => {
    const q = String(req.query.q || '').slice(0, 100);
    const page = parseInt(req.query.page, 10) || 1;
    let result = { items: [], total: 0, page: 1, pages: 1 };
    if (q) result = queries.adminSearchMovies(db, q, page, 20);
    const stats = linkHealth(db);
    res.render('admin/dashboard', { title: 'پنل مدیریت — فیلمرز', q, page, result, stats });
  });

  r.get('/movies/new', (req, res) => {
    res.render('admin/edit', {
      title: 'افزودن فیلم — فیلمرز', movie: blankMovie(), allGenres: catalog.genreList(db), isnew: true,
    });
  });

  r.post('/movies/new', (req, res) => {
    try {
      const id = saveMovie(db, req.body || {}, null);
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
      movie, allGenres: catalog.genreList(db), isnew: false,
    });
  });

  r.post('/movies/:id/edit', (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    try {
      saveMovie(db, req.body || {}, id);
      res.json({ ok: true });
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

  // ---- series (imported from links.db, editable here) -----------------
  r.get('/series', adminLimiter, (req, res) => {
    const q = String(req.query.q || '').slice(0, 100);
    const page = parseInt(req.query.page, 10) || 1;
    let result = { items: [], total: 0, page: 1, pages: 1 };
    if (q) result = seriesCatalog.adminSearchSeries(db, q, page, 20);
    res.render('admin/series', { title: 'مدیریت سریال‌ها — فیلمرز', q, page, result, stats: linkHealth(db) });
  });

  r.get('/series/:id/edit', (req, res) => {
    const series = seriesCatalog.getSeriesFull(db, parseInt(req.params.id, 10) || 0);
    if (!series) return res.status(404).render('404', { title: 'پیدا نشد' });
    res.render('admin/series-edit', {
      title: `ویرایش سریال: ${series.title_en || series.title_fa} — فیلمرز`,
      series, allGenres: catalog.genreList(db),
    });
  });

  r.post('/series/:id/edit', (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    try {
      saveSeries(db, req.body || {}, id);
      res.json({ ok: true, id });
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

module.exports = { adminRoutes, requireAdmin, saveMovie, saveSeries, linkHealth };
