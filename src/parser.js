'use strict';

const { normSearch, convertDigits, cleanValue, slugify } = require('./normalizer');
const { canonGenres, cleanTitle, splitPersonName } = require('./canon');

/**
 * Field extraction from the crawler's free-form Persian descriptions.
 *
 * The descriptions are NOT line-based: values glue straight into the next
 * label (e.g. «ترسناک، هیجان انگیز محصول : 2021کره جنوبی کارگردانان : ...»).
 * So we slice by label positions: the value of a label is the text between
 * its colon and the start of the next recognized label. Labels are only
 * matched when followed by a colon to avoid hitting prose inside plots.
 * The plot label, when present, is treated as the last field: everything
 * after it belongs to the plot.
 */

const LABELS = [
  'نام اصلی',
  'نام فیلم',
  'ژانرها', 'ژانر', 'زانر',
  'سال تولید', 'سال ساخت', 'سال انتشار', 'تاریخ انتشار', 'سال',
  'محصول',
  'رده سنی',
  'کشور',
  'ساخت',
  'کارگردانان', 'کارگردان',
  'ستارگان', 'بازیگران',
  'نویسنده',
  'خلاصه داستان', 'خلاصه فیلم', 'خلاصه سریال', 'داستان فیلم', 'داستان',
  'موضوع',
  'عناوین',
  'وضعیت سریال',
  'تعداد قسمت‌ها', 'تعداد قسمتها',
];

// Label words that can end up glued to the END of a value, e.g.
// «...Sims-Fewerمحصول کشور : کانادا» → directors value tail «محصول».
const LABEL_TAIL_RE = /(?:محصول|کارگردانان|کارگردان|بازیگران|ستارگان|نویسنده|ژانرها|ژانر|زانر|کشور|ساخت|موضوع|عناوین|نام فیلم|نام اصلی|سال تولید|سال)+$/u;

function stripLabelTails(value) {
  let s = cleanValue(value);
  let prev = null;
  while (prev !== s) {
    prev = s;
    s = cleanValue(s.replace(LABEL_TAIL_RE, ''));
  }
  return s;
}

// «موضوع» is often a theme/genre line that appears BEFORE year/cast labels,
// so it must not terminate field scanning. It is still used as a plot
// fallback when no real plot label exists (see the alias list below).
const PLOT_LABELS = new Set(['خلاصه داستان', 'خلاصه فیلم', 'خلاصه سریال', 'داستان فیلم', 'داستان']);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findFields(description) {
  const text = String(description || '');
  const matches = [];
  for (const label of LABELS) {
    const re = new RegExp(escapeRe(label) + '\\s*[:：]', 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({ label, start: m.index, valueStart: m.index + m[0].length });
      if (re.lastIndex === m.index) re.lastIndex++; // zero-length guard
    }
  }
  matches.sort((a, b) => a.start - b.start || b.label.length - a.label.length);

  // Keep non-overlapping matches; a plot label terminates the scan.
  const accepted = [];
  for (const mt of matches) {
    const prev = accepted[accepted.length - 1];
    if (prev && mt.start <= prev.start) continue;                       // same position → longer label already kept
    if (prev && mt.start < prev.valueStart) continue;                   // inside previous label's span
    if (accepted.some((a) => PLOT_LABELS.has(a.label))) break;          // plot is the final field
    if (accepted.some((a) => a.label === mt.label)) continue;           // keep first occurrence of a label
    accepted.push(mt);
  }

  const fields = {};
  for (let i = 0; i < accepted.length; i++) {
    const cur = accepted[i];
    const end = i + 1 < accepted.length ? accepted[i + 1].start : text.length;
    fields[cur.label] = cleanValue(text.slice(cur.valueStart, end));
  }
  const alias = (names) => {
    for (const n of names) if (fields[n]) return fields[n];
    return '';
  };

  // Strip glued label remnants from value tails: «...Sims-Fewerمحصول»
  for (const k of Object.keys(fields)) fields[k] = stripLabelTails(fields[k]);

  // When no plot label exists, the actors value (last field) usually runs
  // into the plot text: «Name1, Name2, Name3یک زن در آستانه ...». Recover
  // the actor names and move the Persian tail into the plot.
  let plot = alias(['خلاصه داستان', 'خلاصه فیلم', 'خلاصه سریال', 'داستان فیلم', 'داستان', 'موضوع']);
  let actorsRaw = alias(['ستارگان', 'بازیگران']);
  if (!plot && actorsRaw && actorsRaw.length > 30) {
    const recovered = splitActorsPlot(actorsRaw);
    if (recovered.plot) {
      actorsRaw = recovered.actors.join(' , ');
      plot = recovered.plot;
    }
  }

  return {
    nameEn: alias(['نام اصلی']),
    nameFa: alias(['نام فیلم']),
    genresRaw: alias(['ژانرها', 'ژانر', 'زانر']),
    yearRaw: alias(['سال تولید', 'سال ساخت', 'سال انتشار', 'تاریخ انتشار', 'سال']),
    productRaw: alias(['محصول']),
    countryRaw: alias(['کشور', 'ساخت']),
    ageRating: alias(['رده سنی']),
    directorsRaw: alias(['کارگردانان', 'کارگردان']),
    actorsRaw,
    writersRaw: alias(['نویسنده']),
    plot,
    altTitles: alias(['عناوین']),
    statusText: alias(['وضعیت سریال']),
    episodeCountRaw: alias(['تعداد قسمت‌ها', 'تعداد قسمتها']),
  };
}

/** Heuristic: split «Name1, Name2, Name3فارسی…» into names + plot tail. */
function splitActorsPlot(raw) {
  const items = String(raw).split(/[,،;؛]+/u).map(cleanValue).filter(Boolean);
  const actors = [];
  let plotFrom = -1;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const m = item.match(/^([A-Za-z\u00C0-\u024F.'\u2019-][A-Za-z\u00C0-\u024F .'\u2019-]{1,40})([\u0600-\u06FF].*)$/u);
    if (item.length <= 40 && !/[\u0600-\u06FF]/.test(item)) {
      actors.push(item); // pure latin-ish name
    } else if (m) {
      actors.push(cleanValue(m[1])); // actor name glued to Persian plot
      plotFrom = i;
      break;
    } else {
      plotFrom = i; // Persian sentence → plot starts here
      break;
    }
  }
  const plot = plotFrom >= 0 ? cleanValue(items.slice(plotFrom).join(' ')) : '';
  return { actors, plot };
}


const SPLIT_RE = /[,،;؛\u060C\u061B/|\n\u2013\u2014]+/u; // ASCII , ؛ ، ; / | newline – —
const SPLIT_SPACED_HYPHEN = /\s+-\s+/;

function splitList(value) {
  if (!value) return [];
  const out = [];
  for (const chunk of String(value).split(SPLIT_RE)) {
    for (const piece of chunk.split(SPLIT_SPACED_HYPHEN)) {
      const v = cleanValue(piece);
      if (v && v.length >= 2 && !/^[0-9]+$/.test(v)) out.push(v);
    }
  }
  return [...new Set(out)];
}

const PART_WORDS = {
  'اول': 1, 'دوم': 2, 'سوم': 3, 'چهارم': 4, 'پنجم': 5,
  'ششم': 6, 'هفتم': 7, 'هشتم': 8, 'نهم': 9, 'دهم': 10,
};

/** Parse «کیفیت 720x265 زیرنویس قسمت 2»-style labels. */
function parseQuality(text) {
  const label = String(text || '').trim();
  const t = convertDigits(label);
  const q = { label, resolution: '', codec: '', hardsub: false, censored: false, part: 0 };
  const rm = t.match(/(480|720|1080|2160)\s*p?/i);
  if (rm) q.resolution = rm[1] + 'p';
  const cm = t.match(/x\s*(264|265)/i);
  if (cm) q.codec = 'x' + cm[1].toLowerCase();
  if (/هارد\s*ساب|hardsub/i.test(t)) q.hardsub = true;
  if (/سانسور|سانسر/i.test(t)) q.censored = true;
  const pm = t.match(/قسمت\s*(\d{1,3}|اول|دوم|سوم|چهارم|پنجم|ششم|هفتم|هشتم|نهم|دهم)/);
  if (pm) {
    const w = pm[1];
    q.part = /^\d+$/.test(w) ? parseInt(w, 10) : (PART_WORDS[w] || 0);
  }
  return q;
}

const MAX_FUTURE_YEAR = new Date().getFullYear() + 1;

/** Reject crawl typos like «2079»/«2062» while keeping Persian calendar years. */
function plausibleYear(y) {
  if (!Number.isFinite(y)) return false;
  if (y >= 1300 && y <= 1499) return true; // Persian calendar (e.g. 1399)
  return y >= 1880 && y <= MAX_FUTURE_YEAR;
}

function yearFrom(text) {
  const t = convertDigits(String(text || ''));
  // Filenames glue years to letters/underscores («Acceleration_2019_»), so
  // digit lookarounds work better than \b here.
  const re = /(?<!\d)(1[234]\d{2}|18\d{2}|19\d{2}|20\d{2})(?!\d)/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const y = parseInt(m[1], 10);
    if (plausibleYear(y)) return y;
  }
  return null;
}

function extractYear(fields, url) {
  const fromYearRaw = yearFrom(fields.yearRaw);
  const fromProduct = yearFrom(fields.productRaw);
  const descYear = fromYearRaw || fromProduct;

  let fromFile = null;
  try {
    // Only trust a year in the file name. Directory years like
    // /movies/2023/06/ are crawl paths, not release years, and used to give
    // classics the wrong year. The LAST year is the release year in names
    // like «2001.A.Space.Odyssey.1968».
    const u = new URL(String(url || ''));
    const file = decodeURIComponent(u.pathname.split('/').pop() || '');
    const re = /(?<!\d)(1[234]\d{2}|18\d{2}|19\d{2}|20\d{2})(?!\d)/g;
    let m;
    while ((m = re.exec(file)) !== null) {
      const y = parseInt(m[1], 10);
      if (plausibleYear(y)) fromFile = y;
    }
  } catch { /* malformed url — ignore */ }

  if (descYear && fromFile) {
    // A Persian year (13xx/14xx) that is nowhere near its Gregorian
    // equivalent is a crawl typo («1379» for «1979»); trust the file name.
    if (descYear >= 1300 && descYear <= 1499 && Math.abs(fromFile - (descYear + 621)) > 3) {
      return fromFile;
    }
    return descYear;
  }
  return descYear || fromFile || null;
}

function extractCountry(fields) {
  for (const raw of [fields.productRaw, fields.countryRaw]) {
    if (!raw) continue;
    let s = convertDigits(String(raw)).replace(/(1[234]|19|20)\d{2}/g, ' ');
    s = cleanValue(s);
    if (/[\u0600-\u06FF]/.test(s)) return s;
  }
  return '';
}

/** Split «سربازان حرفهای_Mercenaries» → {fa, enTail} */
function splitFaEnTail(s) {
  const t = cleanValue(s);
  const m = t.match(/^(.*?)\s*[_\u2013\u2014-]\s*([A-Za-z0-9 .:'\u2019-]{2,})$/u);
  if (m && m[1]) return { fa: cleanValue(m[1]), enTail: cleanValue(m[2]) };
  return { fa: t, enTail: '' };
}

function splitTitles(title, fields) {
  const t = String(title || '');
  let titleEn = cleanValue(fields.nameEn);
  let titleFa = '';
  const fm = t.match(/^(.*?)\s*نام\s*فیلم\s*[:：]\s*(.*)$/u);
  if (fm) {
    if (!titleEn) titleEn = cleanValue(fm[1]);
    const tail = splitFaEnTail(fm[2]);
    titleFa = tail.fa;
    if (!titleEn && tail.enTail) titleEn = tail.enTail;
  } else if (!titleEn) {
    titleEn = cleanValue(t);
  }
  return { titleEn, titleFa };
}

/**
 * Parse one crawler row into normalized pieces.
 */
function parseRow(row) {
  const fields = findFields(row.description);
  const { titleEn, titleFa } = splitTitles(row.title, fields);
  const fm2 = fields.nameFa ? splitFaEnTail(fields.nameFa) : null;
  const list = (names) => (names || []).map(splitPersonName).filter(Boolean);
  return {
    titleEn: cleanTitle(titleEn) || cleanValue(titleEn),
    titleFa: cleanTitle(titleFa || (fm2 ? fm2.fa : '')),
    year: extractYear(fields, row.url),
    country: extractCountry(fields),
    genres: canonGenres(fields.genresRaw),
    directors: list(splitList(fields.directorsRaw)),
    actors: list(splitList(fields.actorsRaw)),
    writers: list(splitList(fields.writersRaw)),
    plot: fields.plot || '',
    ageRating: fields.ageRating || '',
    altTitles: fields.altTitles || '',
    statusText: fields.statusText || '',
    episodeCountRaw: fields.episodeCountRaw || '',
    quality: parseQuality(row.text),
  };
}

module.exports = {
  findFields,
  splitList,
  parseQuality,
  parseRow,
  extractYear,
  extractCountry,
  splitTitles,
  slugify,
  normSearch,
  plausibleYear,
  MAX_FUTURE_YEAR,
};
