'use strict';

/** File extension from a download URL (lower-case), or ''. */
function extFromUrl(u) {
  try {
    const m = new URL(u).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

/** Hostname of a URL, or ''. */
function hostOf(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}

module.exports = { extFromUrl, hostOf };
