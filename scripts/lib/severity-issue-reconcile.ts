/**
 * severity-issue-reconcile.ts — generic per-entity multi-severity issue reconcile, shared by
 * railway-volume-monitor.ts (OK/WARN/CRITICAL per volume) and credential-expiry-monitor.ts
 * (OK/WARN-<threshold>/DEAD/NO_EXPIRY/PROBE_FAILED per credential). Extends the plain
 * active/clear reconcile in gateway-token-reconcile.ts's `reconcileCondition` to the case where
 * an alert-worthy condition has MULTIPLE distinct severities that can change while an issue stays
 * open (e.g. WARN→CRITICAL, or a credential tightening from a 14-day to a 7-day warning band) —
 * the already-open issue must not be duplicated (Rules #292/#358), but its title is a
 * human-facing severity claim that must not go stale either (Rule #412), so a severity change
 * on an already-open issue gets a comment + retitle instead of silence or a second issue.
 *
 * "OK" is the one designated clear status; every other status string is alert-worthy. Callers
 * pass whatever status vocabulary they like (this module never inspects status MEANING, only
 * whether it equals "OK" and whether it differs from whatever the open issue's title says).
 */

export type SeverityAction = "open" | "retitle" | "close" | "none";

/**
 * `status` is the entity's current classification ("OK" clears; anything else is alert-worthy).
 * `openStatus` is the status embedded in the currently-open issue's title for this entity (parsed
 * back out via `parseSeverityTitle`), or null when no issue is open for it.
 */
export function reconcileSeverity(status: string, openStatus: string | null): SeverityAction {
  const clear = status === "OK";
  const isOpen = openStatus !== null;
  if (clear) return isOpen ? "close" : "none";
  if (!isOpen) return "open";
  return openStatus !== status ? "retitle" : "none";
}

const SEP = " — "; // em dash, spaced — matches the gateway-token-watch title convention

/**
 * Build the `[<label>] <entity> — <status>` title convention shared across monitors using this
 * module. `entity` must not itself contain " — " (true for every current caller: Railway
 * project/service/volume names, and credential manifest names).
 */
export function buildSeverityTitle(label: string, entity: string, status: string): string {
  return `[${label}] ${entity}${SEP}${status}`;
}

/** Inverse of `buildSeverityTitle` — null if `title` doesn't match the `[<label>] ... — ...` shape. */
export function parseSeverityTitle(label: string, title: string): { entity: string; status: string } | null {
  const prefix = `[${label}] `;
  if (!title.startsWith(prefix)) return null;
  const rest = title.slice(prefix.length);
  const sep = rest.lastIndexOf(SEP);
  if (sep === -1) return null;
  return { entity: rest.slice(0, sep), status: rest.slice(sep + SEP.length) };
}
