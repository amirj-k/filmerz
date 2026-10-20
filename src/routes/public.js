'use strict';
const express = require('express');
const config = require('../config');
const catalog = require('../catalog');
const { rateLimiter } = require('../ratelimit');
const { ResolveError, isProbablyFresh } = require('../resolver');

const suggestLimit = rateLimiter({ windowMs: 60000, max: 60, name: 'suggest' });
const resolveLimit = rateLimiter({ windowMs: 60000, max: 12, name: 'resolve' });
const posterLimit = rateLimiter({ windowMs: 60000, max: 240, name: 'poster' });

/** Build helpers exposed to all templates. */
function viewHelpers(db) {
  return {
    posterSrc(movie) {
      if (movie.poster_valid === 2 && movie.poster_url) return movie.poster_url; // local upload
      if (movie.poster_valid === 1 && movie.poster_url) return `/poster?u=${encodeURIComponent(movie.poster_url)}`;
      return '';
    },
    movieHref(movie) {
      return `/movie/${movie.id}-${movie.slug}`;
    },
    yearOf(movie) {
      return movie.year ? movie.year : '';
    },
  };
}

function parseIdSlug(idSlug) {
  const m = String(idSlug || '').match(/^(\d+)(?:[-].*)?$/);
  return m ? parseInt(m[1], 10) : null;
}

function publicRoutes(app, db, sourceClient) {
  const helpers = viewHelpers(db);
  app.use((req, res, next) => {
    Object.assign(res.locals, helpers);
    res.locals.currentPath = req.path;
    res.locals.query = req.query;
    next();
  });

  app.get('/', (req, res) => {
    const data = catalog.homeData(db);
    res.render('home', { title: 'فیلمز — تماشا و دانلود فیلم', data });
  });

  app.get('/browse', (req, res) => {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(301, '/movies' + qs);
  });

  app.get('/movies', (req, res) => {
    const filters = {
      genre: req.query.genre || '',
      year: req.query.year || '',
      country: req.query.country || '',
      person: req.query.person || '',
      sort: req.query.sort || 'newest',
      page: req.query.page || 1,
      perPage: config.perPage,
    };
    const result = catalog.browseMovies(db, filters);
    const genres = catalog.genreList(db);
    const years = catalog.yearList(db);
    let personName = '';
    if (filters.person) {
      const p = db.prepare('SELECT name FROM people WHERE id = ?').get(parseInt(filters.person, 10) || 0);
      personName = p ? p.name : '';
    }
    res.render('browse', {
      title: 'فیلم‌ها — فیلمز',
      filters, result, genres, years, personName,
      buildQuery(overrides) {
        const merged = { ...req.query, ...overrides };
        for (const k of Object.keys(merged)) if (merged[k] === '' || merged[k] === undefined || merged[k] === null) delete merged[k];
        const s = new URLSearchParams(merged).toString();
        return '/movies' + (s ? '?' + s : '');
      },
    });
  });

  app.get('/genres', (req, res) => {
    const genres = catalog.genreList(db);
    res.render('genres', { title: 'ژانرها — فیلمز', genres });
  });

  app.get('/movie/:idSlug', (req, res) => {
    const id = parseIdSlug(req.params.idSlug);
    if (!id) return res.status(404).render('404', { title: 'پیدا نشد' });
    const movie = catalog.getMovieFull(db, id);
    if (!movie || (!movie.published && !req.session?.data?.userId)) {
      return res.status(404).render('404', { title: 'پیدا نشد' });
    }
    if (req.params.idSlug !== `${movie.id}-${movie.slug}`) {
      return res.redirect(301, `/movie/${movie.id}-${movie.slug}`);
    }
    const similar = catalog.similarMovies(db, id, 8);
    res.render('movie', { title: `${movie.title_en || movie.title_fa} — فیلمز`, movie, similar });
  });

  app.get('/search', (req, res) => {
    const q = String(req.query.q || '').slice(0, 100);
    const page = req.query.page || 1;
    const result = q ? catalog.searchMovies(db, q, page, config.perPage) : { items: [], total: 0, page: 1, pages: 1 };
    res.render('search', { title: q ? `جستجو: ${q} — فیلمز` : 'جستجو — فیلمز', q, result });
  });

  app.get('/api/suggest', suggestLimit, (req, res) => {
    const items = catalog.suggest(db, String(req.query.q || ''), 8).map((m) => ({
      id: m.id,
      href: `/movie/${m.id}-${m.slug}`,
      title_en: m.title_en,
      title_fa: m.title_fa,
      year: m.year,
      poster: helpers.posterSrc(m),
    }));
    res.set('Cache-Control', 'public, max-age=30');
    res.json({ ok: true, items });
  });

  app.get('/healthz', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ok: true, db: true });
    } catch {
      res.status(500).json({ ok: false, db: false });
    }
  });

  registerApiAndPoster(app, db, sourceClient);
}

/** /api/movies/:id/resolve + /poster proxy (split out to keep files small). */
function registerApiAndPoster(app, db, sourceClient) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const posterDir = path.join(config.dataDir, 'cache', 'posters');
  const posterHostsRe = new RegExp(config.posterHosts, 'i');

  /**
   * Fresh-link endpoint used by both buttons on the movie page. Never hands
   * out a stale stored link unless its expire param proves it is still
   * valid — and always prefers the stable play_url via the resolver.
   */
  app.get('/api/movies/:id/resolve', resolveLimit, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const kind = req.query.type === 'download' ? 'download' : 'play';
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, code: 'BAD_ID', message: 'شناسه نامعتبر است.' });
    const movie = db.prepare('SELECT id, published FROM movies WHERE id = ?').get(id);
    if (!movie || !movie.published) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'فیلم پیدا نشد.' });

    const link = catalog.bestLinkForMovie(db, id);
    if (!link) return res.status(404).json({ ok: false, code: 'NO_LINK', message: 'برای این فیلم لینکی ثبت نشده است.' });

    if (link.play_url) {
      if (!catalog.playUrlExists(db, link.play_url)) {
        return res.status(403).json({ ok: false, code: 'SSRF', message: 'لینک پایدار معتبر نیست.' });
      }
      try {
        const fresh = await sourceClient.resolve(link.play_url);
        return res.json({ ok: true, kind, url: fresh, vlc: toVlc(fresh), source: 'resolver' });
      } catch (err) {
        if (err instanceof ResolveError && err.code !== 'NO_CREDENTIALS') {
          return res.status(502).json({ ok: false, code: err.code, message: err.message });
        }
        // fall through to the stale fallback (e.g. credentials not configured)
      }
    }

    // No stable play_url (crawler not re-run yet) — fall back to the stored
    // direct link ONLY if its expire parameter proves it is still valid.
    if (isProbablyFresh(link.url)) {
      return res.json({ ok: true, kind, url: link.url, vlc: toVlc(link.url), source: 'stale-ok' });
    }
    return res.status(503).json({
      ok: false,
      code: 'LINK_EXPIRED',
      message: 'لینک ذخیره‌شده منقضی شده و play_url ثبت نشده است. کراول را با پشتیبانی play_url دوباره اجرا کنید.',
    });
  });

  /** Poster proxy with on-disk cache; host-allowlisted; never an open proxy. */
  app.get('/poster', posterLimit, async (req, res) => {
    const raw = String(req.query.u || '');
    let u;
    try { u = new URL(raw); } catch { return res.status(400).send('bad url'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return res.status(400).send('bad protocol');
    if (!posterHostsRe.test(u.hostname)) return res.status(403).send('host not allowed');

    const key = crypto.createHash('sha1').update(u.toString()).digest('hex');
    const file = path.join(posterDir, key + '.img');
    if (fs.existsSync(file)) {
      res.set('Cache-Control', 'public, max-age=1209600, immutable');
      return res.sendFile(file);
    }
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) return res.status(404).send('not found');
      const type = (r.headers.get('content-type') || '').split(';')[0];
      if (!/^image\/(jpe?g|png|webp|avif|gif)$/.test(type)) return res.status(415).send('not an image');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 4 * 1024 * 1024) return res.status(413).send('too large');
      fs.mkdirSync(posterDir, { recursive: true });
      fs.writeFileSync(file, buf);
      res.set('Cache-Control', 'public, max-age=1209600, immutable');
      res.set('Content-Type', type);
      return res.send(buf);
    } catch {
      return res.status(502).send('fetch failed');
    }
  });
}

function toVlc(url) {
  return 'vlc://' + String(url).replace(/^https?:\/\//i, '');
}

module.exports = { publicRoutes, viewHelpers, toVlc };
