import { useEffect, useState } from 'react';
import { Check, Download, MessageSquare } from 'lucide-react';
import { Alert, AlertDescription } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardContent } from '../components/ui/card.tsx';
import { Checkbox } from '../components/ui/checkbox.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { Separator } from '../components/ui/separator.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../components/ui/table.tsx';
import { Textarea } from '../components/ui/textarea.tsx';

/**
 * The page a client opens from an acceptance link (#53, C18).
 *
 * No sign-in, no app chrome, one quotation. It is plain on purpose: it has
 * to read on a phone, opened from a corporate inbox, by somebody who has
 * never seen this system and never will again. So it shows the figure, the
 * terms and one decision — and it never mentions anything but this
 * quotation, because the person reading it has no account here and no
 * business seeing anyone else's.
 */
const BASE = '/api/public/accept';

async function call(path, body) {
  const r = await fetch(`${BASE}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(json.error?.message || 'Something went wrong. Please try again.');
    e.fields = json.error?.fields;
    throw e;
  }
  return json.data;
}

const fmtMoney = (n, cur = 'INR') => (n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur || 'INR', maximumFractionDigits: 2 }).format(Number(n)));
const fmtDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');

/** The whole page is one column, centred, and never wider than a letter. */
function Sheet({ children }) {
  return (
    <div className="min-h-dvh bg-background px-4 py-10 sm:px-6 sm:py-16">
      <Card className="mx-auto w-full max-w-[720px] gap-0 rounded-[14px] py-0">
        <CardContent className="px-5 py-6 sm:px-8 sm:py-8">{children}</CardContent>
      </Card>
    </div>
  );
}

export default function AcceptQuotation({ token }) {
  const [state, setState] = useState({ loading: true });
  const [mode, setMode] = useState(null);  // 'accept' | 'changes'
  const [form, setForm] = useState({ name: '', email: '', agree: false, comment: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    call(token).then((d) => setState({ data: d })).catch((e) => setState({ dead: e.message }));
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call(`${token}/${mode === 'accept' ? 'accept' : 'changes'}`, form);
      setState({ data: await call(token) });
      setMode(null);
    } catch (err) {
      setError(err.fields ? Object.values(err.fields)[0] : err.message);
    } finally {
      setBusy(false);
    }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  if (state.loading) {
    return (
      <Sheet>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="mt-4 h-8 w-3/4" />
        <Skeleton className="mt-6 h-32 w-full" />
      </Sheet>
    );
  }

  if (state.dead) {
    return (
      <Sheet>
        <h1 className="text-xl font-semibold text-foreground">This link is not available</h1>
        <p className="mt-2 text-[14px]/[1.6] text-secondary-text">{state.dead}</p>
        <p className="mt-4 text-[13px] text-muted-foreground">
          If you were expecting a quotation, reply to the email that brought you here and we will send a fresh link.
        </p>
      </Sheet>
    );
  }

  const { quotation: q, seller, status } = state.data;
  const open = status === 'sent' || status === 'viewed';
  const reference = `${q.quotation_no}${q.revision ? ` revision ${q.revision}` : ''}`;

  return (
    <Sheet>
      <div className="text-[12px] font-semibold uppercase tracking-[0.1em] text-primary">{seller.name}</div>
      <h1 className="mt-2 text-[24px]/[1.25] font-semibold tracking-[-0.02em] text-foreground">
        Quotation for {q.client_name}
      </h1>
      <p className="mt-1.5 text-[13px] text-secondary-text">
        {reference} · {fmtDate(q.quotation_date)} · valid until {fmtDate(q.valid_until)}
      </p>
      {(q.contact_name || q.sales_person) && (
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          {q.contact_name ? `Prepared for ${q.contact_name}` : 'Prepared'}{q.sales_person ? ` by ${q.sales_person}` : ''}
        </p>
      )}

      {q.service_quoted && (
        <p className="mt-6 text-[14px]/[1.6] font-medium text-foreground">{q.service_quoted}</p>
      )}

      {q.lines.length > 0 && (
        <div className="mt-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Item</TableHead>
                <TableHead scope="col" className="text-right">Qty</TableHead>
                <TableHead scope="col" className="text-right">Rate</TableHead>
                <TableHead scope="col" className="text-right">GST</TableHead>
                <TableHead scope="col" className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.lines.map((l, i) => (
                <TableRow key={i}>
                  <TableCell className="whitespace-normal">
                    {l.description}
                    {Number(l.discount_percent) > 0 && (
                      <span className="ml-2 text-[12px] text-muted-foreground">{Number(l.discount_percent)}% off</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.qty)}{l.unit ? ` ${l.unit}` : ''}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMoney(l.rate, q.currency)}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.gst_rate)}%</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{fmtMoney(l.amount, q.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="mt-5 ml-auto w-full max-w-[280px] text-[13px]">
        {q.subtotal != null && (
          <div className="flex justify-between py-1 text-secondary-text">
            <span>Subtotal</span><span className="tabular-nums">{fmtMoney(q.subtotal, q.currency)}</span>
          </div>
        )}
        {q.tax_total != null && (
          <div className="flex justify-between py-1 text-secondary-text">
            <span>GST</span><span className="tabular-nums">{fmtMoney(q.tax_total, q.currency)}</span>
          </div>
        )}
        <Separator className="my-2" />
        <div className="flex justify-between text-[16px] font-semibold text-foreground">
          <span>Total</span><span className="tabular-nums">{fmtMoney(q.total, q.currency)}</span>
        </div>
      </div>

      {q.terms && (
        <div className="mt-8">
          <h2 className="text-[13px] font-semibold text-foreground">Terms</h2>
          {/* Open, not folded into a disclosure. These are the terms
              somebody is about to agree to; hiding them behind a triangle
              makes the agreement weaker and the page no shorter. */}
          <p className="mt-1.5 whitespace-pre-wrap text-[13px]/[1.65] text-secondary-text">{q.terms}</p>
        </div>
      )}

      {status === 'accepted' && (
        <Alert className="mt-8 border-settled/30 bg-settled/8">
          <Check className="size-4 text-settled" aria-hidden="true" />
          <AlertDescription className="text-secondary-text">
            Accepted by {state.data.decided_by_name} on {new Date(state.data.decided_at).toLocaleString('en-IN')}.
            Thank you — we will be in touch about the purchase order.
          </AlertDescription>
        </Alert>
      )}

      {status === 'changes_requested' && (
        <Alert className="mt-8">
          <MessageSquare className="size-4" aria-hidden="true" />
          <AlertDescription className="text-secondary-text">
            Thank you. Your requested changes went to our team, who will send a revised quotation.
          </AlertDescription>
        </Alert>
      )}

      {open && !mode && (
        <div className="mt-8">
          <Separator />
          <h2 className="mt-6 text-[15px] font-semibold text-foreground">Accept this quotation</h2>
          <p className="mt-1 text-[13px] text-secondary-text">
            Your name is recorded with the date. {seller.name} will ask for a purchase order next.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button onClick={() => setMode('accept')}>Accept quotation</Button>
            <Button variant="secondary" asChild>
              <a href={`${BASE}/${token}/pdf`} target="_blank" rel="noopener noreferrer">
                <Download className="size-4" strokeWidth={1.75} aria-hidden="true" /> Download PDF
              </a>
            </Button>
            <Button variant="ghost" onClick={() => setMode('changes')}>Ask a question</Button>
          </div>
        </div>
      )}

      {mode && (
        <form className="mt-8" onSubmit={submit}>
          <Separator />
          <h2 className="mt-6 text-[15px] font-semibold text-foreground">
            {mode === 'accept' ? 'Accept this quotation' : 'Ask a question or request a change'}
          </h2>

          <div className="mt-4 grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="accept-name">Your name</Label>
              <Input id="accept-name" value={form.name} onChange={set('name')} required autoFocus autoComplete="name" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="accept-email">Your email</Label>
              <Input id="accept-email" type="email" value={form.email} onChange={set('email')} autoComplete="email" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="accept-comment">{mode === 'accept' ? 'Anything to add (optional)' : 'What should change?'}</Label>
              <Textarea
                id="accept-comment"
                rows={mode === 'accept' ? 2 : 4}
                value={form.comment}
                onChange={set('comment')}
                required={mode === 'changes'}
              />
            </div>

            {mode === 'accept' && (
              <div className="flex items-start gap-3 rounded-[10px] border border-border bg-secondary/40 px-4 py-3">
                <Checkbox
                  id="accept-agree"
                  checked={form.agree}
                  onCheckedChange={(checked) => setForm((f) => ({ ...f, agree: checked === true }))}
                  className="mt-0.5"
                />
                <Label htmlFor="accept-agree" className="text-[13px]/[1.6] font-normal text-secondary-text">
                  I am authorised to accept {reference} for {fmtMoney(q.total, q.currency)}, on the terms above,
                  on behalf of {q.client_name}.
                </Label>
              </div>
            )}
          </div>

          {error && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="mt-5 flex flex-wrap gap-3">
            <Button type="submit" disabled={busy || (mode === 'accept' && !form.agree)}>
              {busy ? 'Sending…' : mode === 'accept' ? 'Accept quotation' : 'Send it'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => { setMode(null); setError(null); }} disabled={busy}>
              Back
            </Button>
          </div>
        </form>
      )}

      <p className="mt-10 text-[12px]/[1.6] text-muted-foreground">
        This link is personal to you and expires with the quotation. Your name, the time and your
        network address are recorded with your answer.
      </p>
    </Sheet>
  );
}
