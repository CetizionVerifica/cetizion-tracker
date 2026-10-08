import { useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { cn } from 'cn';

import { SettingsPane } from '../pages/SettingsArea.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useFetch } from '../lib/hooks.js';
import { ago } from '../lib/format.js';
import { ConfirmDialog, Field, Input, Modal, useToast } from './ui.jsx';
import { initialsOf } from './record.jsx';
import { FailedCard, ListTable, LoadingPanel, Panel, PhoneRow, StateCard } from './daily.jsx';
import { DialogError, MoneyBanner } from './money.jsx';
import { MoreMenu, Tone } from './sales.jsx';
import { RowActions, undoToast } from './settings.jsx';

/**
 * Settings › People & access › Users & roles (#18), Wave 8.
 *
 * Two kinds of row land here and are drawn differently. People who sign in
 * have an email and a password. Names carried over from the workbook's
 * free-text "sales person" column have neither — they exist so the records
 * they are attached to keep making sense — and they get a dashed mark and
 * "Give them a sign-in" (email and password in one step).
 *
 * Three roles: admin, sales and hr (`users.role` CHECK). A role change and
 * stopping someone signing in now ask first; both toast with what changed.
 * Hiding this pane from a sales user is a courtesy, not the lock: every
 * route it calls is behind requireAdmin on the server.
 */

const ROLES = [
  { value: 'sales', label: 'Sales', d: 'Their own deals, companies and collections' },
  { value: 'admin', label: 'Admin', d: 'Everything, including Settings' },
  // The travel desk (#196): trips, vendor invoices, the travel import.
  { value: 'hr', label: 'HR (travel)', d: 'Only the travel desk' },
];
const ROLE = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));
const SEES = {
  admin: 'Everything, including Settings, margins, approvals and every person’s deals.',
  sales: 'Their own deals, companies, orders and collections. Settings lists read-only, and their own mailbox.',
  hr: 'Only the travel desk: trips, vendor invoices, payables, travel vendors, trip types and the travel import. No deals, clients or money in.',
};
const AFTER = {
  admin: 'They’ll see everything, including Settings, margins and every person’s deals.',
  sales: 'They’ll see their own deals, companies and collections, and Settings lists read-only.',
  hr: 'They’ll see only the travel desk: trips, vendor invoices, payables and the travel lists. Their deals, companies and collections stay assigned to them, but they won’t see them until they’re Sales again.',
};

/** Server-side field errors, shown against the field that caused them. */
const fieldErrors = (err) => err?.fields ?? {};

export function UsersAdmin() {
  const toast = useToast();
  const { mode } = useAuth();
  const { data, loading, error, refetch } = useFetch(() => api.users.list());
  // Each person's connected mailbox(es) (docs/per-user-mailboxes-plan.md §5.3).
  const mailboxes = useFetch(() => api.raw('/mailboxes'));
  const mailboxesOf = (user) => (mailboxes.data?.data ?? []).filter((m) => m.user_id === user.id);
  const [editing, setEditing] = useState(null); // user | 'new' | null
  const [giving, setGiving] = useState(null);
  const [resetting, setResetting] = useState(null);
  const [roleChange, setRoleChange] = useState(null); // { user, role }
  const [stopping, setStopping] = useState(null);
  const [busy, setBusy] = useState(null);
  const [q, setQ] = useState('');
  const [show, setShow] = useState('all');

  const users = data?.data ?? [];
  const minPassword = data?.limits?.min_password_length ?? 12;
  const shared = mode === 'shared';

  async function update(user, body, message, undo) {
    setBusy(user.id);
    try {
      await api.users.update(user.id, body);
      if (undo) undoToast(message, undo); else toast(message, 'success');
      refetch();
      return true;
    } catch (err) {
      toast(err.message, 'danger');
      return false;
    } finally {
      setBusy(null);
    }
  }

  const kind = (u) => (!u.email ? 'old' : u.active ? 'in' : 'stopped');
  const counts = { all: users.length, in: users.filter((u) => kind(u) === 'in').length, stopped: users.filter((u) => kind(u) === 'stopped').length, old: users.filter((u) => kind(u) === 'old').length };
  const ql = q.trim().toLowerCase();
  const rows = users.filter((u) => (show === 'all' || kind(u) === show) && (!ql || `${u.name} ${u.email ?? ''}`.toLowerCase().includes(ql)));

  const person = (u) => {
    const old = !u.email;
    return (
      <span className="set-person">
        <span className={cn('mg-avatar', old && 'is-ghost')}>{initialsOf(u.name)}</span>
        <span className="min-w-0">
          <b>{u.name}</b>
          <small className={old ? 'italic' : undefined}>{u.email ?? 'No sign-in: kept so old records say who sold them'}</small>
          {u.daily_mis === false && u.role !== 'hr' && !old && <small>Exempt from the personal daily MIS</small>}
          {mailboxesOf(u).map((m) => (
            <small key={m.id} className={m.status === 'active' ? 'is-ok' : m.status === 'needs_reconnect' ? 'is-late' : 'is-muted'}>
              Mailbox {m.email} · {m.status === 'active' ? 'syncing' : m.status === 'needs_reconnect' ? 'needs reconnecting' : 'disconnected'}
            </small>
          ))}
        </span>
      </span>
    );
  };
  const signsIn = (u) => (!u.email ? <Tone>No</Tone> : u.active ? <Tone tone="ok">Yes</Tone> : <Tone tone="late">Stopped</Tone>);
  const more = (u) => [
    { label: 'Set a new password', onSelect: () => setResetting(u) },
    u.role !== 'hr' && {
      label: u.daily_mis === false ? 'Include in the personal daily MIS' : 'Exempt from the personal daily MIS',
      onSelect: () => update(u, { daily_mis: u.daily_mis === false }, u.daily_mis === false ? `${u.name}’s daily MIS goes to management again` : `${u.name} is exempt from the personal daily MIS`),
    },
    u.active
      ? { label: 'Stop them signing in', onSelect: () => setStopping(u) }
      : { label: 'Let them sign in again', onSelect: () => update(u, { active: true }, `${u.name} can sign in again`) },
  ];
  const acts = (u) => (!u.email
    ? <button type="button" className="mg-btn mg-btn--sm" aria-label={`Give ${u.name} a sign-in`} onClick={() => setGiving(u)}>Give them a sign-in</button>
    : (
      <RowActions>
        <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Edit ${u.name}`} onClick={() => setEditing(u)}>Edit</button>
        <MoreMenu size="sm" label={`More actions for ${u.name}`} items={more(u)} />
      </RowActions>
    ));

  return (
    <>
      <SettingsPane
        title="Users & roles"
        description="Who can sign in and what they see. Names carried over from the workbook’s “sales person” column have no sign-in; they’re kept so old records still say who sold them."
        actions={<button type="button" className="mg-btn mg-btn--primary" onClick={() => setEditing('new')}><Plus className="size-4" aria-hidden="true" />Add a person</button>}
      >
        {shared && (
          <MoneyBanner tone="wait" title="Everyone signs in with one shared account right now.">
            {' '}People added here can sign in once the server switches to personal sign-ins (AUTH_MODE=database).
          </MoneyBanner>
        )}
        {error ? <FailedCard title="Couldn’t load the people list" text="The server didn’t answer, so nothing is shown. This isn’t “nobody here”: nothing has changed. Try again in a moment." onRetry={refetch} />
        : loading && !data ? <LoadingPanel rows={5} />
        : users.length === 0 ? (
          <StateCard
            tone="plain"
            title={shared ? 'Everyone signs in with one shared account' : 'Nobody here yet'}
            text={shared ? 'Add people here first. Once each has a sign-in, the server can switch to personal sign-ins (AUTH_MODE=database).' : 'Add the first person. They sign in with the email and password you set.'}
          >
            <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={() => setEditing('new')}>Add a person</button>
          </StateCard>
        ) : (
          <Panel
            id="set-people"
            title="People"
            hint={`${counts.in} can sign in · ${counts.stopped} stopped · ${counts.old} kept only so old records say who sold them`}
            tools={
              <div className="set-tools">
                <label className="mg-search"><Search aria-hidden="true" /><input className="mg-input" type="search" placeholder="Find a person" aria-label="Find a person" value={q} onChange={(e) => setQ(e.target.value)} /></label>
                <div className="set-chips">
                  {[['all', `Everyone · ${counts.all}`], ['in', `Can sign in · ${counts.in}`], ['stopped', `Stopped · ${counts.stopped}`], ['old', `Old records only · ${counts.old}`]].map(([k, l]) => (
                    <button key={k} type="button" className="mg-chip" aria-pressed={show === k} onClick={() => setShow(k)}>{l}</button>
                  ))}
                </div>
              </div>
            }
          >
            {rows.length === 0 ? (
              <StateCard inPanel tone="plain" title="Nobody matches" text="No one on the list fits what you typed or picked.">
                <button type="button" className="mg-btn mg-btn--sm" onClick={() => { setQ(''); setShow('all'); }}>Clear filters</button>
              </StateCard>
            ) : (
              <ListTable
                label="People who can sign in"
                rows={rows}
                columns={[
                  { key: 'person', header: 'Person', className: 'app-wrap', render: person },
                  { key: 'role', header: 'Role', width: '170px', render: (u) => (!u.email ? <span className="text-muted-foreground">—</span> : (
                    <span className="mg-select-wrap set-rolesel">
                      <select className="mg-select" aria-label={`Role for ${u.name}`} value={u.role} disabled={busy === u.id} onChange={(e) => setRoleChange({ user: u, role: e.target.value })}>
                        {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </span>
                  )) },
                  { key: 'active', header: 'Signs in', render: signsIn },
                  { key: 'seen', header: 'Last seen', render: (u) => <span className="text-secondary-text">{ago(u.last_login_at) ?? 'Never'}</span> },
                  { key: 'act', header: '', className: 'actions', render: acts },
                ]}
                phone={(u) => (
                  <PhoneRow
                    title={u.name}
                    meta={`${!u.email ? 'No sign-in · kept for old records' : `${ROLE[u.role] || u.role} · ${u.email}`} · seen ${ago(u.last_login_at) ?? 'never'}`}
                    state={!u.email ? <Tone>No sign-in</Tone> : u.active ? <Tone tone="ok">Signs in</Tone> : <Tone tone="late">Stopped</Tone>}
                    wraps
                  >
                    <span className="set-rowacts">
                      {!u.email
                        ? <button type="button" className="mg-btn mg-btn--sm" onClick={() => setGiving(u)}>Give them a sign-in</button>
                        : <>
                          <button type="button" className="mg-btn mg-btn--sm" aria-label={`Edit ${u.name}`} onClick={() => setEditing(u)}>Edit</button>
                          <MoreMenu label={`More actions for ${u.name}`} items={more(u)} />
                        </>}
                    </span>
                  </PhoneRow>
                )}
              />
            )}
          </Panel>
        )}

        <section className="mg-glass mg-panel" data-a="rise" aria-labelledby="set-roles">
          <div className="flex flex-col gap-0.5"><h2 className="mg-panel__title" id="set-roles">What each role sees</h2><span className="mg-panel__hint">Pick the narrowest one that lets them do the job.</span></div>
          <div className="set-roles">
            {['admin', 'sales', 'hr'].map((r) => (
              <div key={r} className="set-role"><span className="mg-badge mg-badge--plain self-start">{ROLE[r]}</span>{SEES[r]}</div>
            ))}
          </div>
          <p className="m-0 text-[12.5px] text-secondary-text">
            Passwords are {minPassword} characters or more. Stopping someone signing in ends their session on their next click and disconnects their mailbox. Nobody is deleted, so the records they’re attached to keep making sense.
          </p>
        </section>
      </SettingsPane>

      {editing && (
        <UserForm
          user={editing === 'new' ? null : editing}
          minPassword={minPassword}
          onClose={() => setEditing(null)}
          onSaved={(message) => { setEditing(null); toast(message, 'success'); refetch(); }}
        />
      )}
      {giving && (
        <UserForm
          user={giving}
          give
          minPassword={minPassword}
          onClose={() => setGiving(null)}
          onSaved={(message) => { setGiving(null); toast(message, 'success'); refetch(); }}
        />
      )}
      {resetting && (
        <PasswordForm
          user={resetting}
          minPassword={minPassword}
          onClose={() => setResetting(null)}
          onSaved={(message) => { setResetting(null); toast(message, 'success'); refetch(); }}
        />
      )}
      {roleChange && (
        <ConfirmDialog
          title={`Make ${roleChange.user.name} ${ROLE[roleChange.role]}?`}
          subtitle={`${ROLE[roleChange.user.role]} → ${ROLE[roleChange.role]}`}
          message={AFTER[roleChange.role]}
          tone="neutral"
          confirmLabel="Change role"
          cancelLabel={`Keep ${ROLE[roleChange.user.role]}`}
          busy={busy === roleChange.user.id}
          onClose={() => setRoleChange(null)}
          onConfirm={async () => {
            const { user, role } = roleChange;
            const ok = await update(user, { role }, `${user.name} is now ${ROLE[role]}.${role === 'hr' ? ' They see only the travel desk.' : ''}`, () => update(user, { role: user.role }, `${user.name} is ${ROLE[user.role]} again`));
            if (ok) setRoleChange(null);
          }}
        />
      )}
      {stopping && (
        <ConfirmDialog
          title={`Stop ${stopping.name} signing in?`}
          subtitle={`${stopping.email} · ${ROLE[stopping.role] || stopping.role}`}
          message="Their session ends on their next click and their mailbox is disconnected. Nothing they did is deleted, and you can let them sign in again at any time."
          tone="neutral"
          confirmLabel="Stop signing in"
          busy={busy === stopping.id}
          onClose={() => setStopping(null)}
          onConfirm={async () => { if (await update(stopping, { active: false }, `${stopping.name} can no longer sign in`)) setStopping(null); }}
        />
      )}
    </>
  );
}

/** Role radios with what each role sees. */
function RoleRadios({ value, onChange, disabled }) {
  return (
    <div className="set-radios" role="radiogroup" aria-label="Role">
      {ROLES.map((r) => (
        <label key={r.value} className="set-radio">
          <input type="radio" name="user-role" value={r.value} checked={value === r.value} onChange={() => onChange(r.value)} disabled={disabled} />
          <span><b>{r.label}</b><small>{r.d}</small></span>
        </label>
      ))}
    </div>
  );
}

/**
 * Add a person, edit one, or give an old-records name a sign-in. The last
 * sets the email and role, then the password, with the two existing calls.
 */
function UserForm({ user, give = false, minPassword, onClose, onSaved }) {
  const isNew = !user;
  const [form, setForm] = useState({ name: user?.name ?? '', email: user?.email ?? '', role: user?.role || 'sales', password: '' });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));
  const withPassword = isNew || give;

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrors({});
    setFailure(null);
    try {
      if (isNew) {
        await api.users.create({ name: form.name, email: form.email, role: form.role, password: form.password });
        onSaved(`${form.name} can now sign in`);
      } else {
        // Only what changed, so an untouched field is never rewritten.
        const changes = {};
        if (form.name !== user.name) changes.name = form.name;
        if (form.email !== (user.email ?? '')) changes.email = form.email;
        if (form.role !== user.role) changes.role = form.role;
        if (Object.keys(changes).length) await api.users.update(user.id, changes);
        if (give && form.password) await api.users.setPassword(user.id, form.password);
        if (!Object.keys(changes).length && !(give && form.password)) return onClose();
        onSaved(give ? `${form.name} can now sign in` : `${form.name} updated`);
      }
    } catch (err) {
      setErrors(fieldErrors(err));
      setFailure(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={isNew ? 'Add a person' : give ? `Give ${user.name} a sign-in` : `Edit ${user.name}`}
      subtitle={isNew ? 'They sign in with this email and password. Nothing is emailed to them.'
        : give ? 'Kept so old records say who sold them. With an email and a password they can sign in.'
        : 'Changing these never changes their password; use Set a new password for that.'}
      onClose={onClose}
      size={withPassword ? '' : 'sm'}
      footer={
        <>
          <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="user-form" className="mg-btn mg-btn--primary" disabled={busy}>
            {busy ? 'Saving…' : isNew ? 'Add person' : give ? 'Give sign-in' : 'Save changes'}
          </button>
        </>
      }
    >
      <form id="user-form" className="form-grid" onSubmit={submit}>
        {failure && !Object.keys(errors).length && <div className="span-all"><DialogError error={failure} what={isNew ? 'the person' : 'the changes'} /></div>}
        <Field label="Name" required error={errors.name}>
          <Input value={form.name} onChange={set('name')} error={errors.name} autoFocus required disabled={busy} />
        </Field>
        <Field label="Email" required={withPassword} error={errors.email}>
          <Input type="email" autoComplete="off" value={form.email} onChange={set('email')} error={errors.email} required={withPassword} disabled={busy} />
        </Field>
        <div className="span-all">
          <Field as="div" label="Role" required error={errors.role} hint={withPassword ? undefined : 'HR (travel) sees only the travel desk.'}>
            <RoleRadios value={form.role} onChange={(role) => setForm((p) => ({ ...p, role }))} disabled={busy} />
          </Field>
        </div>
        {withPassword && (
          <div className="span-all">
            <Field label="Password" required error={errors.password} hint={`At least ${minPassword} characters. Tell them out of band; they can change it under My account.`}>
              <Input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} error={errors.password} required minLength={minPassword} disabled={busy} />
            </Field>
          </div>
        )}
      </form>
    </Modal>
  );
}

/** Set somebody's password, on its own, on purpose. */
function PasswordForm({ user, minPassword, onClose, onSaved }) {
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrors({});
    setFailure(null);
    try {
      await api.users.setPassword(user.id, password);
      onSaved(`${user.name} has a new password`);
    } catch (err) {
      setErrors(fieldErrors(err));
      setFailure(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`New password for ${user.name}`}
      subtitle="Tell them out of band. It isn’t shown again, and it doesn’t end any session they already have."
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="password-form" className="mg-btn mg-btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Set password'}</button>
        </>
      }
    >
      <form id="password-form" className="flex flex-col gap-3.5" onSubmit={submit}>
        {failure && !Object.keys(errors).length && <DialogError error={failure} what="the password" />}
        {!user.active && (
          <MoneyBanner tone="wait" title={`${user.name} is stopped from signing in.`}>{' '}A new password doesn’t let them in. Choose Let them sign in again when you mean to.</MoneyBanner>
        )}
        <Field label="Password" required error={errors.password} hint={`At least ${minPassword} characters.`}>
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} autoFocus required disabled={busy} />
        </Field>
      </form>
    </Modal>
  );
}
