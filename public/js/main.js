/* filmz — main.js (theme, header suggest, resolve buttons) */
(function () {
  'use strict';

  /* ---------- theme (runs early via inline nonce boot too) ---------- */
  function applyTheme(t) {
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
  }
  window.filmerzSetTheme = function (t) {
    localStorage.setItem('fmz-theme', t);
    applyTheme(t);
  };

  var btn = document.querySelector('[data-theme-toggle]');
  if (btn) {
    btn.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme')
        || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      window.filmerzSetTheme(cur === 'dark' ? 'light' : 'dark');
    });
  }

  /* ---------- mobile navigation ---------- */
  var navToggle = document.querySelector('[data-nav-toggle]');
  var mainNav = document.getElementById('main-nav');
  if (navToggle && mainNav) {
    var setNav = function (open) {
      mainNav.classList.toggle('open', open);
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      navToggle.setAttribute('aria-label', open ? 'بستن منو' : 'باز کردن منو');
    };
    navToggle.addEventListener('click', function (e) {
      e.stopPropagation();
      setNav(!mainNav.classList.contains('open'));
    });
    mainNav.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('a')) setNav(false);
    });
    document.addEventListener('click', function (e) {
      if (mainNav.classList.contains('open')
        && !mainNav.contains(e.target)
        && !navToggle.contains(e.target)) setNav(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setNav(false);
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 820) setNav(false);
    });
  }

  /* broken posters → placeholder (CSP forbids inline handlers) */
  document.querySelectorAll('img.poster').forEach(function (img) {
    img.addEventListener('error', function () {
      var div = document.createElement('div');
      div.className = 'no-poster';
      div.textContent = '🎬';
      img.replaceWith(div);
    }, { once: true });
  });

  /* ---------- header autocomplete ---------- */
  var box = document.querySelector('.searchbox');
  if (box) {
    var input = box.querySelector('input');
    var panel = box.querySelector('.suggest');
    var timer = null, items = [], sel = -1;

    function render() {
      panel.innerHTML = '';
      if (!items.length) { panel.classList.remove('open'); return; }
      items.forEach(function (m, i) {
        var a = document.createElement('a');
        a.href = m.href;
        if (i === sel) a.className = 'sel';
        if (m.poster) {
          var img = document.createElement('img');
          img.src = m.poster; img.alt = ''; img.loading = 'lazy';
          a.appendChild(img);
        }
        var wrap = document.createElement('span');
        var t = document.createElement('span'); t.className = 't';
        t.textContent = m.title_fa || m.title_en || 'بدون عنوان';
        wrap.appendChild(t);
        if (m.title_fa && m.title_en) {
          var en = document.createElement('span'); en.className = 'y';
          en.textContent = ' ' + m.title_en;
          wrap.appendChild(en);
        }
        if (m.year) {
          var y = document.createElement('span'); y.className = 'y';
          y.textContent = ' (' + m.year + ')';
          wrap.appendChild(y);
        }
        if (m.kind === 'series') {
          var k = document.createElement('span'); k.className = 'k';
          k.textContent = 'سریال';
          wrap.appendChild(k);
        }
        a.appendChild(wrap);
        panel.appendChild(a);
      });
      panel.classList.add('open');
    }

    function close() { panel.classList.remove('open'); sel = -1; }

    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2) { close(); return; }
      timer = setTimeout(function () {
        fetch('/api/suggest?q=' + encodeURIComponent(q))
          .then(function (r) { return r.ok ? r.json() : { items: [] }; })
          .then(function (d) { items = d.items || []; sel = -1; render(); })
          .catch(function () { close(); });
      }, 160);
    });

    input.addEventListener('keydown', function (e) {
      if (!panel.classList.contains('open')) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
      else if (e.key === 'Enter' && sel >= 0 && items[sel]) { e.preventDefault(); location.href = items[sel].href; }
      else if (e.key === 'Escape') { close(); }
    });

    document.addEventListener('click', function (e) {
      if (!box.contains(e.target)) close();
    });
  }

  /* ---------- open a freshly resolved link (VLC on mobile) ---------- */
  function isIOSDevice() {
    var ua = navigator.userAgent || '';
    return /iPhone|iPad|iPod/i.test(ua)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function isAndroidDevice() {
    return /Android/i.test(navigator.userAgent || '');
  }
  function vlcDeepLink(d) {
    if (isIOSDevice()) return d.vlcIos || d.vlc || '';
    if (isAndroidDevice()) return d.vlcAndroid || d.vlc || '';
    return '';
  }
  function openResolved(d, kind, noteEl, noteFn) {
    var note = noteFn || function (msg, isErr) { liveNote(noteEl, msg, isErr); };
    if (kind === 'play') {
      var deep = vlcDeepLink(d);
      if (deep) {
        note('در حال باز کردن VLC…', false);
        window.location.href = deep;
        // If the app is not installed the custom scheme silently does nothing;
        // leave the user a clear fallback instead of a dead button.
        var timer = setTimeout(function () {
          note('اگر VLC باز نشد، نصب بودن آن را بررسی کنید یا از دکمه دانلود استفاده کنید.', true);
        }, 2500);
        window.addEventListener('pagehide', function () { clearTimeout(timer); }, { once: true });
        return;
      }
    }
    note('لینک تازه آماده است — در حال انتقال…', false);
    window.location.href = d.url;
  }

  /* ---------- movie page: play / download buttons ---------- */
  var watch = document.querySelector('[data-movie-id]');
  if (watch) {
    var id = watch.getAttribute('data-movie-id');
    var note = watch.querySelector('.note');
    var playBtn = watch.querySelector('[data-kind="play"]');
    var dlBtn = watch.querySelector('[data-kind="download"]');

    function setNote(msg, isErr) {
      if (!note) return;
      note.textContent = msg;
      note.classList.toggle('err', Boolean(isErr));
    }

    function busy(on, label, el) {
      if (!el) return;
      el.disabled = on;
      el.classList.toggle('loading', on);
      el.setAttribute('aria-busy', on ? 'true' : 'false');
    }

    function resolve(kind, el) {
      busy(true, 'در حال دریافت لینک تازه…', el);
      setNote('در حال دریافت لینک تازه از منبع…');
      fetch('/api/movies/' + id + '/resolve?type=' + kind)
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (res.ok && res.d.url) {
            openResolved(res.d, kind, note, setNote);
          } else {
            setNote((res.d && res.d.message) || 'دریافت لینک ناموفق بود.', true);
          }
        })
        .catch(function () { setNote('خطای شبکه — دوباره تلاش کنید.', true); })
        .finally(function () { busy(false, '', el); });
    }

    if (playBtn) playBtn.addEventListener('click', function () { resolve('play', playBtn); });
    if (dlBtn) dlBtn.addEventListener('click', function () { resolve('download', dlBtn); });
  }

  /* ---------- shared resolve feedback ---------- */
  function liveNote(el, msg, isErr) {
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('err', Boolean(isErr));
  }

  function startBusy(el) {
    el.disabled = true;
    el.classList.add('loading');
    el.setAttribute('aria-busy', 'true');
  }

  function endBusy(el) {
    el.disabled = false;
    el.classList.remove('loading');
    el.setAttribute('aria-busy', 'false');
  }

  function bindResolve(selector, buildUrl, noteEl) {
    var buttons = document.querySelectorAll(selector);
    if (!buttons.length) return;
    buttons.forEach(function (el) {
      el.addEventListener('click', function () {
        var kind = el.getAttribute('data-kind') === 'download' ? 'download' : 'play';
        startBusy(el);
        liveNote(noteEl, 'در حال دریافت لینک تازه از منبع…');
        fetch(buildUrl(el, kind))
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (res) {
            if (res.ok && res.d.url) {
              openResolved(res.d, kind, noteEl);
            } else {
              liveNote(noteEl, (res.d && res.d.message) || 'دریافت لینک ناموفق بود.', true);
            }
          })
          .catch(function () { liveNote(noteEl, 'خطای شبکه — دوباره تلاش کنید.', true); })
          .finally(function () { endBusy(el); });
      });
    });
  }

  /* ---------- series episode: exact per-episode link buttons ---------- */
  bindResolve('[data-ep-resolve]', function (el, kind) {
    var u = '/api/episodes/' + encodeURIComponent(el.getAttribute('data-episode-id')) + '/resolve?type=' + kind;
    var linkId = el.getAttribute('data-link-id');
    if (linkId) u += '&link=' + encodeURIComponent(linkId);
    return u;
  }, document.querySelector('[data-ep-note]'));

  /* ---------- movie page: per-link buttons ---------- */
  bindResolve('[data-movie-link-resolve]', function (el, kind) {
    var u = '/api/movies/' + encodeURIComponent(el.getAttribute('data-movie-id')) + '/resolve?type=' + kind;
    var linkId = el.getAttribute('data-link-id');
    if (linkId) u += '&link=' + encodeURIComponent(linkId);
    return u;
  }, document.querySelector('[data-movie-note]'));

  /* ---------- نشان‌ها (wishlist) ---------- */
  var wishlistMeta = document.querySelector('meta[name="wishlist-token"]');
  var toastEl = document.querySelector('[data-toast]');
  var toastTimer = null;

  function showToast(msg, isErr) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.toggle('err', Boolean(isErr));
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2400);
  }

  function updateWishlistCount(count) {
    var el = document.querySelector('[data-wishlist-count]');
    if (!el) return;
    el.textContent = String(count);
    el.classList.toggle('hidden', !count);
  }

  document.querySelectorAll('[data-wishlist-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var token = wishlistMeta ? wishlistMeta.getAttribute('content') : '';
      var type = btn.getAttribute('data-type');
      var id = btn.getAttribute('data-id');
      btn.disabled = true;
      fetch('/api/wishlist/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ type: type, id: id }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok || !res.d.ok) {
            showToast('ذخیره نشد — دوباره تلاش کنید.', true);
            return;
          }
          var active = Boolean(res.d.active);
          updateWishlistCount(res.d.count);
          btn.classList.toggle('active', active);
          btn.setAttribute('aria-pressed', active ? 'true' : 'false');
          var label = btn.querySelector('[data-wishlist-label]');
          if (label) label.textContent = active ? 'در نشان‌ها' : 'افزودن به نشان‌ها';

          if (btn.hasAttribute('data-wishlist-remove') && !active) {
            var row = btn.closest('[data-wishlist-row]');
            if (row) {
              row.classList.add('is-removing');
              setTimeout(function () {
                row.remove();
                var empty = document.querySelector('[data-wishlist-empty]');
                if (empty && !document.querySelector('[data-wishlist-row]')) empty.classList.remove('hidden');
              }, 180);
            }
            showToast('از نشان‌ها حذف شد');
          } else {
            showToast(active ? 'به نشان‌ها اضافه شد' : 'از نشان‌ها حذف شد');
          }
        })
        .catch(function () { showToast('خطای شبکه — دوباره تلاش کنید.', true); })
        .finally(function () { btn.disabled = false; });
    });
  });

  /* ---------- episode grid keyboard navigation ---------- */
  var grid = document.querySelector('.episode-grid');
  if (grid) {
    var cells = Array.prototype.slice.call(grid.querySelectorAll('.episode-btn'));
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function columns() {
      var cols = window.getComputedStyle(grid).gridTemplateColumns;
      return Math.max(1, cols ? cols.split(' ').length : 1);
    }

    grid.addEventListener('keydown', function (e) {
      var idx = cells.indexOf(document.activeElement);
      if (idx < 0) return;
      var next = -1;
      if (e.key === 'ArrowLeft') next = idx + 1;
      else if (e.key === 'ArrowRight') next = idx - 1;
      else if (e.key === 'ArrowDown') next = idx + columns();
      else if (e.key === 'ArrowUp') next = idx - columns();
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = cells.length - 1;
      if (next < 0 || next >= cells.length) return;
      e.preventDefault();
      cells[next].focus({ preventScroll: true });
      cells[next].scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    });
  }
})();
