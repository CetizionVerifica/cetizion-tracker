import { AlertCircle, Mail } from 'lucide-react';
import { cn } from 'cn';

/** A pane's empty, missing or failed state: the system's mg-empty, filling the pane. */
export function PaneState({ icon: Icon = Mail, title, text, action, tone, role }) {
  const MarkIcon = tone === 'late' && Icon === Mail ? AlertCircle : Icon;
  return (
    <div className="mg-empty" role={role || (tone === 'late' ? 'alert' : undefined)} style={{ padding: '48px 24px' }}>
      <span className={cn('mg-empty__mark', tone === 'late' && 'app-ib__late-mark')}><MarkIcon className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
      <h2 className="mg-empty__title">{title}</h2>
      {text && <p className="mg-empty__text">{text}</p>}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}

/** The conversation skeleton, also used while a message is read live. */
export function PaneLoading({ label = 'Loading the conversation' }) {
  return (
    <div aria-busy="true" aria-label={label} style={{ flex: 1, padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="mg-skel" style={{ height: 18, width: '62%' }} />
      <div className="mg-skel" style={{ height: 12, width: '40%' }} />
      <div className="mg-skel" style={{ height: 56, marginTop: 8 }} />
      <div className="mg-skel" style={{ height: 56 }} />
      <div className="mg-skel" style={{ height: 220 }} />
    </div>
  );
}
