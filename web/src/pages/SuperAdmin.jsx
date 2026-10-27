import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, MoreHorizontal, Search, ShieldCheck, UserPlus } from 'lucide-react';
import { cn } from 'cn';

import { ago, fileSize, localDate } from '../lib/format.js';
import { initialsOf } from '../components/record.jsx';
import {
  Badge, Empty, ErrorState, Field, Input, Modal, Select, Tabs, useToast,
} from '../components/ui.jsx';
import { Alert, AlertDescription } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardContent } from '../components/ui/card.tsx';
import { Checkbox } from '../components/ui/checkbox.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../components/ui/dropdown-menu.tsx';
import { Label } from '../components/ui/label.tsx';

/**
 * The super admin portal (/super-admin): user management, outside the staff
 * app, with its own sign-in and its own cookie (server/src/auth/superAdmin.js).
 *
 * Its own small client rather than lib/api.js, as the client portal has: a
 * 401 here means "sign in to this portal", and must not drop the staff app
 * to its sign-in page, nor the other way round.
 */
const BASE = '/api/super-admin';

async function call(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const e = new Error('Cannot reach the server — is the API running?');
    throw e;
  }
  if (response.status === 204) return null;
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const e = new Error(json.error?.message || `Request failed (${response.status})`);
    e.status = response.status;
    e.fields = json.error?.fields ?? null;
    throw e;
  }
  return json;
}

const ROLES = [
  { value: 'admin', label: 'Admin' },
  { value: 'sales', label: 'Sales' },
  { value: 'hr', label: 'HR (travel)' },
];
const roleLabel = (role) => ROLES.find((r) => r.value === role)?.label ?? role;

export default function SuperAdmin() {
  // undefined while asking, null when signed out.
  const [me, setMe] = useState(undefined);
  const [disabled, setDisabled] = useState(false);

  useEffect(() => {
    document.title = 'Super admin · Sales Tracker';
    call('/me')
      .then((res) => setMe(res.data))
      .catch((e) => { if (e.status === 404) setDisabled(true); setMe(null); });
  }, []);

  const signOut = async () => {
    await call('/logout', { method: 'POST' }).catch(() => {});
    setMe(null);
  };

  if (me === undefined) return <div className="grid min-h-dvh place-items-center bg-background"><div className="skeleton h-40 w-full max-w-[480px]" /></div>;
  if (disabled) return <NotSetUp />;
  if (!me) return <SignIn onSignedIn={setMe} />;
  return <Portal me={me} onSignOut={signOut} onExpired={() => setMe(null)} />;
}

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary">
        <ShieldCheck className="size-[18px] text-primary-foreground" strokeWidth={2.4} aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="font-display text-[16px] font-bold tracking-[-0.01em] text-foreground">Sales Tracker</div>
        <div className="text-[12px] text-muted-foreground">Super admin</div>
      </div>
    </div>
  );
}

function NotSetUp() {
  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4 py-10">
      <Card className="w-full max-w-[480px] rounded-xl py-0">
        <CardContent className="flex flex-col gap-4 px-6 py-10 sm:px-10">
          <Brand />
          <h1 className="font-display text-2xl font-bold text-foreground">Not set up</h1>
          <p className="text-[13px]/[1.6] text-secondary-text">
            The super admin portal is switched off. Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD
            in the server’s environment and restart it.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function SignIn({ onSignedIn }) {
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await call('/login', { method: 'POST', body: form });
      onSignedIn(res.data);
    } catch (err) {
      setError(err.fields ? Object.values(err.fields)[0] : err.message);
      setForm((prev) => ({ ...prev, password: '' }));
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4 py-10">
      <Card className="w-full max-w-[480px] gap-0 rounded-xl py-0">
        <CardContent className="flex flex-col justify-center gap-7 px-6 py-10 sm:px-10 sm:py-12">
          <Brand />
          <div>
            <h1 className="font-display text-2xl/[1.25] font-bold text-foreground">Super admin sign in</h1>
            <p className="mt-1.5 text-[13px]/[1.6] text-secondary-text">
              For managing who can use the tracker. Sessions last 8 hours.
            </p>
          </div>

          <form className="flex flex-col gap-4" onSubmit={submit}>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div>
              <Label htmlFor="sa-email" className="mb-2 text-[12.5px] font-medium text-secondary-text">Email</Label>
              <Input id="sa-email" type="email" autoComplete="username" autoFocus required value={form.email}
                onChange={set('email')} disabled={busy} className="h-10 text-[13.5px]" />
            </div>
            <div>
              <Label htmlFor="sa-password" className="mb-2 text-[12.5px] font-medium text-secondary-text">Password</Label>
              <div className="relative">
                <Input id="sa-password" type={show ? 'text' : 'password'} autoComplete="current-password" required
                  value={form.password} onChange={set('password')} disabled={busy} className="h-10 pr-16 text-[13.5px]" />
                <button type="button" onClick={() => setShow((s) => !s)} aria-pressed={show}
                  aria-label={show ? 'Hide what I typed' : 'Show what I typed'}
                  className="absolute inset-y-0 right-0 rounded-r-md px-3 text-[12px] font-medium text-muted-foreground hover:text-foreground">
                  {show ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
            <Button type="submit" className="h-10 w-full text-[14px] font-semibold" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <p className="text-[11.5px]/[1.6] text-muted-foreground">
            Ten wrong attempts in fifteen minutes pause sign-in here for a while.
            Staff sign in on the <a className="text-primary hover:underline" href="/">main page</a>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ----------------------------------------------------------------- portal

function Portal({ me, onSignOut, onExpired }) {
  const toast = useToast();
  const [state, setState] = useState({ loading: true, error: null, users: [], minPassword: 12 });
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [editing, setEditing] = useState(null); // user | 'new' | null
  const [resetting, setResetting] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(null);
  const [tab, setTab] = useState('users');

  // Every call goes through here, so an expired session returns to sign-in.
  const run = useCallback(async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 401) onExpired();
      throw err;
    }
  }, [onExpired]);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await run(() => call('/users'));
      setState({ loading: false, error: null, users: res.data, minPassword: res.limits?.min_password_length ?? 12 });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err.message }));
    }
  }, [run]);

  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return state.users.filter((u) => !u.deleted_at &&
      (!q || u.name.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q)) &&
      (!roleFilter || u.role === roleFilter) &&
      (!statusFilter || (statusFilter === 'active' ? u.active : !u.active)));
  }, [state.users, search, roleFilter, statusFilter]);

  async function update(user, body, message) {
    setBusy(user.id);
    try {
      await run(() => call(`/users/${user.id}`, { method: 'PATCH', body }));
      toast(message, 'success');
      await load();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(null);
    }
  }

  // Deleted (archived) accounts are still listed by the API, because reports
  // name them; here they live under their own tab.
  const current = useMemo(() => state.users.filter((u) => !u.deleted_at), [state.users]);
  const deletedCount = state.users.length - current.length;

  const counts = {
    total: current.length,
    active: current.filter((u) => u.active).length,
    admins: current.filter((u) => u.active && u.role === 'admin').length,
  };

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Brand />
          <div className="flex items-center gap-3">
            <span className="hidden text-[13px] text-secondary-text sm:inline">{me.email}</span>
            <Button variant="outline" size="sm" onClick={onSignOut}>Sign out</Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold text-foreground">{tab === 'users' ? 'Users' : 'Deleted users'}</h1>
            <p className="mt-1 text-[13px] text-secondary-text">
              {tab === 'users'
                ? 'Everyone who can sign in to the tracker, and what their role lets them see.'
                : 'Accounts that were deleted, with the Excel backup made before each one.'}
            </p>
          </div>
          {tab === 'users' && (
            <Button onClick={() => setEditing('new')}>
              <UserPlus className="size-4" aria-hidden="true" />Add user
            </Button>
          )}
        </div>

        <Tabs
          tabs={[{ key: 'users', label: 'Users', count: counts.total }, { key: 'deleted', label: 'Deleted users', count: deletedCount }]}
          active={tab}
          onChange={setTab}
        />

        {tab === 'deleted' ? <DeletedUsers run={run} /> : <>


        <div className="grid grid-cols-3 gap-3">
          {[['Users', counts.total], ['Can sign in', counts.active], ['Active admins', counts.admins]].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-card px-4 py-3">
              <div className="eyebrow">{label}</div>
              <div className="num mt-1 text-2xl font-semibold text-foreground">{state.loading && !state.users.length ? '—' : value}</div>
            </div>
          ))}
        </div>

        {!state.loading && !state.error && current.length > 0 && counts.admins === 0 && (
          <Alert variant="destructive">
            <AlertDescription>
              There is no active Admin. The tracker always keeps at least one, so add an Admin user
              (or make an existing user an Admin) before any other change will save.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input aria-label="Search by name or email" placeholder="Search by name or email" value={search}
              onChange={(e) => setSearch(e.target.value)} className="pl-8" />
          </div>
          <Select aria-label="Role" className="w-40" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
            options={ROLES} placeholder="All roles" />
          <Select aria-label="Status" className="w-40" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            options={[{ value: 'active', label: 'Can sign in' }, { value: 'inactive', label: 'Switched off' }]} placeholder="Any status" />
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {state.error ? (
            <ErrorState message={state.error} onRetry={load} />
          ) : state.loading && !state.users.length ? (
            <div className="skeleton m-4 h-[160px]" />
          ) : current.length === 0 ? (
            <Empty title="No users yet" text="Add the first one, and make them an Admin: the tracker always keeps at least one active admin."
              action={<Button size="sm" onClick={() => setEditing('new')}>Add user</Button>} />
          ) : shown.length === 0 ? (
            <Empty title="Nobody matches" text="Try another name, or clear the filters." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-secondary text-left">
                    {['Person', 'Role', 'Status', 'Phone', 'Last sign-in', ''].map((h) => (
                      <th key={h} scope="col" className="h-row px-4 text-[12px] font-semibold text-muted-foreground">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((user) => (
                    <tr key={user.id} className="border-b border-border last:border-b-0">
                      <td className="px-4 py-2.5">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className={cn('grid size-7 flex-none place-items-center rounded-full text-[10.5px] font-semibold',
                            user.email ? 'bg-accent text-primary' : 'border border-dashed border-border-strong bg-secondary text-muted-foreground')}>
                            {initialsOf(user.name)}
                          </span>
                          <div className="min-w-0">
                            <div className="truncate font-medium text-foreground">{user.name}</div>
                            <div className="text-[12px] break-words text-muted-foreground">
                              {user.email ?? <em>no email (name kept for old records)</em>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-secondary-text">{roleLabel(user.role)}</td>
                      <td className="px-4 py-2.5">
                        {user.active ? <Badge tone="success" dot>Can sign in</Badge> : <Badge tone="neutral">Switched off</Badge>}
                      </td>
                      <td className="px-4 py-2.5 text-secondary-text">{user.phone || <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-4 py-2.5 text-secondary-text">{ago(user.last_login_at) ?? <span className="text-muted-foreground">never</span>}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-[12.5px]" onClick={() => setEditing(user)}>Edit</Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm" className="size-7" aria-label={`More actions for ${user.name}`} disabled={busy === user.id}>
                                <MoreHorizontal strokeWidth={2.4} aria-hidden="true" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem className="text-[13px]" onSelect={() => setResetting(user)}>Set a new password</DropdownMenuItem>
                              {user.email && (
                                <DropdownMenuItem className="text-[13px]" onSelect={() => update(user, { active: !user.active },
                                  user.active ? `${user.name} can no longer sign in` : `${user.name} can sign in again`)}>
                                  {user.active ? 'Switch off (stop sign-in)' : 'Switch on (allow sign-in)'}
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-[13px] text-late" onSelect={() => setDeleting(user)}>Delete user</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="max-w-[75ch] text-[12px]/[1.6] text-muted-foreground">
          Switching someone off stops them signing in and keeps everything they did; you can switch them back
          on. Deleting makes an Excel backup first, moves their open work to someone else, and keeps their old
          records and past targets under their name; it cannot be undone. Passwords are at least {state.minPassword} characters.
        </p>
        </>}
      </main>

      {editing && (
        <UserForm
          user={editing === 'new' ? null : editing}
          minPassword={state.minPassword}
          run={run}
          onClose={() => setEditing(null)}
          onSaved={(message) => { setEditing(null); toast(message, 'success'); load(); }}
        />
      )}
      {resetting && (
        <PasswordForm
          user={resetting}
          minPassword={state.minPassword}
          run={run}
          onClose={() => setResetting(null)}
          onSaved={(message) => { setResetting(null); toast(message, 'success'); }}
        />
      )}
      {deleting && (
        <DeleteDialog
          user={deleting}
          run={run}
          onClose={() => setDeleting(null)}
          onDeleted={(message) => { setDeleting(null); toast(message, 'success'); load(); setTab('deleted'); }}
        />
      )}
    </div>
  );
}

function UserForm({ user, minPassword, run, onClose, onSaved }) {
  const isNew = !user;
  const [form, setForm] = useState({
    name: user?.name ?? '',
    email: user?.email ?? '',
    role: user?.role ?? 'sales',
    password: '',
    phone: user?.phone ?? '',
    time_zone: user?.time_zone ?? '',
    active: user?.active ?? true,
    daily_mis: user?.daily_mis ?? true,
  });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));
  const tick = (key) => (checked) => setForm((prev) => ({ ...prev, [key]: checked === true }));

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrors({});
    setFailure(null);
    try {
      if (isNew) {
        await run(() => call('/users', { method: 'POST', body: form }));
        onSaved(`${form.name} added`);
      } else {
        // Only what changed, so an untouched field is never rewritten.
        const changes = {};
        for (const key of ['name', 'email', 'role', 'phone', 'time_zone', 'active', 'daily_mis']) {
          const before = user[key] ?? (typeof form[key] === 'string' ? '' : user[key]);
          if (form[key] !== before) changes[key] = form[key];
        }
        if (Object.keys(changes).length === 0) return onClose();
        await run(() => call(`/users/${user.id}`, { method: 'PATCH', body: changes }));
        onSaved(`${form.name} updated`);
      }
    } catch (err) {
      setErrors(err.fields ?? {});
      setFailure(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={isNew ? 'Add user' : `Edit ${user.name}`}
      subtitle={isNew ? 'They sign in to the main tracker with this email and password.' : 'Their password is changed separately, with “Set a new password”.'}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="sa-user-form" size="sm" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Add user' : 'Save'}</Button>
        </>
      }
    >
      <form id="sa-user-form" className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
        {failure && !Object.keys(errors).length && <div className="text-[13px] text-late sm:col-span-2">{failure}</div>}

        <Field label="Name" required error={errors.name}>
          <Input value={form.name} onChange={set('name')} error={errors.name} autoFocus required disabled={busy} />
        </Field>
        <Field label="Email" required error={errors.email}>
          <Input type="email" autoComplete="off" value={form.email} onChange={set('email')} error={errors.email} required={isNew || form.active} disabled={busy} />
        </Field>
        <Field label="Role" required error={errors.role} hint="Admin sees everything; Sales sees their own records; HR sees the travel desk.">
          <Select value={form.role} onChange={set('role')} options={ROLES} placeholder={null} error={errors.role} disabled={busy} />
        </Field>
        {isNew ? (
          <Field label="Password" required error={errors.password} hint={`At least ${minPassword} characters. Tell them yourself; it is not shown again.`}>
            <Input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} error={errors.password} required disabled={busy} />
          </Field>
        ) : <div className="hidden sm:block" />}
        <Field label="Phone" error={errors.phone}>
          <Input type="tel" value={form.phone} onChange={set('phone')} error={errors.phone} disabled={busy} />
        </Field>
        <Field label="Time zone" error={errors.time_zone} hint="For example Asia/Kolkata. Blank uses the company’s.">
          <Input value={form.time_zone} onChange={set('time_zone')} error={errors.time_zone} disabled={busy} />
        </Field>

        <label className="flex items-start gap-2.5 sm:col-span-2">
          <Checkbox checked={form.active} onCheckedChange={tick('active')} disabled={busy} className="mt-0.5" />
          <span className="text-[13px] text-foreground">Can sign in<span className="block text-[12px] text-muted-foreground">Untick to keep the account but stop them signing in.</span></span>
        </label>
        {form.role !== 'hr' && (
          <label className="flex items-start gap-2.5 sm:col-span-2">
            <Checkbox checked={form.daily_mis} onCheckedChange={tick('daily_mis')} disabled={busy || isNew} className="mt-0.5" />
            <span className="text-[13px] text-foreground">Gets the personal daily MIS email
              <span className="block text-[12px] text-muted-foreground">{isNew ? 'On for new users; change it after adding them.' : 'Their own summary of the day’s sales work.'}</span>
            </span>
          </label>
        )}
      </form>
    </Modal>
  );
}

function PasswordForm({ user, minPassword, run, onClose, onSaved }) {
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
      await run(() => call(`/users/${user.id}/password`, { method: 'POST', body: { password } }));
      onSaved(`${user.name} has a new password`);
    } catch (err) {
      setErrors(err.fields ?? {});
      setFailure(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`New password for ${user.name}`}
      subtitle="Tell them yourself; it is not shown again. They are signed out everywhere and sign in with the new one."
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="sa-password-form" size="sm" disabled={busy}>{busy ? 'Saving…' : 'Set password'}</Button>
        </>
      }
    >
      <form id="sa-password-form" className="grid gap-4" onSubmit={submit}>
        {failure && !Object.keys(errors).length && <div className="text-[13px] text-late">{failure}</div>}
        {!user.active && (
          <p className="text-[12.5px] text-muted-foreground">
            {user.name} is switched off. A new password does not let them in until you switch them on.
          </p>
        )}
        <Field label="Password" required error={errors.password} hint={`At least ${minPassword} characters.`}>
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
            error={errors.password} autoFocus required disabled={busy} />
        </Field>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ delete

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Delete, as the server does it (lib/userDeletion.js): the plan first, so
 * the super admin sees what will move and what will stay before anything
 * happens, then one request that backs up, checks, moves and archives.
 */
function DeleteDialog({ user, run, onClose, onDeleted }) {
  const [plan, setPlan] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [replacement, setReplacement] = useState('');
  const [moveTargets, setMoveTargets] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    run(() => call(`/users/${user.id}/deletion-plan`))
      .then((res) => {
        setPlan(res.data);
        // With exactly one person who can take over, suggest them.
        if (res.data.needs_replacement && res.data.candidates.length === 1) setReplacement(String(res.data.candidates[0].id));
      })
      .catch((err) => setLoadError(err.message));
  }, [user.id, run]);

  const chosen = plan?.candidates.find((c) => String(c.id) === replacement) ?? null;
  const noOneToTakeOver = plan && plan.needs_replacement && plan.candidates.length === 0;
  const canDelete = plan && plan.storage_ready && plan.admin_remains && !noOneToTakeOver
    && (!plan.needs_replacement || chosen) && confirmed && !busy;
  // Said beside the button, so it is seen: the dialog scrolls, and a refusal
  // drawn at the top of it went unnoticed.
  const blocker = !plan ? null
    : !plan.storage_ready ? 'File storage is not set up on the server, so no backup can be kept.'
    : !plan.admin_remains ? 'The tracker must keep at least one active Admin. Add an Admin user (or make someone an Admin) first.'
    : noOneToTakeOver ? 'Add or switch on another Sales user to take over their open work first.'
    : plan.needs_replacement && !chosen ? 'Choose who takes over their open work.'
    : !confirmed ? 'Tick “I understand this cannot be undone” to continue.'
    : null;

  async function submit(event) {
    event.preventDefault();
    if (!canDelete) return;
    setBusy(true);
    setErrors({});
    setFailure(null);
    try {
      const res = await run(() => call(`/users/${user.id}`, {
        method: 'DELETE',
        body: { replacement_user_id: chosen ? chosen.id : null, move_targets: Boolean(chosen && moveTargets) },
      }));
      const moved = Object.values(res.data.summary.records_moved).reduce((a, b) => a + b, 0);
      onDeleted(`${user.name} deleted. Backup saved${moved ? `; ${plural(moved, 'open record')} moved to ${chosen.name}` : ''}.`);
    } catch (err) {
      setErrors(err.fields ?? {});
      setFailure(err.message);
      setBusy(false);
    }
  }

  const rows = plan ? [
    ['Enquiries', plan.records.enquiries],
    ['Quotations', plan.records.quotations],
    ['Projects', plan.records.projects],
  ] : [];

  return (
    <Modal
      title={`Delete ${user.name}?`}
      subtitle="An Excel backup is made and checked first. If anything fails, nothing changes."
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="sa-delete-form" variant="destructive" size="sm" disabled={!canDelete}>
            {busy ? 'Backing up and deleting…' : 'Back up and delete'}
          </Button>
        </>
      }
    >
      {loadError ? (
        <ErrorState message={loadError} />
      ) : !plan ? (
        <div className="skeleton h-[220px]" />
      ) : (
        <form id="sa-delete-form" className="flex flex-col gap-5" onSubmit={submit}>
          {!plan.storage_ready && (
            <Alert variant="destructive">
              <AlertDescription>File storage is not set up on the server, so no backup can be kept. Delete is unavailable until it is.</AlertDescription>
            </Alert>
          )}
          {!plan.admin_remains && (
            <Alert variant="destructive">
              <AlertDescription>
                Deleting {user.name} would leave the tracker with no active Admin. Add an Admin user, or make
                someone an Admin, before deleting.
              </AlertDescription>
            </Alert>
          )}

          <div>
            <div className="eyebrow mb-2">Their records</div>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="bg-secondary text-left">
                    {['', 'Total', 'Open (move)', 'Closed (stay)'].map((h) => (
                      <th key={h} scope="col" className="h-row px-3 text-[12px] font-semibold text-muted-foreground">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([label, r]) => (
                    <tr key={label} className="border-t border-border">
                      <th scope="row" className="px-3 py-2 text-left font-medium text-foreground">{label}</th>
                      <td className="num px-3 py-2">{r.total}</td>
                      <td className="num px-3 py-2">{r.open_owned}</td>
                      <td className="num px-3 py-2">{r.total - r.open_owned}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-border">
                    <th scope="row" className="px-3 py-2 text-left font-medium text-foreground">Sales targets</th>
                    <td className="num px-3 py-2">{plan.targets.total}</td>
                    <td className="px-3 py-2 text-secondary-text" colSpan={2}>
                      {plan.targets.past} past year{plan.targets.past === 1 ? '' : 's'}, {plan.targets.current_or_future} this year or later
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {plan.needs_replacement ? (
            noOneToTakeOver ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {user.name} has {plural(plan.open_owned, 'open record')} and there is no other active Sales user to take
                  them over. Add or switch on a Sales user first, or switch {user.name} off instead.
                </AlertDescription>
              </Alert>
            ) : (
              <Field label="Who takes over their open work" required error={errors.replacement_user_id}
                hint="Only active Sales users can own records.">
                <Select value={replacement} onChange={(e) => setReplacement(e.target.value)} disabled={busy}
                  error={errors.replacement_user_id} placeholder="Choose a person"
                  options={plan.candidates.map((c) => ({ value: String(c.id), label: `${c.name} (${c.email})` }))} />
              </Field>
            )
          ) : (
            <p className="text-[13px] text-secondary-text">They have no open records, so nobody needs to take over.</p>
          )}

          {plan.targets.current_or_future > 0 && (
            <label className="flex items-start gap-2.5">
              <Checkbox checked={moveTargets && Boolean(chosen)} onCheckedChange={(v) => setMoveTargets(v === true)}
                disabled={busy || !chosen} className="mt-0.5" />
              <span className="text-[13px] text-foreground">
                Move this year’s and future sales targets{chosen ? ` to ${chosen.name}` : ''}
                <span className="block text-[12px] text-muted-foreground">
                  {chosen ? 'Unticked, they stay with ' + user.name + '. A target the new person already has always stays.' : 'Choose who takes over first.'}
                </span>
              </span>
            </label>
          )}

          <div className="rounded-lg border border-border bg-secondary px-4 py-3">
            <div className="eyebrow mb-1.5">What will happen</div>
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] text-secondary-text">
              <li>An Excel backup of all their records, targets and history is saved privately, and checked.</li>
              {plan.open_owned > 0 && <li>{plural(plan.open_owned, 'open record')} move to {chosen ? chosen.name : 'the person you choose'}.</li>}
              <li>Closed records and past targets stay under {user.name}’s name, so reports still show their work.</li>
              {plan.targets.current_or_future > 0 && (
                <li>{plural(plan.targets.current_or_future, 'current or future target')} {moveTargets && chosen ? `move to ${chosen.name}` : `stay with ${user.name}`}.</li>
              )}
              {plan.api_tokens > 0 && <li>{plural(plan.api_tokens, 'API token')} in {user.name}’s name {plan.api_tokens === 1 ? 'is' : 'are'} revoked.</li>}
              <li>{user.name} can no longer sign in, and moves to the Deleted users tab with the backup.</li>
            </ul>
          </div>

          <label className="flex items-start gap-2.5">
            <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} disabled={busy} className="mt-0.5" />
            <span className="text-[13px] text-foreground">I understand this cannot be undone.</span>
          </label>

          {failure && (
            <div ref={(el) => el?.scrollIntoView({ block: 'nearest' })}>
              <Alert variant="destructive"><AlertDescription>{failure}</AlertDescription></Alert>
            </div>
          )}
          {!failure && blocker && <p className="m-0 text-[12.5px] text-muted-foreground">{blocker}</p>}
        </form>
      )}
    </Modal>
  );
}

// ----------------------------------------------------------- deleted users

function DeletedUsers({ run }) {
  const [state, setState] = useState({ loading: true, error: null, rows: [] });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await run(() => call('/deleted-users'));
      setState({ loading: false, error: null, rows: res.data });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err.message }));
    }
  }, [run]);

  useEffect(() => { load(); }, [load]);

  if (state.error) return <div className="rounded-lg border border-border bg-card"><ErrorState message={state.error} onRetry={load} /></div>;
  if (state.loading && !state.rows.length) return <div className="skeleton h-[160px]" />;
  if (!state.rows.length) {
    return (
      <div className="rounded-lg border border-border bg-card">
        <Empty title="Nobody has been deleted" text="When you delete a user, they appear here with the Excel backup made before the deletion." />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-[13px]">
          <thead>
            <tr className="border-b border-border bg-secondary text-left">
              {['Person', 'Role', 'Deleted', 'Open work moved to', 'Backup', ''].map((h) => (
                <th key={h} scope="col" className="h-row px-4 text-[12px] font-semibold text-muted-foreground">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.rows.map((row) => {
              const moved = Object.values(row.summary?.records_moved ?? {}).reduce((a, b) => a + b, 0);
              return (
                <tr key={row.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-foreground">{row.name}</div>
                    <div className="text-[12px] break-words text-muted-foreground">{row.email ?? '—'}</div>
                  </td>
                  <td className="px-4 py-2.5 text-secondary-text">{roleLabel(row.role)}</td>
                  <td className="px-4 py-2.5 text-secondary-text">
                    <div>{localDate(row.deleted_at)}</div>
                    <div className="text-[12px] text-muted-foreground">by {row.deleted_by}</div>
                  </td>
                  <td className="px-4 py-2.5 text-secondary-text">
                    {row.replacement_name
                      ? <>{row.replacement_name}<div className="text-[12px] text-muted-foreground">{plural(moved, 'record')}</div></>
                      : <span className="text-muted-foreground">Nobody (no open work)</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone="success" dot>Saved and checked</Badge>
                    <div className="mt-1 text-[12px] text-muted-foreground">{fileSize(row.backup_size_bytes)}</div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {/* A plain link: the browser sends the portal cookie, and
                        the server checks it and the file before sending. */}
                    <Button variant="outline" size="sm" asChild>
                      <a href={`${BASE}/deleted-users/${row.id}/backup`} download>
                        <Download className="size-4" aria-hidden="true" />Download Excel
                      </a>
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
