import { useId } from 'react';
import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { Card, Empty, ErrorState } from '../ui.jsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Skeleton } from '../ui/skeleton.tsx';

/**
 * One question on Insights: the question in plain words, a one-line answer,
 * the rule behind it a tap away, and then the charts. A section that failed
 * on the server says so and offers a retry; the others carry on.
 *
 * `children` is a function, called only once the data is in, so a section
 * never reads a field of a response that has not arrived.
 */
export function Section({ question, answer, rule, data, loading, onRetry, wide = false, children }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={`flex min-w-0 flex-col gap-3 ${wide ? '@3xl:col-span-2' : ''}`}>
      <div>
        <div className="flex items-start gap-1.5">
          <h2 id={headingId} className="text-[17px] font-semibold text-foreground">{question}</h2>
          {rule && <RuleInfo text={rule} />}
        </div>
        {data && !data.error && answer && <p className="mt-0.5 text-[13px] text-muted-foreground">{answer}</p>}
      </div>
      {data?.error ? (
        <Card><ErrorState message={data.error} onRetry={onRetry} /></Card>
      ) : loading && !data ? (
        <Skeleton style={{ height: 320 }} className="w-full" />
      ) : data ? children() : null}
    </section>
  );
}

/** The ⓘ beside a question: the rule, read from the live settings. A popover, so a tap opens it too. */
function RuleInfo({ text }) {
  return (
    <Popover>
      <PopoverTrigger
        className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="How this is worked out"
      >
        <Info className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="max-w-sm text-[13px] leading-relaxed">{text}</PopoverContent>
    </Popover>
  );
}

/**
 * The few rows to act on first, worst first. Each row opens its record; an
 * `action` sits beside it for the next step (log a touch, chase).
 *
 * Rows are `{ key, href, title, meta, value, chips?, action? }`.
 */
export function ActionList({ title, rows, empty }) {
  return (
    <Card title={title} flush>
      {rows.length ? (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <Link to={r.href} className="font-medium text-foreground hover:underline">{r.title}</Link>
                <div className="text-[12px] text-muted-foreground">{r.meta}</div>
                {r.chips?.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {r.chips.map((c) => (
                      <span key={c} className="rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">{c}</span>
                    ))}
                  </div>
                )}
              </div>
              {r.value && <span className="num text-[13px] font-semibold">{r.value}</span>}
              {r.action}
            </li>
          ))}
        </ul>
      ) : (
        <Empty title={empty} />
      )}
    </Card>
  );
}
