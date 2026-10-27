/**
 * The same money reads the same everywhere. "Received" on a PO, a project
 * and the dashboard is payment_stages.amount_received, which is cash plus
 * TDS; the cash-flow forecast's received is payments.amount, cash only, and
 * its expected inflow is the gross still owed, before the client deducts TDS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('received that includes TDS says so', () => {
  assert.match(src('pages/Today.jsx'), /step: 'Received \(incl\. TDS\)'/);
  const detail = src('pages/PurchaseOrderDetail.jsx');
  assert.match(detail, /label="Received \(incl\. TDS\)"/);
  assert.match(detail, /<span>Received \(incl\. TDS\) <strong/);
  assert.match(src('pages/PurchaseOrders.jsx'), /key: 'total_received', header: 'Received \(incl\. TDS\)'/);
  const sales = src('components/SalesReportSections.jsx');
  assert.match(sales, /'Invoiced', 'Received \(incl\. TDS\)'\]/);
  assert.match(sales, /key: 'received_inr', header: 'Received \(incl\. TDS\)'/);
  assert.match(sales, /Includes GST where the PO carries it \(export POs are zero-rated\)\./);
  assert.match(src('pages/Projects.jsx'), /key: 'total_received', header: 'Received \(incl\. TDS\)'/);
  assert.match(src('pages/PaymentStages.jsx'), /key: 'amount_received', header: 'Received \(incl\. TDS\)'/);
  assert.match(src('pages/Portal.jsx'), /\['Received \(incl\. TDS\)', o\.received\]/);
});

test('the cash forecast says its inflow is gross, before TDS, and its received is cash', () => {
  assert.match(src('pages/Cashflow.jsx'), /meta="invoiced \+ scheduled, gross before TDS"/);
  const reports = src('pages/Reports.jsx');
  assert.match(reports, /columns=\{\['Month', 'Cash received', 'Invoiced, due', 'Not yet invoiced', 'Total'\]\}/);
  assert.match(reports, /gross, before TDS/);
});

test('the portal explains the columns it shows: Paid and TDS, no Received', () => {
  const portal = src('pages/Portal.jsx');
  assert.doesNotMatch(portal, /Received is what was paid plus TDS/);
  assert.match(portal, /Outstanding is the total less what was paid and the TDS deducted/);
});
