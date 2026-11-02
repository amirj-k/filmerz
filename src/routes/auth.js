'use strict';
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const users = require('../auth/users');
const lists = require('../auth/lists');
const authSession = require('../auth/users-session');
const passwords = require('../auth/passwords');
const tokens = require('../auth/tokens');
const mail = require('../auth/mail');
const google = require('../auth/google');
const csrf = require('../auth/csrf');
const { rateLimiter } = require('../ratelimit');
const {
  normalizeEmail, validateEmail, validatePassword, validateDisplayName, safeRedirect, asInt,
} = require('../auth/validate');
const { nowIso, withTransaction } = require('../auth/util');

/** Small in-memory sliding-window counter for per-account/IP login abuse. */
function windowCounter({ max, windowMs }) {
  const map = new Map();
  let lastSweep = 0;
  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [k, v] of map) if (v.resetAt <= now) map.delete(k);
  }
  return {
    blocked(key) {
      const now = Date.now();
      sweep(now);
      const rec = map.get(key);
      return Boolean(rec && rec.resetAt > now && rec.count >= max);
    },
    hit(key) {
      const now = Date.now();
      const rec = map.get(key);
      if (!rec || rec.resetAt <= now) map.set(key, { count: 1, resetAt: now + windowMs });
      else rec.count += 1;
    },
    clear(key) { map.delete(key); },
  };
}

function authRoutes(app, db) {
  const r = express.Router();

  const loginIpLimit = rateLimiter({
    windowMs: config.auth.login.ipWindowMs,
    max: config.auth.login.ipMax,
    name: 'auth-login-ip',
    onLimit(req, res, retryAfter) {
      return renderAuth(res, 'auth/login', {
        title: 'ورود — فیلمرز',
        error: 'تلاش‌های ورود بیش از حد مجاز است. چند دقیقه بعد دوباره تلاش کنید.',
        values: { email: String((req.body && req.body.email) || '') },
        next: safeRedirect((req.body && req.body.next) || req.query.next, '/account'),
        status: 429,
        retryAfter,
      });
    },
  });
  const registerLimit = rateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 20,
    name: 'auth-register',
    onLimit(req, res) {
      return renderAuth(res, 'auth/register', {
        title: 'ثبت‌نام — فیلمرز',
        error: 'تعداد درخواست‌های ثبت‌نام زیاد است. کمی بعد دوباره تلاش کنید.',
        values: {},
        status: 429,
      });
    },
  });
  const forgotLimit = rateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 8,
    name: 'auth-forgot',
    onLimit(req, res) {
      return renderAuth(res, 'auth/forgot-password', {
        title: 'بازیابی رمز عبور — فیلمرز',
        error: 'تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کنید.',
        values: {},
        status: 429,
      });
    },
  });
  const resetLimit = rateLimiter({ windowMs: 15 * 60 * 1000, max: 20, name: 'auth-reset' });
  const resendLimit = rateLimiter({ windowMs: 15 * 60 * 1000, max: 8, name: 'auth-resend' });
  const accountLimiter = windowCounter({
    max: config.auth.login.accountMax,
    windowMs: config.auth.login.accountWindowMs,
  });

  /* ------------------------------ helpers ------------------------------ */

  function commonLocals(extra = {}) {
    return {
      googleEnabled: google.isConfigured(),
      mailConfigured: mail.isConfigured(),
      requireEmailVerification: config.auth.emailVerificationRequired,
      minPasswordLength: config.auth.minPasswordLength,
      maxPasswordLength: config.auth.maxPasswordLength,
      ...extra,
    };
  }

  function renderAuth(res, view, { status = 200, ...locals } = {}) {
    return res.status(status).render(view, commonLocals({
      noindex: true,
      error: null,
      message: null,
      values: {},
      next: '/account',
      ...locals,
    }));
  }

  function renderNotice(res, { title, message, kind = 'info', showResend = false, email = '', link = '', linkLabel = '', status = 200 }) {
    return res.status(status).render('auth/notice', commonLocals({
      noindex: true,
      title,
      heading: String(title).replace(/\s*—\s*فیلمرز\s*$/, ''),
      message,
      kind,
      showResend,
      email,
      link,
      linkLabel,
    }));
  }

  function loginUser(req, res, user) {
    authSession.createSession(db, req, res, user.id);
    users.markLogin(db, user.id);
    csrf.rotateToken(req, res);
  }

  function accountThrottleKey(req, email) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const digest = crypto.createHash('sha256').update(email || '').digest('hex').slice(0, 16);
    return `${ip}|${digest}`;
  }

  function accountPage(req, res, view, locals) {
    return res.render(view, commonLocals({
      noindex: true,
      title: locals.title,
      user: req.user,
      counts: users.userCounts(db, req.user.id),
      section: locals.section,
      error: null,
      message: null,
      ...locals,
    }));
  }

  /* ------------------------------- login ------------------------------- */

  r.get('/login', (req, res) => {
    if (req.user) return res.redirect('/account');
    const messages = {
      verified: 'ایمیل شما تأیید شد. حالا وارد شوید.',
      reset: 'رمز عبور تغییر کرد. با رمز جدید وارد شوید.',
      registered: 'ثبت‌نام انجام شد. حالا وارد شوید.',
      google_conflict: 'این ایمیل قبلاً با رمز عبور ثبت شده است. ابتدا با رمز عبور وارد شوید، سپس از تنظیمات حساب، گوگل را متصل کنید.',
      google_unavailable: 'ورود با گوگل در حال حاضر پیکربندی نشده است.',
    };
    const message = messages[String(req.query.notice || '')] || null;
    const error = req.query.google_error ? 'ورود با گوگل انجام نشد. دوباره تلاش کنید.' : null;
    renderAuth(res, 'auth/login', {
      title: 'ورود — فیلمرز',
      message,
      error,
      values: { email: String(req.query.email || '') },
      next: safeRedirect(req.query.next, '/account'),
      showResend: req.query.unverified === '1',
      emailForResend: String(req.query.email || ''),
    });
  });

  r.post('/login', loginIpLimit, async (req, res) => {
    const emailCheck = validateEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    const next = safeRedirect((req.body && req.body.next), '/account');
    const values = { email: String((req.body && req.body.email) || '') };

    if (!emailCheck.ok || !password || password.length > config.auth.maxPasswordLength) {
      return renderAuth(res, 'auth/login', {
        title: 'ورود — فیلمرز',
        status: 400,
        error: emailCheck.ok ? 'رمز عبور را وارد کنید.' : emailCheck.error,
        values, next,
      });
    }

    const email = emailCheck.email;
    const throttleKey = accountThrottleKey(req, email);
    if (accountLimiter.blocked(throttleKey)) {
      return renderAuth(res, 'auth/login', {
        title: 'ورود — فیلمرز',
        status: 429,
        error: 'تلاش‌های ناموفق زیاد است. چند دقیقه بعد دوباره تلاش کنید.',
        values, next,
      });
    }

    const user = users.findByEmail(db, email);
    let verified = { ok: false, needsRehash: false };
    if (user && user.password_hash) {
      verified = await passwords.verifyPassword(password, user.password_hash);
    } else {
      // Unknown account or Google-only account: equalise timing.
      await passwords.verifyAgainstDummy(password);
    }

    if (!user || !verified.ok) {
      accountLimiter.hit(throttleKey);
      return renderAuth(res, 'auth/login', {
        title: 'ورود — فیلمرز',
        status: 401,
        error: 'ایمیل یا رمز عبور نادرست است.',
        values, next,
      });
    }

    if (user.status === 'disabled') {
      return renderAuth(res, 'auth/login', {
        title: 'ورود — فیلمرز',
        status: 403,
        error: 'این حساب غیرفعال شده است.',
        values, next,
      });
    }

    if (config.auth.emailVerificationRequired && !user.email_verified_at) {
      return renderAuth(res, 'auth/login', {
        title: 'ورود — فیلمرز',
        status: 403,
        error: 'برای ورود، ابتدا ایمیل خود را تأیید کنید.',
        values, next, showResend: true, emailForResend: email,
      });
    }

    if (verified.needsRehash) {
      try {
        users.updatePassword(db, user.id, await passwords.hashPassword(password));
      } catch { /* non-fatal; the old hash still verifies */ }
    }

    accountLimiter.clear(throttleKey);
    loginUser(req, res, user);
    return res.redirect(next);
  });

  r.post('/logout', (req, res) => {
    authSession.destroySession(db, req, res);
    csrf.rotateToken(req, res);
    res.redirect('/');
  });

  /* ----------------------------- registration -------------------------- */

  r.get('/register', (req, res) => {
    if (req.user) return res.redirect('/account');
    renderAuth(res, 'auth/register', {
      title: 'ثبت‌نام — فیلمرز',
      values: {},
      next: safeRedirect(req.query.next, '/account'),
      registrationBlocked: config.auth.emailVerificationRequired && !mail.isConfigured(),
    });
  });

  r.post('/register', registerLimit, async (req, res) => {
    const body = req.body || {};
    const values = {
      display_name: String(body.display_name || ''),
      email: String(body.email || ''),
    };
    const next = safeRedirect(body.next, '/account');

    if (config.auth.emailVerificationRequired && !mail.isConfigured()) {
      return renderAuth(res, 'auth/register', {
        title: 'ثبت‌نام — فیلمرز',
        status: 503,
        error: 'ثبت‌نام موقتاً غیرفعال است: سرویس ارسال ایمیل پیکربندی نشده است.',
        values, next,
        registrationBlocked: true,
      });
    }

    const nameCheck = validateDisplayName(body.display_name);
    const emailCheck = validateEmail(body.email);
    const passCheck = validatePassword(body.password);
    const confirm = String(body.confirm_password || '');

    if (!nameCheck.ok || !emailCheck.ok || !passCheck.ok) {
      return renderAuth(res, 'auth/register', {
        title: 'ثبت‌نام — فیلمرز',
        status: 400,
        error: !nameCheck.ok ? nameCheck.error : (!emailCheck.ok ? emailCheck.error : passCheck.error),
        values, next,
      });
    }
    if (passCheck.password !== confirm) {
      return renderAuth(res, 'auth/register', {
        title: 'ثبت‌نام — فیلمرز',
        status: 400,
        error: 'تکرار رمز عبور با رمز عبور یکسان نیست.',
        values, next,
      });
    }
    if (users.findByEmail(db, emailCheck.email)) {
      return renderAuth(res, 'auth/register', {
        title: 'ثبت‌نام — فیلمرز',
        status: 409,
        error: 'این ایمیل قبلاً ثبت شده است. اگر حساب دارید وارد شوید.',
        values, next,
      });
    }

    let passwordHash;
    try {
      passwordHash = await passwords.hashPassword(passCheck.password);
    } catch {
      return renderAuth(res, 'auth/register', {
        title: 'ثبت‌نام — فیلمرز',
        status: 500,
        error: 'ثبت‌نام انجام نشد. دوباره تلاش کنید.',
        values, next,
      });
    }

    const requireVerify = config.auth.emailVerificationRequired;
    let userId;
    try {
      userId = users.createUser(db, {
        email: emailCheck.email,
        emailOriginal: String(body.email || ''),
        displayName: nameCheck.name,
        passwordHash,
        status: requireVerify ? 'pending' : 'active',
        emailVerified: !requireVerify,
        role: 'user', // the request body can never choose a role
      });
    } catch {
      return renderAuth(res, 'auth/register', {
        title: 'ثبت‌نام — فیلمرز',
        status: 409,
        error: 'این ایمیل قبلاً ثبت شده است.',
        values, next,
      });
    }

    if (!requireVerify) {
      return res.redirect('/login?notice=registered');
    }

    const token = tokens.issueEmailVerification(db, userId);
    const link = `${config.appBaseUrl}/verify-email?token=${encodeURIComponent(token)}`;
    const result = await mail.sendVerificationEmail({
      to: emailCheck.email,
      displayName: nameCheck.name,
      link,
    });

    return res.status(result.sent ? 200 : 202).render('auth/notice', commonLocals({
      noindex: true,
      title: 'تأیید ایمیل — فیلمرز',
      heading: 'تأیید ایمیل',
      kind: result.sent ? 'success' : 'warning',
      message: result.sent
        ? 'حساب ساخته شد. برای فعال‌سازی، پیوند تأیید را از ایمیل خود باز کنید.'
        : 'حساب ساخته شد اما ارسال ایمیل تأیید انجام نشد. لطفاً بعداً از صفحه ورود «ارسال دوباره» را بزنید یا با پشتیبانی تماس بگیرید.',
      showResend: !result.sent,
      email: emailCheck.email,
      link: '', linkLabel: '',
    }));
  });

  /* -------------------------- email verification ----------------------- */

  r.get('/verify-email', (req, res) => {
    const consumed = tokens.consumeEmailVerification(db, String(req.query.token || ''));
    if (consumed) return res.redirect('/login?notice=verified');
    renderNotice(res, {
      title: 'تأیید ایمیل — فیلمرز',
      kind: 'warning',
      message: 'این پیوند تأیید معتبر نیست یا منقضی شده است. می‌توانید درخواست ایمیل تازه بدهید.',
      showResend: true,
    });
  });

  r.post('/verify-email/resend', resendLimit, async (req, res) => {
    const emailCheck = validateEmail(req.body && req.body.email);
    if (emailCheck.ok) {
      const user = users.findByEmail(db, emailCheck.email);
      if (user && !user.email_verified_at && user.status !== 'disabled') {
        const token = tokens.issueEmailVerification(db, user.id);
        const link = `${config.appBaseUrl}/verify-email?token=${encodeURIComponent(token)}`;
        await mail.sendVerificationEmail({ to: user.email, displayName: user.display_name, link });
      }
    }
    // Same response whether or not the account exists.
    renderNotice(res, {
      title: 'ارسال دوباره تأیید ایمیل — فیلمرز',
      kind: 'info',
      message: 'اگر حسابی با این ایمیل وجود داشته باشد و تأیید نشده باشد، پیوند تازه ارسال می‌شود.',
    });
  });

  /* --------------------------- password reset -------------------------- */

  r.get('/forgot-password', (req, res) => {
    renderAuth(res, 'auth/forgot-password', {
      title: 'بازیابی رمز عبور — فیلمرز',
      values: {},
    });
  });

  r.post('/forgot-password', forgotLimit, async (req, res) => {
    const emailCheck = validateEmail(req.body && req.body.email);
    if (emailCheck.ok) {
      const user = users.findByEmail(db, emailCheck.email);
      if (user && user.status === 'active' && user.email_verified_at) {
        const token = tokens.issuePasswordReset(db, user.id);
        const link = `${config.appBaseUrl}/reset-password?token=${encodeURIComponent(token)}`;
        await mail.sendPasswordResetEmail({ to: user.email, displayName: user.display_name, link });
      }
    }
    renderNotice(res, {
      title: 'بازیابی رمز عبور — فیلمرز',
      kind: 'info',
      message: 'اگر حسابی با این ایمیل وجود داشته باشد، پیوند بازیابی رمز برایش ارسال می‌شود.',
    });
  });

  r.get('/reset-password', (req, res) => {
    const token = String(req.query.token || '');
    const row = tokens.findValidResetToken(db, token);
    if (!row) {
      return renderNotice(res, {
        title: 'بازیابی رمز عبور — فیلمرز',
        kind: 'warning',
        message: 'این پیوند بازیابی معتبر نیست یا منقضی شده است. دوباره درخواست دهید.',
        link: '/forgot-password', linkLabel: 'درخواست پیوند تازه',
      });
    }
    renderAuth(res, 'auth/reset-password', {
      title: 'تعیین رمز عبور جدید — فیلمرز',
      token,
      values: {},
    });
  });

  r.post('/reset-password', resetLimit, async (req, res) => {
    const body = req.body || {};
    const token = String(body.token || '');
    const passCheck = validatePassword(body.password);
    const confirm = String(body.confirm_password || '');

    if (!tokens.findValidResetToken(db, token)) {
      return renderNotice(res, {
        title: 'بازیابی رمز عبور — فیلمرز',
        kind: 'warning',
        message: 'این پیوند بازیابی معتبر نیست یا منقضی شده است.',
        link: '/forgot-password', linkLabel: 'درخواست پیوند تازه',
      });
    }
    if (!passCheck.ok) {
      return renderAuth(res, 'auth/reset-password', {
        title: 'تعیین رمز عبور جدید — فیلمرز',
        status: 400, error: passCheck.error, token, values: {},
      });
    }
    if (passCheck.password !== confirm) {
      return renderAuth(res, 'auth/reset-password', {
        title: 'تعیین رمز عبور جدید — فیلمرز',
        status: 400, error: 'تکرار رمز عبور یکسان نیست.', token, values: {},
      });
    }

    let hash;
    try {
      hash = await passwords.hashPassword(passCheck.password);
    } catch {
      return renderAuth(res, 'auth/reset-password', {
        title: 'تعیین رمز عبور جدید — فیلمرز',
        status: 500, error: 'تغییر رمز انجام نشد. دوباره تلاش کنید.', token, values: {},
      });
    }

    const userId = tokens.consumePasswordReset(db, token, hash);
    if (!userId) {
      return renderNotice(res, {
        title: 'بازیابی رمز عبور — فیلمرز',
        kind: 'warning',
        message: 'این پیوند قبلاً استفاده شده یا منقضی شده است.',
        link: '/forgot-password', linkLabel: 'درخواست پیوند تازه',
      });
    }
    authSession.revokeAllSessions(db, userId);
    return res.redirect('/login?notice=reset');
  });

  /* ------------------------------- account ----------------------------- */

  r.get('/account', authSession.requireUser, (req, res) => res.redirect('/account/profile'));

  r.get('/account/profile', authSession.requireUser, (req, res) => {
    const row = users.findById(db, req.user.id);
    accountPage(req, res, 'account/profile', {
      title: 'حساب من — فیلمرز',
      section: 'profile',
      profile: users.normalizeUser(row),
      identities: users.listIdentities(db, req.user.id),
      message: messageFromQuery(req.query),
    });
  });

  r.post('/account/profile', authSession.requireUser, (req, res) => {
    const nameCheck = validateDisplayName(req.body && req.body.display_name);
    if (!nameCheck.ok) {
      return res.status(400).render('account/profile', commonLocals({
        noindex: true,
        title: 'حساب من — فیلمرز',
        section: 'profile',
        profile: users.normalizeUser(users.findById(db, req.user.id)),
        identities: users.listIdentities(db, req.user.id),
        counts: users.userCounts(db, req.user.id),
        error: nameCheck.error,
        message: null,
      }));
    }
    users.updateDisplayName(db, req.user.id, nameCheck.name);
    return res.redirect('/account/profile?notice=profile_saved');
  });

  r.post('/account/password', authSession.requireUser, async (req, res) => {
    const user = users.findById(db, req.user.id);
    const current = String((req.body && req.body.current_password) || '');
    const passCheck = validatePassword(req.body && req.body.password);
    const confirm = String((req.body && req.body.confirm_password) || '');

    function fail(message, status = 400) {
      return res.status(status).render('account/settings', commonLocals({
        noindex: true,
        title: 'تنظیمات حساب — فیلمرز',
        section: 'settings',
        user: req.user,
        counts: users.userCounts(db, req.user.id),
        profile: users.normalizeUser(user),
        identities: users.listIdentities(db, req.user.id),
        error: message,
        message: null,
      }));
    }

    if (user.password_hash) {
      const ok = await passwords.verifyPassword(current, user.password_hash);
      if (!ok.ok) return fail('رمز عبور فعلی نادرست است.');
    }
    if (!passCheck.ok) return fail(passCheck.error);
    if (passCheck.password !== confirm) return fail('تکرار رمز عبور یکسان نیست.');

    const hash = await passwords.hashPassword(passCheck.password);
    users.updatePassword(db, req.user.id, hash);
    // Revoke every old session, then issue a fresh token for this device.
    authSession.revokeAllSessions(db, req.user.id);
    authSession.createSession(db, req, res, req.user.id);
    csrf.rotateToken(req, res);
    return res.redirect('/account/settings?notice=password_changed');
  });

  r.post('/account/logout-all', authSession.requireUser, (req, res) => {
    authSession.revokeAllSessions(db, req.user.id);
    authSession.destroySession(db, req, res);
    csrf.rotateToken(req, res);
    return res.redirect('/login?notice=logged_out_all');
  });

  r.post('/account/delete', authSession.requireUser, async (req, res) => {
    const user = users.findById(db, req.user.id);
    const password = String((req.body && req.body.current_password) || '');
    const confirmEmail = normalizeEmail(req.body && req.body.confirm_email);

    function fail(message) {
      return res.status(400).render('account/settings', commonLocals({
        noindex: true,
        title: 'تنظیمات حساب — فیلمرز',
        section: 'settings',
        user: req.user,
        counts: users.userCounts(db, req.user.id),
        profile: users.normalizeUser(user),
        identities: users.listIdentities(db, req.user.id),
        error: message,
        message: null,
      }));
    }

    if (user.password_hash) {
      const ok = await passwords.verifyPassword(password, user.password_hash);
      if (!ok.ok) return fail('برای حذف حساب، رمز عبور فعلی را درست وارد کنید.');
    } else if (confirmEmail !== user.email) {
      return fail('برای تأیید حذف، ایمیل حساب را دقیقاً وارد کنید.');
    }

    users.deleteUser(db, user.id);
    authSession.destroySession(db, req, res);
    csrf.rotateToken(req, res);
    return res.redirect('/?account=deleted');
  });

  r.get('/account/favorites', authSession.requireUser, (req, res) => {
    accountPage(req, res, 'account/list', {
      title: 'علاقه‌مندی‌ها — فیلمرز',
      section: 'favorites',
      heading: 'علاقه‌مندی‌ها',
      emptyText: 'هنوز فیلم یا سریالی را به علاقه‌مندی‌ها اضافه نکرده‌اید.',
      items: lists.listFor(db, 'favorites', req.user.id),
      listName: 'favorites',
      message: messageFromQuery(req.query),
    });
  });

  r.get('/account/watchlist', authSession.requireUser, (req, res) => {
    accountPage(req, res, 'account/list', {
      title: 'لیست تماشا — فیلمرز',
      section: 'watchlist',
      heading: 'لیست تماشا',
      emptyText: 'هنوز چیزی برای تماشای بعدی ذخیره نکرده‌اید.',
      items: lists.listFor(db, 'watchlist', req.user.id),
      listName: 'watchlist',
      message: messageFromQuery(req.query),
    });
  });

  r.get('/account/history', authSession.requireUser, (req, res) => {
    accountPage(req, res, 'account/history', {
      title: 'تاریخچه تماشا — فیلمرز',
      section: 'history',
      history: lists.historyFor(db, req.user.id),
      continueWatching: lists.continueWatching(db, req.user.id),
      message: messageFromQuery(req.query),
    });
  });

  r.get('/account/settings', authSession.requireUser, (req, res) => {
    const row = users.findById(db, req.user.id);
    accountPage(req, res, 'account/settings', {
      title: 'تنظیمات حساب — فیلمرز',
      section: 'settings',
      profile: users.normalizeUser(row),
      identities: users.listIdentities(db, req.user.id),
      message: messageFromQuery(req.query),
      googleEnabled: google.isConfigured(),
    });
  });

  /* ------------------------------ account API -------------------------- */

  function toggleListEndpoint(list) {
    return (req, res) => {
      const type = String((req.body && req.body.type) || '');
      const id = asInt(req.body && req.body.id, 1);
      if (!lists.TYPES.has(type) || id === null) {
        return res.status(400).json({ ok: false, error: 'BAD_REQUEST' });
      }
      const result = lists.toggle(db, list, req.user.id, type, id);
      if (!result) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      return res.json({ ok: true, ...result });
    };
  }

  r.post('/api/favorites/toggle', authSession.requireUserApi, toggleListEndpoint('favorites'));
  r.post('/api/watchlist/toggle', authSession.requireUserApi, toggleListEndpoint('watchlist'));

  /**
   * Real progress events from a player. The current external-player flow does
   * not call this yet; when a player is integrated it can POST
   * { item_type, item_id, episode_id?, position, duration } here.
   */
  r.post('/api/watch/progress', authSession.requireUserApi, (req, res) => {
    const body = req.body || {};
    const type = String(body.item_type || '');
    const itemId = asInt(body.item_id, 1);
    const episodeId = body.episode_id == null ? null : asInt(body.episode_id, 1);
    const position = Number(body.position);
    const duration = Number(body.duration);
    if (!lists.TYPES.has(type) || itemId === null) {
      return res.status(400).json({ ok: false, error: 'BAD_REQUEST' });
    }
    const ok = lists.recordWatch(db, req.user.id, {
      itemType: type,
      itemId,
      episodeId,
      position: Number.isFinite(position) ? position : null,
      duration: Number.isFinite(duration) ? duration : null,
    });
    if (!ok) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true });
  });

  /* -------------------------------- Google ----------------------------- */

  r.get('/auth/google', (req, res) => {
    if (!google.isConfigured()) return res.status(404).type('text/plain; charset=utf-8').send('Google Sign-In is not configured.');
    if (req.user) return res.redirect('/account');
    const flow = google.startFlow(db, { redirectAfter: safeRedirect(req.query.next, '/account') });
    if (!flow) return res.redirect('/login?notice=google_unavailable');
    return res.redirect(flow.url);
  });

  r.post('/account/google/link', authSession.requireUser, async (req, res) => {
    if (!google.isConfigured()) return res.status(404).type('text/plain; charset=utf-8').send('Google Sign-In is not configured.');
    const user = users.findById(db, req.user.id);
    if (user.password_hash) {
      const ok = await passwords.verifyPassword(
        String((req.body && req.body.current_password) || ''), user.password_hash);
      if (!ok.ok) {
        return res.status(400).render('account/settings', commonLocals({
          noindex: true,
          title: 'تنظیمات حساب — فیلمرز',
          section: 'settings',
          user: req.user,
          counts: users.userCounts(db, req.user.id),
          profile: users.normalizeUser(user),
          identities: users.listIdentities(db, req.user.id),
          error: 'برای اتصال گوگل، رمز عبور فعلی را درست وارد کنید.',
          message: null,
        }));
      }
    }
    const flow = google.startFlow(db, { redirectAfter: '/account/settings', linkUserId: user.id });
    if (!flow) return res.redirect('/account/settings?notice=google_unavailable');
    return res.redirect(flow.url);
  });

  r.post('/account/google/disconnect', authSession.requireUser, async (req, res) => {
    const user = users.findById(db, req.user.id);
    const identities = users.listIdentities(db, user.id);
    const googleIdentity = identities.find((i) => i.provider === 'google');
    if (!googleIdentity) return res.redirect('/account/settings?notice=google_not_linked');

    const otherMethods = Boolean(user.password_hash)
      || identities.some((i) => i.provider !== 'google');
    if (!otherMethods) {
      return res.status(400).render('account/settings', commonLocals({
        noindex: true,
        title: 'تنظیمات حساب — فیلمرز',
        section: 'settings',
        user: req.user,
        counts: users.userCounts(db, req.user.id),
        profile: users.normalizeUser(user),
        identities,
        error: 'تا زمانی که روش ورود دیگری (رمز عبور) ندارید، نمی‌توانید گوگل را قطع کنید.',
        message: null,
      }));
    }
    if (user.password_hash) {
      const ok = await passwords.verifyPassword(
        String((req.body && req.body.current_password) || ''), user.password_hash);
      if (!ok.ok) {
        return res.status(400).render('account/settings', commonLocals({
          noindex: true,
          title: 'تنظیمات حساب — فیلمرز',
          section: 'settings',
          user: req.user,
          counts: users.userCounts(db, req.user.id),
          profile: users.normalizeUser(user),
          identities,
          error: 'برای قطع اتصال گوگل، رمز عبور فعلی را درست وارد کنید.',
          message: null,
        }));
      }
    }

    users.removeIdentity(db, user.id, 'google');
    return res.redirect('/account/settings?notice=google_disconnected');
  });

  r.get('/auth/google/callback', async (req, res) => {
    if (!google.isConfigured()) return res.redirect('/login?notice=google_unavailable');
    if (req.query.error) {
      console.error('[auth][google] provider returned error:',
        String(req.query.error).slice(0, 80),
        String(req.query.error_description || '').slice(0, 160));
      return res.redirect('/login?google_error=1');
    }

    let result;
    try {
      result = await google.exchange(db, {
        code: String(req.query.code || ''),
        state: String(req.query.state || ''),
      });
    } catch (err) {
      console.error('[auth][google] callback exchange failed:', (err && err.message) || 'unknown');
      return res.redirect('/login?google_error=1');
    }

    const { payload, stateRow } = result;
    const email = normalizeEmail(payload.email);
    const displayName = validateDisplayName(payload.name || email.split('@')[0]);
    const avatar = typeof payload.picture === 'string' && /^https:\/\//.test(payload.picture)
      ? payload.picture : '';

    try {
      // Linking an already signed-in account: the browser must still hold the
      // same account session that initiated the flow.
      if (stateRow.link_user_id) {
        if (!req.user || req.user.id !== stateRow.link_user_id) {
          return res.redirect('/login?google_error=1');
        }
        const existing = users.findIdentity(db, google.PROVIDER, payload.sub);
        if (existing && existing.user_id !== req.user.id) {
          return res.redirect('/account/settings?notice=google_used');
        }
        if (!existing) {
          users.addIdentity(db, {
            userId: req.user.id,
            provider: google.PROVIDER,
            subject: payload.sub,
            email,
          });
        }
        if (avatar && !req.user.avatarUrl) users.updateAvatar(db, req.user.id, avatar);
        return res.redirect('/account/settings?notice=google_linked');
      }

      const identity = users.findIdentity(db, google.PROVIDER, payload.sub);
      if (identity) {
        const user = users.findById(db, identity.user_id);
        if (!user || user.status !== 'active') return res.redirect('/login?google_error=1');
        loginUser(req, res, user);
        return res.redirect(safeRedirect(stateRow.redirect_after, '/account'));
      }

      // Never silently merge by email: the existing account must sign in
      // first and explicitly link Google from settings.
      if (users.findByEmail(db, email)) {
        return res.redirect('/login?notice=google_conflict');
      }

      let userId;
      withTransaction(db, () => {
        userId = users.createUser(db, {
          email,
          emailOriginal: email,
          displayName: displayName.ok ? displayName.name : email.split('@')[0],
          passwordHash: '',
          status: 'active',
          emailVerified: true,
          role: 'user',
          avatarUrl: avatar,
        });
        users.addIdentity(db, {
          userId,
          provider: google.PROVIDER,
          subject: payload.sub,
          email,
        });
      });

      const user = users.findById(db, userId);
      loginUser(req, res, user);
      return res.redirect(safeRedirect(stateRow.redirect_after, '/account'));
    } catch (err) {
      console.error('[auth][google] callback failed:', (err && err.message) || 'unknown');
      return res.redirect('/login?google_error=1');
    }
  });

  app.use(r);
}

function messageFromQuery(query) {
  const map = {
    profile_saved: 'نام نمایشی ذخیره شد.',
    password_changed: 'رمز عبور تغییر کرد و نشست‌های دیگر بسته شدند.',
    google_linked: 'حساب گوگل متصل شد.',
    google_disconnected: 'اتصال گوگل قطع شد.',
    google_used: 'این حساب گوگل به کاربر دیگری متصل است.',
    google_not_linked: 'حساب گوگل متصل نیست.',
    google_unavailable: 'ورود با گوگل پیکربندی نشده است.',
  };
  return map[String((query && query.notice) || '')] || null;
}

module.exports = { authRoutes };
