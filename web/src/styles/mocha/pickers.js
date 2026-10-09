/* Mocha Glass pickers: every date, month, date-and-time and time field inside .mg opens the
   Mocha Glass calendar instead of the browser's own; file fields light up while a file is dragged
   over them and show the chosen file. Load after bundle.css. Typing into a field stays as it is. */
(function () {
  'use strict';
  var MG = window.MochaGlass = window.MochaGlass || {};
  if (MG.pickers) return;

  var KINDS = { date: 1, month: 1, 'datetime-local': 1, time: 1 };
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  var ICON = {
    prev: 'M15 18l-6-6 6-6', next: 'M9 18l6-6-6-6', down: 'M6 9l6 6 6-6'
  };
  var pop = null, cur = null, closedFor = null, closedAt = 0;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function label12(t) { var h = +t.slice(0, 2), m = t.slice(3); return ((h % 12) || 12) + ':' + m + (h < 12 ? ' am' : ' pm'); }
  function today() { var t = new Date(); return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() }; }
  function key(y, m, d) { return y * 10000 + m * 100 + d; }
  function parse(kind, v) {
    var r = { sel: null, time: null };
    if (!v) return r;
    var dm = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(v), tm = /(\d{2}):(\d{2})/.exec(kind === 'time' ? v : v.split('T')[1] || '');
    if (dm && kind !== 'time') r.sel = { y: +dm[1], m: +dm[2] - 1, d: dm[3] ? +dm[3] : 1 };
    if (tm) r.time = tm[1] + ':' + tm[2];
    return r;
  }
  function bound(input, which) { var p = parse(input.type, input.getAttribute(which) || ''); return p.sel ? key(p.sel.y, p.sel.m, input.type === 'month' ? (which === 'min' ? 1 : 31) : p.sel.d) : null; }
  function svg(d) {
    var ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg'), p = document.createElementNS(ns, 'path');
    s.setAttribute('width', '16'); s.setAttribute('height', '16'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    p.setAttribute('d', d); s.appendChild(p); return s;
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(cls, text, label, fn) {
    var b = el('button', cls, text); b.type = 'button'; if (label) b.setAttribute('aria-label', label);
    b.addEventListener('click', fn); return b;
  }

  function setValue(input, v) {
    var set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* Pop-ups live inside the dialog or sheet that holds their field. A modal dialog
     turns pointer events off everywhere else and closes on any click outside it,
     so a calendar or list hung on <body> could not be clicked there. */
  function hostFor(input) {
    return (input && input.closest && input.closest('[role="dialog"]:not(.mg-cal), [role="alertdialog"], [data-slot="dialog-content"], [data-slot="sheet-content"]')) || document.body;
  }
  function mountIn(node, input) {
    var host = hostFor(input);
    if (node.parentNode === host) return;
    if (node.matches(':popover-open')) { try { node.hidePopover(); } catch (e) {} }
    host.appendChild(node);
  }

  function ensurePop() {
    if (pop && pop.isConnected) return pop;
    pop = el('div', 'mg mg-cal');
    pop.setAttribute('popover', 'auto');
    pop.setAttribute('role', 'dialog');
    pop.addEventListener('toggle', function (e) {
      if (e.newState !== 'closed') return;
      closedFor = cur && cur.input; closedAt = Date.now(); cur = null;
      window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place);
    });
    pop.addEventListener('keydown', onKey);
    document.body.appendChild(pop);
    return pop;
  }

  function open(input, focusGrid) {
    if (!input || input.disabled || input.readOnly || !KINDS[input.type]) return;
    var kind = input.type, p = parse(kind, input.value), t = today(), anchor = p.sel || t;
    cur = { input: input, kind: kind, view: kind === 'month' ? 'months' : 'days', y: anchor.y, m: anchor.m, sel: p.sel, time: p.time, focus: null, slide: '' };
    var P = ensurePop(); mountIn(P, input); var host = input.closest('[data-theme]');
    if (host) P.setAttribute('data-theme', host.getAttribute('data-theme')); else P.removeAttribute('data-theme');
    P.setAttribute('aria-label', kind === 'time' ? 'Choose a time' : kind === 'month' ? 'Choose a month' : 'Choose a date');
    render();
    if (!P.matches(':popover-open')) { try { P.showPopover(); } catch (e) { return; } }
    place();
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place);
    if (focusGrid) focusCurrent();
  }
  function close(refocus) {
    var input = cur && cur.input;
    if (pop && pop.matches(':popover-open')) pop.hidePopover();
    if (refocus && input && input.isConnected) { try { input.focus({ preventScroll: true }); } catch (e) {} }
  }

  function place() {
    if (!cur || !pop) return;
    var r = cur.input.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - w - 8)), below = r.bottom + 6, up = r.top - h - 6;
    var top = below + h <= vh - 8 || up < 8 ? Math.min(below, Math.max(8, vh - h - 8)) : up;
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    pop.style.setProperty('--pop-origin', (top < r.top ? 'bottom ' : 'top ') + (r.left + 20 - left) + 'px');
    pop.style.setProperty('--pop-y', (top < r.top ? '8px' : '-8px'));
  }

  function pickDay(y, m, d) {
    var c = cur; c.sel = { y: y, m: m, d: d }; c.y = y; c.m = m; c.focus = d;
    if (c.kind === 'date') { setValue(c.input, y + '-' + pad(m + 1) + '-' + pad(d)); close(true); return; }
    if (!c.time) c.time = '09:00';
    setValue(c.input, y + '-' + pad(m + 1) + '-' + pad(d) + 'T' + c.time);
    render(); focusCurrent();
  }
  function pickMonth(m) {
    var c = cur;
    if (c.kind === 'month') { c.sel = { y: c.y, m: m, d: 1 }; setValue(c.input, c.y + '-' + pad(m + 1)); close(true); return; }
    c.m = m; c.view = 'days'; c.slide = ''; render(); focusCurrent();
  }
  function pickTime(t) {
    var c = cur; c.time = t;
    if (c.kind === 'time') { setValue(c.input, t); close(true); return; }
    var s = c.sel || today(); c.sel = s;
    setValue(c.input, s.y + '-' + pad(s.m + 1) + '-' + pad(s.d) + 'T' + t); close(true);
  }
  function shift(n) {
    var c = cur;
    if (c.view === 'months') { c.y += n; c.slide = n > 0 ? 'l' : 'r'; }
    else { var d = new Date(c.y, c.m + n, 1); c.y = d.getFullYear(); c.m = d.getMonth(); c.slide = n > 0 ? 'l' : 'r'; }
    c.focus = null; render();
  }

  function render() {
    var c = cur, P = pop, t = today(), min = bound(c.input, 'min'), max = bound(c.input, 'max');
    P.className = 'mg mg-cal' + (c.kind === 'datetime-local' ? ' mg-cal--wide' : '') + (c.kind === 'time' ? ' mg-cal--time' : '');
    var body = el('div', 'mg-cal__body');
    if (c.kind !== 'time') {
      var main = el('div', 'mg-cal__main'), head = el('div', 'mg-cal__head');
      var title = btn('mg-cal__title', c.view === 'months' ? String(c.y) : MONTHS[c.m] + ' ' + c.y, null, function () {
        if (c.kind === 'month') return;
        c.view = c.view === 'months' ? 'days' : 'months'; c.slide = ''; render(); focusCurrent();
      });
      if (c.kind !== 'month') { title.appendChild(svg(ICON.down)); title.setAttribute('aria-expanded', String(c.view === 'months')); title.setAttribute('aria-label', (c.view === 'months' ? 'Back to the days of ' : 'Pick a month, now ') + MONTHS[c.m] + ' ' + c.y); }
      else title.disabled = true;
      var unit = c.view === 'months' ? 'year' : 'month';
      var prev = btn('mg-cal__nav', null, 'Previous ' + unit, function () { shift(-1); }); prev.appendChild(svg(ICON.prev));
      var next = btn('mg-cal__nav', null, 'Next ' + unit, function () { shift(1); }); next.appendChild(svg(ICON.next));
      head.appendChild(title); head.appendChild(prev); head.appendChild(next); main.appendChild(head);
      var grid;
      if (c.view === 'months') {
        grid = el('div', 'mg-cal__grid mg-cal__grid--months'); grid.setAttribute('role', 'grid');
        MONTHS.forEach(function (name, i) {
          var off = (min && key(c.y, i, 31) < min) || (max && key(c.y, i, 1) > max);
          var b = btn('mg-cal__day', name.slice(0, 3), name + ' ' + c.y, function () { pickMonth(i); });
          b.dataset.i = i; b.disabled = !!off;
          if (c.y === t.y && i === t.m) b.classList.add('is-today');
          if (c.sel && c.sel.y === c.y && c.sel.m === i) b.setAttribute('aria-selected', 'true');
          grid.appendChild(b);
        });
      } else {
        var dow = el('div', 'mg-cal__dow'); DOW.forEach(function (d) { dow.appendChild(el('span', null, d)); }); main.appendChild(dow);
        grid = el('div', 'mg-cal__grid'); grid.setAttribute('role', 'grid'); grid.setAttribute('aria-label', MONTHS[c.m] + ' ' + c.y);
        var first = new Date(c.y, c.m, 1).getDay();
        for (var i = 0; i < 42; i++) {
          (function (dt) {
            var y = dt.getFullYear(), m = dt.getMonth(), d = dt.getDate(), k = key(y, m, d);
            var b = btn('mg-cal__day', String(d), DAYS[dt.getDay()] + ', ' + d + ' ' + MONTHS[m] + ' ' + y, function () { pickDay(y, m, d); });
            if (m !== c.m) { b.classList.add('is-out'); b.tabIndex = -1; } else b.dataset.d = d;
            if (k === key(t.y, t.m, t.d)) { b.classList.add('is-today'); b.setAttribute('aria-current', 'date'); }
            if (c.sel && k === key(c.sel.y, c.sel.m, c.sel.d)) b.setAttribute('aria-selected', 'true');
            if ((min && k < min) || (max && k > max)) b.disabled = true;
            grid.appendChild(b);
          })(new Date(c.y, c.m, 1 - first + i));
        }
      }
      if (c.slide) grid.classList.add('is-slide-' + c.slide);
      main.appendChild(grid); body.appendChild(main);
    }
    if (c.kind === 'time' || c.kind === 'datetime-local') {
      var list = el('div', 'mg-cal__times'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Time');
      var picked = null;
      for (var q = 0; q < 96; q++) {
        var tt = pad(Math.floor(q / 4)) + ':' + pad((q % 4) * 15);
        (function (tt) {
          var o = btn('mg-cal__time', label12(tt), null, function () { pickTime(tt); });
          o.setAttribute('role', 'option');
          if (c.time === tt) { o.setAttribute('aria-selected', 'true'); picked = o; }
          list.appendChild(o);
        })(tt);
      }
      body.appendChild(list);
      requestAnimationFrame(function () {
        var target = picked || list.children[36];
        if (target) list.scrollTop = target.offsetTop - list.clientHeight / 2 + target.offsetHeight / 2;
      });
    }
    var foot = el('div', 'mg-cal__foot');
    var nowLabel = c.kind === 'time' ? 'Now' : c.kind === 'month' ? 'This month' : 'Today';
    foot.appendChild(btn(null, nowLabel, null, function () {
      var n = new Date(), tt = pad(n.getHours()) + ':' + pad(Math.floor(n.getMinutes() / 15) * 15);
      if (c.kind === 'time') pickTime(tt);
      else if (c.kind === 'month') { c.y = n.getFullYear(); pickMonth(n.getMonth()); }
      else if (c.kind === 'datetime-local') { c.time = c.time || tt; pickDay(n.getFullYear(), n.getMonth(), n.getDate()); }
      else pickDay(n.getFullYear(), n.getMonth(), n.getDate());
    }));
    if (!c.input.required) foot.appendChild(btn(null, 'Clear', 'Clear the field', function () { setValue(c.input, ''); close(true); }));
    if (c.kind === 'datetime-local') { var done = btn('mg-cal__done', 'Done', null, function () { close(true); }); foot.appendChild(done); }
    P.replaceChildren(body, foot);
  }

  function focusCurrent() {
    var c = cur; if (!c || !pop) return;
    var g = pop.querySelector('.mg-cal__grid'), b = null;
    if (!g) { b = pop.querySelector('.mg-cal__time[aria-selected="true"]') || pop.querySelectorAll('.mg-cal__time')[36]; }
    else if (c.view === 'months') b = g.querySelector('[aria-selected="true"]') || g.querySelector('.is-today') || g.querySelector('[data-i="' + c.m + '"]');
    else {
      var d = c.focus || (c.sel && c.sel.y === c.y && c.sel.m === c.m ? c.sel.d : null) || (today().y === c.y && today().m === c.m ? today().d : 1);
      b = g.querySelector('[data-d="' + d + '"]');
    }
    if (b) b.focus({ preventScroll: true });
  }

  function onKey(e) {
    if (!cur) return;
    var c = cur, t = e.target;
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (t.classList.contains('mg-cal__time')) {
      var dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (dir) { e.preventDefault(); var n = dir > 0 ? t.nextElementSibling : t.previousElementSibling; if (n) n.focus(); }
      return;
    }
    if (!t.classList.contains('mg-cal__day')) return;
    if (c.view === 'months') {
      var mi = +t.dataset.i, step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[e.key];
      if (step == null) return;
      e.preventDefault(); var nm = mi + step;
      if (nm < 0 || nm > 11) { c.y += nm < 0 ? -1 : 1; nm = (nm + 12) % 12; c.slide = ''; c.m = nm; render(); }
      var nb = pop.querySelector('[data-i="' + nm + '"]'); if (nb) nb.focus();
      return;
    }
    var d = +t.dataset.d; if (!d) return;
    var delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key], dt;
    if (delta != null) dt = new Date(c.y, c.m, d + delta);
    else if (e.key === 'PageUp' || e.key === 'PageDown') dt = new Date(c.y, c.m + (e.key === 'PageUp' ? -1 : 1), Math.min(d, 28));
    else if (e.key === 'Home' || e.key === 'End') { var wd = new Date(c.y, c.m, d).getDay(); dt = new Date(c.y, c.m, d + (e.key === 'Home' ? -wd : 6 - wd)); }
    else return;
    e.preventDefault();
    if (dt.getMonth() !== c.m || dt.getFullYear() !== c.y) { c.y = dt.getFullYear(); c.m = dt.getMonth(); c.slide = ''; c.focus = dt.getDate(); render(); }
    else c.focus = dt.getDate();
    focusCurrent();
  }

  function fieldOf(t) { return t && t.closest ? t.closest('input') : null; }
  function enhanced(i) { return i && KINDS[i.type] && i.closest('.mg'); }

  document.addEventListener('click', function (e) {
    var i = fieldOf(e.target);
    if (!enhanced(i)) return;
    e.preventDefault();
    if (closedFor === i && Date.now() - closedAt < 350) { closedFor = null; return; }
    if (cur && cur.input === i) return;
    open(i, false);
  }, true);
  document.addEventListener('keydown', function (e) {
    var i = e.target;
    if (!enhanced(i) || i.tagName !== 'INPUT') return;
    if ((e.altKey && e.key === 'ArrowDown') || e.key === 'F4' || e.key === ' ') { e.preventDefault(); open(i, true); }
  }, true);
  document.addEventListener('input', function (e) {
    if (cur && e.target === cur.input && e.isTrusted) {
      var p = parse(cur.kind, cur.input.value);
      if (p.sel) { cur.sel = p.sel; cur.y = p.sel.y; cur.m = p.sel.m; }
      if (p.time) cur.time = p.time;
      cur.slide = ''; render();
    }
  }, true);

  /* File fields: glow while a file is dragged over, then show the chosen file. */
  function zoneOf(i) { var z = i.closest('.mg-file'); return z || (getComputedStyle(i).opacity === '0' ? i.parentElement : null); }
  function size(n) { return n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function fileField(t) { var i = fieldOf(t); return i && i.type === 'file' && i.closest('.mg') ? i : null; }
  ['dragenter', 'dragover'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { var i = fileField(e.target), z = i && zoneOf(i); if (z) z.classList.add('is-drag'); }, true);
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { var i = fileField(e.target), z = i && zoneOf(i); if (z) z.classList.remove('is-drag'); }, true);
  });
  /* Read the field after the page's own handlers have run: a form that refuses the file (too large,
     wrong type) clears it, and the zone must not keep showing a file that was turned away. */
  function showFile(i, z) {
    var f = i.files || [];
    if (!f.length || z.classList.contains('is-error')) { z.classList.remove('has-file'); z.removeAttribute('data-file'); return; }
    z.setAttribute('data-file', f.length === 1 ? f[0].name + ' · ' + size(f[0].size) : f.length + ' files chosen');
    z.classList.add('has-file');
  }
  document.addEventListener('change', function (e) {
    var i = fileField(e.target), z = i && zoneOf(i); if (!z) return;
    setTimeout(function () { showFile(i, z); }, 0);
  }, true);

  /* Combobox: <input list="id"> with a <datalist>. The browser's suggestion list is swapped for the glass one;
     what you type that isn't listed can still be used ("Use 'X'"; data-new="no" turns that off, data-new-label renames it). */
  var lst = null, lcur = null, picking = false;
  function listPop() {
    if (lst && lst.isConnected) return lst;
    lst = el('div', 'mg mg-list'); lst.setAttribute('popover', 'manual'); lst.setAttribute('role', 'listbox');
    lst.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    document.body.appendChild(lst); return lst;
  }
  function optsOf(i) {
    var d = document.getElementById(i.getAttribute('data-mg-list'));
    return d ? [].slice.call(d.querySelectorAll('option')).map(function (o) { return { v: o.value, l: o.label && o.label !== o.value ? o.label : '' }; }) : [];
  }
  function marked(b, text, q) {
    var k = q ? text.toLowerCase().indexOf(q) : -1;
    if (k < 0) { b.appendChild(document.createTextNode(text)); return; }
    b.appendChild(document.createTextNode(text.slice(0, k))); b.appendChild(el('mark', null, text.slice(k, k + q.length))); b.appendChild(document.createTextNode(text.slice(k + q.length)));
  }
  function placeList() {
    if (!lcur || !lst) return;
    var r = lcur.input.getBoundingClientRect(), w = Math.max(r.width, 220), h = lst.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - w - 8)), top = r.bottom + 6 + h <= vh - 8 || r.top - h - 6 < 8 ? r.bottom + 6 : r.top - h - 6;
    lst.style.width = Math.min(w, vw - 16) + 'px'; lst.style.left = left + 'px'; lst.style.top = top + 'px';
    lst.style.setProperty('--pop-origin', (top < r.top ? 'bottom ' : 'top ') + '24px');
  }
  function hideList() { if (lst && lst.matches(':popover-open')) lst.hidePopover(); lcur = null; window.removeEventListener('scroll', placeList, true); }
  function pickOpt(v) { var i = lcur && lcur.input; if (!i) return; picking = true; setValue(i, v); picking = false; hideList(); }
  function showList(i) {
    var q = i.value.trim().toLowerCase(), all = optsOf(i), exact = false;
    var hits = all.filter(function (o) { if (o.v.toLowerCase() === q) exact = true; return !q || o.v.toLowerCase().indexOf(q) > -1 || o.l.toLowerCase().indexOf(q) > -1; }).slice(0, 60);
    var L = listPop(); mountIn(L, i); var host = i.closest('[data-theme]');
    if (host) L.setAttribute('data-theme', host.getAttribute('data-theme'));
    lcur = { input: i, items: [], active: -1 };
    L.replaceChildren();
    hits.forEach(function (o) {
      var b = el('button', 'mg-list__opt'); b.type = 'button'; b.setAttribute('role', 'option'); b.tabIndex = -1;
      var val = el('span', 'mg-list__val'); marked(val, o.v, q); b.appendChild(val); if (o.l) b.appendChild(el('small', null, o.l));
      if (o.v === i.value) b.setAttribute('aria-selected', 'true');
      b.addEventListener('click', function () { pickOpt(o.v); });
      L.appendChild(b); lcur.items.push(b);
    });
    if (q && !exact && i.getAttribute('data-new') !== 'no') {
      var wrap = el('div', 'mg-list__new'), nb = el('button', 'mg-list__opt'), typed = i.value.trim();
      nb.type = 'button'; nb.tabIndex = -1; nb.textContent = (i.getAttribute('data-new-label') || 'Use') + ' “' + typed + '”';
      nb.addEventListener('click', function () { pickOpt(typed); });
      wrap.appendChild(nb); L.appendChild(wrap); lcur.items.push(nb);
    } else if (!hits.length) L.appendChild(el('div', 'mg-list__empty', 'Nothing matches'));
    if (!L.matches(':popover-open')) { try { L.showPopover(); } catch (e) { return; } }
    placeList(); window.addEventListener('scroll', placeList, true);
  }
  function comboOf(t) {
    if (!t || t.tagName !== 'INPUT' || !t.closest('.mg')) return null;
    if (t.hasAttribute('list')) { t.setAttribute('data-mg-list', t.getAttribute('list')); t.removeAttribute('list'); t.setAttribute('autocomplete', 'off'); t.setAttribute('role', 'combobox'); }
    return t.hasAttribute('data-mg-list') ? t : null;
  }
  document.addEventListener('focusin', function (e) { var i = comboOf(e.target); if (i) showList(i); }, true);
  document.addEventListener('pointerdown', function (e) { var i = comboOf(e.target); if (i && document.activeElement === i && !lcur) showList(i); }, true);
  document.addEventListener('focusout', function (e) { if (lcur && e.target === lcur.input) hideList(); }, true);
  document.addEventListener('input', function (e) { if (picking) return; var i = comboOf(e.target); if (i) showList(i); }, true);
  document.addEventListener('keydown', function (e) {
    if (!lcur || e.target !== lcur.input) return;
    var n = lcur.items.length, a = lcur.active;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!n) return;
      a = e.key === 'ArrowDown' ? (a + 1) % n : (a <= 0 ? n - 1 : a - 1);
      lcur.items.forEach(function (b, k) { b.classList.toggle('is-active', k === a); }); lcur.active = a;
      lcur.items[a].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && a >= 0) { e.preventDefault(); lcur.items[a].click(); }
    else if (e.key === 'Escape') { e.preventDefault(); hideList(); }
  }, true);

  MG.pickers = { open: open, close: close };
})();
