/* filmz — admin.js (metadata forms, link editor, toggles) */
(function () {
  'use strict';

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': body._csrf || '' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return { ok: r.ok }; })
        .then(function (d) { return { status: r.status, d: d }; });
    });
  }

  function field(form, name) {
    var el = form ? form.querySelector('[name="' + name + '"]') : null;
    return el ? el.value : '';
  }

  function isChecked(form, name) {
    var el = form ? form.querySelector('[name="' + name + '"]') : null;
    return Boolean(el && el.checked);
  }

  function splitList(value) {
    return String(value || '')
      .split(/[,،;؛\n]+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function peopleFrom(form) {
    var people = [];
    [['director', 'directors'], ['writer', 'writers'], ['actor', 'actors']].forEach(function (pair) {
      splitList(field(form, pair[1])).forEach(function (name) {
        people.push({ role: pair[0], name: name });
      });
    });
    return people;
  }

  function readLinkRow(row) {
    function value(name) {
      var el = row.querySelector('[name="' + name + '"]');
      return el ? el.value : '';
    }
    function flag(name) {
      var el = row.querySelector('[name="' + name + '"]');
      return el && el.checked ? 1 : 0;
    }
    return {
      url: value('url'),
      play_url: value('play_url'),
      quality_text: value('quality_text'),
      resolution: value('resolution'),
      server: value('server'),
      media_kind: value('media_kind'),
      codec: value('codec'),
      part: value('part'),
      season_no: value('season_no'),
      episode_no: value('episode_no'),
      episode_title: value('episode_title'),
      is_dub: flag('is_dub'),
      is_sub: flag('is_sub'),
    };
  }

  function collectLinks(container) {
    var links = [];
    if (!container) return links;
    container.querySelectorAll('[data-link-row]').forEach(function (row) {
      var link = readLinkRow(row);
      if (link.url.trim()) links.push(link);
    });
    return links;
  }

  function metadataBody(form) {
    var body = {
      _csrf: field(form, '_csrf'),
      title_en: field(form, 'title_en'),
      title_fa: field(form, 'title_fa'),
      other_titles: field(form, 'other_titles'),
      year: field(form, 'year') || null,
      age_rating: field(form, 'age_rating'),
      country: field(form, 'country'),
      status_text: field(form, 'status_text'),
      poster_url: field(form, 'poster_url'),
      plot: field(form, 'plot'),
      genres: splitList(field(form, 'genres')),
      people: peopleFrom(form),
      published: isChecked(form, 'published') ? 1 : 0,
      featured: isChecked(form, 'featured') ? 1 : 0,
    };
    var list = form.querySelector('[data-link-list]');
    if (list) body.links = collectLinks(list);
    return body;
  }

  function resetRow(row) {
    row.querySelectorAll('input').forEach(function (input) {
      if (input.type === 'checkbox' || input.type === 'radio') {
        input.checked = false;
      } else if (input.name === 'season_no' || input.name === 'episode_no') {
        input.value = '1';
      } else if (input.name === 'part') {
        input.value = '0';
      } else {
        input.value = '';
      }
    });
    row.querySelectorAll('select').forEach(function (select) {
      select.selectedIndex = 0;
    });
  }

  function feedback(result, fallback) {
    if (result.status === 200 && result.d && result.d.ok) return true;
    alert((result.d && result.d.message) || fallback);
    return false;
  }

  /* ---- publish / featured toggles ---------------------------------- */
  document.querySelectorAll('[data-toggle]').forEach(function (button) {
    button.addEventListener('click', function () {
      var name = button.getAttribute('data-field');
      var next = button.getAttribute('data-next') === '1';
      var body = { _csrf: button.getAttribute('data-csrf') };
      body[name] = next ? 1 : 0;
      button.disabled = true;
      post(button.getAttribute('data-url'), body)
        .then(function (result) {
          if (feedback(result, 'تغییر وضعیت ناموفق بود.')) location.reload();
          else button.disabled = false;
        })
        .catch(function () {
          button.disabled = false;
          alert('خطای شبکه');
        });
    });
  });

  /* ---- add / remove link rows -------------------------------------- */
  document.addEventListener('click', function (event) {
    var add = event.target.closest('[data-add-link]');
    if (add) {
      event.preventDefault();
      var scope = add.closest('form') || add.closest('.admin-links-panel');
      var list = scope ? scope.querySelector('[data-link-list]') : null;
      var template = scope ? scope.querySelector('template[data-link-template]') : null;
      if (!list || !template) return;
      list.appendChild(template.content.cloneNode(true));
      var last = list.lastElementChild;
      var input = last && last.querySelector('[name="url"]');
      if (input) input.focus();
      return;
    }

    var remove = event.target.closest('[data-remove-link]');
    if (remove) {
      event.preventDefault();
      var row = remove.closest('[data-link-row]');
      if (!row) return;
      var listEl = row.parentElement;
      if (listEl && listEl.querySelectorAll('[data-link-row]').length > 1) row.remove();
      else resetRow(row);
      return;
    }

    var del = event.target.closest('[data-delete-link]');
    if (del) {
      event.preventDefault();
      if (!confirm('این لینک حذف شود؟')) return;
      del.disabled = true;
      post(del.getAttribute('data-url'), { _csrf: del.getAttribute('data-csrf') })
        .then(function (result) {
          if (feedback(result, 'حذف لینک ناموفق بود.')) location.reload();
          else del.disabled = false;
        })
        .catch(function () {
          del.disabled = false;
          alert('خطای شبکه');
        });
    }
  });

  /* ---- movie / series metadata form -------------------------------- */
  var metadataForm = document.getElementById('movie-form') || document.getElementById('series-form');
  if (metadataForm) {
    metadataForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var action = metadataForm.getAttribute('data-action');
      var submit = metadataForm.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;

      post(action, metadataBody(metadataForm))
        .then(function (result) {
          if (!feedback(result, 'ذخیره ناموفق بود.')) return;
          var id = result.d.id;
          if (metadataForm.getAttribute('data-new') === '1' && id) {
            var base = metadataForm.id === 'series-form' ? '/admin/series/' : '/admin/movies/';
            location.href = base + id + '/edit';
            return;
          }
          alert('ذخیره شد.');
          location.reload();
        })
        .catch(function () { alert('خطای شبکه'); })
        .finally(function () { if (submit) submit.disabled = false; });
    });
  }

  /* ---- separate "add links" forms ---------------------------------- */
  document.querySelectorAll('[data-add-links]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var links = collectLinks(form.querySelector('[data-link-list]'));
      if (!links.length) {
        alert('حداقل یک لینک با «آدرس فایل» وارد کنید.');
        return;
      }
      var submit = form.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      post(form.getAttribute('data-action'), { _csrf: field(form, '_csrf'), links: links })
        .then(function (result) {
          if (feedback(result, 'افزودن لینک ناموفق بود.')) location.reload();
          else if (submit) submit.disabled = false;
        })
        .catch(function () {
          if (submit) submit.disabled = false;
          alert('خطای شبکه');
        });
    });
  });
})();
