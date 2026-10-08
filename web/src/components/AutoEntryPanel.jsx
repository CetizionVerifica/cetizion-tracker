import { useState } from 'react';
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

  const narrow = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 719px)').matches;
  const line = (d) => `${number(d.read)} decided · ${number(d.entered)} entered · ${number(d.review)} to review · ${number(d.set_aside)} set aside · ${number(d.ai_calls)} AI calls`;
  return (
    <section className="mg-glass mg-glass--strong app-ib-panel" data-a="rise" aria-labelledby="sec-entry" data-testid="auto-entry-panel">
      <div className="app-ib-panel__head">
        <div className="app-ib-panel__titles" style={{ flex: '1 1 420px' }}>
          <h2 className="mg-panel__title" id="sec-entry">Mail auto-entry</h2>
          <p className="mg-panel__hint" style={{ maxWidth: 820, lineHeight: 1.55 }}>
            What the email readers did over the last two weeks: the emails they decided on, the enquiries, quotations, POs and invoices they entered,
            what they sent to review, what triage set aside without a thorough reading, and what the AI cost.
          </p>
        </div>
        <label className={now.triage_enabled ? 'mg-switch app-pill-switch is-on' : 'mg-switch app-pill-switch'}>
          <input type="checkbox" role="switch" aria-label="Triage" checked={Boolean(now.triage_enabled)} disabled={busy} onChange={toggleTriage} />
          <span>Triage</span>
          <span aria-hidden="true">{now.triage_enabled ? 'On' : 'Off'}</span>
        </label>
      </div>

      <p className="app-ib-now">
        <strong>Now:</strong> {number(now.to_review)} in review{now.older_than_two_days ? ` (${number(now.older_than_two_days)} older than two days)` : ''}
        {' · '}{number(now.waiting)} invoice{now.waiting === 1 ? '' : 's'} waiting for {now.waiting === 1 ? 'its' : 'their'} PO
        {now.retrying ? ` · ${number(now.retrying)} read${now.retrying === 1 ? '' : 's'} to try again` : ''}
        {now.failed ? ` · ${number(now.failed)} given up on (admins were told)` : ''}
      </p>

      {narrow ? (
        <div className="mg-rows">
          {[...s.days, { day: null, ...total }].map((d) => (
            <div key={d.day || 'total'} className="mg-row">
              <span className="mg-row__title">{d.day ? date(d.day) : 'Two weeks'}</span>
              <span className="mg-row__amount mg-num">{usd(d.cost_usd)}</span>
              <span className="mg-row__meta" style={{ gridColumn: '1 / -1', whiteSpace: 'normal' }}>{line(d)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mg-tablewrap">
          <table className="mg-table" aria-label="Email readers, last two weeks">
            <thead>
              <tr>
                <th>Day</th><th className="num">Emails decided</th><th className="num">Entered</th><th className="num">To review</th>
                <th className="num">Set aside by triage</th><th className="num">AI calls</th><th className="num">AI spend</th>
              </tr>
            </thead>
            <tbody>
              {s.days.map((d) => (
                <tr key={d.day}>
                  <td>{date(d.day)}</td>
                  <td className="num">{number(d.read)}</td>
                  <td className="num">{number(d.entered)}</td>
                  <td className="num">{number(d.review)}</td>
                  <td className="num">{number(d.set_aside)}</td>
                  <td className="num">{number(d.ai_calls)}</td>
                  <td className="num">{usd(d.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Two weeks</td>
                <td className="num">{number(total.read)}</td>
                <td className="num">{number(total.entered)}</td>
                <td className="num">{number(total.review)}</td>
                <td className="num">{number(total.set_aside)}</td>
                <td className="num">{number(total.ai_calls)}</td>
                <td className="num">{usd(total.cost_usd)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="app-ib-reasons">
        {s.reasons.length > 0 && (
          <>
            <span className="mg-label">Why items went to review</span>
            <div>
              {s.reasons.map((r) => (
                <span key={`${r.reader}:${r.reason}`} className={r.reader === 'po' ? 'mg-badge mg-badge--info' : 'mg-badge mg-badge--wait'}>
                  {r.reader === 'po' ? 'PO' : 'Invoice'}: {(r.reader === 'po' ? PO_REASONS : INVOICE_REASONS)[r.reason] || r.reason} · {number(r.n)}
                </span>
              ))}
            </div>
          </>
        )}
        <p>
          Documents are read by {models.reader}{models.reads_pdf ? ', which is sent the PDF itself' : ', from their text (a scan through OCR)'};
          an image PDF is read again by {models.check}, and the two must agree. Triage uses {models.triage}.
          {models.fallbacks?.length ? ` If the reader cannot be reached with zero data retention: ${models.fallbacks.join(', then ')}.` : ''}
        </p>
      </div>
    </section>
  );
}
