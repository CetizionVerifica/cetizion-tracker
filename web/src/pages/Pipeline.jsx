import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Badge, ErrorState, Field, Input, Modal, Select, Textarea, useToast } from '../components/ui.jsx';
import { initialsOf } from '../components/record.jsx';
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

  const open = board ? board.stages.filter((s) => s.type === 'open') : [];
  const gross = open.reduce((n, s) => n + s.value, 0);
  const weighted = open.reduce((n, s) => n + s.weighted, 0);
  const stale = board ? board.cards.filter((c) => c.stale).length : 0;
  const peak = board ? Math.max(1, ...board.forecast.map((f) => Number(f.weighted) || 0)) : 1;

  return (
    <>
      <PageHeader
        title="Pipeline"
        subtitle="Open deals by stage. Drag a card to move it, or use its Move to list; moving to Lost asks why."
        actions={<Select value={person} placeholder="Owner: everyone" options={lookups.sales_people} onChange={(e) => setPerson(e.target.value)} />}
      />
      <div className="page stack">
        {error && <ErrorState message={error} onRetry={refetch} />}
        {board && (
          <section aria-label="Forecast" className="grid gap-4 rounded-lg border border-border bg-card p-5 lg:grid-cols-[auto_auto_minmax(0,1fr)_auto] lg:items-end lg:gap-8">
            <div>
              <div className="eyebrow">Open, gross</div>
              <div className="num mt-1 font-display text-2xl font-bold text-foreground">{money(gross)}</div>
            </div>
            <div>
              <div className="eyebrow">Weighted</div>
              <div className="num mt-1 font-display text-2xl font-bold text-primary">{money(weighted)}</div>
            </div>
            <div className="min-w-0">
              <div className="eyebrow">Weighted, by expected close month</div>
              {board.forecast.length ? (
                <div className="mt-2 flex h-24 items-end gap-2 overflow-x-auto" role="table" aria-label="Weighted value by expected close month">
                  {board.forecast.map((f) => (
                    <div key={f.month} role="row" className="flex min-w-14 flex-1 flex-col items-center gap-1" title={`${f.count} deals · ${money(f.weighted)}`}>
                      <span role="cell" className="num text-[11px] text-muted-foreground">{money(f.weighted, 'INR', { compact: true })}</span>
                      <span aria-hidden="true" className="w-full rounded-t-sm bg-forecast" style={{ height: `${Math.max(4, Math.round((Number(f.weighted) / peak) * 44))}px` }} />
                      <span role="cell" className="text-[11px] font-semibold text-secondary-text">{f.month === 'undated' ? 'No date' : monthLabel(f.month)}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="mt-2 text-[13px] text-muted-foreground">Nothing open with a value yet.</p>}
            </div>
            <div className="flex flex-col gap-1 text-[12.5px] text-secondary-text lg:text-right">
              {stale > 0 && <span><span className="num font-semibold text-late">{stale}</span> stale, no move in a while</span>}
              {board.closed_90_days.map((r, i) => (
                <span key={i}>{r.stage} in 90 days: <span className="num font-semibold text-foreground">{r.n}</span> · <span className="num">{money(r.value_inr, 'INR', { compact: true })}</span></span>
              ))}
            </div>
            {board.without_rate > 0 && (
              <p className="text-[12.5px] text-waiting lg:col-span-4">
                {board.without_rate} quotation{board.without_rate === 1 ? ' is' : 's are'} left out: no exchange rate for {board.without_rate === 1 ? 'its' : 'their'} currency on {board.without_rate === 1 ? 'its' : 'their'} date. Add it under Settings, Exchange rates.
              </p>
            )}
          </section>
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
              <div className="kanban__head" style={{ borderTopColor: s.color || 'var(--border-strong)' }}>
                <div className="flex items-center gap-2">
                  <span className="font-display text-[14px] font-bold text-foreground">{s.name}</span>
                  <span className="num rounded-full bg-secondary px-2 text-[11px] font-semibold text-secondary-text">{s.count}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">{s.probability}%</span>
                </div>
                <div className="num mt-1 text-[12px] text-muted-foreground">
                  {money(s.value, 'INR', { compact: true })}{s.type === 'open' && <> · weighted {money(s.weighted, 'INR', { compact: true })}</>}
                  {s.stale > 0 && <> · <span className="text-late">{s.stale} stale</span></>}
                </div>
              </div>
              <div className="kanban__cards">
                {s.type === 'lost' && cardsFor(s).length === 0 && <div className="p-3 text-[12.5px] text-muted-foreground">Drop a card here to mark it lost</div>}
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
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1 text-[13px] font-semibold text-foreground">{c.client_name}</span>
                      {c.sales_person && (
                        <span title={c.sales_person} className="grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-[10px] font-bold text-primary">{initialsOf(c.sales_person)}</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[12.5px] text-secondary-text">{c.service_quoted || 'No service named'}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="num text-[13px] font-semibold text-foreground">{money(c.quotation_value, c.currency)}</span>
                      <span className={`num ml-auto text-[11.5px] ${c.stale ? 'font-semibold text-late' : 'text-muted-foreground'}`}>{c.days_in_stage}d here</span>
                    </div>
                    {(c.stale || c.expired || c.accepted_at || c.expected_close_date) && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
                        {c.stale && <Badge tone="danger">Stale</Badge>}
                        {c.expired && <Badge tone="warning">Expired</Badge>}
                        {c.accepted_at && <Badge tone="success">Accepted</Badge>}
                        {c.expected_close_date && <span>Closes {date(c.expected_close_date)}</span>}
                      </div>
                    )}
                    {c.next_step && <div className="mt-1.5 text-[12px] text-secondary-text">Next: {c.next_step}</div>}
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
          {loading && !board && <div className="skeleton h-[300px] w-full" />}
        </div>
        <p className="text-[12.5px] text-muted-foreground">Won deals leave the board when their project or PO is registered. Lost ones leave it too; open a lost deal from Deals and revise it to reopen it.</p>
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

