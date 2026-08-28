import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GITHUB_LABEL_DESCRIPTION_MAX, assertLabelDescription, isTransientGhFailure, withGhRetry } from "../github-issues.js";

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("assertLabelDescription (GitHub 100-char label description cap)", () => {
  it("accepts exactly the maximum", () => {
    const d = "x".repeat(GITHUB_LABEL_DESCRIPTION_MAX);
    expect(assertLabelDescription(d)).toBe(d);
  });
  it("rejects one over the maximum, naming the length", () => {
    const d = "x".repeat(GITHUB_LABEL_DESCRIPTION_MAX + 1);
    expect(() => assertLabelDescription(d)).toThrow(/101 chars; GitHub's maximum is 100/);
  });
});

/**
 * Source-level guard for the class ops-pipeline#136's first live firing exposed (2026-08-16):
 * label descriptions only reach `gh label create` on a worker's MUTATING path, so a too-long
 * literal passes every dry run and every unit test and 422s on the first real run. Scan every
 * worker's `LABEL_DESCRIPTION = "…"` constant and every inline `ensureLabel(…, "…", …)` literal.
 */
describe("worker label-description literals stay under GitHub's cap", () => {
  const files = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith(".ts"));
  const literals: Array<{ file: string; text: string }> = [];
  for (const f of files) {
    const src = readFileSync(join(SCRIPTS_DIR, f), "utf8");
    for (const m of src.matchAll(/LABEL_DESCRIPTION\s*=\s*"([^"]*)"/g)) literals.push({ file: f, text: m[1] });
    for (const m of src.matchAll(/ensureLabel\([^,\n]+,[^,\n]+,\s*"([^"]*)"/g)) literals.push({ file: f, text: m[1] });
  }
  it("finds the known literals (positive control — the scan is not blind)", () => {
    expect(literals.length).toBeGreaterThanOrEqual(5);
    expect(literals.some((l) => l.file === "backlog-staleness-worker.ts")).toBe(true);
  });
  it.each(literals.map((l) => [l.file, l.text] as const))("%s: %s", (_file, text) => {
    expect(text.length).toBeLessThanOrEqual(GITHUB_LABEL_DESCRIPTION_MAX);
  });
});

/**
 * Regression guard (ops-pipeline#146, 2026-08-16): an in-place UPDATE that only retitles +
 * comments leaves the issue BODY at its first-run table forever — a stale scope claim that reads
 * as current (Rule #355/#412). Every worker that retitles an open aggregate in place must also
 * rewrite its body in the same branch.
 */
describe("in-place issue updates rewrite the body, not just the title", () => {
  it("backlog-staleness-worker's update branch calls editIssueBody alongside retitleIssue", () => {
    const src = readFileSync(join(SCRIPTS_DIR, "backlog-staleness-worker.ts"), "utf8");
    const retitleAt = src.indexOf("retitleIssue(SELF_REPO, existingNum!, title)");
    expect(retitleAt).toBeGreaterThan(-1);
    const window = src.slice(retitleAt, retitleAt + 400);
    expect(window).toMatch(/editIssueBody\(SELF_REPO, existingNum!, body\)/);
    expect(window).toMatch(/commentIssue\(SELF_REPO, existingNum!, body\)/);
  });
});

/**
 * ops-pipeline#158 — transient-failure predicate, BOTH directions (Rule #322): a predicate
 * that only ever says "transient" would retry 4xx and break isOrgMember's 404 contract; one
 * that only ever says "not transient" makes withGhRetry a no-op. Error shapes mirror what
 * execFileSync actually throws: an Error whose `stderr` property carries gh's output.
 */
function ghError(stderr: string, message = "Command failed: gh"): Error {
  const err = new Error(message) as Error & { stderr?: string };
  err.stderr = stderr;
  return err;
}

describe("isTransientGhFailure", () => {
  it.each([
    ["HTTP 502 on stderr", ghError("gh: Bad Gateway (HTTP 502)")],
    ["HTTP 504 on stderr", ghError("gh: Gateway Timeout (HTTP 504)")],
    ["unicorn-page phrase (the 2026-08-17 incident shape)", ghError("gh: Sorry, but GitHub couldn't respond to your request in time.")],
    ["ECONNRESET in message", new Error("request to https://api.github.com failed, reason: read ECONNRESET")],
    ["ETIMEDOUT on stderr", ghError("connect ETIMEDOUT 140.82.112.6:443")],
  ])("transient: %s", (_name, err) => {
    expect(isTransientGhFailure(err)).toBe(true);
  });

  it.each([
    ["HTTP 404 (isOrgMember's not-a-member contract)", ghError("gh: Not Found (HTTP 404)")],
    ["HTTP 422 (validation — e.g. label description too long)", ghError("gh: Validation Failed (HTTP 422)")],
    ["HTTP 403 (auth/rate-limit)", ghError("gh: Resource not accessible by integration (HTTP 403)")],
    ["plain error with no HTTP shape", new Error("Unexpected token in JSON at position 0")],
    ["non-Error throw", "something went wrong"],
  ])("NOT transient: %s", (_name, err) => {
    expect(isTransientGhFailure(err)).toBe(false);
  });
});

/**
 * ops-pipeline#158 — bounded-retry behavior via the injectable sleep/attempts seam. The first
 * case is the fault-injected positive control (Rules #464/#471): a planted 504 that clears on
 * the third attempt must produce a SUCCESS, proving the retry path actually executes rather
 * than existing as dead code.
 */
describe("withGhRetry", () => {
  const noSleep = { sleep: () => {} };

  it("planted 504 twice, success on the third attempt → returns the value (positive control)", () => {
    let calls = 0;
    const result = withGhRetry(() => {
      calls++;
      if (calls < 3) throw ghError("gh: Gateway Timeout (HTTP 504)");
      return "recovered";
    }, noSleep);
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("persistent transient failure → throws the ORIGINAL error after exactly 3 attempts", () => {
    let calls = 0;
    let caught: unknown;
    try {
      withGhRetry(() => {
        calls++;
        throw ghError("gh: Bad Gateway (HTTP 502)");
      }, noSleep);
    } catch (err) {
      caught = err;
    }
    // The HTTP status rides execFileSync's `stderr` property, not the message — assert the
    // rethrow preserves the original error object callers (e.g. isOrgMember) inspect.
    expect((caught as { stderr?: string }).stderr).toContain("HTTP 502");
    expect(calls).toBe(3);
  });

  it("non-transient failure (HTTP 404) → thrown immediately, exactly 1 attempt — the never-retry-4xx guarantee", () => {
    let calls = 0;
    let caught: unknown;
    try {
      withGhRetry(() => {
        calls++;
        throw ghError("gh: Not Found (HTTP 404)");
      }, noSleep);
    } catch (err) {
      caught = err;
    }
    expect((caught as { stderr?: string }).stderr).toContain("HTTP 404");
    expect(calls).toBe(1);
  });

  it("backoff between attempts is jittered into the 1–5 s band", () => {
    const sleeps: number[] = [];
    expect(() =>
      withGhRetry(() => {
        throw ghError("gh: Bad Gateway (HTTP 502)");
      }, { sleep: (ms) => sleeps.push(ms) }),
    ).toThrow();
    expect(sleeps).toHaveLength(2); // 3 attempts → 2 backoffs
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThanOrEqual(1000);
      expect(ms).toBeLessThan(5000);
    }
  });

  it("success on the first attempt → no sleep at all", () => {
    const sleeps: number[] = [];
    const result = withGhRetry(() => 42, { sleep: (ms) => sleeps.push(ms) });
    expect(result).toBe(42);
    expect(sleeps).toHaveLength(0);
  });

  it("attempts above the contract ceiling are clamped to 3 (codex review pass 1 P2)", () => {
    let calls = 0;
    expect(() =>
      withGhRetry(() => {
        calls++;
        throw ghError("gh: Bad Gateway (HTTP 502)");
      }, { ...noSleep, attempts: 99 }),
    ).toThrow();
    expect(calls).toBe(3);
  });

  it("attempts of 0 clamps up to 1 — the call always runs at least once", () => {
    let calls = 0;
    expect(() =>
      withGhRetry(() => {
        calls++;
        throw ghError("gh: Bad Gateway (HTTP 502)");
      }, { ...noSleep, attempts: 0 }),
    ).toThrow();
    expect(calls).toBe(1);
  });
});

/**
 * ops-pipeline#158 — structural guards. (a) MUTATORS must never ride withGhRetry (a 5xx can
 * arrive after the server committed the write; a retry then mints a duplicate issue/comment) —
 * scan each mutator's body for the wrapper. (b) The crossrepo sweep's three per-unit
 * listIssueComments preludes must carry the transient-degrade wrap, or one bad thread aborts
 * the whole fleet sweep again. Both scans carry positive controls so they can't go blind
 * (Rule #322/#401).
 */
describe("retry surface stays reads-only (source guards)", () => {
  const libSrc = readFileSync(join(SCRIPTS_DIR, "lib", "github-issues.ts"), "utf8");

  function functionBody(src: string, name: string): string {
    const at = src.indexOf(`export function ${name}`);
    expect(at).toBeGreaterThan(-1);
    const next = src.indexOf("\nexport ", at + 1);
    return src.slice(at, next === -1 ? undefined : next);
  }

  it.each(["ensureLabel", "openIssue", "closeIssue", "commentIssue", "retitleIssue", "editIssueBody", "removeLabel"])(
    "mutator %s does NOT call withGhRetry",
    (name) => {
      expect(functionBody(libSrc, name)).not.toContain("withGhRetry(");
    },
  );

  it.each(["listIssuesByLabel", "listIssueComments", "getCommentReactions", "isOrgMember"])(
    "read helper %s DOES call withGhRetry (positive control — the scan sees the wrapper)",
    (name) => {
      expect(functionBody(libSrc, name)).toContain("withGhRetry(");
    },
  );

  it("needs-human-crossrepo wraps all three per-unit comment reads in the transient degrade", () => {
    const sweepSrc = readFileSync(join(SCRIPTS_DIR, "needs-human-crossrepo.ts"), "utf8");
    const commentCalls = sweepSrc.match(/listIssueComments\(/g) ?? [];
    expect(commentCalls).toHaveLength(3); // positive control: the scan still finds every site
    const degrades = sweepSrc.match(/if \(!isTransientGhFailure\(err\)\) throw err;/g) ?? [];
    expect(degrades).toHaveLength(3);
    expect(sweepSrc).toContain("transient-unit-skips");
  });

  it("recall enumeration and the authoritative twin list-scan ride withGhRetry (codex pass 2 P2 + pass 3 P1)", () => {
    const sweepSrc = readFileSync(join(SCRIPTS_DIR, "needs-human-crossrepo.ts"), "utf8");
    // The two RETRIED sweep-side reads, by label — and exactly two withGhRetry sites, so a
    // future mutator can't quietly pick up the wrapper here without this scan noticing.
    expect(sweepSrc).toContain("label: `twin list-scan ${target}`");
    expect(sweepSrc).toContain("label: `recall search ${repo}`");
    expect(sweepSrc.match(/withGhRetry\(/g) ?? []).toHaveLength(2);
    // Pass 3 P1: recall enumeration must FAIL THE RUN after retries — the old degrade-to-[]
    // catch ("will retry next run") silently skipped a whole repo's recall pass.
    expect(sweepSrc).not.toContain("recall-pass search failed");
    // Pass 3 P2 as corrected by pass 4 P2: list-scan transient exhaustion is counted in
    // findTwin, gated on check-failed actually becoming the unit's outcome — never inside
    // twinCandidatesViaList's catch, where a search-index hit would still resolve the unit
    // normally while falsely marking the run degraded.
    expect(sweepSrc).toContain("transient: isTransientGhFailure(err)");
    expect(sweepSrc).toContain("if (listResult.transient) unitSkipsTransient++;");
    expect(sweepSrc).not.toContain("if (isTransientGhFailure(err)) unitSkipsTransient++;");
  });
});
