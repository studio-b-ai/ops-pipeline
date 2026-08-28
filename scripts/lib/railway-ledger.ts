/**
 * railway-ledger.ts — pure body-building half of the Railway incident ledger
 * (ops-pipeline#167 leg 2; orchestration in scripts/railway-incident-ledger.ts).
 *
 * The ledger is ONE standing auto-reconciled GitHub issue (Rule #165 amendment shape)
 * whose body is a markdown table, one row per Railway incident, keyed by slug. It is the
 * DURABLE record: status.railway.com's recentIncidents retains only ~3 months, so rows
 * already in the ledger are KEPT when they age off the page — fresh page data wins per
 * slug, existing rows without fresh data survive as-is. This is what makes the ledger the
 * exit playbook's evidence base rather than a mirror of a rolling window (Rule #453: a
 * mirror inherits the source's retention; the ledger deliberately does not).
 */

import { gateRelevance, type StatusIncident } from "./railway-status.js";

export const LEDGER_LABEL = "railway-incident-ledger";
export const LEDGER_TITLE = "[railway-ledger] Railway incident ledger";
export const LEDGER_ROW_CAP = 200;

const SHORT_GROUPS: Array<[RegExp, string]> = [
  [/US East/i, "US East"],
  [/US West/i, "US West"],
  [/EU West|Amsterdam/i, "EU West"],
  [/Southeast Asia|Singapore/i, "SEA"],
  [/External & Third-Party/i, "ext"],
];

function shortGroup(group: string | null): string {
  if (group === null) return "global";
  for (const [re, short] of SHORT_GROUPS) if (re.test(group)) return short;
  return group.length > 18 ? `${group.slice(0, 18)}…` : group;
}

function fmtWhen(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 17);
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

function cell(text: string, cap = 80): string {
  const clean = text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean;
}

export function formatLedgerRow(incident: StatusIncident): string {
  const resolved = incident.resolvedAt ? fmtWhen(incident.resolvedAt) : "—";
  let duration = "—";
  if (incident.resolvedAt) {
    const mins = Math.round((Date.parse(incident.resolvedAt) - Date.parse(incident.createdAt)) / 60_000);
    if (Number.isFinite(mins) && mins >= 0) duration = `${mins}m`;
  }
  const rel = gateRelevance(incident);
  const compSet = new Map<string, string>();
  for (const c of incident.components) {
    if (c.impact === "OPERATIONAL") continue;
    const key = c.name;
    const groups = compSet.get(key);
    const g = shortGroup(c.groupName);
    compSet.set(key, groups ? (groups.includes(g) ? groups : `${groups}, ${g}`) : g);
  }
  const comps = [...compSet.entries()].map(([name, groups]) => `${name} (${groups})`).join("; ") || "—";
  return `| ${fmtWhen(incident.createdAt)} | \`${incident.slug}\` | ${cell(incident.title)} | ${incident.status} | ${resolved} | ${duration} | ${rel.relevant ? "**YES**" : "no"} | ${cell(comps, 110)} |`;
}

const ROW_RE = /^\| (\S[^|]*?) \| `([A-Z0-9]+)` \| .*\|$/;

/** Parse existing ledger body rows into slug -> {row, startedSortKey}. */
export function parseLedgerRows(body: string): Map<string, { row: string; started: string }> {
  const rows = new Map<string, { row: string; started: string }>();
  for (const line of body.split("\n")) {
    const m = line.match(ROW_RE);
    if (m) rows.set(m[2], { row: line, started: m[1].trim() });
  }
  return rows;
}

export interface LedgerBuildResult {
  body: string;
  addedSlugs: string[];
  updatedSlugs: string[];
  totalRows: number;
}

/**
 * Merge fresh incidents (active + recent, deduped by slug upstream) over the existing
 * body's rows. Fresh wins per slug; existing-only rows are kept verbatim. Sorted newest
 * first by the started cell; capped at LEDGER_ROW_CAP (oldest dropped).
 */
export function buildLedgerBody(
  existingBody: string,
  freshIncidents: StatusIncident[],
  generatedAt: string | null,
  nowIso: string,
): LedgerBuildResult {
  const existing = parseLedgerRows(existingBody);
  const merged = new Map<string, { row: string; started: string }>();
  const addedSlugs: string[] = [];
  const updatedSlugs: string[] = [];

  for (const [slug, entry] of existing) merged.set(slug, entry);
  for (const inc of freshIncidents) {
    const row = formatLedgerRow(inc);
    const prev = merged.get(inc.slug);
    if (!prev) addedSlugs.push(inc.slug);
    else if (prev.row !== row) updatedSlugs.push(inc.slug);
    merged.set(inc.slug, { row, started: fmtWhen(inc.createdAt) });
  }

  const sorted = [...merged.values()].sort((a, b) => (a.started < b.started ? 1 : a.started > b.started ? -1 : 0));
  const capped = sorted.slice(0, LEDGER_ROW_CAP);

  const deployPathCount = capped.filter((r) => r.row.includes("| **YES** |")).length;
  const body = [
    "**Auto-maintained by `scripts/railway-incident-ledger.ts` (ops-pipeline#167) — do not hand-edit rows; hand notes go in comments.**",
    "",
    "The durable record of Railway platform incidents, merged from status.railway.com's",
    "`activeIncidents` + `recentIncidents` every run. Rows survive after the page's ~3-month",
    "retention drops them. **deploy-path? = YES** means the incident's components would HOLD",
    "our deploy gate (`scripts/railway-status-gate.ts`): Deployments / Builds / GitHub",
    "Auto-Deploys / API in a relevant region. This table is the evidence base for the",
    "Railway exit playbook (`docs/runbooks/railway-exit-playbook.md`).",
    "",
    `_Last reconciled: ${nowIso} (page generatedAt: ${generatedAt ?? "unknown"}). Rows: ${capped.length} (${deployPathCount} deploy-path)._`,
    "",
    "| started (UTC) | slug | title | last status | resolved (UTC) | duration | deploy-path? | components (non-operational) |",
    "|---|---|---|---|---|---|---|---|",
    ...capped.map((r) => r.row),
  ].join("\n");

  return { body, addedSlugs, updatedSlugs, totalRows: capped.length };
}
