import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, TriangleAlert } from 'lucide-react';

import { useAuth } from '../lib/auth.jsx';
import { ApiError } from '../lib/api.js';
import { Alert, AlertDescription } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardContent } from '../components/ui/card.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { Separator } from '../components/ui/separator.tsx';

/**
 * Sign in (C18), drawn as the design draws it.
 *
 * The form asks for whatever the API signs people in with: a username while
 * the tracker is on the shared password, an email once it is on the users
 * table. The server says which — see /auth/config — so the deployment's
 * choice is not copied into the build. The same endpoint says which
 * providers are configured, and an unconfigured one is not drawn: a
 * "Continue with Google" that 404s is worse than no button.
 *
 * Two places this departs from the mock, both because the mock is drawing
 * a future the code does not have yet:
 *
 *   The design names the product "Attest" (C17 proposes three marks). The
 *   app is called Cetizion Tracker in the sidebar, the page titles and the
 *   emails it sends, so renaming it is a decision for a person, not
 *   something to slip in through the sign-in page.
 *
 *   "Forgot it?" is drawn as a link. There is no reset flow — C11 proposes
 *   one, nobody has built it — so this says who to ask instead. A link that
 *   goes nowhere teaches people the page is lying to them.
 *
 * The staging band the design mentions is already handled: EnvironmentBanner
 * renders it above every page, this one included.
 */
const FIELD = {
  shared: { label: 'Username', type: 'text', autoComplete: 'username', name: 'username' },
  database: { label: 'Email', type: 'email', autoComplete: 'email', name: 'email' },
};

/** Provider marks, drawn rather than fetched: a sign-in page loads nothing third-party. */
const MARK = {
  microsoft: (
    <span className="grid size-4 shrink-0 grid-cols-2 gap-[2px]" aria-hidden="true">
      <span className="bg-[#f25022]" />
      <span className="bg-[#7fba00]" />
      <span className="bg-[#00a4ef]" />
      <span className="bg-[#ffb900]" />
    </span>
  ),
  google: (
    <svg viewBox="0 0 18 18" className="size-4 shrink-0" aria-hidden="true">
      <path fill="#4285f4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z" />
      <path fill="#34a853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18z" />
      <path fill="#fbbc05" d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H.9a9 9 0 0 0 0 8l3-2.3z" />
      <path fill="#ea4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z" />
    </svg>
  ),
};

/**
 * Microsoft's button is light and Google's is dark, which is not a whim:
 * both brands publish button guidance, and a Microsoft mark on a dark
 * button is the arrangement their own guidelines rule out.
 */
const PROVIDER_CLASS = {
  microsoft: 'h-11 w-full justify-center gap-3 bg-[#f4f4f6] text-[14px] font-semibold text-[#0a0a0c] hover:bg-[#e6e6ea]',
  google: 'h-11 w-full justify-center gap-3 border border-border-strong bg-secondary text-[14px] font-semibold text-foreground hover:bg-accent',
};

export default function Login() {
  const { signIn, mode, providers = [] } = useAuth();
  const field = FIELD[mode] ?? FIELD.shared;
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState(null);
  const [attemptsLeft, setAttemptsLeft] = useState(null);
  const [lockoutMinutes, setLockoutMinutes] = useState(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  // The provider callback sends people back here with ?sso=refused when it
  // turns them away. It was writing that and nobody was reading it, so a
  // refused sign-in looked exactly like never having pressed the button.
  // One wording for every reason it refuses — which reason it was belongs
  // in the server log, not on a page anyone can reach unauthenticated.
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
      setError(err.message);
      // The server counts the failures and only mentions them at the end,
      // so an ordinary typo is not alarming and the number is not a running
      // commentary for whoever is guessing.
      const details = err instanceof ApiError ? err.details : null;
      setAttemptsLeft(details?.attempts_left ?? null);
      setLockoutMinutes(details?.lockout_minutes ?? null);
      setForm((prev) => ({ ...prev, password: '' }));
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4 py-10">
      <Card className="w-full max-w-[480px] gap-0 rounded-xl py-0">
        <CardContent className="flex flex-col justify-center gap-7 px-6 py-10 sm:px-10 sm:py-12">
          <div className="flex items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-primary">
              <Check className="size-[18px] text-primary-foreground" strokeWidth={3.4} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="font-display text-[16px] font-bold tracking-[-0.01em] text-foreground">Sales Tracker</div>
              <div className="text-[12px] text-muted-foreground">Sales, projects and expenses</div>
            </div>
          </div>

          <div>
            <h1 className="text-[24px]/[1.25] font-semibold tracking-[-0.022em] text-foreground">Sign in</h1>
            <p className="mt-1.5 text-[13px]/[1.6] text-secondary-text">
              {providers.length
                ? 'Use the work account you read email with. Sessions last 12 hours.'
                : 'Sessions last 12 hours.'}
            </p>
          </div>

          {providers.length > 0 && (
            <>
              <div className="flex flex-col gap-2.5">
                {providers.map((p) => (
                  <Button key={p.id} variant="ghost" className={PROVIDER_CLASS[p.id]} asChild>
                    {/* A real link, not a fetch: the browser has to leave for
                        the provider and come back holding a cookie, which
                        XHR cannot do. */}
                    <a href={`/api/auth/oauth/${p.id}/start`}>
                      {MARK[p.id]} Continue with {p.label}
                    </a>
                  </Button>
                ))}
              </div>

              <div className="flex items-center gap-3">
                <Separator className="flex-1" />
                <span className="text-[12px] text-muted-foreground">or with a password</span>
                <Separator className="flex-1" />
              </div>
            </>
          )}

          <form className="flex flex-col gap-4" onSubmit={submit}>
            {refused && !error && (
              <Alert variant="destructive">
                <AlertDescription>
                  That account cannot sign in here. Ask an admin to add it under Users &amp; roles,
                  or sign in with a password.
                </AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div>
              <Label htmlFor="signin-id" className="mb-2 text-[12.5px] font-medium text-secondary-text">
                {field.label}
              </Label>
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
                className="h-10 text-[13.5px]"
              />
            </div>

            <div>
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <Label htmlFor="signin-password" className="text-[12.5px] font-medium text-secondary-text">
                  Password
                </Label>
                {/* Not a link. There is no reset flow to send anybody to. */}
                <span className="text-[12px] text-muted-foreground">Forgotten it? An admin resets it</span>
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
                  className="h-10 pr-16 text-[13.5px]"
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  aria-pressed={show}
                  /* Deliberately not "Show the password": that phrase
                     contains the field's own label, so every accessible
                     lookup for "Password" — a screen reader's, a test's —
                     would match this button as well as the box. */
                  aria-label={show ? 'Hide what I typed' : 'Show what I typed'}
                  className="absolute inset-y-0 right-0 rounded-r-md px-3 text-[12px] font-medium text-muted-foreground hover:text-foreground"
                >
                  {show ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <Button type="submit" className="h-10 w-full text-[14px] font-semibold" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          {/* The rule is stated before anybody trips it, because the person
              it inconveniences most is usually not the one who typed the
              wrong password — a shared address can be locked by somebody
              else entirely. The count appears only once it is nearly up. */}
          <div className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary px-3.5 py-3">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-waiting" strokeWidth={2.2} aria-hidden="true" />
            <p className="text-[12.5px]/[1.6] text-secondary-text">
              Ten wrong attempts in fifteen minutes lock sign-in for everyone until the window passes.
              {attemptsLeft != null && (
                <span role="status" className="text-waiting">
                  {' '}{attemptsLeft} attempt{attemptsLeft === 1 ? '' : 's'} left
                  {lockoutMinutes ? `, then ${lockoutMinutes} minutes` : ''}.
                </span>
              )}
            </p>
          </div>

          <p className="text-[11.5px]/[1.6] text-muted-foreground">
            There is no sign-up. An admin creates accounts under Settings → Users &amp; roles.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
