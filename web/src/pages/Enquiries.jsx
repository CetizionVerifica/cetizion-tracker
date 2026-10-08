import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { TriangleAlert } from 'lucide-react';
import { ListPage } from '../components/ListPage.jsx';
import { useToast } from '../components/ui.jsx';
import { FollowUpBanner, useLogParam } from '../components/FollowUpBanner.jsx';
import { TouchDialog } from '../components/Timeline.jsx';
import { EmailOrigin } from '../components/EmailOrigin.jsx';
import { SalesViews, SummaryStrip, Tone, daysFrom, useRows, useTotal } from '../components/sales.jsx';
import { invalidateLookups, useLookups } from '../lib/hooks.js';
import { date, money, today } from '../lib/format.js';
import { plural } from '../components/daily.jsx';

/**
 * Enquiries as leads (#24): where they come from, how they are qualified,
 * when to follow up, and why one was dropped. Converted creates the
 * quotation with the estimate carried across, or links one that exists.
 */
const CONVERTED = 'Converted';
const STATUSES = ['New', 'Contacted', 'Qualified', 'Nurture', CONVERTED, 'Unqualified'];
const OPEN = ['New', 'Contacted', 'Qualified', 'Nurture'];
const SECTORS = ['Agriculture', 'Metal Industry', 'Pharmaceutical', 'Other'];

const enquiryTone = (s) => (s === 'Unqualified' ? 'late' : s === CONVERTED ? 'ok' : s === 'New' ? 'wait' : s === 'Nurture' ? 'plain' : 'info');
const monthStart = () => `${today().slice(0, 7)}-01`;
const MONTH = () => new Date().toLocaleDateString('en-GB', { month: 'long' });

export default function Enquiries() {
  const lookups = useLookups();
  const toast = useToast();
  const [params] = useSearchParams();
  // A follow-up email links here as ?q=<enquiry no>&log=1. Enquiries have no
  // page of their own, so the banner and the log dialog sit on the list.
  const enquiryNo = params.get('q') || '';
  const [touching, setTouching] = useState(false);
  const [logged, setLogged] = useState(0);
  const [version, setVersion] = useState(0);
  useLogParam(() => setTouching(true), Boolean(enquiryNo));
  const statuses = lookups.enums?.enquiry || STATUSES;
  const sectors = lookups.sectors.length ? lookups.sectors : SECTORS;
  const responseHours = Number(lookups.settings?.lead_first_response_hours || 24);
  const sourceName = (r) => lookups.lead_sources.find((s) => s.id === r.source_id)?.name;

  // The banner and the strip count every enquiry, not just this page, by
  // the server's own follow-up rules (?risk=).
  const missed = useRows('enquiries', { risk: 'follow_up_missed', limit: 6 }, [version, logged]);
  const waiting = useRows('enquiries', { risk: 'no_reply', limit: 4 }, [version, logged]);
  const openCount = useTotal('enquiries', { status: OPEN.join(',') }, [version]);
  const converted = useTotal('enquiries', { status: CONVERTED, from: monthStart(), to: today() }, [version]);

  const nextFollowUp = (r) => {
    if (!r.next_follow_up_at) return r.expected_decision_date ? <span className="app-sub">decide by {date(r.expected_decision_date)}</span> : <span className="text-muted-foreground">—</span>;
    const d = daysFrom(r.next_follow_up_at);
    const late = OPEN.includes(r.status) && d < 0;
    return (
      <>
        {late ? <Tone tone="late">{date(r.next_follow_up_at)}, {plural(-d, 'day')} late</Tone> : <span>{date(r.next_follow_up_at)}</span>}
        {r.expected_decision_date && <span className="app-sub">decide by {date(r.expected_decision_date)}</span>}
      </>
    );
  };

  const columns = [
    { key: 'enquiry_no', header: 'Enquiry', className: 'mono', render: (r) => <><b>{r.enquiry_no}</b><span className="app-sub">{date(r.enquiry_date)}</span></> },
    { key: 'client_name', header: 'Client', className: 'strong', render: (r) => <>{r.company_id ? <Link className="font-bold text-foreground no-underline" to={`/companies/${r.company_id}`}>{r.client_name}</Link> : r.client_name}{r.contact_person && <span className="app-sub font-normal">{r.contact_person}</span>}</> },
    { key: 'service', header: 'Interested in', className: 'wrap', min: 160, render: (r) => <>{r.service || r.services_interested || <span className="text-muted-foreground">—</span>}{(sourceName(r) || r.source) && <span className="app-sub">{sourceName(r) || r.source}</span>}</> },
    { key: 'estimated_value', header: 'Estimate', align: 'right', className: 'strong', render: (r) => (r.estimated_value ? money(r.estimated_value, r.currency) : <span className="text-muted-foreground">—</span>) },
    { key: 'sales_person', header: 'Owner', className: 'nowrap', render: (r) => r.sales_person ?? <span className="text-muted-foreground">—</span> },
    { key: 'status', header: 'Status', render: (r) => <><Tone tone={enquiryTone(r.status)}>{r.status}</Tone>{r.status === 'Unqualified' && r.unqualified_reason_id && <span className="app-sub">{lookups.lost_reasons.find((x) => x.id === r.unqualified_reason_id)?.name}</span>}</> },
    { key: 'next_follow_up_at', header: 'Next follow-up', render: nextFollowUp },
    {
      key: 'quotation_no', header: 'Quotation',
      render: (r) => r.quotation_no ? <Link className="app-ref" to={`/quotations/${encodeURIComponent(r.quotation_no)}`}>{r.quotation_no}</Link> : <span className="text-muted-foreground">—</span>,
    },
  ];

  const fields = (record) => [
    { group: 'The enquiry', name: 'enquiry_no', label: 'Enquiry number', auto: 'enquiry' },
    { group: 'The enquiry', name: 'enquiry_date', label: 'Enquiry date', type: 'date', default: today() },
    { group: 'The enquiry', name: 'status', label: 'Status', type: 'select', options: statuses, default: 'New', required: true, hint: `Leaving New needs a source and the client; Qualified and "${CONVERTED}" need the services and an estimated value; Unqualified needs a reason. "${CONVERTED}" creates a draft quotation, a line per service, unless one is linked` },
    { group: 'The enquiry', name: 'source_id', label: 'Lead source', type: 'select', options: lookups.lead_sources.map((s) => ({ value: String(s.id), label: s.name })), hint: 'Where this enquiry came from' },
    { group: 'The enquiry', name: 'source', label: 'How it reached us', hint: 'In words: referral from…, the website form, an email, an event' },
    { group: 'Client', name: 'client_name', label: 'Client', required: true, type: 'combo', options: lookups.clients, hint: 'One spelling per client; a new name creates a company' },
    { group: 'Client', name: 'sector', label: 'Sector', type: 'combo', options: sectors, hint: 'Pick from the list, or type a new sector' },
    { group: 'Client', name: 'country', label: 'Country', type: 'combo', options: ['India', 'United Arab Emirates', 'Singapore', 'United Kingdom', 'United States'] },
    { group: 'Client', name: 'contact_person', label: 'Contact person' },
    // The address lives on the contact, and until now there was nowhere to
    // type it: the contact this name creates held a name and nothing else,
    // so sending the quotation, chasing payment, the portal and mailbox
    // matching all had nobody to reach (docs/client-data-gaps.md, gap 1).
    { group: 'Client', name: 'contact_email', label: 'Contact email', type: 'email', hint: 'Saved on the contact. Used to send the quotation and to chase payment' },
    { group: 'Client', name: 'contact_phone', label: 'Contact phone' },
    { group: 'What they want', name: 'service', label: 'Service asked for', type: 'combo', options: lookups.services, hint: 'Pick from the catalogue, or type it' },
    { group: 'What they want', name: 'services_interested', label: 'Other services of interest' },
    { group: 'What they want', name: 'estimated_value', label: 'Estimated value', type: 'money', hint: 'Carried onto the quotation when converted' },
    { group: 'What they want', name: 'currency', label: 'Currency', type: 'select', options: lookups.enums?.currency || ['INR'], default: 'INR' },
    { group: 'Owner and follow-up', name: 'sales_person', label: 'Owner', type: 'combo', options: lookups.sales_people },
    { group: 'Owner and follow-up', name: 'sales_person_email', label: 'Owner email', type: 'email' },
    { group: 'Owner and follow-up', name: 'next_follow_up_at', label: 'Next follow-up', type: 'date', hint: 'Blank: set from Settings when the status changes' },
    { group: 'Owner and follow-up', name: 'expected_decision_date', label: 'Expected decision', type: 'date' },
    { group: 'If it goes nowhere', name: 'unqualified_reason_id', label: 'Reason, if unqualified', type: 'select', options: lookups.lost_reasons.map((r) => ({ value: String(r.id), label: r.name })) },
    { group: 'If it goes nowhere', name: 'unqualified_notes', label: 'Notes on that', span: 2 },
    {
      group: 'Quotation', name: 'quotation_no', label: 'Existing quotation', type: 'select', span: 'all',
      hint: 'For an enquiry that was already quoted: link that quotation instead of creating a new one',
      options: [
        ...(record?.quotation_no && !lookups.quotations.some((q) => q.quotation_no === record.quotation_no) ? [{ value: record.quotation_no, label: record.quotation_no }] : []),
        ...lookups.quotations.map((q) => ({ value: q.quotation_no, label: `${q.quotation_no} — ${q.client_name} (${q.status})` })),
      ],
    },
    { group: 'Quotation', name: 'notes', label: 'Notes', type: 'textarea', span: 'all' },
  ];

  const summary = ({ filters, setFilters }) => {
    const is = (want) => Object.keys(want).length === Object.keys(filters).length && Object.entries(want).every(([k, v]) => filters[k] === v);
    const press = (want) => () => setFilters(is(want) ? {} : want);
    const W_OPEN = { status: OPEN.join(',') };
    const W_NEW = { risk: 'no_reply' };
    const W_MISS = { risk: 'follow_up_missed' };
    const W_CONV = { status: CONVERTED, from: monthStart(), to: today() };
    return (
      <SummaryStrip
        label="Enquiries at a glance"
        tiles={[
          { key: 'open', label: 'Open enquiries', figure: openCount.total, foot: 'new, contacted, qualified or nurtured', onClick: press(W_OPEN), pressed: is(W_OPEN) },
          { key: 'new', label: 'Waiting for a first call', figure: waiting.total, tone: waiting.total ? 'late' : undefined, foot: `over ${responseHours} hours, nobody has answered`, onClick: press(W_NEW), pressed: is(W_NEW) },
          { key: 'miss', label: 'Follow-ups missed', figure: missed.total, tone: missed.total ? 'late' : undefined, foot: missed.total ? 'past their follow-up date' : 'nothing missed', onClick: press(W_MISS), pressed: is(W_MISS) },
          { key: 'conv', label: `Converted in ${MONTH()}`, figure: converted.total, tone: converted.total ? 'ok' : undefined, foot: 'enquired this month, now quotations', onClick: press(W_CONV), pressed: is(W_CONV) },
        ]}
      />
    );
  };

  return (
    <>
    <ListPage
      refreshToken={version}
      eyebrow="Sales"
      title="Enquiries"
      noun="enquiries"
      subtitle="Every lead, from first contact to quotation: where it came from, who owns it, when to follow up, and what happened."
      nav={<SalesViews />}
      summary={summary}
      resource="enquiries"
      columns={columns}
      fields={fields}
      formSize="lg"
      formSubmitLabel="Create enquiry"
      newLabel="Enquiry"
      formTitle="enquiry"
      formIntro={`New → Contacted → Qualified → ${CONVERTED}. Set "${CONVERTED}" and a quotation is created with these details, or link one that exists. Drop a lead with "Unqualified" and a reason; "Nurture" parks it for later.`}
      searchPlaceholder="Search client, enquiry no, service, sector"
      quick={['sales_person', 'source_id', 'risk']}
      extraFilterLabels={{ owner: 'Owner' }}
      initialFilters={Object.fromEntries(['status', 'sector', 'sales_person', 'source_id', 'from', 'to', 'owner', 'from_email', 'risk'].map((k) => [k, params.get(k)]).filter(([, v]) => v))}
      initialSearch={params.get('q') || undefined}
      dateFilterLabel="Enquiry date"
      phone={(r) => ({
        title: r.client_name,
        amount: r.estimated_value ? money(r.estimated_value, r.currency) : '—',
        meta: <>{r.enquiry_no} · {r.service || r.services_interested || 'no service yet'}{r.sales_person && <> · {r.sales_person}</>}{r.next_follow_up_at && <> · follow up {date(r.next_follow_up_at)}</>}{r.quotation_no && <> · {r.quotation_no}</>}</>,
        state: <Tone tone={enquiryTone(r.status)}>{r.status}</Tone>,
      })}
      deleteTitle={(r) => `Delete ${r.enquiry_no}?`}
      deleteText={(r) => `${r.client_name}${r.service ? `, ${r.service}` : ''}. Its notes, tasks and logged calls go with it. A quotation made from it stays. This cannot be undone.`}
      onSaved={(saved) => {
        invalidateLookups();
        setVersion((v) => v + 1);
        if (saved?.quotation_created) toast(`Quotation ${saved.quotation_created} created`, 'success');
      }}
      filters={[
        { name: 'status', label: 'Status', options: [{ value: OPEN.join(','), label: 'Open (not converted or dropped)' }, ...statuses] },
        { name: 'source_id', label: 'Source', options: lookups.lead_sources.map((s) => ({ value: String(s.id), label: s.name })) },
        { name: 'sector', label: 'Sector', options: [{ value: '__none__', label: 'Not set' }, ...sectors] },
        { name: 'sales_person', label: 'Owner', options: lookups.sales_people },
        // Made by the email reader, for the team to review (docs/email-enquiries.md).
        { name: 'from_email', label: 'Created from email', options: [{ value: '1', label: 'Created from email' }] },
        // Insights links its at-risk bars here (server/src/lib/enquiryRisk.js).
        { name: 'risk', label: 'At risk', options: [
          { value: 'at_risk', label: 'Any reason' },
          { value: 'decision_near', label: 'Decision near, no quotation' },
          { value: 'no_reply', label: 'No reply yet' },
          { value: 'follow_up_missed', label: 'Follow-up date missed' },
          { value: 'idle', label: 'Gone quiet' },
        ] },
      ]}
      banner={(rows, { setFilters }) => <>
        {enquiryNo && <EmailOrigin entity="enquiry" id={enquiryNo} />}
        {enquiryNo && <FollowUpBanner entity="enquiry" id={enquiryNo} version={logged} onLog={() => setTouching(true)} />}
        {(missed.total > 0 || waiting.total > 0) && (
          <div className="mg-banner mg-banner--wait" role="status">
            <TriangleAlert aria-hidden="true" />
            <div className="mg-banner__body">
              <strong>
                {[missed.total > 0 && `${plural(missed.total, 'follow-up')} ${missed.total === 1 ? 'is' : 'are'} overdue`, waiting.total > 0 && `${plural(waiting.total, 'new enquiry', 'new enquiries')} still waiting for a first call`].filter(Boolean).join(', and ')}
              </strong>
              {missed.total > 0 && <>Overdue: {missed.rows.map((e) => `${e.client_name}${e.next_follow_up_at ? ` (${date(e.next_follow_up_at)})` : ''}`).join(', ')}{missed.total > missed.rows.length ? ` and ${missed.total - missed.rows.length} more` : ''}. </>}
              {waiting.total > 0 && <>Waiting over {responseHours} hours: {waiting.rows.map((e) => e.client_name).join(', ')}{waiting.total > waiting.rows.length ? ` and ${waiting.total - waiting.rows.length} more` : ''}. </>}
              Counted across all your enquiries, not just this page.
            </div>
            <span className="flex flex-wrap gap-2 self-center">
              {missed.total > 0 && <button type="button" className="mg-btn mg-btn--sm" onClick={() => setFilters({ risk: 'follow_up_missed' })}>Show the {missed.total} overdue</button>}
              {waiting.total > 0 && <button type="button" className="mg-btn mg-btn--sm" onClick={() => setFilters({ risk: 'no_reply' })}>Show the {waiting.total} waiting</button>}
            </span>
          </div>
        )}
      </>}
    />
    {touching && <TouchDialog entity="enquiry" id={enquiryNo} start={{ channel: 'call', contact_id: null }} onClose={() => setTouching(false)} onSaved={() => { setTouching(false); setLogged((n) => n + 1); }} />}
    </>
  );
}
