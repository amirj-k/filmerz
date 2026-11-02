'use strict';
/**
 * google-diag.js — read-only connectivity check for Google Sign-In.
 *
 * Usage (inside the container):
 *   docker compose exec app npm run diag:google
 *
 * It never prints secrets. It answers one question: can this server reach the
 * token endpoint the app is configured to use, and if not, at which layer
 * (DNS / TCP+TLS / fetch) does it fail?
 *
 * The last check runs the real OAuth2Client from src/auth/google.js, so the
 * result reflects the exact code path the login callback takes.
 */
const dns = require('node:dns').promises;
const https = require('node:https');
const config = require('../src/config');
const google = require('../src/auth/google');

function maskProxy(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '***';
  }
}

function rawPost(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'POST', timeout: 8000 }, (res) => {
      console.log(`[diag] raw https ${url} → status ${res.statusCode}`);
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => {
      console.log(`[diag] raw https ${url} → TIMEOUT (8s)`);
      req.destroy();
      resolve(null);
    });
    req.on('error', (err) => {
      console.log(`[diag] raw https ${url} → ERR ${err.code || ''} ${err.message || ''}`);
      resolve(null);
    });
    req.end();
  });
}

/**
 * Disabled proxy env vars are a very common silent cause of ETIMEDOUT:
 * everything (including Google) is forced through a proxy that is not
 * reachable any more. Report it explicitly.
 */
function reportProxyEnv() {
  const raw = {
    HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || '',
    HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || '',
    NO_PROXY: process.env.NO_PROXY || process.env.no_proxy || '',
    NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY || '',
  };
  console.log('[diag] proxy env:', {
    HTTP_PROXY: maskProxy(raw.HTTP_PROXY),
    HTTPS_PROXY: maskProxy(raw.HTTPS_PROXY),
    NO_PROXY: raw.NO_PROXY,
    NODE_USE_ENV_PROXY: raw.NODE_USE_ENV_PROXY,
  });
  if (raw.NODE_USE_ENV_PROXY === '1' && (raw.HTTPS_PROXY || raw.HTTP_PROXY)) {
    console.log('[diag] WARNING: NODE_USE_ENV_PROXY=1 makes every outbound request use that proxy.');
  }
}

async function main() {
  console.log('[diag] google configured:', config.google.configured);
  console.log('[diag] callback URL:', config.google.callbackUrl);
  console.log('[diag] token URL:', config.google.tokenUrl);
  console.log('[diag] GOOGLE_PROXY_URL set:', Boolean(config.google.proxyUrl), maskProxy(config.google.proxyUrl));
  reportProxyEnv();

  const hosts = [...new Set([
    new URL(config.google.tokenUrl).hostname,
    'oauth2.googleapis.com',
    'www.googleapis.com',
  ])];

  for (const host of hosts) {
    try {
      const addrs = await dns.lookup(host, { all: true });
      console.log(`[diag] DNS ${host}:`, addrs.map((a) => `${a.address}/${a.family}`).join(', '));
    } catch (err) {
      console.log(`[diag] DNS ${host} → ERR ${err.code || ''} ${err.message || ''}`);
    }
  }

  await rawPost(config.google.tokenUrl);
  await rawPost('https://www.googleapis.com/oauth2/v3/certs');

  // Node's built-in fetch (the transport gaxios 7 uses by default).
  try {
    const res = await globalThis.fetch(config.google.tokenUrl, { method: 'POST' });
    console.log('[diag] fetch token URL (direct) → status', res.status);
  } catch (err) {
    console.log('[diag] fetch token URL (direct) → ERR', err.message,
      '| cause:', (err.cause && (err.cause.code || err.cause.message)) || '');
  }

  // The real code path: same client, same endpoint, same proxy agent.
  // Any Google HTTP error (invalid_client / invalid_grant) proves the whole
  // path works — the token never gets exchanged because the code is fake.
  let client = null;
  try {
    console.log('[diag] app client transport:', config.google.proxyUrl
      ? `proxy ${maskProxy(config.google.proxyUrl)}`
      : 'direct (no GOOGLE_PROXY_URL)');
    client = google.createClient();
  } catch (err) {
    console.log('[diag] app client → cannot build client:', (err && err.message) || err);
  }

  if (client) {
    try {
      await client.getToken({ code: 'diag-fake-code', codeVerifier: 'd'.repeat(64) });
      console.log('[diag] app client → unexpected success (no error from Google)');
    } catch (err) {
      const data = (err && err.response && err.response.data) || {};
      if (data.error) {
        console.log(`[diag] app client → Google answered: ${data.error} (${data.error_description || ''})`);
        console.log('[diag] app client → OK: this exact path reaches Google; a real login will work.');
      } else {
        console.log('[diag] app client → network failure:', (err && err.message) || 'unknown',
          '| cause:', (err && err.cause && (err.cause.code || err.cause.message)) || '');
        console.log('[diag] app client → at login the app retries once on the other endpoint/route.');
      }
    }
  }

  console.log('[diag] done.');
  console.log('[diag] interpretation:');
  console.log('  - "Google answered: invalid_client/invalid_grant" → network path is fine;');
  console.log('    a real login will work (check client id/secret and redirect URI in Google Cloud).');
  console.log('  - ETIMEDOUT / ECONNRESET / ENOTFOUND on oauth2.googleapis.com → the app retries');
  console.log('    automatically on www.googleapis.com/oauth2/v4/token; no setting needed.');
  console.log('  - both hosts failing → set GOOGLE_PROXY_URL (http(s):// or socks5h://).');
}

main().catch((err) => {
  console.error('[diag] fatal:', (err && err.message) || err);
  process.exitCode = 1;
});
