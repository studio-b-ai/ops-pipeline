/**
 * railway-volume-probes.ts — Railway GraphQL v2 access for the volume-usage monitor
 * (CLAUDE.md Rule #302 family; origin 2026-07-27 aesthetik-production volume-full outage).
 *
 * PURE PARSERS (unit-tested, no network) are exported separately from the NETWORK SEAMS, same
 * split as credential-probes.ts.
 *
 * Two empirically-verified Railway API quirks this file works around (verified live 2026-07-27
 * against the real API with a real account token — Rule #50/#118: don't guess vendor behavior):
 *
 * 1. Requests with no `User-Agent` header can be rejected by Cloudflare in front of the API (403)
 *    from some callers/networks (observed from a GitHub Actions-shaped caller). Every request here
 *    sets one.
 *
 * 2. The root `Query.projects` connection is NOT reliably available to every token shape — a real
 *    personal-account token got `{"errors":[{"message":"Not Authorized", ...}], "data": null}` on
 *    `projects(first: N)` while `Query.project(id: ...)` on the SAME token worked fine for the same
 *    projects. Railway's GraphQL API also returns HTTP 200 on auth/permission failures — the error
 *    surfaces ONLY in the `errors` array, never the HTTP status — so `discoverProjectIds` treats
 *    ANY error on the `projects` field as "unavailable, fall back to the manifest list" rather than
 *    trying to pattern-match the message.
 *
 * A THIRD quirk shaped the query itself: selecting the nested `VolumeInstance.service { ... }`
 * object field 500s ("Problem processing request", no field-level detail) for the
 * aesthetik-production project specifically — almost certainly a dangling `serviceId` on an
 * orphaned/detached volume that breaks that resolver server-side. Bisected live field-by-field
 * (Rule #401 — don't declare a shape "broken" from a truncated read; here the opposite: don't ship
 * a nested selection without proving each field independently). Fix: never select
 * `VolumeInstance.service { ... }` — read the scalar `serviceId` instead and resolve the friendly
 * name from a SEPARATE `project.services { edges { node { id name } } }` list (proven safe), joined
 * in `parseProjectVolumesResponse`. Do not re-add the nested `service` selection without re-testing
 * against aesthetik-production first — it silently breaks the ENTIRE per-project query, which would
 * starve monitoring for exactly the project this monitor exists for.
 */

export const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const USER_AGENT = "studiob-railway-volume-monitor/1.0";
/** Per-call deadline so a stalled connection fails loud instead of hanging the job (Rule #114/#269). */
const REQUEST_TIMEOUT_MS = 20_000;

export interface GraphQLResponse<T> {
  data: T | null;
  errors?: Array<{ message: string }>;
}

/** Thin fetch seam — every caller in this file goes through here so headers/timeout stay in one place. */
export async function graphqlRequest<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GraphQLResponse<T>> {
  const resp = await fetch(RAILWAY_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT, // Cloudflare 403s some callers with no UA — see file header (2).
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`Railway GraphQL HTTP ${resp.status}`);
  }
  return (await resp.json()) as GraphQLResponse<T>;
}

// ───────────────────────────── token liveness ─────────────────────────────

const ME_QUERY = `query VolMonWhoAmI { me { id } }`;

export interface LivenessResult {
  ok: boolean;
  error?: string;
}

/**
 * Dedicated liveness probe for RAILWAY_API_TOKEN. `me` is the cheapest field every valid token can
 * resolve regardless of project/team scoping, so — unlike `projects()` (quirk 2 above) — an error
 * here means the token itself is dead/expired/malformed, not merely under-scoped. This is the ONLY
 * place this monitor treats a Railway API error as "the token is invalid" (Rule #302 family: fail
 * loud on a dead credential; a silently-dead monitor is worse than none).
 */
export async function probeTokenAlive(token: string): Promise<LivenessResult> {
  try {
    const json = await graphqlRequest<{ me: { id: string } | null }>(token, ME_QUERY);
    if (json.errors && json.errors.length > 0) {
      return { ok: false, error: json.errors.map((e) => e.message).join("; ") };
    }
    if (!json.data?.me?.id) {
      return { ok: false, error: "me query returned no data" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ───────────────────────────── project discovery ─────────────────────────────

const PROJECTS_ROOT_QUERY = `
query VolMonProjects($first: Int!) {
  projects(first: $first) {
    edges { node { id name } }
  }
}`;

export interface ProjectRef {
  id: string;
  name: string;
}

interface ProjectsRootResponseData {
  projects: { edges: Array<{ node: { id: string; name: string } }> } | null;
}

/** Pure: turn a `projects()` root response into a project list, or null if the field errored. */
export function parseProjectsRootResponse(json: GraphQLResponse<ProjectsRootResponseData>): ProjectRef[] | null {
  if (json.errors && json.errors.length > 0) return null;
  const edges = json.data?.projects?.edges;
  if (!edges) return null;
  return edges.map((e) => ({ id: e.node.id, name: e.node.name }));
}

/**
 * Try the root `projects()` connection (discovers every project the token can see — the ideal
 * "fleet-wide" path). Returns null when the field errors (quirk 2 above) so the caller falls back
 * to the manifest list; this is a DEGRADATION, not a token-invalid condition (that's `probeTokenAlive`'s
 * job), so it must never itself raise or post an escalation.
 */
export async function discoverProjectIds(token: string): Promise<ProjectRef[] | null> {
  try {
    const json = await graphqlRequest<ProjectsRootResponseData>(token, PROJECTS_ROOT_QUERY, { first: 100 });
    return parseProjectsRootResponse(json);
  } catch {
    return null;
  }
}

// ───────────────────────────── per-project volume usage ─────────────────────────────

/**
 * NOTE the deliberate absence of `VolumeInstance.service { ... }` — see file header (quirk 3).
 * `serviceId` is a plain scalar; friendly names come from the separate `services` list below.
 */
const PROJECT_VOLUMES_QUERY = `
query VolMonProjectVolumes($id: String!) {
  project(id: $id) {
    id
    name
    services(first: 100) {
      pageInfo { hasNextPage }
      edges { node { id name } }
    }
    environments(first: 100) {
      pageInfo { hasNextPage }
      edges {
        node {
          id
          name
          volumeInstances(first: 100) {
            pageInfo { hasNextPage }
            edges {
              node {
                id
                sizeMB
                currentSizeMB
                state
                serviceId
                volume { id name }
              }
            }
          }
        }
      }
    }
  }
}`;

/** States where alerting on usage% doesn't make sense — the volume is going away. */
const SKIP_VOLUME_STATES = new Set(["DELETED", "DELETING"]);

export interface VolumeRecord {
  volumeInstanceId: string;
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  serviceId: string | null;
  /** Resolved via the project's services list; null when detached (no serviceId) or unresolvable. */
  serviceName: string | null;
  volumeId: string;
  volumeName: string;
  sizeMB: number;
  currentSizeMB: number;
  state: string;
}

interface RawVolumeInstanceNode {
  id: string;
  sizeMB: number;
  currentSizeMB: number;
  state: string;
  serviceId: string | null;
  volume: { id: string; name: string };
}

interface RawProjectVolumesData {
  project: {
    id: string;
    name: string;
    services: { pageInfo: { hasNextPage: boolean }; edges: Array<{ node: { id: string; name: string } }> } | null;
    environments: {
      pageInfo: { hasNextPage: boolean };
      edges: Array<{
        node: {
          id: string;
          name: string;
          volumeInstances: {
            pageInfo: { hasNextPage: boolean };
            edges: Array<{ node: RawVolumeInstanceNode }>;
          } | null;
        };
      }>;
    } | null;
  } | null;
}

export interface ParsedProjectVolumes {
  volumes: VolumeRecord[];
  /** true if any nested connection reported `hasNextPage: true` — Rule #331 (truncation risk). */
  truncated: boolean;
}

/**
 * Pure: turn a `project(id)` response into a flat volume-record list + a service-id→name map join,
 * filtering to `sizeMB > 0` (per spec — a volume with no configured size has no usage percentage)
 * and skipping DELETED/DELETING instances. Exported for unit tests with captured fixture JSON
 * (Rule #223/#277 — test the actual wire shape, not a hand-assembled one).
 */
export function parseProjectVolumesResponse(json: GraphQLResponse<RawProjectVolumesData>): ParsedProjectVolumes {
  if (json.errors && json.errors.length > 0) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  const project = json.data?.project;
  if (!project) {
    throw new Error("project query returned no data");
  }

  const serviceNameById = new Map<string, string>();
  for (const e of project.services?.edges ?? []) {
    serviceNameById.set(e.node.id, e.node.name);
  }

  let truncated = project.services?.pageInfo?.hasNextPage === true || project.environments?.pageInfo?.hasNextPage === true;

  const volumes: VolumeRecord[] = [];
  for (const envEdge of project.environments?.edges ?? []) {
    const env = envEdge.node;
    const viConn = env.volumeInstances;
    if (viConn?.pageInfo?.hasNextPage) truncated = true;
    for (const viEdge of viConn?.edges ?? []) {
      const vi = viEdge.node;
      if (SKIP_VOLUME_STATES.has(vi.state)) continue;
      if (!(vi.sizeMB > 0)) continue; // spec: only volume instances with sizeMB > 0
      volumes.push({
        volumeInstanceId: vi.id,
        projectId: project.id,
        projectName: project.name,
        environmentId: env.id,
        environmentName: env.name,
        serviceId: vi.serviceId,
        serviceName: vi.serviceId ? (serviceNameById.get(vi.serviceId) ?? null) : null,
        volumeId: vi.volume.id,
        volumeName: vi.volume.name,
        sizeMB: vi.sizeMB,
        currentSizeMB: vi.currentSizeMB,
        state: vi.state,
      });
    }
  }

  return { volumes, truncated };
}

export type ProjectVolumesResult = ({ ok: true } & ParsedProjectVolumes) | { ok: false; error: string };

/** Network seam: fetch + parse one project's volumes. Never throws — errors come back as `{ok:false}` so one bad project can't crash the whole run. */
export async function fetchProjectVolumes(token: string, projectId: string): Promise<ProjectVolumesResult> {
  try {
    const json = await graphqlRequest<RawProjectVolumesData>(token, PROJECT_VOLUMES_QUERY, { id: projectId });
    const parsed = parseProjectVolumesResponse(json);
    return { ok: true, ...parsed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
