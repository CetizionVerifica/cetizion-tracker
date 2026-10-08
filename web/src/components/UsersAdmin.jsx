import { useState } from 'react';
import { Check, MoreHorizontal } from 'lucide-react';
import { cn } from 'cn';

import { SettingsPane } from '../pages/SettingsArea.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { ago } from '../lib/format.js';
import { ErrorState, Field, Input, Modal, Select as LegacySelect, useToast } from './ui.jsx';
import { initialsOf } from './record.jsx';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

/**
 * Who may sign in (#18), on C11's shape.
 *
 * Two kinds of row land in this table and the design is careful to draw
 * them differently. People who sign in have an email and a password.
 * Names carried over from the workbook's free-text "sales person" column
 * have neither — they exist so the records they are attached to keep
 * making sense — and they get a dashed mark and an invitation rather than
 * being dressed up as accounts nobody can use.
 *
 * **Three roles, not four.** C11 proposes Admin, Sales, Finance and
 * Delivery, and says so itself: "the code has two roles". HR joined them
 * for the travel desk (#196, 084), with its own gate on the server
 * (lib/authz/policy.js, HR_ROUTES). `users.role` carries
 * `CHECK (role IN ('admin','sales','hr'))`
 * and `requireRole` exists but is mounted nowhere except as
 * `requireAdmin`, so a Finance option would be a control implying a
 * permission model that neither the database nor the routes have. The
 * four sidebar preview cards C11 draws beside this table are part of that
 * same proposal and are left undrawn for the same reason.
 *
 * Hiding this pane from a sales user is a courtesy, not the lock: every
 * route it calls is behind requireAdmin on the server.
 */

const ROLES = [
  { value: 'admin', label: 'Admin' },
  { value: 'sales', label: 'Sales' },
  // The travel desk (#196): trips, vendor invoices, the travel import.
  { value: 'hr', label: 'HR (travel)' },
];

const GRID = '@3xl:grid-cols-[minmax(0,1.5fr)_140px_100px_130px_88px]';
const COL_LABEL = 'eyebrow';

/** Server-side field errors, shown against the field that caused them. */
const fieldErrors = (err) => err?.fields ?? {};

export function UsersAdmin() {
  const toast = useToast();
  const { data, loading, error, refetch } = useFetch(() => api.users.list());
  // Each person's connected mailbox(es), so "whose mail is this" can be
  // answered from the roster (docs/per-user-mailboxes-plan.md §5.3). Admins
  // list every mailbox; the owner column on each is a users row.
  const mailboxes = useFetch(() => api.raw('/mailboxes'));
  const mailboxesOf = (user) => (mailboxes.data?.data ?? []).filter((m) => m.user_id === user.id);
  const [editing, setEditing] = useState(null); // user | 'new' | null
  const [resetting, setResetting] = useState(null);
  const [busy, setBusy] = useState(null);

  const users = data?.data ?? [];
  const minPassword = data?.limits?.min_password_length ?? 12;

  async function update(user, body, message) {
    setBusy(user.id);
    try {
      await api.users.update(user.id, body);
      toast(message, 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(null);
    }
  }

  const toggleActive = (user) => update(
    user,
    { active: !user.active },
    user.active ? `${user.name} can no longer sign in` : `${user.name} can sign in again`
  );

  return (
    <>
      <SettingsPane
        title="Users & roles"
        description="Who can sign in and what they see. Names carried over from the workbook’s “sales person” column have no login and are kept for attribution only."
        actions={<Button size="sm" className="h-8 px-4 text-[13px]" onClick={() => setEditing('new')}>Invite someone</Button>}
      >

        {error ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className={cn('hidden h-9 items-center gap-4 bg-secondary px-5 @3xl:grid', GRID, COL_LABEL)}>
              <span>Person</span><span>Role</span><span>Signs in</span><span>Last seen</span><span />
            </div>

            {loading && !users.length ? (
              <div className="skeleton" style={{ height: 120, margin: 18 }} />
            ) : users.length === 0 ? (
              <p className="px-5 py-6 text-[13px]/[1.7] text-secondary-text">
                Nobody yet. Add the first one, then switch AUTH_MODE to database.
              </p>
            ) : users.map((user, i) => {
              const attributionOnly = !user.email;
              return (
                <div
                  key={user.id}
                  className={cn('grid gap-3 px-5 py-3 @3xl:items-center @3xl:gap-4', GRID, i < users.length - 1 && 'border-b border-border')}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className={cn(
                      'grid size-7 flex-none place-items-center rounded-full text-[10.5px] font-semibold',
                      attributionOnly ? 'border border-dashed border-border-strong bg-secondary text-muted-foreground' : 'bg-accent text-primary'
                    )}>
                      {initialsOf(user.name)}
                    </span>
                    <div className="min-w-0">
                      <div className={cn('truncate text-[13px] font-medium', attributionOnly ? 'text-secondary-text' : 'text-foreground')}>
                        {user.name}
                      </div>
                      <div className="text-[12px] break-words text-muted-foreground">
                        {user.email ?? <em>no email — attribution only, from the workbook</em>}
                      </div>
                      {user.daily_mis === false && user.role !== 'hr' && (
                        <div className="text-[12px] text-muted-foreground">Exempt from the personal daily MIS</div>
                      )}
                      {mailboxesOf(user).map((m) => (
                        <div key={m.id} className="text-[12px] break-words text-muted-foreground">
                          Mailbox {m.email}
                          {m.status === 'active' ? <span className="text-settled"> · syncing</span>
                            : m.status === 'needs_reconnect' ? <span className="text-late"> · needs reconnecting</span>
                            : <span> · disconnected</span>}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    {attributionOnly ? (
                      <span className="text-[12.5px] text-muted-foreground">—</span>
                    ) : (
                      <Select
                        value={user.role}
                        disabled={busy === user.id}
                        onValueChange={(role) => update(user, { role }, `${user.name} is now ${role}`)}
                      >
                        <SelectTrigger size="sm" className="h-7 w-full text-[12.5px]" aria-label={`Role for ${user.name}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLES.map((r) => <SelectItem key={r.value} value={r.value} className="text-[12.5px]">{r.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )}
                  </div>

                  <div className="text-[12.5px]">
                    {user.active ? (
                      <span className="inline-flex items-center gap-1.5 font-medium text-settled">
                        <Check className="size-3" strokeWidth={2.6} aria-hidden="true" />Yes
                      </span>
                    ) : (
                      <span className="text-muted-foreground">No</span>
                    )}
                  </div>

                  <div className="text-[12.5px] text-secondary-text">
                    {ago(user.last_login_at) ?? <span className="text-muted-foreground">never</span>}
                  </div>

                  <div className="flex items-center gap-1 @3xl:justify-end">
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-[12.5px]" onClick={() => setEditing(user)}>
                      {attributionOnly ? 'Invite' : 'Edit'}
                    </Button>
                    {!attributionOnly && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" className="size-7" aria-label={`More actions for ${user.name}`}>
                            <MoreHorizontal strokeWidth={2.4} aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem className="text-[13px]" onSelect={() => setResetting(user)}>Set a new password</DropdownMenuItem>
                          {user.role !== 'hr' && (
                            <DropdownMenuItem
                              className="text-[13px]"
                              onSelect={() => update(
                                user,
                                { daily_mis: user.daily_mis === false },
                                user.daily_mis === false ? `${user.name}'s daily MIS goes to management again` : `${user.name} is exempt from the personal daily MIS`
                              )}
                            >
                              {user.daily_mis === false ? 'Include in the personal daily MIS' : 'Exempt from the personal daily MIS'}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem className="text-[13px]" onSelect={() => toggleActive(user)}>
                            {user.active ? 'Stop them signing in' : 'Let them sign in again'}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="max-w-[70ch] text-[12px]/[1.6] text-muted-foreground">
          Hiding a screen from a role is a courtesy; every route stays behind <code className="mono">requireAdmin</code> on
          the server. Passwords are {minPassword}+ characters. Deactivating somebody ends their session on their next
          request and disconnects their mailbox — there is no deleting, so the records they are attached to keep making sense.
        </p>
      </SettingsPane>

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
          <LegacySelect value={form.role} onChange={set('role')} options={ROLES} placeholder={null} error={errors.role} disabled={busy} />
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
