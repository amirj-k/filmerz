/* filmz — hero-slider.js (cinematic Top 250 homepage slideshow) */
(function () {
  'use strict';

  var root = document.querySelector('[data-cine-slider]');
  if (!root) return;

  /*
   * AUTOPLAY_MS is the single fallback for the slideshow speed. The server
   * renders its own value (src/hero-cinema.js → data-autoplay) so the interval
   * is changed in exactly one place; this constant only covers markup that has
   * no attribute for some reason.
   */
  var AUTOPLAY_MS = 2000;
  var attr = parseInt(root.getAttribute('data-autoplay'), 10);
  var interval = (isFinite(attr) && attr > 0) ? attr : AUTOPLAY_MS;

  var slides = Array.prototype.slice.call(root.querySelectorAll('[data-cine-slide]'));
  if (!slides.length) return;

  var dots = Array.prototype.slice.call(root.querySelectorAll('[data-cine-dot]'));
  var toggle = root.querySelector('[data-cine-toggle]');
  var progressBar = root.querySelector('[data-cine-progress-bar]');
  var status = root.querySelector('[data-cine-status]');

  var motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var pointerQuery = window.matchMedia ? window.matchMedia('(hover: hover) and (pointer: fine)') : null;
  var reduced = motionQuery ? motionQuery.matches : false;
  var finePointer = pointerQuery ? pointerQuery.matches : true;
  var canAnimate = !!(window.Element && Element.prototype.animate);
  var supportsIO = 'IntersectionObserver' in window;

  var current = 0;
  var hovered = false;
  var focused = false;
  var touching = false;
  var userPaused = false;
  var ticking = false;      // A clock is currently counting down.
  var onScreen = !supportsIO; // With IO, wait for the first observation.
  var remaining = interval; // Time left for the visible slide.
  var deadline = 0;
  var timer = null;
  var progressAnim = null;

  var singleSlide = slides.length < 2;
  if (singleSlide) root.classList.add('is-single');

  /* ---------- images: active immediately, next on idle ---------- */

  function loadSlide(index, highPriority) {
    var slide = slides[index];
    if (!slide) return;
    var imgs = slide.querySelectorAll('img[data-src]');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (highPriority) img.setAttribute('fetchpriority', 'high');
      img.src = img.getAttribute('data-src');
      img.removeAttribute('data-src');
    }
  }

  function preloadNext(index) {
    if (window.requestIdleCallback) {
      window.requestIdleCallback(function () { loadSlide(index); }, { timeout: 1200 });
    } else {
      window.setTimeout(function () { loadSlide(index); }, 250);
    }
  }

  /* ---------- slide switching ---------- */

  function show(next, announce) {
    next = ((next % slides.length) + slides.length) % slides.length;
    if (next === current) return;

    loadSlide(next, true);
    preloadNext((next + 1) % slides.length);

    for (var i = 0; i < slides.length; i++) {
      var slide = slides[i];
      var active = i === next;
      slide.classList.toggle('is-active', active);
      slide.setAttribute('aria-hidden', active ? 'false' : 'true');
      var links = slide.querySelectorAll('a');
      for (var j = 0; j < links.length; j++) {
        links[j].setAttribute('tabindex', active ? '0' : '-1');
      }
    }

    for (var k = 0; k < dots.length; k++) {
      var on = k === next;
      dots[k].classList.toggle('is-active', on);
      dots[k].setAttribute('aria-current', on ? 'true' : 'false');
    }

    current = next;
    // Only manual moves are announced; autoplay would chatter every 2s.
    if (announce && status) status.textContent = slides[next].getAttribute('aria-label') || '';
  }

  /* ---------- clock: one timeout, always resumable ---------- */

  function canRun() {
    return onScreen && !reduced && !singleSlide && !userPaused && !hovered &&
      !focused && !touching && !document.hidden;
  }

  function stopTimer() {
    if (timer) { window.clearTimeout(timer); timer = null; }
  }

  function cancelProgress() {
    if (progressAnim) {
      progressAnim.cancel();
      progressAnim = null;
    }
  }

  function startClock() {
    stopTimer();
    remaining = Math.max(0, Math.min(remaining, interval));
    deadline = Date.now() + remaining;

    if (canAnimate && progressBar) {
      cancelProgress();
      var from = interval > 0 ? 1 - (remaining / interval) : 0;
      progressAnim = progressBar.animate(
        [
          { transform: 'scaleX(' + from.toFixed(4) + ')' },
          { transform: 'scaleX(1)' }
        ],
        { duration: Math.max(remaining, 1), easing: 'linear', fill: 'forwards' }
      );
    }

    timer = window.setTimeout(onTick, Math.max(remaining, 1));
  }

  function holdClock() {
    if (timer) {
      stopTimer();
      remaining = Math.max(0, deadline - Date.now());
    }
    if (progressAnim) progressAnim.pause();
  }

  function syncClock() {
    var run = canRun();
    if (run && !ticking) {
      ticking = true;
      startClock();
    } else if (!run && ticking) {
      ticking = false;
      holdClock();
    }
  }

  function resetClock() {
    remaining = interval;
    if (ticking) startClock();
    else cancelProgress(); // CSS base state (scaleX(0)) stays in sync
  }

  function onTick() {
    timer = null;
    if (!canRun()) {
      ticking = false;
      remaining = interval;
      holdClock();
      return;
    }
    show(current + 1, false);
    remaining = interval;
    startClock();
  }

  function navigate(next, announce) {
    show(next, announce === true);
    resetClock();
  }

  /* ---------- controls ---------- */

  var prevBtn = root.querySelector('[data-cine-prev]');
  var nextBtn = root.querySelector('[data-cine-next]');
  if (prevBtn) prevBtn.addEventListener('click', function () { navigate(current - 1, true); });
  if (nextBtn) nextBtn.addEventListener('click', function () { navigate(current + 1, true); });

  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      navigate(parseInt(dot.getAttribute('data-cine-dot'), 10) || 0, true);
    });
  });

  if (toggle) {
    toggle.addEventListener('click', function () {
      if (reduced) return;
      userPaused = !userPaused;
      toggle.classList.toggle('is-paused', userPaused);
      toggle.setAttribute(
        'aria-label',
        userPaused ? 'ادامه پخش خودکار' : 'توقف پخش خودکار'
      );
      syncClock();
    });
  }

  /* ---------- pause while the pointer rests on the hero (mouse only) ---------- */

  if (finePointer) {
    root.addEventListener('mouseenter', function () { hovered = true; syncClock(); });
    root.addEventListener('mouseleave', function () { hovered = false; syncClock(); });
  }

  /* ---------- pause while a keyboard user is inside the hero ---------- */

  function hasKeyboardFocus() {
    var el = document.activeElement;
    if (!el || !root.contains(el)) return false;
    try { return el.matches(':focus-visible'); } catch (err) { return true; }
  }

  root.addEventListener('focusin', function () {
    focused = hasKeyboardFocus();
    syncClock();
  });
  root.addEventListener('focusout', function () {
    // Wait for the browser to move focus before re-reading activeElement.
    window.setTimeout(function () {
      focused = hasKeyboardFocus();
      syncClock();
    }, 0);
  });

  /* ---------- keyboard (only while the hero has focus) ---------- */

  root.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') { e.preventDefault(); navigate(current - 1, true); } // RTL: right = previous
    else if (e.key === 'ArrowLeft') { e.preventDefault(); navigate(current + 1, true); } // RTL: left = next
  });

  /* ---------- touch / swipe (mobile) ---------- */

  var touchX = 0;
  var touchY = 0;
  var tracking = false;

  root.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { tracking = false; return; }
    tracking = true;
    touching = true;
    syncClock();
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
  }, { passive: true });

  function endTouch(e) {
    touching = false;
    syncClock();
    if (!tracking) return;
    tracking = false;
    var t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    var dx = t.clientX - touchX;
    var dy = t.clientY - touchY;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return; // ignore taps / vertical scroll
    if (dx < 0) navigate(current + 1, true);
    else navigate(current - 1, true);
  }

  root.addEventListener('touchend', endTouch, { passive: true });
  root.addEventListener('touchcancel', function () {
    tracking = false;
    touching = false;
    syncClock();
  }, { passive: true });

  /* ---------- pause offscreen: no autoplay work below the fold ---------- */

  if (supportsIO) {
    var observer = new IntersectionObserver(function (entries) {
      var entry = entries[0];
      onScreen = entry ? entry.isIntersecting : true;
      syncClock();
    }, { threshold: 0.05 });
    observer.observe(root);
  }

  /* ---------- tab visibility: no background work ---------- */

  document.addEventListener('visibilitychange', syncClock);

  /* ---------- honour a live change to the motion preference ---------- */

  if (motionQuery && motionQuery.addEventListener) {
    motionQuery.addEventListener('change', function (e) {
      reduced = e.matches;
      syncClock();
    });
  }

  /* ---------- broken image → keep the material, never a broken icon ---------- */

  slides.forEach(function (slide) {
    var imgs = slide.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      imgs[i].addEventListener('error', function () {
        this.classList.add('is-broken');
      }, { once: true });
    }
  });

  /* ---------- init ---------- */

  loadSlide(0);
  preloadNext(1);
  syncClock();
})();
