'use strict';
/**
 * Account & authentication tests.
 *
 * Runs the real Express app against a throwaway SQLite file. No network,
 * no SMTP, no Google: external services are exercised through their
 * "unconfigured" paths, which is exactly what a fresh deployment looks like.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filmerz-auth-'));
process.env.APP_DB_PATH = path.join(dir, 'app.db');
process.env.NODE_ENV = 'test';

const config = require('../src/config');
const { openAppDb } = require('../src/db');
const { applySchema } = require('../src/schema');
const { createApp } = require('../src/server');
const passwords = require('../src/auth/passwords');
const tokens = require('../src/auth/tokens');
const users = require('../src/auth/users');
const lists = require('../src/auth/lists');
const util = require('../src/auth/util');
const { safeRedirect, validateEmail } = require('../src/auth/validate');

let db;
let server;
let base;

/* ------------------------------- helpers ------------------------------- */

function makeClient() {
  const jar = new Map();
  return {
    jar,
    async get(p) {
      return this.request(p, { method: 'GET' });
    },
    async post(p, body, extraHeaders = {}) {
      return this.request(p, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders },
        body: body instanceof URLSearchParams ? body.toString() : new URLSearchParams(body).toString(),
      });
    },
    async request(p, opts = {}) {
      const headers = new Headers(opts.headers || {});
      if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
      const res = await fetch(base + p, { ...opts, headers, redirect: 'manual' });
      for (const raw of res.headers.getSetCookie()) {
        const pair = raw.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const name = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        if (!value || /Max-Age=0/i.test(raw)) jar.delete(name);
        else jar.set(name, value);
      }
      const text = await res.text();
      return { res, text, status: res.status, location: res.headers.get('location') };
    },
    async csrf() {
      // `/` renders for guests and signed-in users alike, so the meta tag is
      // always available (unlike /login, which redirects when signed in).
      const page = await this.get('/');
      const meta = page.text.match(/name="csrf-token" content="([^"]+)"/);
      const form = page.text.match(/name="_csrf" value="([^"]+)"/);
      const value = (meta && meta[1]) || (form && form[1]) || '';
      assert.ok(value, 'csrf token should be present in the page');
      return value;
    },
  };
}

function seedMovie(id = 1, title = 'Test Movie') {
  db.prepare(
    `INSERT OR REPLACE INTO movies (id, slug, title_en, title_fa, year, published)
     VALUES (?, ?, ?, ?, ?, 1)`
  ).run(id, `test-movie-${id}`, title, title, 2020);
}

function makeUser(email, password, { verified = true, status = 'active', role = 'user' } = {}) {
  return passwords.hashPassword(password).then((hash) => users.createUser(db, {
    email,
    emailOriginal: email,
    displayName: 'Test User',
    passwordHash: hash,
    status,
    emailVerified: verified,
    role,
  }));
}

async function login(client, email, password, extra = {}) {
  const csrf = await client.csrf();
  return client.post('/login', { _csrf: csrf, email, password, ...extra });
}

const PASSWORD = 'a-very-long-password-123';

/* -------------------------------- setup -------------------------------- */

test.before(async () => {
  db = openAppDb(process.env.APP_DB_PATH);
  seedMovie(1, 'Test Movie');
  server = createApp({ db }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  try { server && server.close(); } catch { /* ignore */ }
  try { db && db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* --------------------------------- tests ------------------------------- */

test('schema migration is idempotent and keeps catalogue data', () => {
  const usersTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'"
  ).get();
  assert.ok(usersTable, 'users table exists');
  applySchema(db);
  applySchema(db);
  const movie = db.prepare('SELECT id, title_en FROM movies WHERE id = 1').get();
  assert.strictEqual(movie.title_en, 'Test Movie');
  assert.strictEqual(
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
    '2'
  );
});

test('password hashing uses versioned scrypt with a per-password salt', async () => {
  const a = await passwords.hashPassword('correct horse battery staple');
  const b = await passwords.hashPassword('correct horse battery staple');
  assert.match(a, /^scrypt\$1\$65536\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.notStrictEqual(a, b, 'salts are random');
  assert.deepStrictEqual(await passwords.verifyPassword('correct horse battery staple', a), { ok: true, needsRehash: false });
  assert.strictEqual((await passwords.verifyPassword('wrong', a)).ok, false);
  assert.strictEqual((await passwords.verifyPassword('x', 'md5$deadbeef')).ok, false);
  assert.strictEqual((await passwords.verifyPassword('x', '')).ok, false);
});

test('redirect validation blocks open-redirect payloads', () => {
  assert.strictEqual(safeRedirect('/account/settings'), '/account/settings');
  assert.strictEqual(safeRedirect('//evil.example'), '/account');
  assert.strictEqual(safeRedirect('/\\evil.example'), '/account');
  assert.strictEqual(safeRedirect('https://evil.example'), '/account');
  assert.strictEqual(safeRedirect('/\r\nSet-Cookie: x=1'), '/account');
  assert.strictEqual(safeRedirect('javascript:alert(1)'), '/account');
});

test('email validation rejects injection-looking input', () => {
  assert.strictEqual(validateEmail("' OR 1=1 --@evil.com").ok, false);
  assert.strictEqual(validateEmail('not-an-email').ok, false);
  assert.strictEqual(validateEmail('  USER@Example.COM ').email, 'user@example.com');
});

test('registration is refused when verification is required but SMTP is missing', async () => {
  const previousRequired = config.auth.emailVerificationRequired;
  const previousMail = config.mailConfigured;
  config.auth.emailVerificationRequired = true;
  config.mailConfigured = false;
  try {
    const client = makeClient();
    const csrf = await client.csrf();
    const out = await client.post('/register', {
      _csrf: csrf, display_name: 'Ali', email: 'blocked@example.com',
      password: PASSWORD, confirm_password: PASSWORD,
    });
    assert.strictEqual(out.status, 503);
    assert.match(out.text, /ثبت‌نام موقتاً غیرفعال/);
    assert.strictEqual(users.findByEmail(db, 'blocked@example.com'), undefined);
  } finally {
    config.auth.emailVerificationRequired = previousRequired;
    config.mailConfigured = previousMail;
  }
});

test('registration validates input, ignores role injection and normalises email', async () => {
  config.auth.emailVerificationRequired = false;
  const client = makeClient();
  const csrf = await client.csrf();

  const weak = await client.post('/register', {
    _csrf: csrf, display_name: 'Ali', email: 'weak@example.com',
    password: 'short', confirm_password: 'short',
  });
  assert.strictEqual(weak.status, 400);

  const mismatch = await client.post('/register', {
    _csrf: csrf, display_name: 'Ali', email: 'mismatch@example.com',
    password: PASSWORD, confirm_password: PASSWORD + 'x',
  });
  assert.strictEqual(mismatch.status, 400);

  const ok = await client.post('/register', {
    _csrf: csrf, display_name: 'Ali Rezaei', email: '  REGISTER@Example.COM ',
    password: PASSWORD, confirm_password: PASSWORD, role: 'admin',
  });
  assert.strictEqual(ok.status, 302);
  assert.strictEqual(ok.location, '/login?notice=registered');

  const row = users.findByEmail(db, 'register@example.com');
  assert.ok(row, 'account created with normalised email');
  assert.strictEqual(row.role, 'user', 'request body cannot choose a role');
  assert.strictEqual(row.status, 'active');
  assert.ok(row.email_verified_at);

  const dup = await client.post('/register', {
    _csrf: csrf, display_name: 'Ali', email: 'register@example.com',
    password: PASSWORD, confirm_password: PASSWORD,
  });
  assert.strictEqual(dup.status, 409);
});

test('CSRF is enforced on state-changing requests', async () => {
  const client = makeClient();
  const out = await client.post('/login', { email: 'register@example.com', password: PASSWORD });
  assert.strictEqual(out.status, 403);
  assert.match(out.text, /CSRF/);

  const api = await client.post('/api/favorites/toggle', { type: 'movie', id: 1 });
  assert.strictEqual(api.status, 403, 'API CSRF failure is JSON');
  assert.strictEqual(JSON.parse(api.text).error, 'CSRF_INVALID');
});

test('login rejects wrong passwords and unknown accounts without leaking which', async () => {
  const client = makeClient();
  const wrong = await login(client, 'register@example.com', 'wrong-password-123');
  assert.strictEqual(wrong.status, 401);
  const unknown = await login(client, 'nobody@example.com', 'wrong-password-123');
  assert.strictEqual(unknown.status, 401);
  assert.match(unknown.text, /ایمیل یا رمز عبور نادرست است/);
});

test('login sets a secure opaque session cookie and server stores only its hash', async () => {
  const client = makeClient();
  const out = await login(client, 'register@example.com', PASSWORD, { next: '//evil.example' });
  assert.strictEqual(out.status, 302);
  assert.strictEqual(out.location, '/account', 'open redirect neutralised');

  const rawCookie = out.res.headers.getSetCookie()
    .find((c) => c.startsWith('fmz_auth='));
  assert.ok(rawCookie, 'account session cookie issued');
  assert.match(rawCookie, /HttpOnly/);
  assert.match(rawCookie, /SameSite=Lax/);
  assert.match(rawCookie, /Path=\//);

  const token = client.jar.get('fmz_auth');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);

  const stored = db.prepare('SELECT token_hash FROM user_sessions').all().map((r) => r.token_hash);
  assert.ok(stored.length > 0);
  assert.ok(!stored.includes(token), 'raw token is never stored');
  assert.strictEqual(stored[0], util.sha256(token));

  const page = await client.get('/account/profile');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /register@example.com/);
});

test('login rotates the session and invalidates the previous token', async () => {
  const client = makeClient();
  const first = await login(client, 'register@example.com', PASSWORD);
  assert.strictEqual(first.status, 302);
  const oldToken = client.jar.get('fmz_auth');

  const second = await login(client, 'register@example.com', PASSWORD);
  assert.strictEqual(second.status, 302);
  const newToken = client.jar.get('fmz_auth');
  assert.notStrictEqual(oldToken, newToken);

  const replayed = makeClient();
  replayed.jar.set('fmz_auth', oldToken);
  const page = await replayed.get('/account/profile');
  assert.strictEqual(page.status, 302);
  assert.match(page.location, /^\/login/);
});

test('unverified accounts cannot sign in when verification is required', async () => {
  await makeUser('pending@example.com', PASSWORD, { verified: false, status: 'pending' });
  config.auth.emailVerificationRequired = true;
  try {
    const client = makeClient();
    const out = await login(client, 'pending@example.com', PASSWORD);
    assert.strictEqual(out.status, 403);
    assert.match(out.text, /تأیید کنید/);
  } finally {
    config.auth.emailVerificationRequired = false;
  }
});

test('disabled accounts cannot sign in', async () => {
  await makeUser('disabled@example.com', PASSWORD, { status: 'disabled' });
  const client = makeClient();
  const out = await login(client, 'disabled@example.com', PASSWORD);
  assert.strictEqual(out.status, 403);
  assert.match(out.text, /غیرفعال/);
});

test('email verification tokens are hashed, single use and expire', async () => {
  const userId = await makeUser('verify@example.com', PASSWORD, { verified: false, status: 'pending' });
  const raw = tokens.issueEmailVerification(db, userId);
  const row = db.prepare('SELECT token_hash FROM email_verification_tokens WHERE user_id = ?').get(userId);
  assert.strictEqual(row.token_hash, util.sha256(raw));
  assert.notStrictEqual(row.token_hash, raw);

  const client = makeClient();
  const first = await client.get(`/verify-email?token=${encodeURIComponent(raw)}`);
  assert.strictEqual(first.status, 302);
  assert.strictEqual(first.location, '/login?notice=verified');
  assert.ok(users.findById(db, userId).email_verified_at);
  assert.strictEqual(users.findById(db, userId).status, 'active');

  const replay = await client.get(`/verify-email?token=${encodeURIComponent(raw)}`);
  assert.strictEqual(replay.status, 200);
  assert.match(replay.text, /معتبر نیست/);

  const bad = await client.get('/verify-email?token=not-a-real-token');
  assert.strictEqual(bad.status, 200);
  assert.match(bad.text, /معتبر نیست/);
});

test('expired verification token is rejected', async () => {
  const userId = await makeUser('expired-token@example.com', PASSWORD, { verified: false, status: 'pending' });
  const raw = tokens.issueEmailVerification(db, userId);
  db.prepare('UPDATE email_verification_tokens SET expires_at = ? WHERE user_id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), userId);
  const client = makeClient();
  const out = await client.get(`/verify-email?token=${encodeURIComponent(raw)}`);
  assert.match(out.text, /معتبر نیست/);
  assert.strictEqual(users.findById(db, userId).email_verified_at, null);
});

test('password reset is single use, revokes sessions and rejects expired links', async () => {
  const userId = await makeUser('reset@example.com', PASSWORD);

  const client = makeClient();
  assert.strictEqual((await login(client, 'reset@example.com', PASSWORD)).status, 302);

  const raw = tokens.issuePasswordReset(db, userId);
  const csrf = await client.csrf();
  const newPassword = 'brand-new-password-456';
  const changed = await client.post('/reset-password', {
    _csrf: csrf, token: raw, password: newPassword, confirm_password: newPassword,
  });
  assert.strictEqual(changed.status, 302);
  assert.strictEqual(changed.location, '/login?notice=reset');

  const reuse = await client.post('/reset-password', {
    _csrf: csrf, token: raw, password: newPassword, confirm_password: newPassword,
  });
  assert.match(reuse.text, /قبلاً استفاده شده|معتبر نیست/);

  const oldCookie = makeClient();
  assert.strictEqual((await login(oldCookie, 'reset@example.com', PASSWORD)).status, 401, 'old password is gone');
  const fresh = await login(oldCookie, 'reset@example.com', newPassword);
  assert.strictEqual(fresh.status, 302);

  // Expired reset link
  const expiredRaw = tokens.issuePasswordReset(db, userId);
  db.prepare('UPDATE password_reset_tokens SET expires_at = ? WHERE user_id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), userId);
  const expired = await client.post('/reset-password', {
    _csrf: csrf, token: expiredRaw, password: newPassword, confirm_password: newPassword,
  });
  assert.match(expired.text, /معتبر نیست/);
});

test('forgot-password does not reveal whether an account exists', async () => {
  const client = makeClient();
  const csrf = await client.csrf();
  const known = await client.post('/forgot-password', { _csrf: csrf, email: 'reset@example.com' });
  const unknown = await client.post('/forgot-password', { _csrf: csrf, email: 'ghost@example.com' });
  assert.strictEqual(known.status, 200);
  assert.strictEqual(unknown.status, 200);
  // Identical apart from per-request CSP nonces.
  const strip = (html) => html.replace(/nonce="[^"]*"/g, 'nonce="x"');
  assert.strictEqual(strip(known.text), strip(unknown.text));
});

test('account pages require authentication', async () => {
  const client = makeClient();
  for (const p of ['/account', '/account/profile', '/account/favorites', '/account/watchlist', '/account/history', '/account/settings']) {
    const out = await client.get(p);
    assert.strictEqual(out.status, 302, `${p} redirects`);
    assert.match(out.location, /^\/login\?next=/);
  }
});

test('a normal account can never reach the admin panel', async () => {
  const client = makeClient();
  await login(client, 'register@example.com', PASSWORD);
  const out = await client.get('/admin');
  assert.strictEqual(out.status, 302);
  assert.match(out.location, /\/admin\/login/);
});

test('favorites and watchlist are isolated per account', async () => {
  seedMovie(2, 'Second Movie');
  const aId = await makeUser('alice@example.com', PASSWORD);
  const bId = await makeUser('bob@example.com', PASSWORD);

  const alice = makeClient();
  await login(alice, 'alice@example.com', PASSWORD);
  let csrf = await alice.csrf();
  const added = await alice.post('/api/favorites/toggle', { _csrf: csrf, type: 'movie', id: 2 }, { 'x-csrf-token': csrf });
  assert.strictEqual(added.status, 200);
  assert.strictEqual(JSON.parse(added.text).active, true);
  assert.strictEqual(lists.count(db, 'favorites', aId), 1);

  const alicePage = await alice.get('/account/favorites');
  assert.strictEqual(alicePage.status, 200);
  assert.match(alicePage.text, /Second Movie/);
  assert.match(alicePage.text, /\/movie\/2-test-movie-2/);

  const bob = makeClient();
  await login(bob, 'bob@example.com', PASSWORD);
  const bobPage = await bob.get('/account/favorites');
  assert.strictEqual(bobPage.status, 200);
  assert.ok(!bobPage.text.includes('Second Movie'), 'other user list is not visible');
  assert.strictEqual(lists.count(db, 'favorites', bId), 0);

  // Toggling again removes only from the owner.
  csrf = await alice.csrf();
  const removed = await alice.post('/api/favorites/toggle', { _csrf: csrf, type: 'movie', id: 2 });
  assert.strictEqual(JSON.parse(removed.text).active, false);
  assert.strictEqual(lists.count(db, 'favorites', aId), 0);
});

test('guests keep the cookie wishlist and it is CSRF-protected', async () => {
  const guest = makeClient();
  const csrf = await guest.csrf();
  assert.ok(guest.jar.get('fmz_wishlist'), 'guest wishlist cookie issued');

  const noToken = await guest.post('/api/wishlist/toggle', { type: 'movie', id: 1 });
  assert.strictEqual(noToken.status, 403);

  const added = await guest.post('/api/wishlist/toggle',
    { _csrf: csrf, type: 'movie', id: 1 }, { 'x-csrf-token': csrf });
  assert.strictEqual(added.status, 200);
  const body = JSON.parse(added.text);
  assert.strictEqual(body.active, true);
  assert.strictEqual(body.scope, 'guest');
  assert.strictEqual(body.count, 1);

  const page = await guest.get('/wishlist');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /Test Movie/);
});

test('personal list endpoints reject unknown types, missing ids and unpublished content', async () => {
  const client = makeClient();
  await login(client, 'alice@example.com', PASSWORD);
  const csrf = await client.csrf();

  const badType = await client.post('/api/favorites/toggle', { _csrf: csrf, type: 'admin', id: 1 });
  assert.strictEqual(badType.status, 400);

  const badId = await client.post('/api/favorites/toggle', { _csrf: csrf, type: 'movie', id: 'abc' });
  assert.strictEqual(badId.status, 400);

  const missing = await client.post('/api/favorites/toggle', { _csrf: csrf, type: 'movie', id: 999999 });
  assert.strictEqual(missing.status, 404);

  db.prepare('UPDATE movies SET published = 0 WHERE id = 2').run();
  const unpublished = await client.post('/api/favorites/toggle', { _csrf: csrf, type: 'movie', id: 2 });
  assert.strictEqual(unpublished.status, 404);
  db.prepare('UPDATE movies SET published = 1 WHERE id = 2').run();
});

test('watch history records real events only and supports continue-watching', async () => {
  const userId = await makeUser('history@example.com', PASSWORD);
  const client = makeClient();
  await login(client, 'history@example.com', PASSWORD);
  const csrf = await client.csrf();

  const ok = await client.post('/api/watch/progress', {
    _csrf: csrf, item_type: 'movie', item_id: 1, position: 600, duration: 7200,
  });
  assert.strictEqual(ok.status, 200);
  const rows = lists.historyFor(db, userId);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].progressSeconds, 600);
  assert.strictEqual(lists.continueWatching(db, userId).length, 1);

  const noPosition = await client.post('/api/watch/progress', {
    _csrf: csrf, item_type: 'movie', item_id: 1,
  });
  assert.strictEqual(noPosition.status, 200);
  const after = lists.historyFor(db, userId)[0];
  assert.strictEqual(after.progressSeconds, 600, 'missing progress never overwrites real progress');
  assert.strictEqual(after.watchCount, 2);

  const wrongEpisode = await client.post('/api/watch/progress', {
    _csrf: csrf, item_type: 'movie', item_id: 1, episode_id: 5,
  });
  assert.strictEqual(wrongEpisode.status, 404);
});

test('profile update escapes user content (XSS)', async () => {
  const userId = await makeUser('xss@example.com', PASSWORD);
  const client = makeClient();
  await login(client, 'xss@example.com', PASSWORD);
  const csrf = await client.csrf();
  const payload = '<script>alert(1)</script>';
  const out = await client.post('/account/profile', { _csrf: csrf, display_name: payload });
  assert.strictEqual(out.status, 302);

  const page = await client.get('/account/profile');
  assert.ok(!page.text.includes(payload), 'raw script tag must not be rendered');
  assert.ok(page.text.includes('&lt;script&gt;'), 'value is HTML-escaped');
  assert.strictEqual(users.findById(db, userId).display_name, payload);
});

test('logging out revokes the session; logout-all kills every device', async () => {
  const user = await makeUser('multi@example.com', PASSWORD);

  const one = makeClient();
  const two = makeClient();
  await login(one, 'multi@example.com', PASSWORD);
  await login(two, 'multi@example.com', PASSWORD);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM user_sessions WHERE user_id = ?').get(user).c, 2);

  let csrf = await one.csrf();
  const out = await one.post('/account/logout-all', { _csrf: csrf });
  assert.strictEqual(out.status, 302);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM user_sessions WHERE user_id = ?').get(user).c, 0);

  const other = await two.get('/account/profile');
  assert.strictEqual(other.status, 302);
  assert.match(other.location, /^\/login/);

  // Simple logout only removes the current session.
  const three = makeClient();
  await login(three, 'multi@example.com', PASSWORD);
  csrf = await three.csrf();
  const logout = await three.post('/logout', { _csrf: csrf });
  assert.strictEqual(logout.status, 302);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM user_sessions WHERE user_id = ?').get(user).c, 0);
});

test('Google sign-in fails closed when unconfigured and rejects bad state', async () => {
  const previous = config.google.configured;
  const client = makeClient();

  config.google.configured = false;
  try {
    const out = await client.get('/auth/google');
    assert.strictEqual(out.status, 404);
    assert.match(out.text, /not configured/i);

    // Unconfigured callback never attempts a token exchange.
    const callback = await client.get('/auth/google/callback?code=abc&state=bogus');
    assert.strictEqual(callback.status, 302);
    assert.match(callback.location, /google_unavailable/);
  } finally {
    config.google.configured = previous;
  }

  // Configured, but the state is unknown: rejected before any network call.
  config.google.configured = true;
  try {
    const callback = await client.get('/auth/google/callback?code=abc&state=bogus');
    assert.strictEqual(callback.status, 302);
    assert.match(callback.location, /google_error=1/);
  } finally {
    config.google.configured = previous;
  }
});

test('Google start flow stores hashed state, nonce and PKCE S256 challenge', async () => {
  const google = require('../src/auth/google');
  const previous = config.google.configured;
  config.google.configured = true;
  try {
    const flow = google.startFlow(db, { redirectAfter: '/account/watchlist' });
    assert.ok(flow && flow.url);
    const url = new URL(flow.url);
    assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
    assert.strictEqual(url.searchParams.get('scope'), 'openid email profile');

    const state = url.searchParams.get('state');
    const row = db.prepare('SELECT state_hash, nonce, code_verifier, redirect_after FROM oauth_states ORDER BY id DESC LIMIT 1').get();
    assert.strictEqual(row.state_hash, util.sha256(state));
    assert.strictEqual(row.nonce, url.searchParams.get('nonce'));
    assert.strictEqual(row.redirect_after, '/account/watchlist');
    assert.ok(row.code_verifier.length >= 43);
    assert.strictEqual(
      crypto.createHash('sha256').update(row.code_verifier).digest('base64url'),
      url.searchParams.get('code_challenge')
    );

    // State is single use.
    assert.ok(google.consumeState(db, state));
    assert.strictEqual(google.consumeState(db, state), null);
  } finally {
    config.google.configured = previous;
  }
});

test('session cookie gets the __Host- prefix and Secure flag in secure mode', () => {
  const authSession = require('../src/auth/users-session');
  const previous = config.cookieSecure;
  config.cookieSecure = true;
  try {
    assert.strictEqual(authSession.cookieName(), '__Host-fmz_auth');
  } finally {
    config.cookieSecure = previous;
  }
  assert.strictEqual(authSession.cookieName(), 'fmz_auth');
});

test('detail pages expose a self-consistent canonical and indexable robots tag', async () => {
  const client = makeClient();
  const page = await client.get('/movie/1-test-movie-1');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /<meta name="robots" content="index, follow">/);
  const canonical = page.text.match(/<link rel="canonical" href="([^"]+)">/);
  assert.ok(canonical, 'canonical link present');
  assert.strictEqual(canonical[1], `${config.appBaseUrl}/movie/1-test-movie-1`);
  assert.ok(page.text.includes('application/ld+json'), 'structured data present');
});

test('sitemap endpoints return XML, never HTML', async () => {
  const client = makeClient();
  const index = await client.get('/sitemap.xml');
  assert.strictEqual(index.status, 200);
  assert.match(index.res.headers.get('content-type'), /application\/xml/);
  assert.ok(index.text.startsWith('<?xml'));
  assert.ok(index.text.includes('<sitemapindex'));
  assert.strictEqual(index.res.headers.getSetCookie().length, 0, 'sitemap responses stay cookie-free');

  const movies = await client.get('/sitemaps/movies-1.xml');
  assert.strictEqual(movies.status, 200);
  assert.match(movies.res.headers.get('content-type'), /application\/xml/);
  assert.ok(movies.text.includes('/movie/1-test-movie-1'));

  const alias = await client.get('/sitemaps/movies.xml');
  assert.strictEqual(alias.status, 200);
  assert.ok(alias.text.startsWith('<?xml'));

  // Conventional alternative spellings must also be XML, never the HTML 404.
  for (const p of ['/sitemap_index.xml', '/sitemap-index.xml', '/sitemaps/index.xml']) {
    const out = await client.get(p);
    assert.strictEqual(out.status, 200, p);
    assert.match(out.res.headers.get('content-type'), /application\/xml/, p);
    assert.ok(out.text.startsWith('<?xml'), p);
  }
  const noExt = await client.get('/sitemaps/movies');
  assert.strictEqual(noExt.status, 200);
  assert.ok(noExt.text.startsWith('<?xml'));

  const legacy = await client.get('/sitemap');
  assert.strictEqual(legacy.status, 301);
  assert.strictEqual(legacy.location, '/sitemap.xml');

  const missing = await client.get('/sitemaps/movies-99.xml');
  assert.strictEqual(missing.status, 404);
  assert.match(missing.res.headers.get('content-type'), /text\/plain/);
  assert.ok(!missing.text.includes('<html'), 'a missing sitemap must not be an HTML page');

  const robots = await client.get('/robots.txt');
  assert.strictEqual(robots.status, 200);
  assert.match(robots.res.headers.get('content-type'), /text\/plain/);
  assert.match(robots.text, /Sitemap: .*\/sitemap\.xml/);
  assert.strictEqual(robots.res.headers.getSetCookie().length, 0, 'robots.txt stays cookie-free');
});
