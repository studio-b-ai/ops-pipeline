import { describe, expect, it } from "vitest";
import {
  classifyDiffFile,
  classifyPrDiffClass,
  gateDecision,
  gateDecisionForClass,
  isRollupClean,
  reconcileFileClasses,
  type GateFile,
  type GateInput,
  type GateInputV2,
  type ParsedDiffFile,
} from "../automerge-classify.js";

// A baseline "all legs pass" input, so each negative-control test flips exactly one
// leg to prove that leg alone gates the decision (Rule #322: negative controls first).
function baseInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    files: [{ path: "packages/api/src/routes/zoom-chat-relay.ts", fileClass: "comment-only" }],
    totalChangedLines: 2,
    author: "kbibelhausen",
    labels: ["bugsquasher"],
    ciClean: true,
    reviewVerdict: "CLEAN",
    ...overrides,
  };
}

describe("classifyDiffFile", () => {
  // ───── Negative controls first (Rule #322) ─────

  it("classifies a single code-class line as code", () => {
    expect(classifyDiffFile("packages/api/src/foo.ts", ["const x = 1;"], [])).toBe("code");
  });

  it("classifies an unknown-extension file as code (fail-closed)", () => {
    expect(classifyDiffFile("scripts/deploy.wat", ["some content"], [])).toBe("code");
  });

  it("classifies an extensionless file as code (fail-closed)", () => {
    expect(classifyDiffFile("Makefile", ["# a comment"], [])).toBe("code");
  });

  it("classifies a file with zero changed lines as code (nothing to verify)", () => {
    expect(classifyDiffFile("packages/api/src/foo.ts", [], [])).toBe("code");
  });

  it("classifies mixed comment+code lines in a .ts file as code", () => {
    expect(classifyDiffFile("packages/api/src/foo.ts", ["// a comment", "const x = 1;"], [])).toBe("code");
  });

  it("classifies a .py file with a real code line as code", () => {
    expect(classifyDiffFile("scripts/tool.py", ["x = compute()"], [])).toBe("code");
  });

  // ───── Positives ─────

  it("fail-closes the +1/-1 JSDoc-INTERIOR .ts shape (the proven studiob#401 diff) to code — post-pass-3 narrowing: interior lines are contextless, so this class now WAITS for a human by design", () => {
    const added = [" *   400  { ok: false, code: \"BODY_INVALID\" | \"QUERY_INVALID\", details: ... }"];
    const removed = [" *   400  { ok: false, code: \"BODY_INVALID\", details: ... }"];
    expect(classifyDiffFile("packages/api/src/routes/zoom-chat-relay.ts", added, removed)).toBe("code");
  });

  it("classifies a 3-line .md file as doc regardless of content", () => {
    expect(classifyDiffFile("docs/plans/2026-07-30-notes.md", ["anything at all", "even code-looking `const x = 1;`"], [])).toBe("doc");
  });

  it("classifies anything under docs/ as doc even without a .md extension", () => {
    expect(classifyDiffFile("docs/plans/notes.txt", ["free text"], [])).toBe("doc");
  });

  it("classifies a .py file with only # comment lines as comment-only", () => {
    expect(classifyDiffFile("scripts/tool.py", ["# updated comment"], ["# old comment"])).toBe("comment-only");
  });

  it("classifies a .yaml file with only # comment lines as comment-only", () => {
    expect(classifyDiffFile("infra/config.yaml", ["# new note"], [])).toBe("comment-only");
  });

  it("treats blank changed lines as harmless inside an otherwise comment-only file", () => {
    expect(classifyDiffFile("packages/api/src/foo.ts", ["// note", ""], ["// old note", ""])).toBe("comment-only");
  });

  it("classifies an .html file with only <!-- --> lines as comment-only", () => {
    expect(classifyDiffFile("public/page.html", ["<!-- updated banner -->"], ["<!-- old banner -->"])).toBe("comment-only");
  });

  // ───── binary-vs-doc-path ordering (codex P2 fix, 2026-07-30) ─────

  it("classifies a binary file under docs/ as code, NOT doc — binary always wins over path", () => {
    expect(classifyDiffFile("docs/assets/logo.png", [], [], { binary: true })).toBe("code");
  });

  it("classifies a binary .md file as code, NOT doc — binary always wins over path", () => {
    expect(classifyDiffFile("docs/notes.md", [], [], { binary: true })).toBe("code");
  });

  it("classifies a non-binary .md file as doc when opts.binary is explicitly false", () => {
    expect(classifyDiffFile("docs/notes.md", ["text"], [], { binary: false })).toBe("doc");
  });
});

describe("gateDecision", () => {
  // ───── Negative controls first (Rule #322): each flips exactly one leg ─────

  it("waits when a code-class file is present", () => {
    const files: GateFile[] = [{ path: "packages/api/src/foo.ts", fileClass: "code" }];
    const result = gateDecision(baseInput({ files }));
    expect(result.decision).toBe("wait");
    expect(result.reasons.some((r) => r.includes("code-class file"))).toBe(true);
  });

  it("waits when totalChangedLines exceeds 10 (11 lines)", () => {
    const result = gateDecision(baseInput({ totalChangedLines: 11 }));
    expect(result.decision).toBe("wait");
    expect(result.reasons.some((r) => r.includes("totalChangedLines"))).toBe(true);
  });

  it("waits when the bugsquasher label is missing", () => {
    const result = gateDecision(baseInput({ labels: [] }));
    expect(result.decision).toBe("wait");
    expect(result.reasons.some((r) => r.includes("label"))).toBe(true);
  });

  it("waits when the author is not kbibelhausen", () => {
    const result = gateDecision(baseInput({ author: "some-other-bot" }));
    expect(result.decision).toBe("wait");
    expect(result.reasons.some((r) => r.includes("author"))).toBe(true);
  });

  it("waits when CI is not clean", () => {
    const result = gateDecision(baseInput({ ciClean: false }));
    expect(result.decision).toBe("wait");
    expect(result.reasons.some((r) => r.includes("CI not clean"))).toBe(true);
  });

  it("waits when the independent review verdict is FLAG", () => {
    const result = gateDecision(baseInput({ reviewVerdict: "FLAG" }));
    expect(result.decision).toBe("wait");
    expect(result.reasons.some((r) => r.includes("review verdict"))).toBe(true);
  });

  it("waits and reports every failing leg when multiple legs fail simultaneously", () => {
    const result = gateDecision(baseInput({ author: "someone-else", ciClean: false, totalChangedLines: 20 }));
    expect(result.decision).toBe("wait");
    expect(result.reasons).toHaveLength(3);
  });

  // ───── Positives ─────

  it("merges the +1/-1 comment-only .ts shape (studiob#401) with all legs green", () => {
    const result = gateDecision(baseInput());
    expect(result.decision).toBe("merge");
    expect(result.reasons).toHaveLength(0);
  });

  it("merges a 3-line .md-only change with all legs green", () => {
    const files: GateFile[] = [{ path: "docs/plans/notes.md", fileClass: "doc" }];
    const result = gateDecision(baseInput({ files, totalChangedLines: 3 }));
    expect(result.decision).toBe("merge");
    expect(result.reasons).toHaveLength(0);
  });

  it("merges at exactly the 10-line boundary (inclusive)", () => {
    const result = gateDecision(baseInput({ totalChangedLines: 10 }));
    expect(result.decision).toBe("merge");
  });
});

// NOTE (false-positive exemption, Rule #141): every `status`/`conclusion` literal in
// this describe block is a GitHub Actions checkCheckRun / statusCheckRollup field (gh
// CLI JSON vocabulary: IN_PROGRESS/COMPLETED/QUEUED, SUCCESS/FAILURE/CANCELLED/...) —
// NOT a Postgres column, and unrelated to any sync_status-style DB enum. The
// postgres-enum-drift-guard hook's generic `\bstatus\b` regex collides with this
// unrelated GH vocabulary; every occurrence below carries its own
// `pg-enum-drift-exempt` marker per the hook's own override contract.
describe("isRollupClean", () => {
  // ───── Negative controls first (Rule #322) ─────

  it("is unclean with a legacy FAILURE state present", () => {
    expect(isRollupClean([{ state: "SUCCESS" }, { state: "FAILURE" }])).toBe(false);
  });

  it("is unclean with a legacy PENDING state present", () => {
    expect(isRollupClean([{ state: "PENDING" }])).toBe(false);
  });

  it("is unclean with an IN_PROGRESS check run", () => {
    // pg-enum-drift-exempt: GitHub Actions check-run status field, not a Postgres enum
    expect(isRollupClean([{ status: "IN_PROGRESS", conclusion: null }])).toBe(false);
  });

  it("is unclean with a COMPLETED check run whose conclusion is FAILURE", () => {
    // pg-enum-drift-exempt: GitHub Actions check-run status field, not a Postgres enum
    expect(isRollupClean([{ status: "COMPLETED", conclusion: "FAILURE" }])).toBe(false);
  });

  // ── Supersession (ops-pipeline#29) ────────────────────────────────────────────
  // Live shape from bolt-wms#1463: `require-review-label.yml` runs with
  // `cancel-in-progress: true`, and the PR was created WITH its label, so `opened`
  // was superseded by `labeled` ~20s later. GitHub reported the PR CLEAN; the gate
  // reported ciClean=false and declined a perfectly eligible PR — permanently, since
  // that CANCELLED entry never clears from the head commit.
  it("is CLEAN when a CANCELLED run is superseded by a newer SUCCESS of the same check (the #1463 shape)", () => {
    expect(
      isRollupClean([
        // pg-enum-drift-exempt: GitHub Actions check-run fields, not a Postgres enum
        { name: "Require review label", status: "COMPLETED", conclusion: "CANCELLED", completedAt: "2026-08-04T17:00:02Z" },
        { name: "Require review label", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-08-04T17:00:23Z" },
      ]),
    ).toBe(true);
  });

  it("is UNCLEAN when a CANCELLED run has no newer sibling (nothing superseded it)", () => {
    expect(
      // pg-enum-drift-exempt: GitHub Actions check-run fields, not a Postgres enum
      isRollupClean([{ name: "Require review label", status: "COMPLETED", conclusion: "CANCELLED", completedAt: "2026-08-04T17:00:02Z" }]),
    ).toBe(false);
  });

  // THE test that matters: de-duplication must never let a real failure hide behind
  // an older success of the same name.
  it("is UNCLEAN when a newer FAILURE supersedes an older SUCCESS of the same check", () => {
    expect(
      isRollupClean([
        // pg-enum-drift-exempt: GitHub Actions check-run fields, not a Postgres enum
        { name: "Server — TypeScript + Tests", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-08-04T17:00:02Z" },
        { name: "Server — TypeScript + Tests", status: "COMPLETED", conclusion: "FAILURE", completedAt: "2026-08-04T17:00:23Z" },
      ]),
    ).toBe(false);
  });

  it("is UNCLEAN when a re-run is still IN_PROGRESS even though the previous run of that check succeeded", () => {
    expect(
      isRollupClean([
        // pg-enum-drift-exempt: GitHub Actions check-run fields, not a Postgres enum
        { name: "Server — TypeScript + Tests", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-08-04T17:00:02Z" },
        { name: "Server — TypeScript + Tests", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-08-04T17:05:00Z" },
      ]),
    ).toBe(false);
  });

  it("is UNCLEAN when same-name entries TIE on timestamp and disagree (recency cannot arbitrate — fail closed)", () => {
    expect(
      isRollupClean([
        // pg-enum-drift-exempt: GitHub Actions check-run fields, not a Postgres enum
        { name: "flaky", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-08-04T17:00:00Z" },
        { name: "flaky", status: "COMPLETED", conclusion: "FAILURE", completedAt: "2026-08-04T17:00:00Z" },
      ]),
    ).toBe(false);
  });

  it("does NOT let a DIFFERENT check's newer success supersede another check's failure", () => {
    expect(
      isRollupClean([
        // pg-enum-drift-exempt: GitHub Actions check-run fields, not a Postgres enum
        { name: "lint", status: "COMPLETED", conclusion: "FAILURE", completedAt: "2026-08-04T17:00:02Z" },
        { name: "tests", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-08-04T17:00:23Z" },
      ]),
    ).toBe(false);
  });

  it("never groups unnamed entries together — two unkeyed items stay independent and both must be clean", () => {
    expect(
      isRollupClean([
        // pg-enum-drift-exempt: GitHub Actions check-run fields, not a Postgres enum
        { status: "COMPLETED", conclusion: "FAILURE", completedAt: "2026-08-04T17:00:02Z" },
        { status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-08-04T17:00:23Z" },
      ]),
    ).toBe(false);
  });

  it("de-duplicates legacy commit statuses by context too", () => {
    expect(
      isRollupClean([
        { context: "ci/legacy", state: "FAILURE", createdAt: "2026-08-04T17:00:02Z" },
        { context: "ci/legacy", state: "SUCCESS", createdAt: "2026-08-04T17:00:23Z" },
      ]),
    ).toBe(true);
  });

  it("is unclean with a COMPLETED check run whose conclusion is CANCELLED", () => {
    // pg-enum-drift-exempt: GitHub Actions check-run status field, not a Postgres enum
    expect(isRollupClean([{ status: "COMPLETED", conclusion: "CANCELLED" }])).toBe(false);
  });

  it("is unclean with an unrecognized item shape (fail-closed)", () => {
    expect(isRollupClean([{} as never])).toBe(false);
  });

  it("is unclean with an unrecognized legacy state value (allowlist regression, codex P1 fix)", () => {
    // Before the allowlist fix, any `state` value OUTSIDE the known-bad denylist
    // (including a brand-new GitHub value this function has never seen) fell through
    // to "clean" — the exact fail-open shape Rule #4 forbids.
    // pg-enum-drift-exempt: GitHub Actions check-run status field, not a Postgres enum
    expect(isRollupClean([{ state: "SOME_FUTURE_GITHUB_STATE" }])).toBe(false);
  });

  it("is unclean with a COMPLETED check run whose conclusion is null (allowlist regression, codex P1 fix)", () => {
    // Before the fix, `item.conclusion && UNCLEAN_CONCLUSIONS.has(...)` short-circuited
    // false on a null conclusion, skipping the "return false" branch entirely.
    // pg-enum-drift-exempt: GitHub Actions check-run status field, not a Postgres enum
    expect(isRollupClean([{ status: "COMPLETED", conclusion: null }])).toBe(false);
  });

  it("is unclean with a COMPLETED check run whose conclusion is missing entirely", () => {
    // pg-enum-drift-exempt: GitHub Actions check-run status field, not a Postgres enum
    expect(isRollupClean([{ status: "COMPLETED" }])).toBe(false);
  });

  // ───── Positives ─────

  it("is UNCLEAN with an empty rollup — no CI is not green CI (codex P3 fix)", () => {
    // "Full CI green" requires CI to exist: a repo with zero checks queues for a
    // human instead of vacuously passing the CI leg.
    expect(isRollupClean([])).toBe(false);
  });

  it("is clean with legacy SUCCESS states only", () => {
    expect(isRollupClean([{ state: "SUCCESS" }])).toBe(true);
  });

  it("is UNCLEAN with a legacy EXPECTED state — expected is not successful (codex pass-3 P2)", () => {
    expect(isRollupClean([{ state: "SUCCESS" }, { state: "EXPECTED" }])).toBe(false);
  });

  it("is clean with all COMPLETED check runs at SUCCESS/NEUTRAL/SKIPPED", () => {
    // pg-enum-drift-exempt: GitHub Actions check-run status field, not a Postgres enum
    const rollup = [
      // pg-enum-drift-exempt: GitHub Actions check-run status field, not a Postgres enum
      { status: "COMPLETED", conclusion: "SUCCESS" },
      // pg-enum-drift-exempt: GitHub Actions check-run status field, not a Postgres enum
      { status: "COMPLETED", conclusion: "NEUTRAL" },
      // pg-enum-drift-exempt: GitHub Actions check-run status field, not a Postgres enum
      { status: "COMPLETED", conclusion: "SKIPPED" },
    ];
    expect(isRollupClean(rollup)).toBe(true);
  });

  it("is clean with a mix of legacy and check-run shapes, all green", () => {
    // pg-enum-drift-exempt: GitHub Actions check-run status field, not a Postgres enum
    expect(isRollupClean([{ state: "SUCCESS" }, { status: "COMPLETED", conclusion: "SUCCESS" }])).toBe(true);
  });
});

describe("reconcileFileClasses", () => {
  // ───── Negative controls first (Rule #322) ─────

  it("fail-closes an authoritative path with NO parsed diff entry to code (rename/mode-only gap, codex P1 fix)", () => {
    // A pure rename or mode-only change produces zero content hunks — the diff parser
    // never emits it. Without reconciliation the gate's every-file leg would vacuously
    // pass over a file it never inspected.
    const out = reconcileFileClasses(["src/renamed-file.ts"], []);
    expect(out).toEqual([{ path: "src/renamed-file.ts", fileClass: "code" }]);
  });

  it("fail-closes a binary file to code even under docs/ (codex P2 fix)", () => {
    const out = reconcileFileClasses(["docs/diagram.png"], [{ path: "docs/diagram.png", added: [], removed: [], binary: true }]);
    expect(out).toEqual([{ path: "docs/diagram.png", fileClass: "code" }]);
  });

  it("fail-closes when the authoritative list has an extra file beyond the parsed set", () => {
    const out = reconcileFileClasses(
      ["README.md", "src/sneaky.ts"],
      [{ path: "README.md", added: ["hello"], removed: [] }],
    );
    expect(out.find((f) => f.path === "src/sneaky.ts")?.fileClass).toBe("code");
  });

  // ───── Positives ─────

  it("classifies matched entries normally (doc + comment-only)", () => {
    const out = reconcileFileClasses(
      ["README.md", "src/lib/thing.ts"],
      [
        { path: "README.md", added: ["some text"], removed: [] },
        { path: "src/lib/thing.ts", added: ["// clarified comment"], removed: ["// old comment"] },
      ],
    );
    expect(out).toEqual([
      { path: "README.md", fileClass: "doc" },
      { path: "src/lib/thing.ts", fileClass: "comment-only" },
    ]);
  });
});

describe("isStrictCommentLine via classifyDiffFile (block-comment suffix code, codex P2 fix)", () => {
  // ───── Negative controls first (Rule #322) ─────
  const ts = (line: string) => classifyDiffFile("src/x.ts", [line], []);

  it("rejects code after a closing block comment", () => {
    expect(ts("/* comment */ doEvil()")).toBe("code");
  });
  it("rejects code after a bare closer", () => {
    expect(ts("*/ doEvil()")).toBe("code");
  });
  it("rejects generator-method lines masquerading as continuation stars", () => {
    expect(ts("*method() {}")).toBe("code");
  });
  it("rejects multi-block lines even when they end with a closer", () => {
    expect(ts("/* a */ x() /* b */")).toBe("code");
  });
  it("rejects shebang lines — #! is behavioral, not a comment (codex pass-4 P2)", () => {
    expect(classifyDiffFile("run.sh", ["#!/bin/sh"], ["#!/usr/bin/env python3"])).toBe("code");
    expect(classifyDiffFile("run.py", ["#!/usr/bin/env python2"], [])).toBe("code");
  });

  it("still accepts normal hash comments", () => {
    expect(classifyDiffFile("conf.yaml", ["# tuned per 2026-07-31 load program"], [])).toBe("comment-only");
  });

  it("rejects html content after a closing marker", () => {
    expect(classifyDiffFile("page.html", ["<!-- c --> <script>x()</script>"], [])).toBe("code");
  });

  // ───── Positives ─────
  it("rejects ALL block-interior shapes — continuation/opener/closer are contextless (codex pass-3 P1)", () => {
    // `* method() {}` (spaced generator) is byte-identical to a JSDoc continuation;
    // without block context every interior shape is guessing → code, human queue.
    expect(ts("* method() {}")).toBe("code");
    expect(ts("* continuation text")).toBe("code");
    expect(ts("/* open block")).toBe("code");
    expect(ts("* ends the block */")).toBe("code");
    expect(ts("*/")).toBe("code");
    expect(classifyDiffFile("page.html", ["<!-- open comment"], [])).toBe("code");
  });

  it("accepts only line comments and complete single-line blocks", () => {
    expect(ts("// plain")).toBe("comment-only");
    expect(ts("/* one-line block */")).toBe("comment-only");
    expect(classifyDiffFile("page.html", ["<!-- pure comment -->"], [])).toBe("comment-only");
  });
});

// ───────────────────────────── gate v2: PR-level diff classes ─────────────────────────────
// Kevin-approved 2026-08-02 widening: ci-infra + test-only, alongside the unchanged
// docs-comment class. Negative controls first throughout (Rule #322).

describe("classifyPrDiffClass", () => {
  function files(paths: string[], fileClass: GateFile["fileClass"] = "code"): GateFile[] {
    return paths.map((path) => ({ path, fileClass }));
  }

  // ───── Negative controls first ─────

  it("resolves null (class-match) for an empty file list", () => {
    const result = classifyPrDiffClass({ files: [], totalChangedLines: 0 });
    expect(result.prClass).toBeNull();
    expect(result.failureLeg).toBe("class-match");
  });

  it("resolves null (class-match) for a mixed diff — a workflow file AND a test file together", () => {
    const result = classifyPrDiffClass({
      files: files([".github/workflows/ci.yml", "scripts/lib/__tests__/foo.test.ts"]),
      totalChangedLines: 5,
    });
    expect(result.prClass).toBeNull();
    expect(result.failureLeg).toBe("class-match");
  });

  it("resolves null (line-cap) for an otherwise-qualifying ci-infra diff at 41 lines", () => {
    const result = classifyPrDiffClass({ files: files([".github/workflows/ci.yml"]), totalChangedLines: 41 });
    expect(result.prClass).toBeNull();
    expect(result.failureLeg).toBe("line-cap");
    expect(result.reasons.some((r) => r.includes("ci-infra") && r.includes("totalChangedLines"))).toBe(true);
  });

  it("resolves null (line-cap) for an otherwise-qualifying test-only diff at 41 lines", () => {
    const result = classifyPrDiffClass({ files: files(["scripts/lib/__tests__/foo.test.ts"]), totalChangedLines: 41 });
    expect(result.prClass).toBeNull();
    expect(result.failureLeg).toBe("line-cap");
  });

  it("rejects a ci-infra-shaped diff with one src/** file present", () => {
    const result = classifyPrDiffClass({
      files: files([".github/workflows/ci.yml", "src/index.ts"]),
      totalChangedLines: 5,
    });
    expect(result.prClass).toBeNull();
    expect(result.reasons.some((r) => r.includes("src/**"))).toBe(true);
  });

  it("rejects a test-only-shaped diff with one src/** runtime file present", () => {
    const result = classifyPrDiffClass({
      files: files(["scripts/lib/__tests__/foo.test.ts", "src/foo.ts"]),
      totalChangedLines: 5,
    });
    expect(result.prClass).toBeNull();
    expect(result.reasons.some((r) => r.includes("src/** runtime file"))).toBe(true);
  });

  it("rejects a ci-infra-shaped diff with a package.json change (dependency change)", () => {
    const result = classifyPrDiffClass({
      files: files([".github/workflows/ci.yml", "package.json"]),
      totalChangedLines: 5,
    });
    expect(result.prClass).toBeNull();
    expect(result.reasons.some((r) => r.includes("package manifest/lockfile"))).toBe(true);
  });

  it("rejects a test-only-shaped diff with a lockfile change (dependency change)", () => {
    const result = classifyPrDiffClass({
      files: files(["scripts/lib/__tests__/foo.test.ts", "scripts/package-lock.json"]),
      totalChangedLines: 5,
    });
    expect(result.prClass).toBeNull();
    expect(result.reasons.some((r) => r.includes("package manifest/lockfile"))).toBe(true);
  });

  it("rejects a ci-infra-shaped diff touching a migration file", () => {
    const result = classifyPrDiffClass({
      files: files([".github/workflows/ci.yml", "db/migrations/0007_add_col.sql"]),
      totalChangedLines: 5,
    });
    expect(result.prClass).toBeNull();
    expect(result.reasons.some((r) => r.includes("migration"))).toBe(true);
  });

  it("rejects a test-only-shaped diff touching a migration file", () => {
    const result = classifyPrDiffClass({
      files: files(["scripts/lib/__tests__/foo.test.ts", "src/migrations/0007_add_col.ts"]),
      totalChangedLines: 5,
    });
    expect(result.prClass).toBeNull();
    expect(result.reasons.some((r) => r.includes("migration"))).toBe(true);
  });

  it("rejects a ci-infra path outside the workflows/actions allowlist (e.g. .circleci/config.yml)", () => {
    const result = classifyPrDiffClass({ files: files([".circleci/config.yml"]), totalChangedLines: 3 });
    expect(result.prClass).toBeNull();
  });

  it("rejects a non-yaml file inside .github/actions/ — executable code, not declarative config", () => {
    const result = classifyPrDiffClass({ files: files([".github/actions/foo/index.js"]), totalChangedLines: 3 });
    expect(result.prClass).toBeNull();
  });

  it("excludes any PR touching a caller-supplied sensitive path, regardless of an otherwise-qualifying shape", () => {
    const result = classifyPrDiffClass({
      files: files([".github/workflows/ci.yml"]),
      totalChangedLines: 3,
      sensitivePathPatterns: ["^\\.github/workflows/"],
    });
    expect(result.prClass).toBeNull();
    expect(result.failureLeg).toBe("class-match");
    expect(result.reasons.some((r) => r.includes("sensitive path"))).toBe(true);
  });

  it("fail-closes (never throws) on a malformed sensitivePathPatterns regex source", () => {
    // A caller misconfiguration (an invalid regex source) must NEVER throw out of
    // this function and must NEVER be silently ignored (treating it as "no
    // exclusion" would fail OPEN) — it resolves the same as a real sensitive-path
    // hit: prClass null, failureLeg class-match.
    expect(() =>
      classifyPrDiffClass({
        files: files([".github/workflows/ci.yml"]),
        totalChangedLines: 3,
        sensitivePathPatterns: ["(unclosed["],
      }),
    ).not.toThrow();
    const result = classifyPrDiffClass({
      files: files([".github/workflows/ci.yml"]),
      totalChangedLines: 3,
      sensitivePathPatterns: ["(unclosed["],
    });
    expect(result.prClass).toBeNull();
    expect(result.failureLeg).toBe("class-match");
    expect(result.reasons.some((r) => r.includes("invalid sensitivePathPatterns regex"))).toBe(true);
  });

  // ───── Positives ─────

  it("resolves docs-comment for the unchanged doc|comment-only shape at <=10 lines (regression: byte-identical to the original #279 gate)", () => {
    const result = classifyPrDiffClass({ files: [{ path: "docs/plans/notes.md", fileClass: "doc" }], totalChangedLines: 3 });
    expect(result).toEqual({ prClass: "docs-comment", failureLeg: null, reasons: [] });
  });

  it("resolves ci-infra for an all-workflow/action-yaml diff at exactly 40 lines (cap boundary, inclusive)", () => {
    const result = classifyPrDiffClass({
      files: files([".github/workflows/ci.yml", ".github/actions/foo/action.yml"]),
      totalChangedLines: 40,
    });
    expect(result).toEqual({ prClass: "ci-infra", failureLeg: null, reasons: [] });
  });

  it("resolves test-only for an all-test-file diff at exactly 40 lines (cap boundary, inclusive)", () => {
    const result = classifyPrDiffClass({
      files: files(["scripts/lib/__tests__/foo.test.ts", "vitest.config.ts"]),
      totalChangedLines: 40,
    });
    expect(result).toEqual({ prClass: "test-only", failureLeg: null, reasons: [] });
  });

  it("resolves test-only for a .spec.ts file", () => {
    const result = classifyPrDiffClass({ files: files(["src/foo.spec.ts"]), totalChangedLines: 5 });
    expect(result.prClass).toBe("test-only");
  });

  it("accepts a test-only diff touching src/__tests__/** — test-scoped, NOT a src/** runtime file", () => {
    const result = classifyPrDiffClass({ files: files(["src/__tests__/foo.test.ts"]), totalChangedLines: 5 });
    expect(result.prClass).toBe("test-only");
  });

  it("prefers docs-comment over ci-infra when a comment-only workflow-yaml edit fits both shapes and the (smaller) docs cap", () => {
    const result = classifyPrDiffClass({
      files: [{ path: ".github/workflows/ci.yml", fileClass: "comment-only" }],
      totalChangedLines: 4,
    });
    expect(result.prClass).toBe("docs-comment");
  });

  it("falls through to ci-infra when a comment-only workflow-yaml edit exceeds the docs cap but fits the ci-infra cap", () => {
    const result = classifyPrDiffClass({
      files: [{ path: ".github/workflows/ci.yml", fileClass: "comment-only" }],
      totalChangedLines: 25,
    });
    expect(result.prClass).toBe("ci-infra");
  });
});

describe("gateDecisionForClass", () => {
  function baseInputV2(overrides: Partial<GateInputV2> = {}): GateInputV2 {
    return {
      prClass: "ci-infra",
      author: "kbibelhausen",
      labels: ["bugsquasher"],
      ciClean: true,
      reviewVerdict: "CLEAN",
      ...overrides,
    };
  }

  // ───── Negative controls first ─────

  it("waits when prClass is not a recognized diff class (runtime allowlist guard, codex P2 fix, 2026-08-02) — a JS caller bypassing the TypeScript union must NOT reach merge", () => {
    // Simulates a value that TypeScript's PrDiffClass union would normally reject at
    // compile time but JS has no runtime enforcement of (JSON-parsed input, a future
    // refactor) — every OTHER leg here is green, so this guard is the ONLY thing
    // standing between an unrecognized class and "merge".
    const result = gateDecisionForClass(baseInputV2({ prClass: "totally-made-up-class" as unknown as GateInputV2["prClass"] }));
    expect(result.decision).toBe("wait");
    expect(result.reasons.some((r) => r.includes("not a recognized diff class"))).toBe(true);
  });

  it("waits when the author is not kbibelhausen", () => {
    const result = gateDecisionForClass(baseInputV2({ author: "someone-else" }));
    expect(result.decision).toBe("wait");
    expect(result.reasons.some((r) => r.includes("author"))).toBe(true);
  });

  it("waits when the bugsquasher label is missing", () => {
    const result = gateDecisionForClass(baseInputV2({ labels: [] }));
    expect(result.decision).toBe("wait");
    expect(result.reasons.some((r) => r.includes("label"))).toBe(true);
  });

  it("waits when CI is not clean", () => {
    const result = gateDecisionForClass(baseInputV2({ ciClean: false }));
    expect(result.decision).toBe("wait");
    expect(result.reasons.some((r) => r.includes("CI not clean"))).toBe(true);
  });

  it("waits when the independent review verdict is FLAG", () => {
    const result = gateDecisionForClass(baseInputV2({ reviewVerdict: "FLAG" }));
    expect(result.decision).toBe("wait");
    expect(result.reasons.some((r) => r.includes("review verdict"))).toBe(true);
  });

  it("waits and reports every failing leg when multiple legs fail simultaneously", () => {
    const result = gateDecisionForClass(baseInputV2({ author: "someone-else", ciClean: false }));
    expect(result.decision).toBe("wait");
    expect(result.reasons).toHaveLength(2);
  });

  // ───── Positives ─────

  it("merges for ci-infra with all universal legs green", () => {
    expect(gateDecisionForClass(baseInputV2())).toEqual({ decision: "merge", reasons: [] });
  });

  it("merges for test-only with all universal legs green", () => {
    expect(gateDecisionForClass(baseInputV2({ prClass: "test-only" }))).toEqual({ decision: "merge", reasons: [] });
  });

  it("merges for docs-comment with all universal legs green, IDENTICAL to the original gateDecision's result for the equivalent input (equivalence regression check)", () => {
    const v2 = gateDecisionForClass(baseInputV2({ prClass: "docs-comment" }));
    const v1 = gateDecision({
      files: [{ path: "docs/notes.md", fileClass: "doc" }],
      totalChangedLines: 3,
      author: "kbibelhausen",
      labels: ["bugsquasher"],
      ciClean: true,
      reviewVerdict: "CLEAN",
    });
    expect(v2.decision).toBe(v1.decision);
    expect(v2.reasons).toEqual(v1.reasons);
  });
});
