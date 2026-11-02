'use strict';
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
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

/**
 * Build the proxy agent for GOOGLE_PROXY_URL.
 * Supports HTTP/HTTPS CONNECT proxies and SOCKS5/SOCKS4 (`socks5://`,
 * `socks5h://`, `socks4://`, `socks4a://`).
 */
function createProxyAgent(proxyUrl) {
  const value = String(proxyUrl || '').trim();
  if (!value) return null;
  if (/^socks[45][ah]?:\/\//i.test(value)) return new SocksProxyAgent(value);
  if (/^https?:\/\//i.test(value)) return new HttpsProxyAgent(value);
  throw new Error('GOOGLE_PROXY_URL must start with http://, https://, socks5:// or socks5h://');
}

function makeClient({ tokenUrl, useProxy = true } = {}) {
  const options = {
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: config.google.callbackUrl,
    endpoints: { oauth2TokenUrl: tokenUrl || config.google.tokenUrl },
    // A blocked endpoint otherwise hangs until the OS TCP timeout (~2 min),
    // which looks to the user like a dead login button.
    transporterOptions: { timeout: OAUTH_TIMEOUT_MS },
  };
  if (useProxy && config.google.proxyUrl) {
    // Only Google API calls go through this proxy; the rest of the app keeps
    // its normal network path.
    options.transporterOptions.agent = createProxyAgent(config.google.proxyUrl);
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
 * Endpoints to try, in order, for the token exchange:
 *   1. the configured endpoint (through the proxy when one is set),
 *   2. the other Google host, directly — so a dead proxy does not lock
 *      everyone out of sign-in.
 */
function tokenAttempts() {
  const configured = config.google.tokenUrl;
  const directAlternative = configured === DEFAULT_TOKEN_URL ? FALLBACK_TOKEN_URL : configured;
  if (config.google.proxyUrl) {
    return [
      { tokenUrl: configured, useProxy: true },
      { tokenUrl: directAlternative, useProxy: false },
    ];
  }
  const attempts = [{ tokenUrl: configured, useProxy: false }];
  if (configured === DEFAULT_TOKEN_URL) attempts.push({ tokenUrl: FALLBACK_TOKEN_URL, useProxy: false });
  return attempts;
}

async function exchangeCode(code, codeVerifier) {
  const attempts = tokenAttempts();
  let lastError = null;

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    const client = makeClient(attempt);
    try {
      const result = await client.getToken({ code, codeVerifier });
      return { client, tokens: result.tokens };
    } catch (err) {
      lastError = err;
      if (err && typeof err === 'object') err.googleEndpoint = attempt.tokenUrl;

      // Google answered with an OAuth error: retrying hides the real problem.
      if (!isNetworkFailure(err) || i === attempts.length - 1) break;

      const next = attempts[i + 1];
      console.warn(
        '[auth][google] token endpoint unreachable, trying fallback:',
        `${attempt.tokenUrl}${attempt.useProxy ? ' via proxy' : ''}`,
        '→', `${next.tokenUrl}${next.useProxy ? ' via proxy' : ''}`,
        '|', (err && err.name) || '', (err && err.message) || ''
      );
    }
  }

  throw lastError;
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
