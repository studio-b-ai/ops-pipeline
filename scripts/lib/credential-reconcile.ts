/**
 * credential-reconcile.ts — the absent-entity orphan sweep for credential-expiry-monitor.ts
 * (ops-pipeline#74, design approved by Kevin 2026-08-14 — see the issue's design comment,
 * unblocked once ops#71's Leg 1 sweep proved out live: 11 runs, all controls held).
 *
 * Origin: the SAME class of gap as gateway #37 and volume #71 — the per-credential reconcile
 * loop in credential-expiry-monitor.ts's `main()` iterates `credentials.manifest.yaml` ITEMS
 * ONLY (`openByEntity` is read but never swept against), so a credential REMOVED from the
 * manifest (rotated off, decommissioned, migrated to a keyless alternative) leaves its open
 * `credential-monitor` issue orphaned forever — the close path only runs when the SAME
 * credential is probed again, which a removed credential never is (`NPM_TOKEN-clients`,
 * removed 2026-06-10, is the live example shape named in the issue).
 *
 * Which proven pattern this ports: this monitor is the SIMPLEST instance of the class, and it
 * ports as the gateway-style NAME-IN-SET sweep (`gateway-token-reconcile.ts`'s
 * `orphanedStragglerIssues` shape) applied over the severity-title parse
 * (`parseSeverityTitle("credential-monitor", …)`) — NOT `railway-volume-reconcile.ts`'s
 * three-way (keep / close-absent / close-unprobed) machinery. This is the mirror of that
 * file's own Rule #109 note, in the OPPOSITE direction: no keep-blind, no prefix resolution,
 * no UUID-suffix discriminator, no truncation guard, no duplicate-name guard — none of THEIR
 * preconditions exist here, because none of their reasons for existing apply to a manifest:
 *
 *   - keep-blind / truncation guards exist because Railway's project/volume fetch can fail or
 *     paginate mid-run, so "absent from what we saw this run" can mean either "genuinely gone"
 *     or "we didn't see far enough" — two different things Railway's API forces the caller to
 *     tell apart. `credentials.manifest.yaml` is a LOCAL FILE, read once, in full, via
 *     `readFileSync` (and `main()` already throws before this module is ever reached if the
 *     manifest is empty or unreadable) — there is no partial read, no pagination, no fetch that
 *     can fail independently of the whole run already having failed. Absent from the manifest
 *     names this run built IS "genuinely gone" — always, unconditionally.
 *   - prefix resolution / UUID-suffix discrimination exist because a Railway volume-entity key
 *     is a COMPOUND string (`project/environment/service/volume [instanceId]`) built from
 *     multiple independently-renameable parts, so matching requires resolving which live
 *     project a stale-titled issue's entity segment belongs to. A credential manifest entry's
 *     `name` is ONE flat string and IS the entity — there is nothing to decompose or resolve.
 *   - a manifest RENAME is not a special case to guard against here the way a Railway PROJECT
 *     rename is: this sweep closing the old name's issue as "no longer monitored" is the
 *     CORRECT outcome (the old name genuinely left the monitored set), not a false-close — the
 *     new name, if still alert-worthy, opens its own fresh issue via the normal per-credential
 *     reconcile loop in credential-expiry-monitor.ts, exactly like a real removal would.
 *
 * Decision logic only — zero I/O, mirroring the reconcile/caller split used throughout this
 * repo's monitors (gateway-token-reconcile.ts, railway-volume-reconcile.ts).
 */

import { parseSeverityTitle } from "./severity-issue-reconcile.js";

const LABEL = "credential-monitor";

export interface CredentialSweepIssue {
  number: number;
  title: string;
  state: string;
}

export interface CredentialSweepAction {
  number: number;
  title: string;
  entity: string;
}

export interface CredentialSweepOutcome {
  actions: CredentialSweepAction[];
}

/**
 * Batch sweep over every OPEN `credential-monitor` issue. Global guard FIRST (mirrors
 * `railway-volume-reconcile.ts`'s `sweepAbsentEntityIssues`'s `probedOkProjects.size === 0`
 * guard, ported): `manifestNames.size === 0` → the WHOLE sweep no-ops. `main()` in
 * credential-expiry-monitor.ts already throws before it ever builds an empty manifest-names set
 * (`if (items.length === 0) throw ...`), but this pure function must not TRUST its caller to
 * have checked that — an empty set reaching this sweep on some future call path would classify
 * EVERY open `credential-monitor` issue as an orphan and close all of them in one run, a
 * close-all exactly like the guard it mirrors exists to prevent.
 *
 * Per issue:
 *   - `state !== "OPEN"` → skip (a closed issue has no orphan state left to resolve).
 *   - Title doesn't parse under `parseSeverityTitle(LABEL, …)` → skip, silently. Covers both a
 *     human-filed issue under the label (no ` — <status>` suffix) and a title carrying a
 *     DIFFERENT label entirely (e.g. `[volume-monitor] …` — `parseSeverityTitle` requires an
 *     exact `[credential-monitor] ` prefix, so a foreign-label title never even reaches the
 *     entity check). This sweep only ever acts on titles its own monitor built.
 *   - Parsed entity IN `manifestNames` → skip. This is where PROBE_FAILED disjointness comes
 *     from: a probe-failing credential is still an ITEM in the manifest, so its name is still in
 *     `manifestNames`, and the per-credential loop in credential-expiry-monitor.ts (which owns
 *     every entity that IS in the manifest) keeps/retitles its issue as usual. This sweep and
 *     that loop are therefore disjoint by construction — proven by the mixed-fixture test below.
 *   - Parsed entity NOT in `manifestNames` → sweep action (the orphan).
 *
 * Exact-match `Set.has` membership only (Rule #315's spirit) — no prefix/fuzzy logic: an issue
 * entity that is merely a string-prefix of a name still IN the manifest is NOT rescued by that
 * resemblance. The issue's own name left the set; it is gone.
 */
export function sweepUnmonitoredCredentialIssues(
  issues: CredentialSweepIssue[],
  manifestNames: Set<string>,
): CredentialSweepOutcome {
  if (manifestNames.size === 0) {
    return { actions: [] };
  }

  const actions: CredentialSweepAction[] = [];
  for (const issue of issues) {
    if (issue.state !== "OPEN") continue;
    const parsed = parseSeverityTitle(LABEL, issue.title);
    if (!parsed) continue; // unparseable (human-filed, or a foreign label) — keep, silently.
    if (manifestNames.has(parsed.entity)) continue; // still monitored — the main loop owns it.
    actions.push({ number: issue.number, title: issue.title, entity: parsed.entity });
  }
  return { actions };
}
