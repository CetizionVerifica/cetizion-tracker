import { useState } from 'react';
import { Alert, useToast } from './ui.jsx';
import { Chip } from './record.jsx';
import { Button } from './ui/button';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date } from '../lib/format.js';

/**
 * A person's own daily MIS (mis-report-sender-plan.md §B2, §B6): the notice
 * that it is sent, once, and every report that went about them, as
 * management received it. The server answers for the signed-in person only.
 */

export function useMyDailyMis() {
  return useFetch(() => api.raw('/mis-reports/mine'), []);
}

/**
 * The notice. `always` keeps it on the page once read (the Mailboxes page,
 * where someone connecting a mailbox should see it); elsewhere it shows
 * until they press Got it.
 */
export function DailyMisNotice({ mine, always = false }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const notice = mine.data?.data?.notice;
  if (!notice || !(always ? notice.enabled : notice.show)) return null;
  async function seen() {
    setBusy(true);
    try { await api.action('/mis-reports/mine/notice', {}); mine.refetch(); }
    catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }
  return (
    <Alert tone="info">
      <span className="flex flex-wrap items-center gap-2">
        <span><strong>Your daily MIS.</strong> {notice.text}</span>
        {notice.show && <Button variant="secondary" size="sm" className="h-7 px-3 text-[12.5px]" disabled={busy} onClick={seen}>Got it</Button>}
      </span>
    </Alert>
  );
}

const via = (r) => (r.sent_via === 'graph' ? `from ${r.sent_from || 'your mailbox'}` : r.sent_via === 'smtp' ? 'by the tracker\'s SMTP sender' : '');

/** Every report that went about them, newest first, each as its PDF. */
export function MyDailyMis({ mine }) {
  const data = mine.data?.data;
  if (!data || (!data.notice?.applies && !data.runs.length)) return null;
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <div className="text-[13px] font-semibold text-foreground">My daily MIS</div>
      <p className="text-[12px]/[1.6] text-muted-foreground">What management received about your previous working day, exactly as it went.</p>
      {data.runs.length ? (
        <ul className="flex flex-col gap-1 text-[12.5px] text-secondary-text">
          {data.runs.slice(0, 10).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{date(r.period_from)}</span>
              <Chip tone="settled">sent</Chip>
              <span>{via(r)}</span>
              {r.has_pdf && <a href={`/api/mis-reports/mine/${r.id}/pdf`} target="_blank" rel="noreferrer">Open</a>}
            </li>
          ))}
        </ul>
      ) : <div className="text-[12.5px] text-muted-foreground">No report has gone yet.</div>}
    </section>
  );
}
