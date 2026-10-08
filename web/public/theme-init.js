// Runs before the first paint: see the comment beside it in index.html. A
// file of its own, not inline, because the server's Content-Security-Policy
// (helmet's default, script-src 'self') blocks inline scripts; inline, it
// never ran in a built app and every load painted the default first.
(function () {
  try {
    var stored = localStorage.getItem('cetizion.theme');
    var system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    var mode = stored === 'light' || stored === 'dark' ? stored : stored === 'system' ? system : 'light';
    document.documentElement.classList.toggle('dark', mode === 'dark');
    document.documentElement.style.colorScheme = mode;
  } catch (e) {
    /* No storage: light, the default, which is no class at all. */
  }
})();
