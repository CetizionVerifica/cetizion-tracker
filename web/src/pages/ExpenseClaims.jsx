import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ListPage } from '../components/ListPage.jsx';
import { ClaimDecisionDialog, CorrectClaimDialog, ReimburseClaimDialog } from '../components/actions.jsx';
import { shortDate } from '../components/money.jsx';
import { Tone, useTotal } from '../components/sales.jsx';
import { CLAIM, StateBadge, count } from '../components/travel.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useLookups } from '../lib/hooks.js';
import { money } from '../lib/format.js';

const APPROVAL = { Submitted: ['info', 'Submitted'], Approved: ['ok', 'Approved'], Rejected: ['late', 'Rejected'], 'On Hold': ['wait', 'On hold'] };
const TO_REIMBURSE = 'Approved - to reimburse,Partly reimbursed';

/** What to do next, in plain words (the view's "HR: …" / "FINANCE: …" said for people). */
function nextStep(r) {
  const owed = Math.max(Number(r.amount_claimed || 0) - Number(r.amount_reimbursed || 0), 0);
  switch (r.status) {
    case 'Pending approval': return 'An admin approves or rejects it';
    case 'On hold': return 'On hold: decide it once what was asked for is in';
    case 'Approved - to reimburse': return `Finance reimburses ${r.employee_name} at month-end`;
    case 'Partly reimbursed': return `Reimburse the ${money(owed)} balance to ${r.employee_name}`;
    case 'Reimbursed': return `Nothing to do: paid${r.reimbursement_date ? ` ${shortDate(r.reimbursement_date)}` : ''}`;
    case 'Rejected': return 'Nothing to do: not reimbursed';
    default: return r.follow_up_action || '';
  }
}

/**
 * Employee expense claims (Wave 6): quick filters for what waits on
 * someone, each claim's trip, the decision and the state as two badges with
 * the next step in words, and one button per row — Review (also for a claim
 * on hold), Reimburse, or for an admin on a settled claim, Correct (the
 * audited correction route). Deciding and paying stay the admin's (#85);
 * sales see why there is no button.
 */
export default function ExpenseClaims() {
  const lookups = useLookups();
  const { isAdmin } = useAuth();
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);

  const all = useTotal('expense-claims', {}, [version]);
  const decide = useTotal('expense-claims', { status: 'Pending approval' }, [version]);
  const reimburse = useTotal('expense-claims', { status: TO_REIMBURSE }, [version]);
  const hold = useTotal('expense-claims', { status: 'On hold' }, [version]);

  const refresh = () => {
    setDialog(null);
    setVersion((v) => v + 1);
  };

  const action = (r) => {
    if (!isAdmin) return null;
    if (r.status === 'Pending approval' || r.status === 'On hold') return { label: r.status === 'On hold' ? 'Decide' : 'Review', type: 'decide', primary: true };
    if (r.status === 'Approved - to reimburse' || r.status === 'Partly reimbursed') return { label: 'Reimburse', type: 'reimburse' };
    return { label: 'Correct', type: 'correct', ghost: true };
  };
  const actButton = (r) => {
    const a = action(r);
    if (!a) return null;
    return (
      <button
        type="button"
        className={`mg-btn mg-btn--sm ${a.primary ? 'mg-btn--primary' : a.ghost ? 'mg-btn--ghost' : ''}`}
        aria-label={`${a.label} ${r.claim_id}, ${r.employee_name}, ${money(r.amount_claimed)}`}
        onClick={(e) => { e.stopPropagation(); setDialog({ type: a.type, row: r }); }}
      >
        {a.label}
      </button>
    );
  };

  const columns = [
    { key: 'claim_id', header: 'Claim', className: 'nowrap', render: (r) => <><b className="mg-num">{r.claim_id}</b><span className="app-sub2">{r.submission_date ? `Submitted ${shortDate(r.submission_date)}` : 'Not submitted'}</span></> },
    {
      key: 'employee_name', header: 'Employee', className: 'nowrap',
      render: (r) => <><b>{r.employee_name}</b><span className="app-sub2"><Link className="app-link mg-num" to={`/travel/${encodeURIComponent(r.travel_id)}`}>{r.travel_id}</Link>{r.client_name ? ` · ${r.client_name}` : ''}</span></>,
    },
    { key: 'expense_category', header: 'Category', min: 130, render: (r) => <>{r.expense_category || <span className="text-muted-foreground">Uncategorised</span>}<span className="app-sub2">{r.claim_month || 'No month'}</span></> },
    {
      key: 'amount_claimed', header: 'Claimed', align: 'right',
      render: (r) => <><b>{money(r.amount_claimed)}</b><span className="app-sub2">{Number(r.amount_reimbursed) > 0 ? `${money(r.amount_reimbursed)} reimbursed` : 'nothing reimbursed'}</span></>,
    },
    { key: 'approval_status', header: 'Approval', render: (r) => { const [tone, word] = APPROVAL[r.approval_status] || ['plain', r.approval_status]; return <><Tone tone={tone}>{word}</Tone>{r.approved_by && <span className="app-sub2">by {r.approved_by}</span>}</>; } },
    { key: 'status', header: 'Status', min: 180, render: (r) => <><StateBadge map={CLAIM} value={r.status} /><span className="app-sub2 is-wrap">{nextStep(r)}</span></> },
  ];

  const fields = [
    { name: 'claim_id', label: 'Claim ID', required: true, hint: 'e.g. CLM-2026-002' },
    { name: 'travel_id', label: 'Trip', required: true, type: 'select', options: lookups.trips.map((t) => ({ value: t.travel_id, label: `${t.travel_id} — ${t.employee_name}${t.destination ? ` (${t.destination})` : ''}` })), hint: 'Name, email, PO, project and client come from the trip' },
    { name: 'expense_category', label: 'Category', type: 'select', options: lookups.expense_categories },
    { name: 'claim_month', label: 'Claim month', placeholder: 'Jul-2026' },
    { name: 'amount_claimed', label: 'Amount claimed', type: 'money', required: true },
    { name: 'submission_date', label: 'Submitted on', type: 'date' },
    // approval_status, approved_by, amount_reimbursed and reimbursement_date
    // are deliberately not here (#85). A new claim starts Submitted and is
    // decided through Review and paid through Reimburse, which check the role
    // and leave an audit row; the server refuses all four on this form, for
    // administrators too, so offering them here would only produce a 403.
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all', placeholder: 'e.g. Airport cab at both ends' },
  ];

  const waiting = (decide.total || 0) + (hold.total || 0) + (reimburse.total || 0);
  const subtitle = isAdmin
    ? waiting > 0
      ? `${count(waiting, 'claim waits', 'claims wait')} on you: ${[decide.total && `${decide.total} to decide`, hold.total && `${hold.total} on hold`, reimburse.total && `${reimburse.total} to reimburse`].filter(Boolean).join(', ')}. Each claim is made against a trip.`
      : 'Out-of-pocket costs claimed against a trip. Nothing waits on you.'
    : 'Out-of-pocket costs claimed against a trip. An admin decides and reimburses them.';

  return (
    <>
      <ListPage
        refreshToken={version}
        title="Employee expense claims"
        subtitle={subtitle}
        resource="expense-claims"
        noun="claims"
        allLabel="All claims"
        columns={columns}
        fields={fields}
        newLabel="Claim"
        formTitle="expense claim"
        formSubmitLabel="Create claim"
        formIntro="Only the claim facts are entered here; the rest is read from the trip. It lands as waiting for a decision: an admin approves it, then finance reimburses it."
        deleteTitle={(r) => `Delete claim ${r.claim_id}?`}
        deleteText={(r) => `${r.employee_name} · ${r.travel_id} · ${money(r.amount_claimed)}. This cannot be undone. The trip's claimed cost drops by ${money(r.amount_claimed)}.`}
        searchPlaceholder="Search claim, employee, trip or category"
        phoneBelow={1024}
        rowExtras={actButton}
        rowMenu={(r) => { const a = action(r); return a ? [{ label: a.label, onSelect: () => setDialog({ type: a.type, row: r }) }] : []; }}
        chips={({ filters, setFilters }) => {
          const on = (v) => filters.status === v;
          const only = (v) => setFilters(on(v) ? {} : { status: v });
          return (
            <>
              <button type="button" className="mg-chip" aria-pressed={Object.keys(filters).length === 0} onClick={() => setFilters({})}>All claims{all.total != null && <span className="mg-count">{all.total}</span>}</button>
              <button type="button" className="mg-chip" aria-pressed={on('Pending approval')} onClick={() => only('Pending approval')}>Waiting for a decision{decide.total != null && <span className="mg-count">{decide.total}</span>}</button>
              <button type="button" className="mg-chip" aria-pressed={on(TO_REIMBURSE)} onClick={() => only(TO_REIMBURSE)}>To reimburse{reimburse.total != null && <span className="mg-count">{reimburse.total}</span>}</button>
              <button type="button" className="mg-chip" aria-pressed={on('On hold')} onClick={() => only('On hold')}>On hold{hold.total != null && <span className="mg-count">{hold.total}</span>}</button>
            </>
          );
        }}
        phone={(r) => ({
          title: `${r.employee_name} · ${r.expense_category || 'Uncategorised'}`,
          amount: money(r.amount_claimed),
          meta: [r.claim_id, r.travel_id, r.claim_month, nextStep(r)].filter(Boolean).join(' · '),
          state: <StateBadge map={CLAIM} value={r.status} />,
        })}
        filters={[
          { name: 'status', label: 'Status', options: [...Object.entries(CLAIM).map(([value, [, label]]) => ({ value, label })), { value: TO_REIMBURSE, label: 'To reimburse (either)' }] },
          { name: 'approval_status', label: 'Approval', options: (lookups.enums?.approval || Object.keys(APPROVAL)).map((v) => ({ value: v, label: APPROVAL[v]?.[1] || v })) },
        ]}
        extraFilterLabels={{ travel_id: 'Trip', employee_name: 'Employee', claim_month: 'Month', project_id: 'Project' }}
      />

      {dialog?.type === 'decide' && <ClaimDecisionDialog claim={dialog.row} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.type === 'reimburse' && <ReimburseClaimDialog claim={dialog.row} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.type === 'correct' && <CorrectClaimDialog claim={dialog.row} onClose={() => setDialog(null)} onDone={refresh} />}
    </>
  );
}
