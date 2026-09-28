import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Badge, Card, Field, Input, Modal, Select, Textarea, useToast } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';

/**
 * The quotation pipeline as a board (#25): one column per open stage, each
 * card a quotation, dragged between stages. Moving to Lost asks why. The
 * weighted total per column and the forecast by expected close month sit
 * above the board.
 */
export default function Pipeline() {
  const navigate = useNavigate();
  const toast = useToast();
  const lookups = useLookups();
  const [person, setPerson] = useState('');
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const [losing, setLosing] = useState(null);   // { card, stage }
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/pipeline${person ? `?sales_person=${encodeURIComponent(person)}` : ''}`), [person]);
  const board = data?.data;

  async function move(card, stage, extra = {}) {
    try {
      await api.action(`/pipeline/${encodeURIComponent(card.quotation_no)}/move`, { stage_id: stage.id, ...extra });
      toast(`${card.quotation_no} → ${stage.name}`, 'success');
      refetch();
      return true;
    } catch (err) {
      toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger');
      return false;
    }
  }

  function drop(stage) {
    setOver(null);
    const card = dragging; setDragging(null);
    moveCard(card, stage);
  }

  /** Dragged, picked from "Move to", or moved with Alt+arrow: the same rules (#25). */
  function moveCard(card, stage) {
    if (!card || !stage || card.stage_id === stage.id) return;
    if (stage.type === 'lost') { setLosing({ card, stage }); return; }
    if (stage.type === 'won') { toast('Register the project or PO to win a quotation', 'info'); return; }
    move(card, stage);
  }

  // Expired is the expiry job's to set, not a place to drop a card.
  const columns = board ? board.stages.filter((s) => (s.type === 'open' || s.type === 'paused' || s.type === 'lost') && s.name !== 'Expired') : [];
  const openColumns = columns.filter((s) => s.type !== 'lost');

  function onCardKey(e, card) {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/quotations/${encodeURIComponent(card.quotation_no)}`); return; }
    if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const at = openColumns.findIndex((s) => s.id === card.stage_id);
      const next = openColumns[at + (e.key === 'ArrowRight' ? 1 : -1)];
      if (at >= 0 && next) moveCard(card, next);
    }
  }
  const cardsFor = (s) => (board?.cards ?? []).filter((c) => c.stage_id === s.id);

  return (
    <>
      <PageHeader
        title="Pipeline"
        subtitle="Every open quotation by stage. Drag a card to move it; the weighted value is what each stage is worth at its probability."
        actions={<Select value={person} placeholder="Owner: all" options={lookups.sales_people} onChange={(e) => setPerson(e.target.value)} />}
      />
      <div className="page stack">
        {error && <Card><span style={{ color: 'var(--danger-fg)' }}>{error}</span></Card>}
        {board && (
          <div className="auto-grid grid--3">
            <Card title="Open pipeline" hint="Open stages, every currency converted to INR at the rate on the quotation's date; drafts not weighted">
              <div className="stat__value">{money(board.stages.filter((s) => s.type === 'open').reduce((n, s) => n + s.value, 0))}</div>
              <div className="small muted">weighted {money(board.stages.filter((s) => s.type === 'open').reduce((n, s) => n + s.weighted, 0))} · {board.cards.filter((c) => c.stale).length} stale</div>
              {board.without_rate > 0 && <div className="small" style={{ color: 'var(--warn-fg)', marginTop: 4 }}>{board.without_rate} quotation{board.without_rate === 1 ? '' : 's'} left out: no exchange rate for {board.without_rate === 1 ? 'its' : 'their'} currency on {board.without_rate === 1 ? 'its' : 'their'} date (Settings → Exchange rates)</div>}
            </Card>
            <Card title="Forecast by expected close" hint="Weighted value in INR, drafts left out; undated quotations at the end">
              {board.forecast.length ? (
                <table className="table" style={{ fontSize: 12 }}>
                  <tbody>{board.forecast.map((f) => <tr key={f.month}><td>{f.month === 'undated' ? 'No date' : monthLabel(f.month)}</td><td className="num">{f.count}</td><td className="num">{money(f.weighted)}</td></tr>)}</tbody>
                </table>
              ) : <span className="muted">Nothing open with a value</span>}
            </Card>
            <Card title="Closed in the last 90 days" hint="Won and lost, with the reasons given">
              {board.closed_90_days.length ? (
                <table className="table" style={{ fontSize: 12 }}>
                  <tbody>{board.closed_90_days.map((r, i) => <tr key={i}><td>{r.stage}{r.lost_reason && <span className="muted"> · {r.lost_reason}</span>}</td><td className="num">{r.n}</td><td className="num">{money(r.value_inr)}</td></tr>)}</tbody>
                </table>
              ) : <span className="muted">Nothing closed yet</span>}
            </Card>
          </div>
        )}

        <div className="kanban">
          {columns.map((s) => (
            <div
              key={s.id}
              className={`kanban__col ${over === s.id ? 'is-over' : ''} ${s.type === 'lost' ? 'kanban__col--lost' : ''}`}
              onDragOver={(e) => { e.preventDefault(); if (over !== s.id) setOver(s.id); }}
              onDragLeave={() => setOver(null)}
              onDrop={() => drop(s)}
            >
              <div className="kanban__head" style={{ borderTopColor: s.color || 'var(--ink-300)' }}>
                <div className="strong">{s.name} <span className="muted">· {s.probability}%</span></div>
                <div className="small muted">{s.count} · {money(s.value)}{s.type === 'open' && <> · weighted {money(s.weighted)}</>}{s.stale > 0 && <> · <span style={{ color: 'var(--danger-fg)' }}>{s.stale} stale</span></>}</div>
              </div>
              <div className="kanban__cards">
                {s.type === 'lost' && cardsFor(s).length === 0 && <div className="small muted" style={{ padding: 12 }}>Drop a card here to mark it lost</div>}
                {cardsFor(s).map((c) => (
                  <div
                    key={c.id}
                    className={`kanban__card ${c.stale ? 'is-stale' : ''} ${dragging?.id === c.id ? 'is-dragging' : ''}`}
                    draggable
                    tabIndex={0}
                    role="button"
                    aria-label={`${c.quotation_no}, ${c.client_name}, ${s.name}. Enter opens it; Alt and the arrow keys move it between stages.`}
                    onKeyDown={(e) => onCardKey(e, c)}
                    onDragStart={() => setDragging(c)}
                    onDragEnd={() => { setDragging(null); setOver(null); }}
                    onClick={() => navigate(`/quotations/${encodeURIComponent(c.quotation_no)}`)}
                  >
                    <div className="strong" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span>{c.client_name}</span><span>{money(c.quotation_value, c.currency)}</span></div>
                    <div className="small muted" style={{ marginTop: 2 }}>{c.service_quoted || 'no subject'}</div>
                    <div className="small muted" style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span className="mono">{c.quotation_no}</span>
                      {c.sales_person && <span>· {c.sales_person}</span>}
                      {c.expected_close_date && <span>· close {date(c.expected_close_date)}</span>}
                      <span>· {c.days_in_stage}d</span>
                      {c.stale && <Badge tone="danger">stale</Badge>}
                      {c.expired && <Badge tone="warning">expired</Badge>}
                      {c.accepted_at && <Badge tone="success">accepted</Badge>}
                    </div>
                    {c.next_step && <div className="small" style={{ marginTop: 6 }}>→ {c.next_step}</div>}
                    {/* The keyboard's (and anybody's) way to move a card: any stage, Lost included (#25). */}
                    <select
                      className="kanban__move"
                      aria-label={`Move ${c.quotation_no} to`}
                      value=""
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      onChange={(e) => moveCard(c, columns.find((x) => String(x.id) === e.target.value))}
                    >
                      <option value="">Move to…</option>
                      {columns.filter((x) => x.id !== c.stage_id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {loading && !board && <div className="skeleton" style={{ height: 300, width: '100%' }} />}
        </div>
        <div className="small muted">Won quotations leave the board when their project or PO is registered. Lost ones leave it too; open a lost quotation from the Quotations list and revise it to reopen it.</div>
      </div>

      {losing && (
        <LostDialog card={losing.card} reasons={lookups.lost_reasons} onClose={() => setLosing(null)} onConfirm={async (extra) => { if (await move(losing.card, losing.stage, extra)) setLosing(null); }} />
      )}
    </>
  );
}

function monthLabel(ym) {
  const [y, m] = ym.split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y}`;
}

function LostDialog({ card, reasons, onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [competitor, setCompetitor] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Mark ${card.quotation_no} as lost`} subtitle={`${card.client_name} · ${money(card.quotation_value, card.currency)}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn--primary" disabled={!reason || busy} onClick={async () => { setBusy(true); await onConfirm({ lost_reason_id: Number(reason), lost_notes: notes || null, competitor: competitor || null }); setBusy(false); }}>Mark lost</button></>}>
      <div className="stack">
        <Field label="Why" required><Select value={reason} placeholder="Pick a reason" options={reasons.map((r) => ({ value: String(r.id), label: r.name }))} onChange={(e) => setReason(e.target.value)} /></Field>
        <Field label="Competitor" hint="If we lost to someone"><Input value={competitor} onChange={(e) => setCompetitor(e.target.value)} /></Field>
        <Field label="Notes"><Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

