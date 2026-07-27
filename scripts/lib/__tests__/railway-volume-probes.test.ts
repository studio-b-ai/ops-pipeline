import { describe, it, expect } from "vitest";
import { parseProjectsRootResponse, parseProjectVolumesResponse } from "../railway-volume-probes.js";

describe("parseProjectsRootResponse", () => {
  it("returns the project list on success", () => {
    const json = {
      data: {
        projects: {
          edges: [
            { node: { id: "p1", name: "aesthetik-production" } },
            { node: { id: "p2", name: "studiob-platform" } },
          ],
        },
      },
    };
    expect(parseProjectsRootResponse(json)).toEqual([
      { id: "p1", name: "aesthetik-production" },
      { id: "p2", name: "studiob-platform" },
    ]);
  });

  it("returns null when the field errors — the real live shape: HTTP 200, data:null, errors:['Not Authorized']", () => {
    const json = { data: null, errors: [{ message: "Not Authorized" }] };
    expect(parseProjectsRootResponse(json)).toBeNull();
  });

  it("returns null when projects is missing entirely", () => {
    expect(parseProjectsRootResponse({ data: {} } as never)).toBeNull();
  });
});

describe("parseProjectVolumesResponse", () => {
  // Shape mirrors the REAL live-captured response (2026-07-27 probe against the actual Railway
  // API) — Project -> environments -> volumeInstances, with `serviceId` (scalar) instead of a
  // nested `service {}` object (that nested selection 500s for at least one real project — see
  // the file header in railway-volume-probes.ts). `project.services` is the separate join source.
  function fixture(overrides: Partial<{ services: unknown[]; volumeInstances: unknown[] }> = {}) {
    return {
      data: {
        project: {
          id: "proj-1",
          name: "aesthetik-production",
          services: {
            pageInfo: { hasNextPage: false },
            edges: overrides.services ?? [
              { node: { id: "svc-pg", name: "Postgres" } },
              { node: { id: "svc-redis", name: "Redis" } },
            ],
          },
          environments: {
            pageInfo: { hasNextPage: false },
            edges: [
              {
                node: {
                  id: "env-prod",
                  name: "production",
                  volumeInstances: {
                    pageInfo: { hasNextPage: false },
                    edges:
                      overrides.volumeInstances ?? [
                        {
                          node: {
                            id: "vi-pg",
                            sizeMB: 500,
                            currentSizeMB: 480,
                            state: "READY",
                            serviceId: "svc-pg",
                            volume: { id: "vol-pg", name: "postgres-volume" },
                          },
                        },
                      ],
                  },
                },
              },
            ],
          },
        },
      },
    };
  }

  it("resolves serviceName by joining serviceId against project.services", () => {
    const { volumes } = parseProjectVolumesResponse(fixture() as never);
    expect(volumes).toHaveLength(1);
    expect(volumes[0]).toMatchObject({
      volumeInstanceId: "vi-pg",
      projectName: "aesthetik-production",
      environmentName: "production",
      serviceId: "svc-pg",
      serviceName: "Postgres",
      volumeName: "postgres-volume",
      sizeMB: 500,
      currentSizeMB: 480,
      state: "READY",
    });
  });

  it("leaves serviceName null for a detached volume (serviceId: null — the real shape for 2 real orphaned volumes found live)", () => {
    const f = fixture({
      volumeInstances: [
        {
          node: {
            id: "vi-orphan",
            sizeMB: 500,
            currentSizeMB: 97,
            state: "READY",
            serviceId: null,
            volume: { id: "vol-orphan", name: "postgres-volume" },
          },
        },
      ],
    });
    const { volumes } = parseProjectVolumesResponse(f as never);
    expect(volumes[0].serviceId).toBeNull();
    expect(volumes[0].serviceName).toBeNull();
  });

  it("leaves serviceName null when serviceId doesn't match any entry in project.services (defensive — shouldn't happen, but never throw)", () => {
    const f = fixture({
      volumeInstances: [
        {
          node: {
            id: "vi-x",
            sizeMB: 1000,
            currentSizeMB: 10,
            state: "READY",
            serviceId: "svc-unknown",
            volume: { id: "vol-x", name: "mystery-volume" },
          },
        },
      ],
    });
    const { volumes } = parseProjectVolumesResponse(f as never);
    expect(volumes[0].serviceName).toBeNull();
  });

  it("filters out volume instances with sizeMB <= 0 (spec: only sizeMB > 0)", () => {
    const f = fixture({
      volumeInstances: [
        { node: { id: "vi-zero", sizeMB: 0, currentSizeMB: 0, state: "READY", serviceId: null, volume: { id: "v0", name: "zero" } } },
        { node: { id: "vi-real", sizeMB: 5000, currentSizeMB: 100, state: "READY", serviceId: null, volume: { id: "v1", name: "real" } } },
      ],
    });
    const { volumes } = parseProjectVolumesResponse(f as never);
    expect(volumes.map((v) => v.volumeInstanceId)).toEqual(["vi-real"]);
  });

  it.each(["DELETED", "DELETING"])("skips volume instances in state %s", (state) => {
    const f = fixture({
      volumeInstances: [{ node: { id: "vi-gone", sizeMB: 500, currentSizeMB: 100, state, serviceId: null, volume: { id: "vg", name: "gone" } } }],
    });
    const { volumes } = parseProjectVolumesResponse(f as never);
    expect(volumes).toHaveLength(0);
  });

  it.each(["READY", "UPDATING", "RESTORING", "MIGRATING", "MIGRATION_PENDING", "ERROR"])(
    "keeps volume instances in state %s (still has real usage worth checking)",
    (state) => {
      const f = fixture({
        volumeInstances: [{ node: { id: "vi-live", sizeMB: 500, currentSizeMB: 100, state, serviceId: null, volume: { id: "vl", name: "live" } } }],
      });
      const { volumes } = parseProjectVolumesResponse(f as never);
      expect(volumes).toHaveLength(1);
    },
  );

  it("throws on a GraphQL error (caller turns this into a per-project PROBE_FAILED-style skip, never a silent empty result)", () => {
    expect(() => parseProjectVolumesResponse({ data: null, errors: [{ message: "Problem processing request" }] } as never)).toThrow(
      /Problem processing request/,
    );
  });

  it("throws when project is null (e.g. a bad/inaccessible project id) rather than returning an empty list silently", () => {
    expect(() => parseProjectVolumesResponse({ data: { project: null } } as never)).toThrow(/no data/);
  });

  it("flags truncated:true when any nested connection reports hasNextPage (Rule #331 — never silently truncate)", () => {
    const f = fixture();
    (f.data.project.environments as { pageInfo: { hasNextPage: boolean } }).pageInfo.hasNextPage = true;
    const { truncated } = parseProjectVolumesResponse(f as never);
    expect(truncated).toBe(true);
  });

  it("truncated:false in the normal case", () => {
    const { truncated } = parseProjectVolumesResponse(fixture() as never);
    expect(truncated).toBe(false);
  });
});
