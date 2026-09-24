import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Laptop, LogOut, Smartphone } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { SettingsPane } from './SettingsArea.jsx';
import { Chip, RecordSection } from '../components/record.jsx';
import { Button } from '../components/ui/button.tsx';
import { Checkbox } from '../components/ui/checkbox.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { Alert, ErrorState, useToast } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useFetch } from '../lib/hooks.js';
import { ago } from '../lib/format.js';

/**
 * My account (C20) — the ways in, the devices, and the fields only you may
 * change.
 *
 * What is deliberately not here: your role, your email address and whether
 * your account is active. Those are facts about your job rather than about
 * you, and an admin sets them under Users & roles. The page says so rather
 * than showing a greyed-out box, because a disabled field invites somebody
 * to look for the way to enable it.
 */

const NOTIFY_LABEL = {
  follow_up_late: 'A follow-up of mine is late',
  deal_accepted: 'A deal I own is accepted, or a PO arrives',
  discount_approval: 'A discount needs my approval',
  monday_brief: 'The Monday management brief',
};

const PROVIDER_LABEL = { microsoft: 'Microsoft 365', google: 'Google' };

const day = (value) => (value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : null);

/** A phone is drawn as a phone: the row is how somebody recognises a device. */
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

export default function Account() {
  const toast = useToast();
  const { signOut } = useAuth();
  const { data, loading, error, refetch } = useFetch(() => api.raw('/auth/account'), []);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [changing, setChanging] = useState(false);
  const [passwords, setPasswords] = useState({ current_password: '', new_password: '' });

  if (error) {
    return (
      <>
        <PageHeader title="My account" />
        <div className="page"><ErrorState message={error} onRetry={refetch} /></div>
      </>
    );
  }
  if (loading || !data) {
    return (
      <>
        <PageHeader title="My account" />
        <div className="page"><div className="skeleton" style={{ height: 240 }} /></div>
      </>
    );
  }

  const { profile, identities, sessions, providers, notify_keys: notifyKeys } = data.data;
  const values = form ?? {
    name: profile.name || '',
    signature: profile.signature || '',
    phone: profile.phone || '',
    time_zone: profile.time_zone || '',
  };
  const set = (key) => (e) => setForm({ ...values, [key]: e.target.value });

  async function saveProfile(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.raw('/auth/account', { method: 'PATCH', body: values });
      toast('Saved', 'success');
      setForm(null);
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function toggleNotify(key, on) {
    try {
      await api.raw('/auth/account', { method: 'PATCH', body: { notify: { [key]: on } } });
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

  async function unlink(provider) {
    try {
      await api.raw(`/auth/account/identities/${provider}`, { method: 'DELETE' });
      toast(`${PROVIDER_LABEL[provider]} unlinked`, 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function endSession(session) {
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

  const linked = Object.fromEntries(identities.map((i) => [i.provider, i]));

  return (
    <>
      <PageHeader title="My account" subtitle="How you sign in, where you are signed in, and what the rest of the app calls you." />

      <SettingsPane
        title={profile.name}
        description={`${profile.email} · ${profile.role === 'admin' ? 'Admin' : 'Sales'}. Your role and email address are set by an admin under Settings → Users & roles.`}
      >
        <RecordSection title="Profile" hint="What the app calls you, and what it prints">
          <form className="grid gap-4 px-5 py-5 @2xl:grid-cols-2" onSubmit={saveProfile}>
            <div className="grid gap-1.5">
              <Label htmlFor="account-name">Display name</Label>
              <Input id="account-name" value={values.name} onChange={set('name')} required />
              <p className="text-[12px] text-muted-foreground">Shown as the owner on deals and in the timeline.</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="account-signature">Signature on quotations</Label>
              <Input id="account-signature" value={values.signature} onChange={set('signature')} placeholder="Shyam R. · Director, Sales" />
              <p className="text-[12px] text-muted-foreground">Printed under your name on the PDF.</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="account-phone">Phone</Label>
              <Input id="account-phone" value={values.phone} onChange={set('phone')} autoComplete="tel" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="account-tz">Time zone</Label>
              <Input id="account-tz" value={values.time_zone} onChange={set('time_zone')} placeholder="Asia/Kolkata" />
            </div>
            <div className="@2xl:col-span-2">
              <Button type="submit" disabled={saving || !form}>{saving ? 'Saving…' : 'Save'}</Button>
            </div>
          </form>
        </RecordSection>

        <RecordSection title="Email me when" hint="Each one saves as you tick it">
          <div className="grid gap-3 px-5 py-5">
            {notifyKeys.map((key) => (
              <div key={key} className="flex items-center gap-3">
                <Checkbox
                  id={`notify-${key}`}
                  checked={profile.notify?.[key] === true}
                  onCheckedChange={(on) => toggleNotify(key, on === true)}
                />
                <Label htmlFor={`notify-${key}`} className="text-[13px] font-normal text-secondary-text">
                  {NOTIFY_LABEL[key] || key}
                </Label>
              </div>
            ))}
          </div>
        </RecordSection>

        <RecordSection title="Ways in" hint="One person, several doors. Unlinking one never deletes anything.">
          <div className="divide-y divide-border">
            {providers.length === 0 && identities.length === 0 && (
              <p className="px-5 py-4 text-[12.5px] text-muted-foreground">
                This deployment signs in with a password only. Connecting Microsoft 365 or Google is an
                admin job, and <Link to="/settings/sign-in">Settings → Sign-in methods</Link> says exactly
                what each one still needs.
              </p>
            )}

            {[...new Set([...providers.map((p) => p.id), ...identities.map((i) => i.provider)])].map((id) => {
              const mine = linked[id];
              return (
                <div key={id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-foreground">{PROVIDER_LABEL[id] || id}</div>
                    <div className="text-[12px] text-muted-foreground">
                      {mine
                        ? `${mine.email || 'linked'} · linked ${day(mine.linked_at)}`
                        : 'Not linked. Link it to sign in without typing a password.'}
                    </div>
                  </div>
                  {mine ? <Chip tone="settled">Linked</Chip> : null}
                  {mine
                    ? <Button variant="ghost" size="sm" onClick={() => unlink(id)}>Unlink</Button>
                    : providers.some((p) => p.id === id) && (
                      <Button variant="secondary" size="sm" asChild>
                        <a href={`/api/auth/oauth/${id}/start?next=/account`}>Link {PROVIDER_LABEL[id]}</a>
                      </Button>
                    )}
                </div>
              );
            })}

            <form className="grid gap-4 px-5 py-5 @2xl:grid-cols-2" onSubmit={changePassword}>
              <div className="@2xl:col-span-2">
                <div className="text-[13px] font-medium text-foreground">Password</div>
                <div className="text-[12px] text-muted-foreground">
                  {profile.password_set ? 'Set. Changing it signs out every other device.' : 'Not set.'}
                </div>
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
          </div>
        </RecordSection>

        <RecordSection
          title="Where you're signed in"
          hint="Sessions last 12 hours"
          action={<Button variant="secondary" size="sm" onClick={endEverything}>Sign out everywhere</Button>}
        >
          <div className="divide-y divide-border">
            {sessions.length === 0 && (
              <p className="px-5 py-4 text-[12.5px] text-muted-foreground">Nothing recorded yet.</p>
            )}
            {sessions.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                {isHandheld(s.user_agent)
                  ? <Smartphone className="size-4 shrink-0 text-secondary-text" strokeWidth={1.75} aria-hidden="true" />
                  : <Laptop className="size-4 shrink-0 text-secondary-text" strokeWidth={1.75} aria-hidden="true" />}
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-foreground">
                    {device(s.user_agent)}
                    {s.current && <span className="ml-2 text-[12px] text-primary">this device</span>}
                  </div>
                  <div className="text-[12px] text-muted-foreground">
                    via {s.via === 'password' ? 'password' : PROVIDER_LABEL[s.via] || s.via}
                    {' · '}{ago(s.last_seen_at) || 'just now'}
                    {s.ip ? ` · ${s.ip}` : ''}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => endSession(s)}>
                  <LogOut className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                  {s.current ? 'Sign out here' : 'Sign out'}
                </Button>
              </div>
            ))}
          </div>
        </RecordSection>

        <Alert tone="info">
          <span>
            Linking matches on the verified email of the provider account. A different address needs an
            admin to attach it under <Link to="/settings/users">Users &amp; roles</Link>.
          </span>
        </Alert>
      </SettingsPane>
    </>
  );
}
