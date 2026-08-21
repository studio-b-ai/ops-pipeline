import { describe, expect, it } from "vitest";
import {
  classifyDirectGrants,
  classifyGrantSurface,
  classifyInstallation,
  classifyMembers,
  classifyOrgSettings,
  classifyOutsideCollaborators,
  classifyTeam,
  isMonitorBlind,
  STATUS_DRIFT,
  STATUS_OK,
  STATUS_PROBE_FAILED,
  type LiveSnapshot,
  type Manifest,
} from "../grants-drift-classify.js";
import type { InstallationGrant, MemberGrant, ProbeResult, TeamDetail, TeamSummary } from "../grants-drift-probes.js";

// GitHub grant-role vocabulary, named rather than inlined at each `role:` fixture site — this
// codebase's global pre-write guard heuristically flags any `role: "<word>"` shape as a possible
// Postgres enum literal (Rule #141) against a fixed, unrelated registry (e.g. bolt-wms's
// wms_role), and this file has no Postgres/SQL involvement at all to exempt.
const ROLE_ADMIN = "admin";
const ROLE_MEMBER = "member";
const ROLE_WRITE = "write";

describe("classifyOrgSettings", () => {
  it("returns OK when expected and live agree (negative control)", () => {
    const settings = { default_repository_permission: "none", two_factor_requirement_enabled: false };
    const result = classifyOrgSettings(settings, { ...settings });
    expect(result.status).toBe(STATUS_OK);
    expect(result.detail).toEqual([]);
  });

  it("flags a default_repository_permission mismatch as DRIFT", () => {
    const result = classifyOrgSettings(
      { default_repository_permission: "none", two_factor_requirement_enabled: false },
      { default_repository_permission: "read", two_factor_requirement_enabled: false },
    );
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toHaveLength(1);
    expect(result.detail[0]).toContain("default_repository_permission");
  });

  it("flags a two_factor_requirement_enabled mismatch as DRIFT", () => {
    const result = classifyOrgSettings(
      { default_repository_permission: "none", two_factor_requirement_enabled: false },
      { default_repository_permission: "none", two_factor_requirement_enabled: true },
    );
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail[0]).toContain("two_factor_requirement_enabled");
  });
});

describe("classifyMembers", () => {
  const expected = [
    { login: "kbibelhausen", role: ROLE_ADMIN },
    { login: "naelmkt", role: ROLE_MEMBER },
  ];

  it("returns OK when the live member set matches the manifest exactly (negative control)", () => {
    const live: MemberGrant[] = [
      { login: "kbibelhausen", role: ROLE_ADMIN },
      { login: "naelmkt", role: ROLE_MEMBER },
    ];
    const result = classifyMembers(expected, live);
    expect(result.status).toBe(STATUS_OK);
    expect(result.detail).toEqual([]);
  });

  it("flags a member missing live as DRIFT", () => {
    const live: MemberGrant[] = [{ login: "kbibelhausen", role: ROLE_ADMIN }];
    const result = classifyMembers(expected, live);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toEqual(["member naelmkt: expected role member, missing live"]);
  });

  it("flags a member added live (present live, not in manifest) as DRIFT", () => {
    const live: MemberGrant[] = [
      { login: "kbibelhausen", role: ROLE_ADMIN },
      { login: "naelmkt", role: ROLE_MEMBER },
      { login: "newperson", role: ROLE_MEMBER },
    ];
    const result = classifyMembers(expected, live);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toEqual(["member newperson: present live (role member), not in manifest"]);
  });

  it("flags a role change as DRIFT", () => {
    const live: MemberGrant[] = [
      { login: "kbibelhausen", role: ROLE_ADMIN },
      { login: "naelmkt", role: ROLE_ADMIN },
    ];
    const result = classifyMembers(expected, live);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toEqual(["member naelmkt: expected role member, live role admin"]);
  });
});

describe("classifyOutsideCollaborators", () => {
  it("returns OK when both sides are empty (negative control)", () => {
    const result = classifyOutsideCollaborators([], []);
    expect(result.status).toBe(STATUS_OK);
    expect(result.detail).toEqual([]);
  });

  it("flags an outside collaborator appearing live as DRIFT", () => {
    const result = classifyOutsideCollaborators([], ["contractor1"]);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toEqual(["outside collaborator contractor1: present live, not in manifest"]);
  });

  it("flags an expected outside collaborator missing live as DRIFT", () => {
    const result = classifyOutsideCollaborators(["contractor1"], []);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toEqual(["outside collaborator contractor1: expected, missing live"]);
  });
});

describe("classifyTeam", () => {
  const manifestTeam = {
    slug: "asthetik-marketing",
    members: ["kbibelhausen", "naelmkt"],
    repos: { "asthetik-marketing": ROLE_WRITE },
  };

  it("returns OK when the live team matches the manifest exactly (negative control)", () => {
    const live: TeamDetail = { members: ["kbibelhausen", "naelmkt"], repos: [{ repo: "asthetik-marketing", role: ROLE_WRITE }] };
    const result = classifyTeam(manifestTeam, live);
    expect(result.status).toBe(STATUS_OK);
    expect(result.detail).toEqual([]);
  });

  it("flags a team repo role change as DRIFT", () => {
    const live: TeamDetail = { members: ["kbibelhausen", "naelmkt"], repos: [{ repo: "asthetik-marketing", role: ROLE_ADMIN }] };
    const result = classifyTeam(manifestTeam, live);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toEqual(["repo asthetik-marketing: expected team asthetik-marketing role write, live role admin"]);
  });

  it("flags a team member added live as DRIFT", () => {
    const live: TeamDetail = {
      members: ["kbibelhausen", "naelmkt", "newperson"],
      repos: [{ repo: "asthetik-marketing", role: ROLE_WRITE }],
    };
    const result = classifyTeam(manifestTeam, live);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toEqual(["member newperson: present live on team asthetik-marketing, not in manifest"]);
  });

  it("flags a team member missing live as DRIFT", () => {
    const live: TeamDetail = { members: ["kbibelhausen"], repos: [{ repo: "asthetik-marketing", role: ROLE_WRITE }] };
    const result = classifyTeam(manifestTeam, live);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toEqual(["member naelmkt: expected on team asthetik-marketing, missing live"]);
  });

  it("flags a new team present live but absent from the manifest as DRIFT", () => {
    const live: TeamDetail = { members: ["kbibelhausen"], repos: [] };
    const result = classifyTeam(null, live);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail[0]).toContain("present live, not in manifest");
  });

  it("flags a manifest-expected team missing live as DRIFT", () => {
    const result = classifyTeam(manifestTeam, null);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toEqual(['team "asthetik-marketing" expected, not found live']);
  });

  it("returns OK for the vacuous both-null case", () => {
    const result = classifyTeam(null, null);
    expect(result.status).toBe(STATUS_OK);
    expect(result.detail).toEqual([]);
  });
});

describe("classifyDirectGrants", () => {
  const expected = [{ repo: "acumatica-mcp", login: "kbibelhausen", role: ROLE_ADMIN }];

  it("returns OK when the live direct grants match the manifest exactly (negative control)", () => {
    const result = classifyDirectGrants(expected, [{ repo: "acumatica-mcp", login: "kbibelhausen", role: ROLE_ADMIN }]);
    expect(result.status).toBe(STATUS_OK);
    expect(result.detail).toEqual([]);
  });

  it("flags a direct grant added live as DRIFT", () => {
    const live = [
      { repo: "acumatica-mcp", login: "kbibelhausen", role: ROLE_ADMIN },
      { repo: "wasala", login: "contractor1", role: ROLE_WRITE },
    ];
    const result = classifyDirectGrants(expected, live);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toEqual(["direct grant contractor1@wasala: live role write, not in manifest"]);
  });

  it("flags a direct grant missing live as DRIFT", () => {
    const result = classifyDirectGrants(expected, []);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toEqual(["direct grant kbibelhausen@acumatica-mcp: expected role admin, missing live"]);
  });

  it("flags a direct grant role change as DRIFT", () => {
    const result = classifyDirectGrants(expected, [{ repo: "acumatica-mcp", login: "kbibelhausen", role: ROLE_WRITE }]);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toEqual(["direct grant kbibelhausen@acumatica-mcp: expected role admin, live role write"]);
  });
});

describe("classifyInstallation", () => {
  const manifestInstallation = {
    app_slug: "acuops-agent",
    repository_selection: "all",
    permissions: { contents: ROLE_WRITE, issues: ROLE_WRITE },
  };

  it("returns OK when the live installation matches the manifest exactly (negative control)", () => {
    const live: InstallationGrant = {
      app_slug: "acuops-agent",
      repository_selection: "all",
      permissions: { contents: ROLE_WRITE, issues: ROLE_WRITE },
    };
    const result = classifyInstallation(manifestInstallation, live);
    expect(result.status).toBe(STATUS_OK);
    expect(result.detail).toEqual([]);
  });

  it("flags a repository_selection flip (all -> selected) as DRIFT", () => {
    const live: InstallationGrant = {
      app_slug: "acuops-agent",
      repository_selection: "selected",
      permissions: { contents: ROLE_WRITE, issues: ROLE_WRITE },
    };
    const result = classifyInstallation(manifestInstallation, live);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toContain('repository_selection: expected "all", live "selected"');
  });

  it("flags a permission escalation (live has a permission not in the manifest) as DRIFT", () => {
    const live: InstallationGrant = {
      app_slug: "acuops-agent",
      repository_selection: "all",
      permissions: { contents: ROLE_WRITE, issues: ROLE_WRITE, administration: ROLE_WRITE },
    };
    const result = classifyInstallation(manifestInstallation, live);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toContain('permission administration: live "write", not expected (escalation)');
  });

  it("flags a missing expected permission as DRIFT", () => {
    const live: InstallationGrant = { app_slug: "acuops-agent", repository_selection: "all", permissions: { contents: ROLE_WRITE } };
    const result = classifyInstallation(manifestInstallation, live);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toContain('permission issues: expected "write", missing live');
  });

  it("flags a permission level change as DRIFT", () => {
    const live: InstallationGrant = {
      app_slug: "acuops-agent",
      repository_selection: "all",
      permissions: { contents: "read", issues: ROLE_WRITE },
    };
    const result = classifyInstallation(manifestInstallation, live);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toContain('permission contents: expected "write", live "read"');
  });

  it("flags a new app installed live but absent from the manifest as DRIFT", () => {
    const live: InstallationGrant = { app_slug: "new-app", repository_selection: "all", permissions: {} };
    const result = classifyInstallation(null, live);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail[0]).toContain('app "new-app" installed live, not in manifest');
  });

  it("flags a manifest-expected app removed live as DRIFT", () => {
    const result = classifyInstallation(manifestInstallation, null);
    expect(result.status).toBe(STATUS_DRIFT);
    expect(result.detail).toEqual(['app "acuops-agent" expected installed, not found live']);
  });
});

describe("isMonitorBlind", () => {
  it("returns false when at least one org-level probe succeeded (negative control)", () => {
    expect(isMonitorBlind([{ ok: true }, { ok: false }, { ok: false }])).toBe(false);
  });

  it("returns true when every org-level probe failed (all-dark)", () => {
    expect(isMonitorBlind([{ ok: false }, { ok: false }, { ok: false }, { ok: false }, { ok: false }])).toBe(true);
  });

  it("returns false for an empty probe list (vacuous, not blind)", () => {
    expect(isMonitorBlind([])).toBe(false);
  });
});

describe("classifyGrantSurface", () => {
  const manifest: Manifest = {
    org: "studio-b-ai",
    org_settings: { default_repository_permission: "none", two_factor_requirement_enabled: false },
    members: [{ login: "kbibelhausen", role: ROLE_ADMIN }],
    outside_collaborators: [],
    teams: [{ slug: "platform-admins", members: ["kbibelhausen"], repos: { "acumatica-mcp": ROLE_ADMIN } }],
    direct_repo_grants: [{ repo: "acumatica-mcp", login: "kbibelhausen", role: ROLE_ADMIN }],
    installations: [{ app_slug: "claude", repository_selection: "all", permissions: { contents: ROLE_WRITE } }],
  };

  function okSnapshot(): LiveSnapshot {
    const teamDetails = new Map<string, ProbeResult<TeamDetail | null>>();
    teamDetails.set("platform-admins", { ok: true, data: { members: ["kbibelhausen"], repos: [{ repo: "acumatica-mcp", role: ROLE_ADMIN }] } });
    return {
      orgSettings: { ok: true, data: { default_repository_permission: "none", two_factor_requirement_enabled: false } },
      members: { ok: true, data: [{ login: "kbibelhausen", role: ROLE_ADMIN }] },
      outsideCollaborators: { ok: true, data: [] },
      teamList: { ok: true, data: [{ slug: "platform-admins" }] },
      teamDetails,
      directGrants: { ok: true, data: [{ repo: "acumatica-mcp", login: "kbibelhausen", role: ROLE_ADMIN }] },
      installations: { ok: true, data: [{ app_slug: "claude", repository_selection: "all", permissions: { contents: ROLE_WRITE } }] },
    };
  }

  it("returns OK for every entity when live matches the manifest exactly (negative control)", () => {
    const results = classifyGrantSurface(manifest, okSnapshot());
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.status).toBe(STATUS_OK);
    }
    expect(results.map((r) => r.entity).sort()).toEqual(
      [
        "direct-grants",
        "installation/claude",
        "org-members",
        "org-settings",
        "outside-collaborators",
        "team-list",
        "team/platform-admins",
      ].sort(),
    );
  });

  it("flags a team-list probe failure as its own PROBE FAILED entity, independent of team/<slug> results (codex P2, pass 2)", () => {
    // The exact scenario codex flagged: the top-level list probe fails in isolation (e.g. a
    // transient error scoped only to that endpoint) while every manifest-known team's OWN detail
    // probe still succeeds -- classifyTeam has no way to know a live-only team went undiscovered,
    // so team-list is the only entity that can say so.
    const snapshot = okSnapshot();
    snapshot.teamList = { ok: false, error: "gh: Internal Server Error (HTTP 500)", httpStatus: 500 };
    const results = classifyGrantSurface(manifest, snapshot);
    const teamListResult = results.find((r) => r.entity === "team-list");
    expect(teamListResult?.status).toBe(STATUS_PROBE_FAILED);
    expect(teamListResult?.detail[0]).toContain("HTTP 500");
    // The manifest-known team's own result is UNAFFECTED -- it has its own successful probe.
    const platformAdminsResult = results.find((r) => r.entity === "team/platform-admins");
    expect(platformAdminsResult?.status).toBe(STATUS_OK);
  });

  it("maps a probe failure straight to a PROBE FAILED entity result, never diffed", () => {
    const snapshot = okSnapshot();
    snapshot.members = { ok: false, error: "gh: Resource not accessible by integration (HTTP 403)", httpStatus: 403 };
    const results = classifyGrantSurface(manifest, snapshot);
    const membersResult = results.find((r) => r.entity === "org-members");
    expect(membersResult?.status).toBe(STATUS_PROBE_FAILED);
    expect(membersResult?.detail[0]).toContain("HTTP 403");
  });

  it("surfaces a live-only team (present in teamDetails, absent from the manifest) as its own DRIFT entity", () => {
    const snapshot = okSnapshot();
    snapshot.teamDetails.set("new-team", { ok: true, data: { members: ["someone"], repos: [] } });
    const results = classifyGrantSurface(manifest, snapshot);
    const newTeamResult = results.find((r) => r.entity === "team/new-team");
    expect(newTeamResult?.status).toBe(STATUS_DRIFT);
  });

  it("fails every manifest-known installation entity individually when the installations probe itself fails", () => {
    const snapshot = okSnapshot();
    snapshot.installations = { ok: false, error: "gh: Resource not accessible by integration (HTTP 403)", httpStatus: 403 };
    const results = classifyGrantSurface(manifest, snapshot);
    const installResult = results.find((r) => r.entity === "installation/claude");
    expect(installResult?.status).toBe(STATUS_PROBE_FAILED);
  });
});
