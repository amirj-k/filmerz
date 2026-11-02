'use strict';
const crypto = require('crypto');

/** ISO-8601 timestamps are lexicographically comparable in SQLite. */
function nowIso() {
  return new Date().toISOString();
}

function isoAfter(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison that never throws on length mismatch. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Run `fn` inside a write transaction. node:sqlite's DatabaseSync has no
 * transaction helper, so BEGIN IMMEDIATE / COMMIT / ROLLBACK is explicit.
 */
function withTransaction(db, fn) {
  let began = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    began = true;
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (began) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    }
    throw err;
  }
}

function isExpired(isoString) {
  if (!isoString) return true;
  const t = Date.parse(isoString);
  return !Number.isFinite(t) || t <= Date.now();
}

module.exports = {
  nowIso,
  isoAfter,
  sha256,
  randomToken,
  safeEqual,
  withTransaction,
  isExpired,
};
