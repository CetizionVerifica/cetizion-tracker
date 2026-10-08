import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CircleAlert, Lock, Moon, Sun } from 'lucide-react';

import { useAuth } from '../lib/auth.jsx';
import { ApiError } from '../lib/api.js';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { BrandMark, useThemeSwitch } from '../components/shell/Shell.jsx';

/**
 * Sign in, drawn as the Wave 1 canvas draws it: one strong-glass card on
 * the scene, the coffee-bean mark and "Sales Tracker", and the theme switch
 * in the corner.
 *
 * The form asks for whatever the API signs people in with: a username while
 * the tracker is on the shared password, an email once it is on the users
 * table. The server says which — see /auth/config. The same endpoint says
 * which providers are configured, and an unconfigured one is not drawn.
 *
 * "Forgotten it?" is not a link: there is no reset flow, so it says who to
 * ask instead. The staging band is EnvironmentBanner's, above every page.
 */
const FIELD = {
  shared: { label: 'Username', type: 'text', autoComplete: 'username', name: 'username' },
  database: { label: 'Email', type: 'email', autoComplete: 'email', name: 'email' },
};

/** Provider marks, drawn rather than fetched: a sign-in page loads nothing third-party. */
const MARK = {
  microsoft: (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="10.5" height="10.5" fill="#F25022" /><rect x="12.5" y="1" width="10.5" height="10.5" fill="#7FBA00" />
      <rect x="1" y="12.5" width="10.5" height="10.5" fill="#00A4EF" /><rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#FFB900" />
    </svg>
  ),
  google: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285f4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z" />
      <path fill="#34a853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18z" />
      <path fill="#fbbc05" d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H.9a9 9 0 0 0 0 8l3-2.3z" />
      <path fill="#ea4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z" />
    </svg>
  ),
};

/**
 * The server's answer in plain words (A1-9). A wrong password keeps the
 * server's own sentence; a lockout and a busy rate limiter say sign-in is
 * paused; no answer at all says the server cannot be reached.
 */
function describe(err) {
  const status = err instanceof ApiError ? err.status : undefined;
  if (status === 429) return { title: 'Sign-in is paused for now', body: err.message };
  if (!status) return { title: 'Can’t reach the server', body: 'Check your connection, then try again in a minute.' };
  if (status === 400 || status === 401 || status === 403) return { title: err.message, body: null };
  return { title: 'Sign-in didn’t go through', body: err.message };
}

function Banner({ tone = 'late', title, children, role = 'alert' }) {
  return (
    <div className={tone === 'late' ? 'mg-banner mg-banner--late' : 'mg-banner'} role={role}>
      <CircleAlert strokeWidth={1.8} aria-hidden="true" />
      <div className="mg-banner__body">
        <strong>{title}</strong>
        {children}
      </div>
    </div>
  );
}

export default function Login() {
  const { signIn, mode, providers = [] } = useAuth();
  const field = FIELD[mode] ?? FIELD.shared;
  const { resolved, change } = useThemeSwitch();
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState(null);
  const [attemptsLeft, setAttemptsLeft] = useState(null);
  const [lockoutMinutes, setLockoutMinutes] = useState(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(null);
  // The provider callback sends people back here with ?sso=refused when it
  // turns them away. One wording for every reason it refuses — which reason
  // it was belongs in the server log, not on a page anyone can reach.
  const [params] = useSearchParams();
  const refused = params.get('sso') === 'refused';

  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  async function submit(event) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);
    try {
      await signIn(form.username, form.password);
    } catch (err) {
      setError(describe(err));
      // The server counts the failures and only mentions them at the end,
      // so an ordinary typo is not alarming.
      const details = err instanceof ApiError ? err.details : null;
      setAttemptsLeft(details?.attempts_left ?? null);
      setLockoutMinutes(details?.lockout_minutes ?? null);
      setForm((prev) => ({ ...prev, password: '' }));
      setBusy(false);
    }
  }

  return (
    <div className="relative grid min-h-dvh place-items-center px-4 pt-[72px] pb-8">
      <button
        type="button"
        className="mg-iconbtn absolute top-4 right-4 border border-glass-edge bg-glass"
        aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} mode`}
        onClick={(e) => change(resolved === 'dark' ? 'light' : 'dark', e.currentTarget)}
      >
        {resolved === 'dark' ? <Sun strokeWidth={1.8} aria-hidden="true" /> : <Moon strokeWidth={1.8} aria-hidden="true" />}
      </button>

      <main className="mg-glass mg-glass--strong flex w-full max-w-[460px] flex-col gap-4 rounded-[28px] px-6 pt-[30px] pb-6 sm:px-8" data-a="rise">
        <div className="flex items-center gap-3">
          <BrandMark size={38} />
          <div>
            <div className="text-[21px] leading-[1.1] tracking-[-0.01em]" style={{ fontFamily: 'var(--font-display)' }}>Sales Tracker</div>
          </div>
        </div>

        <div>
          <h1 className="mg-display" style={{ fontSize: 34 }}>Sign <em className="text-caramel-text italic">in</em></h1>
          <p className="mt-1.5 mb-0 text-secondary-text">
            {providers.length
              ? 'Use the work account you read email with. Sessions last 12 hours.'
              : 'Sessions last 12 hours.'}
          </p>
        </div>

        {refused && !error && (
          <Banner title="That account can’t sign in here">
            Ask an admin to add it in Settings › Users &amp; roles, or sign in with a password.
          </Banner>
        )}

        {providers.length > 0 && (
          <>
            <div className="flex flex-col gap-2.5">
              {providers.map((p) => (
                // A real link, not a fetch: the browser has to leave for the
                // provider and come back holding a cookie.
                <a key={p.id} href={`/api/auth/oauth/${p.id}/start`} className="mg-btn mg-btn--lg w-full" onClick={() => setLeaving(p.id)}>
                  {MARK[p.id]} {leaving === p.id ? 'Signing in…' : `Continue with ${p.label}`}
                </a>
              ))}
            </div>
            <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
              <span className="h-px flex-1 bg-line" />or with a password<span className="h-px flex-1 bg-line" />
            </div>
          </>
        )}

        <form className="flex flex-col gap-3.5" onSubmit={submit}>
          {error && (
            <Banner title={error.title}>
              {error.body && <span>{error.body}</span>}
              {attemptsLeft != null && (
                <span role="status">
                  {' '}{attemptsLeft} attempt{attemptsLeft === 1 ? '' : 's'} left
                  {lockoutMinutes ? `, then sign-in pauses for ${lockoutMinutes} minutes` : ''}.
                </span>
              )}
            </Banner>
          )}

          <div className="mg-field">
            <Label htmlFor="signin-id">{field.label}</Label>
            <Input
              id="signin-id"
              key={field.name}
              name={field.name}
              type={field.type}
              autoComplete={field.autoComplete}
              autoFocus
              required
              value={form.username}
              onChange={set('username')}
              disabled={busy}
              className="h-12"
            />
          </div>

          <div className="mg-field">
            <div className="flex items-baseline gap-2">
              <Label htmlFor="signin-password">Password</Label>
              {/* Not a link. There is no reset flow to send anybody to. */}
              <span className="mg-field__hint ml-auto">Forgotten it? An admin resets it</span>
            </div>
            <div className="relative">
              <Input
                id="signin-password"
                name="password"
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={form.password}
                onChange={set('password')}
                disabled={busy}
                className="h-12 pr-[76px]"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                aria-pressed={show}
                /* Deliberately not "Show the password": that phrase contains
                   the field's own label, so every accessible lookup for
                   "Password" would match this button as well as the box. */
                aria-label={show ? 'Hide what I typed' : 'Show what I typed'}
                className="mg-btn mg-btn--ghost mg-btn--sm absolute top-1.5 right-1.5"
              >
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <button type="submit" className="mg-btn mg-btn--primary mg-btn--lg w-full" disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {/* Said before anybody trips it; the count appears only once it is nearly up. */}
        <p className="m-0 flex items-start gap-2 text-[12.5px] text-secondary-text">
          <Lock size={16} strokeWidth={1.8} aria-hidden="true" className="mt-px shrink-0 text-muted-foreground" />
          After 10 wrong attempts from this device, sign-in pauses for 15 minutes.
        </p>
        <p className="m-0 border-t border-line pt-3.5 text-[12.5px] text-muted-foreground">
          {mode === 'shared'
            ? 'The team shares one sign-in. Ask an admin for it.'
            : 'There is no sign-up. An admin creates accounts in Settings › Users & roles.'}
        </p>
      </main>
    </div>
  );
}
