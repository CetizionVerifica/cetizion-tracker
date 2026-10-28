import { useEffect, useState } from 'react';
import { Check, TriangleAlert } from 'lucide-react';

import { api } from '../lib/api.js';
import { Alert, AlertDescription } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardContent } from '../components/ui/card.tsx';
import { Checkbox } from '../components/ui/checkbox.tsx';
import { Label } from '../components/ui/label.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';

/**
 * "Claude wants to use the tracker as you" (#249).
 *
 * claude.ai sends the browser here from /api/oauth/authorize when somebody
 * adds the tracker as a custom connector. Sign-in has already happened by
 * the time this draws: AuthGate shows the sign-in page on this same address
 * first. Nothing is issued until Allow; Deny sends Claude a refusal.
 *
 * Writing is off unless ticked, the same default as an API token: a
 * connection that was only asked to read should not be able to add notes.
 */
export default function OAuthConsent() {
  const id = new URLSearchParams(window.location.search).get('request') || '';
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [canWrite, setCanWrite] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.raw(`/oauth/requests/${encodeURIComponent(id)}`)
      .then((r) => setInfo(r.data))
      .catch((err) => setError(err.message));
  }, [id]);

  async function decide(allow) {
    setBusy(true);
    try {
      const r = await api.action(`/oauth/requests/${encodeURIComponent(id)}`, { allow, can_write: allow && canWrite });
      // A real navigation: the code goes back to Claude, which finishes the connection.
      window.location.assign(r.data.redirect);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4 py-10">
      <Card className="w-full max-w-[480px] gap-0 rounded-xl py-0">
        <CardContent className="flex flex-col gap-6 px-6 py-10 sm:px-10">
          <div className="flex items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary">
              <Check className="size-[18px] text-primary-foreground" strokeWidth={3.4} aria-hidden="true" />
            </span>
            <div className="font-display text-[16px] font-bold text-foreground">Sales Tracker</div>
          </div>

          {error ? (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : !info ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-7 w-3/4" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            <>
              <div>
                <h1 className="font-display text-2xl/[1.25] font-bold text-foreground">Connect {info.client_name}</h1>
                <p className="mt-1.5 text-[13px]/[1.6] text-secondary-text">
                  {info.client_name} ({info.redirect_host}) is asking to use the tracker as <strong className="text-foreground">{info.user_name}</strong>.
                </p>
              </div>

              <ul className="flex flex-col gap-2 text-[13px]/[1.6] text-secondary-text">
                <li>It will see {info.sees === 'everything' ? 'every record, as an administrator does' : 'your own clients, deals and projects, as you do in the tracker'}.</li>
                <li>Whatever it reads goes into your conversation with Claude. Client email stays as subjects only.</li>
                <li>It cannot delete anything, change a stage, send a message or record money.</li>
                <li>You can disconnect it at any time in Settings → Claude connector.</li>
              </ul>

              {info.refused ? (
                <Alert variant="destructive">
                  <TriangleAlert aria-hidden="true" />
                  <AlertDescription>{info.refused}</AlertDescription>
                </Alert>
              ) : (
                <div className="flex items-start gap-3">
                  <Checkbox id="can-write" checked={canWrite} onCheckedChange={(v) => setCanWrite(v === true)} className="mt-0.5" />
                  <Label htmlFor="can-write" className="flex flex-col items-start gap-0.5 text-[13px] font-semibold">
                    Let it add notes and tasks
                    <span className="font-normal text-muted-foreground">Notes, tasks, logged calls and next steps, marked as made through Claude. Off means read only.</span>
                  </Label>
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" disabled={busy} onClick={() => decide(false)}>Deny</Button>
                {!info.refused && <Button disabled={busy} onClick={() => decide(true)}>Allow</Button>}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
