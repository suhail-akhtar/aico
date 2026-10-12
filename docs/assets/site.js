/*
 * Three behaviours, and no framework to carry them.
 *
 * The theme applies from a head script before the body paints — set it any
 * later and every visitor on dark gets a white flash first.
 */
(function () {
  'use strict';

  var KEY = 'aico-site-theme';

  function apply(value) {
    if (value === 'dark' || value === 'light') document.documentElement.setAttribute('data-theme', value);
    else document.documentElement.removeAttribute('data-theme');
  }
  try { apply(localStorage.getItem(KEY)); } catch (err) { /* private mode */ }

  function isDark() {
    var set = document.documentElement.getAttribute('data-theme');
    if (set) return set === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  document.addEventListener('DOMContentLoaded', function () {
    // Drawn rather than typed. The moon and sun characters render at wildly
    // different weights and baselines across platforms, and on Windows one of
    // them arrives as a clipped circle.
    var SUN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"'
      + ' stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/>'
      + '<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2'
      + 'M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    var MOON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"'
      + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

    var toggle = document.querySelector('.theme-toggle');
    if (toggle) {
      var paint = function () {
        toggle.innerHTML = isDark() ? SUN : MOON;
        toggle.setAttribute('aria-label', isDark() ? 'Switch to light' : 'Switch to dark');
      };
      paint();
      toggle.addEventListener('click', function () {
        var next = isDark() ? 'light' : 'dark';
        apply(next);
        try { localStorage.setItem(KEY, next); } catch (err) { /* not persisted */ }
        paint();
      });
    }

    // Copy the install command. The clipboard API needs a secure context, and
    // github.io is one — but a file:// preview is not, so failure is handled
    // rather than assumed away.
    document.querySelectorAll('.install button').forEach(function (button) {
      button.addEventListener('click', function () {
        var text = button.parentElement.querySelector('code').textContent.replace(/^\$\s*/, '');
        var done = function (ok) {
          button.textContent = ok ? 'Copied' : 'Copy failed';
          button.classList.toggle('done', ok);
          setTimeout(function () { button.textContent = 'Copy'; button.classList.remove('done'); }, 1800);
        };
        if (!navigator.clipboard) return done(false);
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      });
    });
  });

  // Arriving on a deep link — compare.html#vscode from the landing page, say.
  //
  // Chrome scrolls to the fragment while the document is still loading, and
  // `scroll-behavior: smooth` turns that into an animation that late layout
  // routinely cancels: the visitor lands at the top of a long page instead of
  // the section they clicked. Redoing it once everything has settled is the
  // difference between a working link and one that looks broken. `scrollIntoView`
  // honours the scroll-padding that clears the sticky header, and instant
  // behaviour is right here — nobody wants to watch a page they have not seen
  // yet scroll past.
  window.addEventListener('load', function () {
    if (!location.hash || location.hash === '#') return;
    var target;
    try { target = document.querySelector(location.hash); } catch (err) { return; } // not a selector
    if (target) target.scrollIntoView({ behavior: 'instant', block: 'start' });
  });
})();
