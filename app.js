(function () {
  'use strict';

  /* Progress bar */
  var bar = document.getElementById('bar');
  var ticking = false;

  function updateBar() {
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    var p = max > 0 ? (h.scrollTop || document.body.scrollTop) / max : 0;
    if (bar) bar.style.width = Math.min(100, Math.max(0, p * 100)) + '%';
    ticking = false;
  }

  window.addEventListener('scroll', function () {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(updateBar);
    }
  }, { passive: true });
  updateBar();

  /* Reveal on scroll */
  var items = document.querySelectorAll('.reveal');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduce || !('IntersectionObserver' in window)) {
    for (var i = 0; i < items.length; i++) items[i].classList.add('in');
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    for (var j = 0; j < items.length; j++) io.observe(items[j]);
  }

  /* Score bars */
  var bars = document.querySelectorAll('.bar-f');

  function fill(el) {
    el.style.width = (el.getAttribute('data-w') || '0') + '%';
  }

  if (reduce) {
    for (var k = 0; k < bars.length; k++) fill(bars[k]);
  } else if ('IntersectionObserver' in window) {
    var io2 = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          fill(e.target);
          io2.unobserve(e.target);
        }
      });
    }, { threshold: 0.3 });
    for (var m = 0; m < bars.length; m++) io2.observe(bars[m]);
  } else {
    for (var n = 0; n < bars.length; n++) fill(bars[n]);
  }

  /* Highlight current section in nav */
  var links = Array.prototype.slice.call(document.querySelectorAll('.nav a'));
  var sections = links
    .map(function (a) { return document.querySelector(a.getAttribute('href')); })
    .filter(Boolean);

  if (sections.length && 'IntersectionObserver' in window) {
    var io3 = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        links.forEach(function (a) {
          var on = a.getAttribute('href') === '#' + e.target.id;
          a.style.color = on ? 'var(--accent)' : '';
          a.style.background = on ? 'rgba(18,86,74,.09)' : '';
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    sections.forEach(function (s) { io3.observe(s); });
  }

  /* Visit tracking: один отчёт на сессию, данные уходят только своему серверу */
  try {
    if (!sessionStorage.getItem('visit-logged')) {
      sessionStorage.setItem('visit-logged', '1');
      var tz = '';
      try {
        tz = (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '';
      } catch (e) { /* старый браузер без Intl — отправляем без часового пояса */ }
      var body = JSON.stringify({
        path: location.pathname,
        ref: document.referrer || '',
        screen: window.screen ? screen.width + 'x' + screen.height : '',
        lang: navigator.language || '',
        tz: tz
      });
      fetch('/track', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
        keepalive: true
      }).catch(function () { /* статистика не должна ломать страницу */ });
    }
  } catch (e) { /* приватный режим без storage */ }
})();
