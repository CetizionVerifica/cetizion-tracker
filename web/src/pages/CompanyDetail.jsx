import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle, FileText, FolderKanban, MessageSquare, Pencil, Plus, Receipt, UserPlus, Users,
} from 'lucide-react';
import { ConfirmDialog, Field, Modal, Select, useToast } from '../components/ui.jsx';
import { Chip, initialsOf, RecordMenuItem, RecordPage, RecordRow, RecordStat } from '../components/record.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { Timeline } from '../components/Timeline.jsx';
import { DeliverablesTable } from '../components/Deliverables.jsx';
import { PortalSettings } from '../components/PortalSettings.jsx';
import { PortalAnswers } from '../components/PortalAnswers.jsx';
import { PortalPreview } from '../components/PortalPreview.jsx';
import { plural } from '../components/daily.jsx';
import { RecordState } from '../components/travel.jsx';
import { RecordTabs, Sec, Tone, useTab } from '../components/sales.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { invalidateLookups, useFetch, useLookups } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';
import { quotationFields } from './Quotations.jsx';

/**
 * One client, on one page.
 *
 * This was eight tabs, which meant the answer to "what is going on with
 * Hindalco?" was in whichever of eight places you thought to look. The
 * design puts the four figures somebody asks before they pick up the
 * phone in one row — what they owe us, what we have won, what is open,
 * when we last spoke — merges deals and orders into a single list, because
 * the client thinks of them as one relationship, and keeps the people
 * beside the tabs (above them on a narrow screen), not at the very bottom.
 */

const OPEN_STATUSES = new Set(['Draft', 'Submitted', 'Under Negotiation', 'On Hold']);

/** The status of a deal or order, as a word with a colour behind it. Partly paid waits. */
function toneFor(status) {
  if (/overdue|lost|reject|unqualified/i.test(status)) return 'late';
  if (/to invoice|negotiation|submitted|hold|pending|part|draft/i.test(status)) return 'waiting';
  if (/paid|won|valid|complete|converted/i.test(status)) return 'settled';
  return 'plain';
}

/** Deals, enquiries and orders in one list, newest first, each saying what it is and when. */
function relationship(c) {
  const rows = [
    ...c.enquiries.map((e) => ({
      key: `e${e.id}`, when: e.enquiry_date, icon: MessageSquare,
      title: e.service || 'Enquiry', meta: `Enquiry · ${e.enquiry_no}${e.enquiry_date ? ` · ${date(e.enquiry_date)}` : ''}`,
      status: e.status, amount: e.estimated_value ? money(e.estimated_value, e.currency, { compact: true }) : '—',
      to: `/enquiries?q=${encodeURIComponent(e.enquiry_no)}`, muted: /lost|closed|unqualified/i.test(e.status || ''),
    })),
    ...c.quotations.map((q) => ({
      key: `q${q.id}`, when: q.quotation_date, icon: FileText,
      title: q.service_quoted || q.quotation_no, meta: `Quotation · ${q.quotation_no}${q.quotation_date ? ` · ${date(q.quotation_date)}` : ''}`,
      status: q.approval_status === 'pending' ? 'Discount waiting' : q.approval_status === 'rejected' ? 'Discount rejected' : q.status,
      amount: money(q.quotation_value, q.currency, { compact: true }),
      to: `/quotations/${encodeURIComponent(q.quotation_no)}`,
      muted: /lost/i.test(q.status || ''),
    })),
    ...c.purchase_orders.map((p) => ({
      key: `p${p.id}`, when: p.po_date, icon: Receipt,
      title: <>{p.po_number}{p.project_id ? ` · ${p.project_id}` : ''}</>,
      meta: `Purchase order${p.po_date ? ` · ${date(p.po_date)}` : ''}`,
      status: p.payment_status, amount: money(p.po_value, p.currency, { compact: true }),
      to: `/purchase-orders/${encodeURIComponent(p.po_number)}`,
    })),
  ];
  return rows.sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')));
}

export default function CompanyDetail() {
  const { isAdmin } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const lookups = useLookups();
  const [editing, setEditing] = useState(null);
  const [contact, setContact] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [newDeal, setNewDeal] = useState(false);
  const [merge, setMerge] = useState(false);
  const [into, setInto] = useState('');
  const [busy, setBusy] = useState(false);

  const { data, loading, fresh: current, error, errorStatus, refetch } = useFetch(() => api.raw(`/companies/${id}/full`), [id]);
  const c = data?.data;
  // The portal switches are an admin's (the route is admin-only).
  const portal = useFetch(() => (isAdmin ? api.raw(`/portal-admin/companies/${id}`) : Promise.resolve(null)), [id, isAdmin]);
  const portalOn = portal.data?.data?.portal_enabled;

  const tabKeys = ['deals', 'projects', 'certificates', 'activity', ...(isAdmin ? ['portal', 'preview'] : [])];
  const [tab, setTab] = useTab(tabKeys);

  async function deleteContact() {
    setBusy(true);
    try { await api.remove('contacts', removing.id); toast(`${removing.name} removed`, 'success'); setRemoving(null); refetch(); }
    catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }

  async function doMerge() {
    setBusy(true);
    try {
      const { data: r } = await api.action(`/companies/${id}/merge`, { into });
      toast(`${r.merged} merged into ${r.into}`, 'success');
      invalidateLookups();
      setMerge(false);
      navigate(`/companies/${into}`);
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }

  if (error) {
    return <RecordState parent="Companies" parentTo="/companies" crumb={`#${id}`} noun="company" missing={errorStatus === 404} error={error} onRetry={refetch} />;
  }
  if ((loading && !current) || !c) {
    return (
      <div className="app-page" aria-busy="true" aria-label="Loading the company">
        <div className="app-rec__bar"><span className="mg-skel" style={{ height: 14, width: 160 }} /></div>
        <div className="mg-glass mg-glass--strong mg-record"><span className="mg-skel" style={{ height: 32, width: '45%' }} /><span className="mg-skel" style={{ height: 44 }} /></div>
        <div className="app-rec__stats">{[0, 1, 2, 3].map((i) => <div key={i} className="mg-glass mg-tile"><span className="mg-skel" style={{ height: 12, width: '50%' }} /><span className="mg-skel" style={{ height: 30 }} /></div>)}</div>
        <div className="mg-glass mg-glass--strong app-flow"><span className="mg-skel" style={{ height: 220 }} /></div>
      </div>
    );
  }

  const contactFields = [
    { name: 'company_id', type: 'hidden', default: c.id },
    { name: 'name', label: 'Name', required: true },
    { name: 'role', label: 'Role' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'phone', label: 'Phone' },
    { name: 'whatsapp_number', label: 'WhatsApp number', hint: 'If different from the phone' },
    { name: 'preferred_channel', label: 'Prefers', type: 'select', options: ['email', 'call', 'whatsapp', 'meeting'] },
    { name: 'best_time_to_call', label: 'Best time to call' },
    { name: 'do_not_contact', label: 'Contact from the app', type: 'boolean', trueLabel: 'Do not contact', falseLabel: 'Allowed', default: 'false' },
    { name: 'whatsapp_opt_in_at', label: 'WhatsApp opt-in on', type: 'date' },
    { name: 'whatsapp_opt_in_source', label: 'Opt-in source', hint: 'e.g. email reply, signed form' },
    { name: 'is_billing', label: 'Billing contact', type: 'boolean', hint: 'Receives payment reminders', default: 'false' },
    { name: 'opt_out_reminders', label: 'Automatic reminders', type: 'boolean', trueLabel: 'Never send', falseLabel: 'Allowed', default: 'false' },
    { name: 'notes', label: 'Notes', type: 'textarea', span: 'all' },
  ];
  const companyFields = [
    { name: 'name', label: 'Company name', required: true, span: 2, hint: 'Renaming here renames the client on every record' },
    { name: 'sector', label: 'Sector', type: 'combo', options: lookups.sectors, hint: 'Pick from the list, or type a new sector' },
    { name: 'city', label: 'City' },
    { name: 'gstin', label: 'GSTIN' },
    { name: 'website', label: 'Website' },
    { name: 'address', label: 'Address', type: 'textarea', span: 'all' },
    { name: 'notes', label: 'Notes', type: 'textarea', span: 'all' },
  ];

  const won = c.quotations.filter((q) => /won/i.test(q.status || ''));
  const open = c.quotations.filter((q) => OPEN_STATUSES.has(q.status));
  const total = (rows, key) => rows.reduce((sum, row) => sum + Number(row[key] || 0), 0);
  const rows = relationship(c);
  const main = c.contacts.find((p) => p.is_billing) || c.contacts[0];
  const since = c.created_at ? new Date(c.created_at).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : null;
  const owed = Number(c.outstanding) > 0;
  const fresh = !c.enquiries.length && !c.quotations.length && !c.purchase_orders.length && !c.projects.length;

  const TABS = [
    { key: 'deals', label: 'Deals and orders', count: rows.length },
    { key: 'projects', label: 'Projects', count: c.projects.length },
    { key: 'certificates', label: 'Certificates' },
    { key: 'activity', label: 'Activity' },
    ...(isAdmin ? [{ key: 'portal', label: 'Client portal' }, { key: 'preview', label: 'Preview as client' }] : []),
  ];

  const people = (
    <section className="mg-glass mg-glass--strong mg-panel" aria-labelledby="people-title" data-a="rise" style={{ borderRadius: 26 }}>
      <div className="app-sec__head">
        <h2 id="people-title" className="mg-panel__title">People</h2>
        <span className="mg-count">{c.contacts.length}</span>
        <div className="app-sec__tools"><button type="button" className="mg-btn mg-btn--sm" onClick={() => setContact('new')}><UserPlus className="size-4" aria-hidden="true" />Add a contact</button></div>
      </div>
      {c.contacts.length === 0 ? (
        <p className="m-0 text-[12.5px] text-muted-foreground">Nobody yet. A contact is created whenever a name is typed on a quotation or an enquiry, or add one here.</p>
      ) : (
        <div className="app-people">
          {c.contacts.map((person) => (
            <button key={person.id} type="button" className="app-person" onClick={() => setContact(person)} aria-label={`Edit contact ${person.name}`}>
              <span className="mg-avatar" aria-hidden="true">{initialsOf(person.name)}</span>
              <span className="app-person__text">
                <b>{person.name}</b>
                <span>{[person.role, person.preferred_channel && `prefers ${person.preferred_channel === 'call' ? 'a call' : person.preferred_channel}`, !person.email && 'no email yet'].filter(Boolean).join(' · ') || 'No role noted'}</span>
              </span>
              {person.do_not_contact ? <Tone tone="late">Do not contact</Tone> : person.is_billing ? <Tone tone="info">Billing</Tone> : null}
            </button>
          ))}
        </div>
      )}
    </section>
  );

  const dealsTab = (
    <Sec id="co-deals" title="Deals and orders" hint="enquiries, quotations and purchase orders, newest first" tools={<button type="button" className="mg-btn mg-btn--sm" onClick={() => setNewDeal(true)}><Plus className="size-4" aria-hidden="true" />New deal</button>}>
      {rows.length === 0 ? (
        <div className="mg-empty app-box">
          <span className="mg-empty__mark"><FileText className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
          <h4 className="mg-empty__title">Nothing quoted or ordered yet</h4>
          <p className="mg-empty__text">{c.name} is new here. Start with a deal; its enquiry, quotation and order will all show in this list.</p>
          <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={() => setNewDeal(true)}><Plus className="size-4" aria-hidden="true" />New deal</button>
        </div>
      ) : (
        <div>
          {rows.map((row, i) => (
            <RecordRow
              key={row.key}
              icon={row.icon}
              to={row.to}
              title={row.title}
              meta={row.meta}
              muted={row.muted}
              last={i === rows.length - 1}
              amount={row.amount ?? '—'}
              chip={row.status ? (
                <Chip tone={toneFor(row.status)} icon={/overdue/i.test(row.status) ? AlertTriangle : undefined}>
                  {row.status}
                </Chip>
              ) : null}
            />
          ))}
        </div>
      )}
    </Sec>
  );

  const projectsTab = (
    <Sec id="co-projects" title="Projects" hint="delivery, not sales">
      {c.projects.length === 0 ? (
        <div className="mg-empty app-box">
          <span className="mg-empty__mark"><FolderKanban className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
          <h4 className="mg-empty__title">No projects yet</h4>
          <p className="mg-empty__text">A project opens when a deal is won and created as one.</p>
        </div>
      ) : (
        <div>
          {c.projects.map((project, i) => (
            <RecordRow
              key={project.id}
              icon={FolderKanban}
              to={`/projects/${encodeURIComponent(project.project_id)}`}
              title={project.primary_service || 'No service named'}
              meta={`${project.project_id}${project.planned_delivery_date ? ` · due ${date(project.planned_delivery_date)}` : ''}`}
              last={i === c.projects.length - 1}
              amount={project.percent_complete != null ? `${project.percent_complete}%` : '—'}
              chip={project.project_stage ? <Chip tone={toneFor(project.project_stage)}>{project.project_stage}</Chip> : null}
            />
          ))}
        </div>
      )}
    </Sec>
  );

  return (
    <>
      <RecordPage
        parent="Companies"
        parentTo="/companies"
        eyebrow={`Company${since ? ` · since ${since}` : ''}`}
        title={c.name}
        badges={(owed || portalOn != null || fresh) && <>
          {owed && <Tone tone="wait">Owes {money(c.outstanding)}</Tone>}
          {portalOn === true && <Tone tone="ok">Portal on</Tone>}
          {portalOn === false && <Tone tone="plain">Portal off</Tone>}
          {fresh && <Tone tone="info">New client</Tone>}
        </>}
        factsGrid={[
          { label: 'Sector', value: c.sector },
          { label: 'City', value: c.city },
          { label: 'GSTIN', value: c.gstin },
          { label: 'Website', value: c.website && <a href={/^https?:/.test(c.website) ? c.website : `https://${c.website}`} target="_blank" rel="noopener noreferrer">{c.website.replace(/^https?:\/\//, '')}</a> },
          { label: 'Main contact', value: main?.name },
        ]}
        action={<>
          <button type="button" className="mg-btn mg-btn--primary" onClick={() => setNewDeal(true)}><Plus className="size-4" strokeWidth={2} aria-hidden="true" />New deal</button>
          <button type="button" className="mg-btn" onClick={() => setEditing(c)}><Pencil className="size-4" strokeWidth={1.8} aria-hidden="true" />Edit</button>
        </>}
        menu={
          <>
            <RecordMenuItem onSelect={() => setContact('new')}><UserPlus aria-hidden="true" />Add a contact</RecordMenuItem>
            <RecordMenuItem onSelect={() => navigate(`/quotations?q=${encodeURIComponent(c.name)}`)}><FileText aria-hidden="true" />See its deals in Deals</RecordMenuItem>
            {isAdmin && <RecordMenuItem danger onSelect={() => setMerge(true)}><Users aria-hidden="true" />Merge into another company…</RecordMenuItem>}
          </>
        }
        stats={
          <>
            <RecordStat
              label="Owed to us"
              value={money(c.outstanding, 'INR')}
              tone={owed ? 'late' : undefined}
              detail={owed ? 'Invoiced and not yet received' : 'Nothing outstanding'}
            />
            <RecordStat
              label="Won"
              value={money(total(won, 'quotation_value_inr') || total(won, 'quotation_value'), 'INR')}
              detail={`${plural(won.length, 'deal')} · ${plural(c.purchase_orders.length, 'order')}`}
            />
            <RecordStat
              label="Open pipeline"
              value={money(total(open, 'quotation_value_inr') || total(open, 'quotation_value'), 'INR')}
              tone={open.length ? 'waiting' : undefined}
              detail={open.length ? `${plural(open.length, 'deal')} still live` : 'Nothing open'}
            />
            <RecordStat
              label="Last contact"
              value={c.last_contacted_at ? date(c.last_contacted_at) : 'Never'}
              tone={c.last_contacted_at ? undefined : 'waiting'}
              detail={c.last_activity ? date(c.last_activity) === date(c.last_contacted_at) ? 'Logged on this record' : `Last change ${date(c.last_activity)}` : 'Nobody has logged a call or a meeting'}
            />
          </>
        }
        rail={people}
        railFirst
      >
        <section className="mg-glass mg-glass--strong app-tabpanel" data-a="rise" aria-label={`${c.name}: deals, projects and more`}>
          <RecordTabs id="co" label="The company" tabs={TABS} active={tab} onChange={setTab} />
          <div className="app-tabbody" id="co-panel" role="tabpanel" aria-labelledby={`co-tab-${tab}`}>
            {tab === 'deals' && dealsTab}
            {tab === 'projects' && projectsTab}
            {tab === 'certificates' && (
              <DeliverablesTable
                flat
                params={{ company_id: c.id }}
                preset={{ company_id: String(c.id) }}
                compact
                title="Certificates"
                hint="What this client holds. A renewal deal is created 90 days before expiry."
              />
            )}
            {/* The one place activity lives: the full timeline from #22 —
                notes, tasks, files, logged calls — not a second read-only copy. */}
            {tab === 'activity' && <Timeline entity="company" id={id} flat />}
            {tab === 'portal' && isAdmin && <PortalAnswers companyId={c.id} />}
            {tab === 'portal' && isAdmin && <PortalSettings companyId={c.id} companyName={c.name} portal={portal} />}
            {tab === 'preview' && isAdmin && <PortalPreview companyId={c.id} companyName={c.name} enabled={portal.data?.data?.portal_sections} />}
          </div>
        </section>
      </RecordPage>

      {editing && (
        <RecordForm
          title="Edit company"
          subtitle="Renaming renames the client on every record."
          resource="companies"
          record={editing}
          fields={companyFields}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); invalidateLookups(); refetch(); }}
        />
      )}
      {newDeal && (
        // A new deal for this client: the form opens with the client, its
        // sector and the main contact already filled in.
        <RecordForm
          title="New deal"
          subtitle={`For ${c.name}. Price it as lines on the deal page once it exists.`}
          size="lg"
          resource="quotations"
          record={{ client_name: c.name, sector: c.sector || '', contact_person: main?.name || '', contact_email: main?.email || '', contact_phone: main?.phone || '' }}
          fields={quotationFields(lookups)}
          submitLabel="Create deal"
          onClose={() => setNewDeal(false)}
          onSaved={(saved) => { setNewDeal(false); invalidateLookups(); refetch(); if (saved?.quotation_no) navigate(`/quotations/${encodeURIComponent(saved.quotation_no)}`); }}
        />
      )}
      {contact && (
        <RecordForm
          title={contact === 'new' ? 'New contact' : 'Edit contact'}
          subtitle={contact === 'new' ? `Someone at ${c.name}.` : `${contact.name} at ${c.name}.`}
          resource="contacts"
          record={contact === 'new' ? null : contact}
          fields={contactFields}
          onClose={() => setContact(null)}
          onSaved={() => { setContact(null); refetch(); }}
          // Adding a contact and correcting one is ordinary work; removing one is
          // not (#85). A contact is named on every quotation and enquiry that ever
          // used it, so contacts is adminOnlyDeletes on the server. The dialog's
          // Remove is the only way in, so the gate belongs here.
          extraAction={isAdmin && contact !== 'new' && (
            <button type="button" className="mg-btn mg-btn--ghost mr-auto text-late" onClick={() => { setRemoving(contact); setContact(null); }}>Remove contact</button>
          )}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          message={`${removing.name} will no longer be offered on ${c.name}'s records. Deals and enquiries that named them keep the name.`}
          confirmLabel="Remove contact"
          busy={busy}
          onClose={() => setRemoving(null)}
          onConfirm={deleteContact}
        />
      )}
      {merge && (
        <Modal
          size="sm"
          title="Merge into another company"
          subtitle={`Every record naming ${c.name} moves to the company you pick, and this one is deleted. It cannot be undone.`}
          onClose={() => setMerge(false)}
          footer={
            <>
              <button type="button" className="mg-btn mg-btn--ghost" onClick={() => setMerge(false)} disabled={busy}>Cancel</button>
              <button type="button" className="mg-btn mg-btn--danger" disabled={!into || busy} onClick={doMerge}>{busy ? 'Merging…' : 'Merge'}</button>
              {!into && <span className="app-why">Pick the company to keep to merge.</span>}
            </>
          }
        >
          <Field label="The company to keep" required hint={`${c.name} takes its name.`}>
            <Select
              value={into}
              onChange={(e) => setInto(e.target.value)}
              placeholder="Pick the company to keep"
              options={(lookups.companies || []).filter((x) => String(x.id) !== String(id)).map((x) => ({ value: String(x.id), label: x.name }))}
            />
          </Field>
        </Modal>
      )}
    </>
  );
}
