import { useAuth } from '../lib/auth.jsx';
import Login from '../pages/Login.jsx';

/** Nothing behind this renders — or fetches — until the API says who you are. */
export default function AuthGate({ children }) {
  const { status } = useAuth();

  if (status === 'checking') {
    return (
      <div className="auth">
        <div className="auth__checking">Checking your session…</div>
      </div>
    );
  }

  return status === 'in' ? children : <Login />;
}
