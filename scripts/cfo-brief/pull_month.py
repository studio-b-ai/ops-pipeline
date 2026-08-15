#!/usr/bin/env python3
"""
Pull one closed month's AR (doc-level), the Customer master, and the unfiltered
GL oracle via the studiob-api gateway. Python stdlib only.

Env: ACUMATICA_GATEWAY_URL, ACUMATICA_GATEWAY_TOKEN.
Usage: pull_month.py --period MMYYYY --ym YYYYMM --workdir DIR

Laws baked in: bare query params (#181); entity route for Invoice (the GI route
TCP-resets on quoted-string filters — studiob#490 — so BI-GLBudgetActual is
pulled UNFILTERED and sliced client-side); 429 honors Retry-After once (#437);
other failures wait 60s and retry ONCE, then exit loudly (#161); exact-page
continuation with a hard page cap that WARNS instead of silently truncating
(#331). Sign law: net = (Amount - TaxTotal), negated for credit types.

CashSale (issue #106): the CashSale entity has NO filterable PostPeriod, so it
is pulled with ONE unfiltered call (expand=Details; the set is ~130 docs
lifetime — no paging ladder needed) and sliced client-side to the target month
by the doc's Date field. Date-period is a SLICING PROXY for GL PostPeriod, not
the real period field — the two-oracle GL check in run_month.py absorbs any
misperiodization drift this proxy introduces. Only Status == 'Closed' docs are
kept (unreleased docs are not in GL). The chart of accounts (AccountCD, Type)
is pulled once alongside it so run_month.py can filter CashSale Detail lines to
Income-type accounts without ever hardcoding the account list into classification
logic. NEVER use the BI-ARInvoices GI TranType to detect cash sales — it
mislabels CSL docs as INV (proven: INV010267-72); the CashSale entity is the
only CSL enumeration source.
"""
import argparse, json, os, random, sys, time, urllib.parse, urllib.request

NEG_TYPES = {"Credit Memo", "Credit WO", "Cash Return"}
PAGE = 1000
PAGE_CAP = 10

def fetch(path, params):
    base = os.environ["ACUMATICA_GATEWAY_URL"].rstrip("/")
    tok = os.environ["ACUMATICA_GATEWAY_TOKEN"]
    url = f"{base}/api/v1/acumatica/{path}?{urllib.parse.urlencode(params)}"
    last_err = None
    for attempt in (1, 2):
        try:
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
            with urllib.request.urlopen(req, timeout=180) as r:
                body = r.read().decode()
            data = json.loads(body)
            if isinstance(data, dict) and data.get("error"):
                raise RuntimeError(f"gateway error envelope: {body[:200]}")
            return data
        except urllib.error.HTTPError as e:
            if e.code == 429:
                ra = int(e.headers.get("Retry-After") or 30)
                wait = min(ra, 60) + random.uniform(0, 5)
                print(f"[pull] 429 pool_saturated — waiting {wait:.0f}s (#437)", flush=True)
            else:
                wait = 60
                print(f"[pull] HTTP {e.code} on {path} attempt {attempt} — waiting {wait}s", flush=True)
            last_err = e
            if attempt == 1:
                time.sleep(wait)
        except Exception as e:
            last_err = e
            print(f"[pull] {type(e).__name__}: {e} on {path} attempt {attempt}", flush=True)
            if attempt == 1:
                time.sleep(60)
    raise SystemExit(f"PULL FAILED after retry: {path}: {last_err}")

def pull_all(entity, select, flt):
    rows, skip, page = [], 0, 0
    while page < PAGE_CAP:
        params = {"select": select, "top": PAGE, "skip": skip}
        if flt:
            params["filter"] = flt
        batch = fetch(f"query/{entity}", params)
        rows.extend(batch)
        print(f"[pull] {entity} page {page}: {len(batch)} rows", flush=True)
        if len(batch) < PAGE:
            return rows
        skip += PAGE
        page += 1
    print(f"[pull] **WARN: {entity} hit the {PAGE_CAP}-page cap — population may be truncated (#331)**", flush=True)
    return rows

def slice_cashsale(raw_docs, ym):
    """Client-side month + status slice for CashSale docs (#106).

    PostPeriod is not filterable on the CashSale entity, so pull_all() cannot
    do the narrowing server-side the way it does for Invoice. Instead the
    single unfiltered CashSale pull is sliced HERE by the doc's Date field
    (YYYY-MM == target month). Date-period is a SLICING PROXY, not the real
    GL period — the two-oracle GL reconciliation in run_month.py absorbs any
    drift this proxy introduces. Unreleased (non-Closed) docs are dropped —
    they are not in the GL yet. Pure function: no I/O, directly testable
    against a fixture covering many months (test_csl_regression.py exercises
    202606/202508/202607 off ONE fixture this way).
    """
    target = f"{ym[0:4]}-{ym[4:6]}"
    out = []
    for d in raw_docs:
        if (d.get("Date") or "")[:7] != target:
            continue
        if (d.get("Status") or "").strip() != "Closed":
            continue
        out.append(d)
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--period", required=True, help="MMYYYY, e.g. 072026")
    ap.add_argument("--ym", required=True, help="YYYYMM, e.g. 202607")
    ap.add_argument("--workdir", required=True)
    a = ap.parse_args()
    os.makedirs(a.workdir, exist_ok=True)

    invs = pull_all(
        "Invoice",
        "Type,ReferenceNbr,Customer,Date,PostPeriod,Amount,TaxTotal,Status,LinkBranch,CustomerOrder,Description",
        f"PostPeriod eq '{a.period}'",
    )
    custs_raw = pull_all("Customer", "CustomerID,CustomerClass,CustomerName,Status", None)
    custs = {}
    for c in custs_raw:
        cid = (c.get("CustomerID") or "").strip()
        custs[cid] = {"cls": (c.get("CustomerClass") or "").strip(), "name": c.get("CustomerName")}

    out = []
    for r in invs:
        t = r.get("Type") or "?"
        amt = float(r.get("Amount") or 0)
        tax = float(r.get("TaxTotal") or 0)
        sign = -1.0 if t in NEG_TYPES else 1.0
        cust = (r.get("Customer") or "").strip()
        m = custs.get(cust, {})
        out.append({
            "cust": cust, "name": m.get("name"), "cls": m.get("cls", ""),
            "type": t, "ref": r.get("ReferenceNbr"), "date": (r.get("Date") or "")[:10],
            "period": r.get("PostPeriod"), "status": r.get("Status"),
            "branch": (r.get("LinkBranch") or "").strip(), "net": round(sign * (amt - tax), 2),
            "gross": amt, "tax": tax, "custorder": r.get("CustomerOrder"),
            "desc": r.get("Description"),
        })
    ar_path = os.path.join(a.workdir, f"ar-invoices-{a.ym}.jsonl")
    with open(ar_path, "w") as f:
        for row in out:
            f.write(json.dumps(row) + "\n")
    total = round(sum(r["net"] for r in out), 2)
    print(f"[pull] AR {a.ym}: {len(out)} doc rows, net total {total:,.2f} -> {ar_path}", flush=True)

    gl = fetch("inquiry/BI-GLBudgetActual", {"top": 5000})
    gl_rows = gl.get("value", gl) if isinstance(gl, dict) else gl
    gl_path = os.path.join(a.workdir, "gl-all-periods.json")
    json.dump(gl_rows, open(gl_path, "w"))
    print(f"[pull] GL oracle: {len(gl_rows)} rows (all periods, unfiltered) -> {gl_path}", flush=True)

    # CashSale revenue stream (#106): ONE unfiltered call (no PostPeriod filter
    # exists on this entity — top=1000 covers the ~130-doc lifetime population
    # with room to spare), sliced client-side to the target month + Closed-only.
    # FAIL LOUD (not warn-and-proceed) on hitting the cap: the downstream run
    # consumes this file as the authoritative in-month CashSale set, and a
    # truncated pull would silently UNDERREPORT CSL revenue for any in-month
    # docs past the cut page — the two-oracle GL check might eventually flag
    # the resulting residual, but there is no reason to ship a known-truncated
    # pull when the fix is to widen top or add a skip-paging ladder (codex
    # #106 review pass 3, P2).
    csl_raw = fetch("query/CashSale", {"expand": "Details", "top": 1000})
    if len(csl_raw) >= 1000:
        raise SystemExit(
            "CASHSALE PULL FAIL: query hit the 1000-row cap — the lifetime population may "
            "have outgrown the single-call assumption (#106); widen top or add skip-paging "
            "before re-running rather than shipping a truncated in-month slice."
        )
    csl_docs = slice_cashsale(csl_raw, a.ym)
    for d in csl_docs:
        cid = (d.get("CustomerID") or "").strip()
        d["_cls"] = custs.get(cid, {}).get("cls", "")
    csl_path = os.path.join(a.workdir, f"cashsale-{a.ym}.json")
    json.dump(csl_docs, open(csl_path, "w"))
    print(f"[pull] CashSale {a.ym}: {len(csl_docs)} in-month Closed docs (of {len(csl_raw)} "
          f"lifetime) -> {csl_path}", flush=True)

    # Chart of accounts (#106): fetched once so run_month.py can filter CashSale
    # Detail lines to Income-type accounts without hardcoding the account list
    # into classification logic (a hardcoded list is fail-loud VALIDATION only).
    # FAIL LOUD (not a warn-and-proceed like the CashSale/Invoice population
    # caps above) if this hits the page cap: unlike an undercounted revenue
    # pull — which the two-oracle GL check would eventually surface as a
    # growing residual — a TRUNCATED chart silently MISCLASSIFIES real Income
    # account lines as excluded cash movements (codex #106 review, P2). A
    # truncated chart is never safe to classify revenue against.
    chart_raw = fetch("query/Account", {"select": "AccountCD,Type", "top": 500})
    if len(chart_raw) >= 500:
        raise SystemExit(
            "CHART PULL FAIL: Account query hit the 500-row cap — the chart may be "
            "truncated, and classifying CashSale revenue against a partial chart risks "
            "silently miscategorizing real Income accounts as excluded (#106). Widen "
            "top or add paging before re-running."
        )
    chart_path = os.path.join(a.workdir, "account-chart.json")
    json.dump(chart_raw, open(chart_path, "w"))
    print(f"[pull] Account chart: {len(chart_raw)} accounts -> {chart_path}", flush=True)

    missing_cls = sum(1 for r in out if not r["cls"])
    if out and missing_cls == len(out):
        raise SystemExit("PULL SANITY FAIL: every doc missing customer class — master join broken (the 8/13 master-wipe lesson)")

if __name__ == "__main__":
    main()
