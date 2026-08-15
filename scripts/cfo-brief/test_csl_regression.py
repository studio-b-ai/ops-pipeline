#!/usr/bin/env python3
"""
CashSale (CSL) revenue-stream regression — issue #106.

Three scenarios, ALL sourced from ONE shared fixture (fixtures/cashsale-fixture.jsonl,
the full ~130-doc lifetime CashSale population, unsliced) plus fixtures/account-chart.jsonl
(the 5 Income accounts + 4 non-income accounts actually used across that population):

  (A) 202606 (June 2026) — the primary CSL-bearing month. Exercises the REAL
      run_month.py entry point end-to-end (its actual main(), not a
      reimplementation — #223) against the real ar-invoices-202606.jsonl fixture,
      asserting the seat-verified authoritative totals EXACTLY. A mismatch here
      means the CODE is wrong — never adjust these constants to make it pass.

  (B) 202508 (Aug 2025) — the exclusion-mechanism negative control. No income
      accounts appear this month (all lines are the Milberg 1240-000 factoring
      wires + two 5680-000 Expense lines) — CSL income must be exactly 0.00
      while every non-income line is still SEEN and summed (never silently
      dropped). Tests classify_csl_income()/income_accounts_from_chart()
      directly (the "CSL path only" per the issue spec — no invoice fixture
      exists for this month, deliberately).

  (C) 202607 (July 2026) — the already-shipped fixture stays blind to CSL by
      construction (zero docs at this Date-slice). test_july_regression.py's
      assertions are untouched and unaffected; this file additionally proves
      the CSL slice for July is empty, off the SAME shared fixture used above.

Stdlib only; plain __main__ (no pytest dependency), mirroring
test_july_regression.py. Exit 0 = pass.
"""
import collections, io, json, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pull_month as pm
import run_month as rm
import classify_legs_v1_1 as r

CASHSALE_FIXTURE = os.path.join(HERE, "fixtures", "cashsale-fixture.jsonl")
CHART_FIXTURE = os.path.join(HERE, "fixtures", "account-chart.jsonl")
AR_202606_FIXTURE = os.path.join(HERE, "fixtures", "ar-invoices-202606.jsonl")

EXPECTED_INCOME_ACCOUNTS = {"3010-000", "3210-000", "3212-000", "3213-000", "3214"}

# ---- (A) 202606 authoritative targets — seat-verified against live books.
# Do NOT re-derive or adjust these; a mismatch means the CODE is wrong.
CSL_202606_INCOME_TOTAL = 151137.32
INVOICE_202606_LEG6 = 228123.31          # already-adopted invoice-stream leg6 (unchanged by this fix)
INVOICE_202606_GRAND_TOTAL = 1182934.19  # already-adopted invoice-stream grand total (unchanged)
LEG6_202606_COMBINED = round(INVOICE_202606_LEG6 + CSL_202606_INCOME_TOTAL, 2)      # 379,260.63
GRAND_TOTAL_202606_COMBINED = round(INVOICE_202606_GRAND_TOTAL + CSL_202606_INCOME_TOTAL, 2)  # 1,334,071.51

# ---- (B) 202508 exclusion-mechanism targets — derived transparently from the
# fixture itself (this figure is NOT an independently-verified live-books
# number the way the 202606 ones are; it's what the built fixture actually
# contains, computed and hard-coded here for regression stability). The four
# Milberg 1240-000 wires sum to 625,000.00 exactly (200000+175000+100000+150000);
# the fixture ALSO carries two same-month 5680-000 (Expense-type, non-income)
# lines totaling 686.80 (472.53+214.27) that are equally excluded — the full
# excluded sum for the month is therefore 625,000.00 + 686.80 = 625,686.80.
CSL_202508_MILBERG_ONLY = 625000.00
CSL_202508_EXCLUDED_TOTAL = 625686.80
MILBERG_SEEN_DOC_REF = "INV000421"
MILBERG_SEEN_DOC_AMOUNT = 200000.0


def load_fixture_docs():
    return [json.loads(line) for line in open(CASHSALE_FIXTURE) if line.strip()]


def load_chart_rows():
    return [json.loads(line) for line in open(CHART_FIXTURE) if line.strip()]


def check_a_june_full_pipeline(failures):
    """(A) Run the REAL run_month.py main() end-to-end for 202606 against a
    workdir assembled from the fixtures (mirrors exactly what pull_month.py
    would have written), and separately probe classify_csl_income() directly
    for the CSL-only figure. Both must hit the authoritative targets."""
    raw_docs = load_fixture_docs()
    chart_rows = load_chart_rows()

    # -- direct CSL-path probe (#223: call the actual functions under test)
    income_accts = rm.income_accounts_from_chart(chart_rows)
    if income_accts != EXPECTED_INCOME_ACCOUNTS:
        failures.append(f"A: income_accounts_from_chart mismatch: got {sorted(income_accts)} "
                         f"want {sorted(EXPECTED_INCOME_ACCOUNTS)}")

    sliced_june = pm.slice_cashsale(raw_docs, "202606")
    if len(sliced_june) != 14:
        failures.append(f"A: 202606 slice_cashsale doc count: got {len(sliced_june)} want 14")
    for d in sliced_june:
        d["_cls"] = ""  # all real income lines are FERNCREST-branch; class never consulted (R7 wins)

    deltas, income_total, excluded_total, excluded_lines = rm.classify_csl_income(
        sliced_june, income_accts, r.classify_doc
    )
    if income_total != CSL_202606_INCOME_TOTAL:
        failures.append(f"A: CSL income total (direct probe): got {income_total} want {CSL_202606_INCOME_TOTAL}")
    if excluded_total != 0.00:
        failures.append(f"A: CSL excluded total (direct probe): got {excluded_total} want 0.00")
    if excluded_lines != 0:
        failures.append(f"A: CSL excluded lines (direct probe): got {excluded_lines} want 0")
    leg6_delta = deltas.get("leg6", {"net": 0.0})["net"]
    if round(leg6_delta, 2) != CSL_202606_INCOME_TOTAL:
        failures.append(f"A: all 202606 CSL income should land leg6 (all FERNCREST-branch): "
                         f"got {round(leg6_delta, 2)} want {CSL_202606_INCOME_TOTAL}")
    other_legs = {b: round(v['net'], 2) for b, v in deltas.items() if b != "leg6" and v["net"]}
    if other_legs:
        failures.append(f"A: unexpected non-leg6 CSL income buckets: {other_legs}")

    # -- full end-to-end wiring probe: the REAL run_month.main() entry point.
    with tempfile.TemporaryDirectory() as wd:
        with open(os.path.join(wd, "ar-invoices-202606.jsonl"), "w") as f:
            f.write(open(AR_202606_FIXTURE).read())
        # GL reconciliation isn't part of this issue's authoritative targets —
        # an empty oracle just means the two-oracle marker prints INVESTIGATE
        # (not a pass/fail signal this test asserts on).
        json.dump([], open(os.path.join(wd, "gl-all-periods.json"), "w"))
        fresh_sliced = pm.slice_cashsale(raw_docs, "202606")
        for d in fresh_sliced:
            d["_cls"] = ""
        json.dump(fresh_sliced, open(os.path.join(wd, "cashsale-202606.json"), "w"))
        json.dump(chart_rows, open(os.path.join(wd, "account-chart.json"), "w"))

        argv_bak = sys.argv
        stdout_bak = sys.stdout
        sys.argv = ["run_month.py", "--ym", "202606", "--workdir", wd,
                    "--out", os.path.join(wd, "brief.md")]
        buf = io.StringIO()
        sys.stdout = buf
        try:
            rm.main()
        finally:
            sys.stdout = stdout_bak
            sys.argv = argv_bak

        out_lines = [ln for ln in buf.getvalue().splitlines() if ln.strip()]
        result = json.loads(out_lines[-1])  # main()'s final print is the machine-readable summary

    if result["csl_income_total"] != CSL_202606_INCOME_TOTAL:
        failures.append(f"A: main() csl_income_total: got {result['csl_income_total']} "
                         f"want {CSL_202606_INCOME_TOTAL}")
    if round(result["buckets"]["leg6"], 2) != LEG6_202606_COMBINED:
        failures.append(f"A: main() leg6 (invoice {INVOICE_202606_LEG6} + CSL {CSL_202606_INCOME_TOTAL}): "
                         f"got {result['buckets']['leg6']} want {LEG6_202606_COMBINED}")
    if round(result["total"], 2) != GRAND_TOTAL_202606_COMBINED:
        failures.append(f"A: main() grand total (invoice {INVOICE_202606_GRAND_TOTAL} + "
                         f"CSL {CSL_202606_INCOME_TOTAL}): got {result['total']} want {GRAND_TOTAL_202606_COMBINED}")


def check_b_august_exclusion(failures):
    """(B) 202508 — the exclusion-mechanism negative control: CSL income must
    be exactly 0.00 (no income-account lines that month) while every
    non-income line is SEEN and summed (never silently dropped). CSL path
    only — no invoice fixture exists for this month, deliberately (#106 spec:
    "run month 202508 through the CSL path only")."""
    raw_docs = load_fixture_docs()
    chart_rows = load_chart_rows()
    income_accts = rm.income_accounts_from_chart(chart_rows)

    sliced_aug = pm.slice_cashsale(raw_docs, "202508")
    if len(sliced_aug) != 6:
        failures.append(f"B: 202508 slice_cashsale doc count: got {len(sliced_aug)} want 6")
    for d in sliced_aug:
        d["_cls"] = ""

    # Positive control (#322): the Milberg 200,000.00 doc was actually SEEN
    # in the slice, on the excluded account, before we trust the exclusion.
    milberg_doc = next((d for d in sliced_aug if d.get("ReferenceNbr") == MILBERG_SEEN_DOC_REF), None)
    if milberg_doc is None:
        failures.append(f"B: Milberg doc {MILBERG_SEEN_DOC_REF} not found in 202508 slice — "
                         f"instrument may be blind (#322)")
    else:
        milberg_lines = [l for l in milberg_doc.get("Details", []) if l.get("Account") == "1240-000"]
        if not milberg_lines or milberg_lines[0].get("Amount") != MILBERG_SEEN_DOC_AMOUNT:
            failures.append(f"B: Milberg doc {MILBERG_SEEN_DOC_REF} line mismatch: {milberg_lines}")
        if "1240-000" in income_accts:
            failures.append("B: 1240-000 (Milberg) is classified as an Income account — should be Asset")

    deltas, income_total, excluded_total, excluded_lines = rm.classify_csl_income(
        sliced_aug, income_accts, r.classify_doc
    )
    if income_total != 0.00:
        failures.append(f"B: 202508 CSL income total: got {income_total} want 0.00 "
                         f"(no income-account lines this month)")
    if excluded_total != CSL_202508_EXCLUDED_TOTAL:
        failures.append(f"B: 202508 excluded total: got {excluded_total} want {CSL_202508_EXCLUDED_TOTAL}")
    if excluded_lines != 6:
        failures.append(f"B: 202508 excluded line count: got {excluded_lines} want 6")
    if deltas:
        failures.append(f"B: 202508 should route ZERO docs to any leg bucket (all excluded): got {dict(deltas)}")

    # Milberg-only subtotal, sanity-anchored against the issue's own estimate.
    milberg_only = round(sum(
        line.get("Amount") or 0
        for d in sliced_aug for line in d.get("Details", [])
        if line.get("Account") == "1240-000"
    ), 2)
    if milberg_only != CSL_202508_MILBERG_ONLY:
        failures.append(f"B: Milberg-only (1240-000) subtotal: got {milberg_only} want {CSL_202508_MILBERG_ONLY}")


def check_c_july_zero_csl(failures):
    """(C) 202607 (July) — the already-shipped fixture stays blind to CSL by
    construction. test_july_regression.py's own assertions are untouched and
    out of scope here; this only proves the CSL slice is empty off the SAME
    shared all-docs fixture used in (A)/(B)."""
    raw_docs = load_fixture_docs()
    sliced_july = pm.slice_cashsale(raw_docs, "202607")
    if len(sliced_july) != 0:
        failures.append(f"C: 202607 slice_cashsale doc count: got {len(sliced_july)} want 0 "
                         f"(July has zero CSL docs by Date — the reason July's original fixture "
                         f"was blind to this class)")

    chart_rows = load_chart_rows()
    income_accts = rm.income_accounts_from_chart(chart_rows)
    deltas, income_total, excluded_total, excluded_lines = rm.classify_csl_income(
        sliced_july, income_accts, r.classify_doc
    )
    if income_total != 0.00:
        failures.append(f"C: 202607 CSL income total: got {income_total} want 0.00")
    if excluded_total != 0.00 or excluded_lines != 0:
        failures.append(f"C: 202607 CSL excluded: got total={excluded_total} lines={excluded_lines} want 0/0")


def main():
    failures = []
    check_a_june_full_pipeline(failures)
    check_b_august_exclusion(failures)
    check_c_july_zero_csl(failures)

    if failures:
        print("CSL REGRESSION: FAIL")
        for f in failures:
            print("  " + f)
        sys.exit(1)
    print(f"CSL REGRESSION: PASS — 202606 CSL income {CSL_202606_INCOME_TOTAL:,.2f} "
          f"(leg6 combined {LEG6_202606_COMBINED:,.2f}, grand total {GRAND_TOTAL_202606_COMBINED:,.2f}); "
          f"202508 exclusion mechanism verified (income 0.00, excluded {CSL_202508_EXCLUDED_TOTAL:,.2f}, "
          f"Milberg {MILBERG_SEEN_DOC_REF} seen); 202607 CSL slice empty (0 docs)")


if __name__ == "__main__":
    main()
