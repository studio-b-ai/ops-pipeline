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
  /** ops#190 rung A2: when true the runner evaluates the A-side `train:ready`
   *  label-authority gate (`evaluateTrainReady`) instead of the B-side squasher
   *  diff-classification gate. The two gates are structurally separate (doc §3.1 vs
   *  §4) and take disjoint configuration, so `--train-ready` is mutually exclusive
   *  with the squasher-only flags (`--enabled-classes`, `--sensitive-path`) —
   *  combining them is a caller misconfiguration and throws rather than silently
   *  ignoring half the invocation. */
  trainReady: boolean;
}

export function parseArgs(argv: string[]): Args {
  let repo: string | undefined;
  let pr: number | undefined;
  let enabledClassesRaw: string | undefined;
  let trainReady = false;
  const sensitivePathPatterns: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") repo = argv[++i];
    else if (argv[i] === "--pr") pr = Number(argv[++i]);
    else if (argv[i] === "--enabled-classes") enabledClassesRaw = argv[++i];
    else if (argv[i] === "--train-ready") trainReady = true;
    else if (argv[i] === "--sensitive-path") {
      // Trim before storing (codex P2 finding, 2026-08-02 pass 2): the reusable
      // workflow's caller-facing input is a single comma-separated string
      // (`sensitive_path_patterns: "a,b,c"`) that the workflow's bash step splits
      // on comma WITHOUT trimming — a normal-looking input like "a, b" arrives
      // here as the literal string " b" (leading space). An untrimmed regex
      // SOURCE with a leading space would only ever match a path that itself
      // starts with a literal space character — i.e. never — silently making that
      // exclusion entry permanently inert. sensitivePathPatterns is a fail-closed
      // escape hatch (classifyPrDiffClass's `sensitivePathPatterns`), so a
      // silently-inert entry is a silent SAFETY REGRESSION, not a cosmetic bug.
      // A whitespace-only entry (e.g. a trailing comma) is dropped entirely
      // rather than compiled — RegExp("") matches every path, which would
      // exclude EVERYTHING from classification (safe direction, but almost
      // certainly not what the caller meant) — cleaner to just ignore it.
      const trimmed = argv[++i]?.trim();
      if (trimmed) sensitivePathPatterns.push(trimmed);
    }
  }
  if (!repo) throw new Error("--repo <org/repo> is required");
  if (!pr || !Number.isFinite(pr) || pr <= 0) throw new Error("--pr <n> is required");

  // Mutual exclusion (see the `trainReady` field doc): an invocation naming BOTH
  // gates is ambiguous — fail loud (#161) instead of picking one and silently
  // ignoring the other's flags. Presence is what matters, not validity: even
  // `--enabled-classes docs-comment` (the default value, explicitly passed)
  // combined with --train-ready signals a confused caller.
  if (trainReady && (enabledClassesRaw !== undefined || sensitivePathPatterns.length > 0)) {
    throw new Error(
      "--train-ready is mutually exclusive with --enabled-classes/--sensitive-path " +
        "(A-side label-authority gate vs B-side squasher gate — one invocation evaluates exactly one)",
    );
  }

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

  return { repo, pr, enabledClasses, sensitivePathPatterns, trainReady };
}
