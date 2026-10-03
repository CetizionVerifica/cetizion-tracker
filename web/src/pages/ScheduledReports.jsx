import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Field, Input, useToast } from '../components/ui.jsx';
import { Button } from '../components/ui/button';
import { PageHeader } from '../App.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date } from '../lib/format.js';

/**
 * Reports → Scheduled reports (docs/mis-reports-plan.md §5): the Daily Sales
 * Briefing and the Weekly Sales MIS the tracker builds from its own records.
 *
 * This first step previews only: the figures, the email as it would read,
 * and the PDF as it would be attached. Sending, the schedule and the run
 * history follow in the next step (§7.3). Admin only; the routes are
 * behind requireAdmin on the server.
 */

const KINDS = [
  { kind: 'daily_briefing', title: 'Daily Sales Briefing', when: 'Every day at 08:56 IST, for the previous day', what: 'What happened yesterday, the pending invoices, POs and quotations with Overdue marked, and the top five actions for today.' },
  { kind: 'weekly_mis', title: 'Weekly Sales MIS Report', when: 'Every Monday at 08:54 IST, for the previous Monday to Sunday', what: 'The eight management questions: enquiries per day with first-response times, outcomes, sector-wise and service-wise sales, customers, invoiced and received, receivables over 90 days, pending follow-ups, conversion and speed.' },
];

function ReportCard({ kind, title, when, what }) {
  const toast = useToast();
  // "As of": the report is run as if this were today, so a past period can
  // be looked at again. Blank means today.
  const [asOf, setAsOf] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const q = asOf ? `?date=${asOf}` : '';

  async function load() {
    setBusy(true);
    try {
      const r = await api.raw(`/mis-reports/${kind}/preview${q}`);
      setPreview(r.data);
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-5">
      <div>
        <div className="text-[14px] font-semibold text-foreground">{title}</div>
        <div className="text-[12px] text-muted-foreground">{when}</div>
        <p className="mt-1 text-[12.5px]/[1.6] text-secondary-text">{what}</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="As of" hint="Run it as if this were today">
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="h-8 text-[12.5px]" />
        </Field>
        <Button size="sm" className="h-8 px-4 text-[13px]" disabled={busy} onClick={load}>{busy ? 'Building…' : 'Preview figures and email'}</Button>
        <Button variant="secondary" size="sm" className="h-8 px-4 text-[13px]" asChild>
          <a href={`/api/mis-reports/${kind}/preview.pdf${q}`} target="_blank" rel="noreferrer">Open the PDF</a>
        </Button>
      </div>
      {preview && (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <div className="text-[12.5px] text-secondary-text">
            Period <strong>{date(preview.period.from)}{preview.period.to !== preview.period.from ? ` – ${date(preview.period.to)}` : ''}</strong>
            {' · '}attachment <code className="mono">{preview.file_name}</code>
            {' · '}recipients: {preview.settings.to.length ? preview.settings.to.join(', ') : <em>none set yet</em>}
          </div>
          <div className="text-[13px] font-medium text-foreground">{preview.email.subject}</div>
          <pre className="max-h-[420px] overflow-auto rounded-[8px] bg-secondary p-3 text-[12px]/[1.5] whitespace-pre-wrap text-secondary-text">{preview.email.text}</pre>
        </div>
      )}
    </div>
  );
}

export default function ScheduledReports() {
  const settings = useFetch(() => api.raw('/settings'), []);
  const mode = (settings.data?.data ?? []).find((s) => s.key === 'emails_enabled')?.value;
  return (
    <>
      <PageHeader
        title="Scheduled reports"
        subtitle="The Daily Sales Briefing and the Weekly Sales MIS, built from the tracker's records and emailed from the sales mailbox with the PDF attached."
        actions={<Link className="btn" to="/reports">Back to Reports</Link>}
      />
      <div className="page stack">
        <Alert tone="info">
          <span>
            Preview only for now: nothing is sent from this page. The figures come from the same definitions as the Reports page, in ₹ at the rate on each record's date.
            {mode === 'false' && ' Automatic email is switched off under Settings → Emails & jobs.'}
          </span>
        </Alert>
        <div className="grid gap-4 lg:grid-cols-2">
          {KINDS.map((k) => <ReportCard key={k.kind} {...k} />)}
        </div>
      </div>
    </>
  );
}
