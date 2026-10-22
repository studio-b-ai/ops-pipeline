import { describe, expect, it } from "vitest";
import {
  classifyPr,
  classifyPrs,
  planStackedPrAction,
  renderStackedPrIssueBody,
  summarizeStackedPr,
  type ParentPr,
  type StackedPrFinding,
  type StackedPrInput,
} from "../stacked-pr-classify.js";

// ───────────────────────────── fixtures ─────────────────────────────

const NOW = "2026-10-22T01:00:00Z";
const DEFAULT_BRANCH = "main";

function pr(overrides: Partial<StackedPrInput> = {}): StackedPrInput {
  return {
    repo: "studio-b-ai/ops-pipeline",
    number: 617,
    title: "fix: stacked PR detection",
    url: "https://github.com/studio-b-ai/ops-pipeline/pull/617",
    baseRefName: "main",
    headRefName: "mechanic/stacked-pr-1018",
    defaultBranch: DEFAULT_BRANCH,
    isDraft: false,
    ...overrides,
  };
}

function parent(headRefName: string, state: ParentPr["state"]): ParentPr {
  return { headRefName, state };
}

// ──────────────── classifyPr — the core signal ────────────────

describe("classifyPr", () => {
  // #322 positive control — a known-GOOD must produce a finding.
  it("finds a stacked PR whose base branch maps to a merged parent PR (the stunt)", () => {
    const input = pr({ number: 100, baseRefName: "feature-a", headRefName: "feature-b" });
    const parents = [parent("feature-a", "MERGED")];
    const finding = classifyPr(input, parents);
    expect(finding).not.toBeNull();
    expect(finding!.class).toBe("stacked-base-defunct");
    expect(finding!.baseRefName).toBe("feature-a");
    expect(finding!.headRefName).toBe("feature-b");
  });

  // #322 negative control — a known-GOOD must NOT produce a false finding.
  it("returns null for a PR targeting the default branch (normal case)", () => {
    const input = pr({ baseRefName: "main", headRefName: "feature-x" });
    const parents = [parent("feature-x", "MERGED")];
    expect(classifyPr(input, parents)).toBeNull();
  });

  it("returns null for a stacked PR whose parent is still OPEN", () => {
    const input = pr({ baseRefName: "feature-a", headRefName: "feature-b" });
    const parents = [parent("feature-a", "OPEN")];
    expect(classifyPr(input, parents)).toBeNull();
  });

  it("returns null for a stacked PR whose parent is CLOSED (not merged)", () => {
    const input = pr({ baseRefName: "feature-a", headRefName: "feature-b" });
    const parents = [parent("feature-a", "CLOSED")];
    expect(classifyPr(input, parents)).toBeNull();
  });

  it("returns null for a PR targeting a non-default branch with no matching parent PR at all", () => {
    const input = pr({ baseRefName: "release/v2", headRefName: "hotfix/urgent" });
    const parents = [parent("feature-x", "MERGED"), parent("feature-y", "CLOSED")];
    expect(classifyPr(input, parents)).toBeNull();
  });

  it("returns null for a draft PR (Rule #157 — human chose draft, not abandoned)", () => {
    const input = pr({ baseRefName: "feature-a", headRefName: "feature-b", isDraft: true });
    const parents = [parent("feature-a", "MERGED")];
    expect(classifyPr(input, parents)).toBeNull();
  });

  it("matches parent by exact headRefName, not substring", () => {
    const input = pr({ baseRefName: "feature-a", headRefName: "feature-b" });
    const parents = [parent("feature-a-extra", "MERGED")]; // different name
    expect(classifyPr(input, parents)).toBeNull();
  });

  it("default branch comparison is exact — 'main' !== 'Main'", () => {
    const input = pr({ baseRefName: "Main", defaultBranch: "main" });
    const parents = [parent("Main", "MERGED")];
    expect(classifyPr(input, parents)).not.toBeNull(); // baseRefName !== defaultBranch, so it fires
  });

  it("works across different default branch names (e.g. 'master')", () => {
    const input = pr({ baseRefName: "feature-a", headRefName: "feature-b", defaultBranch: "master" });
    const parents = [parent("feature-a", "MERGED")];
    expect(classifyPr(input, parents)).not.toBeNull();
  });
});

// ──────────────── classifyPrs — batch classification ────────────────

describe("classifyPrs", () => {
  it("classifies multiple stacked PRs, each matched to their parent", () => {
    const prs: StackedPrInput[] = [
      pr({ number: 1, baseRefName: "feature-a", headRefName: "feature-a-continued" }),
      pr({ number: 2, baseRefName: "main", headRefName: "normal-feature" }),
      pr({ number: 3, baseRefName: "feature-b", headRefName: "feature-b-continued" }),
    ];
    const parents: ParentPr[] = [
      parent("feature-a", "MERGED"),
      parent("feature-b", "MERGED"),
    ];
    const findings = classifyPrs(prs, parents);
    expect(findings).toHaveLength(2);
    expect(findings[0].number).toBe(1);
    expect(findings[1].number).toBe(3);
  });

  it("returns empty array when no stacked PRs are defunct", () => {
    const prs: StackedPrInput[] = [
      pr({ number: 1, baseRefName: "main" }),
      pr({ number: 2, baseRefName: "main" }),
    ];
    const parents: ParentPr[] = [parent("feature-x", "MERGED")];
    expect(classifyPrs(prs, parents)).toHaveLength(0);
  });

  it("returns empty array when parents are empty", () => {
    const prs: StackedPrInput[] = [
      pr({ number: 1, baseRefName: "feature-a" }),
    ];
    expect(classifyPrs(prs, [])).toHaveLength(0);
  });
});

// ──────────────── planStackedPrAction ────────────────

describe("planStackedPrAction", () => {
  it("opens when findings > 0 and no issue exists", () => {
    expect(planStackedPrAction(1, false)).toBe("open");
  });

  it("updates when findings > 0 and an issue exists", () => {
    expect(planStackedPrAction(3, true)).toBe("update");
  });

  it("closes when findings = 0 and an issue is open (condition cleared)", () => {
    expect(planStackedPrAction(0, true)).toBe("close");
  });

  it("does nothing when findings = 0 and no issue exists", () => {
    expect(planStackedPrAction(0, false)).toBe("none");
  });
});

// ──────────────── summarizeStackedPr ────────────────

describe("summarizeStackedPr", () => {
  it("reports 0 findings for an empty array", () => {
    expect(summarizeStackedPr([])).toBe("0 findings");
  });

  it("reports the count for non-empty", () => {
    const findings: StackedPrFinding[] = [
      { repo: "r", number: 1, title: "a", url: "u", class: "stacked-base-defunct", baseRefName: "b", headRefName: "h", defaultBranch: "main", parentPrNumber: 2, parentPrState: "MERGED" },
    ];
    expect(summarizeStackedPr(findings)).toBe("1 finding(s): 1 stacked-base-defunct");
  });
});

// ──────────────── renderStackedPrIssueBody ────────────────

describe("renderStackedPrIssueBody", () => {
  it("renders a markdown table with findings", () => {
    const findings: StackedPrFinding[] = [
      { repo: "studio-b-ai/bolt-wms", number: 4000, title: "fix: backorder date calc", url: "https://github.com/studio-b-ai/bolt-wms/pull/4000", class: "stacked-base-defunct", baseRefName: "feat/refactor-dates", headRefName: "feat/backorder-fix", defaultBranch: "main", parentPrNumber: 3999, parentPrState: "MERGED" },
    ];
    const body = renderStackedPrIssueBody("studio-b-ai/bolt-wms", findings, NOW);
    expect(body).toContain("Stacked-PR sweep");
    expect(body).toContain("studio-b-ai/bolt-wms");
    expect(body).toContain("feat/refactor-dates");
    expect(body).toContain("MERGED");
    expect(body).toContain("#3999");
    expect(body).toContain("#4000");
    expect(body).toContain("mechanic stint #1018");
    expect(body).toContain("Default branch for this repo: `main`");
  });

  it("handles parentPrNumber=0 as 'unknown'", () => {
    const findings: StackedPrFinding[] = [
      { repo: "r", number: 1, title: "t", url: "u", class: "stacked-base-defunct", baseRefName: "b", headRefName: "h", defaultBranch: "main", parentPrNumber: 0, parentPrState: "MERGED" },
    ];
    const body = renderStackedPrIssueBody("r", findings, NOW);
    expect(body).toContain("unknown");
  });

  it("renders empty findings body with 0 entries", () => {
    const body = renderStackedPrIssueBody("r", [], NOW);
    expect(body).toContain("Stacked-PR sweep");
    expect(body).toContain("Default branch for this repo: `unknown`");
  });
});