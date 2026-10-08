import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, Check, Table as TableIcon } from 'lucide-react';
import { cn } from 'cn';
import { useMediaQuery } from '../lib/hooks.js';
import { money, number } from '../lib/format.js';
import { still } from '../styles/mocha/motion.js';

/**
 * The Mocha Glass chart kit for Insights and Reports (Wave 7).
 *
 * Every chart is drawn in HTML from the system's tokens: money in `figure`,
 * expected money hatched in caramel, labels muted, a value printed on every
 * bar so nothing needs a tooltip, and each bar a real link (keyboard and
 * touch reach) when it opens a list. A zero keeps a 2px sliver.
 *
 * Every chart also has a table twin (#22). In chart mode the twin is in the
 * document as plain, visually hidden text, so a screen reader always gets the
 * numbers; "Open as table" swaps the chart for the real table, whose first
 * cells are the links. On a phone, columns become rows on the same scale and
 * the table becomes phone rows.
 *
 * Bars grow once with a 6% overshoot, staggered within their own chart;
 * pause and reduced motion leave them drawn.
 */

export const inr = (value) => money(value, 'INR', { compact: true });
export const inrFull = (value) => money(value, 'INR');

/* --------------------------------------------------------------- scale */

/** A rounded top and its ticks (0 first), so every tick is a value the scale reaches. */
export function niceScale(max, count = 4, integer = true) {
  const m = Math.max(Number(max) || 0, 0);
  if (m <= 0) return { top: 1, ticks: [0, 1] };
  const raw = m / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * pow).find((s) => s >= raw) || 10 * pow;
  const whole = step >= 1 || !integer ? step : 1;
  const top = Math.ceil(m / whole) * whole;
  const ticks = [];
  for (let v = 0; v <= top + whole / 2; v += whole) ticks.push(v);
  return { top, ticks };
}

const pct = (v, top) => (top > 0 ? Math.max(0, (100 * Number(v || 0)) / top) : 0);
const sum = (segs) => segs.reduce((n, s) => n + Math.max(0, Number(s.v) || 0), 0);
const barsOf = (r) => r.bars || [r.segs || [{ v: r.v, tone: r.tone }]];

/* --------------------------------------------------------------- legend */

const SOLID = { figure: 'var(--figure)', wait: 'var(--wait)', late: 'var(--late)', info: 'var(--info)', ok: 'var(--ok)' };

/** A key for a multi-colour chart: [{ tone, label }]. Words, never colour alone. */
export function Legend({ items, className }) {
  return (
    <div className={cn('mg-legend rp-legend', className)}>
      {items.map((it) => (
        <span key={it.label}>
          <i className={SOLID[it.tone] ? undefined : `is-${it.tone}`} style={SOLID[it.tone] ? { background: SOLID[it.tone] } : undefined} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function Segs({ segs, total, axis }) {
  return segs.filter((s) => Number(s.v) > 0).map((s, i) => (
    <span
      key={i}
      className={`rp-seg rp-seg--${s.tone || 'figure'}`}
      style={axis === 'x' ? { width: `${(100 * Number(s.v)) / total}%` } : { height: `${(100 * Number(s.v)) / total}%` }}
    />
  ));
}

/* ----------------------------------------------------------- row bars */

/**
 * Horizontal bars, one row each: the name, the bar on a shared scale, the value.
 * rows: { key, label, value (printed), aria, href?, segs: [{ v, tone }] } or `bars` for several.
 */
export function RowBars({ label, rows, lw = 132, vw = 112, max, format = number, axis = true, integer = true }) {
  const top = niceScale(max ?? Math.max(0, ...rows.flatMap((r) => barsOf(r).map(sum))), 4, integer);
  return (
    <div className="rp-bars" role="group" aria-label={label} style={{ '--lw': `${lw}px`, '--vw': `${vw}px` }}>
      {rows.map((r) => {
        const inner = (
          <>
            <span className="rp-bar__l" aria-hidden="true">{r.label}</span>
            <span className="rp-bar__t" aria-hidden="true">
              <span className="flex w-full flex-col justify-center gap-1">
                {barsOf(r).map((segs, i) => {
                  const total = sum(segs);
                  return (
                    <span key={i} className="rp-bar__fill" data-grow="x" style={{ width: `${pct(total, top.top)}%`, height: barsOf(r).length > 1 ? 10 : undefined }}>
                      {total > 0 ? <Segs segs={segs} total={total} axis="x" /> : <span className={`rp-seg rp-seg--${segs[0]?.tone || 'figure'}`} style={{ width: 2 }} />}
                    </span>
                  );
                })}
              </span>
            </span>
            <span className="rp-bar__v" aria-hidden="true">{r.value}</span>
          </>
        );
        return r.href
          ? <Link key={r.key} className="rp-bar" to={r.href} aria-label={r.aria}>{inner}</Link>
          : <div key={r.key} className="rp-bar" role="img" aria-label={r.aria}>{inner}</div>;
      })}
      {axis && (
        <div className="rp-axis" aria-hidden="true">
          <span>{top.ticks.map((t) => <i key={t} style={{ left: `${pct(t, top.top)}%` }}>{format(t)}</i>)}</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ columns */

/**
 * Vertical columns on a shared scale. rows: { key, label (x), value (printed),
 * aria, href?, segs | bars, target? }. On a phone they become RowBars.
 */
export function ColBars({ label, rows, height = 170, format = number, lw = 72, vw = 96, integer = true }) {
  const wide = useMediaQuery('(min-width: 640px)');
  const max = Math.max(0, ...rows.flatMap((r) => [...barsOf(r).map(sum), Number(r.target) || 0]));
  if (!wide) return <RowBars label={label} rows={rows} lw={lw} vw={vw} max={max} format={format} axis={false} integer={integer} />;
  const top = niceScale(max, 4, integer);
  const y = (v) => height + 20 - (height * pct(v, top.top)) / 100;
  const n = rows.length;
  // Too many columns for every name: label every few, the rest stay in the table and the bar's name.
  const every = n > 16 ? Math.ceil(n / 8) : 1;
  return (
    <div className="rp-cols" style={{ '--h': `${height}px` }}>
      <div className="rp-cols__axis" aria-hidden="true">
        {top.ticks.map((t) => <i key={t} style={{ top: y(t) }}>{format(t)}</i>)}
      </div>
      <div className="rp-cols__plot" role="group" aria-label={label}>
        <div className="rp-cols__grid" aria-hidden="true">
          {top.ticks.map((t) => <span key={t} style={{ top: y(t) - 20 }} />)}
        </div>
        {rows.some((r) => r.target != null) && (
          <div className="rp-cols__target" aria-hidden="true">
            {rows.map((r, i) => (r.target == null ? null : (
              <span key={r.key} style={{ left: `${(100 * i) / n}%`, width: `${100 / n}%`, top: y(r.target) - 20 }} />
            )))}
          </div>
        )}
        {rows.map((r, idx) => {
          const inner = (
            <>
              <span className="rp-col__stack" aria-hidden="true">
                <span className="rp-col__v">{r.value}</span>
                <span className="rp-col__bars">
                  {barsOf(r).map((segs, i) => {
                    const total = sum(segs);
                    const h = Math.max(2, (height * pct(total, top.top)) / 100);
                    return (
                      <span key={i} className="rp-col__fill" data-grow="y" style={{ height: h }}>
                        {total > 0 ? <Segs segs={segs} total={total} axis="y" /> : <span className={`rp-seg rp-seg--${segs[0]?.tone || 'figure'}`} style={{ height: 2 }} />}
                      </span>
                    );
                  })}
                </span>
              </span>
              <span className={every > 1 ? 'rp-col__x rp-col__x--free' : 'rp-col__x'} aria-hidden="true" title={r.label}>{idx % every === 0 ? r.label : ' '}</span>
            </>
          );
          return r.href
            ? <Link key={r.key} className="rp-col" to={r.href} aria-label={r.aria}>{inner}</Link>
            : <div key={r.key} className="rp-col" role="img" aria-label={r.aria}>{inner}</div>;
        })}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- the block */

/** Grow the bars of one chart once, staggered within it. */
function useGrow(ref, on) {
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!on || done.current || !el) return;
    done.current = true;
    if (still() || !el.animate) return;
    el.querySelectorAll('[data-grow="y"]').forEach((b, i) => b.animate(
      [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1.06)', offset: 0.7 }, { transform: 'scaleY(1)' }],
      { duration: 850, delay: 260 + Math.min(i, 24) * 50, easing: 'ease-out', fill: 'backwards' },
    ));
    el.querySelectorAll('[data-grow="x"]').forEach((b, i) => b.animate(
      [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1.06)', offset: 0.7 }, { transform: 'scaleX(1)' }],
      { duration: 900, delay: 260 + Math.min(i, 24) * 60, easing: 'ease-out', fill: 'backwards' },
    ));
  }, [ref, on]);
}

/** The one-line empty a chart with nothing to draw shows instead of bare axes. */
export function ChartEmpty({ children, plain = false }) {
  return (
    <div className={cn('rp-chart-empty', plain && 'rp-chart-empty--plain')}>
      <span aria-hidden="true"><Check className="size-[15px]" strokeWidth={1.8} /></span>{children}
    </div>
  );
}

/**
 * A chart and its table twin under an h3, with the toggle beside the title.
 *
 * columns: header strings; rows: { key, cells, href? } (the first cell links);
 * foot: a total row's cells; empty: a sentence shown instead when there is
 * nothing to draw; tools: controls beside the title; note: lines under it.
 */
export function ChartBlock({ title, meta, legend, tools, columns, rows, foot, note, empty, emptyPlain, children, className }) {
  const [asTable, setAsTable] = useState(false);
  const wide = useMediaQuery('(min-width: 720px)');
  const captionId = useId();
  const ref = useRef(null);
  useGrow(ref, !asTable && !empty);
  const caption = meta ? `${title} — ${meta}` : title;

  return (
    <div className={cn('rp-block', className)} data-slot="card" ref={ref}>
      <div className="rp-bhead">
        <h3 className="rp-btitle">{title}</h3>
        {tools}
        {!empty && (
          <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm rp-toggle" onClick={() => setAsTable(!asTable)}>
            {asTable
              ? <><BarChart3 className="size-4" strokeWidth={1.8} aria-hidden="true" />Show the chart</>
              : <><TableIcon className="size-4" strokeWidth={1.8} aria-hidden="true" />Open as table</>}
          </button>
        )}
      </div>
      {meta && <p className="rp-meta">{meta}</p>}
      {empty ? (
        <ChartEmpty plain={emptyPlain}>{empty}</ChartEmpty>
      ) : asTable ? (
        wide ? (
          <div className="mg-tablewrap rp-twin">
            <table className="mg-table">
              <caption className="sr-only">{caption}</caption>
              <thead><tr>{columns.map((c, i) => <th key={c} scope="col" className={i ? 'num' : undefined}>{c}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    {r.cells.map((cell, i) => (
                      <td key={columns[i]} className={i ? 'num' : 'strong'}>
                        {i === 0 && r.href ? <Link className="rp-link" to={r.href}>{cell}</Link> : cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {foot && <tfoot><tr>{foot.map((cell, i) => <td key={columns[i]} className={i ? 'num' : undefined}>{cell}</td>)}</tr></tfoot>}
            </table>
          </div>
        ) : (
          <div className="mg-rows rp-twin" role="table" aria-label={caption}>
            {[...rows, ...(foot ? [{ key: '__total', cells: foot, total: true }] : [])].map((r) => {
              const last = r.cells.length - 1;
              const inner = (
                <>
                  <span className="mg-row__title" role="cell">{r.cells[0]}</span>
                  <span className="mg-row__amount mg-num" role="cell"><span className="rp-rl">{columns[last]}</span>{r.cells[last]}</span>
                  {last > 1 && <span className="mg-row__meta" role="cell" style={{ gridColumn: '1 / -1' }}>{r.cells.slice(1, last).map((c, i) => `${columns[i + 1]}: ${c}`).join(' · ')}</span>}
                </>
              );
              return r.href
                ? <Link key={r.key} className="mg-row" role="row" to={r.href}>{inner}</Link>
                : <div key={r.key} className="mg-row" role="row" style={r.total ? { fontWeight: 700 } : undefined}>{inner}</div>;
            })}
          </div>
        )
      ) : (
        <>
          {legend && <Legend items={legend} />}
          {children}
          <div className="sr-only">
          <table>
            <caption id={captionId}>{caption}</caption>
            <thead><tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            <tbody>{rows.map((r) => <tr key={r.key}>{r.cells.map((cell, i) => <td key={columns[i]}>{cell}</td>)}</tr>)}</tbody>
          </table>
          </div>
        </>
      )}
      {note}
    </div>
  );
}

/** One muted line under a chart. */
export function Note({ children }) {
  return children ? <p className="rp-note">{children}</p> : null;
}

/* ------------------------------------------------------------ colours */

/** Ageing escalates: not late, late, properly late. Red is only for the last. */
export const AGE_TONE = { 'not-due': 'info', '1-30': 'wait', '31-60': 'wait', '61-90': 'late', '90+': 'late' };
