#!/usr/bin/env python3
"""
July 2026 regression gate — the classifier port is faithful BY CONSTRUCTION.

Runs classify_legs_v1_1 on the committed July fixture and asserts the EXACT
bucket totals adopted into revenue model v2 (2026-08-13). Any code change that
moves a penny of July fails CI. NEVER adjust the fixture or these constants to
make the test pass — a mismatch means the change broke classification; stop
and investigate.

Stdlib only; plain __main__ (no pytest dependency). Exit 0 = pass.
"""
import collections, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import classify_legs_v1_1 as r

FIXTURE = os.path.join(HERE, "fixtures", "ar-invoices-202607.jsonl")

EXPECTED_BUCKETS = {
    "leg1": 917847.17,
    "leg2": 0.00,
    "leg3": 0.00,
    "leg4": 2297.16,
    "leg5": 0.00,
    "leg6": 174936.66,
    "H2_unclassified": 1915.34,
    "H0_internal": 0.00,
    "H9_UNMAPPED": 0.00,
}
EXPECTED_TOTAL = 1096996.33
EXPECTED_DOCS = 950
EXPECTED_CUSTS = 217
EXPECTED_TAG_NET = 79243.04

def main():
    rows = [json.loads(line) for line in open(FIXTURE) if line.strip()]
    r.SRC = FIXTURE
    r.EXPECTED_TOTAL = round(sum(row["net"] for row in rows), 2)

    r.disjointness_check()
    r.tag_ratification_check()
    r.self_test()
    docs = r.load_docs()
    r.class_vocabulary_audit(docs)

    buckets = collections.defaultdict(float)
    ndocs = 0
    custs = set()
    tag_net = 0.0
    for d in docs:
        b, rule, tag, note = r.classify_doc(d)
        buckets[b] += d["net"]
        ndocs += 1
        custs.add(d["cust"])
        if d["cust"] in r.MAKER_SHAPED_TAG:
            tag_net += d["net"]

    failures = []
    for k, want in EXPECTED_BUCKETS.items():
        got = round(buckets.get(k, 0.0), 2)
        if got != want:
            failures.append(f"{k}: got {got} want {want}")
    total = round(sum(buckets.values()), 2)
    if total != EXPECTED_TOTAL:
        failures.append(f"TOTAL: got {total} want {EXPECTED_TOTAL}")
    if ndocs != EXPECTED_DOCS:
        failures.append(f"DOCS: got {ndocs} want {EXPECTED_DOCS}")
    if len(custs) != EXPECTED_CUSTS:
        failures.append(f"CUSTS: got {len(custs)} want {EXPECTED_CUSTS}")
    if round(tag_net, 2) != EXPECTED_TAG_NET:
        failures.append(f"TAG_NET: got {round(tag_net, 2)} want {EXPECTED_TAG_NET}")

    if failures:
        print("JULY REGRESSION: FAIL")
        for f in failures:
            print("  " + f)
        sys.exit(1)
    print(f"JULY REGRESSION: PASS — {ndocs} docs, {len(custs)} customers, "
          f"total {total:,.2f}, every bucket exact, tag {tag_net:,.2f}")

if __name__ == "__main__":
    main()
