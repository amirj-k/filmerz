'use strict';
const config = require('../config');
const { nowIso, isoAfter, sha256, randomToken, withTransaction, isExpired } = require('./util');

/**
 * One-time, hashed-at-rest tokens for email verification and password reset.
 * The raw token only ever exists in the email link; the database stores its
 * SHA-256 digest.
 */

function issueEmailVerification(db, userId) {
  const token = randomToken(32);
  withTransaction(db, () => {
    // Invalidate previous unused tokens: only the newest link may work.
    db.prepare(
      'UPDATE email_verification_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL'
    ).run(nowIso(), userId);
    db.prepare(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at, used_at, created_at)
       VALUES (?, ?, ?, NULL, ?)`
    ).run(userId, sha256(token), isoAfter(config.auth.emailVerificationTtlMs), nowIso());
  });
  return token;
}

function findValidEmailToken(db, token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT t.id, t.user_id, t.expires_at, t.used_at, u.status
       FROM email_verification_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?`
  ).get(sha256(token));
  if (!row || row.used_at || isExpired(row.expires_at)) return null;
  if (row.status === 'disabled') return null;
  return row;
}

function consumeEmailVerification(db, token) {
  const row = findValidEmailToken(db, token);
  if (!row) return null;
  return withTransaction(db, () => {
    const claimed = db.prepare(
      'UPDATE email_verification_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL'
    ).run(nowIso(), row.id);
    if (!claimed.changes) return null; // lost a race with another request
    db.prepare(
      `UPDATE users
          SET email_verified_at = COALESCE(email_verified_at, ?),
              status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
              updated_at = ?
        WHERE id = ?`
    ).run(nowIso(), nowIso(), row.user_id);
    return db.prepare('SELECT id, email, display_name, status FROM users WHERE id = ?').get(row.user_id);
  });
}

function issuePasswordReset(db, userId) {
  const token = randomToken(32);
  withTransaction(db, () => {
    db.prepare(
      'UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL'
    ).run(nowIso(), userId);
    db.prepare(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used_at, created_at)
       VALUES (?, ?, ?, NULL, ?)`
    ).run(userId, sha256(token), isoAfter(config.auth.passwordResetTtlMs), nowIso());
  });
  return token;
}

function findValidResetToken(db, token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT t.id, t.user_id, t.expires_at, t.used_at, u.status
       FROM password_reset_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?`
  ).get(sha256(token));
  if (!row || row.used_at || isExpired(row.expires_at)) return null;
  if (row.status !== 'active') return null;
  return row;
}

/**
 * Atomically consume the reset token, set the new hash and revoke every
 * existing session. Returns the user id, or null when the token is invalid.
 */
function consumePasswordReset(db, token, passwordHash) {
  const row = findValidResetToken(db, token);
  if (!row) return null;
  return withTransaction(db, () => {
    const claimed = db.prepare(
      'UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL'
    ).run(nowIso(), row.id);
    if (!claimed.changes) return null;
    db.prepare(
      'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?'
    ).run(passwordHash, nowIso(), row.user_id);
    db.prepare(
      'UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL'
    ).run(nowIso(), row.user_id);
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(row.user_id);
    return row.user_id;
  });
}

/** Housekeeping: drop tokens that are expired or long consumed. */
function sweepExpiredTokens(db) {
  const now = nowIso();
  db.prepare('DELETE FROM email_verification_tokens WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM password_reset_tokens WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(now);
}

module.exports = {
  issueEmailVerification,
  findValidEmailToken,
  consumeEmailVerification,
  issuePasswordReset,
  findValidResetToken,
  consumePasswordReset,
  sweepExpiredTokens,
};
