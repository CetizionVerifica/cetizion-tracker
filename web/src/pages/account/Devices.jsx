import { Laptop, LogOut, Smartphone } from 'lucide-react';
import { cn } from 'cn';
import { Tone } from '../../components/sales.jsx';
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
 * Where you are signed in, and how to stop being (Wave 8). This device is
 * pinned to the top and marked; Sign out everywhere sits in the header
 * (only with more than one session) and asks first.
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

  return (
    <Pane>
      {sessions.length === 0 ? (
        <p className="m-0 text-[13px] text-secondary-text">Nothing recorded yet.</p>
      ) : (
        <ul className="acc-list m-0 list-none p-0">
          {ordered.map((s) => {
            const Icon = isHandheld(s.user_agent) ? Smartphone : Laptop;
            return (
              <li key={s.id} className={cn('acc-item', s.current && 'acc-item--here')}>
                <span className="acc-item__mark"><Icon aria-hidden="true" /></span>
                <div className="acc-item__text">
                  <b>{device(s.user_agent)}{s.current && <Tone tone="wait">This device</Tone>}</b>
                  <small>via {s.via === 'password' ? 'password' : PROVIDER[s.via] || s.via} · {ago(s.last_seen_at) || 'just now'}{s.ip ? ` · ${s.ip}` : ''}</small>
                </div>
                <button type="button" className={cn('mg-btn mg-btn--sm', !s.current && 'mg-btn--ghost')} aria-label={s.current ? 'Sign out on this device' : `Sign out ${device(s.user_agent)}`} onClick={() => end(s)}>
                  <LogOut className="size-3.5" strokeWidth={1.75} aria-hidden="true" />{s.current ? 'Sign out here' : 'Sign out'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Pane>
  );
}
