import { useState } from 'react';
import { Eye, EyeOff, TriangleAlert } from 'lucide-react';

import { useAuth } from '../lib/auth.jsx';
import { ApiError } from '../lib/api.js';
import { Alert, AlertDescription } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardContent } from '../components/ui/card.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { Separator } from '../components/ui/separator.tsx';

/**
 * Sign in (C18).
 *
 * The form asks for whatever the API signs people in with: a username while
 * the tracker is on the shared password, an email once it is on the users
 * table. The server tells us which — see /auth/config — so the
 * deployment's choice is not copied into the build.
 *
 * The same endpoint says which providers are configured. An unconfigured
 * one is not drawn: a "Continue with Google" button that returns 404 is
 * worse than no button, and on a deployment that has never set up either,
 * the page is exactly what it was before.
 */
const FIELD = {
  shared: { label: 'Username', type: 'text', autoComplete: 'username', name: 'username' },
  database: { label: 'Email', type: 'email', autoComplete: 'email', name: 'email' },
};

/** Provider marks, drawn rather than fetched: a sign-in page loads nothing third-party. */
const MARK = {
  microsoft: (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
      <rect x="0" y="0" width="7" height="7" fill="#f25022" />
      <rect x="9" y="0" width="7" height="7" fill="#7fba00" />
      <rect x="0" y="9" width="7" height="7" fill="#00a4ef" />
      <rect x="9" y="9" width="7" height="7" fill="#ffb900" />
    </svg>
  ),
  google: (
    <svg viewBox="0 0 18 18" className="size-4" aria-hidden="true">
      <path fill="#4285f4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z" />
      <path fill="#34a853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18z" />
      <path fill="#fbbc05" d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H.9a9 9 0 0 0 0 8l3-2.3z" />
      <path fill="#ea4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z" />
    </svg>
  ),
};

export default function Login() {
  const { signIn, mode, providers = [] } = useAuth();
  const field = FIELD[mode] ?? FIELD.shared;
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState(null);
  const [warning, setWarning] = useState(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  async function submit(event) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);
    try {
      await signIn(form.username, form.password);
    } catch (err) {
      setError(err.message);
      // The server counts the failures and only mentions them at the end,
      // so a typo is not alarming. When it does, say what "locked" means
      // and for how long, because the next person to try will be locked
      // out by somebody else's mistake and deserves to know why.
      const left = err instanceof ApiError ? err.details?.attempts_left : null;
      setWarning(left
        ? `${left} attempt${left === 1 ? '' : 's'} left before this account is locked from here for ${err.details.lockout_minutes} minutes.`
        : null);
      setForm((prev) => ({ ...prev, password: '' }));
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-[10px] bg-primary text-[15px] font-bold text-primary-foreground">C</span>
          <div>
            <h1 className="text-[16px] font-semibold text-foreground">Cetizion Tracker</h1>
            <p className="text-[12.5px] text-muted-foreground">Sales · Projects · Payments · Travel</p>
          </div>
        </div>

        <Card className="mt-5 gap-0 rounded-[12px] py-0">
          <CardContent className="px-6 py-6">
            <h2 className="text-[15px] font-semibold text-foreground">Sign in</h2>
            <p className="mt-1 text-[12.5px] text-secondary-text">
              {providers.length
                ? 'Use the work account you read email with. Sessions last 12 hours.'
                : 'Sessions last 12 hours.'}
            </p>

            {providers.length > 0 && (
              <>
                <div className="mt-5 grid gap-2">
                  {providers.map((p) => (
                    <Button key={p.id} variant="secondary" className="w-full justify-center" asChild>
                      {/* A real link, not a fetch: the browser has to leave
                          for the provider and come back with a cookie, and
                          XHR cannot do that. */}
                      <a href={`/api/auth/oauth/${p.id}/start`}>
                        {MARK[p.id]} Continue with {p.label}
                      </a>
                    </Button>
                  ))}
                </div>
                <div className="my-5 flex items-center gap-3">
                  <Separator className="flex-1" />
                  <span className="text-[11.5px] text-muted-foreground">or with a password</span>
                  <Separator className="flex-1" />
                </div>
              </>
            )}

            <form className={providers.length ? '' : 'mt-5'} onSubmit={submit}>
              {error && (
                <Alert variant="destructive" className="mb-4">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="grid gap-1.5">
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
                />
              </div>

              <div className="mt-4 grid gap-1.5">
                <Label htmlFor="signin-password">Password</Label>
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
                    className="pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setShow((s) => !s)}
                    /* Deliberately not "Show the password": that phrase
                       contains the field's own label, so every accessible
                       lookup for "Password" — a screen reader's, a test's —
                       matches the button as well as the box. */
                    aria-label={show ? 'Hide what I typed' : 'Show what I typed'}
                    aria-pressed={show}
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
                  >
                    {show ? <EyeOff className="size-4" strokeWidth={1.75} aria-hidden="true" /> : <Eye className="size-4" strokeWidth={1.75} aria-hidden="true" />}
                  </Button>
                </div>
              </div>

              <Button type="submit" className="mt-5 w-full" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>

            {warning && (
              <p className="mt-4 flex items-start gap-2 text-[12px]/[1.5] text-waiting">
                <TriangleAlert className="mt-px size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                <span role="status">{warning}</span>
              </p>
            )}
          </CardContent>
        </Card>

        <p className="mt-4 text-[12px]/[1.6] text-muted-foreground">
          There is no sign-up. Accounts are created by an admin under Settings → Users.
        </p>
      </div>
    </div>
  );
}
