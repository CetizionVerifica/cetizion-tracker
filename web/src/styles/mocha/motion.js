/* Mocha Glass motion for the app: the jelly and press, count-ups, the entrance, the pause
   switch and the theme shockwave, ported from the design system's bundle.js (the canvas
   "Mocha mix · Glass 2"). No cursor ripple (removed 8 Oct). The scene's blobs and grain are
   drawn by components/SceneBackdrop.jsx rather than by scenes() here. */

export const SOFT = 'linear(0, 0.012, 0.048 2.3%, 0.2 5%, 0.718 13.4%, 0.92 17.6%, 1.006 21%, 1.045 24.2%, 1.056 27.4%, 1.047 31%, 1.012 39.5%, 0.996 46.5%, 0.993 52%, 1 70%, 1)';
export const BREW = 'linear(0, 0.009, 0.035 2.1%, 0.141 4.4%, 0.723 12.9%, 0.938 16.7%, 1.017 19.4%, 1.067, 1.099 24.3%, 1.108 26%, 1.104, 1.087 31.4%, 1.008 39.6%, 0.985 45.8%, 0.98 50%, 0.996 63.4%, 1.001 72.4%, 1)';

// Primary buttons jelly. Every other button and chip dips to .97 in CSS (feel.css, PR 14).
const JELLY = '.mg-btn--primary, .mg-rail__btn, .mg-rail__theme, .mg-dock__add, [data-jelly]';
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

/* Entrance, once per page view. Mark elements with data-a="rise|pop". An element
   rises once only, however many times enter() or arrive() reach it. */
const seen = new WeakSet();
const fresh = (el) => (seen.has(el) ? false : (seen.add(el), true));
export function enter(root = document) {
  if (!still()) {
    [...root.querySelectorAll('[data-a="rise"]')].filter(fresh).forEach((el, i) => el.animate(
      [{ opacity: 0, translate: '0 22px', filter: 'blur(10px)' }, { opacity: 1, translate: '0 0', filter: 'blur(0px)' }],
      { duration: 900, delay: i * 75, easing: SOFT, fill: 'backwards' }));
    [...root.querySelectorAll('[data-a="pop"]')].filter(fresh).forEach((el, i) => el.animate(
      [{ scale: '.6', opacity: 0 }, { scale: '1', opacity: 1 }], { duration: 600, delay: 560 + i * 30, easing: SOFT, fill: 'backwards' }));
  }
  countUps(root);
}

/* Count-up: 1.5s ease-out, never past the real value. <span data-count="1842500" data-format="inr">. */
export const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const counted = new WeakSet();
export function countUps(root = document) {
  root.querySelectorAll('[data-count]').forEach((el) => {
    if (counted.has(el)) return;
    counted.add(el);
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
  }, true);
  wireFeel();
  /* The hero's light follows the cursor (Glass 2): it fades in where the pointer enters, trails it smoothly,
     and fades out when the pointer leaves. Pause and reduced motion keep it off. */
  let lit = null, spotFrame = 0, last = null;
  const place = (hero, ev) => {
    const b = hero.getBoundingClientRect();
    hero.style.setProperty('--mx', ((ev.clientX - b.left) / b.width * 100).toFixed(1) + '%');
    hero.style.setProperty('--my', ((ev.clientY - b.top) / b.height * 100).toFixed(1) + '%');
  };
  const unlight = () => { if (lit) lit.classList.remove('is-lit'); lit = null; };
  document.addEventListener('pointermove', (e) => {
    last = e;
    if (spotFrame) return;
    spotFrame = requestAnimationFrame(() => {
      spotFrame = 0;
      const ev = last, hero = ev.target && ev.target.closest ? ev.target.closest('.mg-hero') : null;
      if (hero !== lit) {
        unlight();
        if (!hero || isPaused() || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        hero.classList.add('is-placing'); place(hero, ev); void hero.offsetWidth; hero.classList.remove('is-placing');
        hero.classList.add('is-lit'); lit = hero;
        return;
      }
      if (hero) place(hero, ev);
    });
  }, { passive: true });
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) unlight(); });
  window.MochaGlass = Object.assign(window.MochaGlass || {}, {
    springs: { soft: SOFT, brew: BREW }, switchTheme, jelly, press, enter, arrive, countUps, pause, isPaused, inr,
  });
}

/* ── Feel (PR 14) ─────────────────────────────────────────────────────────── */

/* Page arrival, on every route change: sections rise in on the soft stagger, the
   first rows of a list fade up (10 at most, then instant), figures count up and
   progress bars fill. It watches the page for 1.2s so sections and rows that
   arrive with their data still get it; after that nothing animates on a
   re-render, so sorting, filtering and typing stay instant. Never blocks input. */
const ROWS = '.mg-table tbody tr, .mg-row, .app-row, .app-ib__row, .app-diary__row, a.app-recrow, .set-index__row, .app-note';
const SECTION = '[data-a="rise"]';
let arrival = null;
export function arrive(root) {
  if (!root || typeof MutationObserver === 'undefined') return;
  if (arrival) arrival.stop();
  let sections = 0, rows = 0;
  const t0 = performance.now();
  const all = (scope, sel) => [...(scope.matches && scope.matches(sel) ? [scope] : []), ...scope.querySelectorAll(sel)];
  const run = (scope) => {
    const quiet = still();
    all(scope, SECTION).filter(fresh).forEach((el) => {
      if (quiet || sections >= 8) return;
      el.animate([{ opacity: 0, translate: '0 14px' }, { opacity: 1, translate: '0 0' }],
        { duration: 560, delay: Math.max(0, sections * 55 - (performance.now() - t0)), easing: SOFT, fill: 'backwards' });
      sections += 1;
    });
    if (!quiet) {
      all(scope, ROWS).filter(fresh).forEach((el) => {
        if (rows >= 10) return;
        el.animate([{ opacity: 0, translate: '0 6px' }, { opacity: 1, translate: '0 0' }],
          { duration: 300, delay: rows * 28, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' });
        rows += 1;
      });
      all(scope, '.mg-progress > *').filter(fresh).forEach((el) => {
        el.animate([{ scale: '0 1' }, { scale: '1 1' }], { duration: 900, delay: 120, easing: SOFT, fill: 'backwards' });
      });
    }
    countUps(scope);
  };
  run(root);
  const mo = new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) run(n);
  });
  mo.observe(root, { childList: true, subtree: true });
  const handle = {};
  const timer = setTimeout(() => handle.stop(), 1200);
  handle.stop = () => { mo.disconnect(); clearTimeout(timer); if (arrival === handle) arrival = null; };
  arrival = handle;
}

function wireFeel() {
  const html = document.documentElement;
  /* Keyboard moves are instant: highlights in menus and lists skip their fade
     while keys drive them; the pointer brings the fade back. */
  const NAV = /^(Arrow|Tab$|Home$|End$|Page|Enter$|Escape$| $)/;
  document.addEventListener('keydown', (e) => { if (NAV.test(e.key)) html.classList.add('mg-kbd'); }, true);
  document.addEventListener('pointermove', () => { if (html.classList.contains('mg-kbd')) html.classList.remove('mg-kbd'); }, { passive: true, capture: true });

  /* While anything scrolls, the scene's blobs hold still (feel.css), so the glass
     never re-blurs a moving scene and a moving page in the same frame. */
  let idle = 0;
  document.addEventListener('scroll', () => {
    if (!idle) html.classList.add('mg-scrolling'); else clearTimeout(idle);
    idle = setTimeout(() => { idle = 0; html.classList.remove('mg-scrolling'); }, 160);
  }, { passive: true, capture: true });

  /* Tabs: the caramel underline glides from the old tab to the new one and the
     panel under it fades in fast. Counts bump when their number changes. */
  const bumped = new WeakMap();
  const mo = new MutationObserver((list) => {
    if (still()) return;
    let from = null, to = null;
    for (const m of list) {
      if (m.type === 'attributes') {
        const el = m.target;
        if (!el.closest || !el.closest('.mg-tabs')) continue;
        if (el.getAttribute('aria-selected') === 'true') to = el; else if (m.oldValue === 'true') from = el;
        continue;
      }
      const host = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const count = host && host.closest ? host.closest('.mg-count') : null;
      if (!count || !count.isConnected || !count.animate) continue;
      const at = performance.now();
      if (at - (bumped.get(count) || 0) < 400) continue;
      bumped.set(count, at);
      count.animate([{ scale: '1' }, { scale: '1.28' }, { scale: '1' }], { duration: 420, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    }
    if (from && to && from.isConnected && to.isConnected && from.parentElement === to.parentElement && to.animate) {
      const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
      const s = Math.max(0.05, (a.width - 20) / Math.max(1, b.width - 20));
      try {
        to.animate([{ transform: `translateX(${a.left - b.left}px) scaleX(${s})` }, { transform: 'none' }],
          { duration: 420, easing: SOFT, pseudoElement: '::after' });
      } catch { /* no pseudo-element animation here */ }
      const id = to.getAttribute('aria-controls');
      const panel = (id && document.getElementById(id)) || to.closest('.mg-tabs').nextElementSibling;
      if (panel && panel.animate) panel.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
    }
  });
  mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['aria-selected'], attributeOldValue: true, childList: true, characterData: true });
}
