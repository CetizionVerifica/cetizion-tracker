import { useState } from 'react';

import { useAuth } from '../lib/auth.jsx';
import { Alert, Field, Input } from '../components/ui.jsx';

/**
 * The sign-in form asks for whatever the API signs people in with: a
 * username while the tracker is on the shared password, an email once it
 * is on the users table. The server tells us which — see /auth/config —
 * so the deployment's choice is not copied into the build.
 */
const FIELD = {
  shared: { label: 'Username', type: 'text', autoComplete: 'username', name: 'username' },
  database: { label: 'Email', type: 'email', autoComplete: 'email', name: 'email' },
};

export default function Login() {
  const { signIn, mode } = useAuth();
  const field = FIELD[mode] ?? FIELD.shared;
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  async function submit(event) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);
    try {
      await signIn(form.username, form.password);
    } catch (err) {
      setError(err.message);
      setForm((prev) => ({ ...prev, password: '' }));
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={submit}>
        <div className="auth__brand">
          <span className="auth__logo">C</span>
          <div>
            <h1 className="auth__title">Cetizion Tracker</h1>
            <div className="auth__tagline">Sales · Projects · Payments · Travel</div>
          </div>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}

        <Field label={field.label}>
          <Input
            key={field.name}
            name={field.name}
            type={field.type}
            autoComplete={field.autoComplete}
            autoFocus
            required
            value={form.username}
            onChange={set('username')}
            disabled={busy}
          />
        </Field>

        <Field label="Password">
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={form.password}
            onChange={set('password')}
            disabled={busy}
          />
        </Field>

        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
