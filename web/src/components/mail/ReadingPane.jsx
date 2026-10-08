import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { Empty } from '../ui.jsx';
import { api } from '../../lib/api.js';
import { useFetch } from '../../lib/hooks.js';
import { Message } from './MessageView.jsx';

/**
 * A conversation from a mailbox folder (docs/inbox-outlook-plan.md §3.3):
 * the subject, which mailbox it is in, the company and record it was
 * matched to, Open in Outlook, and the messages — the newest open, the
 * rest a line each.
 *
 * No owner, snooze or close here: those are the team inbox's triage, and a
 * personal folder has none. The actions on the mail itself (read, flag,
 * move, delete) come with step 3.
 */
export function ReadingPane({ threadId, refreshKey = 0, onBack }) {
  const thread = useFetch(() => api.raw(`/mail/threads/${threadId}`), [threadId, refreshKey]);
  const t = thread.data?.data;
  // Only a 404 means the conversation is not ours to read. A server that
  // would not answer, or a connection that dropped, says what happened
  // instead of sending the reader to an admin about permissions.
  if (thread.error) {
    return (
      <div className="p-6">
        {thread.errorStatus === 404
          ? <Empty title="Not found" text="This conversation is not in a mailbox you can read." />
          : <Empty title="Not available" text={thread.error} />}
      </div>
    );
  }
  if (!t) return <div className="p-6"><div className="skeleton" style={{ height: 200 }} /></div>;
  const newest = [...t.messages].reverse().find((m) => m.web_link) || null;
  const stored = t.messages.filter((m) => !m.removed_at);
  return (
    <div className="flex flex-col">
      <header className="border-b border-border px-6 py-5">
        <button
          type="button"
          onClick={onBack}
          className="mb-2 inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground lg:hidden"
        >
          ← All conversations
        </button>
        <div className="flex items-start gap-4">
          <h2 className="min-w-0 flex-1 text-[18px]/[1.3] font-semibold tracking-[-0.015em] text-foreground">{t.subject || '(no subject)'}</h2>
          {newest?.web_link && (
            <a
              href={newest.web_link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border bg-secondary px-2 py-1 text-[12px] font-medium text-secondary-text hover:text-foreground"
              title="Open this conversation in Outlook on the web"
            >
              <ExternalLink className="size-3.5" strokeWidth={1.75} aria-hidden="true" /> Open in Outlook
            </a>
          )}
        </div>
        <p className="mt-1 wrap-anywhere text-[12.5px] text-secondary-text">
          in <span className="text-foreground">{t.mailbox}</span>
          {t.company_name && <> · <Link to={`/companies/${t.company_id}`}>{t.company_name}</Link></>}
          {t.contact_name && <> · {t.contact_name}</>}
          {t.entity_id && <> · <span className="num">{t.entity_id}</span></>}
          {` · ${t.message_count} message${t.message_count === 1 ? '' : 's'}`}
        </p>
        {t.visibility !== 'share_everything' && !t.messages.some((m) => m.can_read_live) && (
          <p className="mt-1 text-[12px] text-muted-foreground">
            The mailbox owner shares {t.visibility === 'subject' ? 'subjects only' : 'only who and when'}.
          </p>
        )}
      </header>
      <div className="flex flex-col gap-2.5 px-6 py-4">
        {t.messages.map((m, i) => (
          <Message key={m.id} m={m} openByDefault={i >= t.messages.length - 1 || stored.length <= 2} />
        ))}
      </div>
    </div>
  );
}
