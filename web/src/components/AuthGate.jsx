import { useAuth } from '../lib/auth.jsx';
import Login from '../pages/Login.jsx';
import { BrandMark } from './shell/Shell.jsx';

/** Nothing behind this renders — or fetches — until the API says who you are. */
export default function AuthGate({ children }) {
  const { status } = useAuth();

  if (status === 'checking') {
    return (
      <div className="grid min-h-dvh place-items-center px-4">
        <div role="status" className="flex flex-col items-center gap-[18px]">
          <span className="app-pulse"><BrandMark size={56} /></span>
          <span className="text-[13.5px] text-secondary-text">Checking who you are…</span>
        </div>
      </div>
    );
  }

  return status === 'in' ? children : <Login />;
}
