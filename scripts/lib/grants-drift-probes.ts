// Grants Drift Monitor — live-state probes (ops#178).
//
// Every probe here is a thin `gh api` invocation. Callers get an ok/error result back — nothing
// throws. Errors capture the HTTP status (parsed from gh's own "... (HTTP NNN)" stderr suffix,
// same convention as lib/github-issues.ts's isOrgMember) plus a stderr snippet, per the design's
// "typed probe-failure" requirement — the orchestrator uses this to distinguish PROBE FAILED
// (state unknown) from DRIFT (state known and wrong), and to detect the MONITOR BLIND condition
// (every org-level probe failing the same missing-permission way, ops#178 design comment).
//
// Deliberately NOT reusing lib/github-issues.ts's `gh()` helper here — that file's job is issue
// MUTATION (open/close/retitle/comment); this file's job is grant-surface READS. Same underlying
// execFileSync shape, kept as a separate, smaller wrapper so the two concerns don't share a
// module boundary that has no reason to exist.
//
// Pagination: every list endpoint goes through `--paginate` (Rule #331) — a fleet-wide grant
// surface can legitimately exceed one page (e.g. org repos, ~103 as of 2026-08-21) and a silently
// truncated read here would under-report drift, not over-report it.

import { execFileSync } from "node:child_process";

export type ProbeResult<T> = { ok: true; data: T } | { ok: false; error: string; httpStatus: number | null };

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    const stderr = (err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? "";
    const combined = `${stderr}\n${err.message}`.trim();
    return combined.length > 0 ? combined : err.message;
  }
  return String(err);
}

function httpStatusFrom(detail: string): number | null {
  const m = /HTTP (\d{3})/.exec(detail);
  return m ? Number(m[1]) : null;
}

function toProbeFailure(err: unknown): { ok: false; error: string; httpStatus: number | null } {
  const detail = errorDetail(err);
  return { ok: false, error: detail, httpStatus: httpStatusFrom(detail) };
}

/** Single-object GET (no pagination) — e.g. `GET /orgs/{org}`. */
function ghApiOnce<T>(path: string): ProbeResult<T> {
  try {
    const out = gh(["api", path]);
    return { ok: true, data: JSON.parse(out) as T };
  } catch (err) {
    return toProbeFailure(err);
  }
}

/**
 * Paginated list GET. `jqFilter` must produce one JSON *object or array* value per line (gh's
 * --jq applies the filter to each page's response independently and --paginate concatenates the
 * output). Do NOT use this for a filter whose result is a bare top-level string (e.g. `.[].login`)
 * -- see ghApiListStrings() below for why.
 */
function ghApiList<T>(path: string, jqFilter: string): ProbeResult<T[]> {
  try {
    const out = gh(["api", path, "--paginate", "--jq", jqFilter]);
    const items = out
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
    return { ok: true, data: items };
  } catch (err) {
    return toProbeFailure(err);
  }
}

/**
 * Paginated list GET for a jq filter whose result is a bare top-level STRING (e.g. `.[].login`,
 * `.[].name`). `gh api --jq` emits RAW (unquoted) text for a top-level string result -- not valid
 * JSON -- while an object/array-shaped result (ghApiList's case) is unaffected and still comes
 * back as real per-line JSON. Live-verified 2026-08-21 against orgs/studio-b-ai/members: `--jq
 * '.[].login'` prints `kbibelhausen` (no quotes), and `JSON.parse("kbibelhausen")` throws
 * "Unexpected token 'k' ... is not valid JSON" -- the exact failure this dry-run caught on
 * org-members, every team/<slug> (team membership), and direct-grants (repo name listing) before
 * this helper existed. Each line IS the string value directly; no JSON.parse needed or wanted.
 */
function ghApiListStrings(path: string, jqFilter: string): ProbeResult<string[]> {
  try {
    const out = gh(["api", path, "--paginate", "--jq", jqFilter]);
    const items = out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return { ok: true, data: items };
  } catch (err) {
    return toProbeFailure(err);
  }
}

// ---------------------------------------------------------------------------------------------
// org-settings
// ---------------------------------------------------------------------------------------------

export interface OrgSettingsLive {
  default_repository_permission: string;
  two_factor_requirement_enabled: boolean;
}

/**
 * `default_repository_permission` and `two_factor_requirement_enabled` are admin-sensitive
 * fields on the "Get an organization" response — GitHub's documented behavior for an
 * insufficiently-privileged caller is to omit them from an otherwise-200 response, not to 403
 * the whole call. Both failure shapes (a thrown execFileSync error, or a 200 missing the fields)
 * are treated as probe failure here so the caller can't mistake "we couldn't see it" for "it's
 * false" (Rule #401 — absence needs a complete read, not a partial one).
 */
export function probeOrgSettings(org: string): ProbeResult<OrgSettingsLive> {
  const res = ghApiOnce<Record<string, unknown>>(`orgs/${org}`);
  if (!res.ok) return res;
  const { default_repository_permission, two_factor_requirement_enabled } = res.data;
  if (typeof default_repository_permission !== "string" || typeof two_factor_requirement_enabled !== "boolean") {
    return {
      ok: false,
      error:
        "org settings response missing default_repository_permission / two_factor_requirement_enabled (insufficient permission?)",
      httpStatus: null,
    };
  }
  return { ok: true, data: { default_repository_permission, two_factor_requirement_enabled } };
}

// ---------------------------------------------------------------------------------------------
// org members
// ---------------------------------------------------------------------------------------------

export interface MemberGrant {
  login: string;
  role: "admin" | "member";
}

export function probeMembers(org: string): ProbeResult<MemberGrant[]> {
  const all = ghApiListStrings(`orgs/${org}/members`, ".[].login");
  if (!all.ok) return all;
  const admins = ghApiListStrings(`orgs/${org}/members?role=admin`, ".[].login");
  if (!admins.ok) return admins;
  const adminSet = new Set(admins.data);
  return { ok: true, data: all.data.map((login) => ({ login, role: adminSet.has(login) ? "admin" : "member" })) };
}

// ---------------------------------------------------------------------------------------------
// outside collaborators
// ---------------------------------------------------------------------------------------------

export function probeOutsideCollaborators(org: string): ProbeResult<string[]> {
  return ghApiListStrings(`orgs/${org}/outside_collaborators`, ".[].login");
}

// ---------------------------------------------------------------------------------------------
// teams
// ---------------------------------------------------------------------------------------------

export interface TeamSummary {
  slug: string;
}

/** Top-level team list — used only to discover teams present live but absent from the manifest. */
export function probeTeamSlugs(org: string): ProbeResult<TeamSummary[]> {
  return ghApiList<TeamSummary>(`orgs/${org}/teams`, ".[] | {slug}");
}

export interface TeamRepoGrant {
  repo: string;
  role: string;
}

export interface TeamDetail {
  members: string[];
  repos: TeamRepoGrant[];
}

/**
 * Full detail for one team (members + per-repo role), addressed directly by slug — this does NOT
 * depend on probeTeamSlugs succeeding first, since every manifest-known slug is addressable on
 * its own. `data: null` means the team genuinely does not exist live (a 404 on either sub-call),
 * which is drift-relevant LIVE DATA, not a probe failure — distinct from every other error shape,
 * which means "we don't know" and IS a probe failure (Rule #401's absence-vs-unknown distinction).
 */
export function probeTeamDetail(org: string, slug: string): ProbeResult<TeamDetail | null> {
  const membersRes = ghApiListStrings(`orgs/${org}/teams/${slug}/members`, ".[].login");
  if (!membersRes.ok) {
    if (membersRes.httpStatus === 404) return { ok: true, data: null };
    return membersRes;
  }
  const reposRes = ghApiList<TeamRepoGrant>(`orgs/${org}/teams/${slug}/repos`, ".[] | {repo: .name, role: .role_name}");
  if (!reposRes.ok) {
    if (reposRes.httpStatus === 404) return { ok: true, data: null };
    return reposRes;
  }
  return { ok: true, data: { members: membersRes.data, repos: reposRes.data } };
}

// ---------------------------------------------------------------------------------------------
// direct repo grants
// ---------------------------------------------------------------------------------------------

export interface DirectGrant {
  repo: string;
  login: string;
  role: string;
}

function probeAllRepoNames(org: string): ProbeResult<string[]> {
  return ghApiListStrings(`orgs/${org}/repos`, ".[].name");
}

function probeDirectCollaboratorsForRepo(org: string, repo: string): ProbeResult<DirectGrant[]> {
  const res = ghApiList<{ login: string; role: string }>(
    `repos/${org}/${repo}/collaborators?affiliation=direct`,
    ".[] | {login, role: .role_name}",
  );
  if (!res.ok) return res;
  return { ok: true, data: res.data.map((c) => ({ repo, login: c.login, role: c.role })) };
}

/**
 * Aggregates direct (non-team, non-outside-collaborator-implied) collaborator grants across every
 * org repo — "exclude no one" per the design, so this walks the full org repo list (~103 repos as
 * of 2026-08-21) and fetches each repo's direct collaborators in turn. A single repo's failure
 * fails the whole `direct-grants` entity rather than returning partial data — partial data here
 * would silently under-report drift, which is worse than a loud PROBE FAILED (Rule #397's
 * "surface must say it hasn't [seen]" principle). This is the heaviest probe in the sweep
 * (~100+ `gh api` invocations); budgeted for a weekly cron, not a tight-latency check — this repo
 * needs only Metadata: read, already granted to fleet-bot today, so it works independently of the
 * MONITOR BLIND org-level permission gap (ops#178 design comment: "the collaborator leg works day
 * one").
 */
export function probeAllDirectGrants(org: string): ProbeResult<DirectGrant[]> {
  const repoNames = probeAllRepoNames(org);
  if (!repoNames.ok) return repoNames;
  const all: DirectGrant[] = [];
  for (const repo of repoNames.data) {
    const res = probeDirectCollaboratorsForRepo(org, repo);
    if (!res.ok) return { ok: false, error: `repo "${repo}": ${res.error}`, httpStatus: res.httpStatus };
    all.push(...res.data);
  }
  return { ok: true, data: all };
}

// ---------------------------------------------------------------------------------------------
// App installations
// ---------------------------------------------------------------------------------------------

export interface InstallationGrant {
  app_slug: string;
  repository_selection: string;
  permissions: Record<string, string>;
}

/**
 * One call returns full detail (selection + permissions) for every App installed on the org —
 * unlike teams, there's no separate per-app detail endpoint to fan out to. Needs org
 * Administration: read, which fleet-bot lacks pending the ops#178 Kevin click — this is the
 * probe whose failure signature seeds the MONITOR BLIND example in the design comment.
 */
export function probeInstallations(org: string): ProbeResult<InstallationGrant[]> {
  return ghApiList<InstallationGrant>(`orgs/${org}/installations`, ".installations[] | {app_slug, repository_selection, permissions}");
}
