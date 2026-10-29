/* filmz — admin.js (edit form, toggles) */
(function () {
  'use strict';

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': body._csrf || '' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return { ok: r.ok }; }).then(function (d) { return { status: r.status, d: d }; });
    });
  }

  /* toggle publish / featured */
  document.querySelectorAll('[data-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var url = b.getAttribute('data-url');
      var field = b.getAttribute('data-field');
      var next = b.getAttribute('data-next') === '1';
      post(url, { _csrf: b.getAttribute('data-csrf'), published: field === 'published' ? (next ? 1 : 0) : undefined, featured: field === 'featured' ? (next ? 1 : 0) : undefined })
        .then(function (r) {
          if (r.status === 200 && r.d.ok) { b.setAttribute('data-next', next ? '0' : '1'); b.textContent = next ? 'گذاشتن لنگر' : 'رفع لنگر'; location.reload(); }
          else alert((r.d && r.d.message) || 'خطا');
        })
        .catch(function () { alert('خطای شبکه'); });
    });
  });

  /* series edit form → JSON */
  var seriesForm = document.getElementById('series-form');
  if (seriesForm) {
    seriesForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(seriesForm);
      var body = {
        _csrf: fd.get('_csrf'),
        title_en: fd.get('title_en') || '',
        title_fa: fd.get('title_fa') || '',
        year: fd.get('year') || null,
        age_rating: fd.get('age_rating') || '',
        country: fd.get('country') || '',
        status_text: fd.get('status_text') || '',
        poster_url: fd.get('poster_url') || '',
        plot: fd.get('plot') || '',
        genres: (fd.get('genres') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        people: [
          { role: 'director', name: fd.get('directors') || '' },
          { role: 'writer', name: fd.get('writers') || '' },
          { role: 'actor', name: fd.get('actors') || '' },
        ].filter(function (p) { return p.name.trim(); }),
        published: seriesForm.querySelector('[name="published"]').checked ? 1 : 0,
        featured: seriesForm.querySelector('[name="featured"]').checked ? 1 : 0,
      };
      var submit = seriesForm.querySelector('[type="submit"]');
      submit.disabled = true;
      post(seriesForm.getAttribute('data-action'), body)
        .then(function (r) {
          if (r.status === 200 && r.d.ok) { alert('ذخیره شد.'); location.reload(); }
          else alert((r.d && r.d.message) || 'ذخیره ناموفق بود.');
        })
        .catch(function () { alert('خطای شبکه'); })
        .finally(function () { submit.disabled = false; });
    });
  }

  /* movie edit form → JSON */
  var form = document.getElementById('movie-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var body = {
        _csrf: fd.get('_csrf'),
        title_en: fd.get('title_en') || '',
        title_fa: fd.get('title_fa') || '',
        other_titles: fd.get('other_titles') || '',
        year: fd.get('year') || null,
        age_rating: fd.get('age_rating') || '',
        poster_url: fd.get('poster_url') || '',
        plot: fd.get('plot') || '',
        country: fd.get('country') || '',
        genres: (fd.get('genres') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        people: [
          { role: 'director', name: fd.get('directors') || '' },
          { role: 'writer', name: fd.get('writers') || '' },
          { role: 'actor', name: fd.get('actors') || '' },
        ].filter(function (p) { return p.name.trim(); }),
        published: form.querySelector('[name="published"]').checked ? 1 : 0,
        featured: form.querySelector('[name="featured"]').checked ? 1 : 0,
      };
      var submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      post(form.getAttribute('data-action'), body)
        .then(function (r) {
          if (r.status === 200 && r.d.ok) {
            if (r.d.id) location.href = '/movie/' + r.d.id;
            else { alert('ذخیره شد.'); location.reload(); }
          } else {
            alert((r.d && r.d.message) || 'ذخیره ناموفق بود.');
          }
        })
        .catch(function () { alert('خطای شبکه'); })
        .finally(function () { submit.disabled = false; });
    });
  }
})();
