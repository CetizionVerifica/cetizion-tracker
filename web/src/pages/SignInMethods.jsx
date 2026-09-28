import { Check, Copy, TriangleAlert } from 'lucide-react';
import { SettingsPane } from './SettingsArea.jsx';
import { Chip, RecordSection } from '../components/record.jsx';
import { Button } from '../components/ui/button.tsx';
import { Alert, ErrorState, useToast } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';

/**
 * Sign-in methods (C18) — a setup screen, not a switch.
 *
 * Microsoft and Google are configured in the environment, not in the
 * database, so there is nothing here to turn on. What there is instead is
 * the thing that was missing: a missing or mistyped variable used to mean
 * a button that silently never appeared, and the only way to tell a blank
 * secret from a wrong redirect was to read the source.
 *
 * So this says which variable names are still blank — never their values —
 * and prints the redirect URI this server will send, which is the string
 * that has to match the provider's console to the character.
 */

const STEPS = {
  microsoft: [
    'Open the app registration in Microsoft Entra ID — the same one the mailbox sync uses.',
    'Under Authentication → Redirect URIs (Web), add the redirect URI above alongside the mailbox one. Two separate redirects is deliberate: a consent granted for reading mail must not come back as a sign-in.',
    'Under API permissions, add the delegated permissions openid, email and profile.',
    'Set MS_SIGNIN_REDIRECT_URI to the same URI. MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET are the ones the mailbox sync already needs.',
  ],
  google: [
    'In the Google Cloud console, create an OAuth client of type "Web application". Nothing else here uses Google, so this is a new client.',
    'Add the redirect URI above as an Authorised redirect URI.',
    'On the consent screen, set the user type to Internal so only your workspace can use it.',
    'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.',
  ],
};

export function SignInMethods() {
  const toast = useToast();
  const { data, loading, error, refetch } = useFetch(() => api.raw('/auth/providers'), []);

  if (error) return <SettingsPane title="Sign-in methods"><ErrorState message={error} onRetry={refetch} /></SettingsPane>;
  if (loading || !data) return <SettingsPane title="Sign-in methods"><div className="skeleton" style={{ height: 200 }} /></SettingsPane>;

  const { mode, providers } = data.data;

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied', 'success');
    } catch {
      toast('Could not reach the clipboard — select it and copy by hand', 'danger');
    }
  };

  return (
    <SettingsPane
      title="Sign-in methods"
      description="Microsoft 365 and Google sign people into an account that already exists here. Neither can create one, so an admin still adds the person under Users & roles first."
    >
      {mode !== 'database' && (
        <Alert tone="warning">
          <span>
            This deployment signs in with one shared account (<code>AUTH_MODE=shared</code>), so provider
            sign-in is off whatever else is set: there is no per-person row for an identity to attach to.
            Everything below is what it would need once the mode changes.
          </span>
        </Alert>
      )}

      {providers.map((p) => (
        <RecordSection
          key={p.id}
          title={p.label}
          hint={p.enabled ? 'Offered on the sign-in page' : 'Not offered yet'}
          action={p.enabled
            ? <Chip tone="settled" icon={Check}>Ready</Chip>
            : <Chip tone="waiting" icon={TriangleAlert}>{p.missing.length} to set</Chip>}
        >
          <div className="px-5 py-5">
            {p.missing.length > 0 && (
              <div className="mb-5">
                <div className="text-[12.5px] font-medium text-foreground">Still blank in the environment</div>
                <ul className="mt-1.5 flex flex-wrap gap-2">
                  {p.missing.map((name) => (
                    <li key={name} className="num rounded-[6px] border border-waiting/28 bg-waiting/10 px-2 py-1 text-[11.5px] text-waiting">
                      {name}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="text-[12.5px] font-medium text-foreground">Redirect URI</div>
            {p.redirect_uri ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <code className="num min-w-0 flex-1 truncate rounded-[6px] border border-border bg-secondary px-2.5 py-1.5 text-[12px] text-secondary-text">
                  {p.redirect_uri}
                </code>
                <Button variant="ghost" size="sm" onClick={() => copy(p.redirect_uri)}>
                  <Copy className="size-3.5" strokeWidth={1.75} aria-hidden="true" /> Copy
                </Button>
              </div>
            ) : (
              <p className="mt-1.5 text-[12.5px] text-muted-foreground">
                Not set yet. It is this site's address followed by{' '}
                <code className="num text-secondary-text">{p.callback_path}</code> — for example{' '}
                <code className="num text-secondary-text">https://tracker.example.com{p.callback_path}</code>.
                The same string goes in the provider's console and in the environment variable, and they must match exactly.
              </p>
            )}

            <ol className="mt-5 grid gap-2 text-[12.5px]/[1.6] text-secondary-text">
              {STEPS[p.id].map((step, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="num mt-px shrink-0 text-muted-foreground">{i + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </RecordSection>
      ))}

      <p className="text-[12px]/[1.6] text-muted-foreground">
        Values are set in the environment and read when the API starts, so a change needs a redeploy.
        This page never shows a secret back — only whether its variable is blank. Refresh it after a
        deploy to see whether the provider came up.
      </p>
      <div>
        <Button variant="secondary" size="sm" onClick={refetch}>Check again</Button>
      </div>
    </SettingsPane>
  );
}
