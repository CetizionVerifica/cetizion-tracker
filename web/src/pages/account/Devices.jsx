import { Laptop, LogOut, Smartphone } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '../../components/ui/button.tsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { ago } from '../../lib/format.js';
import { useAccount } from './index.jsx';
import { Pane } from './Pane.jsx';

const PROVIDER = { microsoft: 'Microsoft 365', google: 'Google' };

/** A phone is drawn as a phone: the icon is how somebody recognises a row. */
const isHandheld = (ua) => /iPhone|iPad|Android|Mobile/.test(String(ua || ''));

/** "Mac · Chrome" out of a user-agent, or the raw string when it will not give one up. */
function device(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
      : /Chrome\//.test(ua) ? 'Chrome'
        : /Firefox\//.test(ua) ? 'Firefox'
          : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone'
    : /Android/.test(ua) ? 'Android'
      : /Mac OS X/.test(ua) ? 'Mac'
        : /Windows/.test(ua) ? 'Windows'
          : /Linux/.test(ua) ? 'Linux' : null;
  if (!browser && !os) return ua.slice(0, 60);
  return [os, browser].filter(Boolean).join(' · ');
}

/**
 * Where you are signed in, and how to stop being.
 *
 * This device is pinned to the top and marked, because the one row whose
 * "Sign out" does something different from the others is the one you are
 * reading it on.
 */
export function Devices() {
  const { sessions, refetch, toast } = useAccount();
  const { signOut } = useAuth();

  const ordered = [...sessions].sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));

  async function end(session) {
    try {
      await api.raw(`/auth/account/sessions/${session.id}`, { method: 'DELETE' });
      if (session.current) return signOut();
      toast('Signed that device out', 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function endEverything() {
    try {
      await api.raw('/auth/account/sessions/revoke-all', { method: 'POST' });
    } finally {
      // Including here — that is what the words say, so the app follows.
      signOut();
    }
  }

  return (
    <Pane
      title="Where you're signed in"
      description="A session lasts twelve hours. Signing one out ends it immediately, wherever it is."
      actions={sessions.length > 1 && (
        <Button variant="secondary" size="sm" onClick={endEverything}>Sign out everywhere</Button>
      )}
    >
      {sessions.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">Nothing recorded yet.</p>
      ) : (
        <ul className="grid gap-2">
          {ordered.map((s) => (
            <li
              key={s.id}
              className={cn(
                'flex flex-wrap items-center gap-3 rounded-md border px-4 py-3',
                s.current ? 'border-primary/30 bg-primary/5' : 'border-border'
              )}
            >
              {isHandheld(s.user_agent)
                ? <Smartphone className="size-4 shrink-0 text-secondary-text" strokeWidth={1.75} aria-hidden="true" />
                : <Laptop className="size-4 shrink-0 text-secondary-text" strokeWidth={1.75} aria-hidden="true" />}
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-foreground">
                  {device(s.user_agent)}
                  {s.current && <span className="ml-2 text-[12px] font-medium text-primary">this device</span>}
                </div>
                <div className="text-[12px] text-muted-foreground">
                  via {s.via === 'password' ? 'password' : PROVIDER[s.via] || s.via}
                  {' · '}{ago(s.last_seen_at) || 'just now'}
                  {s.ip ? ` · ${s.ip}` : ''}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => end(s)}>
                <LogOut className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                {s.current ? 'Sign out here' : 'Sign out'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Pane>
  );
}
