'use strict';

const { normSearch, convertDigits, cleanValue } = require('./normalizer');

/**
 * Data canonicalization for the messy crawl output.
 *
 * Everything here is idempotent: applying canonGenres / cleanTitle /
 * splitPersonName / parseSeries to already-clean input returns it unchanged,
 * so the importer, the admin panel and scripts/cleanup.js can all share them.
 */

/* ------------------------------------------------------------------ *
 * Genres
 * ------------------------------------------------------------------ */

/** Canonical display names → the only genre labels the site shows. */
const GENRE_CANON = [
  'اکشن', 'هیجان‌انگیز', 'جنایی', 'ترسناک', 'کمدی', 'درام', 'عاشقانه',
  'ماجراجویی', 'فانتزی', 'معمایی', 'علمی‌تخیلی', 'تاریخی', 'انیمیشن', 'انیمه',
  'خانوادگی', 'مستند', 'زندگی‌نامه', 'جنگی', 'ورزشی', 'موسیقی', 'موزیکال',
  'وسترن', 'غم‌انگیز', 'رازآلود', 'اجتماعی', 'کوتاه', 'استندآپ کمدی', 'فیلم نوآر',
  'کلاسیک',
];

/** normKey → canonical display name. Keys have ZWNJ folded to spaces. */
const GENRE_MAP = new Map();
for (const name of GENRE_CANON) GENRE_MAP.set(canonKey(name), name);
// Synonyms and spelling variants observed in the crawl
for (const [keys, canon] of [
  [['هیجانی', 'هیجان انگیر', 'مهیج', 'دلهره اور', 'دلهره آور', 'تریلر'], 'هیجان‌انگیز'],
  [['رمانتیک'], 'عاشقانه'],
  [['راز الود', 'رازالود'], 'رازآلود'],
  [['زندگینامه', 'زندیگنامه', 'بیوگرافی'], 'زندگی‌نامه'],
  [['ماجرایی', 'ماجراجویانه'], 'ماجراجویی'],
  [['غم انگیز', 'غمانگیز'], 'غم‌انگیز'],
  [['موزیک', 'اهنگ', 'آهنگ'], 'موسیقی'],
  [['انیمیش'], 'انیمیشن'],
  [['وحشت'], 'ترسناک'],
  [['ملودرام'], 'درام'],
  [['پلیسی'], 'جنایی'],
  [['حیات وحش', 'مستند حیات وحش'], 'مستند'],
  [['کشتی کج'], 'ورزشی'],
  [['رزمی'], 'اکشن'],
  [['تخیلی', 'علمی نخیلی', 'علمی'], 'علمی‌تخیلی'],
  [['استد اپ کمدی'], 'استندآپ کمدی'],
  [['فیلم نوار', 'نوآر'], 'فیلم نوآر'],
  [['دراماتیک'], 'درام'],
  [['کلاسیک'], 'کلاسیک'],
  // junk that should vanish entirely (countries / labels glued in)
  [['ژاپن', 'کانادا', 'امریکا', 'امریکایی', 'هند', 'ایران', 'کره', 'فرانسه', 'تولید'], ''],
]) {
  for (const k of keys) GENRE_MAP.set(canonKey(k), canon);
}

function canonKey(s) {
  return normSearch(String(s || '').replace(/\u200c/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Label words that bleed into genre values in the crawl. */
const GENRE_BLEED_RE = /(?:کشور سازنده|کشورها|محصول|انتشار|سال تولید|سال ساخت|سال انتشار|رده سنی|خلاصه|قصه|داستان|کارگردان|بازیگر|ستاره|نویسنده|نام فیلم|نام اصلی).*$/u;

/** Normalize a raw genre value into canonical genre names; unknown → dropped. */
function canonGenres(raw) {
  const out = [];
  const push = (name) => {
    if (name && !out.includes(name)) out.push(name);
  };
  for (const chunk of String(raw || '').split(/[,،;؛|/\n.]+|\s*[-–—]\s*|\s+و\s+/u)) {
    const piece = canonKey(cleanValue(chunk).replace(GENRE_BLEED_RE, ' '));
    if (!piece) continue;
    const direct = GENRE_MAP.get(piece);
    if (direct) { push(direct); continue; }
    // Greedy longest-match over known keys: «کمدی عاشقانه درام» → 3 genres
    const words = piece.split(' ');
    let i = 0;
    while (i < words.length) {
      let hit = null;
      for (let len = Math.min(4, words.length - i); len >= 1; len--) {
        const k = words.slice(i, i + len).join(' ');
        if (GENRE_MAP.has(k)) { hit = { name: GENRE_MAP.get(k), len }; break; }
      }
      if (!hit || !hit.name) break; // prose bleed → the rest is dropped
      push(hit.name);
      i += hit.len;
    }
  }
  return out;
}
/* ------------------------------------------------------------------ *
 * Titles
 * ------------------------------------------------------------------ */

/** Labels that glue onto the end of crawled titles. */
const TITLE_BLEED_RE = /\*\*.*$|(?:ژانر|محصول|کارگردان|بازیگران|بازیگر|ستارگان|خلاصه|توجه|توضیح|موضوع|سال تولید|سال انتشار|سال ساخت|تاریخ انتشار|نام\s*[:：]|کشور سازنده|کشورها).*$/u;
const YEAR_TAIL_RE = /(?:سال تولید|سال انتشار|سال ساخت|تاریخ انتشار)\s*[:：]?\s*\S{0,6}\s*$/u;

/** Remove crawled notices / label bleed from a title. Idempotent. */
function cleanTitle(title) {
  let s = cleanValue(convertDigits(String(title || '')));
  if (!s) return '';
  s = s.replace(TITLE_BLEED_RE, ' ');
  s = s.replace(YEAR_TAIL_RE, ' ');
  s = s.replace(/[:：]\s*(?:1[89]\d{2}|20\d{2}|\d{2,4})\s*$/u, ' '); // «: ۲۰۰۹»
  // «سیندرلا – Cinderella …» → keep the Persian head
  s = s.replace(/\s*[_\u2013\u2014]\s*[A-Za-z].*$/u, ' ');
  s = cleanValue(s.replace(/\s{2,}/g, ' '));
  return s.replace(/[-–—|*\s:：]+$/u, '').trim();
}

/* ------------------------------------------------------------------ *
 * People
 * ------------------------------------------------------------------ */

/** Labels that glue onto person names («…Roskamنویسندگان: T. Bidegain»). */
const PERSON_BLEED_RE = /صداپیشگی|صداپیشگان|نویسندگان|نویسنده|بازیگران|بازیگر|ستارگان|ستاره[\s\u200c]*های?|کارگردانان|کارگردان|خلاصه|Starring|[:\uFF1A]/u;

/** Split a bled-together person field value into a clean name. */
function splitPersonName(name) {
  let s = cleanValue(String(name || ''));
  if (!s) return '';
  s = s.split(PERSON_BLEED_RE)[0];
  s = cleanValue(s.replace(/(?:و…|و|با)\s*$/u, ''));
  if (!s || !/[\u0600-\u06FFA-Za-z]/.test(s)) return ''; // digits/emoji only
  return s;
}

/* ------------------------------------------------------------------ *
 * Series (فرنچایز / sequel chains)
 * ------------------------------------------------------------------ */

const ROMAN = { II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 };
const FA_ORDINAL = { اول: 1, دوم: 2, سوم: 3, چهارم: 4, پنجم: 5, ششم: 6, هفتم: 7, هشتم: 8, نهم: 9, دهم: 10 };

/**
 * Extract a franchise base title + episode number.
 *  «Friday the 13th Part III (1982)» → { baseEn: 'Friday the 13th', episode: 3 }
 *  «خانه شلوغ 4»                     → { baseFa: 'خانه شلوغ', episode: 4 }
 */
function parseSeries(titleEn, titleFa) {
  const take = (s) => {
    let t = cleanValue(convertDigits(String(s || '')));
    if (!t) return { t: '', ep: 0 };
    t = t.replace(/\((?:1[89]|20)\d{2}\)/g, ' ');          // (1982)
    t = t.replace(/\*\*.*$/, ' ');
    let ep = 0;
    let m = t.match(/(?:قسمت|فصل)\s*(\d{1,3}|اول|دوم|سوم|چهارم|پنجم|ششم|هفتم|هشتم|نهم|دهم)/u);
    if (!m) m = t.match(/\bPart\s*(\d{1,3}|I{1,3}|IV|VI{0,3}|IX|X|XI{0,2})\b/i);
    if (m) {
      const w = m[1];
      ep = /^\d+$/.test(w) ? parseInt(w, 10)
        : (FA_ORDINAL[w] || ROMAN[w.toUpperCase()] || 0);
      t = t.replace(m[0], ' ');
    }
    const tail = t.match(/\s(\d{1,3})\s*$/);               // «خانه شلوغ 4»
    if (!ep && tail && parseInt(tail[1], 10) <= 30) {
      ep = parseInt(tail[1], 10);
      t = t.replace(tail[0], ' ');
    }
    return { t: cleanTitle(t), ep };
  };
  const en = take(titleEn);
  const fa = take(titleFa);
  return { baseEn: en.t, baseFa: fa.t, episode: en.ep || fa.ep || 0 };
}

/** Grouping key: normalized English base title (every crawled movie has one). */
function seriesKeyOf(parsed) {
  const base = parsed.baseEn || parsed.baseFa;
  return base ? normSearch(base) : '';
}

/** Country spellings that should merge into one entry. */
const COUNTRY_CANON = [
  'آمریکا', 'انگلستان', 'هندوستان', 'فرانسه', 'آلمان', 'ایتالیا', 'اسپانیا',
  'کانادا', 'استرالیا', 'ژاپن', 'چین', 'کره جنوبی', 'کره شمالی', 'هنگ کنگ',
  'تایوان', 'ماکائو', 'روسیه', 'شوروی', 'ترکیه', 'ایران', 'عراق', 'سوریه',
  'لبنان', 'اسرائیل', 'فلسطین', 'اردن', 'عربستان سعودی', 'امارات متحده عربی',
  'قطر', 'کویت', 'بحرین', 'عمان', 'یمن', 'افغانستان', 'پاکستان', 'بنگلادش',
  'سریلانکا', 'نپال', 'تاجیکستان', 'ازبکستان', 'ترکمنستان', 'قرقیزستان',
  'قزاقستان', 'آذربایجان', 'ارمنستان', 'گرجستان', 'قبرس', 'مصر', 'لیبی',
  'تونس', 'الجزایر', 'مراکش', 'سودان', 'اتیوپی', 'کنیا', 'تانزانیا', 'اوگاندا',
  'نیجریه', 'غنا', 'کامرون', 'سنگال', 'زیمبابوه', 'آفریقای جنوبی', 'مغولستان',
  'تایلند', 'ویتنام', 'سنگاپور', 'مالزی', 'اندونزی', 'فیلیپین', 'میانمار',
  'کامبوج', 'لائوس', 'نیوزیلند', 'فیجی', 'ایرلند', 'بلژیک', 'هلند',
  'لوکزامبورگ', 'موناکو', 'سوئیس', 'اتریش', 'پرتغال', 'مالت', 'یونان', 'سوئد',
  'نروژ', 'دانمارک', 'فنلاند', 'ایسلند', 'استونی', 'لتونی', 'لیتوانی',
  'لهستان', 'جمهوری چک', 'اسلواکی', 'مجارستان', 'رومانی', 'بلغارستان',
  'صربستان', 'کرواسی', 'بوسنی و هرزگوین', 'اسلوونی', 'مقدونیه', 'آلبانی',
  'مونته‌نگرو', 'اوکراین', 'بلاروس', 'مولداوی', 'چکسلواکی', 'یوگسلاوی',
  'مکزیک', 'گواتمالا', 'هندوراس', 'السالوادور', 'نیکاراگوئه',
  'کاستاریکا', 'پاناما', 'کوبا', 'جامائیکا', 'هائیتی', 'جمهوری دومینیکن',
  'باهاما', 'باربادوس', 'جزایر کیمن', 'پورتوریکو', 'کلمبیا', 'ونزوئلا',
  'اکوادور', 'پرو', 'بولیوی', 'برزیل', 'شیلی', 'آرژانتین', 'اروگوئه', 'پاراگوئه',
];

/** Spelling variants / typos observed in the crawl → canonical display name. */
const COUNTRY_MAP = {
  'امریکا': 'آمریکا', 'ایالات متحده': 'آمریکا', 'ایالات متحده آمریکا': 'آمریکا',
  'ایالت متحده آمریکا': 'آمریکا', 'usa': 'آمریکا',
  'آمریکاسا': 'آمریکا', 'آمریکاساال': 'آمریکا', 'آمریکابا': 'آمریکا',
  'آمریا': 'آمریکا', 'آمربکا': 'آمریکا', 'آمریک': 'آمریکا',
  'هند': 'هندوستان', 'هندی': 'هندوستان',
  'انگلیس': 'انگلستان', 'بریتانیا': 'انگلستان', 'انگستان': 'انگلستان', 'uk': 'انگلستان',
  'کره': 'کره جنوبی', 'کره ی جنوبی': 'کره جنوبی',
  'المان': 'آلمان', 'استرلیا': 'استرالیا', 'نیوزلند': 'نیوزیلند',
  'اکراین': 'اوکراین', 'وییتنام': 'ویتنام', 'لیتوانیا': 'لیتوانی',
  'عربستان': 'عربستان سعودی', 'امارات': 'امارات متحده عربی',
  'چک': 'جمهوری چک', 'اتحاد جماهیر شوروی': 'شوروی', 'آلمان غربی': 'آلمان',
  'آفریفای جنوبی': 'آفریقای جنوبی', 'سری لانکا': 'سریلانکا',
};

/** Folded key → canonical display name (canonKey: ZWNJ→space, آ→ا, lower). */
const COUNTRY_KEYS = new Map();
for (const name of COUNTRY_CANON) COUNTRY_KEYS.set(canonKey(name), name);
for (const [k, v] of Object.entries(COUNTRY_MAP)) COUNTRY_KEYS.set(canonKey(k), v);

/** Labels that glue onto country values in the crawl. */
const COUNTRY_BLEED_RE = /خلاصه|کارگردان|باز[یی]گر|نویسنده|ستاره|تاریخ|اکران|مدت زمان|سال (?:تولید|ساخت|انتشار)|رده سنی|ده سنی|محصول|نمایشگر|دوبله|امتیاز|ژانر|فرمت|زیرنویس|کیفیت/u;

/**
 * Normalize a raw country value into canonical country names, in order of
 * appearance. Composites («آمریکا , هندوستان»), bleed («هندتاریخ اکران …»)
 * and typos («المان») all resolve; the first name is the primary country.
 */
function canonCountries(raw) {
  const out = [];
  const push = (name) => { if (name && !out.includes(name)) out.push(name); };
  for (let token of String(raw || '').split(/[,،;؛|/\n]+|\s*[.–—]\s*|\s*-\s*/u)) {
    token = cleanValue(token.replace(COUNTRY_BLEED_RE, ' '))
      .replace(/^(?:و|با)\s+/u, '').replace(/\s+(?:و|با)$/u, '');
    const words = canonKey(token).split(' ').filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      for (let len = Math.min(4, words.length - i); len >= 1; len--) {
        const k = words.slice(i, i + len).join(' ');
        if (COUNTRY_KEYS.has(k)) { push(COUNTRY_KEYS.get(k)); i += len - 1; break; }
      }
    }
  }
  return out;
}

/** Canonical country label for a crawled value (primary country). */
function normalizeCountry(name) {
  return canonCountries(name)[0] || cleanValue(String(name || ''));
}

module.exports = {
  GENRE_CANON,
  GENRE_MAP,
  canonGenres,
  cleanTitle,
  splitPersonName,
  PERSON_BLEED_RE,
  parseSeries,
  seriesKeyOf,
  canonKey,
  COUNTRY_CANON,
  COUNTRY_MAP,
  canonCountries,
  normalizeCountry,
};
