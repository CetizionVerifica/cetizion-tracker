import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ListPage } from '../components/ListPage.jsx';
import { Alert, Badge, useToast } from '../components/ui.jsx';
import { FollowUpBanner, useLogParam } from '../components/FollowUpBanner.jsx';
import { TouchDialog } from '../components/Timeline.jsx';
import { EmailOrigin } from '../components/EmailOrigin.jsx';
import { QuestionnaireBadge, QuestionnaireCard } from '../components/QuestionnaireCard.jsx';
import { invalidateLookups, useLookups } from '../lib/hooks.js';
import { date, money, today } from '../lib/format.js';
import { CONVERTED, OPEN_STATUSES as OPEN, enquiryFields, enquirySectors, enquiryStatuses } from '../lib/enquiries.js';
import { recordPath } from '../lib/journey.js';

/**
 * Enquiries as leads (#24): where they come from, how they are qualified,
 * when to follow up, and why one was dropped. Converted creates the
 * quotation with the estimate carried across, or links one that exists.
 *
 * Each row opens the enquiry's own page (pages/EnquiryDetail.jsx), the
 * first step of the sale's journey. The form is the same one that page
 * edits with, kept in lib/enquiries.js so the two cannot drift apart.
 */
export default function Enquiries() {
  const lookups = useLookups();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // A follow-up email links here as ?q=<enquiry no>&log=1. Those links were
  // written before enquiries had a page of their own, so the list still
  // answers them: the banner and the log dialog sit here as well.
  const enquiryNo = params.get('q') || '';
  const [touching, setTouching] = useState(false);
  const [logged, setLogged] = useState(0);
  // The service questionnaire for one enquiry (#208). A "submitted" notification links here with ?questionnaire=.
  const [questionnaire, setQuestionnaire] = useState(() => (enquiryNo && params.get('questionnaire') ? { enquiry_no: enquiryNo } : null));
  const [questionnaireVersion, setQuestionnaireVersion] = useState(0);
  useLogParam(() => setTouching(true), Boolean(enquiryNo));
  const statuses = enquiryStatuses(lookups);
  const sectors = enquirySectors(lookups);
  const responseHours = Number(lookups.settings?.lead_first_response_hours || 24);
  // Worked out from the rows the list already loaded, not a second request.
  const attention = (rows) => ({
    dueRows: rows.filter((e) => OPEN.includes(e.status) && e.next_follow_up_at && e.next_follow_up_at <= today()),
    late: rows.filter((e) => e.status === 'New' && (Date.now() - new Date(e.created_at).getTime()) / 36e5 > responseHours),
  });

  const columns = [
    // The number and the client both open the enquiry's page. Real links, so
    // they open in a new tab and reach a keyboard on a phone, where a row is
    // a card nobody can tab to. The company is one click on from the page.
    { key: 'enquiry_no', header: 'Enquiry', className: 'mono', render: (r) => <><Link to={recordPath('enquiry', r.enquiry_no)}>{r.enquiry_no}</Link><div className="small muted">{date(r.enquiry_date)}</div></> },
    { key: 'client_name', header: 'Client', className: 'strong', render: (r) => <><Link to={recordPath('enquiry', r.enquiry_no)}>{r.client_name}</Link>{r.contact_person && <div className="small muted">{r.contact_person}</div>}</> },
    { key: 'source', header: 'Source', render: (r) => lookups.lead_sources.find((s) => s.id === r.source_id)?.name || <span className="muted">—</span> },
    { key: 'service', header: 'Interested in', className: 'wrap', render: (r) => r.service || r.services_interested || <span className="muted">—</span> },
    { key: 'estimated_value', header: 'Estimate', align: 'right', render: (r) => (r.estimated_value ? money(r.estimated_value, r.currency) : <span className="muted">—</span>) },
    { key: 'sales_person', header: 'Owner', render: (r) => r.sales_person ?? <span className="muted">—</span> },
    { key: 'status', header: 'Status', render: (r) => <><Badge tone={r.status === 'Unqualified' ? 'danger' : r.status === CONVERTED ? 'success' : r.status === 'New' ? 'warning' : 'info'}>{r.status}</Badge>{r.status === 'Unqualified' && r.unqualified_reason_id && <div className="small muted">{lookups.lost_reasons.find((x) => x.id === r.unqualified_reason_id)?.name}</div>}</> },
    { key: 'next_follow_up_at', header: 'Next follow-up', render: (r) => r.next_follow_up_at ? <span style={{ color: r.next_follow_up_at <= today() && OPEN.includes(r.status) ? 'var(--late)' : undefined }}>{date(r.next_follow_up_at)}</span> : <span className="muted">—</span> },
    { key: 'expected_decision_date', header: 'Decision by', render: (r) => date(r.expected_decision_date) },
    {
      key: 'questionnaire_status', header: 'Questionnaire',
      render: (r) => (
        <button type="button" className="btn btn--sm btn--ghost" onClick={(e) => { e.stopPropagation(); setQuestionnaire(r); }}>
          {r.questionnaire_status ? <QuestionnaireBadge status={r.questionnaire_status} /> : 'Send'}
        </button>
      ),
    },
    {
      key: 'quotation_no', header: 'Quotation',
      render: (r) => r.quotation_no ? <Link className="mono" to={recordPath('quotation', r.quotation_no)}>{r.quotation_no}</Link> : <span className="muted">—</span>,
    },
  ];

  return (
    <>
    <ListPage
      title="Enquiries"
      subtitle="Every lead, from first contact to quotation: source, owner, next follow-up, and what happened"
      resource="enquiries"
      columns={columns}
      fields={(record) => enquiryFields(lookups, record)}
      onRowClick={(r) => navigate(recordPath('enquiry', r.enquiry_no))}
      newLabel="Enquiry"
      formTitle="enquiry"
      formIntro={`New → Contacted → Qualified → ${CONVERTED}. Set "${CONVERTED}" and a quotation is created with these details, or link one that exists. Drop a lead with "Unqualified" and a reason; "Nurture" parks it for later.`}
      searchPlaceholder="Search client, enquiry no, service, sector…"
      initialFilters={Object.fromEntries(['status', 'sector', 'sales_person', 'source_id', 'from', 'to', 'owner', 'from_email'].map((k) => [k, params.get(k)]).filter(([, v]) => v))}
      initialSearch={params.get('q') || undefined}
      dateFilterLabel="Enquiry date"
      refreshToken={questionnaireVersion}
      onSaved={(saved) => {
        invalidateLookups();
        if (saved?.quotation_created) toast(`Quotation ${saved.quotation_created} created`, 'success');
      }}
      filters={[
        { name: 'status', label: 'Status', options: statuses },
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
      banner={(rows) => { const { dueRows, late } = attention(rows); return <>
        {enquiryNo && <EmailOrigin entity="enquiry" id={enquiryNo} />}
        {enquiryNo && <FollowUpBanner entity="enquiry" id={enquiryNo} version={logged} onLog={() => setTouching(true)} />}
        {(dueRows.length > 0 || late.length > 0) && (
        <Alert tone="warning">
          <span>
            {dueRows.length > 0 && <><strong>{dueRows.length} follow-up{dueRows.length === 1 ? '' : 's'} due:</strong> {dueRows.slice(0, 6).map((e) => `${e.client_name} (${date(e.next_follow_up_at)})`).join(', ')}{dueRows.length > 6 ? ` and ${dueRows.length - 6} more` : ''}. </>}
            {late.length > 0 && <><strong>{late.length} new enquir{late.length === 1 ? 'y has' : 'ies have'} waited over {responseHours} hours</strong> for a first contact: {late.slice(0, 4).map((e) => e.client_name).join(', ')}.</>}
          </span>
        </Alert>
        )}
      </>; }}
    />
    {touching && <TouchDialog entity="enquiry" id={enquiryNo} start={{ channel: 'call', contact_id: null }} onClose={() => setTouching(false)} onSaved={() => { setTouching(false); setLogged((n) => n + 1); }} />}
    {questionnaire && <QuestionnaireCard enquiry={questionnaire} onClose={() => setQuestionnaire(null)} onChanged={() => setQuestionnaireVersion((n) => n + 1)} />}
    </>
  );
}
