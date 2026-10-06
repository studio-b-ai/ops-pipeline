#!/usr/bin/env python3
"""
Assemble the Asthetik monthly variance brief from pulled data.

Inputs (from pull_variance_data.py --workdir DIR):
  DIR/bi-arinvoices-MMYYYY.json  — BI-ARInvoices line-grain rows
  DIR/stockitem-snapshot.json     — StockItem cost data
  DIR/wms-inventory.json          — wms_inventory qty (optional)

Classifies BI-ARInvoices rows under the seat-proven ruleset v1.1
(classify_legs_v1_1.py), computes margin % by channel, COGS, inventory
valuation (if qty available), and renders the brief in the design doc's
output format.

Usage: assemble_variance_brief.py --workdir DIR --period MMYYYY --ym YYYYMM [--out brief.md]
"""
import argparse, collections, json, os, sys, math

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import classify_legs_v1_1 as r

LABEL = {
    "leg1": "Core trade (Heritage)",
    "leg2": "Maker cohort (new-motion)",
    "leg3": "Own DTC",
    "leg4": "Marketplace (Faire/Wayfair)",
    "leg5": "Hospitality spec",
    "leg6": "Make-side / contract mfg",
    "H2_unclassified": "H2 — unclassified class",
    "H0_internal": "H0 — internal/house",
    "H9_UNMAPPED": "H9 — UNMAPPED (fail-closed)",
}

CHANNEL_DISPLAY = ["leg1", "leg4", "leg6", "leg2", "leg5"]

MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def classify_rows(inv_rows):
    """Classify BI-ARInvoices rows into leg buckets.

    Each row maps to a synthetic doc for classify_doc():
      cust=CustomeID, cls=CustomerClassID, branch=BranchID, net=ExtProfit.
    Also tracks ExtAmount per row for margin % computation.
    """
    buckets = collections.defaultdict(lambda: {"profit": 0.0, "amount": 0.0, "rows": 0, "custs": set()})

    for row in inv_rows:
        cust = (row.get("CustomerID") or "").strip()
        cls = (row.get("CustomerClassID") or "").strip()
        branch = (row.get("BranchID") or "").strip()
        if not cust:
            continue

        doc = {"cust": cust, "cls": cls, "branch": branch, "net": 1.0,
               "ref": (row.get("InvoiceNbr") or "").strip(),
               "name": "", "ttype": "Invoice"}
        bucket, rule_id, _, _ = r.classify_doc(doc)

        profit = float(row.get("ExtProfit") or 0)
        amount = float(row.get("ExtAmount") or 0)

        buckets[bucket]["profit"] += profit
        buckets[bucket]["amount"] += amount
        buckets[bucket]["rows"] += 1
        buckets[bucket]["custs"].add(cust)

    return buckets


def compute_margin_section(buckets):
    """Render the margin-by-channel section of the brief."""
    lines = []
    lines.append("Margin by channel (Sep, ExtProfit/ExtAmount):")
    for bucket in CHANNEL_DISPLAY:
        if bucket not in buckets:
            continue
        b = buckets[bucket]
        if b["amount"] == 0:
            continue
        margin_pct = (b["profit"] / b["amount"]) * 100 if b["amount"] else 0
        label = LABEL.get(bucket, bucket)
        lines.append(f"  {label}: {margin_pct:+.1f}%  "
                     f"(profit ${b['profit']:,.0f} / rev ${b['amount']:,.0f}  "
                     f"· {b['rows']} rows · {len(b['custs'])} accounts)")
    h2 = buckets.get("H2_unclassified", {})
    if h2.get("amount"):
        pct = (h2["profit"] / h2["amount"]) * 100 if h2["amount"] else 0
        lines.append(f"  (H2 unclassified: {pct:+.1f}%  "
                     f"profit ${h2['profit']:,.0f} / rev ${h2['amount']:,.0f}  "
                     f"· {h2['rows']} rows · {len(h2['custs'])} accounts)")
    h9 = buckets.get("H9_UNMAPPED", {})
    if h9.get("amount"):
        lines.append(f"  (H9 UNMAPPED — fail-closed: ${h9['amount']:,.0f} rev  "
                     f"· {h9['rows']} rows — needs Controller attention)")
    return "\n".join(lines)


def compute_cogs(buckets):
    """Compute COGS from ExtProfit/ExtAmount: COGS = ExtAmount - ExtProfit."""
    cogs = 0.0
    for b in buckets.values():
        cogs += b["amount"] - b["profit"]
    return cogs


def compute_inventory_section(workdir, cogs):
    """Compute inventory valuation and turns.

    Valuation = SUM(LastCost * qty_on_hand) from StockItem cost + wms_inventory qty.
    If qty is unavailable, report COGS-only.
    """
    wms_path = os.path.join(workdir, "wms-inventory.json")
    stock_path = os.path.join(workdir, "stockitem-snapshot.json")

    qty_by_id = {}
    if os.path.exists(wms_path):
        try:
            wms_rows = json.load(open(wms_path))
            for r in wms_rows:
                qty_by_id[(r.get("inventory_id") or "").strip()] = float(r.get("qty_on_hand") or 0)
        except (ValueError, json.JSONDecodeError):
            pass

    cost_by_id = {}
    if os.path.exists(stock_path):
        try:
            stock_rows = json.load(open(stock_path))
            for r in stock_rows:
                inv_id = (r.get("InventoryID") or "").strip()
                cost = float(r.get("LastCost") or 0)
                if inv_id and cost > 0:
                    cost_by_id[inv_id] = cost
        except (ValueError, json.JSONDecodeError):
            pass

    valued = 0.0
    valued_items = 0
    for inv_id, qty in qty_by_id.items():
        cost = cost_by_id.get(inv_id, 0)
        if qty > 0 and cost > 0:
            valued += qty * cost
            valued_items += 1

    if valued_items == 0:
        turns_str = f"COGS ${cogs:,.0f} / avg inv: pending wms_inventory qty access"
        detail = ("Inventory valuation blocked: no items with both qty and cost. "
                  f"{len(qty_by_id)} qty entries, {len(cost_by_id)} cost entries matched.")
    else:
        turns = cogs / valued if valued > 0 else 0
        turns_str = (f"{turns:.1f}× annualized (COGS ${cogs:,.0f} / avg inv ${valued:,.0f})  "
                     f"· {valued_items} items valued")
        detail = (f"Valuation: SUM(LastCost * qty_on_hand) = ${valued:,.0f} "
                  f"from {valued_items} inventory items with both cost and qty data.")
        turns_str = f"Inventory turns: {turns_str}"

    lines = [f"Inventory: {turns_str}"]
    if valued_items == 0:
        lines.append(f"  ({detail})")
    return "\n".join(lines)


def render_brief(period, buckets, cogs, inv_section):
    """Render the full variance brief in the design doc's output format."""
    ym = f"{period[2:6]}-{period[0:2]}"
    total_profit = sum(b["profit"] for b in buckets.values())
    total_amount = sum(b["amount"] for b in buckets.values())

    lines = [
        f"Aesthetik Financial — {ym} variance brief",
        "",
        "Cash: deferred — blocked on data source (next admin session: GL inquiry)",
        "AP: deferred — blocked on data source (next admin session: GL inquiry)",
        "",
        compute_margin_section(buckets),
        "",
        inv_section,
        "",
        f"Direction: {total_amount:,.0f} revenue, {total_profit:,.0f} profit "
        f"({(total_profit/total_amount*100 if total_amount else 0):+.1f}% margin) "
        f"— prior-month and prior-year comparisons pending second beat.",
        "",
        "Ask: No ask this month.",
        "",
        "---",
        f"*Generated {ym} · Controller authority (tower charter §2) · "
        "github.com/studio-b-ai/ops-pipeline*",
    ]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="Assemble Asthetik monthly variance brief")
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--period", required=True, help="MMYYYY")
    ap.add_argument("--ym", required=True, help="YYYYMM")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    inv_path = os.path.join(a.workdir, f"bi-arinvoices-{a.period}.json")
    if not os.path.exists(inv_path):
        raise SystemExit(f"MISSING input: {inv_path} — run pull_variance_data.py first")

    inv_rows = json.load(open(inv_path))
    print(f"[assemble] loaded {len(inv_rows)} BI-ARInvoices rows", flush=True)

    buckets = classify_rows(inv_rows)
    for k in sorted(buckets.keys()):
        b = buckets[k]
        print(f"[assemble] {k}: profit={b['profit']:,.2f} amount={b['amount']:,.2f} "
              f"rows={b['rows']} custs={len(b['custs'])}", flush=True)

    cogs = compute_cogs(buckets)
    print(f"[assemble] COGS: ${cogs:,.2f}", flush=True)

    inv_section = compute_inventory_section(a.workdir, cogs)
    brief = render_brief(a.period, buckets, cogs, inv_section)

    out_path = a.out or os.path.join(a.workdir, "variance-brief.md")
    with open(out_path, "w") as f:
        f.write(brief)
    print(f"[assemble] brief written to {out_path}", flush=True)


if __name__ == "__main__":
    main()