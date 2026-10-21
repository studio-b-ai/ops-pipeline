/**
 * squasher-fleet-canonical.ts — Mechanic crew stint #380 (2026-09-15). The pure
 * decision half of `scripts/squasher-fleet-canonical-check.ts`; no I/O lives here.
 *
 * WHY THIS GUARD EXISTS — the live defect it closes:
 * `scripts/squasher-fleet.json` carried BOTH `studio-b-ai/roundhouse` (a GitHub
 * redirect — the repo was renamed 8/30) AND `studio-b-ai/lightsout` (the canonical
 * name) as separate registry entries for the SAME repo. Proven live from the deployed
 * ref (Rule #466): `gh api repos/studio-b-ai/roundhouse --jq .name` => "lightsout",
 * and the positive control (Rule #322) `gh pr list --repo studio-b-ai/roundhouse`
 * returned lightsout's open PR verbatim. The fleet sweep enumerates EVERY registry
 * entry and calls `gh pr list --repo "$repo"`, so each open lightsout PR was fanned
 * out TWICE under two different gate configs — PER_REPO_CAP applied per registry
 * STRING (lightsout silently got 2x its fanout share, the starvation class the cap
 * exists to prevent), and the stale entry's EMPTY `sensitive_path_patterns` armed a
 * latent floor gap the day the repo gains a `.github/actions/` path.
 *
 * The fix deleted the stale row. THIS guard is the class closure (Rules #159/#381):
 * a registry entry whose repo string is not the repo's GitHub-canonical name is
 * ALWAYS drift — a rename, a transfer, or a deletion — and exactly one assert
 * (`gh api repos/<entry> --jq .full_name`, compared case-insensitively to the entry
 * string) catches every future instance of it. The stint prescribed `.name != <r>`;
 * this compares `.full_name` instead, which is the same assert for same-org renames
 * and additionally catches an owner move (`org` drift), which `.name` alone cannot
 * see. GitHub serves the old name via redirect indefinitely, so NOTHING else in the
 * fleet fails when a rename lands — every consumer keeps working through the
 * redirect while the registry rots. That is why the probe must resolve the
 * canonical identity rather than probe reachability: a reachable-but-renamed entry
 * is precisely the defect.
 *
 * ── LAW: READ-ONLY, FLAGS ONLY ──────────────────────────────────────────────────
 * Same law as its sibling detectors (repo-hygiene-worker, door-watch-coherence):
 * this lib and its caller NEVER edit the registry, never rename anything, never
 * touch a PR or issue. Findings are printed for a human; the fix is a human edit
 * to `scripts/squasher-fleet.json` (a declared sensitive path — Kevin's box).
 *
 * ── WHY A SCHEDULED-WORKER LEG, NOT A PR CHECK ──────────────────────────────────
 * The drift vector is a rename in GitHub's UI — NO pull request in this repo is
 * involved, so a `pull_request` gate structurally cannot catch the class (the same
 * reasoning door-watch-coherence-check.ts's header lays out for live-state
 * detectors: checkout-decidable invariants gate PRs; live-state probes ride the
 * scheduled fleet-App-token worker). The caller therefore runs as a leg of
 * `.github/workflows/repo-hygiene.yml`, whose minted `studiob-fleet-bot`
 * installation token holds `metadata:read` org-wide — sufficient for
 * `GET /repos/{owner}/{repo}` on every entry, redirects included.
 *
 * FAIL-CLOSED SEMANTICS (Rule #465 — a predicate that cannot see its population
 * must not report a clean zero): a per-entry probe error (404/410 — repo gone) is
 * DRIFT and reported as a finding; but when EVERY probe fails, the instrument
 * itself is broken (no gh, no auth, network down) and the caller must exit 2
 * ("could not run"), never 1-with-findings and never 0.
 */

export interface CanonicalProbe {
  /** The registry entry string, e.g. "studio-b-ai/roundhouse". */
  entry: string;
  /** The resolved canonical `full_name` from `gh api repos/<entry>`, or null on probe error. */
  canonicalFullName: string | null;
  /** The probe error text when canonicalFullName is null (e.g. the gh stderr). */
  probeError: string | null;
}

export type CanonicalDriftClass = "renamed-or-moved" | "unresolvable";

export interface CanonicalDriftFinding {
  entry: string;
  class: CanonicalDriftClass;
  detail: string;
}

export interface CanonicalScanResult {
  findings: CanonicalDriftFinding[];
  /** True when EVERY probe errored — the instrument is blind, not the registry dirty. */
  systemicFailure: boolean;
  probedCount: number;
}

/**
 * decideCanonicalDrift — the one pure decision. `probes` MUST cover the registry's
 * full population (the caller builds one probe per entry, no filtering — a partial
 * population makes a clean result a blind instrument, Rule #465).
 */
export function decideCanonicalDrift(probes: CanonicalProbe[]): CanonicalScanResult {
  const findings: CanonicalDriftFinding[] = [];
  let errorCount = 0;
  for (const p of probes) {
    if (p.canonicalFullName === null) {
      errorCount += 1;
      findings.push({
        entry: p.entry,
        class: "unresolvable",
        detail:
          `registry entry "${p.entry}" could not be resolved via gh api repos/${p.entry} ` +
          `(${p.probeError ?? "unknown probe error"}). The repo is deleted, renamed past redirect, ` +
          `or the token cannot see it — either way the sweep's per-entry gh calls are failing on ` +
          `this row. Remove or correct the entry in scripts/squasher-fleet.json.`,
      });
      continue;
    }
    if (p.canonicalFullName.toLowerCase() !== p.entry.toLowerCase()) {
      findings.push({
        entry: p.entry,
        class: "renamed-or-moved",
        detail:
          `registry entry "${p.entry}" resolves to canonical repo "${p.canonicalFullName}" — the ` +
          `entry is a GitHub redirect, not the repo's name. Every sweep pass enumerates this repo ` +
          `twice (once per spelling) under two gate configs: PER_REPO_CAP is applied per registry ` +
          `string (double fanout share) and the stale row's gate inputs may under-protect paths the ` +
          `canonical row guards. Rename the entry to "${p.canonicalFullName}" in ` +
          `scripts/squasher-fleet.json (a sensitive path — Kevin's box).`,
      });
    }
  }
  return {
    findings,
    systemicFailure: probes.length > 0 && errorCount === probes.length,
    probedCount: probes.length,
  };
}

export function summarizeCanonicalScan(result: CanonicalScanResult): string {
  if (result.systemicFailure) {
    return `COULD NOT RUN — all ${result.probedCount} canonical-name probe(s) errored; the instrument is blind (auth? gh? network?), NOT the registry dirty (Rule #465).`;
  }
  if (result.findings.length === 0) {
    return `OK — all ${result.probedCount} registry entr${result.probedCount === 1 ? "y is" : "ies are"} the repo's GitHub-canonical name.`;
  }
  return `DRIFT — ${result.findings.length} of ${result.probedCount} registry entries are not the repo's GitHub-canonical name.`;
}
