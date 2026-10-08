import { Copy, Globe, LayoutGrid, RefreshCw } from 'lucide-react';
import { SettingsPane } from './SettingsArea.jsx';
import { useToast } from '../components/ui.jsx';
import { FailedCard, LoadingPanel } from '../components/daily.jsx';
import { MoneyBanner } from '../components/money.jsx';
import { Tone } from '../components/sales.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';

/**
 * Sign-in methods (C18) — a setup screen, not a switch. Wave 8.
 *
 * Microsoft and Google are configured in the environment, not in the
 * database, so there is nothing here to turn on. This says which variable
 * names are still blank — never their values — and prints the redirect URI
 * this server will send, wrapped rather than truncated, because it is the
 * string that has to match the provider's console to the character.
 */

const STEPS = {
  microsoft: [
    'Open the app registration in Microsoft Entra ID, the same one the mailbox sync uses.',
    'Under Authentication, add the redirect URI above as a Web redirect URI, beside the mailbox one. Two separate redirects is deliberate: a consent granted for reading mail must not come back as a sign-in.',
    'Under API permissions, add the delegated permissions openid, email and profile.',
    'Set MS_SIGNIN_REDIRECT_URI to the same address. MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET are the ones the mailbox sync already needs.',
  ],
  google: [
    'In the Google Cloud console, create an OAuth client of type Web application. Nothing else here uses Google, so this is a new client.',
    'Add the redirect URI above to its authorised redirect URIs.',
    'On the consent screen, set the user type to Internal so only your workspace can sign in.',
    'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI, then redeploy.',
  ],
};
const ICON = { microsoft: LayoutGrid, google: Globe };

export function SignInMethods() {
  const toast = useToast();
  const { data, loading, error, refetch } = useFetch(() => api.raw('/auth/providers'), []);
  const check = <button type="button" className="mg-btn" onClick={refetch} disabled={loading}><RefreshCw className="size-4" aria-hidden="true" />{loading && data ? 'Checking…' : 'Check again'}</button>;
  const head = {
    title: 'Sign-in methods',
    description: 'Microsoft 365 and Google sign people in to an account that already exists here. Neither can create one, so an admin adds the person under Users & roles first.',
    actions: check,
  };

  if (error) return <SettingsPane {...head}><FailedCard title="Couldn’t load sign-in methods" text="The server didn’t answer, so nothing is shown. Nothing has changed. Try again in a moment." onRetry={refetch} /></SettingsPane>;
  if (!data) return <SettingsPane {...head}><LoadingPanel rows={4} /></SettingsPane>;

  const { mode, providers } = data.data;
  const shared = mode !== 'database';

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied', 'success');
    } catch {
      toast('Couldn’t reach the clipboard. Select it and copy by hand.', 'danger');
    }
  };

  return (
    <SettingsPane {...head}>
      {shared && (
        <MoneyBanner tone="wait" title="This deployment signs everyone in with one shared account.">
          {' '}Provider sign-in stays off whatever is set below, because there is no personal account for it to attach to. This is what each provider would need once personal sign-ins are on.
        </MoneyBanner>
      )}

      <div className="set-two">
        {providers.map((p) => {
          const Icon = ICON[p.id] || Globe;
          return (
            <section key={p.id} className="mg-glass mg-glass--strong mg-panel set-prov" data-a="rise" aria-labelledby={`set-pv-${p.id}`}>
              <div className="set-prov__head">
                <span className="set-prov__mark"><Icon aria-hidden="true" /></span>
                <div className="min-w-0 flex-1">
                  <h2 className="mg-panel__title" id={`set-pv-${p.id}`}>{p.label}</h2>
                  <span className="mg-panel__hint">{p.enabled ? (shared ? 'Would be offered on the sign-in page' : 'Offered on the sign-in page') : 'Not offered yet'}</span>
                </div>
                {p.enabled ? <Tone tone="ok">Ready</Tone> : <Tone tone="wait">{p.missing.length} to set</Tone>}
              </div>
              {p.missing.length > 0 && (
                <div>
                  <span className="mg-label">Still blank on the server</span>
                  <div className="mt-2 flex flex-wrap gap-1.5">{p.missing.map((name) => <span key={name} className="mg-badge mg-badge--wait">{name}</span>)}</div>
                </div>
              )}
              <div>
                <span className="mg-label">Redirect URI</span>
                {p.redirect_uri ? (
                  <div className="set-prov__uri">
                    <code>{p.redirect_uri}</code>
                    <button type="button" className="mg-btn mg-btn--sm" aria-label={`Copy the ${p.label} redirect URI`} onClick={() => copy(p.redirect_uri)}><Copy className="size-3.5" aria-hidden="true" />Copy</button>
                  </div>
                ) : (
                  <p className="mt-2 mb-0 text-[13px] break-words text-secondary-text">
                    Not set yet. It’s this site’s address followed by <code>{p.callback_path}</code>, for example <code>{window.location.origin}{p.callback_path}</code>. The same address goes in the provider’s console and in the environment, and the two must match exactly.
                  </p>
                )}
              </div>
              <div>
                <span className="mg-label">Setting it up</span>
                <ol>{STEPS[p.id]?.map((step) => <li key={step}>{step}</li>)}</ol>
              </div>
            </section>
          );
        })}
      </div>

      <p className="mg-glass set-note" data-a="rise">
        Values are set in the environment and read when the API starts, so a change needs a redeploy. This page never shows a secret back, only whether its variable is blank. Press Check again after a deploy to see whether the provider came up.
      </p>
    </SettingsPane>
  );
}
