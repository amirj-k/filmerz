'use strict';

/**
 * Normalization helpers.
 * normSearch() is used ONLY to build/compare search keys (FTS/LIKE columns) —
 * never for display. It folds Arabic/Persian letter variants, digits,
 * diacritics, ZWNJ and punctuation so that «ي/ی»، «ك/ک»، «آ/ا» and
 * Persian/Latin numerals all match each other.
 */

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function convertDigits(s) {
  let out = '';
  for (const ch of String(s)) {
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p >= 0) { out += String(p); continue; }
    const a = ARABIC_DIGITS.indexOf(ch);
    if (a >= 0) { out += String(a); continue; }
    out += ch;
  }
  return out;
}

function normSearch(s) {
  if (s === null || s === undefined) return '';
  let t = String(s).normalize('NFKC'); // fold presentation forms ﻓ→ف, ﻢ→م, ligatures
  t = t.replace(/\u064A/g, '\u06CC'); // ي → ی
  t = t.replace(/\u0643/g, '\u06A9'); // ك → ک
  t = t.replace(/[\u0622\u0623\u0625]/g, '\u0627'); // آ أ إ → ا
  t = t.replace(/\u0629/g, '\u0647'); // ة → ه
  t = t.replace(/[\u064B-\u0652\u0670\u0640]/g, ''); // diacritics + tatweel
  t = t.replace(/\u200C/g, ''); // ZWNJ deleted (حرفه‌ای ≡ حرفهای)
  t = t.replace(/[\u200B\u200E\u200F\u202A-\u202E]/g, ' '); // other invisibles → space
  t = convertDigits(t);
  t = t.toLowerCase();
  t = t.replace(/[«»"'“”‘’()[\]{}.,،؛;:!؟?\\/\-–—_…#*&@+=|~^%$]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/** Display-grade trim: strips junk at the edges of extracted field values. */
function cleanValue(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/^[\s\u200c:：،,\-–—.·]+/u, '')
    .replace(/[\s\u200c:：،,\-–—.·]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** URL-safe slug that keeps Persian letters (they get percent-encoded). */
function slugify(s) {
  const n = convertDigits(String(s || '')).toLowerCase().trim();
  return n
    .replace(/[^\w\u0600-\u06FF]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'x';
}

module.exports = { normSearch, convertDigits, cleanValue, slugify };
