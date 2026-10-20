'use strict';

const { normSearch, convertDigits, cleanValue, slugify } = require('./normalizer');

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
  'خلاصه داستان', 'داستان فیلم', 'داستان',
  'موضوع',
  'عناوین',
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

const PLOT_LABELS = new Set(['خلاصه داستان', 'داستان فیلم', 'داستان', 'موضوع']);

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
  let plot = alias(['خلاصه داستان', 'داستان فیلم', 'داستان', 'موضوع']);
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

function yearFrom(text) {
  const m = convertDigits(String(text || '')).match(/\b(19\d{2}|20\d{2})\b/);
  return m ? parseInt(m[1], 10) : null;
}

function extractYear(fields, url) {
  const fromYearRaw = yearFrom(fields.yearRaw);
  if (fromYearRaw) return fromYearRaw;
  const fromProduct = yearFrom(fields.productRaw);
  if (fromProduct) return fromProduct;
  try {
    const y = yearFrom(decodeURIComponent(String(url || '')));
    if (y) return y;
  } catch { /* malformed url — ignore */ }
  return null;
}

function extractCountry(fields) {
  for (const raw of [fields.productRaw, fields.countryRaw]) {
    if (!raw) continue;
    let s = convertDigits(String(raw)).replace(/(19|20)\d{2}/g, ' ');
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
  return {
    titleEn,
    titleFa: titleFa || (fm2 ? fm2.fa : ''),
    year: extractYear(fields, row.url),
    country: extractCountry(fields),
    genres: splitList(fields.genresRaw),
    directors: splitList(fields.directorsRaw),
    actors: splitList(fields.actorsRaw),
    writers: splitList(fields.writersRaw),
    plot: fields.plot || '',
    ageRating: fields.ageRating || '',
    altTitles: fields.altTitles || '',
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
};
