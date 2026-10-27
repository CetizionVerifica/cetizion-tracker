/**
 * HR's travel workbook, every tab (#196 §5.1): one tab a month, one row a
 * leg. Each tab finds its own header row and keeps its own headers, because
 * they drift: Aug has two "PO No." columns and an unnamed one, Sept and Oct
 * add "Against Invoice".
 *
 *   readTravelWorkbook(buffer) → { tabs: [{ name, headers, rows, empty }] }
 *
 * rows: [{ __row, cells: { header: value } }], in sheet order, blank rows
 * left out. A duplicated header keeps both columns, the second as
 * "PO No. (2)"; an unnamed one is named by its column letter. `empty` lists
 * the headers no row fills, which the review shows as ignored.
 */
import XLSX from 'xlsx';
import { sheetToGrid } from '../parse.js';
import { headerScore, normHeader } from './fields.js';

const MAX_HEADER_SEARCH = 15;

function openWorkbook(buffer) {
  const zip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  const ole = buffer[0] === 0xd0 && buffer[1] === 0xcf;
  if (zip || ole) return XLSX.read(buffer, { type: 'buffer', cellDates: false, cellNF: true });
  // A CSV: its cells stay text, so 03/04/2026 is not turned into 4 March.
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { text = new TextDecoder('latin1').decode(buffer); }
  return XLSX.read(text.replace(/^﻿/, ''), { type: 'string', raw: true, cellNF: true });
}

const columnLetter = (i) => XLSX.utils.encode_col(i);

export function readTravelWorkbook(buffer) {
  const wb = openWorkbook(buffer);
  const tabs = [];
  for (const name of wb.SheetNames) {
    const grid = sheetToGrid(wb.Sheets[name]);
    if (!grid.length) continue;
    let headerIdx = -1; let best = 0;
    for (let r = 0; r < Math.min(grid.length, MAX_HEADER_SEARCH); r++) {
      const score = headerScore(grid[r] || []);
      if (score > best) { best = score; headerIdx = r; }
    }
    // Two known headers at least, or this tab is not a travel list (a notes tab, a pivot).
    if (headerIdx < 0 || best < 2) continue;
    const seen = new Map();
    const headers = grid[headerIdx].map((h, i) => {
      const text = h === null || h === undefined || String(h).trim() === '' ? `Column ${columnLetter(i)}` : String(h).replace(/\s+/g, ' ').trim();
      const key = normHeader(text);
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      return n > 1 ? `${text} (${n})` : text;
    });
    const rows = [];
    for (let r = headerIdx + 1; r < grid.length; r++) {
      const raw = grid[r];
      if (!raw || raw.every((v) => v === null || v === '' || (typeof v === 'string' && !v.trim()))) continue;
      // A header repeated part-way down (a pasted block) is not a row.
      if (headerScore(raw) >= Math.max(2, best - 1)) continue;
      const cells = {};
      headers.forEach((h, i) => { cells[h] = typeof raw[i] === 'string' ? raw[i].trim() : raw[i] ?? null; });
      rows.push({ __row: r + 1 + (grid.firstRow || 0), cells });
    }
    const empty = headers.filter((h) => rows.every((row) => row.cells[h] === null || row.cells[h] === ''));
    tabs.push({ name, headers, rows, empty });
  }
  return { tabs };
}
