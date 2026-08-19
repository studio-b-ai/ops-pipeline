/**
 * railway-deployment-probes.ts — Railway GraphQL v2 access for the Heritage restart-train
 * scheduler's anchor computation (ops-pipeline#172 rung 0): "last studiob-api Railway deployment
 * reaching SUCCESS" (design §1.2 step 2b).
 *
 * Reuses the proven `graphqlRequest` client from railway-volume-probes.ts (Rule #5 — copy working
 * patterns) rather than duplicating it — same Cloudflare User-Agent requirement and HTTP-200-
 * with-errors-array auth-failure behavior apply here too; see that file's header for both.
 *
 * Two query shapes:
 *
 * 1. `fetchProjectRefs` — mirrors PROJECT_VOLUMES_QUERY's proven `project(id) { services { edges
 *    { node { id name } } } environments { edges { node { id name } } } }` shape (live-verified
 *    2026-07-27 against this EXACT project — studiob-platform, id
 *    433dec0e-6963-4b66-bdd2-6049ba189b81, per railway-projects.manifest.yaml) minus the
 *    volumeInstances sub-selection. This half is EMPIRICALLY GROUNDED, not a guess — it resolves
 *    the studiob-api service id + the production environment id needed by (2).
 *
 * 2. `fetchServiceDeployments` — the root `Query.deployments(input: DeploymentListInput!, first:
 *    Int)` connection, filtered by projectId/environmentId/serviceId. This is Railway's own
 *    documented public-API shape (docs.railway.com/reference/public-api) for "list a service's
 *    deployments".
 *
 *    ⚠️ UNVERIFIED LIVE THIS SESSION: the dispatching chip had no RAILWAY_API_TOKEN available
 *    locally (`echo ${RAILWAY_API_TOKEN:+SET}` → unset — Rule #259 safe-check, never echoed) and
 *    `railway login` / the Railway MCP tools were also unauthenticated in this sandbox, so this
 *    exact query shape could not be fired against the real API before shipping (Rule #50/#118's
 *    "verify before building" ideal was NOT fully met here — flagged rather than silently
 *    skipped). Per Rule #355, this is an "unconfirmed carryover" of Railway's documented shape,
 *    not a live-confirmed one.
 *
 *    This is deliberately shipped as a FAIL-CLOSED candidate source rather than blocking rung 0
 *    on it: `fetchServiceDeployments` never throws past its own try/catch (same contract as
 *    `fetchProjectVolumes`) — a wrong field name or shape surfaces as a GraphQL `errors` entry,
 *    which `parseServiceDeploymentsResponse` turns into a thrown Error the network seam catches
 *    and reports as `{ok:false, error}`. The worker (`restart-train.ts`) treats that as "no
 *    Railway candidate this run" — which `computeAnchor` (restart-train-lib.ts, already
 *    fail-closed by design, predates this file) handles as one-of-three-sources-missing, not a
 *    crash and not a wrong PLAN line. A wrong query shape therefore degrades the anchor to
 *    "computed from client-asthetik Actions + #280 END comments only" (or `ok:false` if ALL
 *    three sources are down) — never a dangerous one, because rung 0 never fires/merges/labels
 *    anything regardless of what the anchor says.
 *
 *    Rule #464 applies directly: this query's first LIVE firing (the CTO's first real dispatch,
 *    which has RAILWAY_API_TOKEN via GH Actions secrets — see heritage-restart-train.yml) is part
 *    of ITS ship, not a footnote already covered by rung 0's own tests. Watch that run's own
 *    `READ_DENIED`/error output (restart-train.ts logs the raw `error` string on {ok:false}) on
 *    the first fire, and correct the query shape here if it errors.
 */

import { graphqlRequest, type GraphQLResponse } from "./railway-volume-probes.js";

// ───────────────────────────── environment/service id resolution ─────────────────────────────

/** Mirrors PROJECT_VOLUMES_QUERY's proven shape (railway-volume-probes.ts) minus volumeInstances — see file header (1). */
const PROJECT_REFS_QUERY = `
query RestartTrainProjectRefs($id: String!) {
  project(id: $id) {
    id
    name
    services(first: 100) {
      edges { node { id name } }
    }
    environments(first: 100) {
      edges { node { id name } }
    }
  }
}`;

export interface NamedRef {
  id: string;
  name: string;
}

interface ProjectRefsData {
  project: {
    id: string;
    name: string;
    services: { edges: Array<{ node: NamedRef }> } | null;
    environments: { edges: Array<{ node: NamedRef }> } | null;
  } | null;
}

export interface ProjectRefsResult {
  services: NamedRef[];
  environments: NamedRef[];
}

/** Pure: same error contract as parseProjectVolumesResponse (railway-volume-probes.ts) — throws on GraphQL errors or a missing project; the network seam below wraps it. */
export function parseProjectRefsResponse(json: GraphQLResponse<ProjectRefsData>): ProjectRefsResult {
  if (json.errors && json.errors.length > 0) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  const project = json.data?.project;
  if (!project) {
    throw new Error("project query returned no data");
  }
  return {
    services: (project.services?.edges ?? []).map((e) => e.node),
    environments: (project.environments?.edges ?? []).map((e) => e.node),
  };
}

export type ProjectRefsFetchResult = ({ ok: true } & ProjectRefsResult) | { ok: false; error: string };

/** Network seam: never throws — errors come back as {ok:false} (same contract as fetchProjectVolumes). */
export async function fetchProjectRefs(token: string, projectId: string): Promise<ProjectRefsFetchResult> {
  try {
    const json = await graphqlRequest<ProjectRefsData>(token, PROJECT_REFS_QUERY, { id: projectId });
    const parsed = parseProjectRefsResponse(json);
    return { ok: true, ...parsed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ───────────────────────────── deployments ─────────────────────────────

/**
 * Root `Query.deployments` connection — see file header (2) for the UNVERIFIED-LIVE caveat.
 */
const SERVICE_DEPLOYMENTS_QUERY = `
query RestartTrainDeployments($projectId: String!, $environmentId: String!, $serviceId: String!, $first: Int!) {
  deployments(input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId }, first: $first) {
    edges {
      node {
        id
        status
        createdAt
        updatedAt
      }
    }
  }
}`;

/**
 * Railway's DeploymentStatus enum values treated as TERMINAL (brief's explicit list, ops-
 * pipeline#172 rung-0 brief: "terminal enum SUCCESS/FAILED/CRASHED/SKIPPED/REMOVED") — i.e. NOT
 * still in-flight (BUILDING/DEPLOYING/INITIALIZING/QUEUED/WAITING/NEEDS_APPROVAL/SLEEPING are
 * excluded). Exported for callers/tests that need the full terminal set; `latestSuccessfulDeployment`
 * below narrows further to SUCCESS specifically for anchor purposes (see its own doc comment).
 */
export const RAILWAY_TERMINAL_STATUSES = new Set(["SUCCESS", "FAILED", "CRASHED", "SKIPPED", "REMOVED"]);

export interface DeploymentRecord {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface RawDeploymentNode {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface ServiceDeploymentsData {
  deployments: { edges: Array<{ node: RawDeploymentNode }> } | null;
}

/** Pure: same error contract as the other parse* functions in this family — throws, caller wraps in try/catch. */
export function parseServiceDeploymentsResponse(json: GraphQLResponse<ServiceDeploymentsData>): DeploymentRecord[] {
  if (json.errors && json.errors.length > 0) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  const edges = json.data?.deployments?.edges;
  if (!edges) {
    throw new Error("deployments query returned no data");
  }
  return edges.map((e) => ({ ...e.node }));
}

export type ServiceDeploymentsFetchResult = { ok: true; deployments: DeploymentRecord[] } | { ok: false; error: string };

/** Network seam: never throws — a wrong query shape or auth failure degrades to {ok:false}, which the worker treats as "no Railway candidate this run" (see file header). */
export async function fetchServiceDeployments(
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
  first = 10,
): Promise<ServiceDeploymentsFetchResult> {
  try {
    const json = await graphqlRequest<ServiceDeploymentsData>(token, SERVICE_DEPLOYMENTS_QUERY, {
      projectId,
      environmentId,
      serviceId,
      first,
    });
    const deployments = parseServiceDeploymentsResponse(json);
    return { ok: true, deployments };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Pure: the latest deployment reaching SUCCESS specifically (brief: "last studiob-api Railway
 * deployment reaching SUCCESS" — narrower than the full terminal set, since only a successful
 * deploy represents "the service restarted and is serving"; FAILED/CRASHED/SKIPPED/REMOVED are
 * terminal but not a restart-completion signal for anchor purposes). Ranked by `updatedAt` (the
 * timestamp of the deployment's LAST state transition — for one sitting at SUCCESS, this is when
 * it reached that state; `createdAt` is when the deploy was TRIGGERED, which can meaningfully
 * predate completion). Returns null with zero SUCCESS entries in the page — the worker treats
 * that as "no Railway candidate", never as an error.
 */
export function latestSuccessfulDeployment(deployments: DeploymentRecord[]): DeploymentRecord | null {
  const successes = deployments.filter((d) => d.status === "SUCCESS");
  if (successes.length === 0) return null;
  return successes.reduce((latest, d) => (d.updatedAt > latest.updatedAt ? d : latest));
}
