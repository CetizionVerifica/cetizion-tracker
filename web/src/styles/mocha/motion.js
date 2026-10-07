/* Mocha Glass motion for the app: the jelly and press, count-ups, the entrance, the pause
   switch and the theme shockwave, ported from the design system's bundle.js (the canvas
   "Mocha mix · Glass 2"). No cursor ripple (removed 8 Oct). The scene's blobs and grain are
   drawn by components/SceneBackdrop.jsx rather than by scenes() here. */

export const SOFT = 'linear(0, 0.012, 0.048 2.3%, 0.2 5%, 0.718 13.4%, 0.92 17.6%, 1.006 21%, 1.045 24.2%, 1.056 27.4%, 1.047 31%, 1.012 39.5%, 0.996 46.5%, 0.993 52%, 1 70%, 1)';
export const BREW = 'linear(0, 0.009, 0.035 2.1%, 0.141 4.4%, 0.723 12.9%, 0.938 16.7%, 1.017 19.4%, 1.067, 1.099 24.3%, 1.108 26%, 1.104, 1.087 31.4%, 1.008 39.6%, 0.985 45.8%, 0.98 50%, 0.996 63.4%, 1.001 72.4%, 1)';

// Primary buttons jelly; every other button and chip gets the softer press.
const JELLY = '.mg-btn--primary, .mg-rail__btn, .mg-rail__theme, .mg-dock__add, [data-jelly]';
const PRESS = '.mg-btn, .btn, .mg-chip, .mg-seg button, .mg-iconbtn, [data-press]';
const state = { paused: false };

function reduced() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
export function still() { return state.paused || reduced(); }

export function jelly(el) {
  if (still() || !el.animate) return;
  el.animate([{ transform: 'scale(1,1)' }, { transform: 'scale(1.1,.88)', offset: .25 }, { transform: 'scale(.94,1.06)', offset: .5 }, { transform: 'scale(1.02,.99)', offset: .75 }, { transform: 'scale(1,1)' }],
    { duration: 540, easing: 'ease-out', composite: 'add' });
}
export function press(el) {
  if (still() || !el.animate) return;
  el.animate([{ transform: 'scale(1,1)' }, { transform: 'scale(1.06,.94)', offset: .35 }, { transform: 'scale(.97,1.03)', offset: .7 }, { transform: 'scale(1,1)' }],
    { duration: 460, easing: 'ease-out', composite: 'add' });
}

/* Entrance, once per page view. Mark elements with data-a="rise|pop". */
export function enter(root = document) {
  if (!still()) {
    root.querySelectorAll('[data-a="rise"]').forEach((el, i) => el.animate(
      [{ opacity: 0, translate: '0 22px', filter: 'blur(10px)' }, { opacity: 1, translate: '0 0', filter: 'blur(0px)' }],
      { duration: 900, delay: i * 75, easing: SOFT, fill: 'backwards' }));
    root.querySelectorAll('[data-a="pop"]').forEach((el, i) => el.animate(
      [{ scale: '.6', opacity: 0 }, { scale: '1', opacity: 1 }], { duration: 600, delay: 560 + i * 30, easing: SOFT, fill: 'backwards' }));
  }
  countUps(root);
}

/* Count-up: 1.5s ease-out, never past the real value. <span data-count="1842500" data-format="inr">. */
export const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
export function countUps(root = document) {
  root.querySelectorAll('[data-count]').forEach((el) => {
    const to = Number(el.getAttribute('data-count'));
    const fmt = el.getAttribute('data-format') === 'inr' ? inr : (n) => Math.round(n).toLocaleString('en-IN');
    if (still()) { el.textContent = fmt(to); return; }
    let t0 = null;
    const step = (t) => { if (t0 === null) t0 = t; const k = Math.min(1, (t - t0) / 1500); el.textContent = fmt(to * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}

/* Pause: stops the blobs, shimmer, presses and entrances (html.mg-paused). Remembered per browser. */
const PAUSE_KEY = 'cetizion.motion-paused';
export function pause(on) {
  state.paused = on == null ? !state.paused : !!on;
  document.documentElement.classList.toggle('mg-paused', state.paused);
  try { localStorage.setItem(PAUSE_KEY, state.paused ? '1' : '0'); } catch { /* storage off */ }
  return state.paused;
}
export function isPaused() { return state.paused; }

/* Theme shockwave (View Transitions). switchTheme('dark' | 'light', button, apply). */
export function switchTheme(next, btn, apply) {
  const html = document.documentElement;
  if (!document.startViewTransition || reduced() || !btn) return Promise.resolve(apply());
  const b = btn.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
  const vw = innerWidth || html.clientWidth, vh = innerHeight || html.clientHeight;
  const r = Math.ceil(Math.sqrt(Math.max(x, vw - x) ** 2 + Math.max(y, vh - y) ** 2) + 12);
  const cls = next === 'dark' ? 'mg-vt-spread' : 'mg-vt-absorb';
  const diag = Math.sqrt(vw * vw + vh * vh) / Math.SQRT2;
  const set = (k, v) => html.style.setProperty(k, v);
  set('--mg-vt-x', x + 'px'); set('--mg-vt-y', y + 'px'); set('--mg-vt-r', r + 'px');
  set('--mg-vt-w', b.width + 'px'); set('--mg-vt-h', b.height + 'px');
  set('--mg-vt-xp', (x / vw * 100) + '%'); set('--mg-vt-yp', (y / vh * 100) + '%');
  set('--mg-vt-rp', (r / diag * 100) + '%'); set('--mg-vt-r0p', (22 / diag * 100) + '%');
  html.classList.add(cls); btn.style.viewTransitionName = 'mg-wave';
  if (next === 'dark') jelly(btn);
  const t = document.startViewTransition(() => apply());
  return t.finished.finally(() => { html.classList.remove(cls); btn.style.viewTransitionName = ''; if (next !== 'dark') jelly(btn); });
}

let wired = false;
/* Wire the delegated presses once and publish window.MochaGlass (pickers.js extends it). */
export function installMotion() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  try { if (localStorage.getItem(PAUSE_KEY) === '1') pause(true); } catch { /* storage off */ }
  document.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const j = t.closest(JELLY); if (j && !j.disabled) return jelly(j);
    const p = t.closest(PRESS); if (p && !p.disabled) press(p);
  }, true);
  window.MochaGlass = Object.assign(window.MochaGlass || {}, {
    springs: { soft: SOFT, brew: BREW }, switchTheme, jelly, press, enter, countUps, pause, isPaused, inr,
  });
}
