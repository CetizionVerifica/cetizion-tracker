import { useEffect, useState } from 'react';
import { Checkbox } from '../../components/ui/checkbox.tsx';
import { Label } from '../../components/ui/label.tsx';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { useAccount } from './index.jsx';
import { Pane } from './Pane.jsx';

const CHANNEL = { in_app: 'In the app', email: 'By email', both: 'Both', off: 'Off' };

/**
 * What you hear about, and how (#44).
 *
 * Each choice saves as it is made — there is no Save button, because a page
 * of settings with a Save button is a page where most of them are silently
 * unsaved while you read the rest. The server merges one setting at a time.
 * Quiet hours are the exception: two times make one setting, so they save
 * together.
 */
export function Notifications() {
  const { profile, notify_groups: groups = [], notify_channels: channels = Object.keys(CHANNEL), refetch, toast } = useAccount();
  const notify = profile.notify || {};
  const [quiet, setQuiet] = useState({ from: notify.quiet?.from || '', to: notify.quiet?.to || '' });
  useEffect(() => { setQuiet({ from: notify.quiet?.from || '', to: notify.quiet?.to || '' }); }, [notify.quiet?.from, notify.quiet?.to]);

  async function save(change, done) {
    try {
      await api.raw('/auth/account', { method: 'PATCH', body: { notify: change } });
      refetch();
      if (done) toast(done, 'success');
    } catch (err) {
      toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger');
    }
  }

  const quietSet = Boolean(notify.quiet?.from && notify.quiet?.to);
  const quietChanged = quiet.from !== (notify.quiet?.from || '') || quiet.to !== (notify.quiet?.to || '');

  return (
    <>
      <Pane title="What reaches you, and how" description="In the app is the bell and a pop-up while the tracker is open; by email is a message each time. Off hides it entirely.">
        <div className="grid gap-3">
          {groups.map((g) => (
            <div key={g.key} className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-[13px] text-secondary-text">{g.label}</span>
              <div className="w-[160px]">
                <Select
                  aria-label={`${g.label}: how`}
                  value={notify.kinds?.[g.key] || 'in_app'}
                  placeholder={null}
                  options={channels.map((c) => ({ value: c, label: CHANNEL[c] || c }))}
                  onChange={(e) => save({ kinds: { [g.key]: e.target.value } })}
                />
              </div>
            </div>
          ))}
        </div>
      </Pane>

      <Pane title="Quiet hours" description="No emails and no pop-ups between these times, in your time zone. Emails wait until they end; the bell still counts.">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-[12px] font-medium text-secondary-foreground">From
            <Input type="time" value={quiet.from} onChange={(e) => setQuiet((q) => ({ ...q, from: e.target.value }))} />
          </label>
          <label className="flex flex-col gap-1.5 text-[12px] font-medium text-secondary-foreground">To
            <Input type="time" value={quiet.to} onChange={(e) => setQuiet((q) => ({ ...q, to: e.target.value }))} />
          </label>
          <Button size="sm" disabled={!quietChanged || !quiet.from || !quiet.to} onClick={() => save({ quiet }, 'Quiet hours saved')}>Save</Button>
          {quietSet && <Button variant="ghost" size="sm" onClick={() => save({ quiet: null }, 'Quiet hours off')}>Turn off</Button>}
        </div>
      </Pane>

      <Pane title="Digests" description="Each switch saves as you tick it.">
        <div className="grid gap-3.5">
          <div className="flex items-center gap-3">
            <Checkbox id="notify-digest" checked={notify.digest !== false} onCheckedChange={(on) => save({ digest: on === true })} />
            <Label htmlFor="notify-digest" className="text-[13px] font-normal text-secondary-text">
              A morning digest of what is waiting for me, at 8:30 on working days
            </Label>
          </div>
          {profile.role === 'admin' && (
            <div className="flex items-center gap-3">
              <Checkbox id="notify-weekly" checked={notify.weekly !== false && notify.monday_brief !== false} onCheckedChange={(on) => save({ weekly: on === true, monday_brief: on === true })} />
              <Label htmlFor="notify-weekly" className="text-[13px] font-normal text-secondary-text">
                The Monday digest for admins: the week in notifications, and what is still open
              </Label>
            </div>
          )}
        </div>
      </Pane>
    </>
  );
}
