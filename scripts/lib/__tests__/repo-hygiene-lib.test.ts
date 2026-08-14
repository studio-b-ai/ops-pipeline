import { describe, expect, it } from "vitest";
import {
  BASELINE_RULES_VERSION,
  computeBotChurnSample,
  diffFleet,
  isBotAuthoredCommit,
  isBotChurn,
  planIssueAction,
  renderDriftIssueBody,
  summarizeFindings,
  FINDING_CLASSES,
  type BaselineEntry,
  type BaselineFile,
  type CommitAuthorInfo,
  type Finding,
  type LiveRepo,
} from "../repo-hygiene-lib.js";

// ───────────────────────────── fixtures ─────────────────────────────

function baselineEntry(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    name: "acuops-pipeline",
    archived: false,
    visibility: "PUBLIC",
    pushedAtAtSeed: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function liveRepo(overrides: Partial<LiveRepo> = {}): LiveRepo {
  return {
    name: "acuops-pipeline",
    isArchived: false,
    visibility: "PUBLIC",
    pushedAt: "2026-08-10T00:00:00Z",
    ...overrides,
  };
}

function baseline(repos: BaselineEntry[], rulesVersion = BASELINE_RULES_VERSION): BaselineFile {
  return { rulesVersion, seededAt: "2026-08-01T00:00:00Z", repos };
}

// ───────────────────────────── diffFleet: new-unmapped-repo ─────────────────────────────

describe("diffFleet — new-unmapped-repo", () => {
  // Negative control first (Rule #322).
  it("does NOT flag a repo present in both, unchanged", () => {
    const findings = diffFleet(baseline([baselineEntry()]), [liveRepo()]);
    expect(findings.filter((f) => f.class === "new-unmapped-repo")).toHaveLength(0);
  });

  it("flags a live repo absent from the baseline", () => {
    const findings = diffFleet(baseline([]), [liveRepo({ name: "brand-new-repo" })]);
    expect(findings).toHaveLength(1);
    expect(findings[0].class).toBe("new-unmapped-repo");
    expect(findings[0].repo).toBe("brand-new-repo");
    expect(findings[0].detail).toContain("brand-new-repo");
    expect(findings[0].detail).toContain("absent from the baseline");
  });

  it("baselineEdit is an ADD line carrying the exact live state as a single-line JSON object", () => {
    const findings = diffFleet(baseline([]), [
      liveRepo({ name: "brand-new-repo", isArchived: true, visibility: "PRIVATE", pushedAt: "2026-08-12T01:02:03Z" }),
    ]);
    expect(findings[0].baselineEdit).toBe(
      'ADD to "repos": {"name":"brand-new-repo","archived":true,"visibility":"PRIVATE","pushedAtAtSeed":"2026-08-12T01:02:03Z"}',
    );
  });
});

// ───────────────────────────── diffFleet: baseline-repo-gone ─────────────────────────────

describe("diffFleet — baseline-repo-gone", () => {
  it("does NOT flag a baseline repo still live", () => {
    const findings = diffFleet(baseline([baselineEntry()]), [liveRepo()]);
    expect(findings.filter((f) => f.class === "baseline-repo-gone")).toHaveLength(0);
  });

  it("flags a baseline repo absent from the live enumeration", () => {
    const gone = baselineEntry({ name: "deleted-or-transferred" });
    const findings = diffFleet(baseline([gone]), []);
    expect(findings).toHaveLength(1);
    expect(findings[0].class).toBe("baseline-repo-gone");
    expect(findings[0].repo).toBe("deleted-or-transferred");
    expect(findings[0].detail).toContain("deleted or transferred");
  });

  it("baselineEdit is a REMOVE instruction carrying the exact line to delete", () => {
    const gone = baselineEntry({ name: "deleted-or-transferred", archived: true, visibility: "PRIVATE" });
    const findings = diffFleet(baseline([gone]), []);
    expect(findings[0].baselineEdit).toBe(
      'REMOVE this line from "repos": {"name":"deleted-or-transferred","archived":true,"visibility":"PRIVATE","pushedAtAtSeed":"2026-08-01T00:00:00Z"}',
    );
  });
});

// ───────────────────────────── diffFleet: archived-flip ─────────────────────────────

describe("diffFleet — archived-flip", () => {
  it("does NOT flag when archived state matches", () => {
    const findings = diffFleet(baseline([baselineEntry({ archived: true })]), [liveRepo({ isArchived: true })]);
    expect(findings.filter((f) => f.class === "archived-flip")).toHaveLength(0);
  });

  it("flags baseline=false, live=true", () => {
    const findings = diffFleet(baseline([baselineEntry({ archived: false })]), [liveRepo({ isArchived: true })]);
    const flip = findings.find((f) => f.class === "archived-flip");
    expect(flip).toBeDefined();
    expect(flip!.detail).toContain("baseline=false, live=true");
  });

  it("flags baseline=true, live=false (unarchived)", () => {
    const findings = diffFleet(baseline([baselineEntry({ archived: true })]), [liveRepo({ isArchived: false })]);
    const flip = findings.find((f) => f.class === "archived-flip");
    expect(flip).toBeDefined();
    expect(flip!.detail).toContain("baseline=true, live=false");
  });

  it("baselineEdit is an UPDATE line carrying every OTHER field unchanged", () => {
    const entry = baselineEntry({ archived: false, visibility: "PRIVATE", pushedAtAtSeed: "2026-08-01T00:00:00Z" });
    const findings = diffFleet(baseline([entry]), [liveRepo({ isArchived: true, visibility: "PRIVATE" })]);
    const flip = findings.find((f) => f.class === "archived-flip")!;
    expect(flip.baselineEdit).toBe(
      'UPDATE its "repos" line to: {"name":"acuops-pipeline","archived":true,"visibility":"PRIVATE","pushedAtAtSeed":"2026-08-01T00:00:00Z"}',
    );
  });
});

// ───────────────────────────── diffFleet: visibility-flip ─────────────────────────────

describe("diffFleet — visibility-flip", () => {
  it("does NOT flag when visibility matches", () => {
    const findings = diffFleet(baseline([baselineEntry({ visibility: "PUBLIC" })]), [liveRepo({ visibility: "PUBLIC" })]);
    expect(findings.filter((f) => f.class === "visibility-flip")).toHaveLength(0);
  });

  // Defensive case-insensitivity — `gh` itself always reports uppercase, but a hand-typed
  // baseline edit must not read as live drift merely over casing.
  it("does NOT flag on a case-only difference (defensive normalization)", () => {
    const findings = diffFleet(baseline([baselineEntry({ visibility: "public" })]), [liveRepo({ visibility: "PUBLIC" })]);
    expect(findings.filter((f) => f.class === "visibility-flip")).toHaveLength(0);
  });

  it("flags PUBLIC baseline vs PRIVATE live", () => {
    const findings = diffFleet(baseline([baselineEntry({ visibility: "PUBLIC" })]), [liveRepo({ visibility: "PRIVATE" })]);
    const flip = findings.find((f) => f.class === "visibility-flip");
    expect(flip).toBeDefined();
    expect(flip!.detail).toContain("baseline=PUBLIC, live=PRIVATE");
  });

  it("baselineEdit is an UPDATE line", () => {
    const entry = baselineEntry({ visibility: "PUBLIC" });
    const findings = diffFleet(baseline([entry]), [liveRepo({ visibility: "PRIVATE" })]);
    const flip = findings.find((f) => f.class === "visibility-flip")!;
    expect(flip.baselineEdit).toContain('"visibility":"PRIVATE"');
  });

  it("a repo can carry BOTH an archived-flip and a visibility-flip in the same run", () => {
    const entry = baselineEntry({ archived: false, visibility: "PUBLIC" });
    const findings = diffFleet(baseline([entry]), [liveRepo({ isArchived: true, visibility: "PRIVATE" })]);
    expect(findings.map((f) => f.class).sort()).toEqual(["archived-flip", "visibility-flip"]);
  });
});

// ───────────────────────────── diffFleet: bot-churn-freshness ─────────────────────────────

describe("diffFleet — bot-churn-freshness", () => {
  // Negative controls first.
  it("does NOT flag a repo with no attached botChurn sample, regardless of pushedAt", () => {
    const findings = diffFleet(baseline([baselineEntry()]), [liveRepo({ pushedAt: "2026-08-14T00:00:00Z" })]);
    expect(findings.filter((f) => f.class === "bot-churn-freshness")).toHaveLength(0);
  });

  it("does NOT flag a repo whose sample is below the 90% threshold", () => {
    const findings = diffFleet(baseline([baselineEntry()]), [
      liveRepo({ botChurn: { totalCommits: 20, botCommits: 17 } }), // 85%
    ]);
    expect(findings.filter((f) => f.class === "bot-churn-freshness")).toHaveLength(0);
  });

  it("flags a repo at/above the 90% threshold — INFORMATIONAL, baselineEdit is null", () => {
    const findings = diffFleet(baseline([baselineEntry({ name: "acuops-website" })]), [
      liveRepo({ name: "acuops-website", pushedAt: "2026-08-13T00:00:00Z", botChurn: { totalCommits: 20, botCommits: 19 } }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].class).toBe("bot-churn-freshness");
    expect(findings[0].baselineEdit).toBeNull();
    expect(findings[0].detail).toContain("19/20");
    expect(findings[0].detail).toContain("95%");
    expect(findings[0].detail).toContain("machine churn");
  });

  // This class does not depend on the repo being IN the baseline at all — it's a pure live
  // observation, independent of the other four comparison classes.
  it("fires even for a repo that is ALSO new-unmapped-repo", () => {
    const findings = diffFleet(baseline([]), [
      liveRepo({ name: "brand-new-bot-repo", botChurn: { totalCommits: 20, botCommits: 20 } }),
    ]);
    expect(findings.map((f) => f.class).sort()).toEqual(["bot-churn-freshness", "new-unmapped-repo"]);
  });
});

// ───────────────────────────── diffFleet: all-clean + determinism ─────────────────────────────

describe("diffFleet — all-clean path", () => {
  it("produces zero findings when live exactly matches baseline", () => {
    const findings = diffFleet(baseline([baselineEntry({ name: "a" }), baselineEntry({ name: "b" })]), [
      liveRepo({ name: "a" }),
      liveRepo({ name: "b" }),
    ]);
    expect(findings).toEqual([]);
  });

  it("handles a fully empty baseline and empty live without throwing", () => {
    expect(diffFleet(baseline([]), [])).toEqual([]);
  });
});

describe("diffFleet — deterministic ordering", () => {
  it("groups findings by class in FINDING_CLASSES order, sorted by repo name within class", () => {
    const b = baseline([
      baselineEntry({ name: "zzz-gone" }),
      baselineEntry({ name: "aaa-gone" }),
      baselineEntry({ name: "mid-archived", archived: false }),
    ]);
    const live = [
      liveRepo({ name: "zzz-new" }),
      liveRepo({ name: "aaa-new" }),
      liveRepo({ name: "mid-archived", isArchived: true }),
    ];
    const findings = diffFleet(b, live);
    const classOrder = findings.map((f) => f.class);
    // new-unmapped-repo entries precede baseline-repo-gone entries precede archived-flip —
    // matches FINDING_CLASSES declaration order.
    expect(classOrder).toEqual(["new-unmapped-repo", "new-unmapped-repo", "baseline-repo-gone", "baseline-repo-gone", "archived-flip"]);
    const newUnmapped = findings.filter((f) => f.class === "new-unmapped-repo").map((f) => f.repo);
    expect(newUnmapped).toEqual(["aaa-new", "zzz-new"]); // alphabetical, not insertion order
    const gone = findings.filter((f) => f.class === "baseline-repo-gone").map((f) => f.repo);
    expect(gone).toEqual(["aaa-gone", "zzz-gone"]);
  });

  it("re-running diffFleet on identical inputs produces an identical (deep-equal) result", () => {
    const b = baseline([baselineEntry({ name: "x" })]);
    const live = [liveRepo({ name: "y" })];
    expect(diffFleet(b, live)).toEqual(diffFleet(b, live));
  });
});

// ───────────────────────────── bot-churn classification ─────────────────────────────

describe("isBotAuthoredCommit", () => {
  it("does NOT count a normal human user (negative control)", () => {
    expect(isBotAuthoredCommit({ login: "kbibelhausen", type: "User" })).toBe(false);
  });

  it("does NOT count a commit GitHub couldn't associate with any account", () => {
    expect(isBotAuthoredCommit({ login: null, type: null })).toBe(false);
  });

  it("counts type === 'Bot'", () => {
    expect(isBotAuthoredCommit({ login: "some-app", type: "Bot" })).toBe(true);
  });

  it("counts a login ending in '[bot]' regardless of type", () => {
    expect(isBotAuthoredCommit({ login: "dependabot[bot]", type: "User" })).toBe(true);
  });

  it("does NOT count a login merely CONTAINING '[bot]' mid-string (suffix-anchored, not substring)", () => {
    expect(isBotAuthoredCommit({ login: "not-a-[bot]-really", type: "User" })).toBe(false);
  });
});

describe("computeBotChurnSample", () => {
  it("counts totals and bot-authored commits correctly over a mixed list", () => {
    const commits: CommitAuthorInfo[] = [
      { login: "kbibelhausen", type: "User" },
      { login: "dependabot[bot]", type: "User" },
      { login: "some-app", type: "Bot" },
      { login: null, type: null },
    ];
    expect(computeBotChurnSample(commits)).toEqual({ totalCommits: 4, botCommits: 2 });
  });

  it("handles an empty commit list", () => {
    expect(computeBotChurnSample([])).toEqual({ totalCommits: 0, botCommits: 0 });
  });
});

describe("isBotChurn — threshold edges", () => {
  // Negative controls first.
  it("an EMPTY commit list is never bot-churn (Rule #322 — an empty population is not a positive result)", () => {
    expect(isBotChurn({ totalCommits: 0, botCommits: 0 })).toBe(false);
  });

  it("just under the threshold (17/20 = 85%) does NOT flag", () => {
    expect(isBotChurn({ totalCommits: 20, botCommits: 17 })).toBe(false);
  });

  it("0% (all human) does NOT flag", () => {
    expect(isBotChurn({ totalCommits: 20, botCommits: 0 })).toBe(false);
  });

  it("EXACTLY 90% (18/20) DOES flag — boundary is inclusive", () => {
    expect(isBotChurn({ totalCommits: 20, botCommits: 18 })).toBe(true);
  });

  it("19/20 (95%) flags", () => {
    expect(isBotChurn({ totalCommits: 20, botCommits: 19 })).toBe(true);
  });

  it("100% (20/20) flags", () => {
    expect(isBotChurn({ totalCommits: 20, botCommits: 20 })).toBe(true);
  });

  it("holds at the same 90% boundary for a smaller sample (9/10)", () => {
    expect(isBotChurn({ totalCommits: 10, botCommits: 9 })).toBe(true);
    expect(isBotChurn({ totalCommits: 10, botCommits: 8 })).toBe(false);
  });
});

// ───────────────────────────── summarizeFindings (Rule #465) ─────────────────────────────

describe("summarizeFindings — always prints every class including 0 (Rule #465)", () => {
  it("with zero findings, every one of the five classes still appears at =0", () => {
    const line = summarizeFindings([]);
    for (const cls of FINDING_CLASSES) {
      expect(line).toContain(`${cls}=0`);
    }
    expect(line).toContain("total=0");
  });

  it("with partial findings, classes with NO findings still print =0 (not omitted)", () => {
    const findings: Finding[] = [
      { class: "new-unmapped-repo", repo: "a", detail: "d", baselineEdit: "e" },
      { class: "new-unmapped-repo", repo: "b", detail: "d", baselineEdit: "e" },
    ];
    const line = summarizeFindings(findings);
    expect(line).toContain("new-unmapped-repo=2");
    expect(line).toContain("baseline-repo-gone=0");
    expect(line).toContain("archived-flip=0");
    expect(line).toContain("visibility-flip=0");
    expect(line).toContain("bot-churn-freshness=0");
    expect(line).toContain("total=2");
  });

  it("prints all five class names even when findings carry an unexpected count distribution", () => {
    const findings: Finding[] = FINDING_CLASSES.map((c, i) => ({ class: c, repo: `r${i}`, detail: "d", baselineEdit: null }));
    const line = summarizeFindings(findings);
    for (const cls of FINDING_CLASSES) expect(line).toContain(`${cls}=1`);
    expect(line).toContain("total=5");
  });
});

// ───────────────────────────── renderDriftIssueBody ─────────────────────────────

describe("renderDriftIssueBody", () => {
  const meta = {
    org: "studio-b-ai",
    liveRepoCount: 102,
    baselineRepoCount: 100,
    baselineRulesVersion: BASELINE_RULES_VERSION,
    baselineSeededAt: "2026-08-01T00:00:00Z",
    generatedAt: "2026-08-14T09:00:00Z",
  };

  it("all-clean render: every section says _none_, and the summary line is present", () => {
    const body = renderDriftIssueBody([], meta);
    for (const cls of FINDING_CLASSES) {
      expect(body).toContain(`(${0})`);
    }
    expect(body).toContain("_none_");
    expect(body).toContain("repo-hygiene summary");
    expect(body).toContain("total=0");
  });

  it("does NOT print a rulesVersion mismatch note when versions match (negative control)", () => {
    const body = renderDriftIssueBody([], meta);
    expect(body).not.toContain("rulesVersion mismatch");
  });

  it("prints a loud rulesVersion mismatch note when the baseline's version differs (Rule #381)", () => {
    const body = renderDriftIssueBody([], { ...meta, baselineRulesVersion: 999 });
    expect(body).toContain("rulesVersion mismatch");
    expect(body).toContain("999");
    expect(body).toContain(String(BASELINE_RULES_VERSION));
    expect(body).toContain("FULL re-evaluation");
  });

  it("renders each finding's detail AND its Resolve line", () => {
    const findings: Finding[] = [
      { class: "new-unmapped-repo", repo: "brand-new", detail: "`brand-new` is live but absent from the baseline.", baselineEdit: 'ADD to "repos": {"name":"brand-new"}' },
    ];
    const body = renderDriftIssueBody(findings, meta);
    expect(body).toContain("brand-new` is live but absent from the baseline.");
    expect(body).toContain('Resolve: `ADD to "repos": {"name":"brand-new"}`');
  });

  it("renders bot-churn-freshness findings with an Informational note, NOT a Resolve line", () => {
    const findings: Finding[] = [
      { class: "bot-churn-freshness", repo: "acuops-website", detail: "`acuops-website` ... 19/20 ... 95% ...", baselineEdit: null },
    ];
    const body = renderDriftIssueBody(findings, meta);
    expect(body).toContain("Informational — no baseline edit");
    // The only finding in this fixture is the bot-churn one, so the indented per-finding
    // "  Resolve: `...`" line must not appear anywhere — the footer's generic *instruction*
    // to "Apply the `Resolve:` line(s) above" is a DIFFERENT string shape (unindented prose,
    // no backtick immediately after the colon) and must not false-fail this check.
    expect(body).not.toContain("  Resolve: `");
  });

  it("never claims the worker will edit the baseline itself (Rules #379/#381)", () => {
    const body = renderDriftIssueBody([], meta);
    expect(body).toContain("never edits");
  });

  it("the body's closing summary line matches summarizeFindings exactly (single source of truth)", () => {
    const findings: Finding[] = [{ class: "archived-flip", repo: "x", detail: "d", baselineEdit: "e" }];
    const body = renderDriftIssueBody(findings, meta);
    expect(body).toContain(summarizeFindings(findings));
  });
});

// ───────────────────────────── planIssueAction ─────────────────────────────

describe("planIssueAction — single stable-title issue reconcile", () => {
  // Negative controls first.
  it("does nothing when clean and no issue is open", () => {
    expect(planIssueAction(0, false)).toBe("none");
  });

  it("opens a fresh issue when findings exist and none is open", () => {
    expect(planIssueAction(3, false)).toBe("open");
  });

  it("updates (refreshes body) when findings persist and an issue is already open", () => {
    expect(planIssueAction(3, true)).toBe("update");
  });

  it("closes when findings clear and an issue is open", () => {
    expect(planIssueAction(0, true)).toBe("close");
  });
});
