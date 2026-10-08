import { Link } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Lock } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useFetch } from '../../lib/hooks.js';
import { Message } from './MessageView.jsx';
import { PaneState, PaneLoading } from './PaneState.jsx';

/**
 * A conversation from a mailbox folder (docs/inbox-outlook-plan.md §3.3):
 * the subject, which mailbox it is in, the company and record it was
 * matched to, Open in Outlook, and the messages — the newest open, the
 * rest a line each. A read-only copy of Outlook: no owner, snooze or
 * close here, and the foot says so.
 */
export function ReadingPane({ threadId, refreshKey = 0, onBack }) {
  const thread = useFetch(() => api.raw(`/mail/threads/${threadId}`), [threadId, refreshKey]);
  const t = thread.data?.data;
  // Only a 404 means the conversation is not ours to read; anything else says what happened.
  if (thread.error) {
    return thread.errorStatus === 404
      ? <PaneState tone="late" icon={Lock} title="Not found" text="This conversation is not in a mailbox you can read." action={<button type="button" className="mg-btn mg-btn--sm" onClick={onBack}>Back to the folder</button>} />
      : <PaneState tone="late" title="Couldn't open this conversation" text={thread.error} action={<button type="button" className="mg-btn mg-btn--sm" onClick={thread.refetch}>Try again</button>} />;
  }
  if (!t) return <PaneLoading />;
  const newest = [...t.messages].reverse().find((m) => m.web_link) || null;
  const stored = t.messages.filter((m) => !m.removed_at);
  const limited = t.visibility !== 'share_everything' && !t.messages.some((m) => m.can_read_live);
  return (
    <>
      <div className="app-ib__head">
        <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm app-ib__back" onClick={onBack} aria-keyshortcuts="Escape" style={{ alignSelf: 'flex-start', marginLeft: -10 }}>
          <ArrowLeft className="size-4" strokeWidth={2} aria-hidden="true" />All conversations
        </button>
        <div className="app-ib__titlerow">
          <div className="app-ib__titles">
            <h2>{t.subject || (t.visibility === 'metadata' ? 'Subject not shared' : '(no subject)')}</h2>
            <div className="app-ib__badges">
              <span className="mg-badge mg-badge--plain">{t.message_count} message{t.message_count === 1 ? '' : 's'}</span>
            </div>
          </div>
          {newest?.web_link && (
            <div className="app-ib__acts">
              <a href={newest.web_link} target="_blank" rel="noopener noreferrer" className="mg-btn mg-btn--sm" title="Open this conversation in Outlook on the web">
                <ExternalLink className="size-4" strokeWidth={1.8} aria-hidden="true" />Open in Outlook
              </a>
            </div>
          )}
        </div>
        <p className="app-ib__meta">
          <span>in {t.mailbox}</span>
          {t.company_name && <span><Link to={`/companies/${t.company_id}`}>{t.company_name}</Link></span>}
          {t.contact_name && <span>{t.contact_name}</span>}
          {t.entity_id && <span className="mg-num">{t.entity_id}</span>}
        </p>
      </div>
      <div className="app-ib__body">
        {limited && (
          <div className="mg-banner" role="note">
            <Lock strokeWidth={1.8} aria-hidden="true" />
            <div className="mg-banner__body">
              <strong>The mailbox owner shares {t.visibility === 'subject' ? 'subjects only' : 'only who and when'}</strong>
              {t.visibility === 'subject' ? 'The text and attachments stay in their mailbox.' : 'Subjects, text and attachments stay in their mailbox. Only they can open them.'}
            </div>
          </div>
        )}
        {t.messages.map((m, i) => (
          <Message key={m.id} m={m} openByDefault={i >= t.messages.length - 1 || stored.length <= 2} />
        ))}
      </div>
      <p className="app-ib__readonly">A read-only copy of Outlook. Reply, flag or move it in Outlook; the change shows here within a minute.</p>
    </>
  );
}
