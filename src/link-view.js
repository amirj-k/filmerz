'use strict';

/**
 * Turn normalized link rows into the download UI model.
 *
 * Two independent axes, exactly as the crawl data allows:
 *   1) version  → dubbed / original+sub / original / other
 *   2) quality  → 4K · 1080p · 720p · SD · unknown (+ audio / subtitle / archive)
 *
 * Nothing is invented: a field that is missing in the DB is simply omitted
 * from the model, and the markup hides it.
 */

const TABS = [
  { key: 'dub', label: 'دوبله فارسی', hint: 'صداگذاری فارسی' },
  { key: 'sub', label: 'زبان اصلی + زیرنویس', hint: 'صدا اصلی، همراه زیرنویس' },
  { key: 'original', label: 'زبان اصلی', hint: 'بدون زیرنویس' },
  { key: 'other', label: 'سایر نسخه‌ها', hint: 'اطلاعات کافی برای دسته‌بندی نیست' },
];

function num(v) { return Number(v) || 0; }

function normalize(raw) {
  const mediaKind = raw.media_kind || raw.mediaKind || 'video';
  return {
    id: num(raw.id),
    mediaKind,
    resolution: String(raw.resolution || raw.quality_res || '').trim(),
    isDub: Boolean(num(raw.is_dub ?? raw.isDub)),
    isSub: Boolean(num(raw.is_sub ?? raw.isSub)),
    codec: String(raw.codec || '').trim(),
    sourceTag: String(raw.source_tag || raw.sourceTag || '').trim(),
    server: String(raw.server || '').trim(),
    fileName: String(raw.file_name || raw.fileName || '').trim(),
    audioLabel: String(raw.audio_label || raw.audioLabel || '').trim(),
    mirrorKey: String(raw.mirror_key || raw.mirrorKey || '').trim(),
    extension: String(raw.extension || '').trim().toLowerCase(),
    qualityText: String(raw.quality_text || raw.qualityText || '').trim(),
    part: num(raw.part),
    isVideo: mediaKind === 'video',
  };
}

function tabOf(l) {
  if (l.isDub) return 'dub';
  if (l.isSub) return 'sub';
  if (l.mediaKind === 'video') return 'original';
  return 'other';
}

/** Group key + display metadata for one link's quality bucket. */
function qualityOf(l) {
  if (l.mediaKind === 'audio') {
    return { key: 'audio', badge: 'صدا', label: 'صدای دوبله', order: 6, tone: 'audio' };
  }
  if (l.mediaKind === 'subtitle') {
    return { key: 'subtitle', badge: 'زیرنویس', label: 'فایل زیرنویس', order: 5, tone: 'sub' };
  }
  if (l.mediaKind === 'archive') {
    return { key: 'archive', badge: 'آرشیو', label: 'فایل فشرده', order: 4, tone: 'other' };
  }
  if (l.mediaKind !== 'video') {
    return { key: 'other', badge: 'سایر', label: 'سایر فایل‌ها', order: 3, tone: 'other' };
  }

  const n = parseInt(String(l.resolution).replace(/[^\d]/g, ''), 10);
  if (!n) return { key: 'unknown', badge: '؟', label: 'کیفیت نامشخص', order: 2, tone: 'unknown' };

  let badge = `${n}p`;
  let tone = 'sd';
  if (n >= 4320) { badge = '8K'; tone = 'uhd'; }
  else if (n >= 2160) { badge = '4K'; tone = 'uhd'; }
  else if (n >= 1440) { badge = '2K'; tone = 'fhd'; }
  else if (n >= 1080) { badge = 'Full HD'; tone = 'fhd'; }
  else if (n >= 720) { badge = 'HD'; tone = 'hd'; }
  else { badge = 'SD'; tone = 'sd'; }
  return { key: `${n}p`, badge, label: `${n}p`, order: 1000 + n, tone };
}

function extLabel(ext) {
  return ext ? ext.toUpperCase() : '';
}

function cardOf(group, l) {
  const badges = [];
  if (l.sourceTag) badges.push({ cls: 'src', text: l.sourceTag });
  if (l.codec) badges.push({ cls: 'codec', text: l.codec });
  if (l.extension) badges.push({ cls: 'ext', text: extLabel(l.extension) });
  if (l.audioLabel) badges.push({ cls: 'audio', text: l.audioLabel });

  const meta = [];
  if (l.server) meta.push({ label: 'سرور', value: l.server });
  if (l.audioLabel) meta.push({ label: 'صدا', value: l.audioLabel });
  if (l.part > 0) meta.push({ label: 'بخش', value: String(l.part) });
  if (l.qualityText && !l.resolution) meta.push({ label: 'برچسب', value: l.qualityText });

  return {
    key: l.mirrorKey || `link-${l.id}`,
    isVideo: l.isVideo,
    badges,
    meta,
    server: l.server,
    fileName: l.fileName,
    links: [{
      id: l.id,
      server: l.server,
      fileName: l.fileName,
      audioLabel: l.audioLabel,
    }],
  };
}

/**
 * @param {Array<object>} rows normalized DB/JSON link rows
 * @returns {{tabs:Array, total:number, hasMultipleTabs:boolean, empty:boolean}}
 */
function buildDownloads(rows) {
  const byTab = new Map();
  for (const raw of rows || []) {
    const l = normalize(raw);
    if (!l.id) continue;
    // Keep non-media rows in the DB (they are crawl data), but never present
    // an image/page/unknown blob as a download card.
    if (l.mediaKind === 'image' || l.mediaKind === 'page' || l.mediaKind === 'other') continue;

    const tabKey = tabOf(l);
    if (!byTab.has(tabKey)) byTab.set(tabKey, new Map());
    const qualities = byTab.get(tabKey);
    const q = qualityOf(l);
    if (!qualities.has(q.key)) qualities.set(q.key, { ...q, cards: new Map() });
    const group = qualities.get(q.key);

    const card = cardOf(group, l);
    if (group.cards.has(card.key)) {
      const existing = group.cards.get(card.key);
      existing.links.push(...card.links);
    } else {
      group.cards.set(card.key, card);
    }
  }

  const tabs = [];
  for (const tab of TABS) {
    const qualities = byTab.get(tab.key);
    if (!qualities) continue;

    const groups = [...qualities.values()].map((group) => {
      const cards = [...group.cards.values()].map((card) => {
        const links = sortMirrors(card.links);
        return { ...card, links, primary: links[0] };
      });
      cards.sort((a, b) => a.key.localeCompare(b.key));
      return {
        key: group.key,
        badge: group.badge,
        label: group.label,
        tone: group.tone,
        order: group.order,
        count: cards.reduce((n, c) => n + c.links.length, 0),
        cards,
      };
    }).sort((a, b) => b.order - a.order);

    const count = groups.reduce((n, g) => n + g.count, 0);
    if (!count) continue;
    tabs.push({ ...tab, count, qualities: groups });
  }

  return {
    tabs,
    total: tabs.reduce((n, t) => n + t.count, 0),
    hasMultipleTabs: tabs.length > 1,
    empty: tabs.length === 0,
  };
}

function sortMirrors(links) {
  return links.slice().sort((a, b) => String(a.server || '').localeCompare(String(b.server || '')));
}

module.exports = { buildDownloads, TABS, tabOf, qualityOf };
