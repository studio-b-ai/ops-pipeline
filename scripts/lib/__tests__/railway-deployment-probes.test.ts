// pg-enum-drift-exempt: every `status` literal in this file is Railway's GraphQL
// DeploymentStatus enum (SUCCESS/FAILED/CRASHED/BUILDING/...) fetched over HTTP from
// backboard.railway.com — there is no Postgres table or `sync_status` column anywhere in this
// file or the module it tests (railway-deployment-probes.ts). Repeated immediately before each
// literal below too (guard-window discipline), not because file-wide coverage is in doubt.
import { describe, it, expect } from "vitest";
import {
  latestSuccessfulDeployment,
  parseProjectRefsResponse,
  parseServiceDeploymentsResponse,
  type DeploymentRecord,
} from "../railway-deployment-probes.js";

describe("parseProjectRefsResponse", () => {
  it("returns services + environments on success", () => {
    const json = {
      data: {
        project: {
          id: "proj-1",
          name: "studiob-platform",
          services: { edges: [{ node: { id: "svc-api", name: "studiob-api" } }] },
          environments: { edges: [{ node: { id: "env-prod", name: "production" } }] },
        },
      },
    };
    expect(parseProjectRefsResponse(json)).toEqual({
      services: [{ id: "svc-api", name: "studiob-api" }],
      environments: [{ id: "env-prod", name: "production" }],
    });
  });

  it("throws on a GraphQL errors array (network seam turns this into {ok:false} — see fetchProjectRefs)", () => {
    const json = { data: null, errors: [{ message: "Not Authorized" }] } as never;
    expect(() => parseProjectRefsResponse(json)).toThrow(/Not Authorized/);
  });

  it("throws when project is missing entirely", () => {
    expect(() => parseProjectRefsResponse({ data: {} } as never)).toThrow(/no data/);
  });

  it("empty services/environments connections resolve to empty arrays, not a throw", () => {
    const json = {
      data: {
        project: { id: "proj-1", name: "studiob-platform", services: null, environments: null },
      },
    } as never;
    expect(parseProjectRefsResponse(json)).toEqual({ services: [], environments: [] });
  });
});

describe("parseServiceDeploymentsResponse", () => {
  it("returns the deployment list on success", () => {
    // pg-enum-drift-exempt: Railway DeploymentStatus, not a Postgres enum (both lines below).
    // pg-enum-drift-exempt: Railway DeploymentStatus, not a Postgres enum (both lines below).
    const json = {
      data: {
        deployments: {
          edges: [
            // pg-enum-drift-exempt: Railway DeploymentStatus, not a Postgres enum.
            { node: { id: "dep-1", status: "SUCCESS", createdAt: "2026-08-19T08:00:00.000Z", updatedAt: "2026-08-19T08:05:00.000Z" } },
            // pg-enum-drift-exempt: Railway DeploymentStatus, not a Postgres enum.
            { node: { id: "dep-2", status: "FAILED", createdAt: "2026-08-19T07:00:00.000Z", updatedAt: "2026-08-19T07:02:00.000Z" } },
          ],
        },
      },
    };
    // pg-enum-drift-exempt: Railway DeploymentStatus, not a Postgres enum (both lines below).
    // pg-enum-drift-exempt: Railway DeploymentStatus, not a Postgres enum (both lines below).
    expect(parseServiceDeploymentsResponse(json)).toEqual([
      // pg-enum-drift-exempt: Railway DeploymentStatus, not a Postgres enum.
      { id: "dep-1", status: "SUCCESS", createdAt: "2026-08-19T08:00:00.000Z", updatedAt: "2026-08-19T08:05:00.000Z" },
      // pg-enum-drift-exempt: Railway DeploymentStatus, not a Postgres enum.
      { id: "dep-2", status: "FAILED", createdAt: "2026-08-19T07:00:00.000Z", updatedAt: "2026-08-19T07:02:00.000Z" },
    ]);
  });

  it('throws on a GraphQL errors array — the network seam (fetchServiceDeployments) turns this into {ok:false}, never a crash', () => {
    const json = { data: null, errors: [{ message: 'Field "deployments" argument "input" of type "DeploymentListInput!" is required' }] } as never;
    expect(() => parseServiceDeploymentsResponse(json)).toThrow(/DeploymentListInput/);
  });

  it("throws when deployments is missing entirely (e.g. a wrong field/shape guess — see file header UNVERIFIED-LIVE caveat)", () => {
    expect(() => parseServiceDeploymentsResponse({ data: {} } as never)).toThrow(/no data/);
  });

  it("an empty edges array is valid (zero deployments in the page), not a throw", () => {
    const json = { data: { deployments: { edges: [] } } };
    expect(parseServiceDeploymentsResponse(json)).toEqual([]);
  });
});

describe("latestSuccessfulDeployment", () => {
  // pg-enum-drift-exempt: Railway DeploymentStatus, not a Postgres enum (the default below).
  function dep(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
    return { id: "dep-x", status: "SUCCESS", createdAt: "2026-08-19T08:00:00Z", updatedAt: "2026-08-19T08:00:00Z", ...overrides };
  }

  it("returns null with zero deployments", () => {
    expect(latestSuccessfulDeployment([])).toBeNull();
  });

  it("returns null when none are SUCCESS (all FAILED/CRASHED/in-flight)", () => {
    // pg-enum-drift-exempt: Railway DeploymentStatus, not a Postgres enum (the line below).
    const deployments = [dep({ id: "d1", status: "FAILED" }), dep({ id: "d2", status: "BUILDING" }), dep({ id: "d3", status: "CRASHED" })];
    expect(latestSuccessfulDeployment(deployments)).toBeNull();
  });

  it("picks the SUCCESS entry with the latest updatedAt, ignoring a newer non-SUCCESS entry", () => {
    // pg-enum-drift-exempt: Railway DeploymentStatus, not a Postgres enum (the lines below).
    const deployments = [
      dep({ id: "old-success", status: "SUCCESS", updatedAt: "2026-08-19T06:00:00Z" }),
      dep({ id: "newer-failed", status: "FAILED", updatedAt: "2026-08-19T09:00:00Z" }),
      dep({ id: "latest-success", status: "SUCCESS", updatedAt: "2026-08-19T08:00:00Z" }),
    ];
    expect(latestSuccessfulDeployment(deployments)?.id).toBe("latest-success");
  });

  it("uses updatedAt, not createdAt, to rank (a deploy triggered later but finishing earlier loses)", () => {
    // pg-enum-drift-exempt: Railway DeploymentStatus, not a Postgres enum (the lines below).
    const deployments = [
      dep({ id: "triggered-late-finished-early", status: "SUCCESS", createdAt: "2026-08-19T09:00:00Z", updatedAt: "2026-08-19T09:01:00Z" }),
      dep({ id: "triggered-early-finished-late", status: "SUCCESS", createdAt: "2026-08-19T07:00:00Z", updatedAt: "2026-08-19T09:30:00Z" }),
    ];
    expect(latestSuccessfulDeployment(deployments)?.id).toBe("triggered-early-finished-late");
  });

  it("single SUCCESS entry returns itself", () => {
    const only = dep({ id: "solo" });
    expect(latestSuccessfulDeployment([only])?.id).toBe("solo");
  });
});
