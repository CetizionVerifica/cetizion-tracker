import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe, LayoutGrid } from 'lucide-react';
import { ConfirmDialog, Modal } from '../../components/ui.jsx';
import { MoneyBanner } from '../../components/money.jsx';
import { Tone } from '../../components/sales.jsx';
import { api } from '../../lib/api.js';
import { useAccount } from './index.jsx';
import { Pane } from './Pane.jsx';

const LABEL = { microsoft: 'Microsoft 365', google: 'Google' };
const ICON = { microsoft: LayoutGrid, google: Globe };

const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : null);

/**
 * The doors into this account: linked providers, and the password (Wave 8).
 * Unlinking asks first; unlinking the only way in is refused with the reason
 * (set a password or link the other provider first).
 */
export function WaysIn() {
  const { profile, identities, providers, refetch, toast } = useAccount();
  const [passwords, setPasswords] = useState({ current_password: '', new_password: '' });
  const [changing, setChanging] = useState(false);
  const [pwError, setPwError] = useState(null);
  const [unlinking, setUnlinking] = useState(null);
  const [busy, setBusy] = useState(false);

  const linked = Object.fromEntries(identities.map((i) => [i.provider, i]));
  const known = [...new Set([...providers.map((p) => p.id), ...identities.map((i) => i.provider)])];
  const onlyWay = !profile.password_set && identities.length <= 1;

  async function unlink(provider) {
    setBusy(true);
    try {
      await api.raw(`/auth/account/identities/${provider}`, { method: 'DELETE' });
      toast(`${LABEL[provider]} unlinked`, 'success');
      setUnlinking(null);
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(e) {
    e.preventDefault();
    setChanging(true);
    setPwError(null);
    try {
      await api.raw('/auth/account/password', { method: 'POST', body: passwords });
      toast('Password changed. Every other device has been signed out.', 'success');
      setPasswords({ current_password: '', new_password: '' });
      refetch();
    } catch (err) {
      setPwError(err.fields ? Object.values(err.fields)[0] : err.message);
    } finally {
      setChanging(false);
    }
  }

  return (
    <>
      <Pane title="Microsoft 365 and Google" description="Any of them signs you in to the same account, and unlinking one never deletes anything.">
        {known.length === 0 ? (
          <p className="m-0 text-[13px] text-secondary-text">
            This deployment signs in with a password only. Connecting Microsoft 365 or Google is an admin job
            {profile.role === 'admin' ? <>, and <Link className="set-link" to="/settings/sign-in">Settings › Sign-in methods</Link> says what each one needs.</> : '.'}
          </p>
        ) : (
          <div className="acc-list">
            {known.map((id) => {
              const mine = linked[id];
              const Icon = ICON[id] || Globe;
              return (
                <div key={id} className="acc-item">
                  <span className="acc-item__mark"><Icon aria-hidden="true" /></span>
                  <div className="acc-item__text">
                    <b>{LABEL[id] || id}</b>
                    <small>{mine ? `${mine.email || 'Linked'} · linked ${day(mine.linked_at)}` : 'Not linked. Link it to sign in without typing a password.'}</small>
                  </div>
                  <div className="acc-item__end">
                    {mine && <Tone tone="ok">Linked</Tone>}
                    {mine
                      ? <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" aria-label={`Unlink ${LABEL[id]}`} onClick={() => setUnlinking(id)}>Unlink</button>
                      : providers.some((p) => p.id === id) && <a className="mg-btn mg-btn--sm" href={`/api/auth/oauth/${id}/start?next=/account/ways-in`}>Link {LABEL[id]}</a>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Pane>

      <Pane title="Password" description={profile.password_set ? 'Set. Changing it signs out every other device, and keeps this one.' : 'Not set.'}>
        <form className="flex flex-col gap-4" onSubmit={changePassword}>
          <div className="mg-grid2">
            <label className="mg-field">
              <span className="mg-field__label">Current password</span>
              <input className="mg-input" id="account-current" type="password" autoComplete="current-password" value={passwords.current_password} onChange={(e) => setPasswords((p) => ({ ...p, current_password: e.target.value }))} />
            </label>
            <label className={`mg-field${pwError ? ' is-error' : ''}`}>
              <span className="mg-field__label">New password</span>
              <input className="mg-input" id="account-new" type="password" autoComplete="new-password" value={passwords.new_password} onChange={(e) => setPasswords((p) => ({ ...p, new_password: e.target.value }))} />
              {pwError ? <span className="mg-field__error">{pwError}</span> : <span className="mg-field__hint">12 characters or more.</span>}
            </label>
          </div>
          <div>
            <button type="submit" className="mg-btn mg-btn--primary" disabled={changing || !passwords.current_password || !passwords.new_password}>{changing ? 'Changing…' : 'Change password'}</button>
          </div>
        </form>
      </Pane>

      <p className="mg-glass set-note" data-a="rise">
        Linking matches the verified email of the provider account. A different address needs an admin to attach it under {profile.role === 'admin' ? <Link to="/settings/users">Users &amp; roles</Link> : 'Users & roles'}.
      </p>

      {unlinking && (onlyWay ? (
        <Modal title={`${LABEL[unlinking]} is your only way in`} subtitle={profile.email} size="sm" onClose={() => setUnlinking(null)} footer={<button type="button" className="mg-btn mg-btn--primary" onClick={() => setUnlinking(null)}>Close</button>}>
          <MoneyBanner tone="wait" title="Set a password first.">{' '}Unlinking now would leave no way in to this account. Ask an admin to set a password, or link the other provider, then unlink.</MoneyBanner>
        </Modal>
      ) : (
        <ConfirmDialog
          title={`Unlink ${LABEL[unlinking]}?`}
          subtitle={profile.email}
          message={`You’ll sign in ${profile.password_set ? 'with your password' : 'another way'} from now on. Your account and everything in it stay as they are, and you can link it again at any time.`}
          tone="neutral"
          confirmLabel="Unlink"
          cancelLabel="Keep it linked"
          busy={busy}
          onConfirm={() => unlink(unlinking)}
          onClose={() => setUnlinking(null)}
        />
      ))}
    </>
  );
}
