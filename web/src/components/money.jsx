import { CircleAlert, Info, TriangleAlert, CircleCheck } from 'lucide-react';
import { cn } from 'cn';

/**
 * The Wave 5 (Money) building blocks, from the Mocha Glass classes: the dark
 * hero with its collected / expected bar, a banner in the four tones, the
 * small facts box a money dialog opens with, and the failed-save banner
 * every money dialog shows inside itself (DialogErrors) rather than as a
 * toast that disappears with the reason.
 */

/**
 * The chocolate hero: a label, the big figure (counted up on entrance), a
 * sentence, then a bar of `done` (solid) and `expected` (hatched) shares in
 * percent, and the legend under it.
 */
export function MoneyHero({ label, figure, count, sub, done, expected, legend, aria, children, className, figureAside }) {
  return (
    <section className={cn('mg-hero app-mhero', className)} data-a="rise" aria-label={typeof label === 'string' ? label : undefined}>
      <div className="mg-hero__label">{label}</div>
      <div className="app-mhero__figure">
        <span className="mg-hero__figure mg-num" data-count={count != null ? Math.round(count) : undefined} data-format={count != null ? 'inr' : undefined}>{figure}</span>
        {figureAside && <span className="app-mhero__aside mg-num">{figureAside}</span>}
      </div>
      {sub && <div className="mg-hero__sub">{sub}</div>}
      {(done != null || expected != null || legend) && (
        <div className="app-mhero__foot">
          {(done != null || expected != null) && (
            <div className="mg-progress" role="img" aria-label={aria}>
              <span className="mg-progress__done relative overflow-hidden" style={{ width: `${clamp(done)}%` }}><span className="mg-shimmer" /></span>
              <span className="mg-progress__expected" style={{ width: `${clamp(expected)}%` }} />
            </div>
          )}
          {legend && <div className="mg-legend app-mhero__legend">{legend}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));

/** One legend entry: a swatch (solid, hatched or plain) and its words. */
export function Key({ swatch = 'solid', children }) {
  return (
    <span>
      <i className={cn(swatch === 'hatch' && 'mg-hatch', swatch === 'empty' && 'app-key--empty')} style={swatch === 'solid' ? { background: 'currentColor' } : typeof swatch === 'object' ? swatch : undefined} />
      {children}
    </span>
  );
}

const BANNER_ICON = { late: CircleAlert, wait: TriangleAlert, ok: CircleCheck, info: Info };

/** A banner in a tone: the icon, a bold first line, the rest, and one button. */
export function MoneyBanner({ tone = 'info', title, children, action, icon, role = 'status', className }) {
  const Icon = icon || BANNER_ICON[tone] || Info;
  return (
    <div className={cn('mg-banner', tone !== 'info' && `mg-banner--${tone}`, className)} role={role}>
      <Icon aria-hidden="true" />
      <div className="mg-banner__body">
        {title && <strong>{title}</strong>}
        {children}
      </div>
      {action && <div className="app-banner__act">{action}</div>}
    </div>
  );
}

/**
 * DialogErrors: a save the server refused. The reason stays in the dialog,
 * the field it names is marked by its own Field, and the button offers
 * "Try again" when nothing in the form was wrong.
 */
export function DialogError({ error, what = 'this' }) {
  if (!error) return null;
  return (
    <div className="mg-banner mg-banner--late" role="alert" tabIndex={-1} ref={(el) => el?.focus()}>
      <CircleAlert aria-hidden="true" />
      <div className="mg-banner__body"><strong>Couldn't save {what}.</strong>{error}</div>
    </div>
  );
}

/** The small track box a money dialog opens with: "Stage value … · Already received … · Outstanding …". */
export function MoneyFacts({ icon: Icon, items, className }) {
  return (
    <div className={cn('app-mfacts', className)}>
      {Icon && <Icon aria-hidden="true" />}
      <span className="app-mfacts__items">
        {items.filter(Boolean).map((it) => (
          <span key={it.label}>{it.label} <b className={cn('mg-num', it.tone && `is-${it.tone}`)}>{it.value}</b></span>
        ))}
      </span>
    </div>
  );
}

/** A skeleton panel shaped like what is coming. */
export function SkelPanel({ rows = 4, className, style }) {
  return (
    <section className={cn('mg-glass mg-panel', className)} aria-busy="true" aria-label="Loading" data-a="rise" style={style}>
      <div className="mg-skel" style={{ height: 12, width: '30%' }} />
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="mg-skel" style={{ height: 44, width: i === rows - 1 ? '80%' : undefined }} />)}
    </section>
  );
}

/** Days from today to an ISO date (negative = past). */
export function daysTo(iso) {
  if (!iso) return null;
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((d - t) / 864e5);
}

/** "5 Oct" — the money screens' one date style (the year only when it is not this one). */
export function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '—';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}
