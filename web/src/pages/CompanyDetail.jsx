import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, BadgeCheck, FileText, FolderKanban, MessageSquare, Receipt } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { ConfirmDialog, ErrorState, Modal, Select, useToast } from '../components/ui.jsx';
import { Chip, RailPerson, RecordMenuItem, RecordPage, RecordRow, RecordSection, RecordStat } from '../components/record.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { Timeline } from '../components/Timeline.jsx';
import { DeliverablesTable } from '../components/Deliverables.jsx';
import { PortalSettings } from '../components/PortalSettings.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { invalidateLookups, useFetch, useLookups } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';

/**
 * One client, on one page.
 *
 * This was eight tabs, which meant the answer to "what is going on with
 * Hindalco?" was in whichever of eight places you thought to look. The
 * design puts the four figures somebody asks before they pick up the
 * phone in one row — what they owe us, what we have won, what is open,
 * when we last spoke — and merges deals and orders into a single list,
 * because the client thinks of them as one relationship.
 */

const OPEN_STATUSES = new Set(['Draft', 'Submitted', 'Under Negotiation', 'On Hold']);

/** The status of a deal or order, as a word with a colour behind it. */
function toneFor(status) {
  if (/overdue|lost/i.test(status)) return 'late';
  if (/to invoice|negotiation|submitted|hold|pending/i.test(status)) return 'waiting';
  if (/paid|won|valid|complete/i.test(status)) return 'settled';
  return 'plain';
}

/** Deals, enquiries and orders in one list, newest first. */
function relationship(c) {
  const rows = [
    ...c.enquiries.map((e) => ({
      key: `e${e.id}`, when: e.enquiry_date, icon: MessageSquare,
      title: e.service || 'Enquiry', status: e.status, amount: null,
      to: '/enquiries', muted: /lost|closed/i.test(e.status || ''),
    })),
    ...c.quotations.map((q) => ({
      key: `q${q.id}`, when: q.quotation_date, icon: FileText,
      title: q.service_quoted || q.quotation_no, status: q.status,
      amount: money(q.quotation_value, q.currency, { compact: true }),
      to: `/quotations/${encodeURIComponent(q.quotation_no)}`,
      muted: /lost/i.test(q.status || ''),
    })),
    ...c.purchase_orders.map((p) => ({
      key: `p${p.id}`, when: p.po_date, icon: Receipt,
      title: <><span className="num text-[12px]">{p.po_number}</span>{p.project_id ? ` · ${p.project_id}` : ''}</>,
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
    { name: 'sector', label: 'Sector', type: 'combo', options: lookups.sectors },
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

  return (
    <>
      <RecordPage
        parent="Companies"
        parentTo="/companies"
        title={c.name}
        facts={[
          c.sector,
          c.city,
          c.gstin && <span className="num text-[12px]">GSTIN {c.gstin}</span>,
          c.website && (
            <a href={/^https?:/.test(c.website) ? c.website : `https://${c.website}`} target="_blank" rel="noopener noreferrer">
              {c.website}
            </a>
          ),
        ]}
        action={
          <button type="button" className="btn btn--primary" onClick={() => setEditing(c)}>Edit</button>
        }
        menu={
          <>
            <RecordMenuItem onSelect={() => navigate('/quotations')}>New deal for this client</RecordMenuItem>
            <RecordMenuItem onSelect={() => setContact('new')}>Add a contact</RecordMenuItem>
            {isAdmin && <RecordMenuItem onSelect={() => setMerge(true)}>Merge into another company…</RecordMenuItem>}
          </>
        }
        stats={
          <>
            <RecordStat
              label="Owed to us"
              value={money(c.outstanding, 'INR', { compact: true })}
              tone={Number(c.outstanding) > 0 ? 'late' : undefined}
              detail={Number(c.outstanding) > 0 ? 'Invoiced and not yet received' : 'Nothing outstanding'}
            />
            <RecordStat
              label="Won"
              value={money(total(won, 'quotation_value_inr') || total(won, 'quotation_value'), 'INR', { compact: true })}
              detail={`${won.length} deal${won.length === 1 ? '' : 's'} · ${c.purchase_orders.length} order${c.purchase_orders.length === 1 ? '' : 's'}`}
            />
            <RecordStat
              label="Open pipeline"
              value={money(total(open, 'quotation_value_inr') || total(open, 'quotation_value'), 'INR', { compact: true })}
              detail={open.length ? `${open.length} deal${open.length === 1 ? '' : 's'} still live` : 'Nothing open'}
            />
            <RecordStat
              label="Last contact"
              value={c.last_contacted_at ? date(c.last_contacted_at) : 'Never'}
              tone={c.last_contacted_at ? undefined : 'waiting'}
              detail={c.last_activity ? date(c.last_activity) === date(c.last_contacted_at) ? 'Logged on this record' : `Last change ${date(c.last_activity)}` : 'Nobody has logged a call or a meeting'}
            />
          </>
        }
        rail={
          <>
            <RecordSection
              title="People"
              action={<button type="button" className="text-[12.5px] font-medium text-primary" onClick={() => setContact('new')}>Add</button>}
            >
              {c.contacts.length === 0 ? (
                <p className="px-5 py-4 text-[12.5px] text-muted-foreground">
                  Nobody yet. A contact is created whenever a name is typed on a quotation or an enquiry.
                </p>
              ) : c.contacts.map((person, i) => (
                <button
                  key={person.id}
                  type="button"
                  onClick={() => setContact(person)}
                  className="block w-full text-left"
                >
                  <RailPerson
                    name={person.name}
                    detail={[person.role, person.is_billing && 'billing contact', person.do_not_contact && 'do not contact']
                      .filter(Boolean).join(' · ')}
                    last={i === c.contacts.length - 1}
                  />
                </button>
              ))}
            </RecordSection>

          </>
        }
      >
        <RecordSection title="Deals and orders" hint="newest first">
          {rows.length === 0 ? (
            <p className="px-5 py-4 text-[12.5px] text-muted-foreground">Nothing quoted or ordered yet.</p>
          ) : rows.map((row, i) => (
            <RecordRow
              key={row.key}
              icon={row.icon}
              to={row.to}
              title={row.title}
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
        </RecordSection>

        {c.projects.length > 0 && (
          <RecordSection title="Projects" hint="delivery, not sales">
            {c.projects.map((project, i) => (
              <RecordRow
                key={project.id}
                icon={FolderKanban}
                to={`/projects/${encodeURIComponent(project.project_id)}`}
                title={<><span className="num text-[12px]">{project.project_id}</span> · {project.primary_service || 'No service named'}</>}
                last={i === c.projects.length - 1}
                amount={project.percent_complete != null ? `${project.percent_complete}%` : '—'}
                chip={project.project_stage ? <Chip tone={toneFor(project.project_stage)}>{project.project_stage}</Chip> : null}
              />
            ))}
          </RecordSection>
        )}

        <DeliverablesTable
          params={{ company_id: c.id }}
          preset={{ company_id: String(c.id) }}
          compact
          title="Certificates"
          hint="What this client holds. A renewal deal is created 90 days before expiry."
        />

        {/* The one place activity lives.
            The mock puts a read-only "Recent" card in the rail, because the
            mock had nowhere else for it. This app has the full timeline
            from #22 — notes, tasks, files, logged calls — and showing the
            same events twice on one page is the kind of thing this
            redesign exists to remove. */}
        <Timeline entity="company" id={id} />

        {isAdmin && <PortalSettings companyId={c.id} />}
      </RecordPage>

      {editing && (
        <RecordForm
          title="Edit company"
          resource="companies"
          record={editing}
          fields={companyFields}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); invalidateLookups(); refetch(); }}
        />
      )}
      {contact && (
        <RecordForm
          title={contact === 'new' ? 'New contact' : 'Edit contact'}
          resource="contacts"
          record={contact === 'new' ? null : contact}
          fields={contactFields}
          onClose={() => setContact(null)}
          onSaved={() => { setContact(null); refetch(); }}
          // Adding a contact and correcting one is ordinary work; removing one is
          // not (#85). A contact is named on every quotation and enquiry that ever
          // used it, so contacts is adminOnlyDeletes on the server. The row cross
          // this used to gate is gone in the redesign — the dialog's Delete is the
          // only way in now, so the gate belongs here.
          onDelete={isAdmin && contact !== 'new' ? () => { setRemoving(contact); setContact(null); } : undefined}
        />
      )}
      {removing && (
        <ConfirmDialog
          title="Remove this contact?"
          message={`${removing.name} will no longer be offered on this client's records.`}
          confirmLabel="Remove"
          busy={busy}
          onCancel={() => setRemoving(null)}
          onConfirm={deleteContact}
        />
      )}
      {merge && (
        <Modal
          size="sm"
          title="Merge into another company"
          onClose={() => setMerge(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setMerge(false)}>Cancel</button>
              <button type="button" className="btn btn--danger" disabled={!into || busy} onClick={doMerge}>Merge</button>
            </>
          }
        >
          <div className="stack">
            <p className="small muted">
              Every record naming <strong>{c.name}</strong> moves to the company you pick, and this one is deleted. It cannot be undone.
            </p>
            <Select
              value={into}
              onChange={(e) => setInto(e.target.value)}
              placeholder="Pick the company to keep"
              options={(lookups.companies || []).filter((x) => String(x.id) !== String(id)).map((x) => ({ value: String(x.id), label: x.name }))}
            />
          </div>
        </Modal>
      )}
    </>
  );
}
