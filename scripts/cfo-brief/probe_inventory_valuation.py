#!/usr/bin/env python3
"""
Inventory valuation probe — BUILD step 2 of the monthly variance brief design.

Verifies that the StockItem cost + quantity snapshot can yield a usable
average-inventory value for the inventory-turns content element (design §1C).

Two candidate sources, probed in sequence:
  (a) snapshot — a StockItem sync dump carrying LastCost + QuantityOnHand per
      inventory item (bolt-wms `skus.last_cost` × on-hand quantity, or the
      StockItem REST entity via the gateway). Preferred: it is the design's
      v1 recommendation (value = SUM(LastCost * QuantityOnHand)).
  (b) gl      — BI-GLBudgetActual inventory (Asset) account balances, the GL
      fallback. Same positive-control discipline as the GL balance probe
      (step 1): an asserted-active Asset account must be found for the GL
      read to count.

Input conventions (a `--workdir DIR` everything), mirroring step 1:
  snapshot → DIR/inventory-snapshot-<start|end>.json  (unwrapped rows)
  gl       → DIR/gl-all-periods.json                  (pull_month.py output)

The verdict ladder (#322): a valuation probe is trusted only when it can
REJECT a known-bad (zero on-hand should yield zero value, a known-cost item
should contribute a non-zero value) AND SEE a known-good (at least one item
with positive on-hand and positive cost present). A probe that cannot see
either is BLIND, not "zero inventory".

Usage: probe_inventory_valuation.py --workdir DIR [--period MMYYYY]
Output: JSON on stdout; human summary on stderr; exit 0=PASS, 2=other.
"""
import argparse, json, os, sys
from collections import defaultdict

# Key candidates for the StockItem snapshot rows. bolt-wms syncs the modern
# InventoryItem schema; the legacy StockItem entity uses LastCost/QuantityOnHand.
ITEM_KEY_CANDIDATES = ["InventoryID", "InventoryCD", "StockItemCD", "ItemCode"]
COST_KEY_CANDIDATES = ["LastCost", "AverageCost", "DefaultPrice", "UnitCost"]
QTY_KEY_CANDIDATES = ["QuantityOnHand", "QtyOnHand", "AvailableQty", "QtyAvailable"]

# GL inventory (Asset) accounts — the fallback. Values are probe-time guesses
# from the standard inventory chart; the probe reports WHICH it finds, never
# asserts their meaning. A positive control is required regardless.
GL_INVENTORY_ACCOUNT_CANDIDATES = [
    "1200-000",  # Inventory — finished goods (typical)
    "1210-000",  # Inventory — raw material / work in process (typical)
    "1220-000",  # Inventory — WIP (typical)
]
# Positive control — an Asset account asserted active outside inventory, to
# prove the GL instrument can see Asset balances at all (mirrors step 1's
# Income-account positive control, but on the Asset side).
GL_POSITIVE_CONTROL_ACCOUNTS = [
    "1025-000",  # Cash — Pinnacle (asserted active, step 1 target)
    "1030-000",  # Cash — Byline (asserted active, step 1 target)
]


def _first(row, candidates):
    for k in candidates:
        v = row.get(k)
        if v not in (None, ""):
            return v
    return None


def _find_keys(rows, candidates):
    if not rows:
        return None
    for k in candidates:
        if k in rows[0]:
            return k
    return None


def probe_snapshot(rows):
    """Value inventory from a StockItem snapshot (SUM LastCost * QuantityOnHand).

    Returns the valuation structure, or None if the file lacks usable keys.
    """
    item_key = _find_keys(rows, ITEM_KEY_CANDIDATES)
    cost_key = _find_keys(rows, COST_KEY_CANDIDATES)
    qty_key = _find_keys(rows, QTY_KEY_CANDIDATES)
    if not item_key or not cost_key or not qty_key:
        return {
            "available": False,
            "reason": "missing key — item: %s · cost: %s · qty: %s (tried all candidates)"
            % (item_key, cost_key, qty_key),
        }

    total_value = 0.0
    positive_items = 0
    zero_qty_items = 0
    zero_cost_positive_qty = 0
    for row in rows:
        try:
            qty = float(row.get(qty_key) or 0)
            cost = float(row.get(cost_key) or 0)
        except (TypeError, ValueError):
            continue
        if qty == 0:
            zero_qty_items += 1
            continue
        if cost == 0:
            zero_cost_positive_qty += 1
        else:
            total_value += qty * cost
            positive_items += 1

    # #322 negative + positive controls in one probe
    if positive_items == 0:
        verdict = "BLIND"
        detail = (
            "No item has a positive on-hand quantity with a positive cost — "
            "the snapshot cannot distinguish 'empty warehouse' from 'cost layer "
            "missing'. Zero valuation from this probe is not evidence of zero "
            "inventory."
        )
    else:
        verdict = "PASS"
        detail = (
            "%d items valued at $%.2f; %d skipped (zero qty), %d positive-qty-but-zero-cost."
            % (positive_items, total_value, zero_qty_items, zero_cost_positive_qty)
        )
    return {
        "available": True,
        "item_key": item_key,
        "cost_key": cost_key,
        "qty_key": qty_key,
        "total_value": round(total_value, 2),
        "positive_items": positive_items,
        "zero_qty_items": zero_qty_items,
        "zero_cost_positive_qty": zero_cost_positive_qty,
        "verdict": verdict,
        "verdict_detail": detail,
    }


def probe_gl(rows, period=None):
    """Fallback — inventory Asset balances from BI-GLBudgetActual.

    Returns structure with targets + positive controls + verdict.
    """
    from collections import defaultdict
    acct_key = _find_keys(rows, ["AccountCD", "Account", "AccountID"])
    if not acct_key:
        return {"available": False, "reason": "no account-code field in GL rows"}

    idx = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    all_periods = set()
    for row in rows:
        acct = (row.get(acct_key) or "").strip()
        p = (row.get("FinancialPeriodID") or "").strip()
        branch = (row.get("Branch") or "").strip().upper()
        credit = float(row.get("FinPTDCredit") or 0)
        debit = float(row.get("FinPTDDebit") or 0)
        idx[acct][p][branch] += credit - debit
        all_periods.add(p)
    if period:
        all_periods = {period} & all_periods

    controls = {}
    for code in GL_POSITIVE_CONTROL_ACCOUNTS:
        controls[code] = {"found": code in idx}

    targets = {}
    for code in GL_INVENTORY_ACCOUNT_CANDIDATES:
        found = code in idx
        periods = {}
        if found:
            for p in sorted(all_periods):
                if p in idx[code]:
                    periods[p] = dict(idx[code][p])
        targets[code] = {
            "found": found,
            "periods": periods,
        }

    controls_found = sum(1 for c in controls.values() if c["found"])
    targets_found = sum(1 for t in targets.values() if t["found"])

    if controls_found == 0:
        verdict, detail = "BLIND", "No Asset positive control found — GL cannot be trusted for inventory balances."
    elif targets_found == 0:
        verdict, detail = "MIXED", "Asset controls present but no inventory candidate account found — chart differs from the guessed list; inspect the real chart."
    else:
        verdict, detail = "PASS", "%d/%d inventory candidates present with %d/%d controls." % (
            targets_found, len(GL_INVENTORY_ACCOUNT_CANDIDATES), controls_found, len(GL_POSITIVE_CONTROL_ACCOUNTS))

    return {
        "available": True,
        "account_key": acct_key,
        "positive_controls": controls,
        "targets": targets,
        "verdict": verdict,
        "verdict_detail": detail,
    }


def main():
    ap = argparse.ArgumentParser(description="Inventory valuation probe for monthly variance brief")
    ap.add_argument("--workdir", required=True, help="Directory containing snapshot/GL json files")
    ap.add_argument("--period", default=None, help="Single MMYYYY period (GL fallback only)")
    a = ap.parse_args()

    result = {"workdir": a.workdir, "snapshot": None, "gl": None}

    snap_path = os.path.join(a.workdir, "inventory-snapshot-end.json")
    if not os.path.exists(snap_path):
        snap_path = os.path.join(a.workdir, "inventory-snapshot.json")
    if os.path.exists(snap_path):
        try:
            result["snapshot"] = probe_snapshot(json.load(open(snap_path)))
        except (ValueError, json.JSONDecodeError) as e:
            result["snapshot"] = {"available": False, "reason": "unparseable: %s" % e}

    gl_path = os.path.join(a.workdir, "gl-all-periods.json")
    if os.path.exists(gl_path):
        try:
            result["gl"] = probe_gl(json.load(open(gl_path)), a.period)
        except (ValueError, json.JSONDecodeError) as e:
            result["gl"] = {"available": False, "reason": "unparseable: %s" % e}

    snap = result["snapshot"]
    gl = result["gl"]
    if snap and snap.get("verdict") == "PASS":
        verdict = "PASS"
        verdict_detail = "Snapshot valuation usable — SUM(LastCost*QtyOnHand) = $%.2f." % snap["total_value"]
    elif gl and gl.get("verdict") == "PASS":
        verdict = "PASS"
        verdict_detail = "GL Asset balances usable as inventory fallback; snapshot not usable (%s)." % (
            snap.get("reason") if snap else "absent")
    elif snap and snap.get("available"):
        verdict = snap["verdict"]
        verdict_detail = snap["verdict_detail"]
    elif gl and gl.get("available"):
        verdict = gl["verdict"]
        verdict_detail = gl["verdict_detail"]
    else:
        verdict = "BLIND"
        verdict_detail = "Neither snapshot nor GL data present/usable — run the sync and pull_month.py first."

    result["verdict"] = verdict
    result["verdict_detail"] = verdict_detail

    print(json.dumps(result, indent=2))
    print("\n[probe] %s: %s" % (verdict, verdict_detail), file=sys.stderr)
    sys.exit(0 if verdict == "PASS" else 2)


if __name__ == "__main__":
    main()