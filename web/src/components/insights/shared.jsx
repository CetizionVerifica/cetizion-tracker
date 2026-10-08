import { useId } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CircleAlert, Info, RefreshCw } from 'lucide-react';
import { cn } from 'cn';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

/**
 * One question on Insights or Reports: a glass panel with the number, the
 * question as an h2, its tools (the ⓘ, CSVs), the one-line answer, then the
 * charts. A section that failed on the server says so in its own panel and
 * offers a retry; the others carry on.
 *
 * `children` is a function, called only once the data is in, so a section
 * never reads a field of a response that has not arrived.
 */
export function Question({ n, question, answer, rule, tools, data, loading, onRetry, wide = false, skeleton = 'cols', children }) {
  const headingId = useId();
  const failed = data?.error;
  return (
    <div className={cn('min-w-0', wide && 'rp-full')}>
      <section className="mg-glass rp-q" data-a="rise" aria-labelledby={headingId} aria-busy={loading && !data ? true : undefined}>
        <div className="rp-qhead">
          <h2 id={headingId} className="rp-qtitle"><span className="rp-qtitle__n">{n}.</span> {question}</h2>
          {(rule || tools) && (
            <div className="rp-qtools">
              {tools}
              {rule && <RuleInfo text={rule} />}
            </div>
          )}
        </div>
        {failed ? (
          <SectionFailed message={data.error} onRetry={onRetry} />
        ) : loading && !data ? (
          <QuestionSkeleton kind={skeleton} />
        ) : data ? (
          <>
            {answer && <p className="rp-answer">{typeof answer === 'string' ? <Lead text={answer} /> : answer}</p>}
            {children()}
          </>
        ) : null}
      </section>
    </div>
  );
}

/** A question that could not be worked out: the reason and Try again, never an all-clear. */
export function SectionFailed({ message, onRetry }) {
  return (
    <div className="mg-banner mg-banner--late" role="alert">
      <CircleAlert aria-hidden="true" />
      <div className="mg-banner__body"><strong>This question couldn't be answered just now</strong>{message} The other questions still load.</div>
      {onRetry && <button type="button" className="mg-btn mg-btn--sm" onClick={onRetry}><RefreshCw className="size-4" strokeWidth={1.8} aria-hidden="true" />Try again</button>}
    </div>
  );
}

export function QuestionSkeleton({ kind = 'cols' }) {
  return (
    <>
      <div className="mg-skel" style={{ height: 14, width: '70%' }} />
      {kind === 'rows' ? (
        [90, 30, 34, 22, 40].map((w) => <div key={w} className="mg-skel" style={{ height: 22, width: `${w}%` }} />)
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, height: 150, padding: '0 12px' }}>
          {[120, 60, 120, 90].map((h, i) => <div key={i} className="mg-skel" style={{ height: h, flex: 1 }} />)}
        </div>
      )}
      <div className="mg-skel" style={{ height: 44 }} />
    </>
  );
}

/** The ⓘ beside a question: the rule, read from the live settings. A pop-over, so a tap opens it too. */
export function RuleInfo({ text, link }) {
  const id = useId();
  return (
    <Popover>
      <PopoverTrigger className="mg-iconbtn" aria-label="How this is worked out" style={{ margin: '-6px -8px -6px 0' }}>
        <Info className="size-[18px]" strokeWidth={1.8} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="end" className="rp-rule" aria-labelledby={id}>
        <h3 className="rp-btitle" id={id}>How this is worked out</h3>
        <p>{text}</p>
        {link}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The few rows to act on first, worst first. A row either opens its record
 * (title link) with a button beside it, or is one link as a whole (`go`),
 * so each row is one tab stop or two, never more.
 *
 * rows: { key, href, title, meta, value, chips?: [{ tone, text }], action?, go?: { label, aria } }
 */
export function ActionList({ title, rows, empty, more }) {
  return (
    <div className="rp-block">
      <div className="rp-bhead">
        <h3 className="rp-btitle">{title}</h3>
        {more && rows.length > 0 && <Link className="rp-link" to={more.to} style={{ marginLeft: 'auto', fontSize: 12.5 }}>{more.label}</Link>}
      </div>
      {rows.length ? (
        <div className="rp-acts">
          {rows.map((r) => {
            const body = (
              <span className="min-w-0">
                {r.go ? <span className="rp-act__t">{r.title}</span> : <Link to={r.href} className="rp-act__t">{r.title}</Link>}
                <span className="rp-act__m">{r.meta}</span>
                {r.chips?.length > 0 && (
                  <span className="rp-act__chips">
                    {r.chips.map((c) => <span key={c.text} className={`mg-badge mg-badge--${c.tone || 'plain'}`}>{c.text}</span>)}
                  </span>
                )}
              </span>
            );
            if (r.go) {
              return (
                <Link key={r.key} className="rp-act" to={r.href} aria-label={r.go.aria}>
                  {body}
                  <span className="rp-act__v">{r.value}</span>
                  <span className="rp-go" aria-hidden="true">{r.go.label}<ArrowRight className="size-3.5" strokeWidth={1.8} /></span>
                </Link>
              );
            }
            return (
              <div key={r.key} className="rp-act">
                {body}
                <span className="rp-act__v">{r.value}</span>
                {r.action}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rp-chart-empty"><span aria-hidden="true">✓</span>{empty}</div>
      )}
    </div>
  );
}

/** A two- or three-way segmented switch (radios), with the sliding thumb. */
export function Seg({ label, value, options, onChange, width = 112 }) {
  const at = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className="mg-seg" role="radiogroup" aria-label={label}>
      <span className="mg-seg__thumb" aria-hidden="true" style={{ width: `calc((100% - 6px) / ${options.length})`, transform: `translateX(${at * 100}%)` }} />
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} style={{ width, minWidth: 0 }} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** A labelled pill select: "Group by [Month]". */
export function PillSelect({ id, label, value, onChange, options }) {
  return (
    <div className="rp-sel">
      <label className="rp-ctl" htmlFor={id}>{label}</label>
      <span className="mg-select-wrap">
        <select className="mg-select" id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </span>
    </div>
  );
}

/** The one-line answer with its lead (up to the first comma or full stop) in bold. */
export function Lead({ text }) {
  if (!text) return null;
  // The first comma, semicolon or full stop that ends a clause, outside brackets.
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (!depth && /[,;.]/.test(c) && (i === text.length - 1 || text[i + 1] === ' ')) {
      return <><strong>{text.slice(0, i)}</strong>{text.slice(i)}</>;
    }
  }
  return text;
}
