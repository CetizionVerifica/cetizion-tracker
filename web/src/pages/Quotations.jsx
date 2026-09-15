import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ListPage } from '../components/ListPage.jsx';
import { Badge, DocumentLink } from '../components/ui.jsx';
import { ConvertQuotationDialog } from '../components/actions.jsx';
import { invalidateLookups, useLookups } from '../lib/hooks.js';
import { money, date } from '../lib/format.js';

export default function Quotations() {
  const lookups = useLookups();
  const [params] = useSearchParams();
  const [converting, setConverting] = useState(null);
  const [version, setVersion] = useState(0);

  const columns = [
    { key: 'quotation_no', header: 'Quotation', className: 'mono', render: (r) => <>{r.quotation_no}<div className="small muted">{date(r.quotation_date)}</div></> },
    { key: 'client_name', header: 'Client', className: 'strong', render: (r) => <>{r.client_name}{r.contact_person && <div className="small muted">{r.contact_person}</div>}</> },
    { key: 'sector', header: 'Sector' },
    { key: 'service_quoted', header: 'Service', className: 'wrap' },
    { key: 'sales_person', header: 'Owner' },
    { key: 'quotation_value', header: 'Value', align: 'right', render: (r) => money(r.quotation_value, r.currency) },
    { key: 'status', header: 'Status', render: (r) => <Badge>{r.status}</Badge> },
    {
      key: 'project_id',
      header: 'Project',
      render: (r) =>
        r.project_id ? (
          <Link className="mono" to={`/projects/${r.project_id}`}>{r.project_id}</Link>
        ) : r.status === 'Won - PO Received' ? (
          <button type="button" className="btn btn--sm btn--primary" onClick={() => setConverting(r)}>
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

  const fields = [
    { name: 'quotation_no', label: 'Quotation number', auto: 'quotation' },
    { name: 'quotation_date', label: 'Quotation date', type: 'date' },
    { name: 'client_name', label: 'Client', required: true, type: 'combo', options: lookups.clients, hint: 'Reports treat the same spelling as the same client' },
    { name: 'sector', label: 'Sector', type: 'combo', options: lookups.sectors, hint: 'Pick from the list, or type a new sector' },
    { name: 'contact_person', label: 'Contact person' },
    { name: 'service_quoted', label: 'Service quoted', type: 'combo', options: lookups.services, span: 2 },
    { name: 'sales_person', label: 'Sales person', type: 'combo', options: lookups.sales_people },
    { name: 'sales_person_email', label: 'Sales person email', type: 'email' },
    { name: 'quotation_value', label: 'Quotation value', type: 'money' },
    { name: 'currency', label: 'Currency', type: 'select', options: lookups.enums?.currency || ['INR'], default: 'INR' },
    { name: 'status', label: 'Status', type: 'select', options: lookups.enums?.quotation || [], default: 'Submitted', required: true },
    { name: 'po_received', label: 'PO received', type: 'boolean', default: 'false' },
    { name: 'project_id', label: 'Project ID', type: 'combo', options: lookups.projects.map((p) => p.project_id), hint: 'Leave blank until the project is registered' },
    { name: 'document_id', label: 'Quotation document', type: 'document', owner: 'quotations', maxBytes: lookups.limits?.document_max_bytes, span: 2 },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];

  return (
    <>
      <ListPage
        refreshToken={version}
        title="Quotations"
        subtitle="Every enquiry quoted, and what happened to it"
        resource="quotations"
        columns={columns}
        fields={fields}
        newLabel="Quotation"
        formTitle="quotation"
        searchPlaceholder="Search client, quotation no, service, sector…"
        // The sales report links here with the filters behind a figure
        // (e.g. ?status=Won - PO Received&sector=__none__&from=&to=), so the
        // list shows exactly the quotations that figure counts.
        initialFilters={Object.fromEntries(
          ['status', 'sector', 'sales_person', 'from', 'to'].map((key) => [key, params.get(key)]).filter(([, value]) => value)
        )}
        dateFilterLabel="Quotation date"
        // A saved quotation can change the lists other forms offer (won
        // quotations for a PO, existing ones for an enquiry).
        onSaved={() => invalidateLookups()}
        // An enquiry links here with ?q=<quotation no> to show its quotation.
        initialSearch={params.get('q') || undefined}
        filters={[
          { name: 'status', label: 'Status', options: lookups.enums?.quotation || [] },
          { name: 'sector', label: 'Sector', options: [{ value: '__none__', label: 'Not set' }, ...lookups.sectors] },
          { name: 'sales_person', label: 'Owner', options: lookups.sales_people },
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
