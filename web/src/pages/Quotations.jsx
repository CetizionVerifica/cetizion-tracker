import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FileCheck2, FolderPlus } from 'lucide-react';
import { ListPage } from '../components/ListPage.jsx';
import { ConvertQuotationDialog } from '../components/actions.jsx';
import { SalesViews, SummaryStrip, Tone, useTotal } from '../components/sales.jsx';
import { api } from '../lib/api.js';
import { invalidateLookups, useFetch, useLookups } from '../lib/hooks.js';
import { money, date } from '../lib/format.js';

/** The open statuses, as one filter value: "Open (all but won and lost)". */
export const OPEN_DEALS = 'Draft,Submitted,Under Negotiation,On Hold';

/** A deal's status as a badge in the system's tones; the word is the state. */
export function dealTone(status, expired) {
  if (expired || /lost/i.test(status || '')) return 'late';
  if (/won/i.test(status || '')) return 'ok';
  if (/hold/i.test(status || '')) return 'wait';
  if (/draft/i.test(status || '')) return 'plain';
  return 'info';
}

/**
 * The quotation form, shared with the deal page. Grouped as the canvas
 * draws it; the edit form adds the pipeline facts the board shows
 * (probability, expected close, next step), so the deal page's Details
 * "Change" has somewhere to go. The stage itself moves on the board.
 */
export function quotationFields(lookups, { edit = false } = {}) {
  return [
    { group: 'The quotation', name: 'quotation_no', label: 'Quotation number', auto: 'quotation' },
    { group: 'The quotation', name: 'quotation_date', label: 'Quotation date', type: 'date' },
    { group: 'The quotation', name: 'valid_until', label: 'Valid until', type: 'date', hint: 'Blank: set from the validity days in Settings' },
    { group: 'The quotation', name: 'status', label: 'Status', type: 'select', options: lookups.enums?.quotation || [], default: 'Submitted', required: true, hint: 'To mark a deal lost, use Mark as lost on the deal page: it asks why' },
    { group: 'Client', name: 'client_name', label: 'Client', required: true, type: 'combo', options: lookups.clients, hint: 'One spelling per client; new names create a company' },
    { group: 'Client', name: 'sector', label: 'Sector', type: 'combo', options: lookups.sectors, hint: 'Pick from the list, or type a new sector' },
    { group: 'Client', name: 'country', label: 'Country', type: 'combo', options: ['India', 'United Arab Emirates', 'Singapore', 'United Kingdom', 'United States'] },
    { group: 'Client', name: 'contact_person', label: 'Contact person' },
    // The address lives on the contact, and until now there was nowhere to
    // type it: the contact this name creates held a name and nothing else,
    // so sending the quotation, chasing payment, the portal and mailbox
    // matching all had nobody to reach (docs/client-data-gaps.md, gap 1).
    { group: 'Client', name: 'contact_email', label: 'Contact email', type: 'email', hint: 'Saved on the contact. Used to send the quotation and to chase payment' },
    { group: 'Client', name: 'contact_phone', label: 'Contact phone' },
    { group: 'What is quoted', name: 'service_quoted', label: 'Service quoted', type: 'combo', options: lookups.services, span: 'all', hint: 'The subject line; price it on the deal page as lines' },
    { group: 'What is quoted', name: 'sales_person', label: 'Owner', type: 'combo', options: lookups.sales_people },
    { group: 'What is quoted', name: 'sales_person_email', label: 'Owner email', type: 'email' },
    { group: 'What is quoted', name: 'quotation_value', label: 'Quotation value', type: 'money', hint: 'Replaced by the line total once lines are added' },
    { group: 'What is quoted', name: 'currency', label: 'Currency', type: 'select', options: lookups.enums?.currency || ['INR'], default: 'INR' },
    ...(edit ? [
      { group: 'Pipeline', name: 'probability', label: 'Probability %', type: 'number', min: 0, hint: 'Blank: the stage’s own probability' },
      { group: 'Pipeline', name: 'expected_close_date', label: 'Expected close', type: 'date' },
      { group: 'Pipeline', name: 'next_step', label: 'Next step', hint: 'Shown on the Pipeline card' },
    ] : []),
    { group: 'Order and paperwork', name: 'po_received', label: 'PO received', type: 'boolean', default: 'false' },
    { group: 'Order and paperwork', name: 'project_id', label: 'Project ID', type: 'combo', options: lookups.projects.map((p) => p.project_id), hint: 'Leave blank until the project is created' },
    { group: 'Order and paperwork', name: 'place_of_supply_state', label: 'Place of supply (state)' },
    { group: 'Order and paperwork', name: 'printed_no', label: 'Printed number', hint: 'The number on the PDF sent, if not the one above. A PO that quotes it finds this quotation' },
    { group: 'Order and paperwork', name: 'document_id', label: 'Signed / client copy', type: 'document', owner: 'quotations', maxBytes: lookups.limits?.document_max_bytes, span: 2 },
    { group: 'Order and paperwork', name: 'terms', label: 'Terms', type: 'textarea', span: 'all', hint: 'Printed on the PDF. Blank: the default terms from Settings' },
    { group: 'Order and paperwork', name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];
}

export default function Quotations() {
  const lookups = useLookups();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [converting, setConverting] = useState(null);
  const [version, setVersion] = useState(0);

  const canCreate = (r) => r.status === 'Won - PO Received' && !r.project_id;
  const statusBadges = (r) => (
    <span className="inline-flex flex-wrap gap-1.5">
      <Tone tone={dealTone(r.status, false)}>{r.status}</Tone>
      {r.approval_status === 'pending' && <Tone tone="wait">Discount waiting</Tone>}
      {r.approval_status === 'rejected' && <Tone tone="late">Discount rejected</Tone>}
    </span>
  );

  const columns = [
    {
      key: 'quotation_no', header: 'Deal', className: 'mono',
      render: (r) => (
        <>
          <Link className="font-bold text-foreground no-underline" to={`/quotations/${encodeURIComponent(r.quotation_no)}`}>{r.quotation_no}</Link>
          {r.revision > 0 && <span className="text-[12px] font-bold text-muted-foreground"> R{r.revision}</span>}
          <span className="app-sub">{date(r.quotation_date)}{r.expired && <span className="app-late"> · expired</span>}</span>
        </>
      ),
    },
    {
      key: 'client_name', header: 'Client', className: 'strong',
      render: (r) => <>{r.company_id ? <Link className="font-bold text-foreground no-underline" to={`/companies/${r.company_id}`}>{r.client_name}</Link> : r.client_name}{r.contact_person && <span className="app-sub font-normal">{r.contact_person}</span>}</>,
    },
    { key: 'service_quoted', header: 'Service', className: 'wrap', min: 170, render: (r) => <>{r.service_quoted || <span className="text-muted-foreground">—</span>}{r.sector && <span className="app-sub">{r.sector}</span>}</> },
    { key: 'sales_person', header: 'Owner', className: 'nowrap', render: (r) => r.sales_person || <span className="text-muted-foreground">—</span> },
    { key: 'quotation_value', header: 'Value', align: 'right', className: 'strong', render: (r) => money(r.quotation_value, r.currency) },
    { key: 'status', header: 'Status', render: statusBadges },
    {
      key: 'project_id',
      header: 'Project',
      className: 'nowrap',
      render: (r) =>
        r.project_id ? (
          <Link className="app-ref" to={`/projects/${r.project_id}`}>{r.project_id}</Link>
        ) : canCreate(r) ? (
          <button type="button" className="mg-btn mg-btn--sm" onClick={() => setConverting(r)}>
            Create project
          </button>
        ) : (
          <span className="text-muted-foreground" aria-label="No project">—</span>
        ),
    },
    {
      key: 'outstanding', header: 'Still to collect', align: 'right',
      render: (r) => (r.project_id
        ? <><b>{money(r.outstanding)}</b>{r.payment_status && <span className={`app-sub font-bold ${/paid in full|^paid/i.test(r.payment_status) ? 'text-ok' : /part/i.test(r.payment_status) ? 'text-caramel-text' : ''}`}>{r.payment_status}</span>}</>
        : <span className="text-muted-foreground">—</span>),
    },
  ];

  // Figures over the list. Each counts across every deal, not this page,
  // and pressing one filters the list to what it counts.
  const pipeline = useFetch(() => api.raw('/pipeline'), [version]);
  const open = (pipeline.data?.data?.stages || []).filter((s) => s.type === 'open');
  const negotiating = useTotal('quotations', { status: 'Under Negotiation' }, [version]);
  const unregistered = useTotal('quotations', { status: 'Won - PO Received', project_id: '__none__' }, [version]);
  const overdue = useTotal('quotations', { follow_up: 'overdue' }, [version]);
  const summary = ({ filters, setFilters }) => {
    const is = (want) => Object.keys(want).length === Object.keys(filters).length && Object.entries(want).every(([k, v]) => filters[k] === v);
    const press = (want) => () => setFilters(is(want) ? {} : want);
    const W_OPEN = { status: OPEN_DEALS };
    const W_NEG = { status: 'Under Negotiation' };
    const W_WON = { status: 'Won - PO Received', project_id: '__none__' };
    const W_LATE = { follow_up: 'overdue' };
    return (
      <SummaryStrip
        label="Deals at a glance"
        loading={pipeline.loading}
        tiles={[
          { key: 'open', label: 'Open deals', figure: pipeline.data ? money(open.reduce((n, s) => n + Number(s.value || 0), 0)) : null, foot: pipeline.data ? `${open.reduce((n, s) => n + Number(s.count || 0), 0)} deals on the board, in INR` : null, onClick: press(W_OPEN), pressed: is(W_OPEN) },
          { key: 'neg', label: 'Under negotiation', figure: negotiating.total, foot: 'deals talking terms', onClick: press(W_NEG), pressed: is(W_NEG) },
          { key: 'won', label: 'Won, no project yet', figure: unregistered.total, badge: unregistered.total ? { tone: 'wait', text: 'Ready to start' } : null, foot: unregistered.total ? null : 'every win has its project', onClick: press(W_WON), pressed: is(W_WON) },
          { key: 'late', label: 'Follow-ups overdue', figure: overdue.total, tone: overdue.total ? 'late' : undefined, foot: overdue.total ? 'past their follow-up date' : 'nothing overdue', onClick: press(W_LATE), pressed: is(W_LATE) },
        ]}
      />
    );
  };

  return (
    <>
      <ListPage
        refreshToken={version}
        eyebrow="Sales"
        title="Deals"
        noun="deals"
        subtitle="Every quotation we have sent, and what happened to it."
        nav={<SalesViews />}
        summary={summary}
        resource="quotations"
        columns={columns}
        fields={(record) => quotationFields(lookups, { edit: Boolean(record) })}
        formSize="lg"
        formSubtitle="One quotation for one client. Price it as lines on the deal page once it exists."
        formSubmitLabel="Create deal"
        onRowClick={(r) => navigate(`/quotations/${encodeURIComponent(r.quotation_no)}`)}
        newLabel="Deal"
        formTitle="deal"
        searchPlaceholder="Search client, quotation no, service, sector"
        quick={['sales_person', 'stage_id', 'follow_up']}
        extraFilterLabels={{ project_id: 'Project', close_month: 'Expected close', month: 'Quoted in', owner: 'Owner', from_email: 'Read from email' }}
        rowExtras={(r) => r.document_id && (
          <a className="mg-iconbtn" href={api.documentUrl(r.document_id)} target="_blank" rel="noopener noreferrer" aria-label={`Open the signed copy of ${r.quotation_no} in a new tab`} title="Signed copy">
            <FileCheck2 strokeWidth={1.8} aria-hidden="true" />
          </a>
        )}
        rowMenu={(r) => [canCreate(r) && { label: 'Create project', icon: FolderPlus, onSelect: () => setConverting(r) }]}
        phone={(r) => ({
          title: r.client_name,
          amount: money(r.quotation_value, r.currency),
          meta: <>{r.quotation_no}{r.revision > 0 ? ` R${r.revision}` : ''} · {r.service_quoted || 'no subject'}{r.expired && <span className="app-late"> · expired</span>}{r.project_id && <> · {r.project_id}</>}{r.project_id && Number(r.outstanding) > 0 && <> · {money(r.outstanding)} to collect</>}{r.sales_person && <> · {r.sales_person}</>}</>,
          state: statusBadges(r),
          to: `/quotations/${encodeURIComponent(r.quotation_no)}`,
        })}
        deleteTitle={(r) => `Delete ${r.quotation_no}?`}
        deleteText={(r) => `${r.client_name}${r.service_quoted ? `, ${r.service_quoted}` : ''}. Its lines and revisions go with it. This cannot be undone.`}
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
        onSaved={() => { invalidateLookups(); setVersion((v) => v + 1); }}
        // An enquiry links here with ?q=<quotation no> to show its quotation.
        initialSearch={params.get('q') || undefined}
        filters={[
          { name: 'status', label: 'Status', options: [{ value: OPEN_DEALS, label: 'Open (all but won and lost)' }, ...(lookups.enums?.quotation || [])] },
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
