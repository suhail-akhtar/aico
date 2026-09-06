// Progressive enhancement for __APP_TITLE__. Everything here has a working
// no-JavaScript fallback: the nav is visible on wide screens, <details> opens on
// its own, and the browser validates the form when `novalidate` is absent.
(function () {
  'use strict';

  // Mobile menu
  var header = document.querySelector('.site-header');
  var menu = document.querySelector('[data-menu]');
  if (header && menu) {
    menu.addEventListener('click', function () {
      var open = header.classList.toggle('is-open');
      menu.setAttribute('aria-expanded', String(open));
    });
    header.querySelectorAll('.site-nav a').forEach(function (a) {
      a.addEventListener('click', function () {
        header.classList.remove('is-open');
        menu.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // FAQ: one answer open at a time
  var faq = document.querySelector('[data-faq]');
  if (faq) {
    faq.addEventListener('toggle', function (e) {
      if (!e.target.open) return;
      faq.querySelectorAll('details[open]').forEach(function (d) {
        if (d !== e.target) d.open = false;
      });
    }, true);
  }

  // Contact form: refuse an invalid email before anything is sent
  var form = document.querySelector('[data-contact]');
  if (form) {
    var email = form.querySelector('#email');
    var field = email && email.closest('.field');
    var error = form.querySelector('#email-error');
    var status = form.querySelector('[data-status]');
    var valid = function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); };
    form.addEventListener('submit', function (e) {
      if (!email) return;
      var ok = valid(email.value.trim());
      field.classList.toggle('is-invalid', !ok);
      error.hidden = ok;
      email.setAttribute('aria-invalid', String(!ok));
      if (!ok) { e.preventDefault(); email.focus(); return; }
      if (form.getAttribute('action') === '#') {
        // Not wired yet: say so instead of pretending.
        e.preventDefault();
        status.textContent = 'This form is not connected to anything yet.';
      }
    });
    email.addEventListener('input', function () {
      if (valid(email.value.trim())) {
        field.classList.remove('is-invalid');
        error.hidden = true;
        email.setAttribute('aria-invalid', 'false');
      }
    });
  }

  var year = document.querySelector('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());
})();
