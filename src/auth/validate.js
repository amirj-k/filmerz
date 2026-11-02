'use strict';
const config = require('../config');

/**
 * Input validation shared by forms and JSON endpoints. Everything the user
 * sends is untrusted; these helpers normalise values and return field-level
 * Persian error messages.
 */

// Pragmatic RFC-5322 subset. The real authority is the verification email.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return { ok: false, error: 'ایمیل را وارد کنید.' };
  if (email.length > 254) return { ok: false, error: 'ایمیل بیش از حد طولانی است.' };
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'ساختار ایمیل معتبر نیست.' };
  return { ok: true, email };
}

function validatePassword(value) {
  const password = String(value || '');
  if (!password) return { ok: false, error: 'رمز عبور را وارد کنید.' };
  if (password.length < config.auth.minPasswordLength) {
    return { ok: false, error: `رمز عبور باید دست‌کم ${config.auth.minPasswordLength} کاراکتر باشد.` };
  }
  if (password.length > config.auth.maxPasswordLength) {
    return { ok: false, error: `رمز عبور نباید بیش از ${config.auth.maxPasswordLength} کاراکتر باشد.` };
  }
  if (password.includes('\u0000')) return { ok: false, error: 'رمز عبور کاراکتر نامعتبر دارد.' };
  return { ok: true, password };
}

function validateDisplayName(value) {
  // Strip control characters and collapse whitespace; keep Persian text.
  const name = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return { ok: false, error: 'نام نمایشی را وارد کنید.' };
  if (name.length < 2) return { ok: false, error: 'نام نمایشی باید دست‌کم ۲ کاراکتر باشد.' };
  if (name.length > 60) return { ok: false, error: 'نام نمایشی نباید بیش از ۶۰ کاراکتر باشد.' };
  return { ok: true, name };
}

/**
 * Only allow same-site absolute paths. Rejects "//evil.com", backslash
 * tricks and absolute URLs — the classic open-redirect vectors.
 */
function safeRedirect(value, fallback = '/account') {
  const raw = String(value || '');
  if (!raw || raw.length > 2000) return fallback;
  if (raw[0] !== '/') return fallback;
  if (raw[1] === '/' || raw[1] === '\\') return fallback;
  if (raw.includes('\\') || raw.includes('\r') || raw.includes('\n')) return fallback;
  if (/^\/\s*[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return fallback;
  return raw;
}

function asInt(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

module.exports = {
  normalizeEmail,
  validateEmail,
  validatePassword,
  validateDisplayName,
  safeRedirect,
  asInt,
};
