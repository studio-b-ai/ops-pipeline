/**
 * automerge-args.ts — CLI argument parsing for the runner (scripts/pr-automerge-gate.ts),
 * extracted to its own pure module so it gets real unit tests (codex P2 finding,
 * 2026-08-02 review: "runner wiring is under-tested... add direct runner tests or
 * export small pure helpers for argument parsing and enabled-class handling").
 *
 * Extracting this out of pr-automerge-gate.ts also sidesteps a real hazard: that
 * file calls `main().catch(...)` unconditionally at module scope, so importing it
 * directly from a test file would execute the whole gate against `process.argv`.
 * This module has no such side effect and is safe to import anywhere.
 */

import { ALL_PR_DIFF_CLASSES, type PrDiffClass } from "./automerge-classify.js";

export interface Args {
  repo: string;
  pr: number;
  /** Defaults to ["docs-comment"] — a caller that never passes this flag (e.g.
   *  studiob's existing, unmodified caller workflow) gets EXACTLY the original #279
   *  gate's scope. Opting into ci-infra/test-only is explicit, per repo. */
  enabledClasses: PrDiffClass[];
  /** Forwarded verbatim to classifyPrDiffClass's sensitivePathPatterns — for callers
   *  whose branch-protection gates aren't independently verifiable from
   *  statusCheckRollup (see the bolt-wms canary caller). */
  sensitivePathPatterns: string[];
}

export function parseArgs(argv: string[]): Args {
  let repo: string | undefined;
  let pr: number | undefined;
  let enabledClassesRaw: string | undefined;
  const sensitivePathPatterns: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") repo = argv[++i];
    else if (argv[i] === "--pr") pr = Number(argv[++i]);
    else if (argv[i] === "--enabled-classes") enabledClassesRaw = argv[++i];
    else if (argv[i] === "--sensitive-path") sensitivePathPatterns.push(argv[++i]);
  }
  if (!repo) throw new Error("--repo <org/repo> is required");
  if (!pr || !Number.isFinite(pr) || pr <= 0) throw new Error("--pr <n> is required");

  let enabledClasses: PrDiffClass[];
  if (enabledClassesRaw === undefined || enabledClassesRaw.trim() === "") {
    // Default MUST stay exactly ["docs-comment"] — this is what keeps every caller
    // that doesn't pass --enabled-classes (e.g. studiob's existing workflow) on the
    // original #279 gate's scope, unchanged by this file existing at all.
    enabledClasses = ["docs-comment"];
  } else {
    const requested = enabledClassesRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const invalid = requested.filter((c) => !ALL_PR_DIFF_CLASSES.includes(c as PrDiffClass));
    if (invalid.length > 0) {
      throw new Error(`--enabled-classes contains unknown class(es): ${invalid.join(", ")} (valid: ${ALL_PR_DIFF_CLASSES.join(", ")})`);
    }
    // Fail closed on an explicitly-empty-but-present list too (e.g. `--enabled-classes ","`
    // or all-whitespace entries) rather than silently defaulting OR silently enabling
    // nothing-then-everything — an empty requested set after filtering is a caller
    // misconfiguration, not "use the default".
    if (requested.length === 0) {
      throw new Error("--enabled-classes was provided but contained no valid class names");
    }
    enabledClasses = requested as PrDiffClass[];
  }

  return { repo, pr, enabledClasses, sensitivePathPatterns };
}
