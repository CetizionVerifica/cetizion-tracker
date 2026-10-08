import { useState } from 'react';
import { cn } from 'cn';
import { useToast } from '../components/ui.jsx';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { SettingsPane } from './SettingsArea.jsx';
import { api } from '../lib/api.js';
import { invalidateLookups, useFetch } from '../lib/hooks.js';

/**
 * The company profile (C21): the facts printed on every quotation.
 *
 * The design's claim is "change once, everything follows", and the way it
 * earns that claim is the panel on the right — it is not a mock-up of a
 * PDF, it is the same three fields the generator lays out, in the same
 * order, updating as you type. Someone editing the GSTIN can see where it
 * lands before saving, which is the only way a settings form stops being
 * a list of keys with no consequences.
 *
 * The preview is kept honest deliberately: `lib/quotationPdf.js` prints
 * the name, the address and "GSTIN <n>" and nothing else, so the preview
 * shows those and nothing else. The design draws an accounts email and a
 * bank line in the header too; the generator does not print them, and
 * drawing them here would be promising something the PDF will not do.
 */

const FIELDS = [
  {
    key: 'company_name',
    label: 'Legal name',
    hint: 'Printed at the top of every quotation, and used wherever the app names itself.',
  },
  {
    key: 'company_gstin',
    label: 'GSTIN',
    mono: true,
    hint: 'Sets the home state — the place of supply then decides CGST+SGST or IGST.',
  },
  {
    key: 'company_gstins',
    label: 'All our GSTINs',
    mono: true,
    span: true,
    hint: 'Every state we are registered in, comma-separated. The email readers take a PO addressed to, or an invoice raised from, any of them; an invoice raised from another GSTIN than its PO was addressed to goes to review.',
  },
  {
    key: 'partner_companies',
    label: 'Partner companies',
    multiline: true,
    span: true,
    hint: 'Companies clients also order through, one per line: name | GSTIN | other names. A PO addressed to one is registered as ours and marked "Through" it. Write "none" for no partners.',
  },
  {
    key: 'company_address',
    label: 'Registered address',
    multiline: true,
    span: true,
    hint: 'One block, as it should appear under the name.',
  },
  {
    key: 'finance_email',
    label: 'Accounts email',
    type: 'email',
    hint: 'Where payment questions and the finance digest go.',
  },
  {
    key: 'company_state_code',
    label: 'Home state code',
    mono: true,
    hint: 'Two digits, matching the start of the GSTIN — 27 for Maharashtra.',
  },
];

/** The PDF header, as quotationPdf.js actually lays it out. */
function PdfHeader({ values }) {
  return (
    <div className="flex flex-col gap-4 rounded-lg bg-white p-6 text-[#151517]">
      <div>
        <div className="text-[16px] font-bold text-[#0f7a66]">{values.company_name || 'Your company name'}</div>
        {values.company_address && <div className="mt-1 text-[8.5px]/[1.5] text-[#5d5d66]">{values.company_address}</div>}
        {values.company_gstin && <div className="text-[8.5px] text-[#5d5d66]">GSTIN {values.company_gstin}</div>}
      </div>
      <div className="flex justify-between border-t border-[#e2e2de] pt-3 text-[11.5px] text-[#3d3d45]">
        <span>Quotation <span className="mono">CTZ/QT/2026/063</span></span>
        <span>22 Sep 2026</span>
      </div>
      <div className="border-t border-[#e2e2de] pt-3 text-[11px]/[1.6] text-[#5d5d66]">
        For {values.company_name || 'your company'} · authorised signatory
      </div>
    </div>
  );
}

export function CompanyProfile() {
  const toast = useToast();
  const { data, loading, refetch } = useFetch(() => api.raw('/lookups'));
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);

  const saved = data?.data?.settings || {};
  const values = Object.fromEntries(FIELDS.map((f) => [f.key, draft[f.key] ?? saved[f.key] ?? '']));
  const changed = FIELDS.filter((f) => draft[f.key] !== undefined && draft[f.key] !== (saved[f.key] ?? ''));

  async function save() {
    setBusy(true);
    try {
      // One PATCH per changed key — the endpoint takes one setting at a
      // time, and only what actually moved is sent.
      for (const field of changed) {
        await api.update('settings', field.key, { value: draft[field.key] });
      }
      toast(changed.length === 1 ? 'Saved' : `${changed.length} settings saved`, 'success');
      invalidateLookups();
      setDraft({});
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <div className="skeleton" style={{ height: 240 }} />;

  return (
    <SettingsPane
      title="Company profile"
      description="The legal identity and tax registration printed on every quotation. The preview beside it is the header the PDF generator actually lays out, so a change here shows where it lands before it is saved."
    >
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-5">
        <div className="grid gap-x-6 gap-y-4 rounded-lg border border-border bg-card p-5 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <div key={field.key} className={cn('min-w-0', field.span && 'sm:col-span-2')}>
              <Label htmlFor={field.key} className="mb-2 text-[12.5px] font-medium text-secondary-text">{field.label}</Label>
              {field.multiline ? (
                <Textarea
                  id={field.key}
                  rows={2}
                  className="text-[13px]"
                  value={values[field.key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.value }))}
                />
              ) : (
                <Input
                  id={field.key}
                  type={field.type || 'text'}
                  className={cn('h-8 text-[13px]', field.mono && 'mono')}
                  value={values[field.key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.value }))}
                />
              )}
              {field.hint && <p className="mt-1.5 text-[11.5px]/[1.5] text-muted-foreground">{field.hint}</p>}
            </div>
          ))}

          <div className="flex items-center gap-3 sm:col-span-2">
            <Button size="sm" className="h-8 px-4 text-[13px]" disabled={!changed.length || busy} onClick={save}>
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
            {changed.length > 0 && !busy && (
              <span className="text-[12px] text-muted-foreground">
                {changed.length === 1 ? `${changed[0].label} has changed` : `${changed.length} fields have changed`}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">PDF header, live</div>
        <PdfHeader values={values} />
        <p className="text-[11.5px]/[1.6] text-muted-foreground">
          The numbering series — <span className="mono">CTZ/QT/2026/…</span>, <span className="mono">PRJ-2026-…</span>,
          {' '}<span className="mono">CVPL/26-27/…</span> — stay server-owned and are not editable here.
        </p>
      </div>
      </div>
    </SettingsPane>
  );
}
