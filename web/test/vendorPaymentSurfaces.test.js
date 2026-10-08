import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The vendor payment screens, checked where a unit test cannot reach (#214).
 *
 * The web suite is pure logic — there is no renderer here — so the rules
 * that live in JSX are checked against the source instead:
 *
 *   - one payment dialog, not two that drift apart;
 *   - every surface that draws a Pay action asks the role first;
 *   - the correction is behind the administrator's gate, never HR's;
 *   - nothing recomputes an agency status the backing views already derive.
 */

const SRC = join(new URL('..', import.meta.url).pathname, 'src');

const read = (path) => readFileSync(join(SRC, path), 'utf8');

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.jsx?$/.test(name) ? [path] : [];
  });
}

/** Source with comments stripped, so a note about a thing is not the thing. */
const code = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * One exported function's own source, and nothing after it.
 *
 * Slicing from a declaration to the end of the file swept the next dialog in
 * with it, which is how a check that the bulk dialog offers no correction
 * passed judgement on the correction dialog sitting underneath it.
 */
function section(text, name) {
  const from = text.indexOf(`export function ${name}`);
  assert.ok(from >= 0, `no export function ${name}`);
  const next = text.indexOf('\nexport function ', from + 1);
  return next < 0 ? text.slice(from) : text.slice(from, next);
}

const SURFACES = [
  'pages/VendorInvoices.jsx',
  'pages/VendorInvoiceDetail.jsx',
  'pages/TripDetail.jsx',
  'pages/Worklist.jsx',
];

test('there is one vendor payment dialog in the app', () => {
  const declaring = files(SRC).filter((path) => /export function PayVendorDialog/.test(readFileSync(path, 'utf8')));
  assert.equal(declaring.length, 1, `declared in: ${declaring.join(', ')}`);
  assert.match(declaring[0], /components\/vendorPayments\.jsx$/);
});

test('every surface that opens the dialog imports it from that one place', () => {
  for (const surface of SURFACES.filter((s) => /PayVendorDialog/.test(read(s)))) {
    assert.match(
      read(surface),
      /import \{[^}]*PayVendorDialog[^}]*\} from '\.\.\/components\/vendorPayments\.jsx'/,
      surface
    );
  }
});

test('every surface with a Pay action asks the role before drawing it', () => {
  for (const surface of SURFACES) {
    const text = code(read(surface));
    if (!/PayVendorDialog/.test(text)) continue;
    assert.match(text, /mayRecordVendorPayment\(\{ isAdmin, isHr \}\)/, `${surface} must ask the role`);
    assert.match(text, /useAuth\(\)/, `${surface} must read the canonical auth state`);
    // Never from the route or the path: the role is a fact the session
    // carries, and guessing it from where somebody is standing is how a
    // screen ends up disagreeing with the server.
    assert.doesNotMatch(text, /location\.pathname[^\n]*(admin|hr)/i, `${surface} must not infer a role from the route`);
  }
});

test('the correction is the administrator\'s, and HR cannot reach it', () => {
  const detail = code(read('pages/VendorInvoiceDetail.jsx'));
  assert.match(detail, /mayCorrectVendorPayment\(\{ isAdmin \}\)/);
  assert.doesNotMatch(detail, /mayCorrectVendorPayment\(\{[^}]*isHr/, 'HR must not satisfy the correction gate');
  assert.match(detail, /mayCorrect && payments\?\.length > 0/, 'the action is drawn only for an administrator');

  // And the dialog is only ever rendered behind that gate.
  const correctionSurfaces = files(SRC)
    .filter((path) => /<CorrectVendorPaymentDialog/.test(readFileSync(path, 'utf8')));
  assert.equal(correctionSurfaces.length, 1, `rendered in: ${correctionSurfaces.join(', ')}`);
});

test('the history is drawn from the reply, so a role it is withheld from sees none', () => {
  const detail = code(read('pages/VendorInvoiceDetail.jsx'));
  // The server leaves `payments` out altogether rather than sending []. An
  // absent list must stay absent, not become an empty history with totals.
  assert.match(detail, /const payments = data\?\.data\?\.payments;/);
  assert.doesNotMatch(detail, /data\?\.data\?\.payments \?\? \[\]/, 'an absent ledger is not an empty one');

  const history = code(read('components/vendorPayments.jsx'));
  assert.match(history, /if \(!payments\) return null;/);
});

test('the agency status is the backing view\'s, mapped and never recalculated', () => {
  for (const surface of ['pages/TravelLogs.jsx', 'pages/TripDetail.jsx', 'pages/VendorInvoices.jsx', 'pages/Worklist.jsx']) {
    const text = code(read(surface));
    assert.match(text, /agency(Trip|Invoice)Chip\(/, `${surface} must use the shared mapping`);
  }
  // The regex ladder TripDetail used to decide a bill's tone for itself is
  // gone: the view already says what the status is.
  assert.doesNotMatch(code(read('pages/TripDetail.jsx')), /function billTone/);
});

/* ----------------------------------------- one transfer, several bills */

/**
 * The bulk transfer (#214 §2.6). This replaces the "no bulk payment has
 * crept in" guard that stood here while the single payment was the only one
 * built: paying the agency monthly is now a thing the screen does, so what
 * is checked is that it is drawn behind the same role gate, against the same
 * server limit, and that it did not quietly become a correction route.
 */

test('there is one bulk payment dialog, in the same file as the single one', () => {
  const declaring = files(SRC).filter((path) => /export function BulkPayVendorDialog/.test(readFileSync(path, 'utf8')));
  assert.equal(declaring.length, 1, `declared in: ${declaring.join(', ')}`);
  assert.match(declaring[0], /components\/vendorPayments\.jsx$/,
    'the bulk dialog belongs beside the single one, so the TDS and the overpayment wording cannot drift apart');
});

test('the selection and the bulk action are drawn only for the two roles that may pay', () => {
  const list = code(read('pages/VendorInvoices.jsx'));
  assert.match(list, /mayBulkPayVendorInvoices\(\{ isAdmin, isHr \}\)/, 'the list must ask the role');
  assert.match(list, /selection=\{mayBulk \?/, 'no checkbox column for a role that may not pay');
  assert.match(list, /useAuth\(\)/, 'from the canonical auth state');
  assert.doesNotMatch(list, /location\.pathname[^\n]*(admin|hr)/i, 'never inferred from the route');
  // Sales is refused by the same helper the single Pay action uses, so the
  // two cannot disagree about who pays an agency.
  const lib = code(read('lib/vendorPayments.js'));
  assert.match(lib, /mayBulkPayVendorInvoices = \(\{ isAdmin, isHr \} = \{\}\) => Boolean\(isAdmin \|\| isHr\)/);
});

test('a row of another agency is disabled with the reason on it, not refused after submit', () => {
  const list = code(read('pages/VendorInvoices.jsx'));
  assert.match(list, /blockedReason: \(row\) => bulkBlockedReason\(row, chosen\)/,
    'the list asks the shared rule, measured against what is already ticked');

  const page = code(read('components/ListPage.jsx'));
  assert.match(page, /disabled=\{Boolean\(blocked\)\}/, 'a blocked row cannot be ticked');
  assert.match(page, /title=\{blocked \|\| undefined\}/, 'and says why where the reader is');
  assert.match(page, /const blocked = picked \? null : selection\.blockedReason\?\.\(row\)/,
    'a row already ticked is never blocked, so unticking stays possible');
});

test('the dialog and the server hold the same maximum', () => {
  const lib = code(read('lib/vendorPayments.js'));
  const [, webLimit] = lib.match(/MAX_BULK_VENDOR_INVOICES = (\d+)/) || [];
  const server = readFileSync(join(SRC, '..', '..', 'server', 'src', 'routes', 'workflow.js'), 'utf8');
  const [, serverLimit] = code(server).match(/MAX_BATCH_ALLOCATIONS = (\d+)/) || [];
  assert.ok(webLimit, 'the web side names a limit');
  assert.equal(webLimit, serverLimit,
    'the dialog must refuse at the same number the route does, or the limit is a 422 instead of a sentence');
});

test('the bulk dialog keeps the cash and the deduction apart, and totals all three', () => {
  const dialog = code(read('components/vendorPayments.jsx'));
  const bulk = section(dialog, 'BulkPayVendorDialog');
  // A row per bill, each with its own two inputs.
  assert.match(bulk, /Amount transferred to \$\{/, 'a transfer input per bill, labelled by the bill');
  assert.match(bulk, /Tax deducted on \$\{/, 'and a TDS input of its own, never folded into the cash field');
  assert.match(bulk, /money\(totals\.transferred\)/);
  assert.match(bulk, /money\(totals\.tds\)/);
  assert.match(bulk, /money\(totals\.settled\)/);
});

test('the shared half of the transfer is asked for once', () => {
  const dialog = code(read('components/vendorPayments.jsx'));
  const bulk = section(dialog, 'BulkPayVendorDialog');
  assert.match(bulk, /label="Paid on"/);
  assert.match(bulk, /options=\{VENDOR_PAYMENT_MODES\}/, 'the six modes the server accepts, from the shared list');
  assert.match(bulk, /label="Reference"/);
  assert.match(bulk, /label="Payment proof"/);
  // Today is the latest the picker offers, as it is for a single payment.
  assert.match(bulk, /max=\{todayIso\(\)\}/);
  // One upload for one transfer, shared by every row it writes.
  assert.match(bulk, /const documentId = proof \? await uploadDocument\(proof, PROOF_OWNER\) : null;/);
});

test('overpayment is warned about and confirmed, never blocked', () => {
  const dialog = code(read('components/vendorPayments.jsx'));
  const bulk = section(dialog, 'BulkPayVendorDialog');
  assert.match(bulk, /totals\.overpaid > 0/, 'the aggregate warning');
  assert.match(bulk, /row\.overBy > 0/, 'and a warning on the row that causes it');
  assert.match(bulk, /if \(totals\.overpaid > 0 && !armed\) \{\s*setArmed\(true\);\s*return;\s*\}/,
    'explicit confirmation before the transfer is sent');
  assert.doesNotMatch(bulk, /Math\.min\(/, 'nothing reduces a figure the person typed');
});

test('the success line is the server\'s figures, and failure claims nothing', () => {
  const dialog = code(read('components/vendorPayments.jsx'));
  const bulk = section(dialog, 'BulkPayVendorDialog');
  assert.match(bulk, /bulkResultSummary\(reply\?\.meta, money\)/,
    'the totals quoted are the ones the server worked out after the write');
  // A refusal means no bill moved, so nothing closes and nothing is cleared:
  // the typed figures stay where they are with the server's message above.
  assert.match(bulk, /if \(!ok\) return;/);
  const list = code(read('pages/VendorInvoices.jsx'));
  assert.match(list, /onDone=\{\(\) => \{[^}]*setPicked\(new Map\(\)\)/s,
    'a success clears the selection');
  assert.match(list, /setVersion\(\(v\) => v \+ 1\)/, 'and re-reads the list');
});

test('a pick that has left the list stops being a pick', () => {
  const page = code(read('components/ListPage.jsx'));
  assert.match(page, /if \(!selection\?\.onVisible \|\| loading\) return;/,
    'and not while the list is loading, where rows are empty for a moment');
  const list = code(read('pages/VendorInvoices.jsx'));
  assert.match(list, /for \(const id of current\.keys\(\)\) if \(visible\.has\(id\)\) next\.set\(id, visible\.get\(id\)\)/);
});

test('bulk correction was not built: nothing here reverses or corrects in bulk', () => {
  const lib = code(read('lib/vendorPayments.js'));
  const dialog = code(read('components/vendorPayments.jsx'));
  const bulk = section(dialog, 'BulkPayVendorDialog');

  // Correcting stays one bill at a time, on its own page, for an admin.
  assert.doesNotMatch(bulk, /correct/i, 'the bulk dialog must not offer a correction');
  assert.doesNotMatch(bulk, /pay\/correct/);
  // And every figure the bulk path can send is non-negative.
  assert.match(lib, /export function bulkPayBody/, 'the bulk body has one shaping function');
  const bulkInputs = bulk.match(/<Input\s+type="number"[^>]*>/gs) || [];
  assert.equal(bulkInputs.length, 2, 'the two allocation inputs');
  for (const input of bulkInputs) assert.match(input, /min="0"/, 'a bulk figure cannot be negative');

  for (const path of files(SRC)) {
    const text = code(readFileSync(path, 'utf8'));
    assert.doesNotMatch(text, /vendor-payments\/batch\/correct/i, path);
    assert.doesNotMatch(text, /bulkCorrect/i, path);
  }
});

test('the single payment flow is untouched beside it', () => {
  const list = code(read('pages/VendorInvoices.jsx'));
  // The per-row Pay button, its gate and its dialog are all still there.
  assert.match(list, /mayRecordVendorPayment\(\{ isAdmin, isHr \}\)/);
  assert.match(list, /setPaying\(r\)/);
  assert.match(list, /<PayVendorDialog/);
  // And the bulk action is an addition, not a replacement: both render.
  assert.match(list, /<BulkPayVendorDialog/);
});
