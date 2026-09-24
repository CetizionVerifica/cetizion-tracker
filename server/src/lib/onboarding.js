/**
 * The onboarding checklist, with the steps another record already owns
 * answering for themselves (#22 / C15).
 *
 * Eleven steps come from the template, and four of them are not really
 * questions for a person: whether the PO is registered, whether the
 * advance invoice went out, whether the on-delivery invoice went out, and
 * whether everything is paid are facts the PO register and the payment
 * schedule already hold. A tick that a project manager maintains by hand
 * beside those facts can only ever be right by coincidence — and when the
 * two disagree, the tick is the one people believe.
 *
 * So each step is classified here, on the server, next to the data it is
 * derived from. Steps nobody else owns keep their stored status and stay
 * editable. A step whose wording an admin has changed past recognition
 * falls through to manual, which is the safe direction: a custom step is a
 * person's step.
 *
 * `status` is left exactly as stored. The UI reads `effective_status`.
 */

const DONE = 'Done';
const IN_PROGRESS = 'In Progress';
const NOT_STARTED = 'Not Started';
const NOT_APPLICABLE = 'N/A';

const PAID = 'Paid';
const ON_DELIVERY = 'On Delivery';

/** "20 May 2026", in the same shape the client prints. */
function day(value) {
  if (!value) return null;
  const iso = String(value).slice(0, 10);
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(d)} ${months[Number(m) - 1]} ${y}`;
}

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Each rule: whose step it is, how to recognise it, and what the records
 * say about it. `read` returns `{ done, detail }`, or `{ done: null }` when
 * there is nothing yet to read it from — an unanswerable step is "not
 * started", not "not done", and the detail says which.
 */
const RULES = [
  {
    match: /purchase order.*(regist|received)|po register/i,
    owner: 'sales',
    read: ({ purchase_orders: pos }) => (pos.length
      ? { done: true, detail: `${pos.map((po) => po.po_number).join(', ')} · ${day(pos[0].po_date) || 'no date'}` }
      : { done: false, detail: 'No purchase order registered yet' }),
  },
  {
    match: /services? on each po|services listed against/i,
    owner: 'sales',
    read: ({ purchase_orders: pos, services }) => {
      if (!pos.length) return { done: null, detail: 'Waiting for a purchase order' };
      const bare = pos.filter((po) => Number(po.service_count || 0) === 0);
      return bare.length
        ? { done: false, detail: `Nothing listed on ${bare.map((po) => po.po_number).join(', ')}` }
        : { done: true, detail: `${count(services.length, 'service')} across ${count(pos.length, 'order')}` };
    },
  },
  {
    match: /payment stages? for each po|payment schedule/i,
    owner: 'finance',
    read: ({ purchase_orders: pos, payment_stages: stages }) => {
      if (!pos.length) return { done: null, detail: 'Waiting for a purchase order' };
      const bare = pos.filter((po) => Number(po.stage_count || 0) === 0);
      return bare.length
        ? { done: false, detail: `No split entered for ${bare.map((po) => po.po_number).join(', ')}` }
        : { done: true, detail: `${count(stages.length, 'stage')} across ${count(pos.length, 'order')}` };
    },
  },
  {
    // Checked before the advance rule: both say "invoice", and this one is
    // the more specific of the two.
    match: /on-delivery stage invoice|delivery stage invoice/i,
    owner: 'finance',
    read: ({ payment_stages: stages }) => {
      const onDelivery = stages.filter((s) => s.trigger_event === ON_DELIVERY);
      if (!onDelivery.length) return { done: null, detail: 'No stage is triggered by delivery' };
      const unbilled = onDelivery.filter((s) => !s.invoice_no);
      return unbilled.length
        ? { done: false, detail: `${count(unbilled.length, 'stage')} still to raise` }
        : { done: true, detail: onDelivery.map((s) => s.invoice_no).join(', ') };
    },
  },
  {
    match: /advance.*invoice|stage-?1.*invoice|first invoice/i,
    owner: 'finance',
    read: ({ purchase_orders: pos, payment_stages: stages }) => {
      const first = pos
        .map((po) => stages.filter((s) => s.po_number === po.po_number).sort((a, b) => a.stage_no - b.stage_no)[0])
        .filter(Boolean);
      if (!first.length) return { done: null, detail: 'Waiting for a payment schedule' };
      const unbilled = first.filter((s) => !s.invoice_no);
      return unbilled.length
        ? {
          done: false,
          // Which order is waiting, not just that one is: on a project with
          // two POs, "with finance" alone sends someone looking for both.
          detail: `With finance · ${unbilled.map((s) => s.po_number).join(', ')} · ${count(Number(unbilled[0].credit_days ?? unbilled[0].terms_days ?? 30), 'day')} terms`,
        }
        : { done: true, detail: first.map((s) => s.invoice_no).join(', ') };
    },
  },
  {
    match: /all stage invoices paid|project closed|fully paid/i,
    owner: 'finance',
    read: ({ payment_stages: stages }) => {
      if (!stages.length) return { done: null, detail: 'Waiting for a payment schedule' };
      const open = stages.filter((s) => s.stage_status !== PAID);
      if (!open.length) return { done: true, detail: 'Every stage settled' };
      const overdue = open.filter((s) => Number(s.days_overdue || 0) > 0).length;
      return { done: false, detail: overdue ? `${count(open.length, 'stage')} open · ${overdue} overdue` : `${count(open.length, 'stage')} still open` };
    },
  },
  {
    match: /final deliverable|certificate issued|report.*issued to client/i,
    owner: 'delivery',
    read: ({ project }) => (project.actual_delivery_date
      ? { done: true, detail: `Delivered ${day(project.actual_delivery_date)}` }
      : {
        done: false,
        detail: project.planned_delivery_date ? `Planned for ${day(project.planned_delivery_date)}` : 'No delivery date planned',
      }),
  },
];

const ruleFor = (step) => RULES.find((rule) => rule.match.test(String(step.step || '')));

/**
 * Add `effective_status`, `derived`, `owned_by` and `detail` to each row.
 *
 * A derived step that reads false is "In Progress" rather than "Not
 * Started" once anything before it has happened, because "not started" is
 * a thing a person can act on and "waiting for finance" is not.
 */
export function withDerivedSteps(rows, context) {
  return rows.map((row) => {
    if (row.status === NOT_APPLICABLE) {
      return { ...row, effective_status: NOT_APPLICABLE, derived: false, owned_by: null, detail: row.remarks || null };
    }
    const rule = ruleFor(row);
    if (!rule) {
      return {
        ...row,
        effective_status: row.status,
        derived: false,
        owned_by: null,
        detail: row.completed_date ? `${day(row.completed_date)}${row.owner ? ` · ${row.owner}` : ''}` : row.remarks || null,
      };
    }
    const { done, detail } = rule.read(context);
    return {
      ...row,
      effective_status: done === true ? DONE : done === null ? NOT_STARTED : IN_PROGRESS,
      derived: true,
      owned_by: rule.owner,
      detail,
    };
  });
}

/** Done / total / what is left, counted on the effective status. */
export function onboardingProgress(rows) {
  const counted = rows.filter((r) => r.effective_status !== NOT_APPLICABLE);
  const done = counted.filter((r) => r.effective_status === DONE).length;
  const waiting = counted.filter((r) => r.effective_status !== DONE && r.derived).length;
  return { done, total: counted.length, left: counted.length - done, waiting };
}
