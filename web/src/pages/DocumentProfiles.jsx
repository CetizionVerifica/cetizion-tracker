import { useState } from 'react';
import { SettingsPane } from './SettingsArea.jsx';
import { Button } from '../components/ui/button';
import { Chip } from '../components/record.jsx';
import { Card, DataTable, Empty, useToast } from '../components/ui.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { api } from '../lib/api.js';
import { useList, useLookups } from '../lib/hooks.js';

const DOC = { po: 'Purchase orders', invoice: 'Invoices' };

/**
 * What is particular about one client's POs or invoices
 * (docs/email-po-invoice-prompt-plan.md §6). The email readers add the note
 * to what they ask the AI about that client's documents, and send a PO whose
 * number does not fit the pattern to review. A note is used once an admin
 * has saved it; one the tracker suggests, after reviewers corrected three of
 * the client's documents, waits here until then.
 */
export default function DocumentProfiles() {
  const toast = useToast();
  const { rows, loading, refetch } = useList('document-profiles', { limit: 500 });
  const lookups = useLookups();
  const [editing, setEditing] = useState(null);

  async function remove(row) {
    if (!window.confirm(`Delete the note on ${row.company_name}'s ${DOC[row.doc_type].toLowerCase()}?`)) return;
    try { await api.remove('document-profiles', row.id); toast('Note deleted', 'success'); refetch(); }
    catch (err) { toast(err.message, 'danger'); }
  }

  return (
    <SettingsPane
      title="Client document notes"
      description="What is particular about a client's purchase orders or invoices: a note for the email readers' AI, the labels the client prints, and the shape of its PO numbers. A PO whose number does not fit goes to review. Saving a note approves it; a suggested one is not used until then."
      actions={<Button size="sm" className="h-8 px-4 text-[13px]" onClick={() => setEditing('new')}>Add a note</Button>}
    >
      <Card flush>
        <DataTable
          loading={loading}
          rows={rows}
          columns={[
            { key: 'company_name', header: 'Client', className: 'strong' },
            { key: 'doc_type', header: 'Documents', render: (r) => DOC[r.doc_type] },
            { key: 'po_number_pattern', header: 'PO numbers', className: 'mono small', render: (r) => r.po_number_pattern || <span className="muted">—</span> },
            { key: 'hint', header: 'Note', className: 'small', render: (r) => r.hint || <span className="muted">—</span> },
            { key: 'approved', header: '', render: (r) => (r.approved ? <Chip tone="settled">In use</Chip> : <Chip tone="waiting">Suggested</Chip>) },
            {
              key: 'act', header: '', align: 'right',
              render: (r) => (
                <div className="table__actions">
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(r)}>{r.approved ? 'Edit' : 'Review and approve'}</button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => remove(r)}>Delete</button>
                </div>
              ),
            },
          ]}
          empty={<Empty title="No notes yet" text="Add one for a client whose documents the readers often get wrong." />}
        />
      </Card>

      {editing && (
        <RecordForm
          title={editing === 'new' ? 'New client document note' : `${editing.company_name}: ${DOC[editing.doc_type].toLowerCase()}`}
          resource="document-profiles"
          record={editing === 'new' ? null : { ...editing, sender_domains: (editing.sender_domains || []).join(', ') }}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refetch(); }}
          fields={[
            { name: 'company_id', label: 'Client', type: 'select', required: true, options: (lookups.companies || []).map((c) => ({ value: String(c.id), label: c.name })) },
            { name: 'doc_type', label: 'Documents', type: 'select', required: true, options: [{ value: 'po', label: 'Purchase orders' }, { value: 'invoice', label: 'Invoices' }] },
            { name: 'sender_domains', label: 'Sent from', hint: 'The client\'s email domains, comma-separated, e.g. client.com, client.co.in' },
            { name: 'po_number_pattern', label: 'PO number pattern', hint: 'A regular expression, e.g. ^37\\d{8}$ for ten digits starting 37. Leave blank to check nothing.' },
            { name: 'label_aliases', label: 'Labels it prints', hint: 'e.g. "Work Order No." for the PO number, "Doc. Date" for its date' },
            { name: 'hint', label: 'Note for the readers', type: 'textarea', span: true, hint: 'At most 500 characters: what to read where, and what to ignore.' },
          ]}
        />
      )}
    </SettingsPane>
  );
}
