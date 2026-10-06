// Applies the saved colour scheme before first paint so a dark-mode user never sees a white flash.
// A separate same-origin file (not an inline script) because the CSP forbids inline script.
// No saved choice means "follow the system": the stylesheet's prefers-color-scheme rules apply.
(() => {
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch {
    // Storage can be blocked (private mode, site settings); the system preference still works.
  }
})();
