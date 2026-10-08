// Runs before the first paint: see the comment beside it in index.html. A
// file of its own, not inline, because the server's Content-Security-Policy
// (helmet's default, script-src 'self') blocks inline scripts; inline, it
// never ran in a built app and every load painted the default first.
(function () {
  try {
    // Light is the default (Mocha Glass). The client's acceptance page and the
    // portal keep the client's own choice, apart from staff's (main.jsx).
    var client = /^\/(accept|portal)(\/|$)/.test(window.location.pathname);
    var stored = localStorage.getItem(client ? 'cetizion.client-theme' : 'cetizion.theme');
    var system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    var mode = stored === 'light' || stored === 'dark' ? stored : stored === 'system' ? system : 'light';
    document.documentElement.classList.toggle('dark', mode === 'dark');
    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.style.colorScheme = mode;
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
