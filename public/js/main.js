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
      if (el) { el.disabled = on; if (on) { el.dataset.orig = el.textContent; el.textContent = label; } else if (el.dataset.orig) { el.textContent = el.dataset.orig; } }
    }

    function resolve(kind, el) {
      busy(true, 'در حال دریافت لینک تازه…', el);
      setNote('در حال دریافت لینک تازه از منبع…');
      fetch('/api/movies/' + id + '/resolve?type=' + kind)
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (res.ok && res.d.url) {
            setNote('لینک تازه آماده است — در حال انتقال…');
            window.location.href = res.d.url;
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
})();
