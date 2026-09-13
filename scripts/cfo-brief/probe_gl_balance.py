#!/usr/bin/env python3
"""
GL balance probe — BUILD step 1 of the monthly variance brief design.

Verifies that BI-GLBudgetActual single-account balance reads work for the
accounts the variance brief depends on: AP control (2010-000), Pinnacle cash
(1025-000), Byline cash (1030-000). Runs positive controls: known-Income
accounts that the existing CFO brief already validates are used as the
positive-control set — if they appear but the target account does not, the
account genuinely has no data; if the positive controls also fail, the
instrument is blind (the OData aggregation caveat).

Input: gl-all-periods.json (pull_month.py output — the BI-GLBudgetActual
inquiry response, unwrapped from {"value": [...]}).

Usage: probe_gl_balance.py --workdir DIR [--period MMYYYY]
  --workdir: directory containing gl-all-periods.json
  --period:  optional single period to report (MMYYYY); omit for all periods

Output: JSON on stdout with probe result, balances, and positive-control verdict.
"""
import argparse, json, os, sys
from collections import defaultdict

# Target accounts for the monthly variance brief
TARGET_ACCOUNTS = {
    "2010-000": {"label": "AP control", "type": "Liability"},
    "1025-000": {"label": "Cash — Pinnacle", "type": "Asset"},
    "1030-000": {"label": "Cash — Byline", "type": "Asset"},
}

# Positive controls — Income accounts the existing brief already validates
# (from run_month.py KNOWN_INCOME_ACCOUNTS_FLOOR, plus a few more from the
# actual chart that appear in every-period GL pulls).
POSITIVE_CONTROL_ACCOUNTS = [
    "3010-000",  # Primary sales income — appears in every period
    "3210-000",  # Secondary income
]

# Known account fields in BI-GLBudgetActual (derived from the existing
# run_month.py consumer which accesses Type/FinancialPeriodID/Branch/
# FinPTDCredit/FinPTDDebit). The AccountCD field is the GL account code;
# we also try "Account" as a fallback (some GIs use different field names).
ACCOUNT_KEY_CANDIDATES = ["AccountCD", "Account", "AccountID"]


def find_account_key(rows):
    """Probe which field carries the account code in the GL rows.

    BI-GLBudgetActual may use 'AccountCD' (standard) or 'Account' (some GIs).
    Returns the first key found in any row.
    """
    if not rows:
        return None
    for key in ACCOUNT_KEY_CANDIDATES:
        if key in rows[0]:
            return key
    return None


def probe_balances(gl_rows, period=None):
    """Extract balances for target + control accounts from GL rows.

    Returns {
        "account_key": str,
        "periods_found": int,
        "targets": {account_code: {"label": ..., "type": ..., "found": bool, "periods": {...}}},
        "positive_controls": {account_code: {"found": bool, "periods": {...}}},
        "verdict": "PASS" | "BLIND" | "MIXED",
    }
    """
    account_key = find_account_key(gl_rows)
    if not account_key:
        return {
            "account_key": None,
            "error": "No account-code field found in GL rows — tried: " + ", ".join(ACCOUNT_KEY_CANDIDATES),
            "periods_found": 0,
            "targets": {},
            "positive_controls": {},
            "verdict": "BLIND",
        }

    # Index: {account_code: {period: {branch: balance}}}
    idx = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    all_periods = set()

    for row in gl_rows:
        acct = (row.get(account_key) or "").strip()
        p = (row.get("FinancialPeriodID") or "").strip()
        branch = (row.get("Branch") or "").strip().upper()
        credit = float(row.get("FinPTDCredit") or 0)
        debit = float(row.get("FinPTDDebit") or 0)
        idx[acct][p][branch] += credit - debit
        all_periods.add(p)

    # Restrict to requested period if given
    if period:
        all_periods = {period} & all_periods

    target_accounts = {}
    for code, meta in TARGET_ACCOUNTS.items():
        periods_data = {}
        found = code in idx
        if found:
            for p in sorted(all_periods):
                if p in idx[code]:
                    periods_data[p] = dict(idx[code][p])
        target_accounts[code] = {
            "label": meta["label"],
            "type": meta["type"],
            "found": found,
            "period_count": len(periods_data),
            "periods": periods_data,
        }

    control_accounts = {}
    for code in POSITIVE_CONTROL_ACCOUNTS:
        periods_data = {}
        found = code in idx
        if found:
            for p in sorted(all_periods):
                if p in idx[code]:
                    periods_data[p] = dict(idx[code][p])
        control_accounts[code] = {
            "found": found,
            "period_count": len(periods_data),
            "periods": periods_data,
        }

    # Verdict: controls MUST be found for the probe to be trusted
    controls_found = sum(1 for c in control_accounts.values() if c["found"])
    targets_found = sum(1 for t in target_accounts.values() if t["found"])

    if controls_found == 0:
        verdict = "BLIND"
        verdict_detail = (
            f"All {len(POSITIVE_CONTROL_ACCOUNTS)} positive controls missing — "
            f"the GL instrument cannot be trusted for balance reads. "
            f"The OData aggregation caveat may be in effect (the GI drops "
            f"accounts below the aggregation threshold). A live gateway probe "
            f"with a per-account filter is needed to confirm."
        )
    elif controls_found < len(POSITIVE_CONTROL_ACCOUNTS):
        verdict = "MIXED"
        verdict_detail = (
            f"{controls_found}/{len(POSITIVE_CONTROL_ACCOUNTS)} positive controls found, "
            f"{targets_found}/{len(TARGET_ACCOUNTS)} targets found. "
            f"Instrument partially trusted — missing targets may be real absences."
        )
    elif targets_found == len(TARGET_ACCOUNTS):
        verdict = "PASS"
        verdict_detail = (
            f"All controls and all targets present — the GL instrument is trusted "
            f"for AP and cash balance reads. Proceed to pipeline build."
        )
    else:
        # Controls all present, some targets missing
        missing = [code for code, t in target_accounts.items() if not t["found"]]
        verdict = "MIXED"
        verdict_detail = (
            f"All controls present but targets missing: {missing}. "
            f"These accounts may genuinely have no data in BI-GLBudgetActual "
            f"(check the Account chart for existence) or the GL inquiry may "
            f"exclude them. A live gateway probe is needed."
        )

    return {
        "account_key": account_key,
        "periods_total": len(all_periods),
        "targets": target_accounts,
        "positive_controls": control_accounts,
        "verdict": verdict,
        "verdict_detail": verdict_detail,
    }


def main():
    ap = argparse.ArgumentParser(description="GL balance probe for monthly variance brief")
    ap.add_argument("--workdir", required=True, help="Directory containing gl-all-periods.json")
    ap.add_argument("--period", default=None, help="Single period MMYYYY (omit for all)")
    a = ap.parse_args()

    gl_path = os.path.join(a.workdir, "gl-all-periods.json")
    if not os.path.exists(gl_path):
        print(json.dumps({
            "error": f"GL data not found at {gl_path} — run pull_month.py first",
            "verdict": "BLIND",
        }))
        sys.exit(1)

    gl_rows = json.load(open(gl_path))
    result = probe_balances(gl_rows, a.period)

    # Summary line for human reading
    target_summaries = []
    for code, t in result.get("targets", {}).items():
        if t["found"] and t["periods"]:
            latest_p = sorted(t["periods"].keys())[-1]
            total = round(sum(t["periods"][latest_p].values()), 2)
            target_summaries.append(f"{code} ({t['label']}): ${total:,.2f} @ {latest_p}")
        elif t["found"]:
            target_summaries.append(f"{code} ({t['label']}): found, no period data")
        else:
            target_summaries.append(f"{code} ({t['label']}): NOT FOUND")

    print(json.dumps(result, indent=2))
    print(f"\n[probe] {result['verdict']}: {result.get('verdict_detail', '')}", file=sys.stderr)
    for s in target_summaries:
        print(f"[probe]   {s}", file=sys.stderr)

    sys.exit(0 if result["verdict"] == "PASS" else 2)


if __name__ == "__main__":
    main()