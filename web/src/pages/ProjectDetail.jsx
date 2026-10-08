import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ClipboardList, FileText, Flag, FolderKanban, Plane, Plus } from 'lucide-react';
import {
  Chip, RailPerson, RecordFlow, RecordMenuItem, RecordPage, RecordStat, flowSteps,
} from '../components/record.jsx';
import { Checklist } from '../components/checklist.jsx';
import { Button } from '../components/ui/button.tsx';
import { useToast, ConfirmDialog } from '../components/ui.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { RaiseTravelInvoiceDialog } from '../components/actions.jsx';
import { TravelInvoicesSection } from '../components/travelInvoices.jsx';
import { useAuth } from '../lib/auth.jsx';
import { mayRaiseTravelInvoice } from '../lib/travelInvoices.js';
import { Timeline } from '../components/Timeline.jsx';
import { ProjectProfit } from '../components/ProjectProfit.jsx';
import { ProjectVisits } from './Schedule.jsx';
import { DeliverablesTable } from '../components/Deliverables.jsx';
import { Sec, Tone, useTab } from '../components/sales.jsx';
import { StateCard } from '../components/daily.jsx';
import { MoneyBanner, shortDate } from '../components/money.jsx';
import { RailCard, RailLink, RecordState, StateBadge, TRIP_BILL, TabsPanel, count } from '../components/travel.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { money, today } from '../lib/format.js';
import { poCurrencyFields } from '../lib/poCurrency.js';
import { poRevisionFields } from '../lib/poRevision.js';
import { projectFields } from './Projects.jsx';

/**
 * The project record (C15), in the Wave 6 shape: the header with its facts,
 * the flow ladder beside the one move that changes money (the delivery
 * date), four figures, then the record's sections as tabs — Checklist,
 * Milestones and orders, Certificates and visits, Margin and costs,
 * Activity — beside a rail of trips, people and the quotation.
 *
 * The checklist stays the first tab, and four of its eleven steps are not
 * ticked by anyone: the PO register and the payment schedule answer them
 * (see server/src/lib/onboarding.js). Purchase orders link to the order
 * record, which is where stages belong (C6).
 */

/** The template's four stages, in order, as the ladder across the top. */
const LIFECYCLE = ['Onboarding', 'Execution', 'Delivery', 'Closure'];
const TAB_KEYS = ['checklist', 'orders', 'deliverables', 'money', 'activity'];

export default function ProjectDetail() {
  const { projectId } = useParams();
  const toast = useToast();
  const lookups = useLookups();
  const [dialog, setDialog] = useState(null);
  // Above the loading return: a hook cannot be called conditionally.
  const { isAdmin, isHr } = useAuth();
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useTab(TAB_KEYS);

  const { data, loading, fresh, error, errorStatus, refetch } = useFetch(
    () => api.raw(`/projects/${encodeURIComponent(projectId)}/full`),
    [projectId]
  );

  if (error || (loading && !fresh) || !data) {
    return (
      <RecordState
        parent="Projects" parentTo="/projects" crumb={projectId} noun="project"
        loading={!error} missing={errorStatus === 404} error={error} onRetry={refetch}
      />
    );
  }

  const {
    project: p, purchase_orders: pos, payment_stages: stages,
    onboarding, onboarding_progress: progress, travel, quotations, milestones = [],
    travel_invoices: travelInvoices = [],
  } = data.data;

  // Raising the invoice that bills a trip is admin's and sales' (#214
  // §9.3). HR keeps the trips and the agency's bills and never raises a
  // client invoice; the route refuses them whatever is drawn here.
  const mayRaiseTravel = mayRaiseTravelInvoice({ isAdmin, isHr });

  // One currency across every PO on the project, or null when they differ.
  const mixed = p.po_count > 0 && !p.currency;
  const amount = (v) => (mixed ? '—' : money(v, p.currency || 'INR'));

  const close = () => setDialog(null);
  const done = () => { close(); refetch(); };

  async function applyTemplate() {
    setBusy(true);
    try {
      const result = await api.action(`/projects/${encodeURIComponent(projectId)}/onboarding/apply-template`, {
        owner: p.project_manager,
        owner_email: p.project_manager_email,
      });
      toast(result.added ? `Added ${result.added} steps` : 'Checklist already applied', result.added ? 'success' : 'default');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function toggleStep(step) {
    const next = step.status === 'Done' ? 'Not Started' : 'Done';
    try {
      await api.update('onboarding', step.id, {
        status: next,
        completed_date: next === 'Done' ? new Date().toISOString().slice(0, 10) : null,
      });
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  /** "Not needed" and back again: the step's own status, N/A or not started (G1-6). */
  async function skipStep(step, needed) {
    setBusy(true);
    try {
      await api.update('onboarding', step.id, { status: needed ? 'Not Started' : 'N/A' });
      toast(needed ? `Step ${step.step_no} is needed again` : `Step ${step.step_no} marked not needed`, 'success');
      done();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  /** Reaching a milestone makes the stages it triggers billable (#26). */
  async function markMilestone(m, reached, on = today()) {
    setBusy(true);
    try {
      await api.update('project-milestones', m.id, { reached_on: reached ? on : null });
      toast(reached ? `${m.name} reached${m.stages.length ? ': its stages can be invoiced' : ''}` : `${m.name} marked not reached`, 'success');
      done();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function deleteStep(step) {
    setBusy(true);
    try {
      await api.remove('onboarding', step.id);
      toast('Step removed', 'success');
      done();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  // A lifecycle stage is done when every step under it is. Stages the
  // template never used are left out rather than drawn as a gap.
  const used = LIFECYCLE.filter((stage) => onboarding.some((s) => s.stage === stage));
  const ladder = flowSteps(used.map((stage) => {
    const steps = onboarding.filter((s) => s.stage === stage && s.effective_status !== 'N/A');
    return { label: stage, done: steps.length > 0 && steps.every((s) => s.effective_status === 'Done') };
  }));

  // What recording the delivery date would actually do, in money.
  const unlocked = stages
    .filter((s) => s.trigger_event === 'On Delivery' && !s.invoice_no)
    .reduce((sum, s) => sum + Number(s.stage_amount || 0), 0);
  const unlockedPos = [...new Set(stages.filter((s) => s.trigger_event === 'On Delivery' && !s.invoice_no).map((s) => s.po_number))];

  const verdict = p.actual_delivery_date
    ? `Delivered ${shortDate(p.actual_delivery_date)}${p.delivery_variance_days > 0 ? `, ${p.delivery_variance_days} days after the plan` : ''}. ${p.balance_due_now > 0 ? `${amount(p.balance_due_now)} is still owed.` : 'Nothing is owed.'}`
    : unlocked > 0
      ? `Recording the delivery date closes the delivery step and makes ${amount(unlocked)} of on-delivery stages billable.`
      : 'Recording the delivery date closes the delivery step. No stage is triggered by delivery, so nothing becomes billable with it.';

  const stepFields = checklistFields(onboarding, lookups);
  const nextStepNo = onboarding.reduce((max, s) => Math.max(max, Number(s.step_no) || 0), 0) + 1;
  const skipped = onboarding.filter((s) => s.effective_status === 'N/A').length;
  const partners = [...new Set(pos.map((po) => po.partner_name).filter(Boolean))];
  const travelTotal = Number(p.total_travel_cost || 0);

  const tabs = [
    { key: 'checklist', label: 'Checklist', count: onboarding.length || undefined },
    { key: 'orders', label: 'Milestones and orders', count: milestones.length + pos.length || undefined },
    { key: 'deliverables', label: 'Certificates and visits' },
    { key: 'money', label: 'Margin and costs' },
    { key: 'activity', label: 'Activity' },
  ];
  /** A derived step points at the record that answers it: the project's (first) PO. */
  const derivedLink = pos.length ? () => ({ to: `/purchase-orders/${encodeURIComponent(pos[0].po_number)}`, label: 'Open PO' }) : null;

  return (
    <>
      <RecordPage
        parent="Projects"
        parentTo="/projects"
        crumb={`${p.project_id} · ${p.client_name}`}
        eyebrow={`Project · ${p.project_id}`}
        title={`${p.project_id} · ${p.client_name}`}
        mark={<FolderKanban className="size-5" strokeWidth={1.75} aria-hidden="true" />}
        /* The stage, not the money: this project is "In progress" even
           when an invoice on it is overdue. Late money is red in the
           figures below, where it belongs. */
        badges={(
          <>
            <Chip tone={p.actual_delivery_date ? 'settled' : 'plain'}>{p.project_stage === 'In Progress' ? 'In progress' : p.project_stage === 'Not Started' ? 'Not started' : p.project_stage}</Chip>
            {partners.map((name) => <Chip key={`partner-${name}`}>Through {name}</Chip>)}
          </>
        )}
        factsGrid={[
          { label: 'Service', value: p.primary_service },
          { label: 'Project manager', value: p.project_manager },
          p.actual_delivery_date
            ? { label: 'Planned delivery', value: p.planned_delivery_date ? shortDate(p.planned_delivery_date) : null }
            : { label: 'Planned start', value: p.planned_start_date ? shortDate(p.planned_start_date) : null },
          p.actual_delivery_date
            ? { label: 'Delivered', value: shortDate(p.actual_delivery_date) }
            : { label: 'Planned delivery', value: p.planned_delivery_date ? shortDate(p.planned_delivery_date) : null },
          { label: '% complete', value: `${Math.round(Number(p.percent_complete || 0) * 100)}%` },
          { label: 'Service request no.', value: p.service_request_no },
          { label: 'Manager email', value: p.project_manager_email ? <a href={`mailto:${p.project_manager_email}`}>{p.project_manager_email.split('@')[0]}<wbr />@{p.project_manager_email.split('@').slice(1).join('@')}</a> : null },
        ]}
        /* No button in the header: the one move this page offers is in the
           band below, next to the sentence explaining what it will do. */
        menu={(
          <>
            <RecordMenuItem onSelect={() => setDialog({ type: 'newPo' })}>Add a purchase order</RecordMenuItem>
            <RecordMenuItem onSelect={() => setDialog({ type: 'newStep' })}>Add a checklist step</RecordMenuItem>
            <RecordMenuItem onSelect={() => setDialog({ type: 'edit' })}>Edit the project</RecordMenuItem>
          </>
        )}
        flow={(
          <RecordFlow
            className="is-row"
            steps={ladder}
            verdict={verdict}
            actions={p.actual_delivery_date
              ? <Button variant="secondary" onClick={() => setDialog({ type: 'edit' })}>Edit the project</Button>
              : <Button onClick={() => setDialog({ type: 'delivery' })}>Record the delivery date</Button>}
            note={progress?.total
              ? `Onboarding · ${progress.done} of ${progress.total} done${progress.left ? ` · ${progress.left} left` : ''}${progress.waiting ? `, ${progress.waiting} of them with another team` : ''}.${skipped ? ` ${count(skipped, 'step')} ${skipped === 1 ? 'is' : 'are'} marked not needed.` : ''}`
              : 'No checklist on this project yet.'}
          />
        )}
        stats={(
          <>
            {/* Sums across the project's POs, so they only read in one
                currency; when the POs disagree the amount is withheld. */}
            <RecordStat
              label="Contract"
              value={amount(p.total_contract_value)}
              detail={mixed ? 'Orders in different currencies' : Number(p.total_invoiced) > 0 ? `${amount(p.total_invoiced)} invoiced` : 'Nothing invoiced yet'}
            />
            <RecordStat
              label="Due now"
              value={amount(p.balance_due_now)}
              tone={mixed ? undefined : p.balance_due_now > 0 ? 'late' : 'settled'}
              detail={mixed ? 'Orders in different currencies' : p.balance_due_now > 0 ? 'Invoiced and unpaid' : p.payment_status}
            />
            <RecordStat
              label="To bill"
              value={amount(p.balance_to_bill)}
              tone={!mixed && p.balance_to_bill > 0 ? 'waiting' : undefined}
              detail={mixed ? 'Orders in different currencies' : p.balance_to_bill > 0 ? 'Stages billable now, not yet invoiced' : 'Everything billable is invoiced'}
            />
            <RecordStat
              label="Travel so far"
              value={money(travelTotal)}
              detail={travel.length ? `${count(travel.length, 'trip')} · always in INR` : 'Nobody has travelled yet'}
            />
          </>
        )}
        bodyClassName="app-w6"
        rail={(
          <>
            <RailCard title="Trips" hint={travel.length ? `${money(travelTotal)} so far` : undefined}>
              {travel.length === 0
                ? <p className="app-w6card__note">No travel recorded against this project. A trip billed to its PO, or with no PO and this project, shows here.</p>
                : <div className="pb-2">{travel.map((t) => (
                  <RailLink
                    key={t.travel_id}
                    to={`/travel/${encodeURIComponent(t.travel_id)}`}
                    icon={Plane}
                    label={`Open trip ${t.travel_id} · ${t.employee_name}`}
                    title={`${t.travel_id} · ${t.employee_name}`}
                    sub={<StateBadge map={TRIP_BILL} value={t.vendor_invoice_status} />}
                    end={Number(t.total_travel_cost) ? money(t.total_travel_cost) : '—'}
                  />
                ))}</div>}
            </RailCard>

            <RailCard title="People">
              <div className="pb-2">
                <RailPerson name={p.project_manager || 'Not assigned'} detail="Project manager" />
                <RailPerson name={p.sales_person || 'Not recorded'} detail="Sold it" last />
              </div>
            </RailCard>

            {quotations.length > 0 && (
              <RailCard title="Quoted as">
                {quotations.map((q) => (
                  <RailLink key={q.quotation_no} to={`/quotations/${encodeURIComponent(q.quotation_no)}`} icon={FileText} title={q.quotation_no} end={money(q.quotation_value, q.currency)} />
                ))}
                {p.remarks && <p className="app-w6card__text pt-2">Remarks: {p.remarks}</p>}
              </RailCard>
            )}
          </>
        )}
      >
        <TabsPanel id="prj" label={`${p.project_id}: checklist, orders and more`} tabs={tabs} active={tab} onChange={setTab}>
          {tab === 'checklist' && (
            <Sec
              id="prj-check"
              title="Checklist"
              hint={onboarding.length ? 'The standard eleven, from the template' : undefined}
              tools={onboarding.length === 0
                ? <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={applyTemplate} disabled={busy}>Add the standard checklist</button>
                : <button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'newStep' })}><Plus className="size-4" strokeWidth={2} aria-hidden="true" />Add a step</button>}
            >
              {onboarding.length === 0 ? (
                <StateCard inPanel bordered={false} tone="plain" icon={ClipboardList} title="No checklist yet"
                  text="The standard checklist is eleven steps, four of which answer themselves from the purchase orders and the payment schedule." />
              ) : (
                <Checklist
                  steps={onboarding}
                  onToggle={toggleStep}
                  onEdit={(step) => setDialog({ type: 'editStep', row: step })}
                  onSkip={(step) => (step.effective_status === 'N/A' ? skipStep(step, true) : setDialog({ type: 'skipStep', row: step }))}
                  onDelete={(step) => setDialog({ type: 'deleteStep', row: step })}
                  link={derivedLink}
                />
              )}
            </Sec>
          )}

          {tab === 'orders' && (
            <>
              <Sec
                id="prj-ms"
                title="Milestones"
                hint="Reaching one makes the payment stages it triggers billable"
                tools={<button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'milestone' })}><Plus className="size-4" strokeWidth={2} aria-hidden="true" />Add a milestone</button>}
              >
                {milestones.length === 0 ? (
                  <p className="app-tabnote">No milestones. A payment stage triggered On milestone gets its milestone when the PO is registered; add any other here.</p>
                ) : (
                  <div>
                    {milestones.map((m) => {
                      const waiting = m.stages.filter((s) => !s.invoice_no).reduce((n, s) => n + Number(s.stage_amount || 0), 0);
                      return (
                        <div key={m.id} className="app-line">
                          <span className={`app-line__mark ${m.reached_on ? 'is-ok' : waiting > 0 ? 'is-wait' : ''}`}><Flag strokeWidth={1.8} aria-hidden="true" /></span>
                          <div className="app-line__text">
                            <span className="app-line__title">{m.name}</span>
                            <span className="app-line__meta">
                              {[m.target_date && `Target ${shortDate(m.target_date)}`,
                                m.stages.length ? `Triggers ${m.stages.map((s) => `${s.stage_name} on PO ${s.po_number}`).join(', ')}` : 'No payment stage waits on it'].filter(Boolean).join(' · ')}
                            </span>
                          </div>
                          <div className="app-line__end">
                            {m.reached_on
                              ? <Tone tone="ok">Reached {shortDate(m.reached_on)}</Tone>
                              : waiting > 0 ? <Tone tone="wait">{amount(waiting)} waiting on it</Tone> : <Tone>Not reached</Tone>}
                            {m.reached_on
                              ? <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" disabled={busy} onClick={() => markMilestone(m, false)}>Not reached</button>
                              : <button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'reach', row: m, on: today() })}>Mark reached</button>}
                            <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Edit milestone ${m.name}`} onClick={() => setDialog({ type: 'milestone', row: m })}>Edit</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Sec>

              <Sec
                id="prj-pos"
                title="Purchase orders"
                hint="Stages, invoices and payments live on the order"
                tools={<button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'newPo' })}><Plus className="size-4" strokeWidth={2} aria-hidden="true" />Add an order</button>}
              >
                {pos.length === 0 ? (
                  <p className="app-tabnote">No purchase order yet, so nothing can be invoiced. Register it and the advance stage becomes billable.</p>
                ) : (
                  <div>
                    {pos.map((po) => (
                      <div key={po.po_number} className="app-line">
                        <span className="app-line__mark"><ClipboardList strokeWidth={1.8} aria-hidden="true" /></span>
                        <div className="app-line__text">
                          <Link className="app-line__title" to={`/purchase-orders/${encodeURIComponent(po.po_number)}`}>PO {po.po_number} · {count(po.stage_count, 'stage')}</Link>
                          <span className="app-line__meta">{[po.po_date && `Registered ${shortDate(po.po_date)}`, `${po.payment_terms_days ?? 30} days terms`, po.currency !== 'INR' && po.currency].filter(Boolean).join(' · ')}</span>
                        </div>
                        <div className="app-line__end">
                          <span className="app-line__amount">{money(po.po_value, po.currency)}</span>
                          {po.balance_due_now > 0
                            ? <Tone tone="late">{money(po.balance_due_now, po.currency)} due</Tone>
                            : po.balance_to_bill > 0 ? <Tone tone="wait">{money(po.balance_to_bill, po.currency)} to bill</Tone>
                              : <Tone tone="ok">Settled</Tone>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Sec>

              {/* Beside the orders and never inside them: travel billed on
                  this project carries its own printed amount, takes no stage
                  number, and is left out of every figure the PO's split
                  answers (097, #214 §5.4). A project with no PO can have one
                  too, which is the whole point of the kind. */}
              <TravelInvoicesSection
                flat
                showPo
                invoices={travelInvoices}
                action={mayRaiseTravel ? (
                  <button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'travel-invoice' })}>
                    <Plus className="size-4" strokeWidth={2} aria-hidden="true" />Raise travel invoice
                  </button>
                ) : undefined}
              />
            </>
          )}

          {tab === 'deliverables' && (
            <>
              <DeliverablesTable
                flat
                params={{ project_id: projectId }}
                preset={{ project_id: projectId }}
                compact
                title="Certificates and reports"
                hint="An expiry date schedules the renewal and its reminders"
                newLabel="Issue a certificate or report"
              />
              <ProjectVisits projectId={projectId} flat />
            </>
          )}

          {tab === 'money' && <ProjectProfit projectId={projectId} />}

          {tab === 'activity' && <Timeline entity="project" id={projectId} flat />}
        </TabsPanel>
      </RecordPage>

      {dialog?.type === 'travel-invoice' && (
        <RaiseTravelInvoiceDialog
          scope={{ projectId: p.project_id, poNumber: null, trips: travel }}
          onClose={close}
          onDone={done}
        />
      )}

      {dialog?.type === 'milestone' && (
        <RecordForm
          title={dialog.row ? 'Edit milestone' : 'Add a milestone'}
          subtitle={dialog.row ? `${dialog.row.name} · ${p.project_id}` : `For ${p.project_id} — ${p.client_name}`}
          submitLabel={dialog.row ? undefined : 'Add milestone'}
          resource="project-milestones"
          record={dialog.row || { project_id: p.project_id, sort_order: milestones.length }}
          intro={dialog.row ? 'There is no delete: a milestone a payment stage waits on stays. Rename it or change its date instead.' : undefined}
          onClose={close}
          onSaved={refetch}
          fields={[
            { name: 'project_id', type: 'hidden' },
            { name: 'name', label: 'Milestone', required: true, span: 2, placeholder: 'Stage 1 audit complete' },
            { name: 'target_date', label: 'Target date', type: 'date' },
            { name: 'reached_on', label: 'Reached on', type: 'date', hint: 'Blank until it happens' },
          ]}
        />
      )}

      {dialog?.type === 'reach' && (() => {
        const m = dialog.row;
        const releases = m.stages.filter((s) => !s.invoice_no);
        return (
          <ConfirmDialog
            title={`Mark "${m.name}" reached?`}
            message={`${p.project_id} · ${p.client_name}`}
            confirmLabel="Mark reached"
            tone="primary"
            busy={busy}
            onConfirm={() => markMilestone(m, true, dialog.on || today())}
            onClose={close}
          >
            {releases.length > 0 && (
              <MoneyBanner tone="wait" title="This makes money billable.">
                {releases.map((s) => `${s.stage_name}, ${money(s.stage_amount, s.currency || p.currency || 'INR')} on PO ${s.po_number}`).join('; ')} becomes ready to invoice.
              </MoneyBanner>
            )}
            <label className="mg-field mt-3">
              <span className="mg-field__label">Reached on</span>
              <input className="mg-input" type="date" value={dialog.on || ''} max={today()} onChange={(e) => setDialog((d) => ({ ...d, on: e.target.value }))} />
              <span className="mg-field__hint">Today. Change it if it happened earlier.</span>
            </label>
          </ConfirmDialog>
        );
      })()}

      {dialog?.type === 'newStep' && (
        <RecordForm
          title="Add a checklist step"
          subtitle={`For ${p.project_id} — ${p.client_name}`}
          submitLabel="Add step"
          resource="onboarding"
          record={{
            project_id: p.project_id,
            step_no: nextStepNo,
            stage: 'Onboarding',
            status: 'Not Started',
            owner: p.project_manager,
            owner_email: p.project_manager_email,
          }}
          intro="A step you add is yours to tick, unless its wording is about the PO, invoices or payments: then it answers itself."
          onClose={close}
          onSaved={refetch}
          fields={stepFields}
        />
      )}

      {dialog?.type === 'editStep' && (
        <RecordForm
          title="Edit the step"
          subtitle={`Step ${dialog.row.step_no} of ${p.project_id}`}
          resource="onboarding"
          record={dialog.row}
          onClose={close}
          onSaved={refetch}
          fields={stepFields}
        />
      )}

      {dialog?.type === 'skipStep' && (
        <ConfirmDialog
          title={`Mark step ${dialog.row.step_no} as not needed?`}
          message={`"${dialog.row.step}" drops out of the count and shows struck through. Undo it from the same menu at any time: the step comes back as it was.`}
          confirmLabel="Mark not needed"
          tone="primary"
          busy={busy}
          onConfirm={() => skipStep(dialog.row, false)}
          onClose={close}
        />
      )}

      {dialog?.type === 'deleteStep' && (
        <ConfirmDialog
          title="Remove this step?"
          message={`"${dialog.row.step}" will be removed from ${p.project_id}. The checklist count will recalculate.`}
          confirmLabel="Remove step"
          busy={busy}
          onConfirm={() => deleteStep(dialog.row)}
          onClose={close}
        />
      )}

      {(dialog?.type === 'edit' || dialog?.type === 'delivery') && (
        <RecordForm
          title={dialog.type === 'delivery' ? 'Record the delivery date' : 'Edit project'}
          subtitle={`${p.project_id} · ${p.client_name}`}
          submitLabel={dialog.type === 'delivery' ? 'Record delivery' : undefined}
          size="lg"
          resource="projects"
          record={dialog.type === 'delivery' ? { ...p, actual_delivery_date: today() } : p}
          onClose={close}
          onSaved={refetch}
          intro={dialog.type === 'delivery'
            ? `${verdict.replace(/\.$/, '')}${unlockedPos.length ? ` on PO ${unlockedPos.join(', ')}` : ''}. Delivered on is today; change it if delivery was another day.`
            : undefined}
          fields={projectFields(lookups, { record: p })}
        />
      )}

      {dialog?.type === 'newPo' && (
        <RecordForm
          title="New purchase order"
          subtitle={`For ${p.project_id} — ${p.client_name}`}
          submitLabel="Add purchase order"
          size="lg"
          resource="purchase-orders"
          record={{
            project_id: p.project_id,
            currency: 'INR',
            payment_terms_days: 30,
            // With one won quotation on the project, that is the order this PO fulfils.
            quotation_no: quotations.filter((q) => q.status === 'Won - PO Received').length === 1
              ? quotations.find((q) => q.status === 'Won - PO Received').quotation_no
              : '',
          }}
          onClose={close}
          onSaved={refetch}
          intro="Once the PO date is set, any stage triggered On PO registration becomes invoiceable straight away."
          fields={[
            { name: 'po_number', label: 'PO number', required: true },
            { name: 'project_id', label: 'Project', required: true, disabled: true },
            {
              name: 'quotation_no',
              label: 'Won quotation',
              type: 'select',
              options: quotations
                .filter((q) => q.status === 'Won - PO Received')
                .map((q) => ({ value: q.quotation_no, label: `${q.quotation_no} — ${money(q.quotation_value, q.currency)}` })),
              hint: 'The order this PO fulfils; revenue counts the PO against it',
              span: 2,
              ...poCurrencyFields(quotations).quotation,
            },
            { name: 'po_date', label: 'PO date', type: 'date' },
            { name: 'po_value', label: 'PO value', type: 'money', required: true },
            { name: 'currency', label: 'Currency', type: 'select', options: lookups.enums?.currency || ['INR'], ...poCurrencyFields(quotations).currency },
            { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number' },
            { name: 'project_manager_email', label: 'Manager email', type: 'email' },
            { name: 'document_id', label: 'PO document', type: 'document', owner: 'purchase-orders', maxBytes: lookups.limits?.document_max_bytes, span: 2 },
            ...poRevisionFields(lookups.purchase_orders, { projectId: p.project_id }),
            { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
          ]}
        />
      )}
    </>
  );
}

function checklistFields(onboarding, lookups) {
  const stageOptions = Array.from(
    new Set([...LIFECYCLE, ...onboarding.map((s) => s.stage).filter(Boolean)])
  );
  const statuses = lookups.enums?.onboarding || ['Not Started', 'In Progress', 'Done', 'N/A'];
  return [
    { name: 'project_id', label: 'Project', required: true, disabled: true },
    { name: 'step_no', label: 'Step number', type: 'number', min: 1, required: true },
    { name: 'stage', label: 'Stage', type: 'combo', options: stageOptions },
    { name: 'status', label: 'Status', type: 'select', options: statuses.map((s) => ({ value: s, label: { 'Not Started': 'Not started', 'In Progress': 'In progress', 'N/A': 'Not needed' }[s] || s })) },
    { name: 'step', label: 'Step', required: true, type: 'textarea', rows: 2, span: 'all', placeholder: 'What has to happen', hint: 'Wording about the PO, invoices or payments makes a step answer itself from them, with no tick box.' },
    { name: 'owner', label: 'Owner' },
    { name: 'owner_email', label: 'Owner email', type: 'email' },
    { name: 'target_date', label: 'Target date', type: 'date' },
    { name: 'completed_date', label: 'Completed on', type: 'date' },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];
}
