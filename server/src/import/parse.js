/**
 * Read an uploaded workbook (xlsx / xls / csv) into plain rows.
 *
 * Nothing here knows what the columns mean — that is the mapper's job.
 * This module only finds the header row, names the columns, and turns
 * cell values into strings, numbers and YYYY-MM-DD dates.
 */
import XLSX from 'xlsx';

/** Pick the sheet with the most rows that has a recognisable header. */
export function readWorkbook(buffer, preferredSheet) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellNF: true });
  const candidates = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const grid = sheetToGrid(ws);
    const headerIdx = findHeaderRow(grid);
    return { name, grid, headerIdx, dataRows: headerIdx < 0 ? 0 : grid.length - headerIdx - 1 };
  });

  let pick = preferredSheet ? candidates.find((c) => c.name === preferredSheet) : null;
  if (!pick) pick = candidates.filter((c) => c.headerIdx >= 0).sort((a, b) => b.dataRows - a.dataRows)[0];
  if (!pick) throw new Error('No sheet with a header row was found in this file');

  const headers = pick.grid[pick.headerIdx].map((h, i) => cleanHeader(h, i));
  const rows = [];
  for (let r = pick.headerIdx + 1; r < pick.grid.length; r++) {
    const raw = pick.grid[r];
    if (!raw || raw.every((v) => v === null || v === '')) continue;
    const row = { __row: r + 1 };
    headers.forEach((h, i) => { row[h] = normaliseCell(raw[i]); });
    rows.push(row);
  }

  return {
    sheet: pick.name,
    sheets: wb.SheetNames,
    headers,
    rows,
  };
}

/**
 * Cell grid with dates resolved from their Excel serial number, so a date
 * typed as 22 Jan comes out as 2026-01-22 regardless of the machine's time
 * zone. A numeric cell is a date when its number format says so, or when
 * Excel rendered it like 1/7/26.
 */
function sheetToGrid(ws) {
  const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
  if (!range) return [];
  const grid = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell || cell.v === null || cell.v === undefined) { row.push(null); continue; }
      if (cell.t === 'n' && ((cell.z && XLSX.SSF.is_date(cell.z)) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(String(cell.w || '')))) {
        const d = XLSX.SSF.parse_date_code(cell.v);
        row.push(d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : null);
        continue;
      }
      row.push(cell.t === 'd' && cell.v instanceof Date ? toISODate(cell.v) : cell.v);
    }
    grid.push(row);
  }
  return grid;
}

/** The header row is the first row with at least three short text cells. */
function findHeaderRow(grid) {
  for (let r = 0; r < Math.min(grid.length, 25); r++) {
    const cells = (grid[r] || []).filter((v) => typeof v === 'string' && v.trim() && v.trim().length < 60);
    if (cells.length >= 3) return r;
  }
  return -1;
}

function cleanHeader(h, i) {
  const s = h === null || h === undefined ? '' : String(h).replace(/\s+/g, ' ').trim();
  return s || `column_${i + 1}`;
}

function normaliseCell(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v) ? null : toISODate(v);
  if (typeof v === 'number') return v;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (s === '' || /^(n\/?a|na|-|—|not sent|nil)$/i.test(s)) return null;
  const d = parseDate(s);
  if (d) return d;
  return s;
}

function toISODate(d) {
  // Sheets store dates without a time zone; use the local calendar date.
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** dd.mm.yyyy, dd/mm/yyyy, dd-mm-yyyy → ISO. Anything else → null. */
export function parseDate(s) {
  const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

/**
 * "7,96,500/-" → {amount: 796500, currency: null}
 * "$8640"      → {amount: 8640, currency: 'USD'}
 * 33000        → {amount: 33000, currency: null}
 */
export function parseMoney(v) {
  if (v === null || v === undefined || v === '') return { amount: null, currency: null };
  if (typeof v === 'number') return { amount: v, currency: null };
  let s = String(v);
  const code = /\b(USD|EUR|GBP|AED|SGD|INR)\b/i.exec(s);
  const currency = s.includes('$') ? 'USD' : s.includes('€') ? 'EUR' : s.includes('£') ? 'GBP' : code ? code[1].toUpperCase() : null;
  // "23,36.400/-": a comma-grouped amount with a dot before exactly three
  // digits is a mistyped comma (Indian grouping), not a decimal point.
  let reinterpreted = null;
  if (/\d,\d{2}\.\d{3}\b/.test(s)) { reinterpreted = s.trim(); s = s.replace(/(\d,\d{2})\.(\d{3})\b/, '$1,$2'); }
  const cleaned = s.replace(/\/-/g, '').replace(/[$€£₹,]/g, '').replace(/\b(INR|USD|EUR|GBP|AED|SGD)\b/gi, '').trim();
  const n = Number(cleaned);
  return { amount: Number.isFinite(n) && cleaned !== '' ? n : null, currency, reinterpreted };
}
