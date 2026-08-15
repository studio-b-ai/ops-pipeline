#!/usr/bin/env python3
"""
LEG-MAPPING RULESET v1.2 — DOC-LEVEL hardening of v1, implementing the codex
adversarial-review remediation spec (Kevin, 2026-08-13). Classifies at
DOCUMENT level straight from the raw line-level substrate
(ar-invoices-202607.jsonl) instead of the pre-aggregated customer-level
substrate v1 consumed (ar-202607-by-customer.json). A document = (type, ref);
per-doc net = sum of its lines' net field. In this month's data every (type,
ref) pair is carried by exactly one JSONL row, so the "sum of lines" collapses
to a passthrough for July — but the grouping is written generally so a future
month with true multi-line documents classifies correctly without a rewrite.

v1.2 (2026-08-15): MAKESIDE_NAMED += P/Kaufmann family (C001544/C001574/C001578);
D4 FAIRE mint comment; RENTAL_INCOME_ACCOUNT flag. Zero fixture-month movement
— hardening only.

Named-account rules (R1-R6, copied verbatim from v1) still classify ALL of a
matched customer's docs, exactly as in v1 (customer-level intent, unconditional
on any one document's data quality). The branch rule (R7) becomes PER-DOC: any
document on branch FERNCREST from a customer not already matched by a named
rule routes THAT DOCUMENT to leg6; the same customer's non-Ferncrest documents
continue through R8/R9 independently. This replaces v1's fragile customer-level
`branches == {FERNCREST}` set-equality test, which silently mis-handled (by
falling through to R8/R9 for the WHOLE customer) any account that ever splits
AR across branches.

RULINGS REGISTER — unchanged from v1 (D1-as-amended, D2, D3); full ruling text
lives in classify_legs_v1.py's header docstring and is not repeated here.

Basis unchanged from v0/v1: PostPeriod 072026, net is already type-signed in
the source data, ALL statuses included. Read-only. No network. Python 3
stdlib only. Script does all math.
"""
import json
import re
import sys
import collections

SRC = "/Users/kevin/dev/cfo-data/ar-invoices-202607.jsonl"
EXPECTED_TOTAL = 1096996.33  # RAW reconcile target only — spec #9: % columns use the ACTUAL runtime total, not this constant.
H2_ABS_LIMIT = 5000.00  # named constant (comment: seat-set) — spec #6 H2 materiality gate.

# July v1 bucket NET totals — the load-bearing "doc-level classification moved
# nothing this month" regression gate (spec #12). NEVER edit these to make the
# gate pass; a mismatch here means STOP and report, not "fix".
V1_JULY_NET = {
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
V1_JULY_TOTAL = 1096996.33
V1_JULY_DOCS = 950
V1_JULY_CUSTS = 217

# ---------------------------------------------------------------- named lists (verbatim copy from v1 — spec item 1)
INTERNAL_HOUSE = {  # R1 -> H0 (not customer revenue)
    "C000949": "HERITAGE FABRICS MANAGEMENT LLC — QA/test seat (Rule #445) + intercompany",
    "C001004": "WEBSAMPLE — web sample-program clearing account",
}
DTC_HOUSE = {  # R2 -> leg 3 (named consumer-direct settlement seats; D7 confirm pending)
    "C001565": "DTC-WEB (Web Retail house account) — rail blanked to base/MSRP 7/30 = DTC retail",
}
PEPPER_COHORT = {}  # R3 -> leg 2. D3: Kevin+CMO-ratified NEW-MOTION wins only. Starts EMPTY (honest).
MARKETPLACE_PROGRAM = {  # R4 -> leg 4. D4 RULED 2026-08-13: 3-prong test ratified
    # (program contract/integration + platform-driven order flow + program economics).
    "C000862": "WAYFAIR LLC — dropship marketplace program (supplier ID 39803)",
}
# D4: Kevin-pre-named PIPELINE programs — dormant until an AR account is born.
# The candidate detector (d) watches for these name tokens; on first appearance
# the seat converts the hit to a customer-ID entry in MARKETPLACE_PROGRAM above.
# D4 activation rider (8/15): on FAIRE account mint, move the entry to MARKETPLACE_PROGRAM keyed by the new C-number IN THE SAME PR; land the account in class RETAILER (Wayfair precedent C000862). Class never drives leg 4 — the named list does (R4 before R9).
PENDING_PROGRAMS = {
    "FAIRE": "Faire Wholesale — marketplace program, Kevin pre-named 2026-08-13 (D4); no AR account yet",
}
HOSPITALITY_DIRECT_SPEC = {}  # R5 -> leg 5 (spec WE hold; D5 pending — none ratified)
MAKESIDE_NAMED = {  # R6 -> leg 6 (D2 RULED: a real leg, not a hold)
    "C001243": "Medline Industries, LP — cut-make-trim private-label program on customer-supplied cloth",
    "C001544": "P/kaufmann Inc. — make-side program (CSL-billed Jan–Jun 2026; named 8/15 after 4 surfacings)",
    "C001574": "P/Kaufmann Home — make-side program (MIXED-BRANCH account: has HERITAGE-branch docs; naming protects against branch-rule misroute)",
    "C001578": "P/KAUFMANN CONTRACT — make-side program (born Jul 2026 from the P/K split)",
}
MAKESIDE_BRANCH = "FERNCREST"  # R7 -> leg 6, now PER-DOC (spec #1)

RENTAL_INCOME_ACCOUNT = "3214"  # Casa Flora C001550 pays Ferncrest RENT via CashSale docs (~$27K T12M, immaterial); rides leg 6 today by R6/R7. Flagged micro-cell for a future ruleset rev — property income, not make-side services. No routing change in v1.2.

# D3 TAG — maker-shaped accounts INSIDE leg 1 (reporting dimension, not a bucket).
MAKER_SHAPED_TAG = {
    "C000857": "3DAY BLINDS LLC — custom window fabricator (Shade-Store-shaped)",
    "C000214": "HORIZON SHADES — custom window fabricator (#5 customer)",
    "C000865": "Tonic Living — digital-native maker",
    "C000299": "Quatrine Home — MTO upholstery",
    "C000491": "Loluma — digital-native maker",
    "C000317": "Swanky Press / Laurel & Blush — digital-native maker",
}

# R9 class defaults -> leg 1. D1: SYNONYM SET {JOBBER, CONTRACTOR, DISTRIBUTOR} —
# CONTRACTOR routes with JOBBER now; DISTRIBUTOR is the migration target name.
TRADE_CLASSES = {"JOBBER", "CONTRACTOR", "DISTRIBUTOR", "DISTRIB",
                 "RETAILER", "FURNITURE", "MFG", "DESIGNER", "EXPORT"}
UNCLASSIFIED = {"TBD", "", "NONE", "NULL"}

NAMED_LISTS = {
    "INTERNAL_HOUSE": INTERNAL_HOUSE,
    "DTC_HOUSE": DTC_HOUSE,
    "PEPPER_COHORT": PEPPER_COHORT,
    "MARKETPLACE_PROGRAM": MARKETPLACE_PROGRAM,
    "HOSPITALITY_DIRECT_SPEC": HOSPITALITY_DIRECT_SPEC,
    "MAKESIDE_NAMED": MAKESIDE_NAMED,
    "MAKER_SHAPED_TAG": MAKER_SHAPED_TAG,
}


def norm(s):
    """spec #2: normalization at ingest — strip()+upper() on cust/cls/branch before any comparison."""
    return (s or "").strip().upper()


# ------------------------------------------------------------- spec #3: named-list disjointness
def disjointness_check():
    names = list(NAMED_LISTS)
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = NAMED_LISTS[names[i]], NAMED_LISTS[names[j]]
            overlap = set(a) & set(b)
            assert not overlap, f"DISJOINTNESS FAIL: {names[i]} ∩ {names[j]} = {overlap}"
    print(f"DISJOINTNESS (spec #3): {len(names)} named lists (incl. MAKER_SHAPED_TAG) pairwise disjoint OK")


# ------------------------------------------------------------- spec #8: tag ratification control
def tag_ratification_check():
    expected = {"C000857", "C000214", "C000865", "C000299", "C000491", "C000317"}
    actual = set(MAKER_SHAPED_TAG)
    assert actual == expected, f"TAG RATIFICATION FAIL: MAKER_SHAPED_TAG keys {actual} != ratified {expected}"
    print(f"TAG RATIFICATION (spec #8): MAKER_SHAPED_TAG == exactly the 6 ratified accounts OK")


def classify_doc(doc):
    """Ordered, deterministic, first-match-wins. DOC-LEVEL (spec #1).
    Returns (bucket, rule_id, tag, note)."""
    cust = doc["cust"]
    cls = doc["cls"]
    branch = doc["branch"]
    tag = cust in MAKER_SHAPED_TAG

    # R1-R6: named customer-level rules — unconditional, classify ALL of that
    # customer's docs, exactly as v1 (spec #1: "as in v1").
    if cust in INTERNAL_HOUSE:
        return "H0_internal", "R1", False, INTERNAL_HOUSE[cust]
    if cust in DTC_HOUSE:
        return "leg3", "R2", False, DTC_HOUSE[cust]
    if cust in PEPPER_COHORT:
        return "leg2", "R3", False, PEPPER_COHORT[cust]
    if cust in MARKETPLACE_PROGRAM:
        return "leg4", "R4", False, MARKETPLACE_PROGRAM[cust]
    if cust in HOSPITALITY_DIRECT_SPEC:
        return "leg5", "R5", False, HOSPITALITY_DIRECT_SPEC[cust]
    if cust in MAKESIDE_NAMED:
        return "leg6", "R6", False, MAKESIDE_NAMED[cust]

    # spec #7: missing/blank branch on a doc not otherwise named-matched is a
    # SCHEMA FAILURE -> H9 loud, never a silent leg1 default via R8/R9.
    if not branch:
        return "H9_UNMAPPED", "R0_SCHEMA", tag, "FAIL-CLOSED: missing/blank branch on doc (schema failure)"

    # R7: branch rule, now PER-DOC (spec #1).
    if branch == MAKESIDE_BRANCH:
        return "leg6", "R7", False, "doc on the FERNCREST workroom branch"

    if cls in UNCLASSIFIED:
        return "H2_unclassified", "R8", tag, f"class = {cls or '(blank)'} — named fallback, never silent"
    if cls in TRADE_CLASSES:
        return "leg1", "R9", tag, f"existing trade book, class {cls}"
    # spec #4: a novel (unrecognized) class value falls through to fail-closed
    # H9 here — it never reaches this line if branch was FERNCREST (R7 already
    # returned above), which is exactly the "still routes leg6" carve-out.
    return "H9_UNMAPPED", "R10", tag, f"FAIL-CLOSED: no rule matched (class={cls!r})"


# ------------------------------------------------- #322 controls on the instrument, adapted to the doc-level API (spec #11)
def self_test():
    def mk(cust, cls, branch, ttype="Invoice", ref="TESTREF"):
        return {"ttype": ttype, "ref": ref, "name": "TEST",
                "cust": norm(cust), "cls": norm(cls), "branch": norm(branch), "net": 1.0}

    bad = mk("CZZZZZZ", "MARTIAN", "HERITAGE")
    b, r, _, _ = classify_doc(bad)
    assert b == "H9_UNMAPPED" and r == "R10", f"NEGATIVE CONTROL FAILED: {b}/{r}"

    good = mk("C000671", "JOBBER", "HERITAGE")
    b, r, t, _ = classify_doc(good)
    assert b == "leg1" and r == "R9" and t is False, f"POSITIVE CONTROL FAILED: {b}/{r}/{t}"

    dist = mk("C0FAKE1", "DISTRIBUTOR", "HERITAGE")
    b, r, _, _ = classify_doc(dist)
    assert b == "leg1" and r == "R9", f"SYNONYM CONTROL FAILED (post-migration name): {b}/{r}"

    contr = mk("C000039", "CONTRACTOR", "HERITAGE")
    b, r, _, _ = classify_doc(contr)
    assert b == "leg1" and r == "R9", f"D1 CONTROL FAILED (CONTRACTOR->leg1): {b}/{r}"

    fern = mk("C0FAKE2", "TBD", "FERNCREST")
    b, r, _, _ = classify_doc(fern)
    assert b == "leg6" and r == "R7", f"D2 BRANCH CONTROL FAILED (->leg6): {b}/{r}"

    tagged = mk("C000214", "JOBBER", "HERITAGE")
    b, r, t, _ = classify_doc(tagged)
    assert b == "leg1" and t is True, f"D3 TAG CONTROL FAILED (leg1+tag): {b}/{t}"

    # spec #11 new control: mixed-branch synthetic — same customer, two docs,
    # two branches -> the FERNCREST doc lands leg6, the HERITAGE doc lands leg1.
    mixed_fern = mk("C0MIXED1", "JOBBER", "FERNCREST", ref="REFA")
    mixed_her = mk("C0MIXED1", "JOBBER", "HERITAGE", ref="REFB")
    bf, rf, _, _ = classify_doc(mixed_fern)
    bh, rh, _, _ = classify_doc(mixed_her)
    assert bf == "leg6" and rf == "R7", f"MIXED-BRANCH CONTROL (FERNCREST leg) FAILED: {bf}/{rf}"
    assert bh == "leg1" and rh == "R9", f"MIXED-BRANCH CONTROL (HERITAGE leg) FAILED: {bh}/{rh}"

    # spec #11 new control: novel class "WORKROOM" on HERITAGE branch -> H9.
    novel = mk("C0NOVEL1", "WORKROOM", "HERITAGE")
    bn, rn, _, _ = classify_doc(novel)
    assert bn == "H9_UNMAPPED" and rn == "R10", f"NOVEL-CLASS CONTROL FAILED: {bn}/{rn}"

    # spec #7 control: missing/blank branch -> H9, never a silent leg1 default.
    blank_branch = mk("C0BLANK1", "JOBBER", "")
    bb, rb, _, _ = classify_doc(blank_branch)
    assert bb == "H9_UNMAPPED" and rb == "R0_SCHEMA", f"BLANK-BRANCH CONTROL FAILED: {bb}/{rb}"

    # v1.2 control: P/Kaufmann mixed-branch — C001574 on HERITAGE branch (not
    # FERNCREST) MUST still land leg6 via the NAMED rule R6, not fall through
    # to R8/R9/H2 — this is the whole point of naming a mixed-branch account
    # instead of leaving it to the R7 branch heuristic.
    pk_mixed = mk("C001574", "TBD", "HERITAGE")
    bpk, rpk, _, _ = classify_doc(pk_mixed)
    assert bpk == "leg6" and rpk == "R6", f"P/K MIXED-BRANCH CONTROL FAILED (want leg6/R6): {bpk}/{rpk}"

    print("CONTROLS (#322, doc-level): known-bad->H9/R10 OK | JOBBER->leg1 untagged OK | "
          "DISTRIBUTOR->leg1 OK | CONTRACTOR->leg1 (D1) OK | FERNCREST->leg6 (D2) OK | "
          "HORIZON->leg1+TAG (D3) OK | mixed-branch split (FERNCREST leg6 / HERITAGE leg1) OK | "
          "novel-class WORKROOM->H9 OK | blank-branch->H9/R0_SCHEMA OK | "
          "P/Kaufmann C001574 on HERITAGE->leg6/R6 named (not R7) OK")


def load_docs():
    with open(SRC) as f:
        rows = [json.loads(line) for line in f if line.strip()]

    for r in rows:
        r["cust"] = norm(r.get("cust"))
        r["cls"] = norm(r.get("cls"))
        r["branch"] = norm(r.get("branch"))

    # spec instruction: FIRST verify the JSONL total reconciles, before building anything.
    raw_total = round(sum(r["net"] for r in rows), 2)
    assert raw_total == EXPECTED_TOTAL, (
        f"RAW RECONCILE FAIL: jsonl net sum {raw_total} != expected {EXPECTED_TOTAL}"
    )
    print(f"RAW RECONCILE OK: {SRC.split(chr(47))[-1]} net sum {raw_total:,.2f} == "
          f"{EXPECTED_TOTAL:,.2f} ({len(rows)} line rows)")

    grouped = collections.OrderedDict()
    for r in rows:
        key = (r["type"], r["ref"])
        grouped.setdefault(key, []).append(r)

    docs = []
    for (ttype, ref), lines in grouped.items():
        custs = {l["cust"] for l in lines}
        assert len(custs) == 1, f"SCHEMA FAIL: doc {(ttype, ref)} spans multiple customers {custs}"
        clsvals = {l["cls"] for l in lines}
        assert len(clsvals) == 1, f"SCHEMA FAIL: doc {(ttype, ref)} spans multiple classes {clsvals}"
        branches = {l["branch"] for l in lines}
        assert len(branches) == 1, f"SCHEMA FAIL: doc {(ttype, ref)} spans multiple branches {branches}"
        names = {l.get("name") for l in lines}
        doc_net = round(sum(l["net"] for l in lines), 2)
        docs.append({
            "ttype": ttype,
            "ref": ref,
            "cust": custs.pop(),
            "cls": clsvals.pop(),
            "branch": branches.pop(),
            "name": names.pop() if len(names) == 1 else next(iter(names)),
            "net": doc_net,
            "nlines": len(lines),
        })
    return docs


# ------------------------------------------------------------- spec #4: class-vocabulary audit BEFORE classification
def class_vocabulary_audit(docs):
    allowed = TRADE_CLASSES | UNCLASSIFIED
    distinct = {d["cls"] for d in docs}
    novel = distinct - allowed
    if novel:
        print(f"\nNOVEL CLASS REPORT (spec #4): {sorted(novel)} present in the data, NOT in "
              f"TRADE_CLASSES ∪ UNCLASSIFIED — routed to H9 UNLESS the doc is also on the "
              f"FERNCREST branch (still leg6 there, but still reported here, never silently):")
        for v in sorted(novel):
            for d in docs:
                if d["cls"] == v:
                    print(f"    NOVEL cls={v!r} {d['cust']} {d['name']} {d['ttype']} {d['ref']} "
                          f"branch={d['branch']} net={d['net']:,.2f}")
    else:
        print(f"CLASS AUDIT OK (spec #4): {len(distinct)} distinct normalized classes, all ⊆ "
              f"TRADE_CLASSES ∪ UNCLASSIFIED — {sorted(distinct)}")
    return novel


# ------------------------------------------------------------- spec #10: candidate detector
def candidate_detector(docs, bucket_of):
    by_cust = collections.defaultdict(list)
    for d in docs:
        by_cust[d["cust"]].append(d)

    all_named = (set(INTERNAL_HOUSE) | set(DTC_HOUSE) | set(PEPPER_COHORT)
                 | set(MARKETPLACE_PROGRAM) | set(HOSPITALITY_DIRECT_SPEC) | set(MAKESIDE_NAMED))

    print("\nCANDIDATES (review monthly):")

    # (a) any Ferncrest-branch doc, customer not in MAKESIDE_NAMED, and NOT fully leg6.
    a_hits = []
    for cust, cdocs in by_cust.items():
        if cust in MAKESIDE_NAMED:
            continue
        fern_docs = [d for d in cdocs if d["branch"] == MAKESIDE_BRANCH]
        if not fern_docs:
            continue
        all_leg6 = all(bucket_of[(d["ttype"], d["ref"])] == "leg6" for d in cdocs)
        if not all_leg6:
            a_hits.append((cust, cdocs[0]["name"], len(fern_docs), len(cdocs)))
    if a_hits:
        for cust, name, nfern, ntotal in sorted(a_hits):
            print(f"  (a) {cust:<9}{name:<42}{nfern}/{ntotal} docs on FERNCREST, NOT fully leg6 — review split")
    else:
        print("  (a) none — no Ferncrest-branch customer this month splits across buckets "
              "(0 mixed-branch customers; every Ferncrest doc's customer routes fully leg6)")

    # (b) reference-series anomalies: non-standard ref prefix, customer not in MAKESIDE_NAMED.
    standard = ("INV", "CREDIT", "CASH", "DM", "CM")
    b_hits = collections.defaultdict(set)
    b_names = {}
    for d in docs:
        if d["cust"] in MAKESIDE_NAMED:
            continue
        m = re.match(r"^([A-Za-z]+)", d["ref"] or "")
        prefix = m.group(1).upper() if m else "(none)"
        if prefix not in standard:
            b_hits[d["cust"]].add(prefix)
            b_names[d["cust"]] = d["name"]
    if b_hits:
        for cust, prefixes in sorted(b_hits.items()):
            print(f"  (b) {cust:<9}{b_names[cust]:<42}non-standard ref prefix(es): {sorted(prefixes)}")
    else:
        print("  (b) none — no non-standard reference-series prefixes outside MAKESIDE_NAMED "
              "(the only dedicated series found, MDINV-, belongs solely to the already-named "
              "Medline account)")

    # (c) month net > 10000, class MFG or TBD, no named list, not tagged.
    c_hits = []
    for cust, cdocs in by_cust.items():
        if cust in all_named or cust in MAKER_SHAPED_TAG:
            continue
        clsvals = {d["cls"] for d in cdocs}
        cls_ = clsvals.pop() if len(clsvals) == 1 else "/".join(sorted(clsvals))
        month_net = round(sum(d["net"] for d in cdocs), 2)
        if month_net > 10000 and cls_ in ("MFG", "TBD"):
            c_hits.append((cust, cdocs[0]["name"], cls_, month_net))
    if c_hits:
        for cust, name, cls_, month_net in sorted(c_hits, key=lambda x: -x[3]):
            print(f"  (c) {cust:<9}{name:<42}class={cls_:<5}month net {month_net:>12,.2f} "
                  f"— unnamed/untagged future leg2/leg6 candidate")
    else:
        print("  (c) none — no unnamed, untagged customer clears $10,000 net this month in "
              "class MFG or TBD")

    # (d) PENDING-PROGRAM watch (D4): a Kevin-pre-named pipeline program's AR account
    # was born — flag for conversion to a customer-ID entry in MARKETPLACE_PROGRAM.
    # Name-token match is a REVIEW flag, never a routing rule (#420: display values
    # are views, not keys — routing happens only via the customer-ID named lists).
    d_hits = []
    for cust, cdocs in by_cust.items():
        if cust in all_named:
            continue
        cname = (cdocs[0]["name"] or "").upper()
        for token, note in PENDING_PROGRAMS.items():
            if re.search(r"\b" + re.escape(token), cname):
                d_hits.append((cust, cdocs[0]["name"], token))
    if d_hits:
        for cust, name, token in sorted(d_hits):
            print(f"  (d) {cust:<9}{name:<42}PENDING PROGRAM '{token}' APPEARED — convert to "
                  f"MARKETPLACE_PROGRAM customer-ID entry (seat action)")
    else:
        pend = ", ".join(sorted(PENDING_PROGRAMS)) or "(none)"
        print(f"  (d) none — no pending-program account born yet (watching: {pend})")

    return a_hits, b_hits, c_hits


def main():
    self_test()
    disjointness_check()
    tag_ratification_check()

    docs = load_docs()
    novel_classes = class_vocabulary_audit(docs)

    agg = collections.defaultdict(lambda: {"net": 0.0, "docs": 0, "members": []})
    tag_agg = {"net": 0.0, "docs": 0, "members": []}
    rule_hits = collections.Counter()
    bucket_of = {}

    for d in docs:
        bucket, rule, tag, note = classify_doc(d)
        bucket_of[(d["ttype"], d["ref"])] = bucket
        a = agg[bucket]
        a["net"] += d["net"]
        a["docs"] += 1
        a["members"].append({**d, "rule": rule, "tag": tag, "note": note})
        rule_hits[rule] += 1
        if tag:
            tag_agg["net"] += d["net"]
            tag_agg["docs"] += 1
            tag_agg["members"].append(d)

    order = ["leg1", "leg2", "leg3", "leg4", "leg5", "leg6",
             "H2_unclassified", "H0_internal", "H9_UNMAPPED"]
    label = {
        "leg1": "Leg 1 — Core designer trade (existing engine)",
        "leg2": "Leg 2 — Maker/brand NEW-MOTION cohort (D3: starts empty)",
        "leg3": "Leg 3 — Own DTC (named settlement accounts)",
        "leg4": "Leg 4 — Retail/marketplace programs (named)",
        "leg5": "Leg 5 — Hospitality/contract direct spec (named; empty)",
        "leg6": "Leg 6 — Make-side / contract manufacturing (D2 RULED)",
        "H2_unclassified": "H2 — HOLD: unclassified class (TBD/blank; D6)",
        "H0_internal": "H0 — internal / house / intercompany",
        "H9_UNMAPPED": "H9 — UNMAPPED (fail-closed; must be 0.00)",
    }

    # spec #9: percentages come from the ACTUAL runtime total, not EXPECTED_TOTAL.
    total = round(sum(agg[k]["net"] for k in order), 2)
    total_docs = sum(agg[k]["docs"] for k in order)
    total_custs = len({d["cust"] for d in docs})  # spec #12: dedup across ALL buckets, counts once.

    def gross_abs(members):
        return round(sum(abs(m["net"]) for m in members), 2)

    print()
    print(f"{'BUCKET (ruleset v1.1, doc-level)':<58}{'NET USD':>14}{'DOCS':>7}{'CUSTS':>7}{'% MO':>8}")
    print("-" * 94)
    for k in order:
        a = agg.get(k, {"net": 0.0, "docs": 0, "members": []})
        custs_in_bucket = len({m["cust"] for m in a["members"]})
        pct = (a["net"] / total * 100) if total else 0.0
        print(f"{label[k]:<58}{a['net']:>14,.2f}{a['docs']:>7}{custs_in_bucket:>7}{pct:>7.1f}%")
    print("-" * 94)
    print(f"{'TOTAL':<58}{total:>14,.2f}{total_docs:>7}{total_custs:>7}{100.0:>7.1f}%")

    # ---- spec #5: H9 hardened fail-closed — docs==0 AND custs==0 AND gross(sum abs)==0.00.
    h9 = agg.get("H9_UNMAPPED", {"net": 0.0, "docs": 0, "members": []})
    h9_custs = len({m["cust"] for m in h9["members"]})
    h9_gross = gross_abs(h9["members"])
    assert h9["docs"] == 0 and h9_custs == 0 and h9_gross == 0.00, (
        f"H9 HARDENED FAIL: docs={h9['docs']} custs={h9_custs} gross_abs={h9_gross} "
        f"(net alone was {h9['net']:.2f} — this check is stronger than a net-only zero check)"
    )
    print(f"\nH9 HARDENED (spec #5): docs=0 AND custs=0 AND gross(abs)=0.00 — fail-closed instrument OK")

    # ---- spec #6: H2 materiality gate.
    h2 = agg.get("H2_unclassified", {"net": 0.0, "docs": 0, "members": []})
    h2_gross = gross_abs(h2["members"])
    if h2_gross > H2_ABS_LIMIT:
        print(f"\nH2 MATERIALITY BREACH: gross(abs) {h2_gross:,.2f} > H2_ABS_LIMIT {H2_ABS_LIMIT:,.2f} "
              f"({h2['docs']} docs, {len({m['cust'] for m in h2['members']})} customers)")
        sys.exit(1)
    print(f"H2 MATERIALITY GATE (spec #6): gross(abs) {h2_gross:,.2f} <= limit {H2_ABS_LIMIT:,.2f} OK")

    # ---- spec #8: every tagged customer's docs land in leg1, else loud failure naming the account.
    for d in docs:
        if d["cust"] in MAKER_SHAPED_TAG:
            b = bucket_of[(d["ttype"], d["ref"])]
            assert b == "leg1", (
                f"TAG-OUTSIDE-LEG1 FAIL: {d['cust']} ({MAKER_SHAPED_TAG[d['cust']]}) doc "
                f"{d['ttype']}/{d['ref']} landed in {b}, not leg1"
            )
    leg1_tag_members = [m for m in agg["leg1"]["members"] if m["tag"]]
    assert {m["cust"] for m in leg1_tag_members} == {m["cust"] for m in tag_agg["members"]}, (
        "TAG REPORT MISMATCH: tag_agg diverges from leg1-sourced tag members"
    )
    tag_custs = len({m["cust"] for m in leg1_tag_members})
    assert tag_custs <= 6, "TAG SET LARGER THAN RATIFIED SIX"
    print(f"TAG-IN-LEG1 (spec #8): all {tag_custs} tagged accounts' docs verified inside leg1 OK; "
          f"tag report below is sourced from leg1 members only")

    # spec #12 reconcile echoes (kept from v1's style, now against the runtime total).
    assert round(total, 2) == EXPECTED_TOTAL, f"RECONCILE FAIL: {round(total, 2)} != {EXPECTED_TOTAL}"
    assert total_docs == 950, f"DOC-COUNT FAIL: {total_docs}"
    assert total_custs == 217, f"POPULATION FAIL: {total_custs}"
    print(f"\nRECONCILE OK: sum = {round(total, 2)} == {EXPECTED_TOTAL} | 217/217 custs (deduped "
          f"across buckets) | 950/950 docs | unmapped 0.00")
    print(f"RULE HITS (doc-level; v1's were per-customer, so magnitudes differ by design): "
          f"{dict(sorted(rule_hits.items()))}")

    # D3 tag report (reporting dimension inside leg 1) — read from leg1 members only (spec #8).
    print(f"\n### MAKER-SHAPED TAG (inside leg 1) — net {tag_agg['net']:,.2f} | "
          f"{tag_custs}/6 tagged accounts billed | {tag_agg['docs']} docs "
          f"| x12 ~ {tag_agg['net'] * 12 / 1e3:,.0f}K/yr (single-month extrapolation marker)")
    tag_by_cust = collections.defaultdict(lambda: {"net": 0.0, "docs": 0, "name": ""})
    for m in leg1_tag_members:
        t = tag_by_cust[m["cust"]]
        t["net"] += m["net"]; t["docs"] += 1; t["name"] = m["name"]
    for cust, t in sorted(tag_by_cust.items(), key=lambda kv: -abs(kv[1]["net"])):
        print(f"    TAG {cust:<9}{t['net']:>13,.2f}  {t['name']}")

    # Per-bucket member listings, aggregated to customer grain within the bucket (mirrors v1's style).
    for k in order:
        a = agg.get(k)
        if not a or not a["members"]:
            print(f"\n### {label[k]} — EMPTY (net 0.00, 0 customers)")
            continue
        by_cust_in_bucket = collections.defaultdict(lambda: {"net": 0.0, "docs": 0, "name": "", "cls": "", "rules": set()})
        for m in a["members"]:
            c = by_cust_in_bucket[m["cust"]]
            c["net"] += m["net"]; c["docs"] += 1; c["name"] = m["name"]; c["cls"] = m["cls"]; c["rules"].add(m["rule"])
        rows_sorted = sorted(by_cust_in_bucket.items(), key=lambda kv: -abs(kv[1]["net"]))
        print(f"\n### {label[k]} — net {a['net']:,.2f} | {len(by_cust_in_bucket)} customers | {a['docs']} docs")
        for cust, c in rows_sorted[:8]:
            rule_str = "/".join(sorted(c["rules"]))
            print(f"    {rule_str:<10}{cust:<9}{(c['cls'] or ''):<11}{c['net']:>13,.2f} "
                  f" {c['name']}  ({c['docs']} docs)")
        if len(rows_sorted) > 8:
            tail = sum(c["net"] for _, c in rows_sorted[8:])
            print(f"    ...  + {len(rows_sorted) - 8} more customers      {tail:>13,.2f}")

    # ---- Candidate detector (spec #10) — printed every run.
    candidate_detector(docs, bucket_of)

    # Remaining-open sensitivities (D1/D2/D3 are RULED — no longer scenarios) — mirrors v1.
    print(f"\nOPEN-RULING SENSITIVITIES (D4-D7):")
    aw = [m for m in agg["leg1"]["members"] if m["cust"] in ("C000237", "C000849")]
    aw_by_cust = collections.defaultdict(float)
    for m in aw:
        aw_by_cust[m["cust"]] += m["net"]
    aw_net = sum(aw_by_cust.values())
    print(f"  - D5: hospitality-SHAPED names deliberately in leg 1 (Atlantic Hospitality, "
          f"Wulff's Contract Furniture) = {aw_net:,.2f}; move only by NAMED spec-list ruling.")
    h2_custs_n = len({m["cust"] for m in h2["members"]})
    print(f"  - D6: H2 hold = {h2['net']:,.2f} across {h2_custs_n} customers awaiting CS class assignment.")
    print(f"  - D7: leg 3 measured by NAMED settlement accounts (rule as drafted; "
          f"Kevin confirm pending) — decides where Oct-17 storefront revenue lands.")

    # ---- spec #12: JULY EQUALITY REGRESSION GATE (load-bearing) — compare against v1 exactly.
    print(f"\nJULY EQUALITY REGRESSION GATE (spec #12) — doc-level vs v1 customer-level, bucket NET:")
    mismatches = []
    for k in order:
        v11_net = round(agg.get(k, {"net": 0.0})["net"], 2)
        v1_net = V1_JULY_NET[k]
        status = "OK" if v11_net == v1_net else "MISMATCH"
        if status == "MISMATCH":
            mismatches.append((k, v1_net, v11_net))
        print(f"    {label[k]:<58}v1={v1_net:>12,.2f}  v1.1={v11_net:>12,.2f}  {status}")
    if round(total, 2) != V1_JULY_TOTAL:
        mismatches.append(("TOTAL", V1_JULY_TOTAL, round(total, 2)))
    if total_docs != V1_JULY_DOCS:
        mismatches.append(("DOCS", V1_JULY_DOCS, total_docs))
    if total_custs != V1_JULY_CUSTS:
        mismatches.append(("CUSTS", V1_JULY_CUSTS, total_custs))

    if mismatches:
        print("\nJULY EQUALITY GATE: FAILED — doc-level classification did NOT numerically no-op "
              "against v1. STOPPING per instruction; NOT adjusting data or expected constants. "
              "Discrepancies:")
        for name, expected, actual in mismatches:
            print(f"    {name}: v1={expected} vs v1.1={actual}  delta={round(actual - expected, 2)}")
        sys.exit(1)
    print(f"\nJULY EQUALITY GATE: PASSED — every bucket NET, TOTAL, DOCS (950), and distinct "
          f"CUSTS (217) match v1 exactly. Doc-level hardening is a proven numeric no-op for "
          f"July (no mixed-branch or novel-class cases exist in this month's data); the "
          f"hardening changes NOTHING about July's answer and only changes future-month behavior.")


if __name__ == "__main__":
    main()
