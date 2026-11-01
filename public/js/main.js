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
    var requestSeq = 0, inflight = null;
    var DEBOUNCE_MS = 450;
    var MIN_QUERY_LENGTH = 2;

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

    function abortInflight() {
      if (inflight) {
        inflight.abort();
        inflight = null;
      }
    }

    // Invalidate any queued/in-flight response and stop the debounce timer.
    function cancelSearch() {
      requestSeq += 1;
      clearTimeout(timer);
      timer = null;
      abortInflight();
    }

    function close() {
      cancelSearch();
      panel.classList.remove('open');
      sel = -1;
    }

    input.addEventListener('input', function () {
      cancelSearch();
      sel = -1; // don't let Enter jump to an old highlighted suggestion
      var q = input.value.trim();
      if (q.length < MIN_QUERY_LENGTH) {
        items = [];
        close();
        return;
      }
      timer = setTimeout(function () {
        timer = null;
        var seq = requestSeq;
        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        inflight = controller;
        var options = controller ? { signal: controller.signal } : undefined;
        fetch('/api/suggest?q=' + encodeURIComponent(q), options)
          .then(function (r) { return r.ok ? r.json() : { items: [] }; })
          .then(function (d) {
            if (seq !== requestSeq) return; // a newer search already won
            items = d.items || [];
            sel = -1;
            render();
          })
          .catch(function (err) {
            if (err && err.name === 'AbortError') return;
            if (seq !== requestSeq) return;
            items = [];
            close();
          })
          .finally(function () {
            if (inflight === controller) inflight = null;
          });
      }, DEBOUNCE_MS);
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
  function episodeResolveUrl(el, kind) {
    var u = '/api/episodes/' + encodeURIComponent(el.getAttribute('data-episode-id')) + '/resolve?type=' + kind;
    var linkId = el.getAttribute('data-link-id');
    if (linkId) u += '&link=' + encodeURIComponent(linkId);
    return u;
  }
  bindResolve('[data-ep-resolve]', episodeResolveUrl, document.querySelector('[data-ep-note]'));

  /* ---------- series page: client-side season / episode switching ---------- */
  var seriesDataEl = document.getElementById('series-episode-data');
  var seasonScroller = document.querySelector('.season-scroller');
  var workbench = document.querySelector('.episode-workbench');

  if (seriesDataEl && seasonScroller && workbench) {
    var episodeData = [];
    try { episodeData = JSON.parse(seriesDataEl.textContent || '[]'); } catch (err) { episodeData = []; }

    var seasonByNo = {};
    episodeData.forEach(function (season) { seasonByNo[String(season[0])] = season; });

    var seasonPills = Array.prototype.slice.call(seasonScroller.querySelectorAll('.season-pill'));
    var gridHost = workbench.querySelector('[data-episode-grid-host]');
    var moreLabel = document.querySelector('#episodes .section-head .more');
    var activePill = seasonScroller.querySelector('.season-pill.active');
    var currentSeasonNo = activePill ? Number(activePill.getAttribute('data-season')) : null;
    var PLAY_ICON = '<svg class="ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5-11-6.5z"/></svg>';
    var DOWNLOAD_ICON = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3a1 1 0 0 1 1 1v9.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.4L11 13.6V4a1 1 0 0 1 1-1zM5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z"/></svg>';

    function updateUrl(seasonNo, episodeNo) {
      if (!window.history || !window.history.replaceState) return;
      var url = window.location.pathname + '?season=' + encodeURIComponent(seasonNo);
      if (episodeNo != null) url += '&episode=' + encodeURIComponent(episodeNo);
      window.history.replaceState(null, '', url);
    }

    function setActiveSeason(seasonNo) {
      seasonPills.forEach(function (pill) {
        var on = Number(pill.getAttribute('data-season')) === seasonNo;
        pill.classList.toggle('active', on);
        if (on) pill.setAttribute('aria-current', 'page');
        else pill.removeAttribute('aria-current');
      });
    }

    function renderEpisodes(seasonNo, episodes) {
      gridHost.innerHTML = '';
      if (!episodes.length) {
        var empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'برای این فصل قسمتی ثبت نشده است.';
        gridHost.appendChild(empty);
        return;
      }
      var grid = document.createElement('div');
      grid.className = 'episode-grid';
      grid.setAttribute('role', 'list');
      grid.setAttribute('aria-label', 'قسمت‌های فصل ' + seasonNo);
      episodes.forEach(function (ep, i) {
        var a = document.createElement('a');
        a.className = 'episode-btn';
        a.setAttribute('role', 'listitem');
        a.href = window.location.pathname + '?season=' + seasonNo + '&episode=' + ep[1];
        a.setAttribute('aria-label', 'فصل ' + seasonNo + ' قسمت ' + ep[1]);
        a.setAttribute('data-episode-index', String(i));
        a.setAttribute('data-episode-no', String(ep[1]));
        var n = document.createElement('span');
        n.className = 'n';
        n.textContent = String(ep[1]);
        a.appendChild(n);
        grid.appendChild(a);
      });
      gridHost.appendChild(grid);
    }

    function markActiveEpisode(episodeNo) {
      gridHost.querySelectorAll('.episode-btn').forEach(function (btn) {
        var on = Number(btn.getAttribute('data-episode-no')) === episodeNo;
        btn.classList.toggle('active', on);
        if (on) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
      });
    }

    function makeResolveButton(kind, label, icon, seasonNo, ep, linkId, quality) {
      var btn = document.createElement('button');
      btn.className = 'btn small' + (kind === 'download' ? ' secondary' : '');
      btn.type = 'button';
      btn.setAttribute('data-ep-resolve', '');
      btn.setAttribute('data-kind', kind);
      btn.setAttribute('data-episode-id', String(ep[0]));
      btn.setAttribute('data-link-id', String(linkId));
      btn.setAttribute('aria-label',
        (kind === 'play' ? 'پخش' : 'دانلود') + ' فصل ' + seasonNo + ' قسمت ' + ep[1] + ' با کیفیت ' + quality);
      btn.innerHTML = icon + ' ' + label;
      return btn;
    }

    function renderPanel(seasonNo, ep, index, total) {
      var old = document.getElementById('episode-panel');
      if (old) old.remove();

      var aside = document.createElement('aside');
      aside.className = 'episode-panel';
      aside.id = 'episode-panel';
      aside.setAttribute('aria-labelledby', 'episode-panel-title');

      var head = document.createElement('div');
      head.className = 'episode-panel-head';
      var kicker = document.createElement('span');
      kicker.className = 'episode-kicker';
      kicker.textContent = 'فصل ' + seasonNo + ' · قسمت ' + ep[1];
      var title = document.createElement('h3');
      title.className = 'episode-panel-title';
      title.id = 'episode-panel-title';
      title.textContent = 'پخش و دانلود';
      var sub = document.createElement('p');
      sub.className = 'episode-panel-sub';
      sub.textContent = (index + 1) + ' از ' + total;
      head.appendChild(kicker);
      head.appendChild(title);
      head.appendChild(sub);
      aside.appendChild(head);

      var body = document.createElement('div');
      body.className = 'episode-panel-body';
      var links = ep[2] || [];

      if (!links.length) {
        var empty = document.createElement('p');
        empty.className = 'episode-empty';
        empty.textContent = 'برای این قسمت گزینه‌ای ثبت نشده است.';
        body.appendChild(empty);
      } else {
        var groups = [];
        links.forEach(function (l) {
          var key = l[1] || l[2] || 'گزینه';
          var group = null;
          for (var i = 0; i < groups.length; i++) {
            if (groups[i].key === key) { group = groups[i]; break; }
          }
          if (!group) { group = { key: key, items: [] }; groups.push(group); }
          group.items.push(l);
        });

        groups.forEach(function (group) {
          var section = document.createElement('section');
          section.className = 'quality-group';
          section.setAttribute('aria-label', 'کیفیت ' + group.key);
          var qHead = document.createElement('div');
          qHead.className = 'quality-head';
          var badge = document.createElement('span');
          badge.className = 'quality-badge';
          var dot = document.createElement('span');
          dot.className = 'dot';
          dot.setAttribute('aria-hidden', 'true');
          badge.appendChild(dot);
          badge.appendChild(document.createTextNode(group.key));
          qHead.appendChild(badge);
          section.appendChild(qHead);

          var list = document.createElement('div');
          list.className = 'link-list';
          group.items.forEach(function (l, idx) {
            var row = document.createElement('div');
            row.className = 'link-row';
            var meta = document.createElement('div');
            meta.className = 'link-meta';
            var b = document.createElement('b');
            b.setAttribute('dir', 'auto');
            b.textContent = 'گزینه ' + (idx + 1);
            var span = document.createElement('span');
            span.textContent = (l[3] ? l[3].toUpperCase() : 'FILE')
              + (l[4] ? ' · ' + l[4].slice(0, 10) : '');
            meta.appendChild(b);
            meta.appendChild(span);

            var actions = document.createElement('div');
            actions.className = 'link-actions';
            actions.appendChild(makeResolveButton('play', 'پخش', PLAY_ICON, seasonNo, ep, l[0], group.key));
            actions.appendChild(makeResolveButton('download', 'دانلود', DOWNLOAD_ICON, seasonNo, ep, l[0], group.key));

            row.appendChild(meta);
            row.appendChild(actions);
            list.appendChild(row);
          });
          section.appendChild(list);
          body.appendChild(section);
        });

        var note = document.createElement('p');
        note.className = 'series-note';
        note.setAttribute('data-ep-note', '');
        note.setAttribute('role', 'status');
        note.setAttribute('aria-live', 'polite');
        note.textContent = 'پخش در موبایل با VLC باز می‌شود؛ دانلود لینک مستقیم می‌دهد.';
        body.appendChild(note);
      }

      aside.appendChild(body);
      workbench.appendChild(aside);
      bindResolve('[data-ep-resolve]', episodeResolveUrl, workbench.querySelector('[data-ep-note]'));
    }

    function selectEpisode(season, ep, withEpisodeInUrl) {
      var episodes = season[2];
      var index = 0;
      for (var i = 0; i < episodes.length; i++) {
        if (episodes[i][0] === ep[0]) { index = i; break; }
      }
      markActiveEpisode(ep[1]);
      renderPanel(season[0], ep, index, episodes.length);
      updateUrl(season[0], withEpisodeInUrl ? ep[1] : null);
    }

    function selectSeason(seasonNo) {
      var season = seasonByNo[String(seasonNo)];
      if (!season) return;
      currentSeasonNo = Number(seasonNo);
      setActiveSeason(currentSeasonNo);
      renderEpisodes(currentSeasonNo, season[2]);
      if (moreLabel) moreLabel.textContent = season[2].length + ' قسمت در فصل ' + currentSeasonNo;

      if (season[2].length) {
        selectEpisode(season, season[2][0], false);
      } else {
        var oldPanel = document.getElementById('episode-panel');
        if (oldPanel) oldPanel.remove();
        updateUrl(currentSeasonNo, null);
      }
    }

    seasonScroller.addEventListener('click', function (e) {
      var pill = e.target.closest ? e.target.closest('.season-pill') : null;
      if (!pill || !seasonScroller.contains(pill)) return;
      var seasonNo = Number(pill.getAttribute('data-season'));
      if (!seasonByNo[String(seasonNo)]) return; // fall back to the normal link
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      selectSeason(seasonNo);
    });

    workbench.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.episode-btn') : null;
      if (!btn || !gridHost.contains(btn)) return;
      var season = seasonByNo[String(currentSeasonNo)];
      if (!season) return; // fall back to the normal link
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      var episodeNo = Number(btn.getAttribute('data-episode-no'));
      for (var i = 0; i < season[2].length; i++) {
        if (season[2][i][1] === episodeNo) {
          selectEpisode(season, season[2][i], true);
          break;
        }
      }
    });
  }

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
  var keyboardHost = document.querySelector('.episode-workbench');
  if (keyboardHost) {
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function columns(grid) {
      var cols = window.getComputedStyle(grid).gridTemplateColumns;
      return Math.max(1, cols ? cols.split(' ').length : 1);
    }

    keyboardHost.addEventListener('keydown', function (e) {
      var grid = keyboardHost.querySelector('.episode-grid');
      if (!grid) return;
      var cells = Array.prototype.slice.call(grid.querySelectorAll('.episode-btn'));
      var idx = cells.indexOf(document.activeElement);
      if (idx < 0) return;
      var next = -1;
      if (e.key === 'ArrowLeft') next = idx + 1;
      else if (e.key === 'ArrowRight') next = idx - 1;
      else if (e.key === 'ArrowDown') next = idx + columns(grid);
      else if (e.key === 'ArrowUp') next = idx - columns(grid);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = cells.length - 1;
      if (next < 0 || next >= cells.length) return;
      e.preventDefault();
      cells[next].focus({ preventScroll: true });
      cells[next].scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    });
  }
})();
