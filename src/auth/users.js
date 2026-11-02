'use strict';
const { nowIso } = require('./util');

/**
 * Account + external-identity persistence. All statements are prepared;
 * user-controlled values never reach SQL as strings.
 */

function normalizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    emailOriginal: row.email_original,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    status: row.status,
    emailVerified: Boolean(row.email_verified_at),
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    hasPassword: Boolean(row.password_hash),
  };
}

const SELECT_USER = `SELECT id, email, email_original, password_hash, display_name, avatar_url,
       role, status, email_verified_at, created_at, updated_at, last_login_at
  FROM users`;

function findByEmail(db, email) {
  return db.prepare(`${SELECT_USER} WHERE email = ?`).get(email);
}

function findById(db, id) {
  return db.prepare(`${SELECT_USER} WHERE id = ?`).get(id);
}

function createUser(db, {
  email,
  emailOriginal = '',
  displayName,
  passwordHash = '',
  status = 'pending',
  emailVerified = false,
  role = 'user',
  avatarUrl = '',
}) {
  const now = nowIso();
  const info = db.prepare(
    `INSERT INTO users
       (email, email_original, password_hash, display_name, avatar_url, role, status,
        email_verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    email, emailOriginal || email, passwordHash, displayName, avatarUrl,
    // Public registration can never choose a privileged role.
    role === 'admin' ? 'user' : 'user',
    status,
    emailVerified ? now : null,
    now, now
  );
  return Number(info.lastInsertRowid);
}

function updateDisplayName(db, userId, displayName) {
  db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
    .run(displayName, nowIso(), userId);
}

function updateAvatar(db, userId, avatarUrl) {
  db.prepare('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?')
    .run(avatarUrl || '', nowIso(), userId);
}

function updatePassword(db, userId, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(passwordHash, nowIso(), userId);
}

function markEmailVerified(db, userId) {
  const now = nowIso();
  db.prepare(
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?`
  ).run(now, now, userId);
}

function markLogin(db, userId) {
  db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?')
    .run(nowIso(), nowIso(), userId);
}

function setStatus(db, userId, status) {
  db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, nowIso(), userId);
}

function deleteUser(db, userId) {
  // Cascades remove sessions, tokens, lists, history and identities.
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

function userCounts(db, userId) {
  const one = (sql) => Number(db.prepare(sql).get(userId).c || 0);
  return {
    favorites: one('SELECT COUNT(*) AS c FROM user_favorites WHERE user_id = ?'),
    watchlist: one('SELECT COUNT(*) AS c FROM user_watchlist WHERE user_id = ?'),
    history: one('SELECT COUNT(*) AS c FROM user_watch_history WHERE user_id = ?'),
  };
}

/* ----------------------------- identities ----------------------------- */

function findIdentity(db, provider, subject) {
  return db.prepare(
    `SELECT id, user_id, provider, provider_subject, email, created_at
       FROM user_identities WHERE provider = ? AND provider_subject = ?`
  ).get(provider, subject) || null;
}

function listIdentities(db, userId) {
  return db.prepare(
    `SELECT id, provider, provider_subject, email, created_at
       FROM user_identities WHERE user_id = ? ORDER BY id`
  ).all(userId);
}

function addIdentity(db, { userId, provider, subject, email = '' }) {
  const info = db.prepare(
    `INSERT INTO user_identities (user_id, provider, provider_subject, email, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, provider, subject, email || '', nowIso());
  return Number(info.lastInsertRowid);
}

function removeIdentity(db, userId, provider) {
  return db.prepare('DELETE FROM user_identities WHERE user_id = ? AND provider = ?')
    .run(userId, provider).changes;
}

module.exports = {
  normalizeUser,
  findByEmail,
  findById,
  createUser,
  updateDisplayName,
  updateAvatar,
  updatePassword,
  markEmailVerified,
  markLogin,
  setStatus,
  deleteUser,
  userCounts,
  findIdentity,
  listIdentities,
  addIdentity,
  removeIdentity,
};
