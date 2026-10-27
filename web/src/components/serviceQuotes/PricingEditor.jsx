import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Alert, Badge, DataTable, Field, Input, Modal, Select, useToast } from '../ui.jsx';
import { QuestionnaireForm } from '../QuestionnaireForm.jsx';
import { api } from '../../lib/api.js';
import { money } from '../../lib/format.js';
import {
  addBand, allQuestions, blankValue, INCLUDE_OPS, kindOf, LIST_KINDS, newLine, numericColumns,
  problemsByLine, questionsFor, removeBand, setBandCell, VALUE_KINDS,
} from '../../lib/pricingRules.js';

/**
 * A questionnaire version's pricing rules (#208 phase 2C), the Pricing tab
 * of the builder (web/src/components/serviceQuotes/CLAUDE.md §2). Lines are
 * edited only on a draft; publishing freezes them with the version. The
 * server checks every rule and works every price out: this screen offers
 * only its vocabulary, shows its problems beside the line they belong to,
 * and previews what sample answers would come to by asking it.
 */
const OP_LABEL = { eq: 'is', neq: 'is not', in: 'is one of', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most', answered: 'is answered' };
const move = (list, i, d) => { const j = i + d; if (j < 0 || j >= list.length) return list; const out = [...list]; [out[i], out[j]] = [out[j], out[i]]; return out; };
const numberOr = (v, fallback) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? fallback : Number(v));

/**
 * `problems` and `onProblems` let the builder hold the list, which a save of
 * the questions also changes; `onDirty` tells it about edits not saved yet,
 * which Publish would leave behind. The preview asks the server, which
 * prices against the saved questions, so it is built from those.
 */
export function PricingEditor({ version, definition, savedDefinition = definition, readOnly = false, currency = 'INR', problems: given, onProblems, onDirty }) {
  const toast = useToast();
  const [lines, setLines] = useState(() => structuredClone(version.pricing?.lines || []));
  const [own, setOwn] = useState(version.pricing_problems || []);
  const problems = given ?? own;
  const [dirty, setDirtyState] = useState(false);
  const setDirty = (d) => { setDirtyState(d); onDirty?.(d); };
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [result, setResult] = useState(null);

  const change = (next) => { setLines(next); setDirty(true); };
  const setLine = (i, l) => change(lines.map((x, j) => (j === i ? l : x)));
  const { byLine, general } = problemsByLine(problems, lines);
  // The server previews only rules it accepts.
  const previewHold = !readOnly && problems.length ? 'Preview waits until the pricing problems are fixed and saved.' : null;

  async function save() {
    setBusy(true);
    try {
      const r = await api.raw(`/questionnaire-versions/${version.id}`, { method: 'PATCH', body: { pricing: { lines } } });
      setOwn(r.data.pricing_problems || []);
      onProblems?.(r.data.pricing_problems || []);
      setDirty(false);
      toast(r.data.pricing_problems?.length ? 'Pricing saved; it lists what to fix before publishing' : 'Pricing saved', 'success');
      return true;
    } catch (err) { toast(err.message, 'danger'); return false; } finally { setBusy(false); }
  }
  async function openPreview() {
    if (dirty && !(await save())) return;
    setResult(null);
    setPreviewing(true);
  }

  return (
    <div className="stack">
      <p className="small muted" style={{ maxWidth: '75ch' }}>
        The lines a quotation gets from this questionnaire's answers, and how each is priced. Rates are in the
        service's currency; a quotation in another is converted at the day's exchange rate. A line the rules
        cannot price is added at rate 0 marked <strong>Price needed</strong>, and the quotation cannot go to the
        client until someone enters it.
      </p>
      {readOnly && <Alert tone="info"><span>Published versions are frozen. Make a new version to change pricing.</span></Alert>}
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn--sm" disabled={busy || !dirty} onClick={save}>Save pricing</button>
          <button type="button" className="btn btn--sm" disabled={busy || !lines.length || Boolean(previewHold)} aria-describedby={previewHold ? 'preview-hold' : undefined} onClick={openPreview}>{dirty ? 'Save and preview pricing' : 'Preview pricing'}</button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => change([...lines, newLine(lines)])}><Plus className="size-3.5" aria-hidden="true" /> Add a pricing line</button>
        </div>
      )}
      {previewHold && <p id="preview-hold" className="small muted">{previewHold}</p>}
      {readOnly && lines.length > 0 && <div><button type="button" className="btn btn--sm" onClick={openPreview}>Preview pricing</button></div>}
      {general.length > 0 && (
        <Alert tone="warning"><span><strong>Before it can be published:</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{general.map((p) => <li key={p}>{p}</li>)}</ul></span></Alert>
      )}
      {!lines.length && <p className="small muted">No pricing lines yet{readOnly ? '.' : ': add one for each part of the quotation (the audit, a report, travel).'}</p>}
      {lines.map((l, i) => (
        <LineEditor key={i} index={i} line={l} definition={definition} readOnly={readOnly} problems={byLine[i]} count={lines.length}
          onChange={(x) => setLine(i, x)} onMove={(d) => change(move(lines, i, d))}
          onRemove={() => window.confirm(`Remove the pricing line "${l.description || l.key}"?`) && change(lines.filter((_, j) => j !== i))} />
      ))}

      {previewing && (
        <Modal title="Preview pricing" subtitle="Fill in sample answers to see the lines and total they come to. Nothing is saved or sent." size="lg" onClose={() => setPreviewing(false)}>
          <div className="stack">
            <QuestionnaireForm
              definition={savedDefinition}
              askContact={false}
              submitLabel="Preview pricing"
              onSubmit={async ({ answers }) => {
                const r = await api.action(`/questionnaire-versions/${version.id}/preview-pricing`, { answers });
                setResult(r.data);
              }}
            />
            {result && <PreviewResult result={result} currency={currency} />}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** What the server made of the sample answers: never worked out here. */
function PreviewResult({ result, currency }) {
  const errors = Object.entries(result.answer_errors || {});
  return (
    <section className="stack" aria-live="polite">
      <div className="strong">What these answers come to</div>
      {errors.length > 0 && <Alert tone="warning"><span>Some sample answers were not used: {errors.map(([k, m]) => `${k}: ${m}`).join('; ')}.</span></Alert>}
      <DataTable rows={result.lines} empty={<p className="small muted">No line applies to these answers.</p>} columns={[
        { key: 'description', header: 'Line', render: (l) => (
          <span>{l.description}{l.price_needed && <span className="block small"><Badge tone="warning">Price needed</Badge> {l.why}</span>}</span>
        ) },
        { key: 'qty', header: 'Qty', align: 'right', render: (l) => `${l.qty}${l.unit ? ` ${l.unit}` : ''}` },
        { key: 'rate', header: 'Rate', align: 'right', render: (l) => (l.price_needed ? '—' : money(l.rate, currency)) },
        { key: 'amount', header: 'Amount', align: 'right', render: (l) => (l.price_needed ? '—' : money(l.amount, currency)) },
      ]} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="small muted">{result.price_needed_count ? `${result.price_needed_count} line${result.price_needed_count === 1 ? '' : 's'} would need a price.` : 'Every line is priced.'}</span>
        <span className="strong mono">Before GST: {money(result.subtotal, currency)}</span>
      </div>
    </section>
  );
}

function LineEditor({ index, line, definition, readOnly, problems, count, onChange, onMove, onRemove }) {
  const set = (patch) => {
    const next = { ...line, ...patch };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete next[k];
    onChange(next);
  };
  return (
    <section className="rounded-lg border border-border bg-card p-4" aria-label={`Pricing line ${index + 1}`}>
      <fieldset disabled={readOnly} className="stack" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="strong">Line {index + 1}</span>
          {problems.length > 0 && <Badge tone="warning">{problems.length} to fix</Badge>}
          {!readOnly && (
            <span className="ml-auto flex gap-1">
              <button type="button" className="btn btn--sm btn--ghost" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp className="size-3.5" aria-hidden="true" /></button>
              <button type="button" className="btn btn--sm btn--ghost" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown className="size-3.5" aria-hidden="true" /></button>
              <button type="button" className="btn btn--sm btn--ghost" aria-label="Remove line" onClick={onRemove}><Trash2 className="size-3.5" aria-hidden="true" /></button>
            </span>
          )}
        </div>
        {problems.length > 0 && <Alert tone="warning"><span><ul style={{ margin: 0, paddingLeft: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul></span></Alert>}
        <div className="form-grid">
          <div className="span-all"><Field label="Description" required hint="What the client reads on the quotation"><Input value={line.description} onChange={(e) => set({ description: e.target.value })} /></Field></div>
          <Field label="Key" hint="Lower-case letters, digits and _"><Input className="mono" value={line.key} onChange={(e) => set({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></Field>
          <Field label="Unit" hint="Empty: the service's"><Input value={line.unit ?? ''} onChange={(e) => set({ unit: e.target.value || undefined })} /></Field>
          <Field label="SAC code" hint="Empty: the service's"><Input className="mono" value={line.sac_code ?? ''} onChange={(e) => set({ sac_code: e.target.value || undefined })} /></Field>
          <Field label="GST %" hint="Empty: the service's"><Input type="number" min="0" max="100" value={line.gst_rate ?? ''} onChange={(e) => set({ gst_rate: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
        </div>
        <IncludeIf rule={line.include_if} definition={definition} onChange={(include_if) => set({ include_if })} />
        <div className="form-grid">
          <div className="span-all"><ValueField label="Quantity" hint="Left as 1 when not set" value={line.qty} optional definition={definition} onChange={(qty) => set({ qty })} /></div>
          <div className="span-all"><ValueField label="Rate" value={line.rate} definition={definition} onChange={(rate) => set({ rate })} /></div>
        </div>
        <div className="stack">
          <span className="small strong">Multiplied by</span>
          {(line.multiply || []).map((m, i) => (
            <div key={i} className="flex flex-wrap items-start gap-2">
              <div style={{ flex: '1 1 320px' }}><ValueField label={`Multiplier ${i + 1}`} value={m} definition={definition} onChange={(v) => set({ multiply: line.multiply.map((x, j) => (j === i ? v : x)) })} /></div>
              {!readOnly && <button type="button" className="btn btn--sm btn--ghost" aria-label={`Remove multiplier ${i + 1}`} onClick={() => set({ multiply: line.multiply.filter((_, j) => j !== i).length ? line.multiply.filter((_, j) => j !== i) : undefined })}><Trash2 className="size-3.5" aria-hidden="true" /></button>}
            </div>
          ))}
          {!readOnly && <div><button type="button" className="btn btn--sm btn--ghost" onClick={() => set({ multiply: [...(line.multiply || []), blankValue('rows', definition)] })}><Plus className="size-3.5" aria-hidden="true" /> Add a multiplier</button></div>}
        </div>
      </fieldset>
    </section>
  );
}

/** "Include when": a question, how to compare, and with what, as the question's type allows. */
function IncludeIf({ rule, definition, onChange }) {
  const questions = questionsFor('include', definition);
  const q = questions.find((x) => x.key === rule?.key);
  const ops = q ? ['answered', ...(INCLUDE_OPS[q.type] || [])] : ['answered'];
  const setValue = (raw) => {
    if (!q) return;
    let value = raw;
    if (q.type === 'yesno') value = raw === 'true';
    else if (['number', 'money'].includes(q.type)) value = rule.op === 'in' ? raw.split(',').map((s) => numberOr(s.trim(), s.trim())) : numberOr(raw, raw);
    else if (rule.op === 'in') value = raw.split(',').map((s) => s.trim()).filter(Boolean);
    onChange({ ...rule, value });
  };
  return (
    <div className="form-grid">
      <Field label="Include when" hint="Empty: always included">
        <Select value={rule?.key || ''} placeholder="Always" options={questions.map((x) => ({ value: x.key, label: x.label }))}
          onChange={(e) => onChange(e.target.value ? { key: e.target.value, op: 'answered' } : undefined)} />
      </Field>
      {rule && (
        <Field label="Compare">
          <Select value={rule.op} placeholder={null} options={ops.map((o) => ({ value: o, label: OP_LABEL[o] }))}
            onChange={(e) => { const op = e.target.value; const next = { key: rule.key, op }; if (op !== 'answered' && rule.value !== undefined) next.value = rule.value; onChange(next); }} />
        </Field>
      )}
      {rule && q && rule.op !== 'answered' && (
        <Field label="With" hint={rule.op === 'in' ? 'Several, separated by commas' : undefined}>
          {q.type === 'yesno' ? (
            <Select value={rule.value === undefined ? '' : String(rule.value)} placeholder="Choose…" options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} onChange={(e) => setValue(e.target.value)} />
          ) : ['number', 'money'].includes(q.type) && rule.op !== 'in' ? (
            <NumberInput value={typeof rule.value === 'number' ? rule.value : undefined} onValue={(n) => onChange({ ...rule, value: n })} />
          ) : q.options && rule.op !== 'in' ? (
            <Select value={rule.value ?? ''} placeholder="Choose…" options={q.options.map((o) => ({ value: o.key, label: o.label }))} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <Input value={Array.isArray(rule.value) ? rule.value.join(', ') : rule.value ?? ''} onChange={(e) => setValue(e.target.value)} />
          )}
        </Field>
      )}
    </div>
  );
}

/** One value of the vocabulary, nested where the block takes others (a band's value, a sum of several). */
function ValueField({ label, hint, value, optional = false, definition, onChange, depth = 0 }) {
  const kind = kindOf(value);
  const kinds = VALUE_KINDS.filter((k) => depth < 3 || !(LIST_KINDS.has(k.kind) || ['band', 'round_up'].includes(k.kind)));
  const pick = (k) => onChange(k ? blankValue(k, definition) : undefined);
  const questionSelect = (k, current, set, name = `${label}: question`) => (
    <Select aria-label={name} value={current || ''} placeholder="Choose a question…" options={questionsFor(k, definition).map((q) => ({ value: q.key, label: q.label }))} onChange={(e) => set(e.target.value)} />
  );
  return (
    <div className="stack" style={depth ? { borderLeft: '2px solid var(--border)', paddingLeft: 12 } : undefined}>
      <Field label={label} hint={hint}>
        <Select value={kind || ''} placeholder={optional ? '1' : 'Choose…'} options={kinds.map((k) => ({ value: k.kind, label: k.label }))} onChange={(e) => pick(e.target.value)} />
      </Field>
      {kind === 'fixed' && <NumberInput aria-label={`${label}: number`} value={value.fixed} onValue={(n) => onChange({ fixed: n })} />}
      {kind === 'answer' && questionSelect('answer', value.answer, (k) => onChange({ answer: k }))}
      {kind === 'count' && questionSelect('count', value.count, (k) => onChange({ count: k }))}
      {kind === 'rows' && questionSelect('rows', value.rows, (k) => onChange({ rows: k }))}
      {kind === 'sum' && (
        <div className="form-grid">
          <Field label="Table">{questionSelect('sum', value.sum.table, (k) => onChange({ sum: { table: k, column: numericColumns(allQuestions(definition).find((q) => q.key === k))[0]?.key || '' } }), `${label}: table`)}</Field>
          <Field label="Column">
            <Select aria-label={`${label}: column`} value={value.sum.column || ''} placeholder="Choose a column…"
              options={numericColumns(allQuestions(definition).find((q) => q.key === value.sum.table)).map((c) => ({ value: c.key, label: c.label }))}
              onChange={(e) => onChange({ sum: { ...value.sum, column: e.target.value } })} />
          </Field>
        </div>
      )}
      {kind === 'band' && <BandEditor label={label} value={value.band} definition={definition} depth={depth} onChange={(band) => onChange({ band })} />}
      {kind === 'round_up' && <ValueField label={`${label}, rounded up`} value={value.round_up} definition={definition} depth={depth + 1} onChange={(v) => onChange({ round_up: v ?? { fixed: 0 } })} />}
      {LIST_KINDS.has(kind) && (
        <div className="stack">
          {value[kind].map((x, i) => (
            <div key={i} className="flex flex-wrap items-start gap-2">
              <div style={{ flex: '1 1 280px' }}><ValueField label={`${label} ${i + 1}`} value={x} definition={definition} depth={depth + 1} onChange={(v) => onChange({ [kind]: value[kind].map((y, j) => (j === i ? v ?? { fixed: 0 } : y)) })} /></div>
              {value[kind].length > 1 && <button type="button" className="btn btn--sm btn--ghost" aria-label={`Remove ${i + 1}`} onClick={() => onChange({ [kind]: value[kind].filter((_, j) => j !== i) })}><Trash2 className="size-3.5" aria-hidden="true" /></button>}
            </div>
          ))}
          <div><button type="button" className="btn btn--sm btn--ghost" onClick={() => onChange({ [kind]: [...value[kind], { fixed: 1 }] })}><Plus className="size-3.5" aria-hidden="true" /> Add another</button></div>
        </div>
      )}
    </div>
  );
}

/** Bands as rows: from, to (both included), and the value they give. */
function BandEditor({ label, value, definition, depth, onChange }) {
  const cell = (row, col) => (
    <NumberInput aria-label={`${label}: band ${row + 1} ${['from', 'to', 'value'][col]}`} value={value.bands[row][col]}
      onValue={(n) => onChange({ ...value, bands: setBandCell(value.bands, row, col, n) })} />
  );
  return (
    <div className="stack">
      <ValueField label={`${label}: look up`} value={value.of} definition={definition} depth={depth + 1} onChange={(of) => onChange({ ...value, of: of ?? { answer: '' } })} />
      <table className="small" style={{ borderCollapse: 'separate', borderSpacing: '6px 4px' }}>
        <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Gives</th><th aria-label="Remove" /></tr></thead>
        <tbody>
          {value.bands.map((_, r) => (
            <tr key={r}>
              <td>{cell(r, 0)}</td><td>{cell(r, 1)}</td><td>{cell(r, 2)}</td>
              <td>{value.bands.length > 1 && <button type="button" className="btn btn--sm btn--ghost" aria-label={`Remove ${label} band ${r + 1}`} onClick={() => onChange({ ...value, bands: removeBand(value.bands, r) })}><Trash2 className="size-3.5" aria-hidden="true" /></button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div><button type="button" className="btn btn--sm btn--ghost" onClick={() => onChange({ ...value, bands: addBand(value.bands) })}><Plus className="size-3.5" aria-hidden="true" /> Add a band</button></div>
      <p className="small muted">Both ends are included{value.bands.length ? `: ${value.bands.map((b) => `${b[0]}–${b[1]}`).join(', ')}` : ''}. A value in no band makes the line Price needed.</p>
    </div>
  );
}

/**
 * A number typed as text: what is typed stays while it is typed ("2.", an
 * empty field before the next digit), and the rule gets each whole number.
 * Leaving the field empty puts the last number back.
 */
function NumberInput({ value, onValue, ...props }) {
  const shown = value === undefined || value === null ? '' : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => { if (text === '' || Number(text) !== value) setText(shown); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Input type="number" step="any" {...props} value={text}
      onChange={(e) => { setText(e.target.value); if (e.target.value !== '' && !Number.isNaN(Number(e.target.value))) onValue(Number(e.target.value)); }}
      onBlur={() => setText(shown)} />
  );
}
