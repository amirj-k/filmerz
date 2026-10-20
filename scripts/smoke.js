'use strict';
/* scripts/smoke.js — live admin flow: login CSRF, session, dashboard, guard */
const BASE = 'http://127.0.0.1:3000';

(async () => {
  const g = await fetch(BASE + '/admin/login');
  const html = await g.text();
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
  const cookie = g.headers.get('set-cookie').split(';')[0];
  console.log('login page:', g.status, '| csrf extracted');

  const p = await fetch(BASE + '/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ _csrf: csrf, username: 'admin', password: 'Filmz-Admin-2026!' }),
    redirect: 'manual',
  });
  console.log('login POST:', p.status, '->', p.headers.get('location'));
  const sid = (p.headers.get('set-cookie') || '').split(';')[0];

  const d = await fetch(BASE + '/admin', { headers: { cookie: sid } });
  const dh = await d.text();
  console.log('dashboard:', d.status, dh.length + 'B', '| stats:', dh.includes('لینک با'));

  const bad = await fetch(BASE + '/admin', { redirect: 'manual' });
  console.log('no-session /admin:', bad.status, '->', bad.headers.get('location'));

  const wrong = await fetch(BASE + '/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ _csrf: csrf, username: 'admin', password: 'wrong-pass' }),
  });
  console.log('wrong password:', wrong.status);
})().catch((e) => console.log('ERR', e.message));
