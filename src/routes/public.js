'use strict';
const express = require('express');
const config = require('../config');
const catalog = require('../catalog');
const seriesCatalog = require('../series-catalog');
const top250 = require('../top250');
const wishlist = require('../wishlist');
const { rateLimiter } = require('../ratelimit');
const { ResolveError, isProbablyFresh } = require('../resolver');

const suggestLimit = rateLimiter({ windowMs: 60000, max: 60, name: 'suggest' });
const resolveLimit = rateLimiter({ windowMs: 60000, max: 12, name: 'resolve' });
const posterLimit = rateLimiter({ windowMs: 60000, max: 240, name: 'poster' });
const wishlistLimit = rateLimiter({ windowMs: 60000, max: 60, name: 'wishlist' });

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
    seriesHref(series) {
      return `/series/${series.id}-${series.slug}`;
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

function publicRoutes(app, db, sourceClient, seoEngine, indexabilityEvaluator) {
  const helpers = viewHelpers(db);
  app.use((req, res, next) => {
    Object.assign(res.locals, helpers);
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
    
    // Generate SEO metadata (require seoEngine to be available)
    if (typeof seoEngine !== 'undefined') {
      res.locals.seoMetadata = seoEngine.generateMetadata(pageType, seoData, pathname);
    }
    
    // Evaluate indexability (require indexabilityEvaluator to be available)
    if (typeof indexabilityEvaluator !== 'undefined') {
      const evaluation = indexabilityEvaluator.evaluate(pageType, seoData, pathname);
      res.locals.indexability = evaluation;
    }
    
    next();
  });

  app.get('/', (req, res) => {
    const data = catalog.homeData(db);
    const pageType = 'home';
    const pathname = '/';
    const seoData = {};
    
    // Generate SEO metadata
    const seoMetadata = seoEngine.generateMetadata(pageType, seoData, pathname);
    
    res.render('home', {
      title: 'فیلمرز — تماشا و دانلود فیلم',
      data,
      seoMetadata,
      indexability: res.locals.indexability,
    });
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
    
    // Generate SEO metadata
    const pageType = 'movies';
    const pathname = '/movies';
    const seoData = { filters, result, genres, years, personName };
    const seoMetadata = seoEngine.generateMetadata(pageType, seoData, pathname, filters.page, Math.ceil(result.total / config.perPage));
    
    res.render('browse', {
      title: 'فیلم‌ها — فیلمرز',
      filters, result, genres, years, personName,
      seoMetadata,
      indexability: res.locals.indexability,
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
    
    // Generate SEO metadata
    const pageType = 'genres';
    const pathname = '/genres';
    const seoData = { genres };
    const seoMetadata = seoEngine.generateMetadata(pageType, seoData, pathname);
    
    res.render('genres', {
      title: 'ژانرها — فیلمرز',
      genres,
      seoMetadata,
      indexability: res.locals.indexability,
    });
  });

  app.get('/top-250', (req, res) => res.redirect(301, '/top250'));

  app.get('/top250', (req, res) => {
    const items = top250.getTop250(db);
    const available = items.filter((x) => x.movie).length;
    res.render('top250', {
      title: '۲۵۰ فیلم برتر — فیلمرز',
      items, available,
    });
  });

  app.get('/wishlist', (req, res) => {
    const items = wishlist.listFor(db, res.locals.wishlistKey);
    res.render('wishlist', { title: 'نشان‌ها — فیلمرز', items });
  });

  app.get('/series', (req, res) => {
    const filters = {
      genre: req.query.genre || '',
      year: req.query.year || '',
      country: req.query.country || '',
      sort: req.query.sort || 'newest',
      page: req.query.page || 1,
      perPage: config.perPage,
    };
    const result = seriesCatalog.seriesList(db, filters);
    const genres = seriesCatalog.seriesGenreList(db);
    const years = seriesCatalog.seriesYearList(db);
    res.render('series', {
      title: 'سریال‌ها — فیلمرز',
      filters, result, genres, years,
      buildHref(overrides = {}) {
        const merged = { ...req.query, ...overrides };
        for (const k of Object.keys(merged)) {
          if (merged[k] === '' || merged[k] === undefined || merged[k] === null) delete merged[k];
        }
        const s = new URLSearchParams(merged).toString();
        return '/series' + (s ? '?' + s : '');
      },
    });
  });

  app.get('/series/:idSlug', (req, res) => {
    const id = parseIdSlug(req.params.idSlug);
    if (!id) return res.status(404).render('404', { title: 'پیدا نشد' });
    // All seasons/episodes/links are loaded exactly once below; skip the
    // duplicate season query inside getSeriesFull.
    const s = seriesCatalog.getSeriesFull(db, id, { withSeasons: false });
    if (!s || (!s.published && !req.session?.data?.userId)) {
      return res.status(404).render('404', { title: 'پیدا نشد' });
    }
    if (req.params.idSlug !== `${s.id}-${s.slug}`) {
      return res.redirect(301, `/series/${s.id}-${s.slug}`);
    }

    const tree = seriesCatalog.seriesEpisodesTree(db, s.id);
    const seasons = tree.seasons;
    const wantedSeason = parseInt(req.query.season, 10);
    const seasonNo = tree.seasonByNo.has(wantedSeason)
      ? wantedSeason
      : (seasons[0] ? seasons[0].season_no : 0);
    const selectedSeason = tree.seasonByNo.get(seasonNo);
    const episodes = selectedSeason ? selectedSeason.episodes : [];
    const wantedEpisode = parseInt(req.query.episode, 10);
    const episode = episodes.find((e) => e.episode_no === wantedEpisode)
      || episodes[0]
      || null;
    const links = episode ? episode.links : [];
    const related = seriesCatalog.relatedSeries(db, s.id, 8);

    // Compact JSON: [season_no, episode_count, [[episode_id, episode_no,
    //   [[link_id, quality_res, quality_text, extension, scraped_at], ...]], ...]]
    const episodeData = seasons.map((se) => [
      se.season_no,
      se.episode_count,
      se.episodes.map((ep) => [
        ep.id,
        ep.episode_no,
        ep.links.map((l) => [
          l.id, l.quality_res || '', l.quality_text || '', l.extension || '', l.scraped_at || '',
        ]),
      ]),
    ]);
    const episodeJson = JSON.stringify(episodeData).replace(/</g, '\\u003c');

    res.render('series-detail', {
      title: `${s.title_en || s.title_fa} — سریال — فیلمرز`,
      s, seasons, seasonNo, episodes, episode, links, related,
      episodeJson,
      inWishlist: wishlist.isIn(db, res.locals.wishlistKey, 'series', s.id),
      seasonHref(no) { return `/series/${s.id}-${s.slug}?season=${no}`; },
      episodeHref(no, ep) { return `/series/${s.id}-${s.slug}?season=${no}&episode=${ep}`; },
    });
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
    res.render('movie', {
      title: `${movie.title_en || movie.title_fa} — فیلمرز`,
      movie, similar,
      inWishlist: wishlist.isIn(db, res.locals.wishlistKey, 'movie', movie.id),
    });
  });

  app.get('/search', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const page = req.query.page || 1;
    const result = q ? catalog.searchMovies(db, q, page, config.perPage) : { items: [], total: 0, page: 1, pages: 1 };
    const seriesResult = q
      ? seriesCatalog.searchSeries(db, q, 1, 12)
      : { items: [], total: 0, page: 1, pages: 1 };
    
    // Generate SEO metadata
    const pageType = 'search';
    const pathname = '/search';
    const seoData = { q, result, seriesResult };
    const seoMetadata = seoEngine.generateMetadata(pageType, seoData, pathname, page, Math.max(result.pages, seriesResult.pages));
    
    res.render('search', {
      title: q ? `جستجو: ${q} — فیلمرز` : 'جستجو — فیلمرز',
      q, result, seriesResult,
      seoMetadata,
      indexability: res.locals.indexability,
    });
  });

  app.get('/api/suggest', suggestLimit, (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    // Match the client's minimum query length so empty/1-char requests never
    // reach the LIKE queries (which would scan the whole catalogue).
    if (q.length < 2) {
      res.set('Cache-Control', 'public, max-age=30');
      return res.json({ ok: true, items: [] });
    }
    const movies = catalog.suggest(db, q, 8).map((m) => ({
      id: m.id,
      kind: 'movie',
      href: `/movie/${m.id}-${m.slug}`,
      title_en: m.title_en,
      title_fa: m.title_fa,
      year: m.year,
      poster: helpers.posterSrc(m),
    }));
    const series = seriesCatalog.suggestSeries(db, q, 6).map((s) => ({
      id: s.id,
      kind: 'series',
      href: `/series/${s.id}-${s.slug}`,
      title_en: s.title_en,
      title_fa: s.title_fa,
      year: s.year,
      poster: helpers.posterSrc(s),
    }));
    res.set('Cache-Control', 'public, max-age=30');
    res.json({ ok: true, items: [...series, ...movies].slice(0, 8) });
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

  /** Toggle one item in the anonymous persistent wishlist. */
  app.post('/api/wishlist/toggle', wishlistLimit, (req, res) => {
    const token = req.get('x-csrf-token') || (req.body && req.body._csrf) || '';
    if (!token || token !== res.locals.wishlistToken) {
      return res.status(403).json({ ok: false, error: 'CSRF' });
    }
    const type = String((req.body && req.body.type) || '');
    const id = parseInt(req.body && req.body.id, 10);
    if (!['movie', 'series'].includes(type) || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'BAD_REQUEST' });
    }
    const result = wishlist.toggle(db, res.locals.wishlistKey, type, id);
    if (!result) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, ...result });
  });

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

    let link = null;
    const linkId = parseInt(req.query.link, 10);
    if (Number.isFinite(linkId)) {
      link = db.prepare('SELECT * FROM links WHERE id = ? AND movie_id = ?').get(linkId, id);
    } else {
      link = catalog.bestLinkForMovie(db, id);
    }
    if (!link) return res.status(404).json({ ok: false, code: 'NO_LINK', message: 'برای این فیلم لینکی ثبت نشده است.' });

    try {
      const fresh = await resolveLinkRow(sourceClient, link, (u) => catalog.playUrlExists(db, u));
      return res.json(resolvedPayload(kind, fresh));
    } catch (err) {
      return res.status(err.status || 500).json({ ok: false, code: err.code || 'ERROR', message: err.message });
    }
  });

  /** Per-episode link resolver (exact link selected by the user, or the best one). */
  app.get('/api/episodes/:id/resolve', resolveLimit, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const kind = req.query.type === 'download' ? 'download' : 'play';
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, code: 'BAD_ID', message: 'شناسه نامعتبر است.' });
    const episode = seriesCatalog.getEpisode(db, id);
    if (!episode || !episode.series_published) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'قسمت پیدا نشد.' });
    }

    let link = null;
    const linkId = parseInt(req.query.link, 10);
    if (Number.isFinite(linkId)) {
      link = db.prepare('SELECT * FROM episode_links WHERE id = ? AND episode_id = ?').get(linkId, id);
    } else {
      link = seriesCatalog.bestEpisodeLink(db, id);
    }
    if (!link) return res.status(404).json({ ok: false, code: 'NO_LINK', message: 'برای این قسمت لینکی ثبت نشده است.' });

    try {
      const fresh = await resolveLinkRow(sourceClient, link, (u) => seriesCatalog.episodePlayUrlExists(db, u));
      return res.json(resolvedPayload(kind, fresh));
    } catch (err) {
      return res.status(err.status || 500).json({ ok: false, code: err.code || 'ERROR', message: err.message });
    }
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

/**
 * Resolve one stored link. Prefers the stable play_url via the resolver and
 * only falls back to the stored direct URL when its expire param proves it is
 * still valid. `existsFn(playUrl)` is the SSRF guard (row must be in our DB).
 */
async function resolveLinkRow(sourceClient, link, existsFn) {
  if (link.play_url) {
    if (!existsFn(link.play_url)) {
      const err = new Error('لینک پایدار معتبر نیست.');
      err.status = 403;
      err.code = 'SSRF';
      throw err;
    }
    try {
      return { url: await sourceClient.resolve(link.play_url), source: 'resolver' };
    } catch (err) {
      if (err instanceof ResolveError && err.code !== 'NO_CREDENTIALS') {
        const wrapped = new Error(err.message);
        wrapped.status = 502;
        wrapped.code = err.code;
        throw wrapped;
      }
      // NO_CREDENTIALS → try the stored direct link below.
    }
  }
  if (isProbablyFresh(link.url)) return { url: link.url, source: 'direct' };
  const expired = new Error('لینک ذخیره‌شده منقضی شده است. لطفاً کراول را دوباره اجرا کنید.');
  expired.status = 503;
  expired.code = 'LINK_EXPIRED';
  throw expired;
}

/**
 * Build the payload for a freshly resolved link. `url` is the direct media
 * URL. VLC deep links differ per platform:
 * - Android: an Intent URI that targets the VLC package (with a browser
 *   fallback to the direct URL when VLC is not installed).
 * - iOS/iPadOS: VLC's x-callback-url scheme.
 * `vlc` is kept as the legacy desktop form for backwards compatibility.
 */
function resolvedPayload(kind, fresh) {
  const links = vlcLinks(fresh.url);
  return {
    ok: true,
    kind,
    url: fresh.url,
    vlc: links.legacy,
    vlcAndroid: links.android,
    vlcIos: links.ios,
    source: fresh.source,
  };
}

function vlcLinks(url) {
  const full = String(url || '');
  const m = full.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  const scheme = m ? m[1].toLowerCase() : 'https';
  const rest = encodeURI(full.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')).replace(/#/g, '%23');
  const fallback = encodeURIComponent(full);
  return {
    legacy: 'vlc://' + rest,
    android: `intent://${rest}#Intent;package=org.videolan.vlc;type=video/*;scheme=${scheme};S.browser_fallback_url=${fallback};end`,
    ios: 'vlc-x-callback://x-callback-url/stream?url=' + encodeURIComponent(full),
  };
}

function toVlc(url) {
  return vlcLinks(url).legacy;
}

module.exports = { publicRoutes, viewHelpers, toVlc, vlcLinks };
