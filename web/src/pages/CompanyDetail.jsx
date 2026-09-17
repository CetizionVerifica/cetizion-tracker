import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Badge, Card, ConfirmDialog, DataTable, Empty, ErrorState, KeyValues, Modal, Select, Stat, Tabs, useToast } from '../components/ui.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { api } from '../lib/api.js';
import { invalidateLookups, useFetch, useLookups } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';

/** One client, everything the tracker knows about it, and its people. */
export default function CompanyDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const lookups = useLookups();
  const [tab, setTab] = useState('contacts');
  const [editing, setEditing] = useState(null);      // company form
  const [contact, setContact] = useState(null);      // contact form: 'new' | record
  const [removing, setRemoving] = useState(null);    // contact to delete
  const [merge, setMerge] = useState(false);
  const [into, setInto] = useState('');
  const [busy, setBusy] = useState(false);

  const { data, loading, error, refetch } = useFetch(() => api.raw(`/companies/${id}/full`), [id]);
  const c = data?.data;

  async function deleteContact() {
    setBusy(true);
    try { await api.remove('contacts', removing.id); toast('Contact removed', 'success'); setRemoving(null); refetch(); }
    catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }

  async function doMerge() {
    setBusy(true);
    try {
      const { data: r } = await api.action(`/companies/${id}/merge`, { into });
      toast(`${r.merged} merged into ${r.into}`, 'success');
      invalidateLookups();
      navigate(`/companies/${into}`);
    } catch (err) { toast(err.message, 'danger'); setBusy(false); }
  }

  if (error) return <><PageHeader title="Company" /><div className="page"><ErrorState message={error} onRetry={refetch} /></div></>;
  if (loading || !c) return <><PageHeader title="Company" /><div className="page"><div className="skeleton" style={{ height: 200 }} /></div></>;

  const tabs = [
    { key: 'contacts', label: `Contacts (${c.contacts.length})` },
    { key: 'enquiries', label: `Enquiries (${c.enquiries.length})` },
    { key: 'quotations', label: `Quotations (${c.quotations.length})` },
    { key: 'projects', label: `Projects (${c.projects.length})` },
    { key: 'pos', label: `Purchase orders (${c.purchase_orders.length})` },
  ];

  const contactFields = [
    { name: 'company_id', type: 'hidden', default: c.id },
    { name: 'name', label: 'Name', required: true },
    { name: 'role', label: 'Role' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'phone', label: 'Phone' },
    { name: 'is_billing', label: 'Billing contact', type: 'boolean', hint: 'Receives payment reminders', default: 'false' },
    { name: 'opt_out_reminders', label: 'Automatic reminders', type: 'boolean', trueLabel: 'Never send', falseLabel: 'Allowed', default: 'false' },
    { name: 'notes', label: 'Notes', type: 'textarea', span: 'all' },
  ];
  const companyFields = [
    { name: 'name', label: 'Company name', required: true, span: 2, hint: 'Renaming here renames the client on every record' },
    { name: 'sector', label: 'Sector', type: 'combo', options: lookups.sectors },
    { name: 'city', label: 'City' },
    { name: 'gstin', label: 'GSTIN' },
    { name: 'website', label: 'Website' },
    { name: 'address', label: 'Address', type: 'textarea', span: 'all' },
    { name: 'notes', label: 'Notes', type: 'textarea', span: 'all' },
  ];

  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={[c.sector, c.city, c.gstin && `GSTIN ${c.gstin}`].filter(Boolean).join(' · ') || 'No sector or city yet'}
        actions={
          <>
            <Link className="btn" to="/companies">All companies</Link>
            <button type="button" className="btn" onClick={() => setMerge(true)}>Merge into…</button>
            <button type="button" className="btn btn--primary" onClick={() => setEditing(c)}>Edit</button>
          </>
        }
      />
      <div className="page stack">
        <div className="grid grid--stats">
          <Stat label="Enquiries" value={c.enquiries.length} />
          <Stat label="Quotations" value={c.quotations.length} meta={`${c.won_quotations} won`} />
          <Stat label="Projects" value={c.projects.length} />
          <Stat label="PO value (INR)" value={money(c.po_value_inr)} />
          <Stat label="Outstanding" value={money(c.outstanding)} tone={c.outstanding > 0 ? 'warn' : ''} />
        </div>

        {(c.website || c.address || c.notes) && (
          <Card title="Details">
            <KeyValues items={[
              c.website && { label: 'Website', value: <a href={/^https?:/.test(c.website) ? c.website : `https://${c.website}`} target="_blank" rel="noopener noreferrer">{c.website}</a> },
              c.address && { label: 'Address', value: c.address },
              c.notes && { label: 'Notes', value: c.notes },
            ].filter(Boolean)} />
          </Card>
        )}

        <Tabs tabs={tabs} active={tab} onChange={setTab} />

        {tab === 'contacts' && (
          <Card flush title="Contacts" hint="The people at this client. A contact is created whenever a name is typed on a quotation or enquiry." actions={<button type="button" className="btn btn--primary btn--sm" onClick={() => setContact('new')}>+ Contact</button>}>
            <DataTable
              rows={c.contacts}
              columns={[
                { key: 'name', header: 'Name', className: 'strong', render: (r) => <>{r.name}{r.role && <div className="small muted">{r.role}</div>}</> },
                { key: 'email', header: 'Email', render: (r) => r.email ? <a href={`mailto:${r.email}`}>{r.email}</a> : <span className="muted">—</span> },
                { key: 'phone', header: 'Phone', render: (r) => r.phone || <span className="muted">—</span> },
                { key: 'flags', header: '', render: (r) => <>{r.is_billing && <Badge tone="info">billing</Badge>} {r.opt_out_reminders && <Badge tone="warning">no reminders</Badge>}</> },
                { key: 'notes', header: 'Notes', className: 'wrap small muted' },
                { key: 'act', header: '', align: 'right', render: (r) => <div className="table__actions"><button type="button" className="btn btn--sm btn--ghost" onClick={() => setContact(r)}>Edit</button><button type="button" className="btn btn--sm btn--ghost" onClick={() => setRemoving(r)}>✕</button></div> },
              ]}
              empty={<Empty title="No contacts yet" text="Add the people you deal with here, with their email and phone." action={<button type="button" className="btn btn--primary" onClick={() => setContact('new')}>+ Contact</button>} />}
            />
          </Card>
        )}
        {tab === 'enquiries' && (
          <Card flush title="Enquiries">
            <DataTable rows={c.enquiries} onRowClick={(r) => navigate(`/enquiries?q=${encodeURIComponent(r.enquiry_no)}`)} columns={[
              { key: 'enquiry_no', header: 'Enquiry', className: 'mono' },
              { key: 'enquiry_date', header: 'Date', render: (r) => date(r.enquiry_date) },
              { key: 'service', header: 'Service', className: 'wrap' },
              { key: 'sales_person', header: 'Sales person' },
              { key: 'status', header: 'Status', render: (r) => <Badge>{r.status}</Badge> },
              { key: 'quotation_no', header: 'Quotation', className: 'mono' },
            ]} empty={<Empty title="No enquiries" />} />
          </Card>
        )}
        {tab === 'quotations' && (
          <Card flush title="Quotations">
            <DataTable rows={c.quotations} onRowClick={(r) => navigate(`/quotations?q=${encodeURIComponent(r.quotation_no)}`)} columns={[
              { key: 'quotation_no', header: 'Quotation', className: 'mono' },
              { key: 'quotation_date', header: 'Date', render: (r) => date(r.quotation_date) },
              { key: 'service_quoted', header: 'Service', className: 'wrap' },
              { key: 'contact_person', header: 'Contact' },
              { key: 'quotation_value', header: 'Value', align: 'right', render: (r) => money(r.quotation_value, r.currency) },
              { key: 'status', header: 'Status', render: (r) => <Badge>{r.status}</Badge> },
              { key: 'payment_status', header: 'Payment', render: (r) => <Badge>{r.payment_status}</Badge> },
            ]} empty={<Empty title="No quotations" />} />
          </Card>
        )}
        {tab === 'projects' && (
          <Card flush title="Projects">
            <DataTable rows={c.projects} onRowClick={(r) => navigate(`/projects/${encodeURIComponent(r.project_id)}`)} columns={[
              { key: 'project_id', header: 'Project', className: 'mono' },
              { key: 'primary_service', header: 'Service', className: 'wrap' },
              { key: 'project_manager', header: 'Manager' },
              { key: 'project_stage', header: 'Stage', render: (r) => <Badge>{r.project_stage}</Badge> },
              { key: 'payment_status', header: 'Payment', render: (r) => <Badge>{r.payment_status}</Badge> },
            ]} empty={<Empty title="No projects" />} />
          </Card>
        )}
        {tab === 'pos' && (
          <Card flush title="Purchase orders">
            <DataTable rows={c.purchase_orders} onRowClick={(r) => navigate(`/purchase-orders/${encodeURIComponent(r.po_number)}`)} columns={[
              { key: 'po_number', header: 'PO', className: 'mono' },
              { key: 'project_id', header: 'Project', className: 'mono small' },
              { key: 'po_date', header: 'Date', render: (r) => date(r.po_date) },
              { key: 'po_value', header: 'Value', align: 'right', render: (r) => money(r.po_value, r.currency) },
              { key: 'total_received', header: 'Received', align: 'right', render: (r) => money(r.total_received, r.currency) },
              { key: 'payment_status', header: 'Payment', render: (r) => <Badge>{r.payment_status}</Badge> },
            ]} empty={<Empty title="No purchase orders" />} />
          </Card>
        )}
      </div>

      {editing && (
        <RecordForm title="Edit company" resource="companies" fields={companyFields} record={editing} onClose={() => setEditing(null)} onSaved={() => { invalidateLookups(); refetch(); }} />
      )}
      {contact && (
        <RecordForm
          title={contact === 'new' ? 'New contact' : 'Edit contact'}
          subtitle={c.name}
          resource="contacts"
          fields={contactFields}
          record={contact === 'new' ? null : contact}
          onClose={() => setContact(null)}
          onSaved={() => refetch()}
        />
      )}
      {removing && (
        <ConfirmDialog title={`Remove ${removing.name}?`} message="Quotations and enquiries that named this person keep the name as text." onConfirm={deleteContact} onClose={() => setRemoving(null)} busy={busy} confirmLabel="Remove" />
      )}
      {merge && (
        <Modal
          title={`Merge ${c.name} into another company`}
          subtitle="Everything here moves to the company you pick and takes its name; this one is deleted."
          onClose={() => setMerge(false)}
          footer={<><button type="button" className="btn" onClick={() => setMerge(false)}>Cancel</button><button type="button" className="btn btn--primary" disabled={!into || busy} onClick={doMerge}>{busy ? 'Merging…' : 'Merge'}</button></>}
        >
          <Select value={into} placeholder="Pick the company that stays" options={lookups.companies.filter((o) => o.id !== c.id).map((o) => ({ value: String(o.id), label: o.name }))} onChange={(e) => setInto(e.target.value)} />
        </Modal>
      )}
    </>
  );
}
