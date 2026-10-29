'use strict';
const config = require('./config');

/**
 * Resolver: turns a stable `play_url` (https://flzios.com/play?...) into a
 * fresh direct download link.
 *
 * - Keeps a logged-in cookie session with the source site (credentials only
 *   ever come from env vars — never logged, never returned).
 * - Opens the play_url WITHOUT following redirects and WITHOUT downloading
 *   the body, then reads the `Location` header.
 * - Caches results for a few minutes.
 * - SSRF-safe: callers must pass a play_url that exists in our DB, and the
 *   redirect target host must match the configured allowlist.
 */

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

class ResolveError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function guardPlayUrl(playUrl, baseUrl) {
  let u;
  try { u = new URL(playUrl); } catch { throw new ResolveError('BAD_URL', 'play_url نامعتبر است.'); }
  const base = new URL(baseUrl);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ResolveError('BAD_URL', 'پروتکل play_url نامعتبر است.');
  if (u.hostname !== base.hostname) throw new ResolveError('SSRF', 'play_url به دامنه مجاز تعلق ندارد.');
}

function guardDirectLink(url, dlHostsRe) {
  let u;
  try { u = new URL(url); } catch { throw new ResolveError('BAD_LOCATION', 'Location نامعتبر است.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ResolveError('BAD_LOCATION', 'پروتکل لینک مستقیم نامعتبر است.');
  if (!dlHostsRe.test(u.hostname)) throw new ResolveError('BAD_HOST', 'هاست لینک مستقیم در لیست مجاز نیست.');
}

class SourceClient {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || config.source.baseUrl).replace(/\/+$/, '');
    this.loginPath = opts.loginPath || config.source.loginPath;
    this.phone = opts.phone ?? config.source.phone;
    this.password = opts.password ?? config.source.password;
    this.phoneField = opts.phoneField || config.source.phoneField;
    this.passwordField = opts.passwordField || config.source.passwordField;
    this.ttlMs = opts.ttlMs ?? config.source.ttlMs;
    this.timeoutMs = opts.timeoutMs ?? config.source.timeoutMs;
    this.dlHostsRe = new RegExp(opts.allowedDlHosts || config.allowedDlHosts, 'i');
    this.cookieJar = new Map(); // name -> value
    this.loggedInAt = 0;
    this.cache = new Map(); // playUrl -> { url, expiresAt }
  }

  #cookieHeader() {
    return [...this.cookieJar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  #absorbCookies(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookieJar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  async #fetch(url, init = {}) {
    const headers = { 'User-Agent': USER_AGENT, ...(init.headers || {}) };
    if (this.cookieJar.size) headers.Cookie = this.#cookieHeader();
    return fetch(url, {
      ...init,
      headers,
      redirect: 'manual', // never follow — we read Location ourselves
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  hasCredentials() {
    return Boolean(this.phone && this.password);
  }

  async login(force = false) {
    if (!this.hasCredentials()) throw new ResolveError('NO_CREDENTIALS', 'SOURCE_PHONE/SOURCE_PASSWORD تنظیم نشده‌اند.');
    if (!force && this.cookieJar.size && Date.now() - this.loggedInAt < 10 * 60 * 1000) return;

    const body = new URLSearchParams({
      [this.phoneField]: this.phone,
      [this.passwordField]: this.password,
    });
    const res = await this.#fetch(this.baseUrl + this.loginPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    // We never log credentials or full responses — only the status class.
    try { await res.body?.cancel(); } catch { /* noop */ }
    this.#absorbCookies(res);
    this.loggedInAt = Date.now();
    if (res.status >= 400) throw new ResolveError('LOGIN_FAILED', 'ورود به سایت منبع ناموفق بود.');
    if (!this.cookieJar.size) throw new ResolveError('LOGIN_FAILED', 'کوکی‌ای از سایت منبع دریافت نشد.');
  }

  /** Resolve one play_url to a fresh direct link (cached for ttlMs). */
  async resolve(playUrl) {
    guardPlayUrl(playUrl, this.baseUrl);
    const hit = this.cache.get(playUrl);
    if (hit && hit.expiresAt > Date.now()) return hit.url;

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.#fetch(playUrl);
      try { await res.body?.cancel(); } catch { /* noop */ }
      this.#absorbCookies(res);

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new ResolveError('NO_LOCATION', 'پاسخ بدون Location بود.');
        const fresh = new URL(location, playUrl).toString();
        guardDirectLink(fresh, this.dlHostsRe);
        this.cache.set(playUrl, { url: fresh, expiresAt: Date.now() + this.ttlMs });
        return fresh;
      }

      // Not a redirect → probably logged out. Re-login once and retry.
      if (attempt === 0) {
        await this.login(true);
        continue;
      }
      throw new ResolveError('NOT_REDIRECT', `پاسخ غیرمنتظره (HTTP ${res.status}) — احتمالاً لینک پایدار معتبر نیست.`);
    }
    throw new ResolveError('NOT_REDIRECT', 'رزولو لینک ناموفق بود.');
  }
}


/** Convenience: check expire=unix-seconds on a stored direct url. */
function linkExpiry(url) {
  try {
    const m = new URL(url).searchParams.get('expire');
    if (!m) return null;
    const sec = parseInt(m, 10);
    return Number.isFinite(sec) ? sec : null;
  } catch { return null; }
}

function isProbablyFresh(url, slackSec = 60) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const exp = linkExpiry(url);
  // No `expire` param means the crawler stored a permanent direct link
  // (e.g. *.abrtech.top → mehracdn.com), not a signed/expiring one.
  if (exp === null) return true;
  return exp > Math.floor(Date.now() / 1000) + slackSec;
}

module.exports = { SourceClient, ResolveError, linkExpiry, isProbablyFresh };
