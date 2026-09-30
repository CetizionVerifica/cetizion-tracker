import { Link, useSearchParams } from 'react-router-dom';
import { ListPage } from '../components/ListPage.jsx';
import { Alert, Badge, useToast } from '../components/ui.jsx';
import { invalidateLookups, useLookups } from '../lib/hooks.js';
import { date, money, today } from '../lib/format.js';

/**
 * Enquiries as leads (#24): where they come from, how they are qualified,
 * when to follow up, and why one was dropped. Converted creates the
 * quotation with the estimate carried across, or links one that exists.
 */
const CONVERTED = 'Converted';
const STATUSES = ['New', 'Contacted', 'Qualified', 'Nurture', CONVERTED, 'Unqualified'];
const OPEN = ['New', 'Contacted', 'Qualified', 'Nurture'];
const SECTORS = ['Agriculture', 'Metal Industry', 'Pharmaceutical', 'Other'];

export default function Enquiries() {
  const lookups = useLookups();
  const toast = useToast();
  const [params] = useSearchParams();
  const statuses = lookups.enums?.enquiry || STATUSES;
  const sectors = lookups.sectors.length ? lookups.sectors : SECTORS;
  const responseHours = Number(lookups.settings?.lead_first_response_hours || 24);
  // Worked out from the rows the list already loaded, not a second request.
  const attention = (rows) => ({
    dueRows: rows.filter((e) => OPEN.includes(e.status) && e.next_follow_up_at && e.next_follow_up_at <= today()),
    late: rows.filter((e) => e.status === 'New' && (Date.now() - new Date(e.created_at).getTime()) / 36e5 > responseHours),
  });

  const columns = [
    { key: 'enquiry_no', header: 'Enquiry', className: 'mono', render: (r) => <>{r.enquiry_no}<div className="small muted">{date(r.enquiry_date)}</div></> },
    { key: 'client_name', header: 'Client', className: 'strong', render: (r) => <>{r.company_id ? <Link to={`/companies/${r.company_id}`}>{r.client_name}</Link> : r.client_name}{r.contact_person && <div className="small muted">{r.contact_person}</div>}</> },
    { key: 'source', header: 'Source', render: (r) => lookups.lead_sources.find((s) => s.id === r.source_id)?.name || <span className="muted">—</span> },
    { key: 'service', header: 'Interested in', className: 'wrap', render: (r) => r.service || r.services_interested || <span className="muted">—</span> },
    { key: 'estimated_value', header: 'Estimate', align: 'right', render: (r) => (r.estimated_value ? money(r.estimated_value, r.currency) : <span className="muted">—</span>) },
    { key: 'sales_person', header: 'Owner', render: (r) => r.sales_person ?? <span className="muted">—</span> },
    { key: 'status', header: 'Status', render: (r) => <><Badge tone={r.status === 'Unqualified' ? 'danger' : r.status === CONVERTED ? 'success' : r.status === 'New' ? 'warning' : 'info'}>{r.status}</Badge>{r.status === 'Unqualified' && r.unqualified_reason_id && <div className="small muted">{lookups.lost_reasons.find((x) => x.id === r.unqualified_reason_id)?.name}</div>}</> },
    { key: 'next_follow_up_at', header: 'Next follow-up', render: (r) => r.next_follow_up_at ? <span style={{ color: r.next_follow_up_at <= today() && OPEN.includes(r.status) ? 'var(--danger-fg)' : undefined }}>{date(r.next_follow_up_at)}</span> : <span className="muted">—</span> },
    { key: 'expected_decision_date', header: 'Decision by', render: (r) => date(r.expected_decision_date) },
    {
      key: 'quotation_no', header: 'Quotation',
      render: (r) => r.quotation_no ? <Link className="mono" to={`/quotations/${encodeURIComponent(r.quotation_no)}`}>{r.quotation_no}</Link> : <span className="muted">—</span>,
    },
  ];

  const fields = (record) => [
    { name: 'enquiry_no', label: 'Enquiry number', auto: 'enquiry' },
    { name: 'enquiry_date', label: 'Enquiry date', type: 'date', default: today() },
    { name: 'client_name', label: 'Client', required: true, type: 'combo', options: lookups.clients, hint: 'One spelling per client; a new name creates a company' },
    { name: 'source', label: 'Enquiry source', hint: 'How the enquiry reached us, such as referral, website, email or event' },
    { name: 'sector', label: 'Sector', type: 'combo', options: sectors },
    { name: 'country', label: 'Country', type: 'combo', options: ['India', 'United Arab Emirates', 'Singapore', 'United Kingdom', 'United States'] },

    { name: 'contact_person', label: 'Contact person' },
    // The address lives on the contact, and until now there was nowhere to
    // type it: the contact this name creates held a name and nothing else,
    // so sending the quotation, chasing payment, the portal and mailbox
    // matching all had nobody to reach (docs/client-data-gaps.md, gap 1).
    { name: 'contact_email', label: 'Contact email', type: 'email', hint: 'Saved on the contact. Used to send the quotation and to chase payment' },
    { name: 'contact_phone', label: 'Contact phone' },
    { name: 'source_id', label: 'Source', type: 'select', options: lookups.lead_sources.map((s) => ({ value: String(s.id), label: s.name })), hint: 'Where this enquiry came from' },
    { name: 'service', label: 'Service asked for', type: 'combo', options: lookups.services },
    { name: 'services_interested', label: 'Other services of interest' },
    { name: 'estimated_value', label: 'Estimated value', type: 'money', hint: 'Carried onto the quotation when converted' },
    { name: 'currency', label: 'Currency', type: 'select', options: lookups.enums?.currency || ['INR'], default: 'INR' },
    { name: 'sales_person', label: 'Owner', type: 'combo', options: lookups.sales_people },
    { name: 'sales_person_email', label: 'Owner email', type: 'email' },
    { name: 'status', label: 'Status', type: 'select', options: statuses, default: 'New', required: true, hint: `Leaving New needs a source and the client; Qualified and "${CONVERTED}" need the services and an estimated value; Unqualified needs a reason. "${CONVERTED}" creates a draft quotation, a line per service, unless one is linked` },
    { name: 'next_follow_up_at', label: 'Next follow-up', type: 'date', hint: 'Blank: set from Settings when the status changes' },
    { name: 'expected_decision_date', label: 'Expected decision', type: 'date' },
    { name: 'unqualified_reason_id', label: 'Reason, if unqualified', type: 'select', options: lookups.lost_reasons.map((r) => ({ value: String(r.id), label: r.name })) },
    { name: 'unqualified_notes', label: 'Notes on that', span: 2 },
    {
      name: 'quotation_no', label: 'Existing quotation', type: 'select', span: 2,
      hint: 'For an enquiry that was already quoted: link that quotation instead of creating a new one',
      options: [
        ...(record?.quotation_no && !lookups.quotations.some((q) => q.quotation_no === record.quotation_no) ? [{ value: record.quotation_no, label: record.quotation_no }] : []),
        ...lookups.quotations.map((q) => ({ value: q.quotation_no, label: `${q.quotation_no} — ${q.client_name} (${q.status})` })),
      ],
    },
    { name: 'notes', label: 'Notes', type: 'textarea', span: 'all' },
  ];

  return (
    <ListPage
      title="Enquiries"
      subtitle="Every lead, from first contact to quotation: source, owner, next follow-up, and what happened"
      resource="enquiries"
      columns={columns}
      fields={fields}
      newLabel="Enquiry"
      formTitle="enquiry"
      formIntro={`New → Contacted → Qualified → ${CONVERTED}. Set "${CONVERTED}" and a quotation is created with these details, or link one that exists. Drop a lead with "Unqualified" and a reason; "Nurture" parks it for later.`}
      searchPlaceholder="Search client, enquiry no, service, sector…"
      initialFilters={Object.fromEntries(['status', 'sector', 'sales_person', 'source_id', 'from', 'to'].map((k) => [k, params.get(k)]).filter(([, v]) => v))}
      initialSearch={params.get('q') || undefined}
      dateFilterLabel="Enquiry date"
      onSaved={(saved) => {
        invalidateLookups();
        if (saved?.quotation_created) toast(`Quotation ${saved.quotation_created} created`, 'success');
      }}
      filters={[
        { name: 'status', label: 'Status', options: statuses },
        { name: 'source_id', label: 'Source', options: lookups.lead_sources.map((s) => ({ value: String(s.id), label: s.name })) },
        { name: 'sector', label: 'Sector', options: [{ value: '__none__', label: 'Not set' }, ...sectors] },
        { name: 'sales_person', label: 'Owner', options: lookups.sales_people },
      ]}
      banner={(rows) => { const { dueRows, late } = attention(rows); return (dueRows.length > 0 || late.length > 0) && (
        <Alert tone="warning">
          <span>
            {dueRows.length > 0 && <><strong>{dueRows.length} follow-up{dueRows.length === 1 ? '' : 's'} due:</strong> {dueRows.slice(0, 6).map((e) => `${e.client_name} (${date(e.next_follow_up_at)})`).join(', ')}{dueRows.length > 6 ? ` and ${dueRows.length - 6} more` : ''}. </>}
            {late.length > 0 && <><strong>{late.length} new enquir{late.length === 1 ? 'y has' : 'ies have'} waited over {responseHours} hours</strong> for a first contact: {late.slice(0, 4).map((e) => e.client_name).join(', ')}.</>}
          </span>
        </Alert>
      ); }}
    />
  );
}
