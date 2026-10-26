'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');

const { openAppDb } = require('../src/db');
const { importSeries } = require('../src/series-import');
const seriesCatalog = require('../src/series-catalog');
const { saveSeries } = require('../src/routes/admin');

const SOURCE_SCHEMA = `
CREATE TABLE links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page INTEGER, title TEXT, img_url TEXT, description TEXT, url TEXT, text TEXT,
  scraped_at TEXT DEFAULT CURRENT_TIMESTAMP,
  kind TEXT NOT NULL DEFAULT 'movie',
  season INTEGER NOT NULL DEFAULT 0,
  episode INTEGER NOT NULL DEFAULT 0,
  quality TEXT NOT NULL DEFAULT ''
);
`;

const DESC = 'نام اصلی : Test Showژانر : درام , جنایی محصول : 2024 آمریکارده سنی : 16کارگردان : Jane Doeستارگان : John Smith , Sara Leeخلاصه سریال : یک داستان آزمایشی برای سریال.';

function makeSource() {
  const src = new DatabaseSync(':memory:');
  src.exec(SOURCE_SCHEMA);
  const ins = src.prepare(
    `INSERT INTO links (page, title, img_url, description, url, text, scraped_at, kind, season, episode, quality)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'series', ?, ?, ?)`
  );
  const img = 'https://vd1.findmylinkes.ir/pic-list/lists/1-1000/5.jpg';
  const rows = [
    [5, 'Test Show', img, DESC, 'http://dl.test/s1e1-720.mp4?expire=9999999999', 'کیفیت 720 زیرنویس', '2026-01-01 00:00:00', 1, 1, '720p'],
    [5, 'Test Show', img, DESC, 'http://dl.test/s1e1-1080.mp4?expire=9999999999', 'کیفیت 1080 زیرنویس', '2026-01-01 00:00:01', 1, 1, '1080p'],
    [5, 'Test Show', img, DESC, 'http://dl.test/s1e2-720.mp4?expire=9999999999', 'کیفیت 720 زیرنویس', '2026-01-01 00:00:02', 1, 2, '720p'],
    [5, 'Test Show', img, DESC, 'http://dl.test/s2e1-720.mp4?expire=9999999999', 'کیفیت 720 زیرنویس', '2026-01-01 00:00:03', 2, 1, '720p'],
  ];
  for (const r of rows) ins.run(...r);
  return src;
}

test('importSeries normalizes seasons, episodes and per-episode links', () => {
  const src = makeSource();
  const db = openAppDb(':memory:');
  const stats = importSeries(db, src, { quiet: true });

  assert.strictEqual(stats.newSeries, 1);
  assert.strictEqual(stats.linksUpserted, 4);

  const show = seriesCatalog.seriesList(db, { page: 1, perPage: 10 }).items[0];
  assert.strictEqual(show.title_en, 'Test Show');
  assert.strictEqual(show.season_count, 2);
  assert.strictEqual(show.episode_count, 3);
  assert.strictEqual(show.link_count, 4);

  const full = seriesCatalog.getSeriesFull(db, show.id);
  assert.deepStrictEqual(full.seasons.map((s) => s.season_no), [1, 2]);
  assert.strictEqual(full.seasons[0].episode_count, 2);
  assert.strictEqual(full.directors[0].name, 'Jane Doe');
  assert.ok(full.genres.some((g) => g.name === 'جنایی'));

  const s1 = seriesCatalog.episodesForSeason(db, show.id, 1);
  assert.deepStrictEqual(s1.map((e) => e.episode_no), [1, 2]);
  assert.strictEqual(s1[0].link_count, 2);

  const links = seriesCatalog.episodeLinks(db, s1[0].id);
  assert.strictEqual(links.length, 2);
  assert.strictEqual(links[0].quality_res, '1080p', 'highest quality sorts first');

  const s2 = seriesCatalog.episodesForSeason(db, show.id, 2);
  assert.strictEqual(s2.length, 1);
  const s2links = seriesCatalog.episodeLinks(db, s2[0].id);
  assert.match(s2links[0].url, /s2e1/, 'each episode owns only its own links');

  const search = seriesCatalog.searchSeries(db, 'Test Show', 1, 10);
  assert.strictEqual(search.total, 1);

  src.close();
  db.close();
});

test('admin can edit series metadata without touching episodes', () => {
  const src = makeSource();
  const db = openAppDb(':memory:');
  importSeries(db, src, { quiet: true });
  const id = db.prepare('SELECT id FROM series LIMIT 1').get().id;

  saveSeries(db, {
    title_en: 'Renamed Show',
    title_fa: 'نمایش',
    year: '2025',
    age_rating: '18',
    poster_url: 'https://vd1.findmylinkes.ir/x.jpg',
    plot: 'خلاصه جدید',
    status_text: 'در حال پخش',
    genres: ['درام'],
    people: [{ role: 'actor', name: 'New Actor' }],
    published: 0,
    featured: 1,
  }, id);

  const s = seriesCatalog.getSeriesFull(db, id);
  assert.strictEqual(s.title_en, 'Renamed Show');
  assert.strictEqual(s.title_fa, 'نمایش');
  assert.strictEqual(s.year, 2025);
  assert.strictEqual(s.published, 0);
  assert.strictEqual(s.featured, 1);
  assert.strictEqual(s.status_text, 'در حال پخش');
  assert.deepStrictEqual(s.genres.map((g) => g.name), ['درام']);
  assert.deepStrictEqual(s.actors.map((a) => a.name), ['New Actor']);
  assert.strictEqual(s.episode_count, 3, 'episodes survive metadata edits');
  assert.strictEqual(s.season_count, 2);

  src.close();
  db.close();
});

test('importSeries is idempotent on re-run', () => {
  const src = makeSource();
  const db = openAppDb(':memory:');
  importSeries(db, src, { quiet: true });
  const second = importSeries(db, src, { quiet: true });

  assert.strictEqual(second.newSeries, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM series').get().c, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM seasons').get().c, 2);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM episodes').get().c, 3);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM episode_links').get().c, 4);

  src.close();
  db.close();
});
