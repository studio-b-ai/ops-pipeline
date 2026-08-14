/**
 * needs-human-authorization.ts — shared reactor-authorization check for the needs-human
 * router (needs-human-router.ts, ops-pipeline#66) AND the cross-repo sweep
 * (needs-human-crossrepo.ts, ops-pipeline#88, chip A deliverable). Extracted from
 * needs-human-router.ts's original inline AUTHORIZED_REACTORS/isAuthorizedReactor (PR
 * #91) so both consumers share ONE authorization definition instead of two copies that
 * can drift apart — same allowlist, same org-membership fallback, same per-run cache
 * shape. Behavior is byte-identical to the PR #91 original; only the location moved.
 *
 * This file does real I/O (isOrgMember hits the GitHub API) — deliberately NOT folded
 * into needs-human-router-lib.ts, whose own header comment commits that file to zero
 * I/O, mirroring every other pure reconcile lib in this repo (credential-reconcile.ts,
 * gateway-token-reconcile.ts, railway-volume-reconcile.ts, needs-human-crossrepo-lib.ts).
 */

import { isOrgMember } from "./github-issues.js";

const ORG = "studio-b-ai";

/**
 * Plant-ladder finding (bolt-wms run 31780796895, 2026-08-14 — the live resolution of the
 * codex pass-3 P1 flagged in lib/github-issues.ts's isOrgMember): kbibelhausen's org
 * membership is PRIVATE, and the workflow's repo-scoped GITHUB_TOKEN receives a clean
 * HTTP 404 from `orgs/{org}/members/{login}` for private memberships — indistinguishable
 * from genuine non-membership, exactly the feared direction. The planted 👎 was therefore
 * (correctly, per isOrgMember's contract) treated as unauthorized and the brake did not
 * fire; the router degraded to the conservative HOLD, not a misroute — fail-safe held.
 *
 * The fix that needs NO org visibility at all: a static allowlist of authorized reactor
 * logins, checked FIRST. The org-membership probe stays as the fallback for logins not
 * listed (a future member with PUBLIC membership is still recognized with zero config).
 * The at-scale fix for private memberships remains the read:org PAT documented in
 * isOrgMember — deliberately NOT minted for a one-human org (Rule #60: consumption
 * machinery before more credentials; Rule #203: mechanism over measurement).
 */
export const AUTHORIZED_REACTORS = new Set(["kbibelhausen"]);

/**
 * Builds a per-run authorized-reactor checker: AUTHORIZED_REACTORS first, falling back to
 * a cached org-membership probe for anyone not listed. Each call returns a FRESH cache (a
 * `Map` closed over by the returned function) — callers invoke this ONCE per script run
 * (mirroring needs-human-router.ts's former per-run module-level `orgMemberCache`
 * exactly), so two independently-scheduled scripts (or one script's two passes) never
 * share a cache that could go stale mid-run or leak across runs.
 */
export function createAuthorizedReactorChecker(): (login: string) => boolean {
  const orgMemberCache = new Map<string, boolean>();
  return function isAuthorizedReactor(login: string): boolean {
    if (AUTHORIZED_REACTORS.has(login)) return true;
    const cached = orgMemberCache.get(login);
    if (cached !== undefined) return cached;
    const result = isOrgMember(ORG, login);
    orgMemberCache.set(login, result);
    return result;
  };
}
