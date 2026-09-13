import { describe, expect, it } from "vitest";
import {
  DOOR_WATCH_EXEMPT,
  findDoorWatchIncoherence,
  summarizeDoorWatchCoherence,
  type DoorRegistryRow,
} from "../door-watch-coherence.js";

// ───────────────────────────── fixtures ─────────────────────────────
//
// The LIVE registry shapes as measured from the deployed ref at authoring time
// (2026-09-13, `git show origin/main:scripts/squasher-fleet.json` and
// `...:scripts/backlog-managers.yaml` per Rule #466). Kept verbatim so the
// regression test below asserts the REAL defect this guard was born from, not a
// hand-simplified echo of the implementation (Rule #223's spirit: assert against
// the real population, not against your own setup).

/** Every door row on origin/main at authoring time, with its real `train` value. */
const LIVE_DOOR_ROWS: DoorRegistryRow[] = [
  { repo: "studio-b-ai/bolt-wms", train: true },
  { repo: "studio-b-ai/studiob", train: false },
  { repo: "studio-b-ai/studiob-price-sync", train: true },
  { repo: "studio-b-ai/asthetik-trade-theme", train: true },
  { repo: "studio-b-ai/asthetik-portal", train: true },
  { repo: "studio-b-ai/webhook-router", train: true },
  { repo: "studio-b-ai/ops-pipeline", train: false },
  { repo: "studio-b-ai/acuops-pipeline", train: false },
  { repo: "studio-b-ai/acudev", train: false },
  { repo: "studio-b-ai/note-intelligence", train: false },
  { repo: "studio-b-ai/brain", train: true },
  { repo: "studio-b-ai/claude-config-plane", train: true },
  { repo: "studio-b-ai/roundhouse", train: false },
  { repo: "studio-b-ai/claude-hooks", train: false },
  { repo: "studio-b-ai/radio", train: true },
  { repo: "studio-b-ai/lightsout", train: true },
  { repo: "studio-b-ai/client-asthetik", train: true },
  { repo: "studio-b-ai/toto", train: true },
];

/** backlog-managers.yaml's `repos:` list BEFORE this PR widened it — the drifted state. */
const WATCHED_BEFORE: string[] = [
  "studio-b-ai/ops-pipeline",
  "studio-b-ai/webhook-router",
  "studio-b-ai/client-asthetik",
  "studio-b-ai/acuops-pipeline",
  "studio-b-ai/acudev",
  "studio-b-ai/clients",
  "studio-b-ai/bolt-wms",
  "studio-b-ai/studiob",
  "studio-b-ai/brain",
  "studio-b-ai/studiob-price-sync",
  "studio-b-ai/asthetik-trade-theme",
  "studio-b-ai/asthetik-portal",
  "studio-b-ai/asthetik-marketing",
];

/** The same list AFTER this PR's four added rows — the intended fixed state. */
const WATCHED_AFTER: string[] = [
  ...WATCHED_BEFORE,
  "studio-b-ai/claude-config-plane",
  "studio-b-ai/radio",
  "studio-b-ai/lightsout",
  "studio-b-ai/toto",
];

const LANE_MANAGERS: Readonly<Record<string, string>> = {
  "studio-b-ai/ops-pipeline": "mechanic",
  "studio-b-ai/claude-config-plane": "mechanic",
  "studio-b-ai/radio": "mechanic",
  "studio-b-ai/lightsout": "mechanic",
  "studio-b-ai/toto": "mechanic",
};

describe("findDoorWatchIncoherence — the live defect (Rule #322 known-bad)", () => {
  it("fires on the REAL pre-fix registries, naming exactly the 4 drifted repos", () => {
    const findings = findDoorWatchIncoherence({
      doorRows: LIVE_DOOR_ROWS,
      watchedRepos: WATCHED_BEFORE,
      laneManagers: LANE_MANAGERS,
    });

    expect(findings.map((f) => f.repo)).toEqual([
      "studio-b-ai/claude-config-plane",
      "studio-b-ai/lightsout",
      "studio-b-ai/radio",
      "studio-b-ai/toto",
    ]);
    expect(findings.every((f) => f.class === "door_watch_incoherent")).toBe(true);
  });

  it("clears on the REAL post-fix registries — the known-GOOD this PR creates (Rule #471)", () => {
    const findings = findDoorWatchIncoherence({
      doorRows: LIVE_DOOR_ROWS,
      watchedRepos: WATCHED_AFTER,
      laneManagers: LANE_MANAGERS,
    });
    expect(findings).toEqual([]);
  });
});

describe("direction discipline (Rule #425 — never fire on clean input)", () => {
  it("does NOT flag a watched repo that has no door row at all", () => {
    // asthetik-marketing + clients are live examples: watched, absent from the door registry.
    const findings = findDoorWatchIncoherence({
      doorRows: [{ repo: "studio-b-ai/bolt-wms", train: true }],
      watchedRepos: ["studio-b-ai/bolt-wms", "studio-b-ai/asthetik-marketing", "studio-b-ai/clients"],
    });
    expect(findings).toEqual([]);
  });

  it("does NOT flag a train:false door row, watched or not", () => {
    const findings = findDoorWatchIncoherence({
      doorRows: [
        { repo: "studio-b-ai/roundhouse", train: false },
        { repo: "studio-b-ai/note-intelligence", train: false },
      ],
      watchedRepos: [],
    });
    expect(findings).toEqual([]);
  });

  it("treats an ABSENT train field as false (registry fallback semantics), not as a door", () => {
    const findings = findDoorWatchIncoherence({
      doorRows: [{ repo: "studio-b-ai/some-repo" }],
      watchedRepos: [],
    });
    expect(findings).toEqual([]);
  });

  it("flags a train:true repo with an EMPTY watch list", () => {
    const findings = findDoorWatchIncoherence({
      doorRows: [{ repo: "studio-b-ai/radio", train: true }],
      watchedRepos: [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].repo).toBe("studio-b-ai/radio");
  });
});

describe("matching + ordering discipline", () => {
  it("compares repo names EXACTLY — a sibling prefix never counts as coverage (Rule #282)", () => {
    // "studio-b-ai/radio" must NOT be considered covered by "studio-b-ai/radio-legacy".
    const findings = findDoorWatchIncoherence({
      doorRows: [{ repo: "studio-b-ai/radio", train: true }],
      watchedRepos: ["studio-b-ai/radio-legacy"],
    });
    expect(findings.map((f) => f.repo)).toEqual(["studio-b-ai/radio"]);
  });

  it("orders findings by repo name ascending so a re-run does not churn the issue body", () => {
    const findings = findDoorWatchIncoherence({
      doorRows: [
        { repo: "studio-b-ai/zzz", train: true },
        { repo: "studio-b-ai/aaa", train: true },
        { repo: "studio-b-ai/mmm", train: true },
      ],
      watchedRepos: [],
    });
    expect(findings.map((f) => f.repo)).toEqual(["studio-b-ai/aaa", "studio-b-ai/mmm", "studio-b-ai/zzz"]);
  });

  it("collapses duplicate door rows for one repo into a single finding", () => {
    const findings = findDoorWatchIncoherence({
      doorRows: [
        { repo: "studio-b-ai/radio", train: true },
        { repo: "studio-b-ai/radio", train: true },
      ],
      watchedRepos: [],
    });
    expect(findings).toHaveLength(1);
  });

  it("treats a repo as behind the door if ANY of its rows says train:true", () => {
    const findings = findDoorWatchIncoherence({
      doorRows: [
        { repo: "studio-b-ai/radio", train: false },
        { repo: "studio-b-ai/radio", train: true },
      ],
      watchedRepos: [],
    });
    expect(findings.map((f) => f.repo)).toEqual(["studio-b-ai/radio"]);
  });
});

describe("owner naming (Rule #294 — never invent a manager)", () => {
  it("carries the mapped seat as suggestedManager when one resolves", () => {
    const [finding] = findDoorWatchIncoherence({
      doorRows: [{ repo: "studio-b-ai/radio", train: true }],
      watchedRepos: [],
      laneManagers: { "studio-b-ai/radio": "mechanic" },
    });
    expect(finding.suggestedManager).toBe("mechanic");
    expect(finding.detail).toContain("`mechanic`");
  });

  it("reports null and says so explicitly when no mapping resolves — no guessed owner", () => {
    const [finding] = findDoorWatchIncoherence({
      doorRows: [{ repo: "studio-b-ai/unmapped", train: true }],
      watchedRepos: [],
      laneManagers: {},
    });
    expect(finding.suggestedManager).toBeNull();
    expect(finding.detail).toContain("do NOT guess one");
  });

  it("omitting laneManagers entirely is safe (optional input)", () => {
    const [finding] = findDoorWatchIncoherence({
      doorRows: [{ repo: "studio-b-ai/radio", train: true }],
      watchedRepos: [],
    });
    expect(finding.suggestedManager).toBeNull();
  });
});

describe("exemption allowlist", () => {
  it("is EMPTY today — the four drifted repos were fixed, not exempted", () => {
    expect(Object.keys(DOOR_WATCH_EXEMPT)).toEqual([]);
  });
});

describe("finding text names both registries and the resolution", () => {
  it("cites squasher-fleet.json, backlog-managers.yaml, and the exact row to add", () => {
    const [finding] = findDoorWatchIncoherence({
      doorRows: [{ repo: "studio-b-ai/radio", train: true }],
      watchedRepos: [],
      laneManagers: LANE_MANAGERS,
    });
    expect(finding.detail).toContain("scripts/squasher-fleet.json");
    expect(finding.detail).toContain("scripts/backlog-managers.yaml");
    expect(finding.detail).toContain('- repo: "studio-b-ai/radio"');
    expect(finding.detail).toContain("train: true");
  });
});

describe("summarizeDoorWatchCoherence", () => {
  it("says OK on zero findings", () => {
    expect(summarizeDoorWatchCoherence([])).toContain("OK");
  });

  it("names every drifted repo on findings", () => {
    const findings = findDoorWatchIncoherence({
      doorRows: LIVE_DOOR_ROWS,
      watchedRepos: WATCHED_BEFORE,
      laneManagers: LANE_MANAGERS,
    });
    const summary = summarizeDoorWatchCoherence(findings);
    expect(summary).toContain("4 repo(s)");
    expect(summary).toContain("studio-b-ai/radio");
    expect(summary).toContain("studio-b-ai/toto");
  });
});
