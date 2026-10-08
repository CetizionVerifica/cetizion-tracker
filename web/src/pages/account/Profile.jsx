import { useState } from 'react';
import { Link } from 'react-router-dom';
import { cn } from 'cn';
import { api } from '../../lib/api.js';
import { useAccount } from './index.jsx';
import { Pane } from './Pane.jsx';

const ZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York'];

/**
 * The four fields a person owns about themselves. Placeholders are written
 * as instructions, not as plausible values.
 */
export function Profile() {
  const { profile, refetch, toast } = useAccount();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

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
    setError(null);
    try {
      await api.raw('/auth/account', { method: 'PATCH', body: values });
      toast('Saved', 'success');
      setForm(null);
      refetch();
    } catch (err) {
      setError(err.fields ? Object.values(err.fields)[0] : err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Pane>
        <form className="flex flex-col gap-4" onSubmit={save}>
          <div className="mg-grid2">
            <label className="mg-field">
              <span className="mg-field__label">Display name<span className="req" aria-hidden="true">*</span></span>
              <input className="mg-input" id="account-name" value={values.name} onChange={set('name')} required />
              <span className="mg-field__hint">Shown as the owner on deals and in the timeline.</span>
            </label>
            <label className="mg-field">
              <span className="mg-field__label">Signature on quotations</span>
              <input className="mg-input" id="account-signature" value={values.signature} onChange={set('signature')} placeholder="Your name and title" />
              <span className="mg-field__hint">Printed under your name on the PDF.</span>
            </label>
            <label className="mg-field">
              <span className="mg-field__label">Phone</span>
              <input className="mg-input" id="account-phone" type="tel" value={values.phone} onChange={set('phone')} autoComplete="tel" placeholder="Optional" />
            </label>
            <label className="mg-field">
              <span className="mg-field__label">Time zone</span>
              <input className="mg-input" id="account-tz" list="account-zones" value={values.time_zone} onChange={set('time_zone')} placeholder={`Defaults to ${Intl.DateTimeFormat().resolvedOptions().timeZone}`} />
              <datalist id="account-zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
            </label>
          </div>
          {error && <span className="mg-field__error" role="alert">{error}</span>}
          <div className="set-savebar">
            {/* Disabled until something changes, so the button says whether there is anything to save. */}
            <button type="submit" className="mg-btn mg-btn--primary" disabled={saving || !form}>{saving ? 'Saving…' : 'Save'}</button>
            {form && !saving && <button type="button" className="mg-btn mg-btn--ghost" onClick={() => setForm(null)}>Discard</button>}
            <span className={cn('text-[13px]', form ? 'font-semibold text-caramel-text' : 'text-muted-foreground')}>{form ? 'Not saved yet' : 'Nothing has changed yet'}</span>
          </div>
        </form>
      </Pane>
      <p className="mg-glass set-note" data-a="rise">
        {profile.role === 'admin'
          ? <>Your role and email address are set under <Link to="/settings/users">Settings › Users &amp; roles</Link>.</>
          : 'Your role and email address are set by an admin. Ask one if either needs to change.'}
      </p>
    </>
  );
}
