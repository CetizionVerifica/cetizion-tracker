import { Badge } from './ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { money, date, localDate } from '../lib/format.js';

/** What the client last said about a stage in the portal (#198 §4), in staff words. */
export function clientWord(a) {
  const on = localDate(a.created_at);
  if (a.kind === 'confirmed') return { tone: 'success', text: `Client confirmed ${on}` };
  if (a.kind === 'query') return a.status === 'open' ? { tone: 'warning', text: 'Client query open', note: a.note } : { tone: 'neutral', text: `Client query ${a.status} ${localDate(a.resolved_at)}` };
  if (a.status === 'open') return { tone: 'info', text: `Client reports paying ${money(a.amount)} on ${date(a.paid_on)}: to check in Collections` };
  return { tone: a.status === 'matched' ? 'success' : 'neutral', text: `Client's payment advice ${a.status}` };
}

/**
 * The client's latest word on every invoice the caller can see, by stage id,
 * for the badges on Collections and the Payment stages list.
 */
export function useClientSaid() {
  const { data } = useFetch(() => api.raw('/portal-admin/actions/by-stage'), []);
  const said = new Map();
  for (const a of data?.data ?? []) said.set(a.stage_id, clientWord(a));
  return said;
}

/** One stage's badge in a table cell; nothing when the client has said nothing. */
export function ClientSaidBadge({ said }) {
  if (!said) return null;
  return <div><Badge tone={said.tone}>{said.text}</Badge>{said.note && <div className="small muted" title={said.note} style={{ maxWidth: '32ch', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>“{said.note}”</div>}</div>;
}
