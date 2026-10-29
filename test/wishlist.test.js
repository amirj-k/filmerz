'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { openAppDb } = require('../src/db');
const wishlist = require('../src/wishlist');

function setup() {
  const db = openAppDb(':memory:');
  const movieId = Number(db.prepare(
    "INSERT INTO movies (slug, title_en, year, published) VALUES ('test-movie', 'Test Movie', 2020, 1)"
  ).run().lastInsertRowid);
  const seriesId = Number(db.prepare(
    "INSERT INTO series (slug, title_en, year, published, season_count, episode_count) VALUES ('test-series', 'Test Series', 2021, 1, 2, 10)"
  ).run().lastInsertRowid);
  return { db, movieId, seriesId };
}

test('wishlist toggles and lists movies and series per owner', () => {
  const { db, movieId, seriesId } = setup();
  const key = 'owner-key-1234567890';

  assert.strictEqual(wishlist.isIn(db, key, 'movie', movieId), false);

  let r = wishlist.toggle(db, key, 'movie', movieId);
  assert.deepStrictEqual(r, { active: true, count: 1 });
  assert.strictEqual(wishlist.isIn(db, key, 'movie', movieId), true);

  r = wishlist.toggle(db, key, 'series', seriesId);
  assert.deepStrictEqual(r, { active: true, count: 2 });

  const items = wishlist.listFor(db, key);
  assert.strictEqual(items.length, 2);
  assert.deepStrictEqual(items.map((x) => x.type).sort(), ['movie', 'series']);
  assert.strictEqual(items.find((x) => x.type === 'movie').item.title_en, 'Test Movie');

  assert.strictEqual(wishlist.countFor(db, 'another-owner'), 0);

  r = wishlist.toggle(db, key, 'movie', movieId);
  assert.deepStrictEqual(r, { active: false, count: 1 });
  assert.strictEqual(wishlist.listFor(db, key).length, 1);

  assert.strictEqual(wishlist.toggle(db, key, 'bad-type', 1), null);
  assert.strictEqual(wishlist.toggle(db, key, 'movie', 999999), null);

  db.close();
});

test('wishlist survives unrelated DB work and cleans orphans', () => {
  const { db, movieId } = setup();
  const key = 'owner-key-1234567890';
  wishlist.toggle(db, key, 'movie', movieId);
  db.prepare('DELETE FROM movies WHERE id = ?').run(movieId);
  wishlist.removeOrphans(db);
  assert.strictEqual(wishlist.countFor(db, key), 0);
  db.close();
});
