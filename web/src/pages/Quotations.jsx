import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ListPage } from '../components/ListPage.jsx';
import { Badge, DocumentLink } from '../components/ui.jsx';
import { ConvertQuotationDialog } from '../components/actions.jsx';
import { invalidateLookups, useLookups } from '../lib/hooks.js';
import { money, date } from '../lib/format.js';

/** The quotation form, shared with the quotation page. */
export function quotationFields(lookups) {
  return [
    { name: 'quotation_no', label: 'Quotation number', auto: 'quotation' },
    { name: 'quotation_date', label: 'Quotation date', type: 'date' },
    { name: 'valid_until', label: 'Valid until', type: 'date', hint: 'Blank: set from the validity days in Settings' },
    { name: 'client_name', label: 'Client', required: true, type: 'combo', options: lookups.clients, hint: 'One spelling per client; new names create a company' },
    { name: 'sector', label: 'Sector', type: 'combo', options: lookups.sectors, hint: 'Pick from the list, or type a new sector' },
    { name: 'country', label: 'Country', type: 'combo', options: ['India', 'United Arab Emirates', 'Singapore', 'United Kingdom', 'United States'] },
    { name: 'contact_person', label: 'Contact person' },
    // The address lives on the contact, and until now there was nowhere to
    // type it: the contact this name creates held a name and nothing else,
    // so sending the quotation, chasing payment, the portal and mailbox
    // matching all had nobody to reach (docs/client-data-gaps.md, gap 1).
    { name: 'contact_email', label: 'Contact email', type: 'email', hint: 'Saved on the contact. Used to send the quotation and to chase payment' },
    { name: 'contact_phone', label: 'Contact phone' },
    { name: 'service_quoted', label: 'Service quoted', type: 'combo', options: lookups.services, span: 2, hint: 'The subject line; price it on the quotation page as lines' },
    { name: 'sales_person', label: 'Sales person', type: 'combo', options: lookups.sales_people },
    { name: 'sales_person_email', label: 'Sales person email', type: 'email' },
    { name: 'quotation_value', label: 'Quotation value', type: 'money', hint: 'Replaced by the line total once lines are added' },
    { name: 'currency', label: 'Currency', type: 'select', options: lookups.enums?.currency || ['INR'], default: 'INR' },
    { name: 'status', label: 'Status', type: 'select', options: lookups.enums?.quotation || [], default: 'Submitted', required: true },
    { name: 'po_received', label: 'PO received', type: 'boolean', default: 'false' },
    { name: 'project_id', label: 'Project ID', type: 'combo', options: lookups.projects.map((p) => p.project_id), hint: 'Leave blank until the project is registered' },
    { name: 'place_of_supply_state', label: 'Place of supply (state)' },
    { name: 'printed_no', label: 'Printed number', hint: 'The number on the PDF sent, if not the one above. A PO that quotes it finds this quotation' },
    { name: 'document_id', label: 'Signed / client copy', type: 'document', owner: 'quotations', maxBytes: lookups.limits?.document_max_bytes, span: 2 },
    { name: 'terms', label: 'Terms', type: 'textarea', span: 'all', hint: 'Printed on the PDF. Blank: the default terms from Settings' },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];
}

export default function Quotations() {
  const lookups = useLookups();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [converting, setConverting] = useState(null);
  const [version, setVersion] = useState(0);

  const columns = [
    { key: 'quotation_no', header: 'Quotation', className: 'mono', render: (r) => <>{r.quotation_no}{r.revision > 0 && <span className="small muted"> R{r.revision}</span>}<div className="small muted">{date(r.quotation_date)}{r.expired && <> · <span style={{ color: 'var(--late)' }}>expired</span></>}</div></> },
    { key: 'client_name', header: 'Client', className: 'strong', render: (r) => <>{r.client_name}{r.contact_person && <div className="small muted">{r.contact_person}</div>}</> },
    { key: 'sector', header: 'Sector' },
    { key: 'service_quoted', header: 'Service', className: 'wrap' },
    { key: 'sales_person', header: 'Owner' },
    { key: 'quotation_value', header: 'Value', align: 'right', render: (r) => money(r.quotation_value, r.currency) },
    { key: 'status', header: 'Status', render: (r) => <>{<Badge>{r.status}</Badge>}{r.approval_status === 'pending' && <div><Badge tone="warning">approval</Badge></div>}{r.approval_status === 'rejected' && <div><Badge tone="danger">rejected</Badge></div>}</> },
    {
      key: 'project_id',
      header: 'Project',
      render: (r) =>
        r.project_id ? (
          <Link className="mono" to={`/projects/${r.project_id}`}>{r.project_id}</Link>
        ) : r.status === 'Won - PO Received' ? (
          <button type="button" className="btn btn--sm" onClick={() => setConverting(r)}>
            Register
          </button>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { key: 'outstanding', header: 'Outstanding', align: 'right', render: (r) => (r.project_id ? money(r.outstanding) : <span className="muted">—</span>) },
    { key: 'payment_status', header: 'Payment', render: (r) => (r.payment_status ? <Badge>{r.payment_status}</Badge> : <span className="muted">—</span>) },
    { key: 'document_id', header: 'Document', render: (r) => <DocumentLink id={r.document_id} name={r.document_name} /> },
  ];

  const fields = quotationFields(lookups);

  return (
    <>
      <ListPage
        refreshToken={version}
        title="Deals"
        subtitle="Every enquiry quoted, and what happened to it"
        resource="quotations"
        columns={columns}
        fields={fields}
        onRowClick={(r) => navigate(`/quotations/${encodeURIComponent(r.quotation_no)}`)}
        newLabel="Quotation"
        formTitle="quotation"
        searchPlaceholder="Search client, quotation no, service, sector…"
        // The sales report links here with the filters behind a figure
        // (e.g. ?status=Won - PO Received&sector=__none__&from=&to=), so the
        // list shows exactly the quotations that figure counts.
        initialFilters={Object.fromEntries(
          // Insights adds the month a deal is expected to close, the month it
          // was quoted (Reports' quoted-vs-won bars) and one owner's records.
          ['status', 'sector', 'sales_person', 'from', 'to', 'close_month', 'month', 'owner', 'from_email'].map((key) => [key, params.get(key)]).filter(([, value]) => value)
        )}
        dateFilterLabel="Quotation date"
        // A saved quotation can change the lists other forms offer (won
        // quotations for a PO, existing ones for an enquiry).
        onSaved={() => invalidateLookups()}
        // An enquiry links here with ?q=<quotation no> to show its quotation.
        initialSearch={params.get('q') || undefined}
        filters={[
          { name: 'status', label: 'Status', options: lookups.enums?.quotation || [] },
          // Reports links a pipeline bar here as ?stage_id=N, and a stage is
          // how the board already talks about a deal.
          { name: 'stage_id', label: 'Stage', options: (lookups.pipeline_stages || []).map((s) => ({ value: String(s.id), label: s.name })) },
          { name: 'sector', label: 'Sector', options: [{ value: '__none__', label: 'Not set' }, ...lookups.sectors] },
          { name: 'sales_person', label: 'Owner', options: [{ value: '__none__', label: 'Not set' }, ...lookups.sales_people] },
          { name: 'quotation_value', label: 'Value', options: [{ value: '__none__', label: 'Not set' }, { value: '__any__', label: 'Set' }] },
          // Insights links its overdue-follow-up bars here; worked out by the
          // follow-up rules on the server, not a column.
          { name: 'follow_up', label: 'Follow-up', options: [{ value: 'overdue', label: 'Overdue' }] },
          // Quotations read from the PDF we emailed (docs/email-enquiries.md).
          { name: 'from_email', label: 'Read from email', options: [{ value: '1', label: 'Read from email' }] },
          { name: 'overdue_days', label: 'Overdue by', options: [{ value: '0-3', label: 'Up to 3 days' }, { value: '4-7', label: '4–7 days' }, { value: '8-14', label: '8–14 days' }, { value: '15+', label: '15 days or more' }] },
        ]}
      />

      {converting && (
        <ConvertQuotationDialog
          quotation={converting}
          onClose={() => setConverting(null)}
          onDone={() => {
            setConverting(null);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </>
  );
}
