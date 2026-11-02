'use strict';
/**
 * google-diag.js — read-only connectivity check for Google Sign-In.
 *
 * Usage (inside the container):
 *   docker compose exec app npm run diag:google
 *
 * It never prints secrets. It answers one question: can this server reach
 * Google's OAuth endpoints, and if not, at which layer (DNS / TCP+TLS /
 * node-fetch) does it fail?
 */
const dns = require('node:dns').promises;
const https = require('node:https');
const config = require('../src/config');

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

async function main() {
  console.log('[diag] google configured:', config.google.configured);
  console.log('[diag] callback URL:', config.google.callbackUrl);
  console.log('[diag] proxy env:', {
    HTTP_PROXY: maskProxy(process.env.HTTP_PROXY),
    HTTPS_PROXY: maskProxy(process.env.HTTPS_PROXY),
    NO_PROXY: process.env.NO_PROXY || '',
    NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY || '',
  });

  for (const host of ['oauth2.googleapis.com', 'www.googleapis.com']) {
    try {
      const addrs = await dns.lookup(host, { all: true });
      console.log(`[diag] DNS ${host}:`, addrs.map((a) => `${a.address}/${a.family}`).join(', '));
    } catch (err) {
      console.log(`[diag] DNS ${host} → ERR ${err.code || ''} ${err.message || ''}`);
    }
  }

  await rawPost('https://oauth2.googleapis.com/token');
  await rawPost('https://www.googleapis.com/oauth2/v3/certs');

  // gaxios uses node-fetch on Node; this is the transport the app really uses.
  try {
    const { default: nodeFetch } = await import('node-fetch');
    const res = await nodeFetch('https://oauth2.googleapis.com/token', { method: 'POST' });
    console.log('[diag] node-fetch → status', res.status);
  } catch (err) {
    console.log('[diag] node-fetch → ERR', err.message,
      '| code:', err.code || '',
      '| cause:', (err.cause && (err.cause.code || err.cause.message)) || '');
  }

  // Node's built-in fetch; used if we switch the Google client transport.
  try {
    const res = await globalThis.fetch('https://oauth2.googleapis.com/token', { method: 'POST' });
    console.log('[diag] global fetch → status', res.status);
  } catch (err) {
    console.log('[diag] global fetch → ERR', err.message,
      '| cause:', (err.cause && (err.cause.code || err.cause.message)) || '');
  }

  console.log('[diag] done: status 400/405 means Google is reachable; ERR/TIMEOUT means the server cannot reach it.');
}

main().catch((err) => {
  console.error('[diag] fatal:', (err && err.message) || err);
  process.exitCode = 1;
});
