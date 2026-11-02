'use strict';
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { HttpsProxyAgent } = require('https-proxy-agent');
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
// Google's canonical token endpoints. Some networks resolve and reach
// www.googleapis.com while silently dropping traffic to oauth2.googleapis.com,
// so the app retries once on the alternate host when the first attempt never
// reaches Google (a timeout/reset, not an OAuth error).
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FALLBACK_TOKEN_URL = 'https://www.googleapis.com/oauth2/v4/token';
const OAUTH_TIMEOUT_MS = 15000;

function isConfigured() {
  return Boolean(config.google.configured);
}

function makeClient(tokenUrl) {
  const options = {
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: config.google.callbackUrl,
    endpoints: { oauth2TokenUrl: tokenUrl || config.google.tokenUrl },
    // A blocked endpoint otherwise hangs until the OS TCP timeout (~2 min),
    // which looks to the user like a dead login button.
    transporterOptions: { timeout: OAUTH_TIMEOUT_MS },
  };
  if (config.google.proxyUrl) {
    // Only Google API calls go through this proxy; the rest of the app keeps
    // its normal network path.
    options.transporterOptions.agent = new HttpsProxyAgent(config.google.proxyUrl);
  }
  return new OAuth2Client(options);
}

/**
 * True when Google probably never saw the request: timeout, reset, DNS, or a
 * proxy/CDN error page. A real OAuth answer from Google is always JSON with an
 * `error` field, and retrying that would only hide the real problem.
 */
function isNetworkFailure(err) {
  if (!err) return false;
  const data = err.response && err.response.data;
  if (data && typeof data === 'object' && data.error) return false; // Google answered
  if (!err.response) return true; // no HTTP response at all
  return typeof data !== 'object'; // HTML/empty body from a middlebox
}

/**
 * Exchange the authorization code for tokens, with one retry on the
 * alternate Google token host when the primary host is unreachable.
 */
async function exchangeCode(code, codeVerifier) {
  const client = makeClient();
  try {
    const result = await client.getToken({ code, codeVerifier });
    return { client, tokens: result.tokens };
  } catch (err) {
    const canRetry = config.google.tokenUrl === DEFAULT_TOKEN_URL
      && !config.google.proxyUrl
      && isNetworkFailure(err);
    if (!canRetry) {
      if (err && typeof err === 'object') err.googleEndpoint = config.google.tokenUrl;
      throw err;
    }

    console.warn(
      '[auth][google] primary token endpoint unreachable, retrying via www.googleapis.com:',
      (err && err.name) || '', (err && err.message) || 'unknown'
    );
    const fallback = makeClient(FALLBACK_TOKEN_URL);
    try {
      const result = await fallback.getToken({ code, codeVerifier });
      return { client: fallback, tokens: result.tokens };
    } catch (fallbackErr) {
      if (fallbackErr && typeof fallbackErr === 'object') {
        fallbackErr.googleEndpoint = FALLBACK_TOKEN_URL;
      }
      throw fallbackErr;
    }
  }
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

  let client;
  let tokens;
  try {
    ({ client, tokens } = await exchangeCode(code, stateRow.code_verifier));
  } catch (err) {
    const provider = (err && err.response && err.response.data) || {};
    console.error('[auth][google] token exchange failed:',
      provider.error || (err && err.message) || 'unknown',
      '| endpoint:', (err && err.googleEndpoint) || config.google.tokenUrl,
      '| cause:', (err && err.cause && (err.cause.code || err.cause.message)) || '');
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
  } catch (err) {
    console.error('[auth][google] id token verification failed:', (err && err.message) || 'unknown');
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
  // Exported only so scripts/google-diag.js can exercise the exact client
  // (proxy agent + token endpoint) the app uses.
  createClient: makeClient,
  startFlow,
  exchange,
  consumeState,
};
