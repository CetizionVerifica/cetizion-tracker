/**
 * A PO's currency follows the quotation it fulfils. Picking the quotation
 * fills the currency in, and a currency that no longer matches is flagged —
 * usually the dropdown left at its INR default, which every report would
 * then read as rupees. Only the currency is compared, never the amount: POs
 * for part of a quotation (50/50, 30/70) are normal. The server makes the
 * same check on save (purchaseOrders.js), for the saves no form sees.
 */

const currencyOf = (quotations, quotationNo) =>
  quotationNo ? quotations.find((q) => q.quotation_no === quotationNo)?.currency : undefined;

/** The warning for these values, or null — the same wording the server sends. */
export function poCurrencyWarning(quotations, { quotation_no: quotationNo, currency }) {
  const expected = currencyOf(quotations, quotationNo);
  if (!expected || !currency || currency === expected) return null;
  return `Quotation ${quotationNo} is in ${expected}, but this PO is in ${currency}. ` +
    'Check the currency: the reports convert the PO value from the currency saved here.';
}

/** RecordForm props for a PO form's quotation_no and currency fields. */
export function poCurrencyFields(quotations) {
  return {
    quotation: {
      fills: (quotationNo) => {
        const currency = currencyOf(quotations, quotationNo);
        return currency ? { currency } : {};
      },
    },
    currency: { warn: (values) => poCurrencyWarning(quotations, values) },
  };
}
