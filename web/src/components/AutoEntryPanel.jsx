import { useState } from 'react';
import { Button } from './ui/button';
import { useToast } from './ui.jsx';
import { INVOICE_REASONS, PO_REASONS } from './EmailReview.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date, number } from '../lib/format.js';
import { useAuth } from '../lib/auth.jsx';

const usd = (v) => `$${Number(v || 0).toFixed(2)}`;

/**
 * Mail auto-entry (docs/email-auto-entry-plan.md §3.10): what the email
 * readers did each day, what waits on a person now, and what the reading
 * cost. Admins only; counts, never the mail.
 */
export function AutoEntryPanel() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const { data, refetch } = useFetch(() => (isAdmin ? api.raw('/mailboxes/auto-entry?days=14') : Promise.resolve(null)), [isAdmin]);
  const [busy, setBusy] = useState(false);
  const s = data?.data;
  if (!isAdmin || !s) return null;
  const { now, models } = s;
  const total = s.days.reduce((t, d) => ({
    read: t.read + d.read, entered: t.entered + d.entered, review: t.review + d.review, set_aside: t.set_aside + d.set_aside,
    ai_calls: t.ai_calls + d.ai_calls, cost_usd: t.cost_usd + d.cost_usd,
  }), { read: 0, entered: 0, review: 0, set_aside: 0, ai_calls: 0, cost_usd: 0 });

  async function toggleTriage() {
    setBusy(true);
    try {
      await api.update('settings', 'email_triage_enabled', { value: now.triage_enabled ? 'false' : 'true' });
      toast(now.triage_enabled ? 'Triage is off: every reader reads every candidate' : 'Triage is on', 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  const cell = 'px-2 py-1.5 text-right mono';
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5" data-testid="auto-entry-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold text-foreground">Mail auto-entry</div>
          <p className="max-w-[80ch] text-[12.5px]/[1.6] text-secondary-text">
            What the email readers did over the last two weeks: the emails they decided on, the enquiries, quotations, POs and invoices they entered,
            what they sent to review, what triage set aside without a thorough reading, and what the AI cost.
          </p>
        </div>
        <Button size="sm" variant={now.triage_enabled ? 'secondary' : 'default'} className="h-8 px-4 text-[13px]" disabled={busy} onClick={toggleTriage}>
          {now.triage_enabled ? 'Triage: switch off' : 'Triage: switch on'}
        </Button>
      </div>

      <p className="text-[12.5px] text-foreground">
        Now: {number(now.to_review)} in review{now.older_than_two_days ? ` (${number(now.older_than_two_days)} older than two days)` : ''}
        {' · '}{number(now.waiting)} invoice{now.waiting === 1 ? '' : 's'} waiting for {now.waiting === 1 ? 'its' : 'their'} PO
        {now.retrying ? ` · ${number(now.retrying)} read${now.retrying === 1 ? '' : 's'} to try again` : ''}
        {now.failed ? ` · ${number(now.failed)} given up on (admins were told)` : ''}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-[12.5px] text-secondary-text">
          <thead>
            <tr className="border-b border-border eyebrow">
              <th className="px-2 py-1.5 text-left font-medium">Day</th>
              <th className="px-2 py-1.5 text-right font-medium">Emails decided</th>
              <th className="px-2 py-1.5 text-right font-medium">Entered</th>
              <th className="px-2 py-1.5 text-right font-medium">To review</th>
              <th className="px-2 py-1.5 text-right font-medium">Set aside by triage</th>
              <th className="px-2 py-1.5 text-right font-medium">AI calls</th>
              <th className="px-2 py-1.5 text-right font-medium">AI spend</th>
            </tr>
          </thead>
          <tbody>
            {s.days.map((d) => (
              <tr key={d.day} className="border-b border-border/60">
                <td className="px-2 py-1.5 text-left">{date(d.day)}</td>
                <td className={cell}>{number(d.read)}</td>
                <td className={cell}>{number(d.entered)}</td>
                <td className={cell}>{number(d.review)}</td>
                <td className={cell}>{number(d.set_aside)}</td>
                <td className={cell}>{number(d.ai_calls)}</td>
                <td className={cell}>{usd(d.cost_usd)}</td>
              </tr>
            ))}
            <tr className="font-semibold text-foreground">
              <td className="px-2 py-1.5 text-left">Two weeks</td>
              <td className={cell}>{number(total.read)}</td>
              <td className={cell}>{number(total.entered)}</td>
              <td className={cell}>{number(total.review)}</td>
              <td className={cell}>{number(total.set_aside)}</td>
              <td className={cell}>{number(total.ai_calls)}</td>
              <td className={cell}>{usd(total.cost_usd)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {s.reasons.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[12.5px] font-medium text-foreground">Why items went to review</div>
          <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[12.5px] text-secondary-text">
            {s.reasons.map((r) => (
              <li key={`${r.reader}:${r.reason}`}>
                {r.reader === 'po' ? 'PO' : 'Invoice'}: {(r.reader === 'po' ? PO_REASONS : INVOICE_REASONS)[r.reason] || r.reason} · {number(r.n)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[12px] text-muted-foreground">
        Documents are read by {models.reader}{models.reads_pdf ? ', which is sent the PDF itself' : ', from their text (a scan through OCR)'};
        an image PDF is read again by {models.check}, and the two must agree. Triage uses {models.triage}.
        {models.fallbacks?.length ? ` If the reader cannot be reached with zero data retention: ${models.fallbacks.join(', then ')}.` : ''}
      </p>
    </div>
  );
}
