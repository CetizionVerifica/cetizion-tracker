import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { api } from '../../lib/api.js';
import { useAccount } from './index.jsx';
import { Pane } from './Pane.jsx';

/**
 * The four fields a person owns about themselves.
 *
 * Placeholders are written as instructions, not as plausible values: the
 * first version used "Shyam R. · Director, Sales" and "Asia/Kolkata",
 * which at a glance read as filled-in fields belonging to somebody else.
 */
export function Profile() {
  const { profile, refetch, toast } = useAccount();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const values = form ?? {
    name: profile.name || '',
    signature: profile.signature || '',
    phone: profile.phone || '',
    time_zone: profile.time_zone || '',
  };
  const set = (key) => (e) => setForm({ ...values, [key]: e.target.value });

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.raw('/auth/account', { method: 'PATCH', body: values });
      toast('Saved', 'success');
      setForm(null);
      refetch();
    } catch (err) {
      toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Pane
      title="Profile"
      description="What the app calls you, and what it prints under your name."
    >
      <form className="grid gap-5 @2xl:grid-cols-2" onSubmit={save}>
        <div className="grid gap-1.5">
          <Label htmlFor="account-name">Display name</Label>
          <Input id="account-name" value={values.name} onChange={set('name')} required />
          <p className="text-[12px] text-muted-foreground">Shown as the owner on deals and in the timeline.</p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="account-signature">Signature on quotations</Label>
          <Input
            id="account-signature"
            value={values.signature}
            onChange={set('signature')}
            placeholder="Your name and title"
          />
          <p className="text-[12px] text-muted-foreground">Printed under your name on the PDF.</p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="account-phone">Phone</Label>
          <Input id="account-phone" value={values.phone} onChange={set('phone')} autoComplete="tel" placeholder="Optional" />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="account-tz">Time zone</Label>
          <Input
            id="account-tz"
            value={values.time_zone}
            onChange={set('time_zone')}
            placeholder={`Defaults to ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}
          />
        </div>

        <div className="@2xl:col-span-2">
          {/* Disabled until something changes, so the button says whether
              there is anything to save rather than always looking ready. */}
          <Button type="submit" disabled={saving || !form}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>

      <p className="mt-6 text-[12px]/[1.6] text-muted-foreground">
        Your role and email address are set by an admin under{' '}
        <Link to="/settings/users">Settings → Users &amp; roles</Link>.
      </p>
    </Pane>
  );
}
