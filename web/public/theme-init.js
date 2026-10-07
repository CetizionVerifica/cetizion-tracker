// Runs before the first paint: see the comment beside it in index.html. A
// file of its own, not inline, because the server's Content-Security-Policy
// (helmet's default, script-src 'self') blocks inline scripts; inline, it
// never ran in a built app and every load painted the default first.
(function () {
  try {
    var stored = localStorage.getItem('cetizion.theme');
    var system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    // Light is the default (Mocha Glass). The client's acceptance page and
    // the portal are pinned dark (main.jsx), so they paint dark from the start.
    var pinned = /^\/(accept|portal)(\/|$)/.test(window.location.pathname);
    var mode = pinned ? 'dark' : stored === 'light' || stored === 'dark' ? stored : stored === 'system' ? system : 'light';
    document.documentElement.classList.toggle('dark', mode === 'dark');
    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.style.colorScheme = mode;
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
