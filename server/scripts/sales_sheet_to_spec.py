#!/usr/bin/env python3
"""
Turn the sales department's "Sales" sheet into an import spec the tracker
can apply.  Reads rows from a given S.No onward, keeps only Closed Won
deals whose proposal name does not mention ISO and that carry a PO number,
and writes one JSON entry per deal describing the quotation, the purchase
order, its payment split, and any invoices and receipts the sheet shows.

Dates the sheet leaves blank are assumed, per the sales lead: a missing
PO date is the proposal date plus 7 days, a missing invoice date is the
PO date plus 1 day.  Every assumed date is noted in the record's remarks.

    python scripts/sales_sheet_to_spec.py "Sales department dashboard.xlsx" \
        --from 16 --out import/sales-sheet-2026-09.json

Quotation numbers are not decided here: the import script assigns them on
the target, starting from --start-no, to the deals it actually creates.

The spec is meant to be read before it is applied.  Anything the sheet
left ambiguous is listed under "review" with a reason, and is applied as
quotation-only unless the entry is edited.
"""
import argparse
import datetime
import json
import re
import sys

import openpyxl

ISO = re.compile(r"\bISO\b", re.I)


def amount(v):
    """'7,96,500/-' -> 796500.0, '$8640' -> (8640.0, 'USD'), 33000 -> 33000.0"""
    if v is None or v == "":
        return None, None
    if isinstance(v, (int, float)):
        return float(v), None
    s = str(v).strip()
    cur = "USD" if "$" in s else None
    s = s.replace("/-", "").replace("$", "").replace(",", "").strip()
    try:
        return float(s), cur
    except ValueError:
        return None, cur


def day(v):
    if v is None or v == "" or v == "N/A":
        return None
    if isinstance(v, datetime.datetime):
        return v.strftime("%Y-%m-%d")
    s = str(v).strip()
    m = re.match(r"^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$", s)
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    return None


def plus_days(iso, n):
    d = datetime.date.fromisoformat(iso) + datetime.timedelta(days=n)
    return d.isoformat()


def percent_from_remarks(text):
    """'Invoice shared for 20% adv' -> 0.2 ; falls back to None."""
    if not text:
        return None
    m = re.search(r"(\d{1,3})\s*%", str(text))
    if m:
        p = int(m.group(1))
        if 0 < p < 100:
            return p / 100
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workbook")
    ap.add_argument("--sheet", default="Sales")
    ap.add_argument("--from", dest="from_sno", type=int, default=16)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    wb = openpyxl.load_workbook(args.workbook, data_only=True)
    ws = wb[args.sheet]
    header = next(ws.iter_rows(min_row=2, max_row=2, values_only=True))
    col = {h: i for i, h in enumerate(header) if h}

    deals, review, excluded = [], [], []
    last_sent = None  # nearest earlier proposal date, for rows with none

    for row in ws.iter_rows(min_row=3, values_only=True):
        try:
            sno = int(float(row[col["S.No"]]))
        except (TypeError, ValueError):
            continue
        if sno < args.from_sno:
            continue
        if not str(row[col["Deal Stage"]] or "").startswith("Closed Won"):
            continue

        proposal = str(row[col["Proposal Name"]] or "").strip()
        client = str(row[col["Client Name"]] or "").strip()
        if ISO.search(proposal):
            excluded.append({"sno": sno, "client": client, "proposal": proposal, "reason": "ISO proposal"})
            continue

        po_number = row[col["PO Number"]]
        po_number = str(po_number).strip() if po_number not in (None, "") else None
        sent = day(row[col["Proposal Sent Date"]])
        if sent:
            last_sent = sent
        if not po_number:
            excluded.append({"sno": sno, "client": client, "proposal": proposal, "reason": "no PO number"})
            continue

        po_value, po_cur = amount(row[col["PO Amount"]])
        quoted, q_cur = amount(row[col["Quoted Price"]])
        received, r_cur = amount(row[col["Ammount received"]])
        pending, _ = amount(row[col["Pending"]])
        currency = po_cur or q_cur or r_cur or "INR"
        po_date = day(row[col["PO Received On"]])
        invoice_no = row[col["Invoice Number"]]
        invoice_no = str(invoice_no).strip() if invoice_no not in (None, "") else None
        remarks = row[col["Remarks"]]
        remarks = str(remarks).strip() if remarks not in (None, "") else ""

        deal = {
            "sno": sno,
            "quotation": {
                "client_name": client,
                "contact_person": row[col["Lead Name"]],
                "service_quoted": proposal,
                "quotation_date": sent,
                "quotation_value": po_value if po_value is not None else quoted,
                "currency": currency,
                "status": "Won - PO Received",
                "po_received": True,
                "remarks": (remarks + " | " if remarks else "") + f"Imported from Sales department dashboard S.No {sno}",
            },
            "industry": row[col["Industry Type"]],
            "lead_type": row[col["Lead Type"]],
        }

        notes = []
        if po_value is None:
            notes.append("PO number present but no PO amount; applied as quotation only")
        else:
            po_remarks = [f"Imported from Sales department dashboard S.No {sno}"]
            if not po_date:
                base = sent or last_sent
                if base:
                    po_date = plus_days(base, 7)
                    po_remarks.append(f"PO date assumed as proposal date + 7 days ({po_date})")
                    notes.append(f"PO date assumed {po_date} (proposal {'sent' if sent else 'of previous row'} + 7 days)")
                else:
                    notes.append("PO date unknown and nothing to derive it from; left blank")
            deal["purchase_order"] = {
                "po_number": po_number,
                "po_date": po_date,
                "po_value": po_value,
                "currency": currency,
                "payment_terms_days": 30,
                "remarks": " | ".join(po_remarks),
            }

            # Payment split.  If the sheet shows an invoice, the first stage is
            # the invoiced one; its size comes from the remarks ("20% adv") or
            # from the invoiced/received amounts, defaulting to 50%.
            first = percent_from_remarks(remarks)
            if first is None and invoice_no and received is not None and pending is not None and po_value:
                inv_total = received + pending
                ratio = inv_total / po_value
                if 0.05 <= ratio <= 0.95:
                    first = round(ratio, 4)
            if first is None:
                first = 0.5
            stages = [
                {"stage_name": f"Advance ({round(first * 100)}%)", "trigger_event": "On PO Registration" if po_date else "Manual", "stage_percent": first},
                {"stage_name": f"On delivery ({round((1 - first) * 100)}%)", "trigger_event": "On Delivery", "stage_percent": round(1 - first, 4)},
            ]
            if invoice_no:
                inv_date = plus_days(po_date, 1) if po_date else None
                stages[0]["invoice"] = {"invoice_no": invoice_no, "invoice_date": inv_date}
                if inv_date:
                    notes.append(f"invoice date assumed {inv_date} (PO date + 1 day)")
                    deal["quotation"]["remarks"] += f" | Invoice date assumed as PO date + 1 day ({inv_date})"
                else:
                    notes.append("invoice date unknown; invoice not recorded")
                if received:
                    stages[0]["receipt"] = {"amount_received": received, "payment_received_date": None}
            deal["stages"] = stages

        if notes:
            deal["notes"] = notes
            review.append({"sno": sno, "client": client, "proposal": proposal, "notes": notes})
        deals.append(deal)

    spec = {
        "source": args.workbook,
        "generated": datetime.date.today().isoformat(),
        "rule": f"S.No >= {args.from_sno}, Closed Won, proposal name without 'ISO', PO number present",
        "deals": deals,
        "review": review,
        "excluded": excluded,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(spec, f, indent=2, ensure_ascii=False, default=str)

    with_po = sum(1 for d in deals if "purchase_order" in d)
    dropped = sum(1 for e in excluded if e["reason"] == "no PO number")
    iso = len(excluded) - dropped
    print(f"{len(deals)} deals written to {args.out} ({with_po} with a PO); {iso} ISO deals excluded; {dropped} dropped for no PO number; {len(review)} carry assumptions", file=sys.stderr)


if __name__ == "__main__":
    main()
