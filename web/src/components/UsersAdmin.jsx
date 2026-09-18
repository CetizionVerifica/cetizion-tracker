import { useState } from 'react';

import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date } from '../lib/format.js';
import { Badge, Card, DataTable, Empty, ErrorState, Field, Input, Modal, Select, useToast } from './ui.jsx';

/**
 * Who may sign in (#18).
 *
 * Deliberately built out of the same pieces as every other screen — Card,
 * DataTable, Modal, Field — because Issue #17 replaces this front end
 * wholesale and anything clever here would only be thrown away twice.
 *
 * Two kinds of row show up in this table. People who sign in have an email
 * and a password; names carried over from the old free-text "sales person"
 * column have neither, and are shown as what they are rather than dressed
 * up as accounts nobody can use.
 *
 * Hiding this tab from a sales user is a courtesy, not the lock: every
 * route it calls is behind requireAdmin on the server.
 */

const ROLES = [
  { value: 'admin', label: 'Admin' },
  { value: 'sales', label: 'Sales' },
];

/** Server-side field errors, shown against the field that caused them. */
const fieldErrors = (err) => err?.fields ?? {};

export function UsersAdmin() {
  const toast = useToast();
  const { data, loading, error, refetch } = useFetch(() => api.users.list());
  const [editing, setEditing] = useState(null); // user | 'new' | null
  const [resetting, setResetting] = useState(null);

  const users = data?.data ?? [];
  const minPassword = data?.limits?.min_password_length ?? 12;

  async function toggleActive(user) {
    try {
      await api.users.update(user.id, { active: !user.active });
      toast(user.active ? `${user.name} can no longer sign in` : `${user.name} can sign in again`, 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  const columns = [
    {
      key: 'name',
      header: 'Name',
      className: 'strong',
      render: (u) => (
        <>
          {u.name}
          <div className="small muted">
            {u.email ?? <em>no email — kept for attribution only</em>}
          </div>
        </>
      ),
    },
    { key: 'role', header: 'Role', render: (u) => <Badge tone={u.role === 'admin' ? 'info' : 'neutral'}>{u.role}</Badge> },
    {
      key: 'active',
      header: 'Signs in',
      render: (u) => <Badge tone={u.active ? 'success' : 'neutral'}>{u.active ? 'Yes' : 'No'}</Badge>,
    },
    {
      key: 'last_login_at',
      header: 'Last signed in',
      render: (u) => (u.last_login_at ? date(u.last_login_at) : <span className="muted">Never</span>),
    },
    {
      key: 'act',
      header: '',
      align: 'right',
      render: (u) => (
        <div className="table__actions">
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(u)}>Edit</button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setResetting(u)}>Password</button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => toggleActive(u)}>
            {u.active ? 'Deactivate' : 'Activate'}
          </button>
        </div>
      ),
    },
  ];

  return (
    <>
      <Card
        flush
        title="Users"
        hint="Who may sign in, and what they may do. Deactivating somebody ends their session on their next request — there is no deleting, so the records they are attached to keep making sense."
        actions={
          <button type="button" className="btn btn--sm btn--primary" onClick={() => setEditing('new')}>+ User</button>
        }
      >
        {error ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : (
          <DataTable
            loading={loading}
            columns={columns}
            rows={users}
            empty={<Empty title="No users yet" text="Add the first one, then switch AUTH_MODE to database." />}
          />
        )}
      </Card>

      {editing && (
        <UserForm
          user={editing === 'new' ? null : editing}
          minPassword={minPassword}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            toast(message, 'success');
            refetch();
          }}
        />
      )}

      {resetting && (
        <PasswordForm
          user={resetting}
          minPassword={minPassword}
          onClose={() => setResetting(null)}
          onSaved={(message) => {
            setResetting(null);
            toast(message, 'success');
            refetch();
          }}
        />
      )}
    </>
  );
}

/** Create a user, or change a name, email and role. Never a password. */
function UserForm({ user, minPassword, onClose, onSaved }) {
  const isNew = !user;
  const [form, setForm] = useState({
    name: user?.name ?? '',
    email: user?.email ?? '',
    role: user?.role ?? 'sales',
    password: '',
  });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrors({});
    setFailure(null);

    try {
      if (isNew) {
        await api.users.create({
          name: form.name, email: form.email, role: form.role, password: form.password,
        });
        onSaved(`${form.name} can now sign in`);
      } else {
        // Only what changed, so an untouched field is never rewritten.
        const changes = {};
        if (form.name !== user.name) changes.name = form.name;
        if (form.email !== (user.email ?? '')) changes.email = form.email;
        if (form.role !== user.role) changes.role = form.role;
        if (Object.keys(changes).length === 0) return onClose();
        await api.users.update(user.id, changes);
        onSaved(`${form.name} updated`);
      }
    } catch (err) {
      setErrors(fieldErrors(err));
      setFailure(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={isNew ? 'New user' : `Edit ${user.name}`}
      subtitle={isNew ? undefined : 'Changing these never changes their password — use Password for that.'}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="user-form" className="btn btn--primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="user-form" className="form-grid" onSubmit={submit}>
        {failure && !Object.keys(errors).length && <div className="field__error">{failure}</div>}

        <Field label="Name" required error={errors.name}>
          <Input value={form.name} onChange={set('name')} error={errors.name} autoFocus required disabled={busy} />
        </Field>

        <Field
          label="Email"
          required={isNew}
          error={errors.email}
          hint={!isNew && !user.email ? 'This name is kept for attribution and has no account yet.' : undefined}
        >
          <Input type="email" autoComplete="off" value={form.email} onChange={set('email')} error={errors.email} disabled={busy} />
        </Field>

        <Field label="Role" required error={errors.role}>
          <Select value={form.role} onChange={set('role')} options={ROLES} placeholder={null} error={errors.role} disabled={busy} />
        </Field>

        {isNew && (
          <Field label="Password" required error={errors.password} hint={`At least ${minPassword} characters.`}>
            <Input
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={set('password')}
              error={errors.password}
              required
              disabled={busy}
            />
          </Field>
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
      subtitle="Tell them out of band. It is not shown again, and it does not end any session they already have."
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="password-form" className="btn btn--primary" disabled={busy}>
            {busy ? 'Saving…' : 'Set password'}
          </button>
        </>
      }
    >
      <form id="password-form" className="form-grid" onSubmit={submit}>
        {failure && !Object.keys(errors).length && <div className="field__error">{failure}</div>}

        {!user.active && (
          <p className="small muted" style={{ gridColumn: '1 / -1' }}>
            {user.name} is deactivated. Giving them a password does not let them in —
            activate the account when you mean to.
          </p>
        )}

        <Field label="Password" required error={errors.password} hint={`At least ${minPassword} characters.`}>
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors.password}
            autoFocus
            required
            disabled={busy}
          />
        </Field>
      </form>
    </Modal>
  );
}
