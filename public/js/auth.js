/* filmz — auth.js (password visibility + client-side form hints) */
(function () {
  'use strict';

  /* ---------- show / hide password ---------- */
  document.querySelectorAll('[data-pw-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var input = btn.parentElement ? btn.parentElement.querySelector('input') : null;
      if (!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', show ? 'مخفی کردن رمز عبور' : 'نمایش رمز عبور');
      btn.classList.toggle('is-on', show);
    });
  });

  /* ---------- tiny helpers ---------- */
  function setMsg(form, msg) {
    var el = form.querySelector('[data-form-msg]');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function busy(form, on) {
    var button = form.querySelector('[data-submit]');
    if (!button) return;
    var label = button.querySelector('[data-submit-label]');
    if (on) {
      if (label && !button.dataset.originalLabel) {
        button.dataset.originalLabel = label.textContent;
        label.textContent = 'در حال ارسال…';
      }
      button.disabled = true;
      button.classList.add('loading');
      button.setAttribute('aria-busy', 'true');
    } else {
      if (label && button.dataset.originalLabel) {
        label.textContent = button.dataset.originalLabel;
        delete button.dataset.originalLabel;
      }
      button.disabled = false;
      button.classList.remove('loading');
      button.setAttribute('aria-busy', 'false');
    }
  }

  function validate(form) {
    var kind = form.getAttribute('data-validate') || '';
    var email = form.querySelector('input[type="email"]');
    var password = form.querySelector('input[name="password"]');
    var confirm = form.querySelector('input[name="confirm_password"]');

    if (email && email.value.trim()) {
      var re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!re.test(email.value.trim())) return 'ساختار ایمیل معتبر نیست.';
    }

    if (kind === 'register' || kind === 'password' || kind === 'reset') {
      if (password) {
        var min = parseInt(password.getAttribute('minlength') || '12', 10);
        if (password.value.length < min) return 'رمز عبور باید دست‌کم ' + min + ' کاراکتر باشد.';
        if (password.value.length > 128) return 'رمز عبور بیش از حد طولانی است.';
      }
      if (confirm && password && confirm.value !== password.value) {
        return 'تکرار رمز عبور با رمز عبور یکسان نیست.';
      }
    }

    if (kind === 'login') {
      if (password && !password.value) return 'رمز عبور را وارد کنید.';
    }

    if (kind === 'profile') {
      var name = form.querySelector('input[name="display_name"]');
      if (name && (name.value.trim().length < 2 || name.value.trim().length > 60)) {
        return 'نام نمایشی باید بین ۲ تا ۶۰ کاراکتر باشد.';
      }
    }

    return '';
  }

  document.querySelectorAll('form[data-auth-form]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      var msg = validate(form);
      if (msg) {
        e.preventDefault();
        setMsg(form, msg);
        var first = form.querySelector('input:invalid, input');
        if (first) first.focus();
        return;
      }
      setMsg(form, '');
      busy(form, true);
    });
    form.addEventListener('input', function () {
      if (!form.querySelector('[data-form-msg][hidden]')) setMsg(form, '');
    });
  });

  // Returning via bfcache must not leave a button stuck in "sending".
  window.addEventListener('pageshow', function () {
    document.querySelectorAll('form[data-auth-form]').forEach(function (form) {
      busy(form, false);
    });
  });
})();
