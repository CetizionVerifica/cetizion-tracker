import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { money, date, localDate } from '../lib/format.js';
import { Tone } from './sales.jsx';

/**
 * What the client last said about a stage in the portal (#198 §4), in staff
 * words. `tone` is the system's badge tone; `match` says the word is a
 * payment report still waiting to be matched, so the badge can offer
 * "Match it" on the spot.
 */
export function clientWord(a) {
  const on = localDate(a.created_at);
  const base = { id: a.id, kind: a.kind, status: a.status };
  if (a.kind === 'confirmed') return { ...base, tone: 'ok', text: `Client confirmed ${on}` };
  if (a.kind === 'query') {
    if (a.status === 'open') return { ...base, tone: 'wait', text: 'Client query open', note: a.note };
    return { ...base, tone: a.status === 'resolved' ? 'ok' : 'plain', text: `Client query ${a.status} ${localDate(a.resolved_at)}` };
  }
  if (a.status === 'open') return { ...base, tone: 'info', match: true, text: `Client reports paying ${money(a.amount)} on ${date(a.paid_on)}` };
  return { ...base, tone: a.status === 'matched' ? 'ok' : 'plain', text: a.status === 'matched' ? "Client's payment advice matched" : `Client's payment advice ${a.status}` };
}

/**
 * The client's latest word on every invoice the caller can see, by stage id,
 * for the badges on Collections and the Payment stages list.
 */
export function useClientSaid(deps = []) {
  const { data } = useFetch(() => api.raw('/portal-admin/actions/by-stage').catch(() => ({ data: [] })), deps);
  const said = new Map();
  for (const a of data?.data ?? []) said.set(a.stage_id, clientWord(a));
  return said;
}

/**
 * One stage's badge in a table cell; nothing when the client has said
 * nothing. `onMatch` adds "Match it" beside an open payment report.
 */
export function ClientSaidBadge({ said, onMatch }) {
  if (!said) return null;
  return (
    <span className="app-stack">
      <span className="app-badges">
        <Tone tone={said.tone}>{said.text}</Tone>
        {said.match && onMatch && <button type="button" className="app-textbtn" onClick={(e) => { e.stopPropagation(); onMatch(said); }}>Match it</button>}
      </span>
      {said.note && <span className="block max-w-[32ch] truncate text-[12px] text-muted-foreground" title={said.note}>“{said.note}”</span>}
    </span>
  );
}
