import { useEffect, useState } from 'react';

/** A band across the top on staging (#35), so nobody mistakes it for the real tracker. */
export function EnvironmentBanner() {
  const [env, setEnv] = useState(null);
  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then((d) => setEnv(d.environment)).catch(() => {});
  }, []);
  useEffect(() => {
    document.body.classList.toggle('is-staging', env === 'staging');
    if (env === 'staging' && !document.title.startsWith('[STAGING]')) document.title = `[STAGING] ${document.title}`;
  }, [env]);
  if (env !== 'staging') return null;
  return <div className="env-banner" role="status">STAGING · test data only · nothing here reaches clients</div>;
}
