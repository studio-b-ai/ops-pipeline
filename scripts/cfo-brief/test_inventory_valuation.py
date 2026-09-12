#!/usr/bin/env python3
"""
Inventory valuation probe regression — BUILD step 2.

Three scenarios from one shared fixture (fixtures/inventory-snapshot-fixture.json,
5 items with known quantities and costs) + the existing gl-all-periods fixture:

  (A) Snapshot PASS — values the 3 items with positive-cost and positive-qty.
      Assert EXACT total (240*12.50 + 1000*8.75 + 50*5.00 = 12,000.00).
      Assert zero-cost item (INV-003) and zero-qty item (INV-004) are skipped
      but not dropped silently (counters confirmed).

  (B) Snapshot BLIND — empty file contains zero valued rows. Assert verdict
      is BLIND, not PASS with zero (a blind instrument cannot distinguish
      "empty warehouse" from "cost layer missing").

  (C) Snapshot ABSENT — no file at all, workdir empty. Assert no crash,
      verdict BLIND.

Stdlib only; plain __main__ (no pytest dependency), mirroring test_july_regression.py
+ test_csl_regression.py. Exit 0 = pass.
"""
import io, json, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import probe_inventory_valuation as piv

FIXTURE = os.path.join(HERE, "fixtures", "inventory-snapshot-fixture.json")


def test_a_snapshot_pass():
    items = json.load(open(FIXTURE))
    result = piv.probe_snapshot(items)
    assert result["available"], "fixture rows should be processable"
    assert result["verdict"] == "PASS", "known-good fixture should PASS — verdict was %s" % result["verdict"]
    # 240*12.50=3000 + 1000*8.75=8750 + 50*5.00=250 = 12000.00
    assert abs(result["total_value"] - 12000.00) < 0.01, "expected $12,000.00, got $%.2f" % result["total_value"]
    assert result["positive_items"] == 3, "expected 3 valued items, got %d" % result["positive_items"]
    assert result["zero_qty_items"] == 1, "INV-004 has zero qty — expected 1 zero_qty skip"
    assert result["zero_cost_positive_qty"] == 1, "INV-003 has positive qty, zero cost — expected 1 zero_cost skip"


def test_b_snapshot_blind():
    items = [{"InventoryID": "INV-006", "LastCost": 0, "QuantityOnHand": 100},
             {"InventoryID": "INV-007", "LastCost": 25.00, "QuantityOnHand": 0}]
    result = piv.probe_snapshot(items)
    assert result["available"], "fixture rows should be processable"
    assert result["verdict"] == "BLIND", "all-zero or no-positive-cost-and-qty items should be BLIND — verdict was %s" % result["verdict"]
    assert result["positive_items"] == 0, "expected zero valued items"


def test_c_snapshot_absent():
    with tempfile.TemporaryDirectory() as td:
        import subprocess
        cp = subprocess.run(
            ["python3", os.path.join(HERE, "probe_inventory_valuation.py"), "--workdir", td],
            capture_output=True, text=True,
        )
        out = json.loads(cp.stdout)
        assert out["verdict"] == "BLIND", "empty workdir should be BLIND — verdict was %s" % out["verdict"]


def main():
    failures = []
    for name, fn in [("(A) snapshot PASS", test_a_snapshot_pass),
                     ("(B) snapshot BLIND", test_b_snapshot_blind),
                     ("(C) snapshot absent", test_c_snapshot_absent)]:
        try:
            fn()
            print("  PASS %s" % name)
        except Exception as e:
            print("  FAIL %s: %s" % (name, e))
            failures.append(name)
    if failures:
        print("\nFAIL %d/%d" % (len(failures), 3))
        sys.exit(1)
    print("\nPASS 3/3")
    sys.exit(0)


if __name__ == "__main__":
    main()