import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Inbox as InboxIcon, MessageSquareText, Plus } from 'lucide-react';
import { PageHeader } from '../../App.jsx';
import { ConfirmDialog, Field, Modal, useToast } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { useFetch, useLookups, useMediaQuery } from '../../lib/hooks.js';
import { useAuth } from '../../lib/auth.jsx';

/**
 * Inbox setup (?view=setup): which shared mailboxes feed the team inbox,
 * who gets new mail first, and the replies the team reuses. Inboxes are an
 * admin's to change; the server refuses anybody else, so a salesperson
 * sees them read-only.
 */
const ROUTES = { owner_of_company: 'The client\'s owner, else round robin', round_robin: 'Round robin', unassigned: 'Unassigned queue' };
const TOKENS = [['contact_name', 'Contact name'], ['company_name', 'Company name'], ['my_name', 'My name']];
const TOKEN_LABEL = Object.fromEntries(TOKENS);

/** Canned text with its {{placeholders}} drawn as the words they stand for. */
function CannedText({ text, max = 220 }) {
  const short = text.length > max ? `${text.slice(0, max)}…` : text;
  return short.split(/(\{\{\s*\w+\s*\}\})/g).map((part, i) => {
    const m = part.match(/^\{\{\s*(\w+)\s*\}\}$/);
    // eslint-disable-next-line react/no-array-index-key
    return m ? <span key={i} style={{ color: 'var(--caramel-text)', fontWeight: 700 }}>{TOKEN_LABEL[m[1]] || m[1]}</span> : <span key={i}>{part}</span>;
  });
}

function Panel({ id, title, hint, tools, children }) {
  return (
    <section className="mg-glass mg-glass--strong app-ib-panel" data-a="rise" aria-labelledby={id}>
      <div className="app-ib-panel__head">
        <div className="app-ib-panel__titles"><h2 className="mg-panel__title" id={id}>{title}</h2>{hint && <p className="mg-panel__hint">{hint}</p>}</div>
        {tools}
      </div>
      {children}
    </section>
  );
}

function Failed({ what, onRetry }) {
  return (
    <section className="mg-glass mg-empty" role="alert" data-a="rise">
      <span className="mg-empty__mark app-ib__late-mark"><AlertCircle className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
      <h2 className="mg-empty__title">Couldn’t load {what}</h2>
      <p className="mg-empty__text">The server didn’t answer. Nothing has changed; the inboxes keep working.</p>
      <button type="button" className="mg-btn mg-btn--sm" onClick={onRetry}>Try again</button>
    </section>
  );
}

export function InboxSetup({ onBack }) {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const lookups = useLookups();
  const wide = useMediaQuery('(min-width: 768px)');
  const inboxes = useFetch(() => api.raw('/inbox/inboxes'));
  const canned = useFetch(() => api.raw('/inbox/canned'));
  const [form, setForm] = useState(null);
  const [cannedForm, setCannedForm] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [removingCanned, setRemovingCanned] = useState(null);
  const [busy, setBusy] = useState(false);
  const textRef = useRef(null);
  const rows = inboxes.data?.data ?? [];
  const avail = inboxes.data?.available_mailboxes ?? [];
  const responses = canned.data?.data ?? [];
  // Client portal messages go to the first active inbox (lowest id).
  const portalInbox = [...rows].filter((r) => r.active !== false).sort((a, b) => a.id - b.id)[0];
  const nextInbox = [...rows].filter((r) => r.active !== false && r.id !== portalInbox?.id).sort((a, b) => a.id - b.id)[0];

  /** The row knows how many conversations it takes with it; ?discard=yes stands for having read that. */
  async function deleteInbox() {
    setBusy(true);
    try {
      await api.raw(`/inbox/inboxes/${removing.id}?discard=yes`, { method: 'DELETE' });
      toast(`${removing.name} deleted`, 'success');
      setRemoving(null);
      inboxes.refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally { setBusy(false); }
  }

  async function saveInbox(e) {
    e?.preventDefault();
    if (!form.name.trim()) return;
    setBusy(true);
    try {
      const body = { name: form.name, default_assignment: form.default_assignment, members: form.members, first_response_hours: form.first_response_hours || null, signature: form.signature || null };
      if (form.id) await api.raw(`/inbox/inboxes/${form.id}`, { method: 'PATCH', body }); else await api.action('/inbox/inboxes', { ...body, account_id: Number(form.account_id) });
      toast('Saved', 'success'); setForm(null); inboxes.refetch();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(false); }
  }
  async function saveCanned(e) {
    e?.preventDefault();
    if (!cannedForm.name.trim() || !cannedForm.body.trim()) return;
    setBusy(true);
    try {
      if (cannedForm.id) await api.raw(`/inbox/canned/${cannedForm.id}`, { method: 'PATCH', body: { name: cannedForm.name, body: cannedForm.body } }); else await api.action('/inbox/canned', { name: cannedForm.name, body: cannedForm.body });
      toast('Saved', 'success'); setCannedForm(null); canned.refetch();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(false); }
  }
  async function deleteCanned() {
    setBusy(true);
    try {
      await api.remove('inbox/canned', removingCanned.id);
      toast(`${removingCanned.name} deleted`, 'success');
      setRemovingCanned(null); canned.refetch();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggleMember = (p) => setForm((f) => ({ ...f, members: f.members.includes(p) ? f.members.filter((x) => x !== p) : [...f.members, p] }));
  const insertToken = (key) => {
    const el = textRef.current;
    const token = `{{${key}}}`;
    setCannedForm((f) => {
      const at = el && typeof el.selectionStart === 'number' ? el.selectionStart : f.body.length;
      requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(at + token.length, at + token.length); } });
      return { ...f, body: `${f.body.slice(0, at)}${token}${f.body.slice(at)}` };
    });
  };

  const inboxActs = (r) => isAdmin && (
    <>
      <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Edit ${r.name}`} onClick={() => setForm({ ...r, members: [...(r.members || [])], first_response_hours: r.first_response_hours || '', signature: r.signature || '' })}>Edit</button>
      <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Delete ${r.name}`} onClick={() => setRemoving(r)}>Delete</button>
    </>
  );
  const cannedActs = (r) => (
    <>
      <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Edit ${r.name}`} onClick={() => setCannedForm(r)}>Edit</button>
      <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Delete ${r.name}`} onClick={() => setRemovingCanned(r)}>Delete</button>
    </>
  );
  const within = (r) => (r.first_response_hours ? `${r.first_response_hours} h` : 'Settings default');
  const people = form ? [...new Set([...(lookups.sales_people || []), ...form.members])] : [];

  return (
    <>
      <PageHeader
        eyebrow="Inbox"
        title="Inbox setup"
        subtitle="Which shared mailboxes feed the team inbox, who gets new mail first, and the replies the team reuses."
        actions={<button type="button" className="mg-btn" onClick={onBack}><ArrowLeft className="size-4" strokeWidth={2} aria-hidden="true" />Back to the inbox</button>}
      />
      <div className="app-page">
        {inboxes.loading && !inboxes.data ? (
          <section className="mg-glass mg-panel" aria-busy="true" aria-label="Loading inboxes" data-a="rise">
            <div className="mg-skel" style={{ height: 14, width: '18%' }} /><div className="mg-skel" style={{ height: 12, width: '46%' }} /><div className="mg-skel" style={{ height: 52, marginTop: 6 }} /><div className="mg-skel" style={{ height: 52 }} />
          </section>
        ) : inboxes.error ? <Failed what="the inbox setup" onRetry={inboxes.refetch} /> : (
          <Panel
            id="sec-inboxes"
            title="Inboxes"
            hint={<>A shared mailbox connected under <Link to="/settings/mailboxes">Settings › Mailboxes</Link> becomes an inbox here. New mail in it is routed to an owner and gets a reply clock.</>}
            tools={isAdmin ? (
              <div className="flex flex-col items-end gap-1.5">
                <button
                  type="button"
                  className="mg-btn mg-btn--primary mg-btn--sm"
                  disabled={!avail.length}
                  aria-describedby={avail.length ? undefined : 'why-noinbox'}
                  onClick={() => setForm({ name: 'Sales', account_id: String(avail[0].id), default_assignment: 'owner_of_company', members: [], first_response_hours: '', signature: '' })}
                >
                  <Plus className="size-4" strokeWidth={2} aria-hidden="true" />Inbox
                </button>
                {!avail.length && <span id="why-noinbox" className="text-right text-[12px]" style={{ color: 'var(--wait)' }}>Connect a shared mailbox first.</span>}
              </div>
            ) : <span className="mg-badge mg-badge--plain">Only an admin changes inboxes</span>}
          >
            {!rows.length ? (
              <div className="mg-empty">
                <span className="mg-empty__mark"><InboxIcon className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
                <h3 className="mg-empty__title">No inbox yet</h3>
                <p className="mg-empty__text">Connect the shared sales mailbox under Settings › Mailboxes, then add it here. Until then, client portal messages arrive only as notifications.</p>
                <Link to="/settings/mailboxes" className="mg-btn mg-btn--sm" style={{ marginTop: 6 }}>Open Settings › Mailboxes</Link>
              </div>
            ) : wide ? (
              <div className="mg-tablewrap">
                <table className="mg-table" aria-label="Inboxes">
                  <thead><tr><th>Inbox</th><th>New email goes to</th><th>Round robin</th><th>Reply within</th><th className="num">Open</th>{isAdmin && <th className="actions" aria-label="Actions" />}</tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td><strong>{r.name}</strong><span className="sub">{r.email}</span>{r.id === portalInbox?.id && <span className="mg-badge mg-badge--info is-sm" style={{ marginTop: 6, height: 22, fontSize: 11 }}>Gets client portal messages</span>}</td>
                        <td className="app-say">{ROUTES[r.default_assignment]}</td>
                        <td className="app-say">{(r.members || []).join(', ') || '—'}</td>
                        <td className="app-nowrap">{within(r)}</td>
                        <td className="num"><strong>{r.open}</strong></td>
                        {isAdmin && <td className="actions">{inboxActs(r)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mg-rows">
                {rows.map((r) => (
                  <div key={r.id} className="mg-row">
                    <span className="mg-row__title">{r.name}</span><span className="mg-row__amount mg-num">{r.open} open</span>
                    <span className="mg-row__meta app-wide">{r.email} · {ROUTES[r.default_assignment]} · reply within {within(r)}</span>
                    {r.id === portalInbox?.id && <span className="app-wide" style={{ marginTop: 6 }}><span className="mg-badge mg-badge--info">Gets client portal messages</span></span>}
                    {isAdmin && <span className="app-acts">{inboxActs(r)}</span>}
                  </div>
                ))}
              </div>
            )}
            {portalInbox && (
              <p className="app-ib-panel__foot">
                Client portal messages and queries go to the first active inbox, <strong>{portalInbox.name}</strong>.
                {nextInbox ? ` If it is deleted they move to ${nextInbox.name}.` : ' If it is deleted they arrive only as notifications.'}
              </p>
            )}
          </Panel>
        )}

        {canned.loading && !canned.data ? (
          <section className="mg-glass mg-panel" aria-busy="true" aria-label="Loading canned responses" data-a="rise">
            <div className="mg-skel" style={{ height: 14, width: '24%' }} /><div className="mg-skel" style={{ height: 12, width: '52%' }} /><div className="mg-skel" style={{ height: 52, marginTop: 6 }} /><div className="mg-skel" style={{ height: 52 }} />
          </section>
        ) : canned.error ? <Failed what="the canned responses" onRetry={canned.refetch} /> : (
          <Panel
            id="sec-canned"
            title="Canned responses"
            hint="Replies anyone can insert from the reply box. The contact's name, the company and your name are filled in as they go in."
            tools={<button type="button" className="mg-btn mg-btn--sm" onClick={() => setCannedForm({ name: '', body: '' })}><Plus className="size-4" strokeWidth={2} aria-hidden="true" />Response</button>}
          >
            {!responses.length ? (
              <div className="mg-empty">
                <span className="mg-empty__mark"><MessageSquareText className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
                <h3 className="mg-empty__title">No canned responses yet</h3>
                <p className="mg-empty__text">Add the replies the team sends again and again, like a thank-you or a quotation cover note.</p>
                <button type="button" className="mg-btn mg-btn--sm" style={{ marginTop: 6 }} onClick={() => setCannedForm({ name: '', body: '' })}>Add a response</button>
              </div>
            ) : wide ? (
              <div className="mg-tablewrap">
                <table className="mg-table" aria-label="Canned responses">
                  <thead><tr><th style={{ width: 220 }}>Name</th><th>Text</th><th className="actions" aria-label="Actions" /></tr></thead>
                  <tbody>
                    {responses.map((r) => (
                      <tr key={r.id}>
                        <td><strong>{r.name}</strong>{r.owner && <span className="sub">by {r.owner}</span>}</td>
                        <td className="app-say"><CannedText text={r.body} /></td>
                        <td className="actions">{cannedActs(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mg-rows">
                {responses.map((r) => (
                  <div key={r.id} className="mg-row">
                    <span className="mg-row__title">{r.name}</span><span className="mg-row__meta" style={{ textAlign: 'right' }}>{r.owner || ''}</span>
                    <span className="mg-row__meta app-wide" style={{ color: 'var(--text2)', whiteSpace: 'normal' }}><CannedText text={r.body} max={160} /></span>
                    <span className="app-acts">{cannedActs(r)}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}
      </div>

      {form && (
        <Modal
          title={form.id ? `Edit ${form.name || 'inbox'}` : 'New inbox'}
          subtitle={form.id ? form.email : 'A shared mailbox with no inbox yet becomes one.'}
          onClose={() => setForm(null)}
          footer={<>
            <button type="button" className="mg-btn mg-btn--ghost" onClick={() => setForm(null)} disabled={busy}>Cancel</button>
            <button type="submit" form="inbox-form" className="mg-btn mg-btn--primary" disabled={busy || !form.name.trim()}>{busy ? 'Saving…' : form.id ? 'Save' : 'Create inbox'}</button>
          </>}
        >
          <form id="inbox-form" onSubmit={saveInbox} className="flex flex-col gap-3.5" noValidate>
            <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <Field label="Name" required hint={`Shown in the switcher as “${form.name || '…'} (team)”.`}><input className="mg-input" required value={form.name} onChange={set('name')} /></Field>
              {!form.id ? (
                <Field label="Mailbox" required hint="Shared mailboxes with no inbox yet.">
                  <span className="mg-select-wrap"><select className="mg-select" value={form.account_id} onChange={set('account_id')}>{avail.map((a) => <option key={a.id} value={String(a.id)}>{a.email}</option>)}</select></span>
                </Field>
              ) : (
                <Field as="div" label="Mailbox" hint="Fixed once the inbox exists."><span className="flex h-11 items-center font-bold">{form.email}</span></Field>
              )}
            </div>
            <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <Field label="New email goes to">
                <span className="mg-select-wrap"><select className="mg-select" value={form.default_assignment} onChange={set('default_assignment')}>{Object.entries(ROUTES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></span>
              </Field>
              <Field label="Reply within (hours)" hint="Blank uses the default reply time from Settings.">
                <input className="mg-input" type="number" min="1" inputMode="numeric" value={form.first_response_hours} onChange={set('first_response_hours')} />
              </Field>
            </div>
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-2 p-0 text-[12px] font-medium text-secondary-foreground">Round robin between</legend>
              <div className="app-ib-chips">
                {people.map((p) => <button key={p} type="button" className="mg-chip" aria-pressed={form.members.includes(p)} onClick={() => toggleMember(p)}>{p}</button>)}
                {!people.length && <span className="text-[13px] text-muted-foreground">No salespeople in the lists yet.</span>}
              </div>
              <span className="text-[12px] text-muted-foreground">Used when the client has no owner, or the rule above is round robin.</span>
            </fieldset>
            <Field label="Signature" hint="Added under every reply sent from this inbox."><textarea className="mg-textarea" rows={3} value={form.signature} onChange={set('signature')} style={{ minHeight: 84 }} /></Field>
          </form>
        </Modal>
      )}
      {removing && (
        <ConfirmDialog
          title={`Delete ${removing.name}?`}
          message={removing.conversations
            ? `Its ${removing.conversations} conversation${removing.conversations === 1 ? '' : 's'} lose their status, owner and reply clock. The emails themselves stay under the mailbox, and new mail to ${removing.email} stops reaching the inbox.`
            : `Nothing has been routed to it yet. New mail to ${removing.email} stops reaching the inbox.`}
          confirmLabel="Delete"
          busy={busy}
          onConfirm={deleteInbox}
          onClose={() => setRemoving(null)}
        >
          {removing.id === portalInbox?.id && (
            <p className="m-0 mt-2 text-[13px] text-secondary-foreground">
              {nextInbox ? `Client portal messages move to ${nextInbox.name}.` : 'Client portal messages then arrive only as notifications.'}
            </p>
          )}
        </ConfirmDialog>
      )}
      {cannedForm && (
        <Modal
          title={cannedForm.id ? `Edit ${cannedForm.name || 'response'}` : 'New response'}
          subtitle="Everyone can insert it from the reply box."
          onClose={() => setCannedForm(null)}
          footer={<>
            <button type="button" className="mg-btn mg-btn--ghost" onClick={() => setCannedForm(null)} disabled={busy}>Cancel</button>
            <button type="submit" form="canned-form" className="mg-btn mg-btn--primary" disabled={busy || !cannedForm.name.trim() || !cannedForm.body.trim()}>Save response</button>
          </>}
        >
          <form id="canned-form" onSubmit={saveCanned} className="flex flex-col gap-3.5" noValidate>
            <Field label="Name" required><input className="mg-input" required value={cannedForm.name} placeholder="For example: Quotation attached" onChange={(e) => setCannedForm((f) => ({ ...f, name: e.target.value }))} /></Field>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="canned-text" className="text-[12px] font-medium text-secondary-foreground">Text<span className="ml-0.5 text-late" aria-hidden="true">*</span></label>
              <textarea id="canned-text" ref={textRef} className="mg-textarea" rows={8} required value={cannedForm.body} onChange={(e) => setCannedForm((f) => ({ ...f, body: e.target.value }))} style={{ minHeight: 168 }} />
              <div className="app-ib-tokens">
                <span className="text-[12px] text-muted-foreground">Insert at the cursor:</span>
                {TOKENS.map(([key, label]) => <button key={key} type="button" className="mg-chip" onClick={() => insertToken(key)}>{label}</button>)}
              </div>
              <span className="text-[12px] text-muted-foreground">Each is filled in when someone inserts the response, so the text reads naturally.</span>
            </div>
          </form>
        </Modal>
      )}
      {removingCanned && (
        <ConfirmDialog
          title={`Delete ${removingCanned.name}?`}
          message="It disappears from everyone’s reply box. Replies already sent with it are not changed."
          confirmLabel="Delete"
          busy={busy}
          onConfirm={deleteCanned}
          onClose={() => setRemovingCanned(null)}
        />
      )}
    </>
  );
}
