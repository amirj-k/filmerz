'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseRow, parseQuality, findFields, splitList } = require('../src/parser');
const { normSearch, convertDigits, slugify, cleanValue } = require('../src/normalizer');
const { extFromUrl, hostOf } = require('../scripts/import');

test('findFields extracts labeled Persian fields', () => {
  const d = [
    'نام اصلی : Inception',
    'نام فیلم : پیدایش',
    'ژانر : علمی تخیلی , اکشن',
    'کارگردان : Christopher Nolan',
    'ستارگان : Leonardo DiCaprio , Tom Hardy',
  ].join('\n');
  const f = findFields(d);
  assert.strictEqual(f.nameEn, 'Inception');
  assert.match(f.genresRaw, /اکشن/);
  assert.match(f.actorsRaw, /Leonardo DiCaprio/);
});

test('parseRow produces clean normalized movie', () => {
  const m = parseRow({
    title: 'Violationنام فیلم : تخلف',
    url: 'http://dl.example/movie/Violation.2020.720p.WEB-DL.mp4',
    text: 'کیفیت 720x265 هاردساب',
    description: [
      'نام اصلی : Violation',
      'نام فیلم : تخلف',
      'ژانر : ترسناک , درام',
      'محصول کشور : کانادا',
      'کارگردان : Dusty Mancinelli',
      'ستارگان : Anna Maguire',
      'یک زن در آستانه طلاق به خانه بازمی‌گردد.',
    ].join('\n'),
  });
  assert.strictEqual(m.titleEn, 'Violation');
  assert.strictEqual(m.titleFa, 'تخلف');
  assert.strictEqual(m.year, 2020);
  assert.strictEqual(m.country, 'کانادا');
  assert.deepStrictEqual(m.genres, ['ترسناک', 'درام']);
  assert.strictEqual(m.actors[0], 'Anna Maguire');
  assert.ok(m.plot.length > 0);
  assert.strictEqual(m.quality.resolution, '720p');
  assert.strictEqual(m.quality.codec, 'x265');
  assert.strictEqual(m.quality.hardsub, true);
});

test('parseQuality reads part numbers and hardsub', () => {
  assert.strictEqual(parseQuality('کیفیت 1080 هاردساب قسمت دوم').part, 2);
  assert.strictEqual(parseQuality('کیفیت 480 زیرنویس قسمت 7').part, 7);
  assert.strictEqual(parseQuality('دوبله فارسی').part, 0);
  assert.strictEqual(parseQuality('سانسور شده').censored, true);
});

test('splitList handles Persian and ASCII separators', () => {
  assert.deepStrictEqual(splitList('اکشن,درام؛کمدی'), ['اکشن', 'درام', 'کمدی']);
  assert.deepStrictEqual(splitList('AA , BB | CC'), ['AA', 'BB', 'CC']);
  assert.deepStrictEqual(splitList('علمی تخیلی , اکشن'), ['علمی تخیلی', 'اکشن']);
});

test('normSearch folds digits, variants and presentation forms', () => {
  assert.strictEqual(convertDigits('۲۰۲۰'), '2020');
  assert.strictEqual(normSearch('كیمیا ﻓیلﻢ'), normSearch('کیمیا فیلم'));
  assert.ok(!/[«»"(),.;!?]/.test(normSearch('The "Matrix"!')));
});

test('slugify produces dash-joined slugs (Persian allowed)', () => {
  assert.strictEqual(slugify('The Matrix!'), 'the-matrix');
  const slug = slugify('فیلم خارجی The-Flash 2023');
  assert.match(slug, /^[\w\u0600-\u06FF-]+$/u);
  assert.ok(!/\s/.test(slug));
});

test('cleanValue trims edges only', () => {
  assert.strictEqual(cleanValue('  اکشن  '), 'اکشن');
  assert.ok(cleanValue('Inception‌ 2010').includes('2010'));
});

test('import helpers read url parts safely', () => {
  assert.strictEqual(extFromUrl('http://x.y/a/b/file.mp4?expire=1'), 'mp4');
  assert.strictEqual(extFromUrl('http://x.y/noframe'), '');
  assert.strictEqual(extFromUrl('::::'), '');
  assert.strictEqual(hostOf('https://CDN.example.com/x.jpg'), 'cdn.example.com');
  assert.strictEqual(hostOf('not a url'), '');
});
