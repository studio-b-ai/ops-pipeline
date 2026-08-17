#!/usr/bin/env tsx
/**
 * scripts/provision-railway-vars.ts
 *
 * Provisions FLEET_APP_ID / FLEET_APP_INSTALLATION_ID / FLEET_APP_PRIVATE_KEY
 * onto a target Railway service via the Railway GraphQL v2 API's
 * `variableCollectionUpsert` mutation — rung 0 of the credential-lifecycle-
 * no-Kevin-touch ladder (decision
 * ~/Documents/brain/library/decisions/2026-08-17-credential-lifecycle-no-kevin-touch.md
 * §3, row `bolt-wms-github-issues-pat`). Only ops-pipeline holds the
 * FLEET_APP_ID/FLEET_APP_PRIVATE_KEY secrets needed to provision these — the
 * consumer (bolt-wms, PR #1840) cannot self-provision its own App identity.
 *
 * MUTATION SHAPE (verified against Railway's own canonical docs — Rule #50 —
 * not guessed; docs.railway.com/integrations/api/manage-variables, fetched
 * 2026-08-17):
 *   mutation ($input: VariableCollectionUpsertInput!) {
 *     variableCollectionUpsert(input: $input)   # returns a plain Boolean
 *   }
 *   input: { projectId, environmentId, serviceId, variables: {K:V,...},
 *            replace: Boolean (default false), skipDeploys: Boolean (default false) }
 *
 * `replace: true` DELETES EVERY VARIABLE NOT IN THE NEW SET (Railway's own
 * docs carry a warning banner on this) — this script HARDCODES `replace:
 * false` in buildUpsertInput() and never exposes it as a flag, so that
 * footgun is structurally unreachable here. `skipDeploys: false` (also
 * hardcoded) is required for the write to actually reach the running
 * container rather than merely stage (Rule #440) — this script's whole job
 * is to make the vars live, not stage them.
 *
 * DEFAULT = DRY-RUN (Rule #376: a dry-run rung must produce the SAME signal
 * as the live rung minus the mutation itself — not a stub). Even without
 * --apply, this script resolves the REAL project/environment/service ids via
 * a live (read-only) GraphQL call and builds the REAL upsert input — it only
 * skips sending the upsert mutation. The printed body has variable NAMES
 * only; VALUES are always redacted, dry-run or not (Rules #363/#259).
 *
 * --apply sends the ONE variableCollectionUpsert, then re-reads the
 * service's variable NAMES (never values, via the `variables()` query — see
 * listVariableNames) to verify all three FLEET_APP_* names actually landed,
 * rather than trusting the mutation's bare `true` return alone.
 *
 * USAGE
 *   npx tsx provision-railway-vars.ts --project-id <id> \
 *     --environment-name <name> --service-name <name> [--apply]
 *
 * REQUIRED ENV (never read from argv — Rules #363/#259 keep secret values
 * out of process listings / shell history):
 *   RAILWAY_API_TOKEN        bearer token for the Railway GraphQL API
 *   FLEET_APP_ID              GitHub App id (e.g. "4595770")
 *   FLEET_APP_INSTALLATION_ID installation id for the target repo
 *   FLEET_APP_PRIVATE_KEY     the App's PEM private key
 *
 * EXIT CODES: 0 = dry-run completed, or apply completed + verified.
 *             1 = bad args, missing env, GraphQL error, or post-apply
 *                 verification found a name missing.
 */

import { requireEnv } from './lib/config.js';

// ---------------------------------------------------------------------------
// CLI args (pure — unit tested)
// ---------------------------------------------------------------------------

export interface ProvisionArgs {
  projectId: string;
  environmentName: string;
  serviceName: string;
  apply: boolean;
}

export function parseArgs(argv: string[]): ProvisionArgs | { error: string } {
  let projectId: string | null = null;
  let environmentName: string | null = null;
  let serviceName: string | null = null;
  let apply = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--project-id') {
      projectId = argv[++i] ?? null;
      continue;
    }
    if (arg === '--environment-name') {
      environmentName = argv[++i] ?? null;
      continue;
    }
    if (arg === '--service-name') {
      serviceName = argv[++i] ?? null;
      continue;
    }
  }

  const missing: string[] = [];
  if (!projectId) missing.push('--project-id');
  if (!environmentName) missing.push('--environment-name');
  if (!serviceName) missing.push('--service-name');
  if (missing.length > 0) {
    return { error: `missing required arg(s): ${missing.join(', ')}` };
  }
  // TS can't narrow projectId/environmentName/serviceName from the `missing` array check above
  // (it only narrows on a direct `if (!x) return` for that exact variable) — these three are
  // provably non-null at this point (every falsy case pushed to `missing` and returned above).
  if (projectId == null || environmentName == null || serviceName == null) {
    // Unreachable — satisfies the type checker without an `as string` cast.
    return { error: 'unreachable: required arg resolved null after the missing-arg check' };
  }
  return { projectId, environmentName, serviceName, apply };
}

// ---------------------------------------------------------------------------
// Railway GraphQL v2 transport (Rule #435: Cloudflare 403s requests with no
// User-Agent in front of this endpoint — verified live against the real API,
// see scripts/lib/railway-volume-probes.ts's file header for the original
// finding; mirrored here rather than imported since that file is monitor-
// specific and this script's domain — variable provisioning — is unrelated
// beyond sharing this same low-level fetch mechanics, same precedent as
// bolt-wms's github-app-token.ts / webhook-router's acuops-agent.ts each
// independently implementing the same JWT pattern with no shared package).
// ---------------------------------------------------------------------------

const RAILWAY_GRAPHQL_URL = 'https://backboard.railway.com/graphql/v2';
const USER_AGENT = 'studiob-fleet-bot-provisioner/1.0';
const REQUEST_TIMEOUT_MS = 20_000;

export interface GraphQLResponse<T> {
  data: T | null;
  errors?: Array<{ message: string }>;
}

/** Thin fetch seam — every caller below goes through here so headers/timeout stay in one place. */
export async function graphqlRequest<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GraphQLResponse<T>> {
  const resp = await fetch(RAILWAY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`Railway GraphQL HTTP ${resp.status}`);
  }
  return (await resp.json()) as GraphQLResponse<T>;
}

// ---------------------------------------------------------------------------
// Project context (environment/service name → id resolution)
// ---------------------------------------------------------------------------

export interface NamedRef {
  id: string;
  name: string;
}

export interface ProjectContext {
  environments: NamedRef[];
  services: NamedRef[];
  /** true if either connection reported hasNextPage — Rule #331 (truncation risk at 100). */
  truncated: boolean;
}

interface RawProjectContextData {
  project: {
    id: string;
    name: string;
    environments: {
      pageInfo: { hasNextPage: boolean };
      edges: Array<{ node: { id: string; name: string } }>;
    } | null;
    services: {
      pageInfo: { hasNextPage: boolean };
      edges: Array<{ node: { id: string; name: string } }>;
    } | null;
  } | null;
}

const PROJECT_CONTEXT_QUERY = `
query FleetProvisionProjectContext($id: String!) {
  project(id: $id) {
    id
    name
    environments(first: 100) {
      pageInfo { hasNextPage }
      edges { node { id name } }
    }
    services(first: 100) {
      pageInfo { hasNextPage }
      edges { node { id name } }
    }
  }
}`;

/** Pure: turn a project() response into a flat environment/service name→id list, or an error. */
export function parseProjectContextResponse(
  json: GraphQLResponse<RawProjectContextData>,
): ProjectContext | { error: string } {
  if (json.errors && json.errors.length > 0) {
    return { error: json.errors.map((e) => e.message).join('; ') };
  }
  const project = json.data?.project;
  if (!project) {
    return { error: 'project query returned no data (check --project-id)' };
  }
  const environments = (project.environments?.edges ?? []).map((e) => ({ id: e.node.id, name: e.node.name }));
  const services = (project.services?.edges ?? []).map((e) => ({ id: e.node.id, name: e.node.name }));
  const truncated =
    project.environments?.pageInfo?.hasNextPage === true || project.services?.pageInfo?.hasNextPage === true;
  return { environments, services, truncated };
}

/** Network seam: fetch + parse a project's environment/service context. */
export async function fetchProjectContext(token: string, projectId: string): Promise<ProjectContext | { error: string }> {
  try {
    const json = await graphqlRequest<RawProjectContextData>(token, PROJECT_CONTEXT_QUERY, { id: projectId });
    return parseProjectContextResponse(json);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Pure: exact-match a name against a resolved list, or return an error naming what WAS available. */
export function resolveIdByName(items: NamedRef[], name: string, kind: string): string | { error: string } {
  const match = items.find((i) => i.name === name);
  if (!match) {
    const available = items.map((i) => i.name).join(', ') || '(none)';
    return { error: `no ${kind} named "${name}" — available: ${available}` };
  }
  return match.id;
}

// ---------------------------------------------------------------------------
// variableCollectionUpsert
// ---------------------------------------------------------------------------

export interface UpsertInput {
  projectId: string;
  environmentId: string;
  serviceId: string;
  variables: Record<string, string>;
  replace: false;
  skipDeploys: false;
}

/**
 * Pure: build the upsert input. `replace` and `skipDeploys` are HARDCODED —
 * see the file header on why `replace: true` must never be reachable from
 * this script, and why `skipDeploys: false` is required (Rule #440).
 */
export function buildUpsertInput(
  projectId: string,
  environmentId: string,
  serviceId: string,
  variables: Record<string, string>,
): UpsertInput {
  return { projectId, environmentId, serviceId, variables, replace: false, skipDeploys: false };
}

/** Pure: same shape as the real input, with every variable VALUE replaced — names stay visible. */
export function redactUpsertInput(input: UpsertInput): Record<string, unknown> {
  return {
    ...input,
    variables: Object.fromEntries(Object.keys(input.variables).map((k) => [k, '<redacted>'])),
  };
}

const UPSERT_MUTATION = `
mutation FleetProvisionUpsert($input: VariableCollectionUpsertInput!) {
  variableCollectionUpsert(input: $input)
}`;

/** Network seam: send the upsert. Returns `true` on confirmed success, else `{error}` — never throws. */
export async function applyUpsert(token: string, input: UpsertInput): Promise<true | { error: string }> {
  try {
    const json = await graphqlRequest<{ variableCollectionUpsert: boolean }>(token, UPSERT_MUTATION, { input });
    if (json.errors && json.errors.length > 0) {
      return { error: json.errors.map((e) => e.message).join('; ') };
    }
    if (json.data?.variableCollectionUpsert !== true) {
      return { error: `variableCollectionUpsert returned ${JSON.stringify(json.data?.variableCollectionUpsert)}, expected true` };
    }
    return true;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Post-apply verification — NAMES only, never values (Rules #363/#259)
// ---------------------------------------------------------------------------

const LIST_VARIABLE_NAMES_QUERY = `
query FleetProvisionListVariableNames($projectId: String!, $environmentId: String!, $serviceId: String!) {
  variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
}`;

/** Network seam: list variable NAMES for a service. Callers must never log the returned values — only the keys are read. */
export async function listVariableNames(
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
): Promise<string[] | { error: string }> {
  try {
    const json = await graphqlRequest<{ variables: Record<string, string> }>(token, LIST_VARIABLE_NAMES_QUERY, {
      projectId,
      environmentId,
      serviceId,
    });
    if (json.errors && json.errors.length > 0) {
      return { error: json.errors.map((e) => e.message).join('; ') };
    }
    const vars = json.data?.variables;
    if (!vars) {
      return { error: 'variables query returned no data' };
    }
    return Object.keys(vars);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const FLEET_APP_VAR_NAMES = ['FLEET_APP_ID', 'FLEET_APP_INSTALLATION_ID', 'FLEET_APP_PRIVATE_KEY'] as const;

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`provision-railway-vars: ${parsed.error}`);
    console.error(
      'usage: provision-railway-vars.ts --project-id <id> --environment-name <name> --service-name <name> [--apply]',
    );
    return 1;
  }
  const { projectId, environmentName, serviceName, apply } = parsed;

  let railwayToken: string;
  let fleetAppId: string;
  let fleetAppInstallationId: string;
  let fleetAppPrivateKey: string;
  try {
    railwayToken = requireEnv('RAILWAY_API_TOKEN');
    fleetAppId = requireEnv('FLEET_APP_ID');
    fleetAppInstallationId = requireEnv('FLEET_APP_INSTALLATION_ID');
    fleetAppPrivateKey = requireEnv('FLEET_APP_PRIVATE_KEY');
  } catch (err) {
    console.error(`provision-railway-vars: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  console.log(`provision-railway-vars ${apply ? '(APPLY — will mutate Railway)' : '(DRY-RUN — pass --apply to mutate)'}`);
  console.log(`  project: ${projectId}`);
  console.log(`  environment: ${environmentName}`);
  console.log(`  service: ${serviceName}`);

  const context = await fetchProjectContext(railwayToken, projectId);
  if ('error' in context) {
    console.error(`provision-railway-vars: failed to resolve project context: ${context.error}`);
    return 1;
  }
  if (context.truncated) {
    console.error(
      'provision-railway-vars: WARNING — environments or services list was truncated (>100 items); id resolution may be incomplete (Rule #331)',
    );
  }

  const environmentId = resolveIdByName(context.environments, environmentName, 'environment');
  if (typeof environmentId !== 'string') {
    console.error(`provision-railway-vars: ${environmentId.error}`);
    return 1;
  }
  const serviceId = resolveIdByName(context.services, serviceName, 'service');
  if (typeof serviceId !== 'string') {
    console.error(`provision-railway-vars: ${serviceId.error}`);
    return 1;
  }
  console.log(`  resolved environmentId=${environmentId} serviceId=${serviceId}`);

  const input = buildUpsertInput(projectId, environmentId, serviceId, {
    FLEET_APP_ID: fleetAppId,
    FLEET_APP_INSTALLATION_ID: fleetAppInstallationId,
    FLEET_APP_PRIVATE_KEY: fleetAppPrivateKey,
  });

  console.log('upsert body (variable VALUES redacted):');
  console.log(JSON.stringify(redactUpsertInput(input), null, 2));

  if (!apply) {
    console.log('dry-run complete — no mutation sent. Pass --apply to write these variables.');
    return 0;
  }

  console.log('sending variableCollectionUpsert...');
  const result = await applyUpsert(railwayToken, input);
  if (result !== true) {
    console.error(`provision-railway-vars: upsert failed: ${result.error}`);
    return 1;
  }
  console.log('upsert succeeded. Verifying via a fresh variable-name listing...');

  const names = await listVariableNames(railwayToken, projectId, environmentId, serviceId);
  if ('error' in names) {
    console.error(`provision-railway-vars: upsert reported success but verification read failed: ${names.error}`);
    return 1;
  }
  const missing = FLEET_APP_VAR_NAMES.filter((n) => !names.includes(n));
  if (missing.length > 0) {
    console.error(`provision-railway-vars: upsert reported success but these names are NOT present on re-read: ${missing.join(', ')}`);
    return 1;
  }
  console.log(`verified: ${FLEET_APP_VAR_NAMES.join(', ')} all present (${names.length} variables total on this service).`);
  return 0;
}

// Entrypoint guard (mirrors bolt-wms's scripts/*.ts convention) — WITHOUT this, importing this
// module from its own test file would fire a real network call as a side effect of the import.
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] != null &&
  (process.argv[1].endsWith('provision-railway-vars.ts') || process.argv[1].endsWith('provision-railway-vars.js'));

if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`provision-railway-vars: unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
