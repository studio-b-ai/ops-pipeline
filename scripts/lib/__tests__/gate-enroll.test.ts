import { describe, expect, it, vi } from "vitest";
import {
  buildEnrollment,
  doorEnvFrom,
  enrollGateRefusal,
  enrollmentKeyFor,
  enrollmentKeyPrefixFor,
  isDecisionLeg,
  resolveGateRefusals,
  shortRepo,
  type GateRefusal,
} from "../gate-enroll.js";

const REFUSAL: GateRefusal = {
  repo: "studio-b-ai/webhook-router",
  pr: 811,
  headSha: "fb604456955ff05fcd1bc5f1fe38b457e2bfa663",
  leg: "line-cap",
  reasons: ["code-fix: totalChangedLines 186 > 150", "docs-comment: code-class file(s): src/x.ts"],
  additions: 171,
  deletions: 15,
};

const ENV = { WEBHOOK_ROUTER_URL: "https://wr.example/", SEAT_INBOX_TOKEN: "tok-123" };

type Init = { method: string; headers: Record<string, string>; body: string };

function fetchSpy(httpStatus: number, body: unknown) {
  return vi.fn(async (_url: string, _init: Init) => ({ httpStatus, text: async () => JSON.stringify(body) }));
}

describe("isDecisionLeg — the ruling's list, both verdicts (#471)", () => {
  it.each(["class-match", "line-cap", "named-checks", "review"] as const)("%s → decision", (leg) => {
    expect(isDecisionLeg(leg)).toBe(true);
  });
  it.each(["ci-rollup", "truncation", "eligibility", "other"] as const)("%s → wait/machinery, never asks Kevin", (leg) => {
    expect(isDecisionLeg(leg)).toBe(false);
  });
});

describe("buildEnrollment — the exact body the door receives", () => {
  it("pins key, group, member label, detail shape and originator", () => {
    expect(buildEnrollment(REFUSAL)).toEqual({
      enrollment_key: "gate-refusal:studio-b-ai/webhook-router#811@fb604456955f",
      group_key: "merge-escalations",
      group_label: "merge escalations",
      member_label: "wr#811",
      detail:
        "https://github.com/studio-b-ai/webhook-router/pull/811 · line-cap: code-fix: totalChangedLines 186 > 150 · +171/−15 · reply `queued` to merge; `hold` to park",
      originator: "pr-automerge-gate",
    });
  });

  it("key is sha-pinned: a new head is a new ask; the same head is the same key (#333)", () => {
    expect(enrollmentKeyFor("o/r", 1, "aaaaaaaaaaaaaaaa")).toBe("gate-refusal:o/r#1@aaaaaaaaaaaa");
    expect(enrollmentKeyFor("o/r", 1, "bbbbbbbbbbbbbbbb")).not.toBe(enrollmentKeyFor("o/r", 1, "aaaaaaaaaaaaaaaa"));
    expect(enrollmentKeyFor("o/r", 1, "aaaaaaaaaaaaaaaa")).toBe(enrollmentKeyFor("o/r", 1, "aaaaaaaaaaaaaaaa"));
    expect(enrollmentKeyPrefixFor("o/r", 1)).toBe("gate-refusal:o/r#1@");
    expect(enrollmentKeyFor("o/r", 1, "aaaaaaaaaaaaaaaa").startsWith(enrollmentKeyPrefixFor("o/r", 1))).toBe(true);
  });

  it("truncates a runaway reason and collapses whitespace so the block line stays readable", () => {
    const long = { ...REFUSAL, reasons: ["x".repeat(400) + "\n\n  y"] };
    const d = buildEnrollment(long).detail;
    expect(d.length).toBeLessThan(400);
    expect(d).toContain("…");
    expect(d).not.toMatch(/\n/);
  });

  it("shortRepo maps the fleet and falls back to the bare name", () => {
    expect(shortRepo("studio-b-ai/client-asthetik")).toBe("ca");
    expect(shortRepo("studio-b-ai/some-new-repo")).toBe("some-new-repo");
  });
});

describe("doorEnvFrom — absent config is null, never a throw", () => {
  it("null when either half is missing", () => {
    expect(doorEnvFrom({})).toBeNull();
    expect(doorEnvFrom({ WEBHOOK_ROUTER_URL: "https://x" })).toBeNull();
    expect(doorEnvFrom({ SEAT_INBOX_TOKEN: "t" })).toBeNull();
  });
  it("trims and strips a trailing slash", () => {
    expect(doorEnvFrom(ENV)).toEqual({ url: "https://wr.example", token: "tok-123" });
  });
});

describe("enrollGateRefusal — the actual wire (#223) and every outcome", () => {
  it("POSTs the built body to /internal/cos/decisions with the bearer; created:true → enrolled", async () => {
    const f = fetchSpy(200, { ok: true, created: true, enrollment_key: "k" });
    const lines: string[] = [];
    const out = await enrollGateRefusal(REFUSAL, { env: ENV, fetchImpl: f, log: (l) => lines.push(l) });
    expect(out).toEqual({ outcome: "enrolled", created: true, key: "gate-refusal:studio-b-ai/webhook-router#811@fb604456955f" });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, Init];
    expect(url).toBe("https://wr.example/internal/cos/decisions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer tok-123", "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual(buildEnrollment(REFUSAL));
    expect(lines.join("\n")).toMatch(/\[enroll\] .*created=true/);
  });

  it("a repeat on the same head → the door says created:false → enrolled, not re-asked", async () => {
    const f = fetchSpy(200, { ok: true, created: false, enrollment_key: "k" });
    const out = await enrollGateRefusal(REFUSAL, { env: ENV, fetchImpl: f, log: () => {} });
    expect(out).toMatchObject({ outcome: "enrolled", created: false });
  });

  it("a wait leg never touches the door", async () => {
    const f = fetchSpy(200, {});
    const out = await enrollGateRefusal({ ...REFUSAL, leg: "ci-rollup" }, { env: ENV, fetchImpl: f, log: () => {} });
    expect(out).toMatchObject({ outcome: "skipped" });
    expect(f).not.toHaveBeenCalled();
  });

  it("no door configured → skipped LOUDLY, no fetch, no throw (#464 — a gap must be visible)", async () => {
    const f = fetchSpy(200, {});
    const lines: string[] = [];
    const out = await enrollGateRefusal(REFUSAL, { env: {}, fetchImpl: f, log: (l) => lines.push(l) });
    expect(out).toEqual({ outcome: "skipped", reason: "door not configured" });
    expect(f).not.toHaveBeenCalled();
    expect(lines[0]).toMatch(/^\[enroll-skipped\] .*NOT delivered/);
  });

  it("door 503 → failed LOUDLY, no throw — the gate keeps running", async () => {
    const f = fetchSpy(503, { ok: false, error: "seat-inbox token not configured — failing closed" });
    const lines: string[] = [];
    const out = await enrollGateRefusal(REFUSAL, { env: ENV, fetchImpl: f, log: (l) => lines.push(l) });
    expect(out).toMatchObject({ outcome: "failed", reason: "HTTP 503" });
    expect(lines[0]).toMatch(/^\[enroll-failed\] .*HTTP 503.*NOT delivered/);
  });

  it("network throw → failed LOUDLY, no throw", async () => {
    const f = vi.fn(async (_url: string, _init: Init) => {
      throw new Error("ECONNREFUSED");
    });
    const out = await enrollGateRefusal(REFUSAL, { env: ENV, fetchImpl: f, log: () => {} });
    expect(out).toMatchObject({ outcome: "failed", reason: "ECONNREFUSED" });
  });
});

describe("resolveGateRefusals — on merge, every head's line for the PR goes", () => {
  it("POSTs the PR's key prefix + resolution to /internal/cos/decisions/resolve", async () => {
    const f = fetchSpy(200, { ok: true, resolved: 2 });
    const out = await resolveGateRefusals("studio-b-ai/webhook-router", 811, { env: ENV, fetchImpl: f, log: () => {} });
    expect(out).toEqual({ outcome: "resolved", count: 2 });
    const [url, init] = f.mock.calls[0] as [string, Init];
    expect(url).toBe("https://wr.example/internal/cos/decisions/resolve");
    expect(JSON.parse(init.body)).toEqual({ key_prefix: "gate-refusal:studio-b-ai/webhook-router#811@", resolution: "merged" });
    expect(init.headers.Authorization).toBe("Bearer tok-123");
  });

  it("no door → skipped loudly; door error → failed loudly; never throws", async () => {
    const lines: string[] = [];
    expect(await resolveGateRefusals("o/r", 1, { env: {}, fetchImpl: fetchSpy(200, {}), log: (l) => lines.push(l) })).toMatchObject({ outcome: "skipped" });
    expect(await resolveGateRefusals("o/r", 1, { env: ENV, fetchImpl: fetchSpy(500, {}), log: (l) => lines.push(l) })).toMatchObject({ outcome: "failed" });
    expect(lines.filter((l) => l.startsWith("[enroll-resolve-")).length).toBe(2);
  });
});
