import { describe, expect, it } from "vitest";
import { classifyDiffFile, gateDecision, isRollupClean, type GateFile, type GateInput } from "../automerge-classify.js";

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

  it("classifies +1/-1 comment-only .ts (the proven studiob#401 shape) as comment-only", () => {
    const added = [" *   400  { ok: false, code: \"BODY_INVALID\" | \"QUERY_INVALID\", details: ... }"];
    const removed = [" *   400  { ok: false, code: \"BODY_INVALID\", details: ... }"];
    expect(classifyDiffFile("packages/api/src/routes/zoom-chat-relay.ts", added, removed)).toBe("comment-only");
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

  it("is unclean with a COMPLETED check run whose conclusion is CANCELLED", () => {
    // pg-enum-drift-exempt: GitHub Actions check-run status field, not a Postgres enum
    expect(isRollupClean([{ status: "COMPLETED", conclusion: "CANCELLED" }])).toBe(false);
  });

  it("is unclean with an unrecognized item shape (fail-closed)", () => {
    expect(isRollupClean([{} as never])).toBe(false);
  });

  // ───── Positives ─────

  it("is clean with an empty rollup", () => {
    expect(isRollupClean([])).toBe(true);
  });

  it("is clean with all legacy SUCCESS/EXPECTED states", () => {
    expect(isRollupClean([{ state: "SUCCESS" }, { state: "EXPECTED" }])).toBe(true);
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
