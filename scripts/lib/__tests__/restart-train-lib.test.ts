import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeAnchor,
  computePlanSlots,
  findDanglingPlan,
  isBatchBlackoutUtc,
  isBusinessHoursBlockedET,
  orderQueue,
  parseEndComments,
  parseTrainLedger,
  planLines,
  repoClassFor,
  windowState,
  zonedWallClockToUtcMs,
  type AnchorResult,
  type QueueEntry,
  type RestartTrainComment,
  type Ticket,
} from "../restart-train-lib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ───────────────────────────── fixtures ─────────────────────────────
// Recorded read-only from client-asthetik#280 the night of 2026-08-19 (Rule #223: never
// hand-typed) — grepped for token-like patterns before commit (clean; public-repo-style text).
const REAL_280_COMMENTS: RestartTrainComment[] = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "restart-train", "issue-280-comments.json"), "utf-8"),
);

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    repo: "studio-b-ai/studiob",
    number: 1,
    repoClass: "studiob",
    appliedAt: "2026-08-19T20:00:00Z",
    pinnedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    currentHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    afterTokens: [],
    consolidate: false,
    ...overrides,
  };
}

// ───────────────────────────── repoClassFor ─────────────────────────────

describe("repoClassFor", () => {
  it("classifies client-asthetik", () => {
    expect(repoClassFor("studio-b-ai/client-asthetik")).toBe("client-asthetik");
  });
  it("classifies studiob", () => {
    expect(repoClassFor("studio-b-ai/studiob")).toBe("studiob");
  });
  it("classifies anything else as other (fail-closed, not a crash)", () => {
    expect(repoClassFor("studio-b-ai/bolt-wms")).toBe("other");
    expect(repoClassFor("")).toBe("other");
  });
});

// ───────────────────────────── isBusinessHoursBlockedET ─────────────────────────────
// Mirrors acuops-deploy.yml L1049-1087: TZ=America/New_York, blocked ⟺ DOW<6 (Mon-Fri) AND
// HOUR in [6,18). Both DST sides + Mon/Fri boundaries per the brief.

describe("isBusinessHoursBlockedET", () => {
  // Negative controls first (Rule #322): instants that must NOT be blocked.
  it("does not block Saturday regardless of hour (EST)", () => {
    expect(isBusinessHoursBlockedET("2026-01-17T15:00:00Z")).toBe(false); // Sat, 10:00 EST
  });
  it("does not block Sunday regardless of hour (EST)", () => {
    expect(isBusinessHoursBlockedET("2026-01-18T15:00:00Z")).toBe(false); // Sun, 10:00 EST
  });
  it("does not block just before 06:00 ET on a weekday (EST)", () => {
    expect(isBusinessHoursBlockedET("2026-01-12T10:59:59Z")).toBe(false); // Mon, 05:59:59 EST
  });
  it("does not block at exactly 18:00 ET on a weekday (EST, upper bound exclusive)", () => {
    expect(isBusinessHoursBlockedET("2026-01-12T23:00:00Z")).toBe(false); // Mon, 18:00:00 EST
  });

  it("blocks at exactly 06:00 ET on a weekday (EST winter, UTC-5)", () => {
    expect(isBusinessHoursBlockedET("2026-01-12T11:00:00Z")).toBe(true); // Mon Jan 12, 06:00 EST
  });
  it("blocks at 17:59:59 ET on a weekday (EST winter)", () => {
    expect(isBusinessHoursBlockedET("2026-01-12T22:59:59Z")).toBe(true);
  });
  it("blocks at exactly 06:00 ET on a weekday (EDT summer, UTC-4)", () => {
    expect(isBusinessHoursBlockedET("2026-08-19T10:00:00Z")).toBe(true); // Wed Aug 19, 06:00 EDT
  });
  it("blocks at 17:59:59 ET on a weekday (EDT summer)", () => {
    expect(isBusinessHoursBlockedET("2026-08-19T21:59:59Z")).toBe(true);
  });
  it("does not block at exactly 18:00 ET (EDT summer, upper bound exclusive)", () => {
    expect(isBusinessHoursBlockedET("2026-08-19T22:00:00Z")).toBe(false);
  });
  it("does not block just before 06:00 ET (EDT summer)", () => {
    expect(isBusinessHoursBlockedET("2026-08-19T09:59:59Z")).toBe(false);
  });

  it("Friday at 10:00 ET is blocked (Mon-Fri boundary: Friday still counts)", () => {
    expect(isBusinessHoursBlockedET("2026-01-16T15:00:00Z")).toBe(true); // Fri Jan 16, 10:00 EST
  });
  it("Friday at 18:00 ET clears into the weekend", () => {
    expect(isBusinessHoursBlockedET("2026-01-16T23:00:00Z")).toBe(false); // Fri Jan 16, 18:00 EST
  });
  it("Monday at 05:00 ET (before the gate) is not blocked", () => {
    expect(isBusinessHoursBlockedET("2026-01-19T10:00:00Z")).toBe(false); // Mon Jan 19, 05:00 EST
  });
});

// ───────────────────────────── isBatchBlackoutUtc ─────────────────────────────

describe("isBatchBlackoutUtc", () => {
  it("does not block just before 05:45Z", () => {
    expect(isBatchBlackoutUtc("2026-08-19T05:44:59Z")).toBe(false);
  });
  it("blocks at exactly 05:45:00Z", () => {
    expect(isBatchBlackoutUtc("2026-08-19T05:45:00Z")).toBe(true);
  });
  it("blocks at 08:14:59Z", () => {
    expect(isBatchBlackoutUtc("2026-08-19T08:14:59Z")).toBe(true);
  });
  it("does not block at exactly 08:15:00Z (upper bound exclusive)", () => {
    expect(isBatchBlackoutUtc("2026-08-19T08:15:00Z")).toBe(false);
  });
  it("applies on any day (not weekday-gated, unlike the ET gate)", () => {
    expect(isBatchBlackoutUtc("2026-08-22T06:00:00Z")).toBe(true); // Saturday
  });
});

// ───────────────────────────── zonedWallClockToUtcMs ─────────────────────────────

describe("zonedWallClockToUtcMs", () => {
  it("resolves 06:00 ET winter (EST, UTC-5) to 11:00Z", () => {
    expect(zonedWallClockToUtcMs(2026, 1, 12, 6, 0, 0, "America/New_York")).toBe(Date.parse("2026-01-12T11:00:00Z"));
  });
  it("resolves 06:00 ET summer (EDT, UTC-4) to 10:00Z", () => {
    expect(zonedWallClockToUtcMs(2026, 8, 19, 6, 0, 0, "America/New_York")).toBe(Date.parse("2026-08-19T10:00:00Z"));
  });
});

// ───────────────────────────── windowState ─────────────────────────────

describe("windowState", () => {
  it("is clear when spacing/blackout/ET gate all pass", () => {
    const r = windowState("2026-08-19T23:00:00Z", "client-asthetik", "2026-08-19T20:00:00Z");
    expect(r).toEqual({ clear: true });
  });

  it("blocks on spacing alone and resolves to anchor+30min when that instant is itself clear", () => {
    const r = windowState("2026-08-19T21:55:00Z", "client-asthetik", "2026-08-19T21:50:00Z");
    expect(r.clear).toBe(false);
    if (!r.clear) {
      expect(r.nextClearIso).toBe("2026-08-19T22:20:00Z");
      expect(r.reason).toMatch(/spacing/);
    }
  });

  it("client-asthetik: spacing resolves INTO the ET gate, chains to that gate's 18:00 ET exit", () => {
    // anchor+30min lands at 10:20Z = 06:20 EDT — inside the ET-blocked window, so the walk must
    // hop again to 18:00 EDT (22:00Z) the same day.
    const r = windowState("2026-08-19T09:55:00Z", "client-asthetik", "2026-08-19T09:50:00Z");
    expect(r.clear).toBe(false);
    if (!r.clear) expect(r.nextClearIso).toBe("2026-08-19T22:00:00Z");
  });

  it("studiob: the SAME anchor/now is NOT subject to the ET gate — clears at anchor+30min", () => {
    const r = windowState("2026-08-19T09:55:00Z", "studiob", "2026-08-19T09:50:00Z");
    expect(r.clear).toBe(false);
    if (!r.clear) {
      expect(r.nextClearIso).toBe("2026-08-19T10:20:00Z");
      expect(r.reason).toMatch(/spacing/);
    }
  });

  it("spacing resolves INTO the batch blackout, chains to 08:15Z exit (repo-class independent)", () => {
    // anchor+30min lands at 05:50Z, inside [05:45,08:15)Z.
    const r = windowState("2026-08-19T05:25:00Z", "studiob", "2026-08-19T05:20:00Z");
    expect(r.clear).toBe(false);
    if (!r.clear) expect(r.nextClearIso).toBe("2026-08-19T08:15:00Z");
  });

  it("batch blackout binds for client-asthetik too, and its exit does not re-enter the ET gate", () => {
    const r = windowState("2026-08-19T07:00:00Z", "client-asthetik", "2026-08-19T01:00:00Z");
    expect(r.clear).toBe(false);
    if (!r.clear) expect(r.nextClearIso).toBe("2026-08-19T08:15:00Z"); // 08:15Z = 04:15 EDT, before the 06:00 ET gate
  });

  it("throws on an unparsable now", () => {
    expect(() => windowState("not-a-date", "studiob", "2026-08-19T20:00:00Z")).toThrow();
  });
  it("throws on an unparsable anchor", () => {
    expect(() => windowState("2026-08-19T20:00:00Z", "studiob", "not-a-date")).toThrow();
  });
});

// ───────────────────────────── computeAnchor ─────────────────────────────

describe("computeAnchor", () => {
  it("picks the latest of three well-separated candidates", () => {
    const r = computeAnchor({
      now: "2026-08-19T12:00:00Z",
      danglingPlan: false,
      candidates: [
        { source: "client-asthetik-actions", completedAtIso: "2026-08-19T09:00:00Z", detail: "a" },
        { source: "studiob-api-railway", completedAtIso: "2026-08-19T11:00:00Z", detail: "b" },
        { source: "manual-end-comment", completedAtIso: "2026-08-19T10:00:00Z", detail: "c" },
      ],
    });
    expect(r).toEqual({ ok: true, anchorIso: "2026-08-19T11:00:00Z", source: "studiob-api-railway", detail: "b" });
  });

  it("fails closed when two candidates are within 30 min of each other", () => {
    const r = computeAnchor({
      now: "2026-08-19T12:00:00Z",
      danglingPlan: false,
      candidates: [
        { source: "client-asthetik-actions", completedAtIso: "2026-08-19T09:00:00Z", detail: "a" },
        { source: "studiob-api-railway", completedAtIso: "2026-08-19T09:20:00Z", detail: "b" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/within 30 min/);
  });

  it("fails closed on an unparsable candidate timestamp", () => {
    const r = computeAnchor({
      now: "2026-08-19T12:00:00Z",
      danglingPlan: false,
      candidates: [{ source: "manual-end-comment", completedAtIso: "not-a-date", detail: "x" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unparsable/);
  });

  it("fails closed on zero candidates", () => {
    const r = computeAnchor({ now: "2026-08-19T12:00:00Z", danglingPlan: false, candidates: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no anchor candidates/);
  });

  it("fails closed on a dangling PLAN regardless of otherwise-clean candidates", () => {
    const r = computeAnchor({
      now: "2026-08-19T12:00:00Z",
      danglingPlan: true,
      danglingPlanDetail: "kbibelhausen's PLAN 2026-08-19T22:30Z · studiob#558",
      candidates: [{ source: "studiob-api-railway", completedAtIso: "2026-08-19T09:00:00Z", detail: "b" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/dangling PLAN/);
      expect(r.reason).toMatch(/studiob#558/);
    }
  });

  it("fails closed on an unparsable now", () => {
    const r = computeAnchor({ now: "not-a-date", danglingPlan: false, candidates: [] });
    expect(r.ok).toBe(false);
  });
});

// ───────────────────────────── orderQueue ─────────────────────────────

describe("orderQueue", () => {
  it("orders by appliedAt FIFO when nothing else applies", () => {
    const a = ticket({ repo: "studio-b-ai/studiob", number: 1, appliedAt: "2026-08-19T20:00:00Z" });
    const b = ticket({ repo: "studio-b-ai/studiob", number: 2, appliedAt: "2026-08-19T19:00:00Z" });
    const entries = orderQueue([a, b]);
    expect(entries.map((e) => e.ticket.number)).toEqual([2, 1]);
    expect(entries.every((e) => e.status === "queued")).toBe(true);
  });

  it("honors train:after even against an earlier appliedAt", () => {
    // B applied first (would be FIFO-first) but names A via train:after — A must come first.
    const a = ticket({ repo: "studio-b-ai/studiob", number: 1, appliedAt: "2026-08-19T20:00:00Z" });
    const b = ticket({
      repo: "studio-b-ai/studiob",
      number: 2,
      appliedAt: "2026-08-19T19:00:00Z",
      afterTokens: ["studio-b-ai/studiob#1"],
    });
    const entries = orderQueue([a, b]);
    const queued = entries.filter((e) => e.status === "queued");
    expect(queued.map((e) => e.ticket.number)).toEqual([1, 2]);
  });

  it("treats an unresolvable train:after reference as a no-op", () => {
    const a = ticket({
      repo: "studio-b-ai/studiob",
      number: 1,
      appliedAt: "2026-08-19T19:00:00Z",
      afterTokens: ["studio-b-ai/studiob#999"], // not in this queue
    });
    const entries = orderQueue([a]);
    expect(entries).toEqual([{ status: "queued", ticket: a, slotGroup: 0 }]);
  });

  it("groups a train:consolidate ticket into the slot of the ticket immediately ahead of it", () => {
    const a = ticket({ repo: "studio-b-ai/studiob", number: 1, appliedAt: "2026-08-19T19:00:00Z" });
    const b = ticket({
      repo: "studio-b-ai/client-asthetik",
      number: 2,
      repoClass: "client-asthetik",
      appliedAt: "2026-08-19T19:05:00Z",
      consolidate: true,
    });
    const entries = orderQueue([a, b]);
    const queued = entries.filter((e): e is Extract<QueueEntry, { status: "queued" }> => e.status === "queued");
    expect(queued[0].slotGroup).toBe(queued[1].slotGroup);
  });

  it("a consolidate ticket with nothing ahead of it gets its own slot (no crash, no false group)", () => {
    const a = ticket({
      repo: "studio-b-ai/client-asthetik",
      number: 2,
      repoClass: "client-asthetik",
      appliedAt: "2026-08-19T19:00:00Z",
      consolidate: true,
    });
    const entries = orderQueue([a]);
    expect(entries).toEqual([{ status: "queued", ticket: a, slotGroup: 0 }]);
  });

  it("invalidates a ticket whose current head drifted from its pinned head, and never schedules it", () => {
    const a = ticket({ repo: "studio-b-ai/studiob", number: 1, appliedAt: "2026-08-19T19:00:00Z" });
    const drifted = ticket({
      repo: "studio-b-ai/studiob",
      number: 2,
      appliedAt: "2026-08-19T18:00:00Z", // would be FIFO-first if valid
      pinnedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      currentHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    const entries = orderQueue([a, drifted]);
    expect(entries.find((e) => e.ticket.number === 1)?.status).toBe("queued");
    const invalid = entries.find((e) => e.ticket.number === 2);
    expect(invalid?.status).toBe("invalidated");
    if (invalid?.status === "invalidated") expect(invalid.reason).toMatch(/head drift/);
  });
});

// ───────────────────────────── computePlanSlots / planLines ─────────────────────────────

describe("computePlanSlots + planLines", () => {
  it("returns the explicit no-anchor line when the anchor is not ok, and computePlanSlots returns empty", () => {
    const notOk: AnchorResult = { ok: false, reason: "no anchor candidates available from any source" };
    const q: QueueEntry[] = [{ status: "queued", ticket: ticket(), slotGroup: 0 }];
    expect(computePlanSlots(q, notOk, "2026-08-19T20:00:00Z")).toEqual([]);
    const lines = planLines(q, notOk, "2026-08-19T20:00:00Z");
    expect(lines).toEqual(["PLAN (dry-run) · no ticket can be scheduled · anchor unavailable: no anchor candidates available from any source"]);
  });

  it("returns no lines for an empty queue even with a healthy anchor", () => {
    const ok: AnchorResult = { ok: true, anchorIso: "2026-08-19T09:17:50Z", source: "manual-end-comment", detail: "x" };
    expect(planLines([], ok, "2026-08-19T20:00:00Z")).toEqual([]);
  });

  it("a single already-clear ticket slots at `now`, rendered in the exact brief-specified template", () => {
    const ok: AnchorResult = { ok: true, anchorIso: "2026-08-19T09:17:50Z", source: "manual-end-comment", detail: "x" };
    const t = ticket({ repo: "studio-b-ai/studiob", number: 558 });
    const q: QueueEntry[] = [{ status: "queued", ticket: t, slotGroup: 0 }];
    const now = "2026-08-19T23:00:00Z";
    const slots = computePlanSlots(q, ok, now);
    expect(slots).toEqual([{ ticket: t, slotIso: now, slotGroup: 0, windowReason: "clear now" }]);
    const lines = planLines(q, ok, now);
    expect(lines).toEqual([
      "`PLAN (dry-run) · studio-b-ai/studiob#558 @ 2026-08-19T23:00:00Z · anchor=2026-08-19T09:17:50Z · reason=clear now`",
    ]);
  });

  it("a second queued ticket's slot walks forward from the first ticket's simulated slot", () => {
    const ok: AnchorResult = { ok: true, anchorIso: "2026-08-19T09:17:50Z", source: "manual-end-comment", detail: "x" };
    const first = ticket({ repo: "studio-b-ai/studiob", number: 1 });
    const second = ticket({ repo: "studio-b-ai/studiob", number: 2 });
    const q: QueueEntry[] = [
      { status: "queued", ticket: first, slotGroup: 0 },
      { status: "queued", ticket: second, slotGroup: 1 },
    ];
    const now = "2026-08-19T23:00:00Z"; // fully clear now
    const slots = computePlanSlots(q, ok, now);
    expect(slots[0].slotIso).toBe(now); // first fires immediately
    // second must wait >=30min after the FIRST's simulated slot (spacing law applied to the walk)
    expect(Date.parse(slots[1].slotIso) - Date.parse(slots[0].slotIso)).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });

  it("consolidated tickets share one rendered slot line's timestamp", () => {
    const ok: AnchorResult = { ok: true, anchorIso: "2026-08-19T09:17:50Z", source: "manual-end-comment", detail: "x" };
    const a = ticket({ repo: "studio-b-ai/studiob", number: 1 });
    const b = ticket({ repo: "studio-b-ai/client-asthetik", number: 2, repoClass: "client-asthetik" });
    const q: QueueEntry[] = [
      { status: "queued", ticket: a, slotGroup: 0 },
      { status: "queued", ticket: b, slotGroup: 0 }, // same group = consolidated
    ];
    const now = "2026-08-19T23:00:00Z";
    const slots = computePlanSlots(q, ok, now);
    expect(slots[0].slotIso).toBe(slots[1].slotIso);
    expect(slots[1].windowReason).toMatch(/consolidated/);
  });
});

// ───────────────────────────── #280 ledger parsing (real recorded fixture) ─────────────────────────────

describe("parseTrainLedger + parseEndComments (real client-asthetik#280 fixture)", () => {
  it("extracts exactly the grammar-tagged lines actually present, correctly typed by kind", () => {
    const entries = parseTrainLedger(REAL_280_COMMENTS);
    const kinds = entries.map((e) => e.kind);
    expect(kinds.filter((k) => k === "END")).toHaveLength(2);
    expect(kinds.filter((k) => k === "PLAN")).toHaveLength(4);
    expect(kinds.filter((k) => k === "NOTE")).toHaveLength(1);
    // No literal START line has been posted yet tonight — bare `START`/`END` mentions in prose
    // (no `\s+<content>` after the keyword) correctly do NOT parse as entries (see file header).
    expect(kinds.filter((k) => k === "START")).toHaveLength(0);
    expect(entries).toHaveLength(7);
  });

  it("every parsed entry carries a non-empty detail (even the two with nested-backtick truncation)", () => {
    for (const e of parseTrainLedger(REAL_280_COMMENTS)) {
      expect(e.detail.length).toBeGreaterThan(0);
    }
  });

  it("parseEndComments returns exactly the two real END lines, in body order, with correct stamps", () => {
    const ends = parseEndComments(REAL_280_COMMENTS);
    expect(ends).toHaveLength(2);
    expect(ends[0].isoStamp).toBe("2026-08-19T08:31:24Z");
    expect(ends[0].detail).toMatch(/studiob-api deployment 824ce6b6/);
    expect(ends[1].isoStamp).toBe("2026-08-19T09:17:50Z");
    expect(ends[1].detail).toMatch(/Heritage publish for client-asthetik#276/);
  });

  it("parses all five grammar kinds given synthetic HELD/START lines (neither appears live yet)", () => {
    const synthetic: RestartTrainComment[] = [
      {
        id: 1,
        login: "kbibelhausen",
        createdAt: "2026-08-19T22:00:00Z",
        body: "`HELD 2026-08-19T22:00:00Z · train:hold label present on ops-pipeline#172 · waiting for Kevin`",
      },
      {
        id: 2,
        login: "kbibelhausen",
        createdAt: "2026-08-19T22:05:00Z",
        body: "`START 2026-08-19T22:05:00Z · studiob#999 merged (abc1234)`",
      },
    ];
    const entries = parseTrainLedger(synthetic);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("HELD");
    expect(entries[1].kind).toBe("START");
    expect(entries[1].detail).toBe("studiob#999 merged (abc1234)");
  });
});

describe("findDanglingPlan (real client-asthetik#280 fixture)", () => {
  it("is NOT dangling before the newest PLAN's own stamped slot has arrived", () => {
    // The latest-by-stamp entry across the real fixture is the 22:30Z `studiob#558` PLAN.
    const r = findDanglingPlan(REAL_280_COMMENTS, "2026-08-19T21:00:00Z");
    expect(r.dangling).toBe(false);
  });

  it("IS dangling once that PLAN's slot has passed with nothing newer confirming it", () => {
    const r = findDanglingPlan(REAL_280_COMMENTS, "2026-08-19T23:00:00Z");
    expect(r.dangling).toBe(true);
    expect(r.detail).toMatch(/kbibelhausen/);
    expect(r.detail).toMatch(/22:30/);
  });

  it("is not dangling with no ledger entries at all", () => {
    expect(findDanglingPlan([], "2026-08-19T23:00:00Z")).toEqual({ dangling: false });
  });
});
