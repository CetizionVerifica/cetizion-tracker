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

test('no bulk vendor payment has crept in — that is a later change', () => {
  for (const path of files(SRC)) {
    const text = code(readFileSync(path, 'utf8'));
    assert.doesNotMatch(text, /bulk[-_]?(vendor)?[-_]?pay/i, path);
    assert.doesNotMatch(text, /vendor-invoices\/bulk/i, path);
  }
});
