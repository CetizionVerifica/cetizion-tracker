import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Keyboard } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { Field, Input, Modal, Select, Textarea } from '../components/ui.jsx';
import { FailedCard, FilterSelect, plural, StateCard } from '../components/daily.jsx';
import { SalesViews, Tone } from '../components/sales.jsx';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { useToast } from '../components/ui.jsx';
import { date, money } from '../lib/format.js';

/**
 * The quotation pipeline as a board (#25): one column per open stage, each
 * card a quotation, dragged between stages. Moving to Lost asks why. The
 * weighted total and the forecast by expected close month sit above the
 * board. Every card also has a Move button, the way to move it without a
 * pointer (or on a phone); Alt and the arrow keys move a focused card.
 */
export default function Pipeline() {
  const navigate = useNavigate();
  const toast = useToast();
  const lookups = useLookups();
  const [person, setPerson] = useState('');
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const [losing, setLosing] = useState(null);   // { card, stage }
  const [asTable, setAsTable] = useState(false);
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

  /** Dragged, picked from Move, or moved with Alt+arrow: the same rules (#25). */
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

  const openStages = board ? board.stages.filter((s) => s.type === 'open') : [];
  const openValue = openStages.reduce((n, s) => n + Number(s.value || 0), 0);
  const weighted = openStages.reduce((n, s) => n + Number(s.weighted || 0), 0);
  const openCount = openStages.reduce((n, s) => n + Number(s.count || 0), 0);
  const stale = board ? board.cards.filter((c) => c.stale).length : 0;
  const maxForecast = board ? Math.max(1, ...board.forecast.map((f) => Number(f.weighted || 0))) : 1;
  const short = (n) => money(n, 'INR', { compact: true });

  return (
    <>
      <PageHeader
        eyebrow="Sales"
        title="Pipeline"
        subtitle="Every open quotation by stage. The weighted value is what each stage is worth at its probability."
        nav={<SalesViews />}
        actions={<FilterSelect label="Owner" value={person} onChange={setPerson} placeholder="Everyone" options={lookups.sales_people} width={170} />}
      />
      <div className="app-page">
        {error ? (
          <FailedCard title="Couldn't load the pipeline" text={error} onRetry={refetch} />
        ) : loading && !board ? (
          <div className="app-pipe" aria-busy="true" aria-label="Loading the pipeline">
            {[0, 1, 2].map((i) => <div key={i} className="mg-glass mg-panel" style={{ minHeight: 200 }}><div className="mg-skel" style={{ height: 14, width: '40%' }} /><div className="mg-skel" style={{ height: 120 }} /></div>)}
          </div>
        ) : board && (
          <>
            <div className="app-pipe">
              <section className="mg-hero" data-a="rise" aria-labelledby="pipe-hero" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="mg-hero__label" id="pipe-hero">Open pipeline</span>
                <span className="mg-hero__figure mg-num" style={{ fontSize: 'clamp(36px, 4.4vw, 60px)', overflowWrap: 'anywhere' }}>{money(openValue)}</span>
                <span className="mg-hero__sub">weighted <strong style={{ color: 'var(--on-hero)' }}>{money(weighted)}</strong> · {plural(openCount, 'deal')} · {stale} stale</span>
                <span className="mg-progress" style={{ margin: '8px 0 4px' }} role="img" aria-label={`Weighted ${money(weighted)} of ${money(openValue)} open`}>
                  <span className="mg-progress__done" style={{ width: `${openValue ? (weighted / openValue) * 100 : 0}%` }} />
                  <span className="mg-progress__expected" style={{ flex: 1 }} />
                </span>
                <span className="mg-hero__sub" style={{ fontSize: 12 }}>Solid: weighted at each stage’s probability. Hatched: the rest of the open value. Every currency in INR at the rate on the quotation’s date; drafts are not weighted.</span>
                {board.without_rate > 0 && (
                  <span className="mg-hero__sub" style={{ fontSize: 12, marginTop: 4 }}>
                    <span className="app-hero__pill" style={{ marginRight: 8 }}>{board.without_rate} left out</span>
                    No exchange rate for {board.without_rate === 1 ? 'its' : 'their'} currency on {board.without_rate === 1 ? 'its' : 'their'} date. Add it in Settings › Exchange rates.
                  </span>
                )}
              </section>

              <section className="mg-glass mg-panel" data-a="rise" aria-labelledby="pipe-fc">
                <div className="mg-panel__head">
                  <h2 id="pipe-fc" className="mg-panel__title">Forecast by expected close</h2>
                  {board.forecast.length > 0 && <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm ml-auto" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>{asTable ? 'Show as chart' : 'Show as table'}</button>}
                </div>
                <span className="mg-panel__hint">Weighted value in INR, drafts left out, undated deals last</span>
                {!board.forecast.length ? (
                  <p className="m-0 text-[13px] text-muted-foreground">Nothing open with a value.</p>
                ) : asTable ? (
                  <div className="app-box"><div className="mg-tablewrap"><table className="mg-table">
                    <caption className="sr-only">Forecast by expected close</caption>
                    <thead><tr><th scope="col">Month</th><th scope="col" className="num">Deals</th><th scope="col" className="num">Weighted</th></tr></thead>
                    <tbody>{board.forecast.map((f) => <tr key={f.month}><td>{f.month === 'undated' ? 'No date' : monthLabel(f.month)}</td><td className="num">{f.count}</td><td className="num">{money(f.weighted)}</td></tr>)}</tbody>
                  </table></div></div>
                ) : (
                  <div className="app-bars3" role="img" aria-label={board.forecast.map((f) => `${f.month === 'undated' ? 'No date' : monthLabel(f.month)} ${money(f.weighted)}`).join(', ')}>
                    {board.forecast.map((f) => (
                      <div key={f.month}>
                        <b>{short(f.weighted)}</b>
                        <i style={{ height: `${Math.max(2, (Number(f.weighted || 0) / maxForecast) * 100)}%` }} />
                        <span>{f.month === 'undated' ? 'No date' : monthLabel(f.month, true)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="mg-glass mg-panel" data-a="rise" aria-labelledby="pipe-closed">
                <h2 id="pipe-closed" className="mg-panel__title">Closed in the last 90 days</h2>
                <span className="mg-panel__hint">Won and lost, with the reasons given</span>
                {board.closed_90_days.length ? (
                  <div className="app-box"><div className="mg-tablewrap"><table className="mg-table">
                    <caption className="sr-only">Closed in the last 90 days</caption>
                    <thead><tr><th scope="col">Outcome</th><th scope="col" className="num">Deals</th><th scope="col" className="num">Value</th></tr></thead>
                    <tbody>{board.closed_90_days.map((r, i) => (
                      <tr key={i}>
                        <td><Tone tone={/won/i.test(r.stage) ? 'ok' : /lost/i.test(r.stage) ? 'late' : 'plain'}>{r.stage}</Tone>{r.lost_reason && <span className="app-sub">{r.lost_reason}</span>}</td>
                        <td className="num">{r.n}</td>
                        <td className="num">{money(r.value_inr)}</td>
                      </tr>
                    ))}</tbody>
                  </table></div></div>
                ) : <p className="m-0 text-[13px] text-muted-foreground">Nothing closed yet.</p>}
              </section>
            </div>

            <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="pipe-board">
              <div className="app-panel__head">
                <div className="app-panel__titles" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px' }}>
                  <h2 id="pipe-board" className="mg-panel__title">Board</h2>
                  <span className="mg-panel__hint inline-flex flex-wrap items-center gap-1.5">
                    <Keyboard className="size-4" strokeWidth={1.8} aria-hidden="true" />
                    Drag a card to move it, or with the keyboard: Tab to a card, <kbd className="app-kbd">Enter</kbd> opens it, <kbd className="app-kbd">Alt</kbd> + <kbd className="app-kbd">←</kbd> <kbd className="app-kbd">→</kbd> moves it a stage. On a phone, use Move.
                  </span>
                </div>
              </div>
              {board.cards.length === 0 ? (
                <StateCard inPanel tone="plain" title="Nothing open on the board" text={person ? `${person} has no open deals.` : 'Open deals appear here as soon as a quotation is created.'}>
                  {person && <button type="button" className="mg-btn mg-btn--sm" onClick={() => setPerson('')}>Show everyone’s</button>}
                </StateCard>
              ) : (
                <div className="app-board" role="list" aria-label="Stages">
                  {columns.map((s) => (
                    <div
                      key={s.id}
                      role="listitem"
                      aria-label={`${s.name}, ${plural(s.count, 'deal')}`}
                      className={`app-board__col ${over === s.id ? 'is-over' : ''} ${s.type === 'lost' ? 'is-lost' : ''}`}
                      style={{ '--stage': s.color || undefined }}
                      onDragOver={(e) => { e.preventDefault(); if (over !== s.id) setOver(s.id); }}
                      onDragLeave={() => setOver(null)}
                      onDrop={() => drop(s)}
                    >
                      <div className="app-board__head">
                        <b>{s.name}<small>{s.type === 'paused' ? 'paused' : `${s.probability}%`}</small></b>
                        <span>{s.count} · {money(s.value)}{s.type === 'open' ? ` · weighted ${money(s.weighted)}` : s.type === 'paused' ? ' · not weighted' : ''}</span>
                        {s.stale > 0 && <span><Tone tone="late">{s.stale} stale</Tone></span>}
                      </div>
                      {cardsFor(s).length === 0 && (
                        <div className="app-board__empty">{s.type === 'lost' ? 'Drop a card here to mark it lost.' : 'No deals at this stage.'}</div>
                      )}
                      {cardsFor(s).map((c) => (
                        <div
                          key={c.id}
                          className={`app-card ${c.stale ? 'is-stale' : ''} ${dragging?.id === c.id ? 'is-dragging' : ''}`}
                          draggable
                          tabIndex={0}
                          role="button"
                          aria-label={`${c.quotation_no}, ${c.client_name}, ${s.name}. Enter opens it; Alt and the arrow keys move it between stages.`}
                          onKeyDown={(e) => onCardKey(e, c)}
                          onDragStart={() => setDragging(c)}
                          onDragEnd={() => { setDragging(null); setOver(null); }}
                          onClick={(e) => { if (!e.target.closest('button')) navigate(`/quotations/${encodeURIComponent(c.quotation_no)}`); }}
                        >
                          <div className="app-card__top"><span>{c.client_name}</span><span>{money(c.quotation_value, c.currency)}</span></div>
                          <div className="app-card__svc">{c.service_quoted || 'no subject'}</div>
                          <div className="app-card__meta">
                            {c.quotation_no}{c.sales_person && ` · ${c.sales_person}`}{c.expected_close_date && ` · close ${date(c.expected_close_date)}`} · {plural(c.days_in_stage, 'day')} in stage
                          </div>
                          {(c.stale || c.expired || c.accepted_at) && (
                            <div className="app-card__badges">
                              {c.stale && <Tone tone="late">Stale, {plural(c.days_in_stage, 'day')}</Tone>}
                              {c.expired && <Tone tone="wait">Expired</Tone>}
                              {c.accepted_at && <Tone tone="ok">Accepted</Tone>}
                            </div>
                          )}
                          <div className="app-card__foot">
                            <span>{c.next_step ? <><ArrowRight className="mr-1 inline size-3.5" aria-hidden="true" />{c.next_step}</> : <span className="text-muted-foreground">No next step</span>}</span>
                            {/* The keyboard's (and anybody's) way to move a card: any stage, Lost included (#25). */}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button type="button" className="mg-btn mg-btn--ghost" aria-label={`Move ${c.quotation_no} to another stage`} onKeyDown={(e) => e.stopPropagation()}>Move</button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="min-w-52">
                                <DropdownMenuLabel>Move {c.quotation_no} to</DropdownMenuLabel>
                                {columns.filter((x) => x.id !== c.stage_id).map((x) => (
                                  <DropdownMenuItem key={x.id} variant={x.type === 'lost' ? 'destructive' : undefined} onSelect={() => moveCard(c, x)}>
                                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: x.color || 'var(--line)' }} aria-hidden="true" />
                                    {x.name}{x.type === 'lost' ? '…' : ''}
                                    <small className="ml-auto text-[12px] text-muted-foreground">{x.type === 'paused' ? 'paused' : x.type === 'lost' ? 'asks why' : `${x.probability}%`}</small>
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              <p className="app-panel__note">Won deals leave the board when their project or PO is registered. Lost ones leave it too; open a lost deal from Deals and revise it to reopen it.</p>
            </section>
          </>
        )}
      </div>

      {losing && (
        <LostDialog card={losing.card} reasons={lookups.lost_reasons} onClose={() => setLosing(null)} onConfirm={async (extra) => { if (await move(losing.card, losing.stage, extra)) setLosing(null); }} />
      )}
    </>
  );
}

function monthLabel(ym, short = false) {
  const [y, m] = ym.split('-');
  const name = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1];
  return short ? name : `${name} ${y}`;
}

/** Why a deal was lost: a reason is required; who won it and notes are optional. Shared with the deal page. */
export function LostDialog({ card, reasons, onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [competitor, setCompetitor] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Mark ${card.quotation_no} as lost`} subtitle={`${card.client_name} · ${money(card.quotation_value, card.currency)}. It leaves the board; revise it later to reopen it.`} onClose={onClose} footer={<>
      <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="mg-btn mg-btn--danger" disabled={!reason || busy} aria-describedby="lost-why" onClick={async () => { setBusy(true); await onConfirm({ lost_reason_id: Number(reason), lost_notes: notes || null, competitor: competitor || null }); setBusy(false); }}>{busy ? 'Marking…' : 'Mark as lost'}</button>
      {!reason && <span id="lost-why" className="app-why">Pick a reason to mark it lost.</span>}
    </>}>
      <div className="stack">
        <Field label="Why" required><Select value={reason} placeholder="Pick a reason" options={reasons.map((r) => ({ value: String(r.id), label: r.name }))} onChange={(e) => setReason(e.target.value)} /></Field>
        <Field label="Competitor" hint="If we lost to someone"><Input value={competitor} onChange={(e) => setCompetitor(e.target.value)} /></Field>
        <Field label="Notes"><Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
