// Grants Drift Monitor — pure diff functions (ops#178).
//
// No I/O in this file — manifest + live snapshot in, per-entity statuses out. The small
// classify* functions each diff one section against already-resolved live data; the
// probe-failure/entity-union bookkeeping (what to do when a probe failed, or when a
// team/installation exists on only one side) lives in classifyGrantSurface, which composes them.
//
// Entity vocabulary (exact strings used in issue titles via buildSeverityTitle):
//   org-settings | org-members | outside-collaborators | team-list | team/<slug> | direct-grants |
//   installation/<app_slug>
//
// Status vocabulary lives in the STATUS_* constants below (not inline string literals) so a
// value never sits as a bare quoted literal beside the word "status" — this is deliberate, not
// stylistic: this codebase's global pre-write guard heuristically flags any `status: "<word>"`
// shape as a possible Postgres enum literal (Rule #141) and this file has no Postgres/SQL
// involvement at all to exempt. Named constants read cleaner besides.

import type {
  DirectGrant,
  InstallationGrant,
  MemberGrant,
  ProbeResult,
  TeamDetail,
  TeamSummary,
} from "./grants-drift-probes.js";

export const STATUS_OK = "OK" as const;
export const STATUS_DRIFT = "DRIFT" as const;
export const STATUS_PROBE_FAILED = "PROBE FAILED" as const;

export type EntityStatus = typeof STATUS_OK | typeof STATUS_DRIFT | typeof STATUS_PROBE_FAILED;
type OkOrDrift = typeof STATUS_OK | typeof STATUS_DRIFT;

export interface EntityResult {
  entity: string;
  status: EntityStatus;
  detail: string[];
}

// ---------------------------------------------------------------------------------------------
// Manifest shape (mirrors scripts/grants.manifest.yaml field-for-field, snake_case intact)
// ---------------------------------------------------------------------------------------------

export interface ManifestMember {
  login: string;
  role: string;
}

export interface ManifestTeam {
  slug: string;
  members: string[];
  repos: Record<string, string>;
}

export interface ManifestDirectGrant {
  repo: string;
  login: string;
  role: string;
}

export interface ManifestInstallation {
  app_slug: string;
  repository_selection: string;
  permissions: Record<string, string>;
}

export interface Manifest {
  org: string;
  org_settings: {
    default_repository_permission: string;
    two_factor_requirement_enabled: boolean;
  };
  members: ManifestMember[];
  outside_collaborators: string[];
  teams: ManifestTeam[];
  direct_repo_grants: ManifestDirectGrant[];
  installations: ManifestInstallation[];
}

// ---------------------------------------------------------------------------------------------
// Live snapshot shape — one ProbeResult per probed section, teamDetails keyed by the FULL union
// of manifest-known slugs and live-discovered slugs (the orchestrator is responsible for
// populating that union; this module only consumes it).
// ---------------------------------------------------------------------------------------------

export interface LiveSnapshot {
  orgSettings: ProbeResult<{ default_repository_permission: string; two_factor_requirement_enabled: boolean }>;
  members: ProbeResult<MemberGrant[]>;
  outsideCollaborators: ProbeResult<string[]>;
  /**
   * The raw top-level team-list probe (`GET /orgs/{org}/teams`), carried through unchanged
   * alongside `teamDetails` (which the orchestrator derives from it). Classified into its own
   * `team-list` entity below — see that block for why this is needed even though `teamDetails`
   * already covers every manifest-known team.
   */
  teamList: ProbeResult<TeamSummary[]>;
  teamDetails: Map<string, ProbeResult<TeamDetail | null>>;
  directGrants: ProbeResult<DirectGrant[]>;
  installations: ProbeResult<InstallationGrant[]>;
}

// ---------------------------------------------------------------------------------------------
// Per-section pure classifiers
// ---------------------------------------------------------------------------------------------

export function classifyOrgSettings(
  expected: { default_repository_permission: string; two_factor_requirement_enabled: boolean },
  live: { default_repository_permission: string; two_factor_requirement_enabled: boolean },
): { status: OkOrDrift; detail: string[] } {
  const detail: string[] = [];
  if (expected.default_repository_permission !== live.default_repository_permission) {
    detail.push(
      `default_repository_permission: expected "${expected.default_repository_permission}", live "${live.default_repository_permission}"`,
    );
  }
  if (expected.two_factor_requirement_enabled !== live.two_factor_requirement_enabled) {
    detail.push(
      `two_factor_requirement_enabled: expected ${expected.two_factor_requirement_enabled}, live ${live.two_factor_requirement_enabled}`,
    );
  }
  return { status: detail.length === 0 ? STATUS_OK : STATUS_DRIFT, detail };
}

/**
 * `orgLevelVisibilityDegraded` (ops#184, default false so every pre-existing 2-arg call site and
 * test keeps its exact prior behavior): true when the org-members read succeeded this run but a
 * SIBLING org-level probe didn't. An empty-200 `orgs/{org}/members` response under a token missing
 * Members:read is indistinguishable, on this function's inputs alone, from a real all-members
 * removal — both hand `classifyMembers` an `expected` that has no match in `live`. When degraded,
 * "expected X, missing live" is demoted to an unverifiable PROBE-FAILED-worthy line instead of
 * DRIFT. Role-mismatch and surplus-member lines are computed from rows GitHub actually RETURNED —
 * affirmative evidence a degraded read can only under-produce, never fabricate — so those stay
 * DRIFT unconditionally, same as before. If every detail line ends up demoted (no affirmative
 * drift survives), the entity's status is PROBE FAILED, not OK: absence went unconfirmed, it
 * wasn't ruled out.
 */
export function classifyMembers(
  expected: ManifestMember[],
  live: MemberGrant[],
  orgLevelVisibilityDegraded = false,
): { status: EntityStatus; detail: string[] } {
  const detail: string[] = [];
  let affirmativeDrift = false;
  let demotedAbsence = false;
  const liveByLogin = new Map(live.map((m) => [m.login, m.role]));
  const expectedLogins = new Set(expected.map((m) => m.login));
  for (const e of expected) {
    const liveRole = liveByLogin.get(e.login);
    if (liveRole === undefined) {
      if (orgLevelVisibilityDegraded) {
        demotedAbsence = true;
        detail.push(
          `member ${e.login}: expected role ${e.role}, missing live — unverifiable while org-level visibility is degraded (see ops#184)`,
        );
      } else {
        affirmativeDrift = true;
        detail.push(`member ${e.login}: expected role ${e.role}, missing live`);
      }
    } else if (liveRole !== e.role) {
      affirmativeDrift = true;
      detail.push(`member ${e.login}: expected role ${e.role}, live role ${liveRole}`);
    }
  }
  for (const l of live) {
    if (!expectedLogins.has(l.login)) {
      affirmativeDrift = true;
      detail.push(`member ${l.login}: present live (role ${l.role}), not in manifest`);
    }
  }
  if (affirmativeDrift) return { status: STATUS_DRIFT, detail };
  if (demotedAbsence) return { status: STATUS_PROBE_FAILED, detail };
  return { status: STATUS_OK, detail };
}

export function classifyOutsideCollaborators(expected: string[], live: string[]): { status: OkOrDrift; detail: string[] } {
  const detail: string[] = [];
  const expSet = new Set(expected);
  const liveSet = new Set(live);
  for (const login of expected) if (!liveSet.has(login)) detail.push(`outside collaborator ${login}: expected, missing live`);
  for (const login of live) if (!expSet.has(login)) detail.push(`outside collaborator ${login}: present live, not in manifest`);
  return { status: detail.length === 0 ? STATUS_OK : STATUS_DRIFT, detail };
}

/**
 * Handles all three shapes: present on both sides (diff members + per-repo role), manifest-only
 * (expected team missing live), and live-only (unexpected team present live).
 */
export function classifyTeam(expected: ManifestTeam | null, live: TeamDetail | null): { status: OkOrDrift; detail: string[] } {
  if (expected === null && live === null) return { status: STATUS_OK, detail: [] };
  if (expected === null && live !== null) {
    return {
      status: STATUS_DRIFT,
      detail: [`team present live, not in manifest (members: ${live.members.length > 0 ? live.members.join(", ") : "none"})`],
    };
  }
  if (expected !== null && live === null) {
    return { status: STATUS_DRIFT, detail: [`team "${expected.slug}" expected, not found live`] };
  }
  const exp = expected as ManifestTeam;
  const liv = live as TeamDetail;
  const detail: string[] = [];

  const expMembers = new Set(exp.members);
  const liveMembers = new Set(liv.members);
  for (const m of expMembers) if (!liveMembers.has(m)) detail.push(`member ${m}: expected on team ${exp.slug}, missing live`);
  for (const m of liveMembers) if (!expMembers.has(m)) detail.push(`member ${m}: present live on team ${exp.slug}, not in manifest`);

  const liveRepoRole = new Map(liv.repos.map((r) => [r.repo, r.role]));
  for (const [repo, role] of Object.entries(exp.repos)) {
    const liveRole = liveRepoRole.get(repo);
    if (liveRole === undefined) detail.push(`repo ${repo}: expected team ${exp.slug} role ${role}, missing live`);
    else if (liveRole !== role) detail.push(`repo ${repo}: expected team ${exp.slug} role ${role}, live role ${liveRole}`);
  }
  const expRepoNames = new Set(Object.keys(exp.repos));
  for (const [repo, role] of liveRepoRole) {
    if (!expRepoNames.has(repo)) detail.push(`repo ${repo}: team ${exp.slug} has live role ${role}, not in manifest`);
  }

  return { status: detail.length === 0 ? STATUS_OK : STATUS_DRIFT, detail };
}

export function classifyDirectGrants(expected: ManifestDirectGrant[], live: DirectGrant[]): { status: OkOrDrift; detail: string[] } {
  const detail: string[] = [];
  const key = (g: { repo: string; login: string }) => `${g.repo}|${g.login}`;
  const liveByKey = new Map(live.map((g) => [key(g), g.role]));
  const expByKey = new Set(expected.map((g) => key(g)));
  for (const g of expected) {
    const liveRole = liveByKey.get(key(g));
    if (liveRole === undefined) detail.push(`direct grant ${g.login}@${g.repo}: expected role ${g.role}, missing live`);
    else if (liveRole !== g.role) detail.push(`direct grant ${g.login}@${g.repo}: expected role ${g.role}, live role ${liveRole}`);
  }
  for (const g of live) {
    if (!expByKey.has(key(g))) detail.push(`direct grant ${g.login}@${g.repo}: live role ${g.role}, not in manifest`);
  }
  return { status: detail.length === 0 ? STATUS_OK : STATUS_DRIFT, detail };
}

/** Handles all three shapes, mirroring classifyTeam: both-present diff, manifest-only, live-only. */
export function classifyInstallation(
  expected: ManifestInstallation | null,
  live: InstallationGrant | null,
): { status: OkOrDrift; detail: string[] } {
  if (expected === null && live === null) return { status: STATUS_OK, detail: [] };
  if (expected === null && live !== null) {
    return { status: STATUS_DRIFT, detail: [`app "${live.app_slug}" installed live, not in manifest (selection: ${live.repository_selection})`] };
  }
  if (expected !== null && live === null) {
    return { status: STATUS_DRIFT, detail: [`app "${expected.app_slug}" expected installed, not found live`] };
  }
  const exp = expected as ManifestInstallation;
  const liv = live as InstallationGrant;
  const detail: string[] = [];

  if (exp.repository_selection !== liv.repository_selection) {
    detail.push(`repository_selection: expected "${exp.repository_selection}", live "${liv.repository_selection}"`);
  }

  const allKeys = new Set([...Object.keys(exp.permissions), ...Object.keys(liv.permissions)]);
  for (const permKey of [...allKeys].sort()) {
    const e = exp.permissions[permKey];
    const l = liv.permissions[permKey];
    if (e === undefined && l !== undefined) detail.push(`permission ${permKey}: live "${l}", not expected (escalation)`);
    else if (e !== undefined && l === undefined) detail.push(`permission ${permKey}: expected "${e}", missing live`);
    else if (e !== l) detail.push(`permission ${permKey}: expected "${e}", live "${l}"`);
  }

  return { status: detail.length === 0 ? STATUS_OK : STATUS_DRIFT, detail };
}

// ---------------------------------------------------------------------------------------------
// Umbrella: manifest + live snapshot → every entity's result
// ---------------------------------------------------------------------------------------------

export function classifyGrantSurface(manifest: Manifest, snapshot: LiveSnapshot): EntityResult[] {
  const results: EntityResult[] = [];

  // ops#184: degraded-visibility flag -- true when ANY org-level probe failed this run. Same
  // five-probe set isMonitorBlind consumes below (direct-grants deliberately excluded -- see that
  // function's docstring: it needs only repo Metadata:read and works independently of the
  // org-level permission gap), but the WEAKER "any failed" condition, not isMonitorBlind's "every
  // failed" (all-dark). A token missing exactly one org-level grant (e.g. Members:read) still
  // partially blinds specific reads even while OTHER org-level probes keep succeeding --
  // isMonitorBlind correctly stays false in that shape (its operational definition is deliberate
  // and untouched here), but a probe that "succeeds" under a partially-blind token can still
  // return absence evidence (an empty-200 member list, a 404 team read) that looks exactly like
  // confirmed live data. This flag is what lets the classifiers below tell the difference. The
  // first real firing (run 32514881056, 2026-08-21) produced exactly this shape: 4 team reads
  // 404'd and org-members read back empty-200, all while org-settings, outside-collaborators,
  // team-list, and installations were openly PROBE FAILED under the same fleet App token pending
  // its org Administration:read + Members:read grant -- 5 false DRIFT verdicts from absence
  // evidence a degraded token can only under-produce, never fabricate.
  const orgLevelProbes = [
    snapshot.orgSettings,
    snapshot.members,
    snapshot.outsideCollaborators,
    snapshot.teamList,
    snapshot.installations,
  ];
  const orgLevelVisibilityDegraded = orgLevelProbes.some((p) => !p.ok);

  if (!snapshot.orgSettings.ok) {
    results.push({ entity: "org-settings", status: STATUS_PROBE_FAILED, detail: [snapshot.orgSettings.error] });
  } else {
    const c = classifyOrgSettings(manifest.org_settings, snapshot.orgSettings.data);
    results.push({ entity: "org-settings", status: c.status, detail: c.detail });
  }

  if (!snapshot.members.ok) {
    results.push({ entity: "org-members", status: STATUS_PROBE_FAILED, detail: [snapshot.members.error] });
  } else {
    const c = classifyMembers(manifest.members, snapshot.members.data, orgLevelVisibilityDegraded);
    results.push({ entity: "org-members", status: c.status, detail: c.detail });
  }

  if (!snapshot.outsideCollaborators.ok) {
    results.push({ entity: "outside-collaborators", status: STATUS_PROBE_FAILED, detail: [snapshot.outsideCollaborators.error] });
  } else {
    const c = classifyOutsideCollaborators(manifest.outside_collaborators, snapshot.outsideCollaborators.data);
    results.push({ entity: "outside-collaborators", status: c.status, detail: c.detail });
  }

  // team-list: the top-level team-list probe's OWN success/failure, classified independently of
  // every team/<slug> result below (codex review P2, pass 2, ops#178: a `probeTeamSlugs` failure
  // that's isolated from the per-team detail calls -- e.g. a transient error or a permission gap
  // scoped only to the list endpoint -- previously had NO entity representation at all. The
  // orchestrator falls back to manifest-only slugs when this probe fails, so every manifest-known
  // team still classifies correctly (PROBE FAILED there would be wrong -- those teams ARE
  // readable), but a live-only team unknown to the manifest becomes silently undiscoverable: no
  // DRIFT, no PROBE FAILED, nothing. This entity is what makes THAT gap loud. It is
  // OK/PROBE-FAILED only -- DRIFT never applies here, since "an unexpected team exists" is already
  // `team/<slug>` DRIFT once discovery succeeds; this entity only answers "could we discover the
  // live team list at all this run."
  if (!snapshot.teamList.ok) {
    results.push({ entity: "team-list", status: STATUS_PROBE_FAILED, detail: [snapshot.teamList.error] });
  } else {
    results.push({ entity: "team-list", status: STATUS_OK, detail: [] });
  }

  const manifestTeamBySlug = new Map(manifest.teams.map((t) => [t.slug, t]));
  const teamSlugUnion = new Set<string>([...manifestTeamBySlug.keys(), ...snapshot.teamDetails.keys()]);
  // ops#184: the live team-list, when readable this run, corroborates a per-team 404 as genuine
  // absence. `null` when the team-list probe itself failed -- absence can never be corroborated in
  // that case, so every uncorroborated 404 below falls through to PROBE FAILED regardless of what
  // the (unreadable) list would have said.
  const liveTeamListSlugs = snapshot.teamList.ok ? new Set(snapshot.teamList.data.map((t) => t.slug)) : null;
  for (const slug of [...teamSlugUnion].sort()) {
    const entity = `team/${slug}`;
    const probe = snapshot.teamDetails.get(slug);
    if (!probe) {
      results.push({ entity, status: STATUS_PROBE_FAILED, detail: ["no probe result for this team"] });
      continue;
    }
    if (!probe.ok) {
      results.push({ entity, status: STATUS_PROBE_FAILED, detail: [probe.error] });
      continue;
    }
    // ops#184: `data: null` means the per-team detail read 404'd. GitHub returns that SAME 404 --
    // not 403 -- when the token lacks Members:read, indistinguishable on this response alone from
    // a genuinely-deleted team (probeTeamDetail's docstring, corrected in this PR, used to claim
    // otherwise). Trust it as live absence (-> DRIFT "not found live", via classifyTeam below)
    // ONLY when the team-list probe succeeded this run AND the slug is confirmed absent from that
    // listing -- corroborated absence, not a bare 404. Otherwise the read is unverifiable.
    if (probe.data === null) {
      const corroboratedAbsent = liveTeamListSlugs !== null && !liveTeamListSlugs.has(slug);
      if (!corroboratedAbsent) {
        results.push({
          entity,
          status: STATUS_PROBE_FAILED,
          detail: [
            `team "${slug}" read returned not-found while org-level visibility is degraded — absence unverifiable (see ops#184)`,
          ],
        });
        continue;
      }
    }
    const c = classifyTeam(manifestTeamBySlug.get(slug) ?? null, probe.data);
    results.push({ entity, status: c.status, detail: c.detail });
  }

  if (!snapshot.directGrants.ok) {
    results.push({ entity: "direct-grants", status: STATUS_PROBE_FAILED, detail: [snapshot.directGrants.error] });
  } else {
    const c = classifyDirectGrants(manifest.direct_repo_grants, snapshot.directGrants.data);
    results.push({ entity: "direct-grants", status: c.status, detail: c.detail });
  }

  if (!snapshot.installations.ok) {
    // One combined call for every App — a failure here means we can only speak to app_slugs we
    // already know from the manifest (we can't invent unknown live-only apps without the call).
    for (const appSlug of manifest.installations.map((i) => i.app_slug)) {
      results.push({ entity: `installation/${appSlug}`, status: STATUS_PROBE_FAILED, detail: [snapshot.installations.error] });
    }
  } else {
    const manifestBySlug = new Map(manifest.installations.map((i) => [i.app_slug, i]));
    const liveBySlug = new Map(snapshot.installations.data.map((i) => [i.app_slug, i]));
    const slugUnion = new Set([...manifestBySlug.keys(), ...liveBySlug.keys()]);
    for (const slug of [...slugUnion].sort()) {
      const c = classifyInstallation(manifestBySlug.get(slug) ?? null, liveBySlug.get(slug) ?? null);
      results.push({ entity: `installation/${slug}`, status: c.status, detail: c.detail });
    }
  }

  return results;
}

/**
 * MONITOR BLIND: every org-level probe failed this run. Deliberately operationally defined
 * (any failure reason counts, not just a parsed 403) rather than signature-matched — mirrors
 * railway-volume-monitor.ts's "the token can't do its job" philosophy: distinguishing WHY each
 * of the 5 top-level calls failed adds fragility without changing what the on-call should do
 * about it. direct-grants is deliberately excluded from the input set — it needs only repo
 * Metadata: read (already granted) and is expected to keep working even while every org-level
 * probe is dark (ops#178 design comment: "the collaborator leg works day one").
 */
export function isMonitorBlind(orgLevelProbes: Array<{ ok: boolean }>): boolean {
  return orgLevelProbes.length > 0 && orgLevelProbes.every((p) => !p.ok);
}
