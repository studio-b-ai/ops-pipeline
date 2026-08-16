import { describe, expect, it } from "vitest";
import {
  classify,
  render,
  LABEL,
  RULE_17_REMEDY,
  FINDING_CLASSES,
  type ClassifyInput,
  type Finding,
  type IssueInput,
  type Thresholds,
} from "../backlog-staleness-lib.js";

// ───────────────────────────── fixtures (Rule #256 — every "now" pinned, never the real clock) ─────────────────────────────

const NOW = "2026-08-16T12:00:00Z";
const REPO = "studio-b-ai/example";
const MANAGER = "CTO";
const THRESHOLDS: Thresholds = { p0p1_days: 2, p2_days: 14, unranked_days: 3 };
const MACHINERY_LABELS = ["bug", "dead-cron", "needs-human", "backlog-staleness", "credential-monitor"];
const ALL_P_LABELS = ["P0", "P1", "P2", "P3"];

function daysAgo(n: number): string {
  return new Date(new Date(NOW).getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

function issue(overrides: Partial<IssueInput> = {}): IssueInput {
  return {
    number: 1,
    title: "Example issue",
    labels: [],
    updatedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

function run(issues: IssueInput[], repoLabels: string[] = ALL_P_LABELS, overrides: Partial<ClassifyInput> = {}): Finding[] {
  return classify({
    repo: REPO,
    manager: MANAGER,
    now: NOW,
    issues,
    thresholds: THRESHOLDS,
    machineryLabels: MACHINERY_LABELS,
    repoLabels,
    ...overrides,
  });
}

// ───────────────────────────── classify — p0p1-stale ─────────────────────────────

describe("classify — p0p1-stale", () => {
  // Negative control first (Rule #322).
  it("does NOT flag a fresh P1", () => {
    const findings = run([issue({ number: 1, labels: ["P1"], updatedAt: daysAgo(1) })]);
    expect(findings.filter((f) => f.class === "p0p1-stale")).toHaveLength(0);
  });

  it("does NOT flag exactly AT the threshold (strictly greater-than, per the issue's own '> 2 days' wording)", () => {
    const findings = run([issue({ number: 2, labels: ["P1"], updatedAt: daysAgo(2) })]);
    expect(findings.filter((f) => f.class === "p0p1-stale")).toHaveLength(0);
  });

  it("flags a P1 untouched beyond the threshold", () => {
    const findings = run([issue({ number: 3, labels: ["P1"], updatedAt: daysAgo(5), title: "Stale P1" })]);
    const f = findings.find((x) => x.class === "p0p1-stale");
    expect(f).toBeDefined();
    expect(f!.issue).toBe(3);
    expect(f!.repo).toBe(REPO);
    expect(f!.manager).toBe(MANAGER);
    expect(f!.daysIdle).toBe(5);
    expect(f!.remedy).toBe(RULE_17_REMEDY);
    expect(f!.detail).toContain("5d");
  });

  it("flags a P0 the same way as P1", () => {
    const findings = run([issue({ number: 4, labels: ["P0"], updatedAt: daysAgo(3) })]);
    expect(findings.some((f) => f.class === "p0p1-stale" && f.issue === 4)).toBe(true);
  });
});

// ───────────────────────────── classify — p2-stale ─────────────────────────────

describe("classify — p2-stale", () => {
  it("does NOT flag a fresh P2", () => {
    const findings = run([issue({ number: 10, labels: ["P2"], updatedAt: daysAgo(10) })]);
    expect(findings.filter((f) => f.class === "p2-stale")).toHaveLength(0);
  });

  it("does NOT flag exactly at the 14-day threshold", () => {
    const findings = run([issue({ number: 11, labels: ["P2"], updatedAt: daysAgo(14) })]);
    expect(findings.filter((f) => f.class === "p2-stale")).toHaveLength(0);
  });

  it("flags a P2 untouched beyond the threshold", () => {
    const findings = run([issue({ number: 12, labels: ["P2"], updatedAt: daysAgo(20) })]);
    const f = findings.find((x) => x.class === "p2-stale");
    expect(f).toBeDefined();
    expect(f!.issue).toBe(12);
    expect(f!.daysIdle).toBe(20);
  });

  // A P1 issue that happens to also be old is p0p1-stale territory, not p2-stale — the two
  // classes are keyed strictly off which label is present.
  it("a stale P1 does NOT also read as p2-stale", () => {
    const findings = run([issue({ number: 13, labels: ["P1"], updatedAt: daysAgo(20) })]);
    expect(findings.filter((f) => f.issue === 13 && f.class === "p2-stale")).toHaveLength(0);
  });
});

// ───────────────────────────── classify — unranked ─────────────────────────────

describe("classify — unranked", () => {
  it("does NOT flag a fresh unranked issue", () => {
    const findings = run([issue({ number: 20, labels: [], createdAt: daysAgo(1) })]);
    expect(findings.filter((f) => f.class === "unranked")).toHaveLength(0);
  });

  it("does NOT flag exactly at the 3-day threshold", () => {
    const findings = run([issue({ number: 21, labels: [], createdAt: daysAgo(3) })]);
    expect(findings.filter((f) => f.class === "unranked")).toHaveLength(0);
  });

  it("flags an old unranked issue", () => {
    const findings = run([issue({ number: 22, labels: [], createdAt: daysAgo(10) })]);
    const f = findings.find((x) => x.class === "unranked");
    expect(f).toBeDefined();
    expect(f!.issue).toBe(22);
    expect(f!.daysIdle).toBe(10);
    expect(f!.detail).toContain("rule 17a");
  });

  // THE machinery-exclusion rule, verbatim from backlog-managers.yaml: "excluded only if it
  // has a machinery label AND no P0–P3 label."
  it("does NOT flag an old issue carrying ONLY a machinery label (excluded — not lane backlog)", () => {
    const findings = run([issue({ number: 23, labels: ["bug"], createdAt: daysAgo(30) })]);
    expect(findings.filter((f) => f.issue === 23)).toHaveLength(0);
  });

  // THE regression this predicate exists to prevent: a machinery label must NOT blanket-exempt
  // an issue a human has since ranked. ops-pipeline#56/#57 (credential-monitor + P1) are the
  // live-verified real-world instance of exactly this shape.
  it("a machinery-labeled issue that ALSO carries a P-label counts as ranked (NOT excluded, NOT unranked, eligible for its P-class staleness check)", () => {
    const findings = run([issue({ number: 24, labels: ["credential-monitor", "P1"], updatedAt: daysAgo(5), createdAt: daysAgo(20) })]);
    expect(findings.some((f) => f.issue === 24 && f.class === "unranked")).toBe(false);
    expect(findings.some((f) => f.issue === 24 && f.class === "p0p1-stale")).toBe(true);
  });
});

// ───────────────────────────── classify — headless ─────────────────────────────

describe("classify — headless", () => {
  it("does NOT flag when a next exists among ranked issues", () => {
    const findings = run([
      issue({ number: 30, labels: ["P1", "next"], updatedAt: daysAgo(1) }),
      issue({ number: 31, labels: ["P2"], updatedAt: daysAgo(1) }),
    ]);
    expect(findings.filter((f) => f.class === "headless")).toHaveLength(0);
  });

  it("does NOT flag when there are zero ranked issues at all (nothing to lead)", () => {
    const findings = run([issue({ number: 32, labels: [], createdAt: daysAgo(1) })]);
    expect(findings.filter((f) => f.class === "headless")).toHaveLength(0);
  });

  it("flags a repo with ranked issues but zero next — a repo-level finding (issue: null)", () => {
    const findings = run([
      issue({ number: 33, labels: ["P1"], updatedAt: daysAgo(1) }),
      issue({ number: 34, labels: ["P2"], updatedAt: daysAgo(1) }),
    ]);
    const f = findings.find((x) => x.class === "headless");
    expect(f).toBeDefined();
    expect(f!.issue).toBeNull();
    expect(f!.daysIdle).toBeNull();
    expect(f!.detail).toContain("2 ranked");
    expect(f!.remedy).toBe(RULE_17_REMEDY);
  });

  // A machinery-excluded ranked-looking issue (no P-label) must not count toward "ranked" for
  // this check either — it was never rankable in the first place.
  it("a repo whose only P-labeled issue is machinery-excluded... is impossible by construction (excluded issues never carry an unexcluded P-label) — sanity: a real ranked issue alone still flags", () => {
    const findings = run([issue({ number: 35, labels: ["P3"], updatedAt: daysAgo(1) })]);
    expect(findings.some((f) => f.class === "headless")).toBe(true);
  });
});

// ───────────────────────────── classify — multi-next ─────────────────────────────

describe("classify — multi-next", () => {
  it("does NOT flag a single next", () => {
    const findings = run([issue({ number: 40, labels: ["P1", "next"], updatedAt: daysAgo(1) })]);
    expect(findings.filter((f) => f.class === "multi-next")).toHaveLength(0);
  });

  it("does NOT flag zero next issues", () => {
    const findings = run([issue({ number: 41, labels: ["P1"], updatedAt: daysAgo(1) })]);
    expect(findings.filter((f) => f.class === "multi-next")).toHaveLength(0);
  });

  it("flags EVERY next-labeled issue when more than one carries next, each naming its siblings", () => {
    const findings = run([
      issue({ number: 42, labels: ["P1", "next"], updatedAt: daysAgo(1) }),
      issue({ number: 43, labels: ["P2", "next"], updatedAt: daysAgo(1) }),
      issue({ number: 44, labels: ["P3", "next"], updatedAt: daysAgo(1) }),
    ]);
    const multi = findings.filter((f) => f.class === "multi-next");
    expect(multi).toHaveLength(3);
    expect(multi.map((f) => f.issue).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([42, 43, 44]);
    const f42 = multi.find((f) => f.issue === 42)!;
    expect(f42.detail).toContain("#42");
    expect(f42.detail).toContain("#43");
    expect(f42.detail).toContain("#44");
  });
});

// ───────────────────────────── classify — labels-missing ─────────────────────────────

describe("classify — labels-missing", () => {
  it("does NOT flag when P0-P3 labels exist in the repo", () => {
    const findings = run([issue({ number: 50, labels: [], createdAt: daysAgo(1) })], ALL_P_LABELS);
    expect(findings.filter((f) => f.class === "labels-missing")).toHaveLength(0);
  });

  it("does NOT flag a repo with zero open issues even when P0-P3 are absent (nothing to rank yet)", () => {
    const findings = run([], []);
    expect(findings.filter((f) => f.class === "labels-missing")).toHaveLength(0);
  });

  it("flags a repo with open issues but none of P0-P3 defined as labels at all — repo-level (issue: null)", () => {
    const findings = run([issue({ number: 51, labels: [], createdAt: daysAgo(1) })], ["bug", "enhancement"]);
    const f = findings.find((x) => x.class === "labels-missing");
    expect(f).toBeDefined();
    expect(f!.issue).toBeNull();
    expect(f!.daysIdle).toBeNull();
    expect(f!.detail).toContain("1 open issue");
  });

  it("reports labels-missing exactly ONCE even with multiple open issues", () => {
    const findings = run(
      [issue({ number: 52, createdAt: daysAgo(1) }), issue({ number: 53, createdAt: daysAgo(1) }), issue({ number: 54, createdAt: daysAgo(1) })],
      [],
    );
    expect(findings.filter((f) => f.class === "labels-missing")).toHaveLength(1);
  });

  // Even ONE of P0-P3 existing (however unused) is enough to NOT trip this — the check is
  // "do any exist", not "are they all defined".
  it("does NOT flag when only ONE of P0-P3 exists in the repo", () => {
    const findings = run([issue({ number: 55, createdAt: daysAgo(1) })], ["P2"]);
    expect(findings.filter((f) => f.class === "labels-missing")).toHaveLength(0);
  });
});

// ───────────────────────────── classify — determinism ─────────────────────────────

describe("classify — deterministic ordering", () => {
  it("re-running classify on identical inputs produces an identical (deep-equal) result", () => {
    const issues = [
      issue({ number: 3, labels: ["P1"], updatedAt: daysAgo(5) }),
      issue({ number: 1, labels: ["P2"], updatedAt: daysAgo(20) }),
      issue({ number: 2, labels: [], createdAt: daysAgo(10) }),
    ];
    expect(run(issues)).toEqual(run(issues));
  });

  it("groups findings in FINDING_CLASSES order regardless of input array order", () => {
    const issues = [
      issue({ number: 5, labels: [], createdAt: daysAgo(10) }), // unranked
      issue({ number: 1, labels: ["P1", "next"], updatedAt: daysAgo(5) }), // p0p1-stale (carries next so headless doesn't also fire — kept out of this ordering test on purpose)
      issue({ number: 3, labels: ["P2"], updatedAt: daysAgo(20) }), // p2-stale
    ];
    const findings = run(issues);
    const classOrder = findings.map((f) => f.class);
    expect(classOrder).toEqual(["p0p1-stale", "p2-stale", "unranked"]);
  });
});

// ───────────────────────────── render ─────────────────────────────

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    class: "p0p1-stale",
    repo: REPO,
    manager: MANAGER,
    issue: 5,
    title: "Fix the thing",
    labels: ["P1"],
    daysIdle: 5,
    detail: "P0/P1 issue untouched for 5d since its last update (> 2d threshold).",
    remedy: RULE_17_REMEDY,
    ...overrides,
  };
}

describe("render", () => {
  it("title format is exactly '[backlog-staleness] <manager> — N findings'", () => {
    const { title } = render({ manager: "CTO", now: NOW, thresholds: THRESHOLDS, findings: [finding()] });
    expect(title).toBe(`[${LABEL}] CTO — 1 findings`);
  });

  it("title counts across ALL findings passed in, not just one repo", () => {
    const { title } = render({
      manager: "CTO",
      now: NOW,
      thresholds: THRESHOLDS,
      findings: [finding({ issue: 1 }), finding({ issue: 2, repo: "studio-b-ai/other" })],
    });
    expect(title).toBe(`[${LABEL}] CTO — 2 findings`);
  });

  it("body renders one table row per finding: issue link, labels, days idle, class, and the rule-17 remedy", () => {
    const { body } = render({ manager: "CTO", now: NOW, thresholds: THRESHOLDS, findings: [finding()] });
    expect(body).toContain("### studio-b-ai/example");
    expect(body).toContain("[#5](https://github.com/studio-b-ai/example/issues/5)");
    expect(body).toContain("| [#5](https://github.com/studio-b-ai/example/issues/5) | P1 | 5 | p0p1-stale | " + RULE_17_REMEDY + " |");
  });

  it("groups findings under a per-repo heading when a manager owns findings across multiple repos", () => {
    const { body } = render({
      manager: "CTO",
      now: NOW,
      thresholds: THRESHOLDS,
      findings: [finding({ issue: 1, repo: "studio-b-ai/zzz" }), finding({ issue: 2, repo: "studio-b-ai/aaa" })],
    });
    const aaaIdx = body.indexOf("### studio-b-ai/aaa");
    const zzzIdx = body.indexOf("### studio-b-ai/zzz");
    expect(aaaIdx).toBeGreaterThan(-1);
    expect(zzzIdx).toBeGreaterThan(-1);
    expect(aaaIdx).toBeLessThan(zzzIdx); // alphabetical
  });

  it("a repo-level finding (issue: null) renders an em-dash in the Issue column, not a broken link", () => {
    const { body } = render({
      manager: "CTO",
      now: NOW,
      thresholds: THRESHOLDS,
      findings: [finding({ class: "headless", issue: null, title: null, labels: [], daysIdle: null, detail: "2 ranked open issue(s) but none carries `next`." })],
    });
    expect(body).toContain("| — | — | — | headless | " + RULE_17_REMEDY + " |");
  });

  it("footer names the run time and all three thresholds", () => {
    const { body } = render({ manager: "CTO", now: NOW, thresholds: THRESHOLDS, findings: [] });
    expect(body).toContain(NOW);
    expect(body).toContain("> 2d");
    expect(body).toContain("> 14d");
    expect(body).toContain("> 3d");
  });

  it("renders a clean 0-findings body with no table and the '0 findings' title", () => {
    const { title, body } = render({ manager: "CTO", now: NOW, thresholds: THRESHOLDS, findings: [] });
    expect(title).toBe(`[${LABEL}] CTO — 0 findings`);
    expect(body).not.toContain("|");
    expect(body).toContain("No findings this run");
  });

  it("never claims to re-label, re-rank, or close the finding's OWN issue (flags-only law)", () => {
    const { body } = render({ manager: "CTO", now: NOW, thresholds: THRESHOLDS, findings: [finding()] });
    expect(body).toContain("flags-only");
    expect(body).toContain("never re-labels, re-ranks, or closes");
  });
});

// Guard against re-introducing a hidden clock read — this file's own contract (see the module
// header) is that NOTHING in backlog-staleness-lib.ts reads `Date.now()`/`new Date()` with no
// argument. A grep-based check belongs in the ship gate (Rule #4/#464), but a fast in-suite
// canary catches it too: every `daysIdle` in this whole test file is derived from the FIXED
// `NOW`/`daysAgo()` fixtures above, never a real timestamp — if the lib ever started reading
// the real clock, at least the boundary tests above (`exactly AT the threshold`) would start
// flaking under CI run-to-run timing, which is itself a signal to re-check this file's header.
describe("FINDING_CLASSES", () => {
  it("exports exactly the six documented classes", () => {
    expect([...FINDING_CLASSES].sort()).toEqual(
      ["headless", "labels-missing", "multi-next", "p0p1-stale", "p2-stale", "unranked"].sort(),
    );
  });
});
