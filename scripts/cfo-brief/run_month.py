#!/usr/bin/env python3
"""
Classify one pulled month under ruleset v1.1 (verbatim module) and render the
monthly CFO brief as markdown.

Usage: run_month.py --ym YYYYMM --workdir DIR [--out brief.md]

Reuses classify_legs_v1_1.py via import + monkeypatch (the seat-proven runner
pattern): ONE rule source, no fork. All gates live: disjointness, tag identity,
#322 controls, class-vocabulary audit, H9 zero-row, H2 materiality (loud,
non-fatal here — the brief carries the breach), candidate detector (a-d).
Two-oracle GL reconciliation: Heritage + Ferncrest income vs AR-posted (the
21%-hidden-stream lesson institutionalized). Quarter-end months (Mar/Jun/Sep/
Dec) additionally check trailing-3-month GL total vs the LOW-path quarter —
below the floor prints an ESCALATION-CANDIDATE block; machinery never
auto-escalates prose (seat action required).
"""
import argparse, collections, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import classify_legs_v1_1 as r

ORDER = ["leg1", "leg2", "leg3", "leg4", "leg5", "leg6", "H2_unclassified", "H0_internal", "H9_UNMAPPED"]
LABEL = {
    "leg1": "Leg 1 — Core designer trade", "leg2": "Leg 2 — Maker cohort (new-motion)",
    "leg3": "Leg 3 — Own DTC", "leg4": "Leg 4 — Marketplace programs",
    "leg5": "Leg 5 — Hospitality spec", "leg6": "Leg 6 — Make-side / contract mfg",
    "H2_unclassified": "H2 — hold: unclassified class", "H0_internal": "H0 — internal/house",
    "H9_UNMAPPED": "H9 — UNMAPPED (fail-closed)",
}
V2_REF_SHARES = {"leg1": 73.2, "leg6": 21.0}
LOW_PATH_ANNUAL = {2026: 12.5e6, 2027: 16.5e6, 2028: 21.8e6, 2029: 28.7e6, 2030: 37.9e6, 2031: 50.0e6}
UNPOSTED_STATUSES = {"ON HOLD", "BALANCED"}

def ym_to_period(ym):
    return ym[4:6] + ym[0:4]

def gl_income_by_period(gl_rows):
    out = collections.defaultdict(lambda: {"FERNCREST": 0.0, "OTHER": 0.0})
    for row in gl_rows:
        if (row.get("Type") or "").strip() != "Income":
            continue
        p = (row.get("FinancialPeriodID") or "").strip()
        v = float(row.get("FinPTDCredit") or 0) - float(row.get("FinPTDDebit") or 0)
        key = "FERNCREST" if (row.get("Branch") or "").strip().upper() == "FERNCREST" else "OTHER"
        out[p][key] += v
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ym", required=True)
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    ym, wd = a.ym, a.workdir

    src = os.path.join(wd, f"ar-invoices-{ym}.jsonl")
    rows = [json.loads(line) for line in open(src) if line.strip()]
    expected = round(sum(row["net"] for row in rows), 2)
    r.SRC = src
    r.EXPECTED_TOTAL = expected

    r.disjointness_check()
    r.tag_ratification_check()
    r.self_test()
    docs = r.load_docs()
    r.class_vocabulary_audit(docs)

    buckets = collections.defaultdict(lambda: {"net": 0.0, "docs": 0, "custs": set()})
    bucket_of = {}
    tagged = []
    for d in docs:
        b, rule, tag, note = r.classify_doc(d)
        bucket_of[(d["ttype"], d["ref"])] = b
        buckets[b]["net"] += d["net"]; buckets[b]["docs"] += 1; buckets[b]["custs"].add(d["cust"])
        if d["cust"] in r.MAKER_SHAPED_TAG:
            tagged.append((d, b))

    h9 = buckets.get("H9_UNMAPPED", {"net": 0.0, "docs": 0, "custs": set()})
    assert h9["docs"] == 0 and not h9["custs"], f"H9 NOT EMPTY: {h9}"
    bad_tag = [(d["cust"], b) for d, b in tagged if b != "leg1"]
    assert not bad_tag, f"TAGGED DOCS OUTSIDE LEG1: {bad_tag}"
    total = round(sum(b["net"] for b in buckets.values()), 2)
    assert total == expected, f"RECONCILE FAIL: {total} != {expected}"

    tag_net = round(sum(d["net"] for d, b in tagged), 2)
    h2_gross = round(sum(abs(d["net"]) for d in docs if bucket_of[(d["ttype"], d["ref"])] == "H2_unclassified"), 2)
    unposted = round(sum(row["net"] for row in rows
                         if (row.get("status") or "").strip().upper() in UNPOSTED_STATUSES), 2)

    gl_rows = json.load(open(os.path.join(wd, "gl-all-periods.json")))
    gl = gl_income_by_period(gl_rows)
    period = ym_to_period(ym)
    gp = gl.get(period, {"FERNCREST": 0.0, "OTHER": 0.0})
    gl_total = round(gp["FERNCREST"] + gp["OTHER"], 2)
    ar_posted = round(total - unposted, 2)
    residual = round(ar_posted - gl_total, 2)
    leg6_ar = round(buckets.get("leg6", {"net": 0.0})["net"], 2)
    fern_gl = round(gp["FERNCREST"], 2)

    lines = []
    w = lines.append
    w(f"# CFO monthly brief — {ym[:4]}-{ym[4:6]}")
    w("")
    w(f"**Marker (#294): books-pulled; AR net ${total:,.2f}; GL income ${gl_total:,.2f}; "
      f"residual ${residual:,.2f}" + (" — GL-RECONCILED**" if abs(residual) <= 1000 else " — INVESTIGATE residual**"))
    w("")
    w("| Bucket | Net USD | Docs | Custs | % of month | v2 T12M ref |")
    w("|---|---:|---:|---:|---:|---:|")
    for k in ORDER:
        b = buckets.get(k, {"net": 0.0, "docs": 0, "custs": set()})
        pct = (b["net"] / total * 100) if total else 0.0
        ref = f"{V2_REF_SHARES[k]:.1f}%" if k in V2_REF_SHARES else "—"
        w(f"| {LABEL[k]} | {b['net']:,.2f} | {b['docs']} | {len(b['custs'])} | {pct:.1f}% | {ref} |")
    w(f"| **TOTAL** | **{total:,.2f}** | {sum(b['docs'] for b in buckets.values())} | | 100.0% | |")
    w("")
    w(f"**Two-oracle (leg 6 forever checks both ledgers):** AR leg-6 ${leg6_ar:,.2f} · "
      f"Ferncrest GL income ${fern_gl:,.2f} · Heritage GL ${gp['OTHER']:,.2f} · "
      f"unposted (On Hold/Balanced) ${unposted:,.2f}. "
      + ("Ferncrest oracles agree within noise." if abs(fern_gl - leg6_ar) <= max(1000, 0.05 * max(abs(fern_gl), 1))
         else f"**Ferncrest AR-vs-GL gap ${round(fern_gl - leg6_ar, 2):,.2f} — the journal-stream pattern; investigate before trusting leg 6.**"))
    w("")
    w(f"**Maker-shaped tag (inside leg 1): ${tag_net:,.2f}** — the channel series point for the month.")
    if h2_gross > r.H2_ABS_LIMIT:
        w(f"")
        w(f"**H2 MATERIALITY: gross ${h2_gross:,.2f} exceeds the ${r.H2_ABS_LIMIT:,.0f} limit — "
          f"unclassified customers need CS assignment (rides the DISTRIBUTOR flip batch).**")
    w("")
    w("## Candidate detector")
    w("```")

    import io
    buf = io.StringIO()
    stdout = sys.stdout
    sys.stdout = buf
    try:
        r.candidate_detector(docs, bucket_of)
    finally:
        sys.stdout = stdout
    w(buf.getvalue().rstrip())
    w("```")

    month = int(ym[4:6])
    if month in (3, 6, 9, 12):
        year = int(ym[:4])
        low_q = LOW_PATH_ANNUAL.get(year, 0) / 4
        q_periods = []
        y, m = year, month
        for _ in range(3):
            q_periods.append(f"{m:02d}{y}")
            m -= 1
            if m == 0:
                m, y = 12, y - 1
        q_total = round(sum(gl.get(p, {"FERNCREST": 0, "OTHER": 0})["FERNCREST"]
                            + gl.get(p, {"FERNCREST": 0, "OTHER": 0})["OTHER"] for p in q_periods), 2)
        w("")
        w(f"## Quarter check (calendar Q ending {ym[:4]}-{ym[4:6]})")
        w(f"Trailing-3-month GL income ${q_total:,.2f} vs LOW-path quarter ${low_q:,.0f}.")
        if low_q and q_total < low_q:
            deltas = sorted(((k, buckets.get(k, {'net': 0.0})['net']) for k in ORDER[:6]), key=lambda x: x[1])
            w("")
            w("**ESCALATION-CANDIDATE — quarter below the LOW floor.**")
            w("Cause candidates (smallest legs this month): " + ", ".join(f"{LABEL[k]} ${v:,.0f}" for k, v in deltas[:3]))
            w("**SEAT ACTION REQUIRED — machinery never auto-escalates prose.**")
        else:
            w("Above the floor — notification lane.")

    brief = "\n".join(lines) + "\n"
    out_path = a.out or os.path.join(wd, f"brief-{ym}.md")
    open(out_path, "w").write(brief)
    print(f"[run] brief written: {out_path}", flush=True)
    print(json.dumps({"ym": ym, "total": total, "gl_total": gl_total, "residual": residual,
                      "leg6_ar": leg6_ar, "fern_gl": fern_gl, "tag_net": tag_net,
                      "h2_gross": h2_gross,
                      "buckets": {k: round(buckets.get(k, {'net': 0.0})["net"], 2) for k in ORDER}}))

if __name__ == "__main__":
    main()
