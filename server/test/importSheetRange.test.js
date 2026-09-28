import { test } from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { sheetToGrid, readWorkbook } from '../src/import/parse.js';

// How much of a sheet the importer reads. A sheet that claims to be far
// bigger than its data is ordinary: one stray format and Excel says so.

const rows = [
  ['S.No', 'Client Name', 'Deal Stage', 'PO Amount'],
  [1, 'Laurus Labs', 'Closed Won (100%)', 796500],
  [2, 'Hetero', 'Submitted', 300000],
];

test('a sheet claiming the whole grid is read to where its data ends', () => {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!ref'] = 'A1:XFD1048576';
  const grid = sheetToGrid(ws);
  assert.equal(grid.length, 3);
  assert.equal(grid[0].length, 4);
  assert.deepEqual(grid[1], [1, 'Laurus Labs', 'Closed Won (100%)', 796500]);
});

test('reading it stays quick instead of walking a billion empty cells', () => {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!ref'] = 'A1:XFD1048576';
  const started = Date.now();
  sheetToGrid(ws);
  assert.ok(Date.now() - started < 1000, 'the declared range is no longer walked cell by cell');
});

test('an honest range is read exactly as before', () => {
  const grid = sheetToGrid(XLSX.utils.aoa_to_sheet(rows));
  assert.equal(grid.length, 3);
  assert.deepEqual(grid[2], [2, 'Hetero', 'Submitted', 300000]);
});

test('an empty sheet gives no rows', () => {
  const ws = XLSX.utils.aoa_to_sheet([[]]);
  ws['!ref'] = 'A1:ZZ10000';
  assert.deepEqual(sheetToGrid(ws), []);
});

test('the rows still carry their own sheet row number', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sales');
  const parsed = readWorkbook(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  assert.deepEqual(parsed.rows.map((r) => [r.__row, r['Client Name']]), [[2, 'Laurus Labs'], [3, 'Hetero']]);
});
