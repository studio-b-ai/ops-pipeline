import { describe, expect, it } from "vitest";
import {
  BASELINE_RULES_VERSION,
  alertWorthyCount,
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
    // Census-complete by default (v2) — mirrors the re-seeded production baseline, where
    // every active row carries a census. Tests exercising census GAPS override these to
    // undefined explicitly (the spread sets the property to undefined, which the lib
    // treats identically to absent — and JSON.stringify drops it from rendered lines).
    class293: "Internal Tooling",
    verdict: "mechanic-covered",
    verdictAt: "2026-08-01T00:00:00Z",
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
      'REMOVE this line from "repos": {"name":"deleted-or-transferred","archived":true,"visibility":"PRIVATE","pushedAtAtSeed":"2026-08-01T00:00:00Z","class293":"Internal Tooling","verdict":"mechanic-covered","verdictAt":"2026-08-01T00:00:00Z"}',
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

  it("baselineEdit is an UPDATE line reflecting the repo's full LIVE state (not a patch over the stale baseline entry)", () => {
    const entry = baselineEntry({ archived: false, visibility: "PRIVATE", pushedAtAtSeed: "2026-08-01T00:00:00Z" });
    const findings = diffFleet(baseline([entry]), [liveRepo({ isArchived: true, visibility: "PRIVATE", pushedAt: "2026-08-14T00:00:00Z" })]);
    const flip = findings.find((f) => f.class === "archived-flip")!;
    // pushedAtAtSeed refreshes to the LIVE pushedAt, not the stale baseline seed date —
    // this line is built from live state end to end, never `{...entry, oneField}`.
    expect(flip.baselineEdit).toBe(
      'UPDATE its "repos" line to: {"name":"acuops-pipeline","archived":true,"visibility":"PRIVATE","pushedAtAtSeed":"2026-08-14T00:00:00Z","class293":"Internal Tooling","verdict":"mechanic-covered","verdictAt":"2026-08-01T00:00:00Z"}',
    );
  });

  // codex review (2026-08-14, ops#101 PR pass 1, P2 — THE regression this fixes): before
  // the fix, this exact fixture produced an archived-flip resolve line carrying the OLD
  // (baseline) visibility and a visibility-flip resolve line carrying the OLD (baseline)
  // archived state — applying either alone would silently revert the OTHER field, and the
  // monitor would keep reporting drift forever no matter which one a human applied.
  it("when BOTH archived and visibility change simultaneously, both findings' resolve lines are IDENTICAL and fully correct", () => {
    const entry = baselineEntry({ name: "dual-flip-repo", archived: false, visibility: "PUBLIC" });
    const findings = diffFleet(baseline([entry]), [
      liveRepo({ name: "dual-flip-repo", isArchived: true, visibility: "PRIVATE", pushedAt: "2026-08-14T00:00:00Z" }),
    ]);
    const archivedFlip = findings.find((f) => f.class === "archived-flip")!;
    const visibilityFlip = findings.find((f) => f.class === "visibility-flip")!;
    expect(archivedFlip.baselineEdit).toBeDefined();
    expect(visibilityFlip.baselineEdit).toBeDefined();
    // Identical — safe to apply either one, or both, with the same end state.
    expect(archivedFlip.baselineEdit).toBe(visibilityFlip.baselineEdit);
    // And both fields are LIVE-correct in that one shared line — neither is stale.
    expect(archivedFlip.baselineEdit).toContain('"archived":true');
    expect(archivedFlip.baselineEdit).toContain('"visibility":"PRIVATE"');
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

// ───────────────────────────── diffFleet: census classes (v2) ─────────────────────────────

describe("diffFleet — census-verdict-missing", () => {
  // Negative control first (Rule #322): a census-complete active row is clean.
  it("does NOT flag a live unarchived repo with a complete valid census", () => {
    const findings = diffFleet(baseline([baselineEntry()]), [liveRepo()]);
    expect(findings).toEqual([]);
  });

  it("flags a census-bare row with ONE aggregated finding naming every gap", () => {
    const entry = baselineEntry({ class293: undefined, verdict: undefined, verdictAt: undefined });
    const findings = diffFleet(baseline([entry]), [liveRepo()]);
    expect(findings).toHaveLength(1);
    expect(findings[0].class).toBe("census-verdict-missing");
    expect(findings[0].detail).toContain("class293 missing");
    expect(findings[0].detail).toContain("verdict missing");
    expect(findings[0].baselineEdit).toBeNull();
  });

  it("flags an out-of-vocabulary verdict — a typo must not silently exempt (Rule #465)", () => {
    const entry = baselineEntry({ verdict: "frozen" }); // typo for "freeze"
    const findings = diffFleet(baseline([entry]), [liveRepo()]);
    expect(findings).toHaveLength(1);
    expect(findings[0].class).toBe("census-verdict-missing");
    expect(findings[0].detail).toContain('verdict invalid ("frozen")');
  });

  it("flags verdict=TBD — valid vocabulary, standing pressure", () => {
    const findings = diffFleet(baseline([baselineEntry({ verdict: "TBD" })]), [liveRepo()]);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("verdict TBD");
  });

  it("flags class293 missing / invalid / TBD independently of a valid verdict", () => {
    const missing = diffFleet(baseline([baselineEntry({ class293: undefined })]), [liveRepo()]);
    expect(missing).toHaveLength(1);
    expect(missing[0].detail).toContain("class293 missing");
    const invalid = diffFleet(baseline([baselineEntry({ class293: "Tooling" })]), [liveRepo()]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].detail).toContain('class293 invalid ("Tooling")');
    const tbd = diffFleet(baseline([baselineEntry({ class293: "TBD" })]), [liveRepo()]);
    expect(tbd).toHaveLength(1);
    expect(tbd[0].detail).toContain("class293 TBD");
  });

  it("flags verdict=freeze without verdictAt as class 6, and class 8 stays silent (no comparand)", () => {
    const entry = baselineEntry({ verdict: "freeze", verdictAt: undefined });
    const findings = diffFleet(baseline([entry]), [liveRepo({ pushedAt: "2026-07-01T00:00:00Z" })]);
    expect(findings).toHaveLength(1);
    expect(findings[0].class).toBe("census-verdict-missing");
    expect(findings[0].detail).toContain("without verdictAt");
  });

  it("flags a malformed verdictAt", () => {
    const findings = diffFleet(baseline([baselineEntry({ verdictAt: "yesterday" })]), [liveRepo()]);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('verdictAt malformed ("yesterday")');
  });

  it("does NOT fire for a live-ARCHIVED repo, even census-bare (census-exempt by construction)", () => {
    const entry = baselineEntry({ archived: true, class293: undefined, verdict: undefined, verdictAt: undefined });
    const findings = diffFleet(baseline([entry]), [liveRepo({ isArchived: true })]);
    expect(findings).toEqual([]);
  });

  it("exemption reads the LIVE archived flag: an archived-flip repo fires the flip but NOT census pressure", () => {
    const entry = baselineEntry({ archived: false, class293: undefined, verdict: undefined, verdictAt: undefined });
    const findings = diffFleet(baseline([entry]), [liveRepo({ isArchived: true })]);
    expect(findings.map((f) => f.class)).toEqual(["archived-flip"]);
  });

  it("does NOT fire for a baseline repo that is GONE live (class 2 owns that)", () => {
    const entry = baselineEntry({ name: "gone-repo", class293: undefined, verdict: undefined, verdictAt: undefined });
    const findings = diffFleet(baseline([entry]), []);
    expect(findings.map((f) => f.class)).toEqual(["baseline-repo-gone"]);
  });

  it("a class-1 ADD line is census-bare by design — the new repo does not fire class 6 this run", () => {
    const findings = diffFleet(baseline([]), [liveRepo({ name: "brand-new-repo" })]);
    expect(findings.map((f) => f.class)).toEqual(["new-unmapped-repo"]);
    // The ADD line carries no census keys; once applied, class 6 demands the verdict next run.
    expect(findings[0].baselineEdit).toContain("brand-new-repo");
    expect(findings[0].baselineEdit).not.toContain("class293");
  });
});

describe("diffFleet — unexecuted-retirement", () => {
  it("does NOT flag verdict=retire on a repo already ARCHIVED live (retirement executed — negative control)", () => {
    const entry = baselineEntry({ archived: true, verdict: "retire", class293: "Dead" });
    const findings = diffFleet(baseline([entry]), [liveRepo({ isArchived: true })]);
    expect(findings).toEqual([]);
  });

  it("flags verdict=retire on a live unarchived repo, naming the verdict date and Rule #366", () => {
    const entry = baselineEntry({ verdict: "retire", class293: "Dead", verdictAt: "2026-08-30T00:00:00Z" });
    const findings = diffFleet(baseline([entry]), [liveRepo()]);
    expect(findings).toHaveLength(1);
    expect(findings[0].class).toBe("unexecuted-retirement");
    expect(findings[0].detail).toContain("worded 2026-08-30T00:00:00Z");
    expect(findings[0].detail).toContain("#366");
    expect(findings[0].baselineEdit).toBeNull();
  });

  it("retire with census gaps fires BOTH class 6 and class 7 (independent defects)", () => {
    const entry = baselineEntry({ verdict: "retire", class293: undefined });
    const findings = diffFleet(baseline([entry]), [liveRepo()]);
    expect(findings.map((f) => f.class).sort()).toEqual(["census-verdict-missing", "unexecuted-retirement"]);
  });
});

describe("diffFleet — freeze-violation", () => {
  it("does NOT flag a frozen repo whose last push precedes the verdict (negative control)", () => {
    const entry = baselineEntry({ verdict: "freeze", verdictAt: "2026-08-30T00:00:00Z" });
    const findings = diffFleet(baseline([entry]), [liveRepo({ pushedAt: "2026-07-01T00:00:00Z" })]);
    expect(findings).toEqual([]);
  });

  it("flags a frozen repo pushed AFTER the verdict", () => {
    const entry = baselineEntry({ verdict: "freeze", verdictAt: "2026-08-01T00:00:00Z" });
    const findings = diffFleet(baseline([entry]), [liveRepo({ pushedAt: "2026-08-15T12:00:00Z" })]);
    expect(findings).toHaveLength(1);
    expect(findings[0].class).toBe("freeze-violation");
    expect(findings[0].detail).toContain("2026-08-15T12:00:00Z");
    expect(findings[0].detail).toContain("frozen repo moved");
    expect(findings[0].baselineEdit).toBeNull();
  });

  it("does NOT fire for an archived frozen repo regardless of dates", () => {
    const entry = baselineEntry({ archived: true, verdict: "freeze", verdictAt: "2026-08-01T00:00:00Z" });
    const findings = diffFleet(baseline([entry]), [liveRepo({ isArchived: true, pushedAt: "2026-08-15T12:00:00Z" })]);
    expect(findings).toEqual([]);
  });
});

describe("diffFleet — census pass-through on accept lines", () => {
  it("a flip's UPDATE line carries the baseline row's census fields verbatim (accepting a flip must not strip the census)", () => {
    const entry = baselineEntry({ verdict: "manual-tax", class293: "Product", verdictAt: "2026-08-30T00:00:00Z", note: "deployed on studiob-platform" });
    const findings = diffFleet(baseline([entry]), [liveRepo({ visibility: "PRIVATE" })]);
    expect(findings).toHaveLength(1);
    const flip = findings[0];
    expect(flip.class).toBe("visibility-flip");
    expect(flip.baselineEdit).toContain('"class293":"Product"');
    expect(flip.baselineEdit).toContain('"verdict":"manual-tax"');
    expect(flip.baselineEdit).toContain('"verdictAt":"2026-08-30T00:00:00Z"');
    expect(flip.baselineEdit).toContain('"note":"deployed on studiob-platform"');
  });

  it("dual-flip resolve lines stay IDENTICAL with census fields present", () => {
    const entry = baselineEntry({ name: "dual", verdict: "manual-tax", class293: "Product" });
    const findings = diffFleet(baseline([entry]), [liveRepo({ name: "dual", isArchived: true, visibility: "PRIVATE" })]);
    const a = findings.find((f) => f.class === "archived-flip")!;
    const v = findings.find((f) => f.class === "visibility-flip")!;
    expect(a.baselineEdit).toBe(v.baselineEdit);
    expect(a.baselineEdit).toContain('"verdict":"manual-tax"');
  });

  it("a census-bare row's REMOVE line renders without census keys at all (v1-shape line survives)", () => {
    const entry = baselineEntry({ name: "bare-gone", class293: undefined, verdict: undefined, verdictAt: undefined });
    const findings = diffFleet(baseline([entry]), []);
    expect(findings[0].baselineEdit).toBe(
      'REMOVE this line from "repos": {"name":"bare-gone","archived":false,"visibility":"PUBLIC","pushedAtAtSeed":"2026-08-01T00:00:00Z"}',
    );
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
  it("with zero findings, every class still appears at =0", () => {
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

  it("prints every class name even when findings carry an unexpected count distribution", () => {
    const findings: Finding[] = FINDING_CLASSES.map((c, i) => ({ class: c, repo: `r${i}`, detail: "d", baselineEdit: null }));
    const line = summarizeFindings(findings);
    for (const cls of FINDING_CLASSES) expect(line).toContain(`${cls}=1`);
    expect(line).toContain(`total=${FINDING_CLASSES.length}`);
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

  // Live-verified 2026-08-14: studiob-fleet-bot's org installation carries only
  // issues:write + metadata:read (no Contents:read), so the commits endpoint 403s for
  // every repo today. Rule #464 — a finding class that can never fire must say so.
  it("does NOT print the bot-churn systemic-failure note when unset (negative control)", () => {
    const body = renderDriftIssueBody([], meta);
    expect(body).not.toContain("structurally degraded");
  });

  it("prints a loud bot-churn systemic-failure note when set, naming the Contents:read gap", () => {
    const body = renderDriftIssueBody([], {
      ...meta,
      botChurnSystemicFailure: { attempted: 7, firstError: "HTTP 403: Resource not accessible by integration" },
    });
    expect(body).toContain("structurally degraded");
    expect(body).toContain("Contents");
    expect(body).toContain("7 repo(s)");
    expect(body).toContain("HTTP 403: Resource not accessible by integration");
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

  it("renders census findings with their per-class resolution notes, never a mechanical Resolve line", () => {
    const findings: Finding[] = [
      { class: "census-verdict-missing", repo: "a", detail: "`a` census incomplete.", baselineEdit: null },
      { class: "unexecuted-retirement", repo: "b", detail: "`b` retire unexecuted.", baselineEdit: null },
      { class: "freeze-violation", repo: "c", detail: "`c` frozen repo moved.", baselineEdit: null },
    ];
    const body = renderDriftIssueBody(findings, meta);
    expect(body).toContain("Census verdict missing/invalid (1)");
    expect(body).toContain("Unexecuted retirement (kill-list tracker) (1)");
    expect(body).toContain("Freeze violation (1)");
    expect(body).toContain("values are decisions, not mechanical accepts");
    expect(body).toContain("EXECUTING the retirement");
    expect(body).toContain("investigating the push");
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

// ───────────────────────────── alertWorthyCount (codex pass 2, P2) ─────────────────────────────

describe("alertWorthyCount", () => {
  // Negative controls first.
  it("is 0 with zero findings and no systemic bot-churn failure", () => {
    expect(alertWorthyCount([], false)).toBe(0);
  });

  it("does not double-count — real findings alone, no systemic flag", () => {
    const findings: Finding[] = [{ class: "new-unmapped-repo", repo: "a", detail: "d", baselineEdit: "e" }];
    expect(alertWorthyCount(findings, false)).toBe(1);
  });

  it("adds exactly 1 for a systemic bot-churn failure, independent of the real findings count", () => {
    expect(alertWorthyCount([], true)).toBe(1);
    const findings: Finding[] = [
      { class: "new-unmapped-repo", repo: "a", detail: "d", baselineEdit: "e" },
      { class: "archived-flip", repo: "b", detail: "d", baselineEdit: "e" },
    ];
    expect(alertWorthyCount(findings, true)).toBe(3);
  });
});

// THE regression codex pass 2 caught: `planIssueAction(findings.length, ...)` alone let a
// fully-broken bot-churn leg (real findings genuinely zero) plan "none" and exit green
// forever — the degradation note in the body was written but never reached, because no
// issue ever opened to carry it. `alertWorthyCount` composed into `planIssueAction` fixes
// it; this test proves the exact wiring, not just each piece in isolation.
describe("alertWorthyCount + planIssueAction — the systemic bot-churn regression", () => {
  it("a fleet with ZERO real drift still OPENS the issue when bot-churn is systemically broken", () => {
    expect(planIssueAction(alertWorthyCount([], true), false)).toBe("open");
  });

  it("...and UPDATES (not closes) an already-open issue while the systemic failure persists, even with zero real findings", () => {
    expect(planIssueAction(alertWorthyCount([], true), true)).toBe("update");
  });

  it("only CLOSES once both real findings AND the systemic failure clear (negative control on the fix itself)", () => {
    expect(planIssueAction(alertWorthyCount([], false), true)).toBe("close");
  });

  it("does NOT open when both are clear and no issue exists (the ordinary quiet steady state)", () => {
    expect(planIssueAction(alertWorthyCount([], false), false)).toBe("none");
  });
});
