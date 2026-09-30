import { useState } from 'react';
import { ListPage } from '../components/ListPage.jsx';
import { Badge } from '../components/ui.jsx';
import { ClaimDecisionDialog, ReimburseClaimDialog } from '../components/actions.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useLookups } from '../lib/hooks.js';
import { money, date } from '../lib/format.js';

export default function ExpenseClaims() {
  const lookups = useLookups();
  // Deciding a claim and paying it are the administrator's (#85). The server
  // refuses either from anybody else; this keeps a sales user from being
  // offered a button that would only come back 403.
  const { isAdmin } = useAuth();
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);

  const refresh = () => {
    setDialog(null);
    setVersion((v) => v + 1);
  };

  const columns = [
    { key: 'claim_id', header: 'Claim', className: 'mono' },
    { key: 'employee_name', header: 'Employee', className: 'strong', render: (r) => <>{r.employee_name}<div className="small muted mono">{r.travel_id}</div></> },
    { key: 'expense_category', header: 'Category' },
    { key: 'claim_month', header: 'Month' },
    { key: 'amount_claimed', header: 'Claimed', align: 'right', render: (r) => money(r.amount_claimed) },
    { key: 'amount_reimbursed', header: 'Reimbursed', align: 'right', render: (r) => money(r.amount_reimbursed) },
    { key: 'submission_date', header: 'Submitted', render: (r) => date(r.submission_date) },
    { key: 'approval_status', header: 'Approval', render: (r) => <Badge>{r.approval_status}</Badge> },
    { key: 'status', header: 'Status', render: (r) => <Badge>{r.status}</Badge> },
    { key: 'follow_up_action', header: 'What to do', className: 'wrap small' },
    {
      key: 'act',
      header: '',
      align: 'right',
      render: (r) => (
        <div className="table__actions">
          {isAdmin && r.status === 'Pending approval' && (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => setDialog({ type: 'decide', row: r })}>Review</button>
          )}
          {isAdmin && (r.status === 'Approved - to reimburse' || r.status === 'Partly reimbursed') && (
            <button type="button" className="btn btn--sm" onClick={() => setDialog({ type: 'reimburse', row: r })}>Reimburse</button>
          )}
        </div>
      ),
    },
  ];

  const fields = [
    { name: 'claim_id', label: 'Claim ID', required: true, hint: 'e.g. CLM-2026-002' },
    { name: 'travel_id', label: 'Trip', required: true, type: 'select', options: lookups.trips.map((t) => ({ value: t.travel_id, label: `${t.travel_id} — ${t.employee_name}${t.destination ? ` (${t.destination})` : ''}` })) },
    { name: 'expense_category', label: 'Category', type: 'select', options: lookups.expense_categories },
    { name: 'claim_month', label: 'Claim month', placeholder: 'Jul-2026' },
    { name: 'amount_claimed', label: 'Amount claimed', type: 'money', required: true },
    { name: 'submission_date', label: 'Submitted on', type: 'date' },
    // approval_status, approved_by, amount_reimbursed and reimbursement_date
    // are deliberately not here (#85). A new claim starts Submitted and is
    // decided through Review and paid through Reimburse, which check the role
    // and leave an audit row; the server refuses all four on this form, for
    // administrators too, so offering them here would only produce a 403.
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];

  return (
    <>
      <ListPage
        refreshToken={version}
        title="Employee expense claims"
        subtitle="Out-of-pocket costs claimed against a trip"
        resource="expense-claims"
        columns={columns}
        fields={fields}
        newLabel="Claim"
        formTitle="expense claim"
        formIntro="Name, email, PO, project and client are all read back from the trip — only the claim facts are entered here."
        searchPlaceholder="Search claim, employee, category…"
        filters={[
          { name: 'status', label: 'Status', options: ['Pending approval', 'Approved - to reimburse', 'Partly reimbursed', 'Reimbursed', 'On hold', 'Rejected'] },
          { name: 'approval_status', label: 'Approval', options: lookups.enums?.approval || [] },
        ]}
      />

      {dialog?.type === 'decide' && <ClaimDecisionDialog claim={dialog.row} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.type === 'reimburse' && <ReimburseClaimDialog claim={dialog.row} onClose={() => setDialog(null)} onDone={refresh} />}
    </>
  );
}
