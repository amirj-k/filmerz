'use strict';
const nodemailer = require('nodemailer');
const config = require('../config');

/**
 * Small transactional mail service. Configuration comes exclusively from the
 * environment (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/MAIL_FROM). No real
 * credentials live in the repository, and tokens are never logged in
 * production.
 */

let transporter = null;

function getTransport() {
  if (!config.mailConfigured) return null;
  if (transporter) return transporter;
  const options = {
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    pool: true,
    maxConnections: 2,
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 12000,
  };
  if (config.mail.user) {
    options.auth = { user: config.mail.user, pass: config.mail.pass };
  }
  transporter = nodemailer.createTransport(options);
  return transporter;
}

function isConfigured() {
  return config.mailConfigured;
}

/**
 * Send one message. Returns { sent, reason } — callers must never claim an
 * email was delivered unless `sent` is true.
 */
async function sendMail({ to, subject, text, html }) {
  const tx = getTransport();
  if (!tx) return { sent: false, reason: 'not_configured' };
  try {
    const info = await tx.sendMail({
      from: config.mail.from,
      to,
      subject,
      text,
      html,
      replyTo: config.mail.replyTo || undefined,
      headers: { 'X-Auto-Response-Suppress': 'All' },
    });
    return { sent: true, id: info && info.messageId ? info.messageId : '' };
  } catch (err) {
    // Never include the recipient or credentials in the log line.
    console.error('[mail] delivery failed:', (err && err.code) || 'SMTP_ERROR');
    return { sent: false, reason: 'delivery_failed' };
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title, bodyHtml) {
  return `<!doctype html><html dir="rtl" lang="fa"><body style="margin:0;background:#0b0b0f;color:#f5f5f7;font-family:Tahoma,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>
    <div style="background:#16161c;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:22px;line-height:1.9;font-size:14px">
      ${bodyHtml}
    </div>
    <p style="color:#86868b;font-size:12px;margin-top:18px">فیلمرز — اگر این درخواست از شما نبود، این پیام را نادیده بگیرید.</p>
  </div></body></html>`;
}

function button(href, label) {
  // URL is generated server-side from APP_BASE_URL, never user input.
  return `<p style="margin:22px 0"><a href="${escapeHtml(href)}" style="display:inline-block;background:#2997ff;color:#fff;text-decoration:none;border-radius:999px;padding:11px 22px;font-weight:700">${escapeHtml(label)}</a></p>`;
}

function devLog(kind, link) {
  if (config.isProduction) return;
  // Development only: make the flow testable without an SMTP server.
  console.log(`[mail:dev] ${kind} link → ${link}`);
}

async function sendVerificationEmail({ to, displayName, link }) {
  const subject = 'تأیید ایمیل حساب فیلمرز';
  const text = `${displayName ? displayName + ' عزیز،\n\n' : ''}برای تأیید ایمیل حساب فیلمرز روی این پیوند بزنید:\n${link}\n\nاین پیوند ۲۴ ساعت معتبر است.`;
  const html = layout('تأیید ایمیل', `
    <p>${displayName ? escapeHtml(displayName) + ' عزیز،' : 'سلام،'}</p>
    <p>برای فعال‌سازی حساب فیلمرز ایمیل خود را تأیید کنید.</p>
    ${button(link, 'تأیید ایمیل')}
    <p style="color:#a1a1a6;font-size:12px;word-break:break-all">${escapeHtml(link)}</p>
    <p style="color:#a1a1a6;font-size:12px">این پیوند ۲۴ ساعت معتبر است و فقط یک بار استفاده می‌شود.</p>
  `);
  const result = await sendMail({ to, subject, text, html });
  if (!result.sent && result.reason === 'not_configured') devLog('verification', link);
  return result;
}

async function sendPasswordResetEmail({ to, displayName, link }) {
  const subject = 'بازیابی رمز عبور فیلمرز';
  const text = `${displayName ? displayName + ' عزیز،\n\n' : ''}برای تعیین رمز عبور جدید روی این پیوند بزنید:\n${link}\n\nاین پیوند ۳۰ دقیقه معتبر است و فقط یک بار استفاده می‌شود.`;
  const html = layout('بازیابی رمز عبور', `
    <p>${displayName ? escapeHtml(displayName) + ' عزیز،' : 'سلام،'}</p>
    <p>درخواست بازیابی رمز عبور برای حساب فیلمرز ثبت شد.</p>
    ${button(link, 'تعیین رمز عبور جدید')}
    <p style="color:#a1a1a6;font-size:12px;word-break:break-all">${escapeHtml(link)}</p>
    <p style="color:#a1a1a6;font-size:12px">این پیوند ۳۰ دقیقه معتبر است. اگر درخواست از شما نبود، رمز فعلی شما تغییر نمی‌کند.</p>
  `);
  const result = await sendMail({ to, subject, text, html });
  if (!result.sent && result.reason === 'not_configured') devLog('password-reset', link);
  return result;
}

module.exports = {
  isConfigured,
  sendMail,
  sendVerificationEmail,
  sendPasswordResetEmail,
};
