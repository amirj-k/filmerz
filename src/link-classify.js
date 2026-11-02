'use strict';

/**
 * links.db → normalized link facts.
 *
 * The crawl stores only a direct URL plus a short Persian label
 * («کیفیت 1080 دوبله», «کیفیت 720 زیرنویس», …). Everything the UI shows must
 * be derived from that real data — never invented. This module is the single
 * place where a crawler row is turned into:
 *
 *   media kind · resolution · dub/sub flags · codec · source tag · server
 *   file name · mirror key · stable dedupe key
 *
 * Resolution preference is URL filename → row text → quality column, because
 * some crawl pages carry a stale page-level `quality` value while the file
 * name is accurate.
 */

const crypto = require('node:crypto');

const VIDEO_EXT = new Set(['mkv', 'mp4', 'avi', 'mov', 'webm', 'm4v', 'ts', 'm2ts', 'mpg', 'mpeg', 'wmv', 'flv']);
const AUDIO_EXT = new Set(['mka', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'wav', 'opus']);
const SUB_EXT = new Set(['srt', 'ass', 'vtt', 'ssa', 'sub']);
const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif']);

const MEDIA_KIND = {
  video: 'video',
  audio: 'audio',
  subtitle: 'subtitle',
  archive: 'archive',
  image: 'image',
  page: 'page',
  other: 'other',
};

const KNOWN_RES = new Set(['4320', '2160', '1440', '1080', '900', '720', '576', '540', '480', '360', '240']);

const RES_FROM_URL_RE = /(?:^|[^0-9])((?:4320|2160|1440|1080|900|720|576|540|480|360|240))\s*p(?![a-z0-9])/i;
const RES_FROM_WORD_RE = /(?:^|[^a-z0-9])(8k|4k|uhd)(?![a-z0-9])/i;
const RES_FROM_TEXT_RE = /(?:^|[^0-9])(4320|2160|1440|1080|900|720|576|540|480|360|240)(?![0-9])/;

const CODEC_RES = [
  [/\b(x265|h\.?265|hevc)\b/i, 'x265'],
  [/\b(x264|h\.?264|avc)\b/i, 'x264'],
  [/\b(av1)\b/i, 'AV1'],
  [/\b(xvid|divx)\b/i, 'XviD'],
];

const SOURCE_RES = [
  [/\b(remux)\b/i, 'Remux'],
  [/\b(web[-_. ]?dl)\b/i, 'WEB-DL'],
  [/\b(web[-_. ]?rip)\b/i, 'WEBRip'],
  [/\b(blu[-_. ]?ray|bdrip|brrip|bd[-_. ]?rip)\b/i, 'BluRay'],
  [/\b(hdrip)\b/i, 'HDRip'],
  [/\b(dvdrip|dvd[-_. ]?rip)\b/i, 'DVDRip'],
  [/\b(hdtv)\b/i, 'HDTV'],
  [/\b(hdcam|camrip|hd[-_. ]?cam)\b/i, 'CAM'],
  [/\b(tvrip)\b/i, 'TVRip'],
];

const DUB_URL_RE = /(?:^|[^a-z0-9])(dubbed|dub|fandub|farsi[._-]?dub|persian[._-]?dub)(?:[^a-z0-9]|$)/i;
const SUB_URL_RE = /(?:^|[^a-z0-9])(hardsub|hard[._-]?sub|soft[._-]?sub|subbed|subtitled|farsi[._-]?sub|persian[._-]?sub)(?:[^a-z0-9]|$)/i;

function decodeSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Split a URL into the pieces we need, without throwing on bad input. */
function urlParts(raw) {
  const url = String(raw || '');
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    const file = decodeSafe(segs[segs.length - 1] || '');
    // Mirror hosts share everything after the random 4-char prefix directory.
    const mirrorKey = segs.slice(2).join('/').toLowerCase();
    return {
      host: u.hostname.toLowerCase(),
      path: u.pathname,
      file,
      mirrorKey: mirrorKey || decodeSafe(u.pathname).toLowerCase(),
      ext: extOf(file),
    };
  } catch {
    return { host: '', path: '', file: '', mirrorKey: '', ext: '' };
  }
}

function extOf(file) {
  const m = String(file || '').match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : '';
}

function mediaKindOf(ext) {
  if (!ext) return MEDIA_KIND.page;
  if (VIDEO_EXT.has(ext)) return MEDIA_KIND.video;
  if (AUDIO_EXT.has(ext)) return MEDIA_KIND.audio;
  if (SUB_EXT.has(ext)) return MEDIA_KIND.subtitle;
  if (ARCHIVE_EXT.has(ext)) return MEDIA_KIND.archive;
  if (IMAGE_EXT.has(ext)) return MEDIA_KIND.image;
  return MEDIA_KIND.other;
}

function normalizeRes(n) {
  const v = String(n || '').trim();
  return KNOWN_RES.has(v) ? `${v}p` : '';
}

function resolutionFromUrl(file) {
  const s = String(file || '');
  const m = s.match(RES_FROM_URL_RE);
  if (m) return normalizeRes(m[1]);
  const w = s.match(RES_FROM_WORD_RE);
  if (w) {
    const t = w[1].toLowerCase();
    if (t === '8k') return '4320p';
    return '2160p'; // 4k / uhd
  }
  return '';
}

function resolutionFromText(text) {
  const m = String(text || '').match(RES_FROM_TEXT_RE);
  return m ? normalizeRes(m[1]) : '';
}

function codecOf(file) {
  const s = String(file || '');
  for (const [re, label] of CODEC_RES) if (re.test(s)) return label;
  return '';
}

function sourceOf(file) {
  const s = String(file || '');
  for (const [re, label] of SOURCE_RES) if (re.test(s)) return label;
  return '';
}

/** Friendly server name derived from the real host (random subdomains fold). */
function serverOf(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!h) return '';
  if (/(^|\.)abrtech\.top$/.test(h)) return 'AbrTech';
  if (/(^|\.)f2m139\.shop$/.test(h)) return 'F2M139';
  if (/(^|\.)myf2m\.com$/.test(h)) return 'MyF2M';
  if (/(^|\.)subf2m\.co$/.test(h)) return 'SubF2M';
  return h;
}

/** Extract a human dub-audio label from names like `…AUDIO.SoundFilm.mka`. */
function audioLabelOf(file) {
  const s = String(file || '');
  const m = s.match(/AUDIO[._\s-]+([A-Za-z][A-Za-z0-9._-]*?)(?:\.(?:mka|mp3|aac|m4a))$/i);
  if (m) return m[1].replace(/[._-]+/g, ' ').trim();
  return '';
}

/**
 * Classify one crawler row.
 * @param {{url?:string, text?:string, quality?:string}} row
 */
function classifyLink(row) {
  const url = String((row && row.url) || '');
  const text = String((row && row.text) || '');
  const quality = String((row && row.quality) || '');
  const parts = urlParts(url);

  const mediaKind = mediaKindOf(parts.ext);

  const resolution =
    resolutionFromUrl(parts.file) ||
    resolutionFromText(text) ||
    normalizeRes(quality);

  // Dub/sub: the crawler's own label is authoritative. The URL is only a
  // fallback for rows without a label, so a single stray word can't flip it.
  let isDub = 0;
  let isSub = 0;
  if (/دوبله/.test(text)) isDub = 1;
  if (/زیرنویس/.test(text)) isSub = 1;
  if (!text) {
    const hay = `${parts.mirrorKey} ${parts.file}`;
    if (DUB_URL_RE.test(hay) || /\/dub\//i.test(parts.path)) isDub = 1;
    if (SUB_URL_RE.test(hay) || mediaKind === MEDIA_KIND.subtitle) isSub = 1;
  }
  if (mediaKind === MEDIA_KIND.subtitle && !isDub && !isSub) isSub = 1;

  const versionType = isDub ? 'dub' : isSub ? 'sub' : mediaKind === MEDIA_KIND.video ? 'original' : 'unknown';

  return {
    mediaKind,
    resolution,
    isDub,
    isSub,
    versionType,
    codec: codecOf(parts.file),
    sourceTag: sourceOf(parts.file),
    server: serverOf(parts.host),
    fileName: parts.file,
    audioLabel: mediaKind === MEDIA_KIND.audio ? audioLabelOf(parts.file) : '',
    mirrorKey: parts.mirrorKey,
    extension: parts.ext,
    host: parts.host,
  };
}

function shortHash(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex');
}

/** Stable identity per scope (movie or episode) + URL, independent of crawl ids. */
function dedupeKeyOf(scope, url) {
  return `${scope}:${shortHash(url)}`;
}

module.exports = { classifyLink, dedupeKeyOf, urlParts, serverOf, mediaKindOf, MEDIA_KIND };
