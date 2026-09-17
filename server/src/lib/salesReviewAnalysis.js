import { amounts, compactInr, decimal, number, percent, plural } from './reportFormat.js';

/**
 * The written analysis in the sales review PDF: fixed rules over the report
 * figures, so the same data always reads the same way. No AI and no outside
 * service. Each insight is { tag, tone, text }; tone is good, watch, risk,
 * action or note and sets its colour.
 *
 * Thresholds: a rate of 60% or more reads as strong and under 40% as weak;
 * one sector with half the won value, or two clients with 35%, is flagged as
 * concentration; less than half of PO value invoiced, or less than 70% of
 * invoices collected, is named as the priority.
 */

const insight = (tag, tone, text) => ({ tag, tone, text });
const was = (n) => (n === 1 ? 'was' : 'were');
const is = (n) => (n === 1 ? 'is' : 'are');
const has = (n) => (n === 1 ? 'has' : 'have');
const share = (part, whole) => (whole > 0 ? part / whole : null);

/** "A", "A and B", "A, B and C". */
const joinNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

// ------------------------------------------------------------ 1. volume
export function enquiryAnalysis(enquiries, today) {
  const t = enquiries.total;
  if (!t.enquiries) {
    return {
      lead: 'No enquiries were logged on the Enquiries page in this period.',
      insights: [
        insight('WATCH', 'watch', 'Enquiry volume and conversion cannot be measured until enquiries are logged. Record every new enquiry on the Enquiries page before it is quoted.'),
      ],
    };
  }

  const months = enquiries.months.filter((m) => m.month).length;
  let lead = `${plural(t.enquiries, 'enquiry', 'enquiries')} ${was(t.enquiries)} logged on the Enquiries page`;
  if (months > 1) lead += ` over ${months} months, an average of ${decimal(enquiries.average_per_month)} a month`;
  lead += '.';
  if (months > 1 && enquiries.busiest) {
    lead += ` The busiest month was ${enquiries.busiest.label}, with ${plural(enquiries.busiest.enquiries, 'enquiry', 'enquiries')}.`;
  }

  const insights = [];
  const tone = t.quote_rate >= 0.6 ? 'good' : t.quote_rate < 0.4 ? 'watch' : 'note';
  insights.push(insight(tone === 'watch' ? 'WATCH' : 'HEADLINE', tone,
    `${number(t.quoted)} of ${plural(t.enquiries, 'enquiry', 'enquiries')} (${percent(t.quote_rate)}) reached a quotation; ` +
    `${number(t.declined)} ${was(t.declined)} declined and ${number(t.in_progress)} ${is(t.in_progress)} still in progress.`));

  const declined = share(t.declined, t.enquiries);
  if (t.declined >= 3 && declined >= 0.3) {
    insights.push(insight('WATCH', 'watch', `${percent(declined)} of enquiries were declined. Noting the reason on each one (price, scope, capacity or fit) would show which could have been won.`));
  }
  if (enquiries.oldest_open && today) {
    const days = daysBetween(enquiries.oldest_open.enquiry_date, today);
    if (days > 30) {
      insights.push(insight('ACTION', 'action',
        `${plural(t.in_progress, 'enquiry', 'enquiries')} ${is(t.in_progress)} still in progress; the oldest, ${enquiries.oldest_open.client} ` +
        `(${enquiries.oldest_open.enquiry_no}), has been open ${days} days. Quote or close enquiries older than 30 days.`));
    }
  }
  if (t.enquiries < 10) {
    insights.push(insight('NOTE', 'note', `With only ${plural(t.enquiries, 'enquiry', 'enquiries')}, each one moves the percentages by about ${Math.round(100 / t.enquiries)} points, so read the rates as indicative.`));
  }
  return { lead, insights };
}

// -------------------------------------------------- 2. quotation status
/** quotes: quotationStatusSummary() — the statuses on the Quotations page. */
export function quotationStatusAnalysis(quotes) {
  const t = quotes.total;
  const insights = [];
  if (!t.quotations) return { lead: 'No quotations were raised in this period.', insights };

  const lead = `${plural(t.quotations, 'quotation')} ${was(t.quotations)} raised in the period: ${number(t.submitted)} submitted, ` +
    `${number(t.negotiating)} under negotiation, ${number(t.on_hold)} on hold, ${number(t.won)} won and ${number(t.lost)} lost.`;
  const byStatus = Object.fromEntries(quotes.rows.map((row) => [row.status, row]));

  if (t.won + t.lost) {
    const tone = t.win_rate >= 0.6 ? 'good' : t.win_rate < 0.4 ? 'risk' : 'watch';
    const won = byStatus['Won - PO Received']?.value_inr ?? 0;
    insights.push(insight(tone === 'good' ? 'HEADLINE' : 'WATCH', tone,
      `${number(t.won)} won and ${number(t.lost)} lost: a ${percent(t.win_rate)} win rate on decided quotations${won ? `, with ${compactInr(won)} won` : ''}.`));
  } else {
    insights.push(insight('NOTE', 'note', 'No quotation in the period has been won or lost yet.'));
  }

  if (t.open) {
    let text = `${plural(t.open, 'quotation')} ${is(t.open)} still open`;
    if (t.open_without_value === t.open) {
      text += `, but ${t.open === 1 ? 'it has no' : 'none has a'} value entered, so the pipeline cannot be valued.`;
    } else {
      text += `, worth ${compactInr(t.open_value_inr)}${t.open_unconverted.length ? ` plus ${amounts(t.open_unconverted)}` : ''}`;
      text += t.open_without_value
        ? `, and ${number(t.open_without_value)} of them ${has(t.open_without_value)} no value entered, so the real pipeline is larger.`
        : '.';
    }
    insights.push(insight('PIPELINE', 'action', text));
  }

  const negotiating = byStatus['Under Negotiation'];
  // Only when most of them carry a value; otherwise the estimate would rest on a few quotations.
  if (t.negotiating >= 3 && t.win_rate !== null && negotiating?.value_inr > 0 && negotiating.without_value * 2 < t.negotiating) {
    insights.push(insight('OPPORTUNITY', 'action',
      `${plural(t.negotiating, 'quotation')} worth ${compactInr(negotiating.value_inr)} ${is(t.negotiating)} under negotiation. ` +
      `At the current ${percent(t.win_rate)} win rate, roughly ${compactInr(negotiating.value_inr * t.win_rate)} of that would convert.`));
  }
  if (t.on_hold && t.on_hold / t.open >= 0.2) {
    insights.push(insight('WATCH', 'watch',
      `${plural(t.on_hold, 'quotation')} ${is(t.on_hold)} on hold. Confirm whether each is still live, or mark it lost, so the pipeline stays accurate.`));
  }
  if (t.submitted >= 3 && t.submitted / t.open >= 0.5) {
    insights.push(insight('ACTION', 'action',
      `${plural(t.submitted, 'quotation')} ${is(t.submitted)} still at Submitted, with no negotiation recorded. Follow them up to move them forward or close them.`));
  }
  return { lead, insights };
}

// ----------------------------------------------------------- 3. sectors
/** rows: the sector rows with won_value_inr added. */
export function sectorAnalysis(sectors, rows) {
  const s = sectors.summary;
  const insights = [];
  if (!s.pos) return { lead: 'No POs were won in this period, so there is no sector split of won business.', insights };

  const named = rows.filter((row) => !row.not_set && row.pos > 0);
  const lead = `${plural(s.pos, 'PO')} ${was(s.pos)} won across ${plural(named.length, 'sector')}` +
    `${s.pos_without_sector ? `, and ${number(s.pos_without_sector)} ${has(s.pos_without_sector)} no sector` : ''}.`;

  const totalInr = rows.reduce((sum, row) => sum + row.won_value_inr, 0);
  const top = [...named].sort((a, b) => b.won_value_inr - a.won_value_inr)[0];
  const unsetValue = share(rows.find((row) => row.not_set)?.won_value_inr ?? 0, totalInr);
  const unset = share(s.pos_without_sector, s.pos);
  // When most won business has no sector, naming the "largest sector" would mislead.
  const unreliable = s.pos_without_sector > 0 && (unsetValue >= 0.5 || unset >= 0.5);
  if (unreliable) {
    insights.push(insight('WATCH', 'watch',
      `${number(s.pos_without_sector)} of ${plural(s.pos, 'won PO')} ${has(s.pos_without_sector)} no sector` +
      `${unsetValue === null ? '' : `, holding ${percent(unsetValue)} of won value`}, so the sector split is not reliable yet.` +
      `${top && top.won_value_inr > 0 ? ` Of the sectors entered, ${top.sector} is the largest at ${compactInr(top.won_value_inr)} from ${plural(top.pos, 'PO')}.` : ''}` +
      ' Set the sector on those quotations.'));
  } else if (top && top.won_value_inr > 0 && totalInr > 0) {
    const topShare = top.won_value_inr / totalInr;
    const concentrated = named.length >= 2 && topShare >= 0.5;
    insights.push(insight(concentrated ? 'RISK' : 'HEADLINE', concentrated ? 'risk' : 'good',
      `${top.sector} is the largest sector: ${compactInr(top.won_value_inr)} from ${plural(top.pos, 'PO')}, ${percent(topShare)} of won value.` +
      `${concentrated ? ' More than half of won business depends on this one sector.' : ''}`));
  }

  const decided = named.filter((row) => row.pos + row.lost >= 3).sort((a, b) => b.win_rate - a.win_rate || b.pos - a.pos);
  if (decided.length >= 2 && decided[0].win_rate - decided.at(-1).win_rate >= 0.15) {
    const [best, worst] = [decided[0], decided.at(-1)];
    insights.push(insight('OPPORTUNITY', 'action', `${best.sector} converts best, winning ${percent(best.win_rate)} of decided quotations against ${percent(worst.win_rate)} for ${worst.sector}.`));
  }

  if (!unreliable && s.pos_without_sector && unset >= 0.25) {
    insights.push(insight('WATCH', 'watch', `${number(s.pos_without_sector)} of ${plural(s.pos, 'won PO')} (${percent(unset)}) have no sector, so this split is incomplete. Set the sector on those quotations.`));
  }
  return { lead, insights };
}

// ---------------------------------------------------------- 4. services
export function serviceAnalysis(services) {
  const s = services.summary;
  const insights = [];
  if (!s.quotations) return { lead: 'No quotations were raised in this period, so there is no service split.', insights };

  const named = services.rows.filter((row) => !row.other);
  const lead = `${plural(s.quotations, 'quotation')} ${was(s.quotations)} raised across ${plural(named.filter((row) => row.quotations).length, 'service line')}.`;

  const top = [...named].sort((a, b) => b.won_value_inr - a.won_value_inr)[0];
  if (top?.won_value_inr > 0) {
    insights.push(insight('HEADLINE', 'good', `${top.service} is the largest service line: ${compactInr(top.won_value_inr)} won from ${plural(top.won, 'PO')}.`));
  }

  const decided = named.filter((row) => row.won + row.lost >= 3).sort((a, b) => b.win_rate - a.win_rate || b.won - a.won);
  if (decided.length >= 2 && decided[0].win_rate - decided.at(-1).win_rate >= 0.15) {
    const [best, worst] = [decided[0], decided.at(-1)];
    insights.push(insight('OPPORTUNITY', 'action',
      `${best.service} converts best at ${percent(best.win_rate)}, against ${percent(worst.win_rate)} for ${worst.service}. ` +
      'Giving the stronger converter more of the sales effort is the cheapest route to growth.'));
  }

  const noWins = named.filter((row) => row.quotations >= 2 && row.won === 0 && row.lost >= 1);
  if (noWins.length) {
    insights.push(insight('ACTION', 'action',
      `${joinNames(noWins.map((row) => row.service))} ${noWins.length === 1 ? 'has' : 'have'} been quoted more than once without a PO won. ` +
      `Review pricing and scope for ${noWins.length === 1 ? 'it' : 'them'}.`));
  }

  const unmatched = share(s.unmatched, s.quotations);
  if (s.unmatched && unmatched >= 0.2) {
    insights.push(insight('WATCH', 'watch',
      `${number(s.unmatched)} ${s.unmatched === 1 ? 'quotation has' : 'quotations have'} a service that fits no service line, or no service entered, so this split is incomplete.`));
  }
  if (s.bundled) {
    insights.push(insight('NOTE', 'note', s.bundled === 1
      ? '1 quotation names more than one service and counts in each of its lines, so the lines add up to more than the total.'
      : `${number(s.bundled)} quotations name more than one service and count in each of their lines, so the lines add up to more than the total.`));
  }
  return { lead, insights };
}

// ----------------------------------------------------------- 5. clients
export function clientAnalysis(customers) {
  const { total: t, repeat: r, single } = customers.summary;
  const insights = [];
  if (!t.clients) return { lead: 'No clients had an enquiry or a quotation in this period.', insights };

  const lead = `${plural(t.clients, 'client')} had an enquiry or a quotation in the period: ${plural(r.clients, 'repeat client')} ` +
    `and ${plural(single.clients, 'single enquiry client')}.`;

  const valued = customers.rows.filter((row) => row.won_value_inr > 0).sort((a, b) => b.won_value_inr - a.won_value_inr);
  if (valued.length >= 3 && t.won_value_inr > 0) {
    const [a, b] = valued;
    const topShare = (a.won_value_inr + b.won_value_inr) / t.won_value_inr;
    if (topShare >= 0.35) {
      insights.push(insight('CONCENTRATION RISK', 'risk', `${a.client} and ${b.client} account for ${percent(topShare)} of won value. Losing either would leave a large gap, so widening the client base should be a priority.`));
    } else {
      insights.push(insight('HEADLINE', 'good', `Won value is spread out: the two largest clients, ${a.client} and ${b.client}, account for ${percent(topShare)}.`));
    }
  }

  if (t.won_value_inr > 0 && r.clients) {
    const repeatShare = r.won_value_inr / t.won_value_inr;
    insights.push(insight(repeatShare >= 0.5 ? 'HEADLINE' : 'NOTE', repeatShare >= 0.5 ? 'good' : 'note',
      `Repeat clients bring ${percent(repeatShare)} of won value${r.repeat_orders ? `, with ${plural(r.repeat_orders, 'repeat order')} between them` : ''}.`));
  } else if (!r.clients && t.pos >= 3) {
    insights.push(insight('WATCH', 'watch', 'No client has placed a second PO yet, so all won business is first-time business.'));
  }

  const stalled = customers.rows.filter((row) => row.lost >= 2 && row.pos === 0).map((row) => row.client);
  if (stalled.length) {
    const names = stalled.length > 4 ? `${stalled.slice(0, 4).join(', ')} and ${stalled.length - 4} more` : joinNames(stalled);
    insights.push(insight('WATCH', 'watch', `${names} ${stalled.length === 1 ? 'has' : 'have each'} lost 2 or more quotations without a win. A review call could show what is going wrong.`));
  }
  return { lead, insights };
}

// ----------------------------------------------------------- 6. revenue
export function revenueAnalysis(revenue, label) {
  const p = revenue.invoicing.total;
  const o = revenue.orders.total;
  const status = Object.fromEntries(revenue.payment_status.rows.map((row) => [row.status, row]));
  const insights = [];

  const intake = o.orders_won
    ? `Order intake in ${label} was ${compactInr(o.order_intake_inr)} from ${plural(o.orders_won, 'won order')}.`
    : `No orders were won in ${label}.`;
  if (!p.pos) return { lead: `${intake} No purchase orders are dated in ${label}.`, insights, priority: null };

  const lead = `${intake} ${plural(p.pos, 'purchase order')} worth ${compactInr(p.po_value_inr)} ${is(p.pos)} dated in ${label}: ` +
    (p.invoiced_inr > 0
      ? `${percent(p.invoiced_rate)} of that value has been invoiced and ${percent(p.collection_rate)} of the invoiced amount collected.`
      : 'nothing has been invoiced yet.');

  const overdue = status.Overdue?.pos ?? 0;
  const toInvoice = status['To Invoice']?.pos ?? 0;
  let priority = null;
  if (p.po_value_inr > 0 && p.invoiced_rate !== null && p.invoiced_rate < 0.5) {
    priority = 'billing';
    insights.push(insight('THE PRIORITY', 'risk',
      `Billing is the bigger gap, not collections: only ${percent(p.invoiced_rate)} of PO value has been invoiced` +
      `${toInvoice ? `, and ${plural(toInvoice, 'PO')} ${has(toInvoice)} a stage due to be billed now` : ''}. Raising those invoices is the fastest way to bring in cash.`));
  } else if (p.invoiced_inr > 0 && p.collection_rate < 0.7) {
    priority = 'collections';
    insights.push(insight('THE PRIORITY', 'risk',
      `Collections are the bigger gap: ${percent(p.collection_rate)} of the invoiced amount has been received, with ${compactInr(p.due_now_inr)} due now` +
      `${overdue ? ` and ${plural(overdue, 'PO')} overdue. Chase the overdue invoices first.` : '. Follow up the unpaid invoices before they fall overdue.'}`));
  } else if (p.invoiced_inr > 0) {
    insights.push(insight('HEADLINE', 'good', `Billing and collections are on track: ${percent(p.invoiced_rate)} of PO value invoiced and ${percent(p.collection_rate)} of invoices collected.`));
  }
  if (overdue && priority !== 'collections') {
    insights.push(insight('WATCH', 'watch', `${plural(overdue, 'PO')} ${has(overdue)} an overdue invoice, with ${compactInr(status.Overdue.due_now_inr)} due.`));
  }
  if (p.pos < 3) {
    insights.push(insight('NOTE', 'note', `These rates rest on ${plural(p.pos, 'purchase order')}, so they will move quickly as more work is billed and paid.`));
  }

  const months = revenue.orders.months.filter((m) => m.month && m.order_intake_inr > 0);
  if (months.length >= 2) {
    const best = months.reduce((a, b) => (b.order_intake_inr > a.order_intake_inr ? b : a));
    insights.push(insight('NOTE', 'note', `The strongest month for order intake was ${best.label}, at ${compactInr(best.order_intake_inr)} from ${plural(best.orders_won, 'order')}.`));
  }
  return { lead, insights, priority };
}

// ---------------------------------------------------------- the headline
export function headline({ enquiries, sectors, customers, revenue, revenueLabel, priority }) {
  const parts = [];
  const e = enquiries.total;
  if (e.enquiries) parts.push(`${number(e.quoted)} of ${plural(e.enquiries, 'enquiry', 'enquiries')} reached a quotation`);
  const s = sectors.summary;
  const won = customers.summary.total.won_value_inr;
  if (s.win_rate !== null) {
    parts.push(`${percent(s.win_rate)} of decided quotations were won (${plural(s.pos, 'PO')}${won ? `, ${compactInr(won)}` : ''})`);
  }
  const p = revenue.invoicing.total;
  if (p.pos) {
    parts.push(`${percent(p.invoiced_rate)} of ${revenueLabel} PO value has been invoiced${p.invoiced_inr ? ` and ${percent(p.collection_rate)} of invoices collected` : ''}`);
  }
  if (!parts.length) return { tag: 'THE HEADLINE', tone: 'note', text: 'No sales activity is recorded for this period yet.' };

  let text = parts.join('; ');
  text = `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  if (priority === 'billing') text += ' The main gap is billing: won work is not being invoiced fast enough.';
  if (priority === 'collections') text += ' The main gap is collections: invoices are not being paid fast enough.';
  return { tag: 'THE HEADLINE', tone: priority ? 'watch' : 'good', text };
}

// ------------------------------------------------------- 7. what to fix
export function managementFixes({ gaps, sectors, services, revenue, missingRates }) {
  const fixes = [];
  const add = (title, detail) => fixes.push({ title, detail });
  const ofQuotations = (n) => `${number(n)} of ${plural(gaps.quotations, 'quotation')} in the period ${has(n)}`;

  if (gaps.quotations_without_value) {
    add('Enter a value on every quotation',
      `${ofQuotations(gaps.quotations_without_value)} no value${gaps.won_without_value ? ` (${number(gaps.won_without_value)} of them won)` : ''}, so pipeline and won value are understated.`);
  }
  if (gaps.won_without_po) {
    add('Register the purchase order for every won quotation',
      `${number(gaps.won_without_po)} won ${gaps.won_without_po === 1 ? 'quotation has' : 'quotations have'} no purchase order registered, ` +
      `so ${gaps.won_without_po === 1 ? 'it is' : 'they are'} missing from invoicing, collections and payment status.`);
  }
  if (gaps.quotations_without_sector) {
    add('Set the sector on every quotation',
      `${ofQuotations(gaps.quotations_without_sector)} no sector${sectors.summary.pos_without_sector ? `, ${number(sectors.summary.pos_without_sector)} of them won` : ''}, so the sector analysis is incomplete.`);
  }
  if (gaps.enquiries_without_sector) {
    add('Set the sector on every enquiry', `${number(gaps.enquiries_without_sector)} of ${plural(gaps.enquiries, 'enquiry', 'enquiries')} in the period ${has(gaps.enquiries_without_sector)} no sector.`);
  }
  if (gaps.quoted_enquiries_unlinked) {
    add('Link each quoted enquiry to its quotation',
      `${plural(gaps.quoted_enquiries_unlinked, 'enquiry', 'enquiries')} marked "Won - Quotation Sent" ${has(gaps.quoted_enquiries_unlinked)} no quotation linked, so ${gaps.quoted_enquiries_unlinked === 1 ? 'its' : 'their'} outcome is unknown.`);
  }
  if (services.summary.unmatched) {
    add('Use consistent service names',
      `${plural(services.summary.unmatched, 'quotation')} ${has(services.summary.unmatched)} a service that fits none of the service lines in section 4, or no service at all. ` +
      'Choosing the service from the suggestions rather than typing a new name keeps the split accurate.');
  }
  if (gaps.quotations_without_sales_person) {
    add('Fill in the sales person', `${ofQuotations(gaps.quotations_without_sales_person)} no sales person, so performance by sales person cannot be reported.`);
  }
  const undatedPos = revenue.undated_pos ?? [];
  if (undatedPos.length) {
    add('Add the PO date to every purchase order',
      `${plural(undatedPos.length, 'purchase order')} ${has(undatedPos.length)} no PO date, so ${undatedPos.length === 1 ? 'it is' : 'they are'} left out of the revenue figures: ${undatedPos.join(', ')}.`);
  }
  if (missingRates.length) {
    add('Set the exchange rates', `No rate covers the dates of the ${missingRates.join(', ')} amounts in this report, so they are left out of every INR figure and shown separately. Add each one under Settings -> Exchange rates, dated from when it applied.`);
  }
  if (gaps.undated_quotations || gaps.undated_enquiries) {
    const parts = [
      gaps.undated_quotations ? plural(gaps.undated_quotations, 'quotation') : null,
      gaps.undated_enquiries ? plural(gaps.undated_enquiries, 'enquiry', 'enquiries') : null,
    ].filter(Boolean);
    add('Add the missing dates', `${joinNames(parts)} ${has(gaps.undated_quotations + gaps.undated_enquiries)} no date, so they cannot be placed in any period and are left out of this report.`);
  }
  return fixes;
}
