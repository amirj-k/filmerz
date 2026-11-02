'use strict';
const crypto = require('crypto');
const config = require('../config');

/**
 * Password hashing with Node's built-in scrypt (no native build step, works
 * in the project's Alpine Docker image). The stored format is versioned so
 * parameters can be raised later without breaking existing hashes:
 *
 *   scrypt$1$N$r$p$salt_base64url$hash_base64url
 *
 * Every password gets an independent 16-byte random salt.
 */

const VERSION = '1';
const SALT_BYTES = 16;
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;

function scryptAsync(password, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

function currentParams() {
  return {
    N: config.auth.scrypt.N,
    r: config.auth.scrypt.r,
    p: config.auth.scrypt.p,
    keylen: config.auth.scrypt.keylen,
    maxmem: config.auth.scrypt.maxmem,
  };
}

function parseHash(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== VERSION) return null;
  const N = parseInt(parts[2], 10);
  const r = parseInt(parts[3], 10);
  const p = parseInt(parts[4], 10);
  if (!Number.isInteger(N) || N < 2 || N > MAX_N || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > MAX_R) return null;
  if (!Number.isInteger(p) || p < 1 || p > MAX_P) return null;
  let salt;
  let hash;
  try {
    salt = Buffer.from(parts[5], 'base64url');
    hash = Buffer.from(parts[6], 'base64url');
  } catch {
    return null;
  }
  if (!salt.length || !hash.length) return null;
  return { N, r, p, salt, hash };
}

async function hashPassword(password) {
  const params = currentParams();
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scryptAsync(String(password), salt, params.keylen, {
    N: params.N, r: params.r, p: params.p, maxmem: params.maxmem,
  });
  return [
    'scrypt', VERSION, params.N, params.r, params.p,
    salt.toString('base64url'), derived.toString('base64url'),
  ].join('$');
}

/**
 * Verify and report whether the stored hash should be upgraded to the
 * current parameters. Never throws for malformed input.
 */
async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed) return { ok: false, needsRehash: false };
  let derived;
  try {
    derived = await scryptAsync(String(password), parsed.salt, parsed.hash.length, {
      N: parsed.N, r: parsed.r, p: parsed.p, maxmem: config.auth.scrypt.maxmem,
    });
  } catch {
    return { ok: false, needsRehash: false };
  }
  const ok = derived.length === parsed.hash.length
    && crypto.timingSafeEqual(derived, parsed.hash);
  const params = currentParams();
  const needsRehash = ok && (parsed.N < params.N || parsed.r < params.r || parsed.p < params.p);
  return { ok, needsRehash };
}

/**
 * Constant-cost verification for a missing account so responses do not
 * reveal whether an email exists via timing.
 */
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword('dummy-password-for-timing-only');
  }
  return dummyHashPromise;
}
async function verifyAgainstDummy(password) {
  try {
    const stored = await dummyHash();
    await verifyPassword(password, stored);
  } catch { /* ignore */ }
}

module.exports = {
  hashPassword,
  verifyPassword,
  verifyAgainstDummy,
  parseHash,
};
