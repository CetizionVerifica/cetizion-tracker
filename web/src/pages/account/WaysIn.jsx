import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { Chip } from '../../components/record.jsx';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { Separator } from '../../components/ui/separator.tsx';
import { api } from '../../lib/api.js';
import { useAccount } from './index.jsx';
import { Pane } from './Pane.jsx';

const LABEL = { microsoft: 'Microsoft 365', google: 'Google' };

const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : null);

/**
 * The doors into this account: linked providers, and the password.
 *
 * The password used to be crammed into the bottom of the provider list,
 * which made a form look like a fourth row of a table. It is the same kind
 * of thing as a linked provider — a way in — so it belongs in this pane,
 * but below a rule of its own.
 */
export function WaysIn() {
  const { profile, identities, providers, refetch, toast } = useAccount();
  const [passwords, setPasswords] = useState({ current_password: '', new_password: '' });
  const [changing, setChanging] = useState(false);

  const linked = Object.fromEntries(identities.map((i) => [i.provider, i]));
  const known = [...new Set([...providers.map((p) => p.id), ...identities.map((i) => i.provider)])];

  async function unlink(provider) {
    try {
      await api.raw(`/auth/account/identities/${provider}`, { method: 'DELETE' });
      toast(`${LABEL[provider]} unlinked`, 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function changePassword(e) {
    e.preventDefault();
    setChanging(true);
    try {
      await api.raw('/auth/account/password', { method: 'POST', body: passwords });
      toast('Password changed. Every other device has been signed out.', 'success');
      setPasswords({ current_password: '', new_password: '' });
      refetch();
    } catch (err) {
      toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger');
    } finally {
      setChanging(false);
    }
  }

  return (
    <Pane
      title="Ways in"
      description="One person, several doors. Any of them signs you into the same account, and unlinking one never deletes anything."
    >
      {known.length === 0 ? (
        <p className="text-[12.5px]/[1.6] text-muted-foreground">
          This deployment signs in with a password only. Connecting Microsoft 365 or Google is an admin
          job, and <Link to="/settings/sign-in">Settings → Sign-in methods</Link> says what each one needs.
        </p>
      ) : (
        <div className="grid gap-3">
          {known.map((id) => {
            const mine = linked[id];
            return (
              <div key={id} className="flex flex-wrap items-center gap-3 rounded-md border border-border px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-foreground">{LABEL[id] || id}</div>
                  <div className="text-[12px] text-muted-foreground">
                    {mine
                      ? `${mine.email || 'linked'} · linked ${day(mine.linked_at)}`
                      : 'Not linked. Link it to sign in without typing a password.'}
                  </div>
                </div>
                {mine && <Chip tone="settled" icon={Check}>Linked</Chip>}
                {mine
                  ? <Button variant="ghost" size="sm" onClick={() => unlink(id)}>Unlink</Button>
                  : providers.some((p) => p.id === id) && (
                    <Button variant="secondary" size="sm" asChild>
                      <a href={`/api/auth/oauth/${id}/start?next=/account/ways-in`}>Link {LABEL[id]}</a>
                    </Button>
                  )}
              </div>
            );
          })}
        </div>
      )}

      <Separator className="my-6" />

      <form className="grid gap-5 @2xl:grid-cols-2" onSubmit={changePassword}>
        <div className="@2xl:col-span-2">
          <h3 className="text-[13px] font-semibold text-foreground">Password</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {profile.password_set
              ? 'Set. Changing it signs out every other device, and keeps this one.'
              : 'Not set.'}
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="account-current">Current password</Label>
          <Input
            id="account-current"
            type="password"
            autoComplete="current-password"
            value={passwords.current_password}
            onChange={(e) => setPasswords((p) => ({ ...p, current_password: e.target.value }))}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="account-new">New password</Label>
          <Input
            id="account-new"
            type="password"
            autoComplete="new-password"
            value={passwords.new_password}
            onChange={(e) => setPasswords((p) => ({ ...p, new_password: e.target.value }))}
          />
          <p className="text-[12px] text-muted-foreground">Twelve characters or more.</p>
        </div>
        <div className="@2xl:col-span-2">
          <Button
            type="submit"
            variant="secondary"
            disabled={changing || !passwords.current_password || !passwords.new_password}
          >
            {changing ? 'Changing…' : 'Change password'}
          </Button>
        </div>
      </form>

      <p className="mt-6 text-[12px]/[1.6] text-muted-foreground">
        Linking matches on the verified email of the provider account. A different address needs an admin
        to attach it under <Link to="/settings/users">Users &amp; roles</Link>.
      </p>
    </Pane>
  );
}
