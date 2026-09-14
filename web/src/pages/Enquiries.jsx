import { Link } from 'react-router-dom';
import { ListPage } from '../components/ListPage.jsx';
import { Badge, useToast } from '../components/ui.jsx';
import { useLookups } from '../lib/hooks.js';
import { date } from '../lib/format.js';

const WON = 'Won - Quotation Sent';
// Used until lookups arrive, so the dropdowns are never empty.
const STATUSES = ['In Progress', 'Declined', WON];
const SECTORS = ['Agriculture', 'Metal Industry', 'Pharmaceutical', 'Other'];

export default function Enquiries() {
  const lookups = useLookups();
  const toast = useToast();
  const statuses = lookups.enums?.enquiry || STATUSES;
  const sectors = lookups.sectors.length ? lookups.sectors : SECTORS;

  const columns = [
    { key: 'enquiry_no', header: 'Enquiry', className: 'mono', render: (r) => <>{r.enquiry_no}<div className="small muted">{date(r.enquiry_date)}</div></> },
    { key: 'client_name', header: 'Client', className: 'strong', render: (r) => <>{r.client_name}{r.contact_person && <div className="small muted">{r.contact_person}</div>}</> },
    { key: 'sector', header: 'Sector' },
    { key: 'service', header: 'Service', className: 'wrap' },
    { key: 'sales_person', header: 'Sales person', render: (r) => <>{r.sales_person ?? <span className="muted">—</span>}{r.sales_person_email && <div className="small muted">{r.sales_person_email}</div>}</> },
    { key: 'status', header: 'Status', render: (r) => <Badge>{r.status}</Badge> },
    {
      key: 'quotation_no',
      header: 'Quotation',
      render: (r) =>
        r.quotation_no ? (
          <Link className="mono" to={`/quotations?q=${encodeURIComponent(r.quotation_no)}`}>{r.quotation_no}</Link>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ];

  const fields = [
    { name: 'enquiry_no', label: 'Enquiry number', required: true, hint: 'e.g. CTZ/ENQ/2026/001' },
    { name: 'enquiry_date', label: 'Enquiry date', type: 'date' },
    { name: 'client_name', label: 'Client', required: true, type: 'combo', options: lookups.clients, hint: 'Reports treat the same spelling as the same client' },
    { name: 'sector', label: 'Sector', type: 'combo', options: sectors, hint: 'Pick from the list, or type a new sector' },
    { name: 'contact_person', label: 'Contact person' },
    { name: 'service', label: 'Service', type: 'combo', options: lookups.services },
    { name: 'sales_person', label: 'Sales person', type: 'combo', options: lookups.sales_people },
    { name: 'sales_person_email', label: 'Sales person email', type: 'email' },
    { name: 'status', label: 'Status', type: 'select', options: statuses, default: 'In Progress', required: true, hint: `"${WON}" creates the quotation` },
  ];

  return (
    <ListPage
      title="Enquiries"
      subtitle="Every enquiry received, before it is quoted"
      resource="enquiries"
      columns={columns}
      fields={fields}
      newLabel="Enquiry"
      formTitle="enquiry"
      formIntro={`Set the status to "${WON}" and a quotation is created under Quotations with these details.`}
      searchPlaceholder="Search client, enquiry no, service, sector…"
      onSaved={(saved, previous) => {
        if (saved?.quotation_no && saved.quotation_no !== previous?.quotation_no) {
          toast(`Quotation ${saved.quotation_no} created`, 'success');
        }
      }}
      filters={[
        { name: 'status', label: 'Status', options: statuses },
        { name: 'sector', label: 'Sector', options: [{ value: '__none__', label: 'Not set' }, ...sectors] },
        { name: 'sales_person', label: 'Sales person', options: lookups.sales_people },
      ]}
    />
  );
}
