import { useEffect, useRef } from 'react';
import { LogOut, Moon, Pause, Play, Sun } from 'lucide-react';
import { BrandMark, usePaused, useThemeSwitch } from './shell/Shell.jsx';
import { enter } from '../styles/mocha/motion.js';

/**
 * Wave 9: what every client page shares (the portal, its sign-in and the
 * quotation acceptance page). No staff shell: a calm glass header with the
 * bean and "Cetizion Verifica", what this page is under it, the client's
 * name when signed in, pause motion, the theme switch with its shockwave,
 * and Sign out. Light by default; the client's own choice is remembered
 * apart from staff's (main.jsx gives client pages their own storage key).
 */
export const PROVIDER = 'Cetizion Verifica';

export const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

export function ClientHeader({ sub, who, company, onSignOut, badge }) {
  const [paused, togglePause] = usePaused();
  const { resolved, change } = useThemeSwitch();
  const other = resolved === 'dark' ? 'light' : 'dark';
  return (
    <header className="mg-glass cl-bar" data-a="rise">
      <span className="cl-brand" aria-label={`${PROVIDER} ${sub}`}>
        <BrandMark size={36} />
        <span className="cl-brand__text"><span className="cl-brand__name">{PROVIDER}</span><span className="cl-brand__sub">{sub}</span></span>
      </span>
      <span style={{ flex: 1 }} />
      {badge && <span className="mg-badge cl-wide" style={{ marginRight: 6 }}>{badge}</span>}
      {who && (
        <div className="cl-who cl-wide">
          <span className="mg-avatar" aria-hidden="true">{initials(who)}</span>
          <span className="cl-who__text"><strong>{who}</strong><span className="cl-brand__sub">{company}</span></span>
        </div>
      )}
      <button type="button" className="mg-iconbtn" aria-label={paused ? 'Play background motion' : 'Pause background motion'} aria-pressed={paused} onClick={togglePause}>
        {paused ? <Play size={15} strokeWidth={2.2} aria-hidden="true" /> : <Pause size={15} strokeWidth={2.2} aria-hidden="true" />}
      </button>
      <button type="button" className="mg-iconbtn" aria-label={`Switch to ${other} mode`} onClick={(e) => change(other, e.currentTarget)}>
        {resolved === 'dark' ? <Sun strokeWidth={1.8} aria-hidden="true" /> : <Moon strokeWidth={1.8} aria-hidden="true" />}
      </button>
      {onSignOut && (
        <>
          <button type="button" className="mg-btn mg-btn--sm cl-wide cl-bar__out" onClick={onSignOut}><LogOut strokeWidth={1.8} aria-hidden="true" />Sign out</button>
          <button type="button" className="mg-iconbtn cl-narrow" aria-label="Sign out" onClick={onSignOut}><LogOut strokeWidth={1.8} aria-hidden="true" /></button>
        </>
      )}
    </header>
  );
}

/** The page column. `plain` drops the room kept at the bottom for the phone bar. */
export function ClientPage({ children, after, plain = false, rootRef }) {
  return (
    <div className={`cl-root${plain ? ' cl-root--plain' : ''}`} ref={rootRef}>
      <div className="cl-wrap">{children}</div>
      {after}
    </div>
  );
}

/** Rise in whatever carries data-a="rise" inside, once per `key` (a page or a tab's data arriving). */
export function useEnter(key) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current && key) enter(ref.current); }, [key]);
  return ref;
}

/** The pulsing bean while a page opens. */
export function Opening({ title, text }) {
  return (
    <div className="cl-boot" role="status">
      <BrandMark size={60} className="cl-boot__mark" />
      {title && <h1 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{title}</h1>}
      <span style={{ fontSize: 14, color: 'var(--text2)' }}>{text}</span>
    </div>
  );
}
