'use strict';
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const config = require('../config');
const { nowIso, isoAfter, sha256, randomToken, isExpired } = require('./util');

/**
 * Google Sign-In via OAuth 2.0 Authorization Code Flow + OpenID Connect.
 *
 * - State is random, single-use and stored hashed (CSRF protection).
 * - A nonce is sent and verified inside the ID token (replay protection).
 * - PKCE S256 is used on top of the confidential-client flow.
 * - The ID token signature, issuer, audience and expiry are verified by
 *   Google's official library; email_verified and sub are checked here.
 * - Google access/refresh tokens are never persisted.
 */

const PROVIDER = 'google';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

function isConfigured() {
  return Boolean(config.google.configured);
}

function makeClient() {
  return new OAuth2Client({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: config.google.callbackUrl,
  });
}

function pkcePair() {
  const verifier = randomToken(48); // 64 chars, base64url
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Build the authorization URL and persist the one-time state row. */
function startFlow(db, { redirectAfter = '', linkUserId = null } = {}) {
  if (!isConfigured()) return null;
  const state = randomToken(32);
  const nonce = randomToken(24);
  const { verifier, challenge } = pkcePair();
  db.prepare(
    `INSERT INTO oauth_states
       (state_hash, nonce, code_verifier, redirect_after, link_user_id, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(
    sha256(state), nonce, verifier, String(redirectAfter || '').slice(0, 2000),
    linkUserId || null, nowIso(), isoAfter(config.auth.oauthStateTtlMs)
  );

  const url = makeClient().generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    include_granted_scopes: false,
  });
  return { url, state };
}

function consumeState(db, state) {
  if (!state) return null;
  const row = db.prepare(
    `SELECT id, nonce, code_verifier, redirect_after, link_user_id, expires_at, used_at
       FROM oauth_states WHERE state_hash = ?`
  ).get(sha256(state));
  if (!row || row.used_at || isExpired(row.expires_at)) return null;
  const claimed = db.prepare(
    'UPDATE oauth_states SET used_at = ? WHERE id = ? AND used_at IS NULL'
  ).run(nowIso(), row.id);
  if (!claimed.changes) return null;
  return row;
}

/**
 * Exchange the authorization code and fully validate the ID token.
 * Returns { payload, stateRow } or throws an Error with a safe message.
 */
async function exchange(db, { code, state }) {
  if (!isConfigured()) throw new Error('GOOGLE_NOT_CONFIGURED');
  const stateRow = consumeState(db, state);
  if (!stateRow) throw new Error('GOOGLE_BAD_STATE');
  if (!code) throw new Error('GOOGLE_NO_CODE');

  const client = makeClient();
  let tokens;
  try {
    const result = await client.getToken({ code, codeVerifier: stateRow.code_verifier });
    tokens = result.tokens;
  } catch {
    throw new Error('GOOGLE_TOKEN_EXCHANGE_FAILED');
  }
  if (!tokens || !tokens.id_token) throw new Error('GOOGLE_NO_ID_TOKEN');

  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: config.google.clientId,
    });
    payload = ticket.getPayload();
  } catch {
    throw new Error('GOOGLE_INVALID_ID_TOKEN');
  }

  if (!payload || !payload.sub) throw new Error('GOOGLE_INVALID_ID_TOKEN');
  if (!ISSUERS.has(payload.iss)) throw new Error('GOOGLE_INVALID_ISSUER');
  if (payload.aud !== config.google.clientId) throw new Error('GOOGLE_INVALID_AUDIENCE');
  if (!payload.exp || payload.exp * 1000 <= Date.now()) throw new Error('GOOGLE_EXPIRED_TOKEN');
  if (!payload.nonce || payload.nonce !== stateRow.nonce) throw new Error('GOOGLE_BAD_NONCE');
  if (payload.email_verified !== true) throw new Error('GOOGLE_EMAIL_NOT_VERIFIED');
  if (!payload.email) throw new Error('GOOGLE_NO_EMAIL');

  return { payload, stateRow };
}

module.exports = {
  PROVIDER,
  isConfigured,
  startFlow,
  exchange,
  consumeState,
};
