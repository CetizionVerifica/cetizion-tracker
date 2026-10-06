/**
 * A made-up travel agency workbook in the shapes HR's real one has (#196
 * §1): a tab a month whose headers drift, a typed text date, two "PO No."
 * columns and an unnamed check-mark column, invoices shared by legs and by
 * people, a cancellation in the remarks, credit and cancellation notes,
 * and a hotel tab. Every name, number and client is invented.
 */
import XLSX from 'xlsx';

const d = (iso) => new Date(`${iso}T00:00:00Z`);

export const JULY = [
  ['Travel bookings, July'],
  [],
  ['Date of Journey', 'Name of the person', 'from', 'to', 'Airlines', 'Amount', 'Admin charges', 'GST', 'Total Amt', 'Dt of Booking',
    'Checking', 'Difference', 'Types: Marketing/Non-Chargeable, Chargeable', 'Client Name', 'PO No.',
    'Included in customer invoice (yes/No) / if yes, invoice number', 'Service Request No.', 'Remarks'],
  // Out and back: one trip, one invoice for both legs, linked by PO.
  [d('2026-07-08'), 'Asha Rao', 'Pune', 'hyderabad', 'indigo', 5000, 200, 936, 6136, d('2026-07-06'), null, null, null, 'Example Pharma', 'PO-TI-1', 'HT/2627/1001', null, null],
  [d('2026-07-12'), 'asha rao', 'Hyderabad', 'Pune', 'Air-India Exp', 4000, 200, 756, 4956, d('2026-07-06'), null, null, null, null, null, 'HT/2627/1001', null, null],
  // A first name only, a text date, a service request that finds the project, a total left blank.
  ['20 july,22', 'Kiran', 'Mumbai', 'Delhi', 'air india', 6000, 200, 1116, null, d('2026-07-15'), null, null, null, 'Example Chemicals', null, 'HT/2627/1002', 'cv 201', null],
  // Two people on one invoice; a PO cell that holds a client's name.
  [d('2026-07-25'), 'Vikram Joshi', 'Pune', 'Chennai', 'indigo', 3000, 200, 576, 3776, d('2026-07-20'), null, null, null, null, 'Megafine Example', 'HT/2627/1003', null, null],
  [d('2026-07-25'), 'Neha Iyer', 'Pune', 'Chennai', 'indigo', 3000, 200, 576, 3776, d('2026-07-20'), null, null, null, null, 'Megafine Example', 'HT/2627/1003', null, null],
];

export const AUG = [
  ['Date of Journey', 'Name of the person', 'from', 'to', 'Airlines', 'Amount', 'Admin charges', 'GST', 'Total Amt', 'Dt of Booking',
    'Types: Marketing/Non-Chargeable, Chargeable', 'Client Name', 'PO No.', 'PO No.',
    'Included in customer invoice (yes/No) / if yes, invoice number', 'Service Request No.', 'Remarks', 'credit note No.', null],
  // An internal trip, typed as such; the second PO No. column is the filled one.
  [d('2026-08-04'), 'Neha Iyer', 'Pune', 'Bengaluru', 'indigo', 4500, 200, 846, 5546, d('2026-08-01'), 'Internal', 'Office Audit', null, null, 'HT/2627/1101', null, null, null, 'ok'],
  // A booking whose return was cancelled, with the charge kept in the remark.
  [d('2026-08-10'), 'Vikram Joshi', 'Pune', 'Kolkata', 'indigo', 7000, 200, 1296, 8496, d('2026-08-02'), null, 'Example Pharma', null, 'PO-TI-1', 'HT/2627/1102', null, 'return ticket is cancelled(1500 deducted)', null, 'ok'],
  // The credit note for a refund on that invoice.
  [d('2026-08-10'), 'Vikram Joshi', 'Pune', 'Kolkata', 'indigo', -2000, null, null, -2000, d('2026-08-12'), null, null, null, null, 'HT/2627/1102', null, 'refund', 'HT/2627/CN/301', null],
  // A wording that is not a trip type.
  [d('2026-08-20'), 'Asha Rao', 'Pune', 'Goa', 'indigo', 3500, 200, 666, 4366, d('2026-08-15'), 'Conference', 'Trade Expo', null, null, 'HT/2627/1103', null, null, null, null],
];

export const SEPT = [
  ['Date of Journey', 'Name of the person', 'from', 'to', 'Airlines', 'Amount', 'Admin charges', 'GST', 'Total Amt', 'Dt of Booking',
    'Client Name', 'PO No.', 'Included in customer invoice (yes/No) / if yes, invoice number', 'Remarks', 'Against Invoice'],
  [d('2026-09-03'), 'Asha Rao', 'Pune', 'Jaipur', 'indigo', 5500, 200, 1026, 6726, d('2026-08-30'), 'Example Pharma', 'PO-TI-1', 'HT/2627/1201', null, null],
  // The cancellation note for that whole booking.
  [d('2026-09-03'), 'Asha Rao', 'Pune', 'Jaipur', 'indigo', 5000, null, null, 5000, d('2026-09-01'), null, null, 'HT/2627/CNT/151', 'cancel', 'HT/2627/1201'],
];

export const HOTELS = [
  ['Name of the person', 'Hotel', 'to', 'Check-in', 'Check-out', 'Amount', 'Admin charges', 'GST', 'Total Amt', 'Dt of Booking', 'PO No.', 'Invoice No'],
  ['Asha Rao', 'Example Residency', 'Hyderabad', d('2026-07-08'), d('2026-07-12'), 8000, 0, 960, 8960, d('2026-07-06'), 'PO-TI-1', 'HT/2627/1004'],
];

export function travelWorkbook({ july = JULY, aug = AUG, sept = SEPT, hotels = HOTELS } = {}) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of [['July', july], ['Aug', aug], ['Sept', sept], ['Hotels Jul', hotels]]) {
    if (rows) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
