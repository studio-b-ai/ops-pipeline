/**
 * railway-status.ts — parse status.railway.com and classify deploy-path risk (ops-pipeline#167).
 *
 * status.railway.com has NO public JSON API (probed 2026-08-28: /summary.json and every
 * Statuspage/Instatus-shaped path return the HTML app shell). It is a Next.js/TSR page whose
 * ENTIRE state ships inline in the server-rendered flight payload as `$R[n]=` assignments.
 * The live-state contract, enumerated from a full 1.15MB capture (Rule #401 complete read):
 *
 *   ...],activeIncidents:$R[n]=[ ...incident objects... ],recentIncidents:$R[n]=[ ...history...
 *   ],maintenances:$R[n]=[ ... ],generatedAt:"<ISO>"},ssr:!0}]
 *
 * There is NO other live-state structure (no overallStatus/currentStatus/banner field — the
 * page banner derives from activeIncidents). Incident object shape (verbatim from capture):
 *
 *   {id:"<uuid>",slug:"VVL3A03V",title:"...",status:"RESOLVED",createdAt:"<ISO>",
 *    resolvedAt:"<ISO>"|null,components:$R[n]=[{id:"<uuid>",name:"Deployments",
 *    groupName:"US East (Virginia, USA)"|null,impact:"PARTIAL_OUTAGE"},...],updates:[...]}
 *
 * Update-status vocabulary: IDENTIFIED/INVESTIGATING/MONITORING/RESOLVED/TRIAGE.
 * Impact vocabulary: DEGRADED_PERFORMANCE/MAJOR_OUTAGE/PARTIAL_OUTAGE/OPERATIONAL.
 * Region groupNames: "US East (Virginia, USA)" / "US West (California, USA)" /
 * "EU West (Amsterdam, Netherlands)" / "Southeast Asia (Singapore)"; non-regional groups
 * exist too ("External & Third-Party Integrations" carries "GitHub — Auto-Deploys").
 *
 * Because this is scraped state, the parser is deliberately paranoid (Rule #465 — the
 * predicate is part of the receipt): every marker must appear EXACTLY once; a missing or
 * duplicated marker is PARSE_ERROR, never CLEAR. Consumers fail OPEN on PARSE_ERROR with a
 * loud warning (Rule #295 — the status page being down/reshaped is not evidence Railway
 * deploys are degraded; a dead instrument must not block deploys forever), and fail CLOSED
 * (HOLD) only on a positively-parsed live incident touching a deploy-path component.
 *
 * Gate scope (Rule #295, trigger-signal scope == remediation scope): the gate protects
 * DEPLOYS, so it watches deploy-path components only — Deployments, Builds,
 * GitHub — Auto-Deploys, API (backboard). Region filter: IGNORE only components whose
 * groupName names a known-foreign region (SEA/EU); null groups, US regions, non-regional
 * groups, and UNKNOWN new groups all count as relevant — fail-toward-HOLD for unknowns
 * (a missed HOLD deploys into a degraded platform; a false HOLD delays a deploy minutes).
 */

export interface IncidentComponent {
  id: string;
  name: string;
  groupName: string | null;
  impact: string;
}

export interface StatusIncident {
  id: string;
  slug: string;
  title: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  components: IncidentComponent[];
}

export interface GateRelevance {
  relevant: boolean;
  /** Human-readable "component (group, impact)" strings that triggered relevance. */
  matched: string[];
}

export type StatusVerdict = "CLEAR" | "HOLD" | "PARSE_ERROR";

export interface StatusSnapshot {
  verdict: StatusVerdict;
  reason: string;
  generatedAt: string | null;
  /** Hours between generatedAt and now; null when generatedAt unparseable. */
  staleHours: number | null;
  activeGateRelevant: StatusIncident[];
  activeIgnored: StatusIncident[];
  recentIncidents: StatusIncident[];
  /** Raw maintenances segment text ("" when empty). Shape unpinned — no real record has
   *  been captured yet (Rule #50), so it is surfaced, not judged: consumers WARN when
   *  non-empty rather than pretending to classify it. */
  maintenancesRaw: string;
}

export const STATUS_URL = "https://status.railway.com/";

/** Deploy-path components (normalized: lowercase, all dash variants -> "-", spaces collapsed). */
export const GATE_COMPONENT_NAMES = [
  "deployments",
  "builds",
  "github - auto-deploys",
  "api - backboard.railway.com",
  // Tolerate a bare "API" component name if Railway ever shortens it.
  "api",
];

/** groupNames matching any of these are foreign regions -> component ignored by the gate.
 *  Everything else (null, US regions, non-regional groups, unknown NEW groups) is relevant. */
export const FOREIGN_REGION_PATTERNS: RegExp[] = [
  /southeast asia/i,
  /singapore/i,
  /eu west/i,
  /amsterdam/i,
  /netherlands/i,
  /europe/i,
];

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[‐-―−]/g, "-") // hyphen/en/em/horizontal-bar/minus variants
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the text between two markers, requiring each marker to appear EXACTLY once.
 * Returns null (never a guess) when either marker is missing or duplicated — the caller
 * maps that to PARSE_ERROR (Rule #465: a wrong-handle zero reads exactly like truth).
 */
export function extractSegment(html: string, startMarker: string, endMarker: string): string | null {
  const countOf = (needle: string): number => {
    let count = 0;
    let idx = html.indexOf(needle);
    while (idx !== -1) {
      count += 1;
      idx = html.indexOf(needle, idx + 1);
    }
    return count;
  };
  if (countOf(startMarker) !== 1 || countOf(endMarker) !== 1) return null;
  const start = html.indexOf(startMarker) + startMarker.length;
  const end = html.indexOf(endMarker);
  if (end < start) return null;
  return html.slice(start, end);
}

/**
 * Scan a segment for balanced top-level {...} objects, string-aware (quotes and escapes
 * inside incident update messages must not derail brace counting).
 */
export function extractBalancedObjects(segment: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        objects.push(segment.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0; // tolerate leading closers in a sliced prefix
    }
  }
  return objects;
}

const FIELD = (name: string) => new RegExp(`(?:^|[{,])${name}:"((?:[^"\\\\]|\\\\.)*)"`);
const NULLABLE_FIELD = (name: string) => new RegExp(`(?:^|[{,])${name}:(null|"(?:[^"\\\\]|\\\\.)*")`);

const COMPONENT_RE = /\{id:"([0-9a-f-]{36})",name:"((?:[^"\\]|\\.)*)",groupName:(null|"(?:[^"\\]|\\.)*"),impact:"([A-Z_]+)"\}/g;

function unquote(v: string): string | null {
  if (v === "null") return null;
  return v.slice(1, -1).replace(/\\(.)/g, "$1");
}

/** Parse ONE balanced incident object. Returns null for non-incident objects (no slug/status). */
export function parseIncidentObject(objText: string): StatusIncident | null {
  const id = objText.match(FIELD("id"))?.[1];
  const slug = objText.match(FIELD("slug"))?.[1];
  const title = objText.match(FIELD("title"))?.[1];
  const status = objText.match(FIELD("status"))?.[1];
  const createdAt = objText.match(FIELD("createdAt"))?.[1];
  if (!id || !slug || !title || !status || !createdAt) return null;
  const resolvedRaw = objText.match(NULLABLE_FIELD("resolvedAt"))?.[1] ?? "null";
  // Components live before updates; updates carry no `impact:` field so the component
  // regex cannot over-match into them.
  const components: IncidentComponent[] = [];
  for (const m of objText.matchAll(COMPONENT_RE)) {
    components.push({
      id: m[1],
      name: m[2].replace(/\\(.)/g, "$1"),
      groupName: m[3] === "null" ? null : m[3].slice(1, -1).replace(/\\(.)/g, "$1"),
      impact: m[4],
    });
  }
  return {
    id,
    slug,
    title: title.replace(/\\(.)/g, "$1"),
    status,
    createdAt,
    resolvedAt: unquote(resolvedRaw),
    components,
  };
}

export function parseIncidentsSegment(segment: string): StatusIncident[] {
  const incidents: StatusIncident[] = [];
  for (const obj of extractBalancedObjects(segment)) {
    const inc = parseIncidentObject(obj);
    if (inc) incidents.push(inc);
  }
  return incidents;
}

/** Would this incident's component set hold a deploy? (Same filter for active gating and
 *  the ledger's historical "gate-relevant" column.) */
export function gateRelevance(incident: StatusIncident): GateRelevance {
  const matched: string[] = [];
  for (const c of incident.components) {
    if (c.impact === "OPERATIONAL") continue;
    if (!GATE_COMPONENT_NAMES.includes(normalizeName(c.name))) continue;
    const group = c.groupName;
    if (group !== null && FOREIGN_REGION_PATTERNS.some((p) => p.test(group))) continue;
    matched.push(`${c.name} (${group ?? "global"}, ${c.impact})`);
  }
  return { relevant: matched.length > 0, matched };
}

export function parseGeneratedAt(html: string): string | null {
  const m = html.match(/generatedAt:"([^"]+)"/);
  return m ? m[1] : null;
}

/** Evaluate a full status.railway.com HTML capture into a verdict snapshot. */
export function evaluateStatusHtml(html: string, nowMs: number = Date.now()): StatusSnapshot {
  const base: Omit<StatusSnapshot, "verdict" | "reason"> = {
    generatedAt: null,
    staleHours: null,
    activeGateRelevant: [],
    activeIgnored: [],
    recentIncidents: [],
    maintenancesRaw: "",
  };

  const activeSegment = extractSegment(html, "activeIncidents:", ",recentIncidents:");
  const recentSegment = extractSegment(html, ",recentIncidents:", ",maintenances:");
  const maintSegment = extractSegment(html, ",maintenances:", ",generatedAt:");
  if (activeSegment === null || recentSegment === null || maintSegment === null) {
    const missing = [
      activeSegment === null ? "activeIncidents" : null,
      recentSegment === null ? "recentIncidents" : null,
      maintSegment === null ? "maintenances" : null,
    ].filter(Boolean);
    return {
      ...base,
      verdict: "PARSE_ERROR",
      reason: `status page format changed — marker(s) missing or duplicated: ${missing.join(", ")}. ` +
        `Fix scripts/lib/railway-status.ts against a fresh capture before trusting any verdict.`,
    };
  }

  const generatedAt = parseGeneratedAt(html);
  let staleHours: number | null = null;
  if (generatedAt) {
    const t = Date.parse(generatedAt);
    if (!Number.isNaN(t)) staleHours = Math.max(0, (nowMs - t) / 3_600_000);
  }

  const active = parseIncidentsSegment(activeSegment);
  const recent = parseIncidentsSegment(recentSegment);
  const activeGateRelevant = active.filter((i) => gateRelevance(i).relevant);
  const activeIgnored = active.filter((i) => !gateRelevance(i).relevant);
  const maintenancesRaw = maintSegment.replace(/^\$R\[\d+\]=/, "").trim() === "[]" ? "" : maintSegment.trim();

  if (activeGateRelevant.length > 0) {
    const lines = activeGateRelevant.map(
      (i) => `${i.slug} "${i.title}" [${i.status}] — ${gateRelevance(i).matched.join("; ")}`,
    );
    return {
      ...base,
      verdict: "HOLD",
      reason: `active Railway incident on deploy-path components: ${lines.join(" | ")}`,
      generatedAt,
      staleHours,
      activeGateRelevant,
      activeIgnored,
      recentIncidents: recent,
      maintenancesRaw,
    };
  }

  const notes: string[] = [];
  if (activeIgnored.length > 0) {
    notes.push(
      `${activeIgnored.length} active incident(s) ignored (foreign region / non-deploy component): ` +
        activeIgnored.map((i) => i.slug).join(", "),
    );
  }
  if (maintenancesRaw !== "") notes.push("maintenances non-empty (shape unpinned — inspect manually)");
  if (staleHours !== null && staleHours > 6) notes.push(`page generatedAt is ${staleHours.toFixed(1)}h old`);

  return {
    ...base,
    verdict: "CLEAR",
    reason: notes.length > 0 ? notes.join("; ") : "no active incidents",
    generatedAt,
    staleHours,
    activeIgnored,
    recentIncidents: recent,
    maintenancesRaw,
  };
}

export async function fetchStatusHtml(url: string = STATUS_URL, timeoutMs = 20_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Cloudflare-fronted endpoints 403 UA-less requests (Rule #435 narrative).
        "User-Agent": "studio-b-ops-pipeline/railway-status (github.com/studio-b-ai/ops-pipeline)",
        Accept: "text/html",
      },
    });
    if (!res.ok) throw new Error(`status page fetch failed: HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
