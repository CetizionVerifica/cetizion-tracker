import { Checkbox } from '../../components/ui/checkbox.tsx';
import { Label } from '../../components/ui/label.tsx';
import { api } from '../../lib/api.js';
import { useAccount } from './index.jsx';
import { Pane } from './Pane.jsx';

const LABEL = {
  follow_up_late: 'A follow-up of mine is late',
  deal_accepted: 'A deal I own is accepted, or a PO arrives',
  discount_approval: 'A discount needs my approval',
  monday_brief: 'The Monday management brief',
};

/**
 * Which emails you want.
 *
 * Each switch saves on its own — there is no Save button, because a page
 * of four checkboxes with a Save button is a page where three of them are
 * silently unsaved while you read the fourth. The server merges one key at
 * a time rather than replacing the object, which is what makes that safe.
 */
export function Notifications() {
  const { profile, notify_keys: keys, refetch, toast } = useAccount();

  async function toggle(key, on) {
    try {
      await api.raw('/auth/account', { method: 'PATCH', body: { notify: { [key]: on } } });
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  return (
    <Pane title="Email me when" description="Each one saves as you tick it. Everything else reaches you on Today instead.">
      <div className="grid gap-3.5">
        {keys.map((key) => (
          <div key={key} className="flex items-center gap-3">
            <Checkbox
              id={`notify-${key}`}
              checked={profile.notify?.[key] === true}
              onCheckedChange={(on) => toggle(key, on === true)}
            />
            <Label htmlFor={`notify-${key}`} className="text-[13px] font-normal text-secondary-text">
              {LABEL[key] || key}
            </Label>
          </div>
        ))}
      </div>
    </Pane>
  );
}
