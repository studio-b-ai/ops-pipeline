import { describe, expect, it } from "vitest";
import {
  CONFLICT_HOURS,
  DOOR_ONLY_FALLBACK_MANAGER,
  STALE_DAYS,
  STALE_PR_CLASSES,
  MAX_UNKNOWN_MERGEABLE,
  classifyPr,
  classifyPrs,
  isMergeabilityUnresolved,
  planStalePrAction,
  renderStalePrIssueBody,
  resolveSweepPopulation,
  summarizeStalePr,
  type BacklogManagerRow,
  type DoorRegistryRow,
  type Mergeable,
  type MergeStateStatus,
  type PrInput,
  type StalePrFinding,
} from "../stale-pr-classify.js";

// ───────────────────────────── fixtures ─────────────────────────────

/**
 * Pinned clock (Rule #256 — never hardcode "today"; the lib is pure and takes `now`,
 * so every assertion here is deterministic forever).
 */
const NOW = "2026-09-13T12:00:00Z";

function daysAgo(n: number): string {
  return new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
}

function hoursAgo(n: number): string {
  return new Date(Date.parse(NOW) - n * 3_600_000).toISOString();
}

function pr(overrides: Partial<PrInput> = {}): PrInput {
  return {
    repo: "studio-b-ai/ops-pipeline",
    number: 405,
    title: "release door: widen the queued leg",
    url: "https://github.com/studio-b-ai/ops-pipeline/pull/405",
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    isDraft: false,
    ...overrides,
  };
}

// ──────────────── unresolved mergeability is a FAILED READ, not a clean result ────────────────

/**
 * Regression guard for the live defect found 2026-09-13 while proving this leg's first
 * firing (#464): GitHub computes `mergeable` lazily, so a COLD `gh pr list` page reports
 * UNKNOWN for every row. `classifyPr` reads UNKNOWN as not-conflicting, so the sweep
 * reported `brain: 18 open PR(s) -> 0 findings` while the same query moments later showed
 * 7 CONFLICTING (#160 at 308h, #221, #225, #230, #242, #252, #270). Worse, that zero drives
 * `planStalePrAction(0, true) === "close"` — a cold read would auto-close the repo's live
 * issue, which is exactly what the worker's step-4 contract forbids (#465).
 */
describe("isMergeabilityUnresolved", () => {
  it("is zero-tolerance by contract — GitHub resolves a whole page at once", () => {
    expect(MAX_UNKNOWN_MERGEABLE).toBe(0);
  });

  // #322 positive control: the instrument must also see a known-GOOD (a warm page).
  it("accepts a fully-resolved page (known-good must PASS, #322/#471)", () => {
    const warm = [
      pr({ number: 160, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
      pr({ number: 253, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
    ];
    expect(isMergeabilityUnresolved(warm)).toBe(false);
  });

  // #322 negative control: it must REJECT the known-bad cold page.
  it("rejects the all-UNKNOWN cold page that produced the live blind zero (known-bad must FIRE)", () => {
    const cold = [160, 221, 225, 230, 242, 252, 270].map((number) =>
      pr({ number, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", createdAt: daysAgo(13), updatedAt: hoursAgo(6) }),
    );
    expect(isMergeabilityUnresolved(cold)).toBe(true);
    // The whole point: classification against that page looks perfectly healthy.
    expect(classifyPrs(cold, NOW)).toHaveLength(0);
    // ...and a healthy zero on an existing issue means CLOSE. Hence read-failure routing.
    expect(planStalePrAction(0, true)).toBe("close");
  });

  it("rejects a page where only ONE row is unresolved (a partial page is still a cold page)", () => {
    expect(
      isMergeabilityUnresolved([
        pr({ number: 1, mergeable: "MERGEABLE" }),
        pr({ number: 2, mergeable: "MERGEABLE" }),
        pr({ number: 3, mergeable: "UNKNOWN" }),
      ]),
    ).toBe(true);
  });

  it("ignores drafts — they are excluded from classification, so their mergeability is irrelevant", () => {
    expect(
      isMergeabilityUnresolved([
        pr({ number: 1, mergeable: "MERGEABLE" }),
        pr({ number: 2, mergeable: "UNKNOWN", isDraft: true }),
      ]),
    ).toBe(false);
  });

  it("accepts an empty page — a repo with zero open PRs is honestly clean, not unresolved", () => {
    expect(isMergeabilityUnresolved([])).toBe(false);
  });

  it("accepts a draft-only page (no classifiable row can be blind)", () => {
    expect(isMergeabilityUnresolved([pr({ mergeable: "UNKNOWN", isDraft: true })])).toBe(false);
  });

  it("proves the warm read would have caught the real finding the cold read missed", () => {
    // brain#160: created 308h before NOW, CONFLICTING once the page warms.
    const warm160 = pr({
      repo: "studio-b-ai/brain",
      number: 160,
      createdAt: hoursAgo(308),
      updatedAt: hoursAgo(6),
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    });
    expect(isMergeabilityUnresolved([warm160])).toBe(false);
    const found = classifyPrs([warm160], NOW);
    expect(found).toHaveLength(1);
    expect(found[0].class).toBe("conflicting-unresolved");

    // Same PR, cold: silently zero findings — the defect, pinned.
    const cold160 = { ...warm160, mergeable: "UNKNOWN" as Mergeable, mergeStateStatus: "UNKNOWN" as MergeStateStatus };
    expect(classifyPrs([cold160], NOW)).toHaveLength(0);
    expect(isMergeabilityUnresolved([cold160])).toBe(true);
  });
});

// ───────────────────────────── thresholds are the contract ─────────────────────────────

describe("thresholds", () => {
  it("match the stint text verbatim (>7d no motion, CONFLICTING >48h)", () => {
    expect(STALE_DAYS).toBe(7);
    expect(CONFLICT_HOURS).toBe(48);
  });

  it("class list is exactly the two classes, strongest first", () => {
    expect([...STALE_PR_CLASSES]).toEqual(["conflicting-unresolved", "stale-no-motion"]);
  });
});

// ───────────────────────────── classifyPr: the clean/negative direction (#322) ─────────────────────────────

describe("classifyPr — known-GOOD must return null (#322 negative control)", () => {
  it("a fresh CLEAN PR is not a finding", () => {
    expect(classifyPr(pr(), NOW)).toBeNull();
  });

  it("an OLD PR that was pushed to today is NOT stale — motion, not age, is the test", () => {
    // The exact false-positive class the lib header calls out: opened three weeks ago,
    // someone pushed an hour ago. Age is 21d; idle is ~0d. Not a finding.
    const f = classifyPr(pr({ createdAt: daysAgo(21), updatedAt: hoursAgo(1) }), NOW);
    expect(f).toBeNull();
  });

  it("idle just UNDER the 7d bound is not a finding (boundary, exclusive side)", () => {
    expect(classifyPr(pr({ createdAt: daysAgo(30), updatedAt: daysAgo(6.99) }), NOW)).toBeNull();
  });

  it("CONFLICTING but younger than 48h is not yet a finding", () => {
    expect(classifyPr(pr({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", createdAt: hoursAgo(47), updatedAt: hoursAgo(47) }), NOW)).toBeNull();
  });

  it.each<MergeStateStatus>(["CLEAN", "DIRTY", "UNSTABLE", "BLOCKED", "BEHIND", "UNKNOWN"])(
    "a fresh mergeStateStatus=%s PR is not a finding — that field is context, never the predicate",
    (status) => {
      expect(classifyPr(pr({ mergeStateStatus: status, createdAt: daysAgo(5), updatedAt: daysAgo(5) }), NOW)).toBeNull();
    },
  );
});

// ───────────────────────────── classifyPr: the firing/positive direction (#322/#464) ─────────────────────────────

describe("classifyPr — known-BAD must fire (#322 positive control)", () => {
  it("idle exactly AT the 7d bound fires stale-no-motion (boundary, inclusive side)", () => {
    const f = classifyPr(pr({ createdAt: daysAgo(7), updatedAt: daysAgo(7) }), NOW);
    expect(f?.class).toBe("stale-no-motion");
    expect(f?.idleDays).toBeCloseTo(7, 6);
  });

  it("CONFLICTING exactly AT 48h old fires conflicting-unresolved (boundary, inclusive side)", () => {
    const f = classifyPr(pr({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", createdAt: hoursAgo(48), updatedAt: hoursAgo(1) }), NOW);
    expect(f?.class).toBe("conflicting-unresolved");
  });

  it("CONFLICTING fires on AGE even when the PR has recent motion — Rule #433: it gets zero CI runs regardless", () => {
    // Deliberate asymmetry vs the stale class, and the reason it is tested explicitly:
    // a conflicting PR being actively pushed to still rots (no CI), so age governs here.
    const f = classifyPr(pr({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", createdAt: daysAgo(10), updatedAt: hoursAgo(2) }), NOW);
    expect(f?.class).toBe("conflicting-unresolved");
    expect(f?.idleDays).toBeLessThan(1);
  });

  it("carries the PR's identity through to the finding (repo/number/title/url)", () => {
    const f = classifyPr(pr({ repo: "studio-b-ai/brain", number: 241, title: "t", url: "u", createdAt: daysAgo(9), updatedAt: daysAgo(9) }), NOW);
    expect(f).toMatchObject({ repo: "studio-b-ai/brain", number: 241, title: "t", url: "u", class: "stale-no-motion" });
    expect(f?.ageDays).toBeCloseTo(9, 6);
  });
});

// ───────────── the blind-instrument regression (#322/#465) ─────────────
//
// Found by live probe 2026-09-13 while proving this leg's first fleet-wide zero honest
// rather than blind: `gh pr list --json mergeStateStatus` NEVER emits "CONFLICTING" — a
// conflicting PR reports mergeStateStatus="DIRTY" there, and only `mergeable` carries
// "CONFLICTING". Observed over the whole fleet's 34 open PRs / 13 repos: list-mode
// mergeStateStatus values were exactly {CLEAN, DIRTY, UNSTABLE, BLOCKED}, zero
// "CONFLICTING" anywhere; the single-PR instrument on brain#160/#252/#230 each read
// `mergeStateStatus=DIRTY mergeable=CONFLICTING`. The first draft of this lib classified
// on mergeStateStatus, which made the conflict class structurally DEAD — fail-closed and
// silent forever, reporting a healthy zero while the org sweep's 7 hand-found CONFLICTING
// PRs sat in plain sight. These tests pin the predicate so that defect cannot return.

describe("conflict predicate is `mergeable`, never `mergeStateStatus` (#322/#465 regression)", () => {
  it("FIRES on the real fleet shape: mergeable=CONFLICTING with mergeStateStatus=DIRTY", () => {
    // Exactly brain#160's observed pair (age 12.8d, recently touched).
    const f = classifyPr(pr({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", createdAt: daysAgo(12.8), updatedAt: hoursAgo(6) }), NOW);
    expect(f?.class).toBe("conflicting-unresolved");
  });

  it("does NOT fire on mergeStateStatus=CONFLICTING alone — that value never appears in list mode", () => {
    // The inverse control: if someone re-points the predicate back at mergeStateStatus,
    // this expectation flips and the suite goes red.
    const f = classifyPr(pr({ mergeable: "MERGEABLE", mergeStateStatus: "CONFLICTING", createdAt: daysAgo(30), updatedAt: hoursAgo(1) }), NOW);
    expect(f).toBeNull();
  });

  it("mergeable=UNKNOWN is not a conflict — GitHub is still computing mergeability", () => {
    expect(classifyPr(pr({ mergeable: "UNKNOWN", mergeStateStatus: "DIRTY", createdAt: daysAgo(30), updatedAt: hoursAgo(1) }), NOW)).toBeNull();
  });

  it("a DIRTY-but-MERGEABLE old PR still fires the STALE class when idle — the two legs stay independent", () => {
    const f = classifyPr(pr({ mergeable: "MERGEABLE", mergeStateStatus: "DIRTY", createdAt: daysAgo(30), updatedAt: daysAgo(30) }), NOW);
    expect(f?.class).toBe("stale-no-motion");
  });

  it("carries the observed pair into the finding as the verdict's evidence", () => {
    const f = classifyPr(pr({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", createdAt: daysAgo(5), updatedAt: hoursAgo(1) }), NOW);
    expect(f).toMatchObject({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
  });
});

// ───────────────────────────── exclusions + precedence ─────────────────────────────

describe("classifyPr — draft exclusion (Rule #157: a human chose that state)", () => {
  it("a long-idle DRAFT is excluded", () => {
    expect(classifyPr(pr({ isDraft: true, createdAt: daysAgo(60), updatedAt: daysAgo(60) }), NOW)).toBeNull();
  });

  it("a CONFLICTING ancient DRAFT is excluded too — draft beats both classes", () => {
    expect(classifyPr(pr({ isDraft: true, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", createdAt: daysAgo(60), updatedAt: daysAgo(60) }), NOW)).toBeNull();
  });
});

describe("classifyPr — exactly one finding per PR, strongest class wins", () => {
  it("BOTH stale AND conflicting reports once, as conflicting-unresolved", () => {
    const f = classifyPr(pr({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", createdAt: daysAgo(30), updatedAt: daysAgo(30) }), NOW);
    expect(f?.class).toBe("conflicting-unresolved");
  });
});

// ───────────────────────────── classifyPrs ─────────────────────────────

describe("classifyPrs", () => {
  it("maps a mixed list to findings only, preserving input order", () => {
    const findings = classifyPrs(
      [
        pr({ number: 1 }), // fresh → dropped
        pr({ number: 2, createdAt: daysAgo(20), updatedAt: daysAgo(20) }), // stale
        pr({ number: 3, isDraft: true, updatedAt: daysAgo(90) }), // draft → dropped
        pr({ number: 4, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", createdAt: daysAgo(5), updatedAt: hoursAgo(1) }), // conflicting
      ],
      NOW,
    );
    expect(findings.map((f) => [f.number, f.class])).toEqual([
      [2, "stale-no-motion"],
      [4, "conflicting-unresolved"],
    ]);
  });

  it("an all-clean repo yields zero findings (the close path's input)", () => {
    expect(classifyPrs([pr({ number: 1 }), pr({ number: 2 })], NOW)).toEqual([]);
  });

  it("an empty PR list is zero findings, not a throw", () => {
    expect(classifyPrs([], NOW)).toEqual([]);
  });
});

// ───────────────────────────── summarize ─────────────────────────────

describe("summarizeStalePr", () => {
  function finding(cls: StalePrFinding["class"], number: number): StalePrFinding {
    return { repo: "r", number, title: "t", url: "u", class: cls, ageDays: 9, idleDays: 9, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };
  }

  it("zero findings reads as an explicit zero, never an empty string", () => {
    expect(summarizeStalePr([])).toBe("0 findings");
  });

  it("counts per class in the canonical class order (strongest first)", () => {
    const s = summarizeStalePr([finding("stale-no-motion", 1), finding("conflicting-unresolved", 2), finding("stale-no-motion", 3)]);
    expect(s).toBe("3 finding(s): 1 conflicting-unresolved, 2 stale-no-motion");
  });

  it("omits a class with no members rather than printing a zero", () => {
    expect(summarizeStalePr([finding("stale-no-motion", 1)])).toBe("1 finding(s): 1 stale-no-motion");
  });
});

// ───────────────────────────── planStalePrAction (mirrors repo-hygiene's planIssueAction) ─────────────────────────────

describe("planStalePrAction — the full 2x2 auto-reconcile truth table", () => {
  it("findings + no open issue → open", () => {
    expect(planStalePrAction(3, false)).toBe("open");
  });
  it("findings + open issue → update", () => {
    expect(planStalePrAction(3, true)).toBe("update");
  });
  it("clean + open issue → close (the auto-reconcile leg, Rule #165)", () => {
    expect(planStalePrAction(0, true)).toBe("close");
  });
  it("clean + no open issue → none (stays silent; never opens an all-clear issue)", () => {
    expect(planStalePrAction(0, false)).toBe("none");
  });
});

// ───────────────────────────── renderStalePrIssueBody ─────────────────────────────

describe("renderStalePrIssueBody", () => {
  const findings: StalePrFinding[] = [
    { repo: "studio-b-ai/brain", number: 241, title: "brain: a stale one", url: "https://github.com/studio-b-ai/brain/pull/241", class: "stale-no-motion", ageDays: 9.25, idleDays: 9.25, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
    { repo: "studio-b-ai/brain", number: 253, title: "brain: a conflicting one", url: "https://github.com/studio-b-ai/brain/pull/253", class: "conflicting-unresolved", ageDays: 4.5, idleDays: 0.1, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
  ];

  it("names the repo, the clock, and both thresholds so the reader can audit the verdict", () => {
    const body = renderStalePrIssueBody("studio-b-ai/brain", findings, NOW);
    expect(body).toContain("studio-b-ai/brain");
    expect(body).toContain(NOW);
    expect(body).toContain(`>= ${STALE_DAYS}d`);
    expect(body).toContain(`>= ${CONFLICT_HOURS}h`);
  });

  it("renders one markdown table row per finding, with a clickable PR link and both ages", () => {
    const body = renderStalePrIssueBody("studio-b-ai/brain", findings, NOW);
    expect(body).toContain("| [#241](https://github.com/studio-b-ai/brain/pull/241) brain: a stale one | stale-no-motion | 9.3 | 9.3 | MERGEABLE | CLEAN |");
    expect(body).toContain("| [#253](https://github.com/studio-b-ai/brain/pull/253) brain: a conflicting one | conflicting-unresolved | 4.5 | 0.1 | CONFLICTING | DIRTY |");
    // Header + separator + one row each, and nothing else claiming to be a row.
    expect(body.split("\n").filter((l) => l.startsWith("| ["))).toHaveLength(2);
  });

  it("states the flags-only law in the body — the issue must not read as 'something was merged'", () => {
    const body = renderStalePrIssueBody("studio-b-ai/brain", findings, NOW);
    expect(body).toMatch(/nominates/i);
    expect(body).toMatch(/owning seat/i);
  });

  it("renders a header-only table when there are no findings (never throws)", () => {
    const body = renderStalePrIssueBody("studio-b-ai/brain", [], NOW);
    expect(body).toContain("| PR | class | age (d) | idle (d) | mergeable | mergeStateStatus |");
    expect(body.split("\n").filter((l) => l.startsWith("| ["))).toHaveLength(0);
  });
});

// ───────────────────────────── resolveSweepPopulation ─────────────────────────────

/**
 * The population half of the receipt (#465). These cases pin the REAL registries as
 * measured 2026-09-13: backlog-managers.yaml had 13 repos, squasher-fleet.json had 18
 * with train:true on 11 — and three train-enabled release-door repos
 * (claude-config-plane, radio, lightsout) were absent from the yaml entirely, so the
 * door could auto-merge where this watch was blind.
 */
describe("resolveSweepPopulation", () => {
  const backlog: BacklogManagerRow[] = [
    { repo: "studio-b-ai/ops-pipeline", manager: "Mechanic" },
    { repo: "studio-b-ai/brain", manager: "Dispatcher" },
    { repo: "studio-b-ai/client-asthetik", manager: "Mechanic" },
  ];
  const door: DoorRegistryRow[] = [
    { repo: "studio-b-ai/brain", train: true },
    { repo: "studio-b-ai/client-asthetik", train: true },
    { repo: "studio-b-ai/claude-config-plane", train: true },
    { repo: "studio-b-ai/radio", train: true },
    { repo: "studio-b-ai/lightsout", train: true },
    { repo: "studio-b-ai/ops-pipeline", train: false },
    { repo: "studio-b-ai/acudev", train: false },
  ];

  it("KNOWN-GOOD: every backlog-manager row survives the union with its manager intact (#471)", () => {
    const pop = resolveSweepPopulation(backlog, door);
    for (const row of backlog) {
      const got = pop.find((p) => p.repo === row.repo);
      expect(got, `${row.repo} must not be dropped by the union`).toBeDefined();
      expect(got!.manager).toBe(row.manager);
    }
  });

  it("KNOWN-BAD (the live gap): train-enabled door repos absent from the yaml ARE swept", () => {
    const pop = resolveSweepPopulation(backlog, door).map((p) => p.repo);
    // The exact three that fell through on 2026-09-13, two with a live CONFLICTING PR.
    expect(pop).toContain("studio-b-ai/claude-config-plane"); // #272 CONFLICTING/DIRTY
    expect(pop).toContain("studio-b-ai/radio"); // #1010 CONFLICTING/DIRTY
    expect(pop).toContain("studio-b-ai/lightsout");
  });

  it("does NOT pull in door rows whose release leg is off — the gap is train:true only", () => {
    const pop = resolveSweepPopulation(backlog, door).map((p) => p.repo);
    // acudev is train:false and has no backlog row, so nothing put it in the population.
    expect(pop).not.toContain("studio-b-ai/acudev");
  });

  it("keeps a train:false door repo that has its OWN backlog row (union, not intersection)", () => {
    const pop = resolveSweepPopulation(backlog, door).map((p) => p.repo);
    expect(pop).toContain("studio-b-ai/ops-pipeline"); // train:false, but a backlog row
  });

  it("labels provenance so a zero can be read against what the sweep could see", () => {
    const pop = resolveSweepPopulation(backlog, door);
    const by = (r: string) => pop.find((p) => p.repo === r)!;
    expect(by("studio-b-ai/brain").source).toBe("both"); // in yaml AND train-enabled
    expect(by("studio-b-ai/ops-pipeline").source).toBe("backlog-managers"); // yaml only
    expect(by("studio-b-ai/radio").source).toBe("release-door"); // door only — the gap
  });

  it("attributes a door-only repo to the door's owning seat (no unowned finding)", () => {
    const pop = resolveSweepPopulation(backlog, door);
    expect(pop.find((p) => p.repo === "studio-b-ai/radio")!.manager).toBe(DOOR_ONLY_FALLBACK_MANAGER);
    expect(pop.every((p) => p.manager.length > 0)).toBe(true);
  });

  it("never double-sweeps: a repo in both registries appears exactly once", () => {
    const pop = resolveSweepPopulation(backlog, door);
    const dupes = pop.map((p) => p.repo).filter((r, i, a) => a.indexOf(r) !== i);
    expect(dupes).toEqual([]);
    expect(new Set(pop.map((p) => p.repo)).size).toBe(pop.length);
  });

  it("dedupes a duplicated backlog row rather than sweeping it twice", () => {
    const pop = resolveSweepPopulation(
      [{ repo: "studio-b-ai/brain", manager: "Dispatcher" }, { repo: "studio-b-ai/brain", manager: "Mechanic" }],
      [],
    );
    expect(pop).toHaveLength(1);
    expect(pop[0].manager).toBe("Dispatcher"); // first row wins, deterministically
  });

  it("is order-stable: backlog rows in config order, then door-only repos in registry order", () => {
    const pop = resolveSweepPopulation(backlog, door).map((p) => p.repo);
    expect(pop).toEqual([
      "studio-b-ai/ops-pipeline",
      "studio-b-ai/brain",
      "studio-b-ai/client-asthetik",
      "studio-b-ai/claude-config-plane",
      "studio-b-ai/radio",
      "studio-b-ai/lightsout",
    ]);
    // Stable across repeated calls — the issue bodies must not reshuffle run to run.
    expect(resolveSweepPopulation(backlog, door).map((p) => p.repo)).toEqual(pop);
  });

  it("treats a missing `train` field as off (absent is not enabled)", () => {
    const pop = resolveSweepPopulation([], [{ repo: "studio-b-ai/lightsout" }]).map((p) => p.repo);
    expect(pop).toEqual([]);
  });

  it("an empty door registry degrades to exactly the backlog population (no crash)", () => {
    const pop = resolveSweepPopulation(backlog, []);
    expect(pop.map((p) => p.repo)).toEqual(backlog.map((b) => b.repo));
    expect(pop.every((p) => p.source === "backlog-managers")).toBe(true);
  });

  it("a backlog row with no manager still gets an owning seat", () => {
    const pop = resolveSweepPopulation([{ repo: "studio-b-ai/clients" }], []);
    expect(pop[0].manager).toBe(DOOR_ONLY_FALLBACK_MANAGER);
  });
});
