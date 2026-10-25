import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import NotFound from './NotFound.jsx';
import { ErrorState, useToast } from '../components/ui.jsx';
import { Chip, RailEvent, RecordMenuItem, RecordPage, RecordSection, initialsOf } from '../components/record.jsx';
import { JourneyRail } from '../components/journey/JourneyRail.jsx';
import { Button } from '../components/ui/button';
import { RecordForm } from '../components/RecordForm.jsx';
import { Timeline, TouchDialog } from '../components/Timeline.jsx';
import { EmailOrigin } from '../components/EmailOrigin.jsx';
import { QuestionnaireBadge, QuestionnaireCard } from '../components/QuestionnaireCard.jsx';
import { api } from '../lib/api.js';
import { invalidateLookups, useFetch, useLookups } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';
import { recordPath } from '../lib/journey.js';
import {
  CONVERTED, MOVE_LABELS, UNQUALIFIED, enquiryEvents, enquiryFields, enquiryMove, enquiryNote, enquiryReceived,
  enquirySource, offersConvert, enquiryTitle, enquiryTone, enquiryVerdict, followUpMissed, questionnaireLine, unqualifiedBecause,
} from '../lib/enquiries.js';

/**
 * One enquiry: the first step of the sale's journey (docs/specs/sales-journey).
 *
 * An enquiry used to be a row and an edit dialog, so the step every sale
 * starts at had nowhere to drill into. The quotation, the order and the
 * project each had a page with a rail, a timeline and the one move that
 * takes them on; the enquiry had the list, a banner bolted to its top and
 * a questionnaire column. This is its page, drawn the way theirs are.
 *
 * The rail is the same journey the quotation and the order show, read off
 * the server. What the page decides is the sentence under it and the one
 * button beside that: a qualified enquiry converts, one with a quotation
 * opens it, and anything else moves on by talking to the client. Edit and
 * the rest are in the ⋯ menu, and the small print names them.
 *
 * Converting is the enquiry form the list uses, opened with the status set
 * to Converted, so the server's rules and the quotation it creates are the
 * same whichever screen it was done from.
 */

const FLOW_BUTTON = 'h-8 px-4 text-[13px]';
const ROW_BUTTON = 'h-7 px-3 text-[12.5px]';
const NONE = <span className="text-muted-foreground">—</span>;

/** A cell in the facts grid: a label, and what it says. */
function Fact({ label, children, wide }) {
  return (
    <div className={wide ? 'col-span-2 min-w-0' : 'min-w-0'}>
      <div className="eyebrow">{label}</div>
      <div className="mt-1.5 text-[13px] text-foreground">{children}</div>
    </div>
  );
}

export default function EnquiryDetail() {
  const { key } = useParams();
  const toast = useToast();
  const lookups = useLookups();
  const [form, setForm] = useState(null);              // 'edit' | 'convert'
  const [touching, setTouching] = useState(false);
  const [questionnaire, setQuestionnaire] = useState(false);
  // Bumped when the page logs a call, so the timeline below shows it.
  const [logged, setLogged] = useState(0);
  // The journey the rail loaded: whether the quotation opens for this viewer.
  const [journey, setJourney] = useState(null);

  const { data, error, errorStatus, refetch } = useFetch(() => api.get('enquiries', key), [key]);
  // The address may name it by number or by id. Going from one enquiry to
  // another keeps the last one loaded until the next arrives; that one is
  // not this page's, so nothing on it should be pressed meanwhile.
  const loaded = data?.data;
  const e = loaded && [loaded.enquiry_no, String(loaded.id)].includes(key) ? loaded : null;

  // Only while there is nothing to show: a reload after an action keeps the
  // enquiry on screen until the new one arrives, rather than flashing a
  // skeleton over the page somebody is working on.
  if (!e) {
    // A sales user asking after somebody else's enquiry gets the same 404 as
    // a number that does not exist, and the same page.
    if (errorStatus === 404) return <NotFound />;
    if (error) return <><PageHeader title="Enquiry" /><div className="page"><ErrorState message={error} onRetry={refetch} /></div></>;
    return <><PageHeader title="Enquiry" /><div className="page"><div className="skeleton h-[240px]" /></div></>;
  }

  // Open until the journey says this very quotation is closed to the viewer,
  // as on the board's drawer: a journey loaded before a conversion or a
  // relink describes another quotation, or none, and says nothing about it.
  const quoted = journey?.records?.enquiry_no === e.enquiry_no ? journey.steps?.find((s) => s.key === 'quotation') : null;
  const quotationOpens = !(e.quotation_no && quoted?.record?.no === e.quotation_no && quoted.reachable === false);
  const move = enquiryMove(e, { quotationOpens });
  const quotationPath = quotationOpens ? recordPath('quotation', e.quotation_no) : null;
  const received = enquiryReceived(e);
  const source = enquirySource(e, lookups);
  const dropped = e.status === UNQUALIFIED ? unqualifiedBecause(e, lookups) : null;
  const events = enquiryEvents(e, lookups);
  const asked = questionnaireLine(e.questionnaire_status);
  const logCall = () => setTouching(true);

  /** A save from either form: a conversion reports the quotation it made. */
  function saved(result) {
    invalidateLookups();
    if (result?.quotation_created) toast(`Quotation ${result.quotation_created} created`, 'success');
    refetch();
  }

  function primary() {
    if (move === 'open_quotation') {
      return <Button size="sm" className={FLOW_BUTTON} asChild><Link to={quotationPath}>{MOVE_LABELS.open_quotation}</Link></Button>;
    }
    if (move === 'convert') return <Button size="sm" className={FLOW_BUTTON} onClick={() => setForm('convert')}>{MOVE_LABELS.convert}</Button>;
    return <Button size="sm" className={FLOW_BUTTON} onClick={logCall}>{MOVE_LABELS.log_call}</Button>;
  }

  return (
    <>
      <RecordPage
        parent="Enquiries"
        parentTo="/enquiries"
        title={enquiryTitle(e)}
        mark={initialsOf(e.client_name)}
        facts={[
          <span className="mono text-[12.5px] text-foreground">{e.enquiry_no}</span>,
          received && `Received ${received}`,
          source && `Via ${source}`,
          <Chip tone={enquiryTone(e.status)}>{e.status}</Chip>,
          e.sales_person ? `Owner ${e.sales_person}` : 'No owner yet',
        ]}
        menu={
          <>
            <RecordMenuItem onSelect={() => setForm('edit')}>Edit the enquiry</RecordMenuItem>
            {move === 'open_quotation' && <RecordMenuItem onSelect={logCall}>Log a call</RecordMenuItem>}
            {offersConvert(e, move) && (
              <RecordMenuItem onSelect={() => setForm('convert')}>Convert to quotation</RecordMenuItem>
            )}
            <RecordMenuItem onSelect={() => setQuestionnaire(true)}>{asked.button}</RecordMenuItem>
          </>
        }
        flow={
          // The enquiry is a new object each time the page loads it, so the
          // rail reloads with it after a save, a call or a conversion here.
          <JourneyRail
            of={{ enquiry: e.enquiry_no }}
            verdict={enquiryVerdict(e, lookups, undefined, { quotationOpens })}
            actions={<>
              {primary()}
              {move === 'convert' && <Button variant="secondary" size="sm" className={FLOW_BUTTON} onClick={logCall}>Log a call</Button>}
            </>}
            note={enquiryNote(move)}
            refreshKey={e}
            onJourney={setJourney}
          />
        }
        rail={events.length > 0 && (
          <RecordSection title="So far">
            {events.map((event, i) => (
              <RailEvent key={event.what} what={event.what} when={event.when} detail={event.detail} last={i === events.length - 1} />
            ))}
          </RecordSection>
        )}
      >
        {/* Made by the email reader (docs/email-enquiries.md): when, which
            mailbox, and the thread. Nothing for an enquiry typed in. */}
        <EmailOrigin entity="enquiry" id={e.enquiry_no} />

        <RecordSection title="About the enquiry">
          <div className="grid grid-cols-2 gap-5 p-5 sm:grid-cols-4">
            <Fact label="Client">
              {e.company_id
                ? <Link to={`/companies/${e.company_id}`} className="text-foreground no-underline hover:text-primary">{e.client_name}</Link>
                : e.client_name}
            </Fact>
            <Fact label="Contact">
              {e.contact_person || e.contact_email || e.contact_phone ? (
                <>
                  {e.contact_person || 'No name'}
                  {e.contact_email && <div className="text-[12px] break-words text-secondary-text">{e.contact_email}</div>}
                  {e.contact_phone && <div className="num text-[12px] text-secondary-text">{e.contact_phone}</div>}
                </>
              ) : NONE}
            </Fact>
            <Fact label="Services" wide>
              {e.service || e.services_interested ? (
                <>
                  {e.service || e.services_interested}
                  {e.service && e.services_interested && <div className="text-[12px] text-secondary-text">Also {e.services_interested}</div>}
                </>
              ) : NONE}
            </Fact>
            <Fact label="Estimate">
              {e.estimated_value === null || e.estimated_value === undefined
                ? <span className="text-muted-foreground">No estimate</span>
                : <span className="num">{money(e.estimated_value, e.currency || 'INR')}</span>}
            </Fact>
            <Fact label="Sector">{e.sector || NONE}</Fact>
            <Fact label="Country">{e.country || NONE}</Fact>
            <Fact label="Quotation">
              {quotationPath
                ? <Link className="mono" to={quotationPath}>{e.quotation_no}</Link>
                : e.quotation_no ? <span className="mono">{e.quotation_no}</span> : <span className="text-muted-foreground">None yet</span>}
            </Fact>
            <Fact label="Next follow-up">
              {e.next_follow_up_at
                ? (followUpMissed(e) ? <span className="text-late">{date(e.next_follow_up_at)} · missed</span> : date(e.next_follow_up_at))
                : NONE}
            </Fact>
            <Fact label="Decision by">{e.expected_decision_date ? date(e.expected_decision_date) : NONE}</Fact>
            {dropped && <Fact label="Unqualified because" wide>{dropped}</Fact>}
          </div>
          {e.notes && (
            <div className="border-t border-border px-5 py-4">
              <div className="eyebrow">Notes</div>
              <p className="mt-1.5 text-[13px]/[1.7] whitespace-pre-wrap text-secondary-text">{e.notes}</p>
            </div>
          )}
        </RecordSection>

        <RecordSection
          title="Questionnaire"
          action={<Button variant="secondary" size="sm" className={ROW_BUTTON} onClick={() => setQuestionnaire(true)}>{asked.button}</Button>}
        >
          <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 px-5 py-4 text-[13px] text-secondary-text">
            {e.questionnaire_status && <QuestionnaireBadge status={e.questionnaire_status} />}
            <span>{asked.text}</span>
          </p>
        </RecordSection>

        {/* Remounted after a call logged from the button above, which the
            timeline did not see happen. Its own "Log a touch" needs none. */}
        <Timeline key={logged} entity="enquiry" id={e.enquiry_no} />
      </RecordPage>

      {form && (
        <RecordForm
          title={form === 'convert' ? 'Convert to quotation' : 'Edit enquiry'}
          subtitle={e.enquiry_no}
          intro={form === 'convert'
            ? `The status is set to "${CONVERTED}". Saving creates a draft quotation with a line per service and the estimate carried across. To link a quotation that already exists instead, pick it under Existing quotation.`
            : undefined}
          submitLabel={form === 'convert' ? 'Convert to quotation' : undefined}
          resource="enquiries"
          fields={enquiryFields(lookups, e)}
          record={form === 'convert' ? { ...e, status: CONVERTED } : e}
          onClose={() => setForm(null)}
          onSaved={saved}
        />
      )}
      {touching && (
        <TouchDialog
          entity="enquiry"
          id={e.enquiry_no}
          start={{ channel: 'call', contact_id: null }}
          onClose={() => setTouching(false)}
          onSaved={() => { setTouching(false); setLogged((n) => n + 1); refetch(); }}
        />
      )}
      {questionnaire && <QuestionnaireCard enquiry={e} onClose={() => setQuestionnaire(false)} onChanged={refetch} />}
    </>
  );
}
