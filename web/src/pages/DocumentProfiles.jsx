import { useState } from 'react';
import { Plus } from 'lucide-react';
import { SettingsPane } from './SettingsArea.jsx';
import { ConfirmDialog, useToast } from '../components/ui.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { FailedCard, ListTable, LoadingPanel, Panel, PhoneRow, StateCard } from '../components/daily.jsx';
import { MoneyBanner } from '../components/money.jsx';
import { Tone } from '../components/sales.jsx';
import { RowActions } from '../components/settings.jsx';
import { api } from '../lib/api.js';
import { date } from '../lib/format.js';
import { useList, useLookups } from '../lib/hooks.js';

const DOC = { po: 'Purchase orders', invoice: 'Invoices' };

/**
 * What is particular about one client's POs or invoices
 * (docs/email-po-invoice-prompt-plan.md §6), Wave 8. The email readers add
 * the note to what they ask about that client's documents, and send a PO
 * whose number does not fit the pattern to review. A note is used once an
 * admin has saved it; a suggested one waits here, first, with an explicit
 * Approve and save or Reject suggestion (which removes it, as Delete did).
 */
export default function DocumentProfiles() {
  const toast = useToast();
  const { rows, loading, error, data, refetch } = useList('document-profiles', { limit: 500 });
  const lookups = useLookups();
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);

  const sorted = [...rows].sort((a, b) => Number(a.approved) - Number(b.approved));
  const suggested = rows.filter((r) => !r.approved);
  const what = (r) => `${r.company_name}’s ${DOC[r.doc_type].toLowerCase()}`;

  async function remove(row, msg) {
    setBusy(true);
    try {
      await api.remove('document-profiles', row.id);
      toast(msg, 'success');
      setRemoving(null);
      setEditing(null);
      refetch();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }

  const acts = (r, phone = false) => (
    <>
      {r.approved
        ? <button type="button" className={phone ? 'mg-btn mg-btn--sm' : 'mg-btn mg-btn--ghost mg-btn--sm'} aria-label={`Edit the note on ${what(r)}`} onClick={() => setEditing(r)}>Edit</button>
        : <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" aria-label={`Review the suggested note on ${what(r)}`} onClick={() => setEditing(r)}>Review</button>}
      <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Delete the note on ${what(r)}`} onClick={() => setRemoving(r)}>Delete</button>
    </>
  );
  const review = editing && editing !== 'new' && !editing.approved;

  return (
    <SettingsPane
      title="Client document notes"
      description="What is particular about a client’s purchase orders or invoices: a note for the email readers, the labels the client prints, and the shape of its PO numbers. A PO whose number doesn’t fit goes to review."
      actions={<button type="button" className="mg-btn mg-btn--primary" onClick={() => setEditing('new')}><Plus className="size-4" aria-hidden="true" />Add a note</button>}
    >
      {error ? <FailedCard title="Couldn’t load client document notes" text="The server didn’t answer, so nothing is shown. Nothing has changed. Try again in a moment." onRetry={refetch} />
      : loading && !data ? <LoadingPanel rows={4} />
      : rows.length === 0 ? (
        <StateCard tone="plain" title="No notes yet" text="Add one for a client whose documents the readers often get wrong.">
          <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={() => setEditing('new')}>Add a note</button>
        </StateCard>
      ) : (
        <>
          {suggested.length > 0 && (
            <MoneyBanner
              title={`${suggested.length} suggested ${suggested.length === 1 ? 'note is' : 'notes are'} waiting for you.`}
              action={<button type="button" className="mg-btn mg-btn--sm" onClick={() => setEditing(suggested[0])}>Review the first</button>}
            >
              {' '}The email readers don’t use a note until you approve it.
            </MoneyBanner>
          )}
          <Panel id="set-notes" title="Notes" hint="Suggested notes first. Saving one approves it.">
            <ListTable
              label="Client document notes"
              rows={sorted}
              columns={[
                { key: 'company_name', header: 'Client', render: (r) => <b>{r.company_name}</b> },
                { key: 'doc_type', header: 'Documents', render: (r) => DOC[r.doc_type] },
                { key: 'po_number_pattern', header: 'PO numbers', render: (r) => (r.po_number_pattern ? <span className="set-mono text-secondary-text">{r.po_number_pattern}</span> : <span className="text-muted-foreground">—</span>) },
                { key: 'hint', header: 'Note', className: 'app-say', width: '30%', render: (r) => r.hint || <span className="text-muted-foreground">—</span> },
                { key: 'approved', header: 'Status', render: (r) => (r.approved ? <Tone tone="ok">In use</Tone> : <Tone tone="wait">Suggested</Tone>) },
                { key: 'act', header: '', className: 'actions', render: (r) => <RowActions>{acts(r)}</RowActions> },
              ]}
              phone={(r) => (
                <PhoneRow title={r.company_name} meta={[DOC[r.doc_type], r.po_number_pattern, r.hint].filter(Boolean).join(' · ')} state={r.approved ? <Tone tone="ok">In use</Tone> : <Tone tone="wait">Suggested</Tone>} wraps>
                  <span className="set-rowacts">{acts(r, true)}</span>
                </PhoneRow>
              )}
            />
          </Panel>
        </>
      )}

      {editing && (
        <RecordForm
          title={editing === 'new' ? 'New client document note' : `${editing.company_name}: ${DOC[editing.doc_type].toLowerCase()}`}
          subtitle={editing === 'new' ? 'Used by the email readers as soon as it’s saved' : review ? `Suggested by the email reader${editing.created_at ? ` on ${date(editing.created_at)}` : ''}` : `In use${editing.updated_at ? ` since ${date(editing.updated_at)}` : ''}`}
          intro={review ? 'Not used yet. The readers ignore a suggested note until you approve it. Change anything that’s wrong first.' : undefined}
          submitLabel={editing === 'new' ? 'Add note' : review ? 'Approve and save' : 'Save changes'}
          extraAction={review && <button type="button" className="mg-btn mg-btn--ghost mr-auto" disabled={busy} onClick={() => remove(editing, 'Suggestion rejected')}>Reject suggestion</button>}
          size="lg"
          resource="document-profiles"
          record={editing === 'new' ? null : { ...editing, sender_domains: (editing.sender_domains || []).join(', ') }}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refetch(); }}
          fields={[
            { name: 'company_id', label: 'Client', type: 'select', required: true, options: (lookups.companies || []).map((c) => ({ value: String(c.id), label: c.name })) },
            { name: 'doc_type', label: 'Documents', type: 'select', required: true, options: [{ value: 'po', label: 'Purchase orders' }, { value: 'invoice', label: 'Invoices' }] },
            { name: 'sender_domains', label: 'Sent from', hint: 'The client’s email domains, separated by commas, e.g. client.com, client.co.in.' },
            { name: 'po_number_pattern', label: 'PO number pattern', hint: 'A pattern such as ^37\\d{8}$ for ten digits starting 37. Leave blank to check nothing.' },
            { name: 'label_aliases', label: 'Labels it prints', span: 'all', hint: 'e.g. “Work Order No.” for the PO number, “Doc. Date” for its date.' },
            { name: 'hint', label: 'Note for the readers', type: 'textarea', span: 'all', max: 500, hint: 'What to read where, and what to ignore.' },
          ]}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Delete the note on ${what(removing)}?`}
          subtitle={removing.approved ? 'In use' : 'Suggested, not used yet'}
          message={`The email readers go back to reading their ${DOC[removing.doc_type].toLowerCase()} without it.`}
          confirmLabel="Delete note"
          cancelLabel="Keep it"
          busy={busy}
          onConfirm={() => remove(removing, 'Note deleted')}
          onClose={() => setRemoving(null)}
        />
      )}
    </SettingsPane>
  );
}
