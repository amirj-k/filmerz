'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseRow, parseQuality, findFields, splitList } = require('../src/parser');
const { normSearch, convertDigits, slugify, cleanValue } = require('../src/normalizer');
const { canonGenres, canonCountries, cleanTitle, splitPersonName, parseSeries, seriesKeyOf } = require('../src/canon');
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

test('canonGenres merges synonyms and splits composites', () => {
  assert.deepStrictEqual(canonGenres('اکشن- جنایی- کمدی'), ['اکشن', 'جنایی', 'کمدی']);
  assert.deepStrictEqual(canonGenres('هیجان انگیز , مهیج'), ['هیجان‌انگیز']);
  assert.deepStrictEqual(canonGenres('اکشن و مهیج'), ['اکشن', 'هیجان‌انگیز']);
  assert.deepStrictEqual(canonGenres('کمدی عاشقانه درام'), ['کمدی', 'عاشقانه', 'درام']);
  assert.deepStrictEqual(canonGenres('علمی و تخیلی'), ['علمی‌تخیلی']);
  assert.deepStrictEqual(canonGenres('بیوگرافی'), ['زندگی‌نامه']);
  assert.deepStrictEqual(canonGenres('نوآر'), ['فیلم نوآر']);
});

test('canonGenres drops field-bleed and country tokens', () => {
  assert.deepStrictEqual(canonGenres('کمدیکشور سازنده : 1985 آمریکا'), ['کمدی']);
  assert.deepStrictEqual(canonGenres('ماجراجوییکشورها : 2020 ژاپن'), ['ماجراجویی']);
  assert.deepStrictEqual(canonGenres('خانوادگیمحصول 2008 آمریکاقصه درباره کشف'), ['خانوادگی']);
  assert.deepStrictEqual(canonGenres('هندی'), []);
  assert.deepStrictEqual(canonGenres(''), []);
});

test('canonGenres is idempotent on canonical input', () => {
  for (const g of ['اکشن', 'هیجان‌انگیز', 'علمی‌تخیلی', 'فیلم نوآر']) {
    assert.deepStrictEqual(canonGenres(g), [g]);
  }
});

test('canonCountries splits composites, fixes typos and strips bleed', () => {
  assert.deepStrictEqual(canonCountries('هند'), ['هندوستان']);
  assert.deepStrictEqual(canonCountries('آمریکا , هندوستان'), ['آمریکا', 'هندوستان']);
  assert.deepStrictEqual(canonCountries('هندتاریخ اکران : 14 Nov'), ['هندوستان']);
  assert.deepStrictEqual(canonCountries('کانادا .انگلستان'), ['کانادا', 'انگلستان']);
  assert.deepStrictEqual(canonCountries('و USA'), ['آمریکا']);
  assert.deepStrictEqual(canonCountries('Airborne آمریکا'), ['آمریکا']);
  assert.deepStrictEqual(canonCountries('کره جنوبی Minyeoneun Goerowo'), ['کره جنوبی']);
  assert.deepStrictEqual(canonCountries('المان'), ['آلمان']);
  assert.deepStrictEqual(canonCountries('آمريکا'), ['آمریکا']); // Arabic ي folded
  assert.deepStrictEqual(canonCountries('کانادا ده سنی : 16'), ['کانادا']);
  assert.deepStrictEqual(canonCountries('بوسنی و هرزگوین'), ['بوسنی و هرزگوین']);
  assert.deepStrictEqual(canonCountries('اتحاد جماهیر شوروی'), ['شوروی']);
  assert.deepStrictEqual(canonCountries(''), []);
});

test('canonCountries is idempotent on canonical input', () => {
  for (const c of ['آمریکا', 'هندوستان', 'کره جنوبی', 'بوسنی و هرزگوین', 'امارات متحده عربی']) {
    assert.deepStrictEqual(canonCountries(c), [c]);
  }
});

test('cleanTitle strips notices and year bleed, keeps real titles', () => {
  assert.strictEqual(cleanTitle('جمعه سیزدهمسال تولید : ۲۰۰۹'), 'جمعه سیزدهم');
  assert.strictEqual(cleanTitle('Finding Mr Destiny** توجه : پخش آنلاین مشکل دارد'), 'Finding Mr Destiny');
  assert.strictEqual(cleanTitle('سیندرلا – Cinderella سال تولید: 1950'), 'سیندرلا');
  assert.strictEqual(cleanTitle('America: The Motion Picture'), 'America: The Motion Picture'); // real colon kept
  assert.strictEqual(cleanTitle('Pitch Perfect 3ژانر »موسیقی ،کمدی'), 'Pitch Perfect 3');
});

test('splitPersonName cuts glued labels and prose', () => {
  assert.strictEqual(splitPersonName('Michaël R. Roskamنویسندگان: Thomas Bidegain'), 'Michaël R. Roskam');
  assert.strictEqual(splitPersonName('Frank CoraciبازیگرانBrandon Keener'), 'Frank Coraci');
  assert.strictEqual(splitPersonName('Chan-Young Yoonخلاصه: بریار'), 'Chan-Young Yoon');
  assert.strictEqual(splitPersonName('Ciaran Foyستاره ها'), 'Ciaran Foy');
  assert.strictEqual(splitPersonName('Ciaran Foyستاره‌ها'), 'Ciaran Foy');
  assert.strictEqual(splitPersonName('پینکی راجپوت و… صداپیشگی کرده اند'), 'پینکی راجپوت');
  assert.strictEqual(splitPersonName('خلاصه'), '');
  assert.strictEqual(splitPersonName('RZA'), 'RZA'); // legit short name kept
});

test('parseSeries extracts franchise base and episode numbers', () => {
  const f = parseSeries('Friday the 13th Part III (1982)', 'جمعه سیزدهم');
  assert.strictEqual(f.baseEn, 'Friday the 13th');
  assert.strictEqual(f.episode, 3);
  const p = parseSeries('Rambo: First Blood Part II', 'رمبو: اولین خون، قسمت ۲');
  assert.strictEqual(p.episode, 2);
  assert.strictEqual(p.baseEn, 'Rambo: First Blood');
  const fa = parseSeries('', 'خانه شلوغ ۴');
  assert.strictEqual(fa.baseFa, 'خانه شلوغ');
  assert.strictEqual(fa.episode, 4);
  const ord = parseSeries('', 'جمعه سیزدهم قسمت هفتم');
  assert.strictEqual(ord.episode, 7);
  const plain = parseSeries('Inception', 'پیدایش');
  assert.strictEqual(seriesKeyOf(plain), normSearch('Inception'));
  assert.strictEqual(plain.episode, 0); // no sequel marker
});
