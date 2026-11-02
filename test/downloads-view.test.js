'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ejs = require('ejs');
const { buildDownloads } = require('../src/link-view');

const ROWS = [
  {
    id: 1,
    media_kind: 'video',
    resolution: '1080p',
    is_dub: 1,
    is_sub: 0,
    server: 'AbrTech',
    file_name: 'Example.2024.1080p.Farsi.Dubbed.mkv',
    extension: 'mkv',
    quality_text: 'کیفیت 1080 دوبله',
  },
  {
    id: 2,
    media_kind: 'video',
    resolution: '720p',
    is_dub: 0,
    is_sub: 1,
    server: 'AbrTech',
    file_name: 'Example.2024.720p.Farsi.Sub.mkv',
    extension: 'mkv',
    quality_text: 'کیفیت 720 زیرنویس',
  },
];

test('downloads partial renders icons as markup, never as escaped text', async () => {
  const downloads = buildDownloads(ROWS);
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'partials', 'downloads.ejs'),
    { downloads, resolveType: 'movie', resolveId: 1 }
  );

  // The chevron/play/download icons are trusted static SVG strings; using the
  // escaping tag (<%=) turns them into literal "<svg ...>" text on the page.
  assert.ok(html.includes('<svg class="dl-chev"'), 'chevron must be real SVG markup');
  assert.ok(html.includes('<svg class="ico"'), 'play/download icons must be real SVG markup');
  assert.ok(!html.includes('&lt;svg'), 'no icon may be HTML-escaped into visible text');
  assert.ok(html.includes('Full HD'), 'quality badge still rendered');
  assert.ok(html.includes('data-downloads'), 'download block rendered');
});
