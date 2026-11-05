'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { openAppDb } = require('../src/db');
const catalog = require('../src/catalog');
const seriesCatalog = require('../src/series-catalog');
const adminContent = require('../src/admin-content');

function freshDb() {
  return openAppDb(':memory:');
}

test('posterFlag classifies proxy hosts, direct URLs and local uploads', () => {
  assert.strictEqual(adminContent.posterFlag(''), 0);
  assert.strictEqual(adminContent.posterFlag('https://vd1.findmylinkes.ir/poster.jpg'), 1);
  assert.strictEqual(adminContent.posterFlag('https://cdn.intocdn.top/poster.jpg'), 1);
  assert.strictEqual(adminContent.posterFlag('https://example.com/poster.jpg'), 2);
  assert.strictEqual(adminContent.posterFlag('/uploads/posters/a.jpg'), 2);
  assert.throws(() => adminContent.posterFlag('/etc/passwd'));
  assert.throws(() => adminContent.posterFlag('ftp://example.com/poster.jpg'));
});

test('saveMovie creates a movie with classified links and metadata', () => {
  const db = freshDb();
  const id = adminContent.saveMovie(db, {
    title_en: 'Test Movie',
    title_fa: 'فیلم تست',
    other_titles: 'Alternative Title',
    year: '2024',
    age_rating: '16',
    country: 'آمریکا',
    poster_url: 'https://vd1.findmylinkes.ir/poster.jpg',
    plot: 'خلاصه فیلم',
    genres: ['اکشن', 'درام'],
    people: [
      { role: 'director', name: 'Jane Doe' },
      { role: 'actor', name: 'John Smith' },
      { role: 'actor', name: 'Sara Lee' },
    ],
    published: 1,
    featured: 1,
    links: [
      {
        url: 'https://cdn.example.com/Test.Movie.2024.1080p.DUB.mkv',
        quality_text: 'کیفیت 1080 دوبله',
        resolution: '1080',
      },
      {
        url: 'https://cdn.example.com/Test.Movie.2024.720p.sub.srt',
        quality_text: 'کیفیت 720 زیرنویس',
        media_kind: 'subtitle',
      },
    ],
  }, null);

  const movie = catalog.getMovieFull(db, id);
  assert.ok(movie, 'movie is persisted');
  assert.strictEqual(movie.title_en, 'Test Movie');
  assert.strictEqual(movie.title_fa, 'فیلم تست');
  assert.strictEqual(movie.year, 2024);
  assert.strictEqual(movie.poster_valid, 1, 'allow-listed poster goes through the proxy');
  assert.strictEqual(movie.published, 1);
  assert.strictEqual(movie.featured, 1);
  assert.strictEqual(movie.link_count, 2);
  assert.strictEqual(movie.genres.length, 2);
  assert.strictEqual(movie.directors[0].name, 'Jane Doe');
  assert.strictEqual(movie.actors.length, 2);
  assert.ok(movie.country_id, 'country is linked');

  const dub = movie.links.find((l) => l.url.includes('1080p'));
  assert.strictEqual(dub.resolution, '1080p');
  assert.strictEqual(dub.is_dub, 1);
  assert.strictEqual(dub.is_sub, 0);

  const sub = movie.links.find((l) => l.url.endsWith('.srt'));
  assert.strictEqual(sub.media_kind, 'subtitle');
  assert.strictEqual(sub.is_sub, 1);

  db.close();
});

test('movie links dedupe by URL and deletion keeps counts correct', () => {
  const db = freshDb();
  const url = 'https://cdn.example.com/Same.Movie.1080p.mkv';
  const id = adminContent.saveMovie(db, {
    title_en: 'Same Movie',
    links: [{ url, quality_text: 'کیفیت 1080', resolution: '1080p' }],
  }, null);

  const result = adminContent.addMovieLinks(db, id, [
    { url, quality_text: 'کیفیت 1080 دوبله', resolution: '1080' },
    { url: 'https://cdn.example.com/Same.Movie.720p.mkv', quality_text: 'کیفیت 720' },
  ]);
  assert.deepStrictEqual(result, { added: 1, updated: 1 });

  let movie = catalog.getMovieFull(db, id);
  assert.strictEqual(movie.links.length, 2);
  assert.strictEqual(movie.link_count, 2);

  const dub = movie.links.find((l) => l.url === url);
  assert.strictEqual(dub.is_dub, 1, 're-adding the same URL updates the existing row');

  adminContent.deleteMovieLink(db, id, dub.id);
  movie = catalog.getMovieFull(db, id);
  assert.strictEqual(movie.links.length, 1);
  assert.strictEqual(movie.link_count, 1);
  assert.strictEqual(movie.links[0].url.includes('720p'), true);

  db.close();
});

test('saveMovie rolls back when a link is invalid', () => {
  const db = freshDb();
  const before = db.prepare('SELECT COUNT(*) c FROM movies').get().c;
  assert.throws(() => adminContent.saveMovie(db, {
    title_en: 'Bad Link Movie',
    links: [{ url: 'not-a-valid-url' }],
  }, null));
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM movies').get().c, before);
  db.close();
});

test('saveSeries creates seasons, episodes and episode links', () => {
  const db = freshDb();
  const id = adminContent.saveSeries(db, {
    title_en: 'Test Show',
    title_fa: 'نمایش تست',
    year: '2024',
    country: 'آمریکا',
    poster_url: 'https://example.com/poster.jpg',
    plot: 'خلاصه سریال',
    status_text: 'در حال پخش',
    genres: ['درام', 'جنایی'],
    people: [{ role: 'actor', name: 'John Smith' }],
    links: [
      {
        season_no: 1,
        episode_no: 1,
        episode_title: 'شروع',
        url: 'https://cdn.example.com/s01e01.1080p.mkv',
        play_url: 'https://flzios.com/play?x=1',
        quality_text: 'کیفیت 1080',
      },
      {
        season_no: 1,
        episode_no: 2,
        url: 'https://cdn.example.com/s01e02.720p.mkv',
        quality_text: 'کیفیت 720',
      },
      {
        season_no: 2,
        episode_no: 1,
        url: 'https://cdn.example.com/s02e01.1080p.mkv',
        quality_text: 'کیفیت 1080',
      },
    ],
  }, null);

  const series = seriesCatalog.getSeriesFull(db, id);
  assert.ok(series, 'series is persisted');
  assert.strictEqual(series.title_en, 'Test Show');
  assert.strictEqual(series.poster_valid, 2, 'non-proxy poster renders directly');
  assert.strictEqual(series.season_count, 2);
  assert.strictEqual(series.episode_count, 3);
  assert.strictEqual(series.link_count, 3);
  assert.strictEqual(series.status_text, 'در حال پخش');
  assert.strictEqual(series.genres.length, 2);

  const links = seriesCatalog.adminSeriesLinks(db, id);
  assert.strictEqual(links.length, 3);
  assert.deepStrictEqual(links.map((l) => `${l.season_no}:${l.episode_no}`), ['1:1', '1:2', '2:1']);
  assert.strictEqual(links[0].episode_title, 'شروع');
  assert.ok(links[0].play_url);

  const updated = adminContent.addSeriesLinks(db, id, [{
    season_no: 1,
    episode_no: 1,
    url: 'https://cdn.example.com/s01e01.1080p.mkv',
    quality_text: 'کیفیت 1080 دوبله',
  }]);
  assert.deepStrictEqual(updated, { added: 0, updated: 1, episodes: 1 });
  assert.strictEqual(seriesCatalog.adminSeriesLinks(db, id).length, 3);

  db.close();
});

test('deleting episode links prunes empty episodes and seasons', () => {
  const db = freshDb();
  const id = adminContent.saveSeries(db, {
    title_en: 'Prune Show',
    links: [
      { season_no: 1, episode_no: 1, url: 'https://cdn.example.com/1x1.mkv' },
      { season_no: 1, episode_no: 2, url: 'https://cdn.example.com/1x2.mkv' },
      { season_no: 2, episode_no: 1, url: 'https://cdn.example.com/2x1.mkv' },
    ],
  }, null);

  const links = seriesCatalog.adminSeriesLinks(db, id);
  const s01e02 = links.find((l) => l.season_no === 1 && l.episode_no === 2);
  adminContent.deleteEpisodeLink(db, id, s01e02.id);
  let series = seriesCatalog.getSeriesFull(db, id);
  assert.strictEqual(series.season_count, 2);
  assert.strictEqual(series.episode_count, 2);
  assert.strictEqual(series.link_count, 2);

  const s02e01 = seriesCatalog.adminSeriesLinks(db, id)
    .find((l) => l.season_no === 2 && l.episode_no === 1);
  adminContent.deleteEpisodeLink(db, id, s02e01.id);
  series = seriesCatalog.getSeriesFull(db, id);
  assert.strictEqual(series.season_count, 1, 'empty season is pruned');
  assert.strictEqual(series.episode_count, 1);
  assert.strictEqual(series.link_count, 1);

  db.close();
});
