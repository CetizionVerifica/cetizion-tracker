import { useEffect, useState } from 'react';
import { Seg } from '../../components/insights/shared.jsx';
import { Tone } from '../../components/sales.jsx';
import { api } from '../../lib/api.js';
import { useAccount } from './index.jsx';
import { Pane } from './Pane.jsx';

const CHANNEL = { in_app: 'In the app', email: 'By email', both: 'Both', off: 'Off' };
const SAID = { in_app: 'in the app', email: 'by email', both: 'in the app and by email', off: 'nowhere' };

/**
 * What you hear about, and how (#44), Wave 8.
 *
 * Each choice saves as it is made and says so (a "Saved" chip on the row and
 * a toast) — no Save button. Quiet hours are the exception: two times make
 * one setting, so they save together. The kinds offered are the ones the
 * server lists for this person's role.
 */
export function Notifications() {
  const { profile, notify_groups: groups = [], notify_channels: channels = Object.keys(CHANNEL), refetch, toast } = useAccount();
  const notify = profile.notify || {};
  const [quiet, setQuiet] = useState({ from: notify.quiet?.from || '', to: notify.quiet?.to || '' });
  const [saved, setSaved] = useState(() => new Set());
  useEffect(() => { setQuiet({ from: notify.quiet?.from || '', to: notify.quiet?.to || '' }); }, [notify.quiet?.from, notify.quiet?.to]);

  async function save(change, done) {
    try {
      await api.raw('/auth/account', { method: 'PATCH', body: { notify: change } });
      refetch();
      if (done) toast(done, 'success');
      return true;
    } catch (err) {
      toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger');
      return false;
    }
  }

  const quietSet = Boolean(notify.quiet?.from && notify.quiet?.to);
  const quietChanged = quiet.from !== (notify.quiet?.from || '') || quiet.to !== (notify.quiet?.to || '');

  return (
    <>
      <Pane title="What reaches you, and how" description="In the app is the bell, and a pop-up while the tracker is open. By email is a message each time. Off hides it entirely. Each choice saves as you make it.">
        <div className="flex flex-col">
          {groups.map((g) => (
            <div key={g.key} className="acc-switchrow">
              <div><b>{g.label}{saved.has(g.key) && <Tone tone="ok" className="ml-2">Saved</Tone>}</b></div>
              <div className="max-w-full overflow-x-auto">
                <Seg
                  label={`${g.label}: how`}
                  value={notify.kinds?.[g.key] || 'in_app'}
                  width={96}
                  options={channels.map((c) => ({ value: c, label: CHANNEL[c] || c }))}
                  onChange={async (v) => { if (await save({ kinds: { [g.key]: v } }, `Saved: ${g.label.toLowerCase()} now reach you ${SAID[v] || v}.`)) setSaved((s) => new Set(s).add(g.key)); }}
                />
              </div>
            </div>
          ))}
          {!groups.length && <p className="m-0 text-[13px] text-secondary-text">Nothing to choose here for your role.</p>}
        </div>
      </Pane>

      <div className="set-two">
        <Pane title="Quiet hours" description="No emails and no pop-ups between these times, in your time zone. Emails wait until they end; the bell still counts.">
          <div className="mg-grid2">
            <label className="mg-field"><span className="mg-field__label">From</span><input className="mg-input" type="time" value={quiet.from} onChange={(e) => setQuiet((q) => ({ ...q, from: e.target.value }))} /></label>
            <label className="mg-field"><span className="mg-field__label">To</span><input className="mg-input" type="time" value={quiet.to} onChange={(e) => setQuiet((q) => ({ ...q, to: e.target.value }))} /></label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="mg-btn mg-btn--primary" disabled={!quietChanged || !quiet.from || !quiet.to} onClick={() => save({ quiet }, 'Quiet hours saved')}>Save quiet hours</button>
            {quietSet && <button type="button" className="mg-btn mg-btn--ghost" onClick={() => save({ quiet: null }, 'Quiet hours off')}>Turn off</button>}
          </div>
        </Pane>
        <Pane title="Digests" description="Each switch saves as you flip it.">
          <div className="flex flex-col">
            <label className="acc-switchrow cursor-pointer">
              <div><b className="font-medium">A morning digest of what’s waiting for me, at 8:30 on working days</b></div>
              <span className="mg-switch"><input type="checkbox" role="switch" checked={notify.digest !== false} onChange={(e) => save({ digest: e.target.checked }, e.target.checked ? 'Morning digest on' : 'Morning digest off')} /></span>
            </label>
            {profile.role === 'admin' && (
              <label className="acc-switchrow cursor-pointer">
                <div><b className="font-medium">The Monday digest for admins: the week in notifications, and what is still open</b></div>
                <span className="mg-switch"><input type="checkbox" role="switch" checked={notify.weekly !== false && notify.monday_brief !== false} onChange={(e) => save({ weekly: e.target.checked, monday_brief: e.target.checked }, e.target.checked ? 'Monday digest on' : 'Monday digest off')} /></span>
              </label>
            )}
          </div>
        </Pane>
      </div>
    </>
  );
}
