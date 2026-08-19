import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeAnchor,
  computePlanSlots,
  findDanglingPlan,
  hasTrainConsolidate,
  isBatchBlackoutUtc,
  isBusinessHoursBlockedET,
  orderQueue,
  parseEndComments,
  parseTrainAfterTokens,
  parseTrainLedger,
  parseTrainPin,
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

  it("fails closed when the two MACHINE sources are within 30 min of each other", () => {
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

  it("does NOT fail closed when manual-end-comment corroborates a machine source at the SAME instant (codex P2, 2026-08-19)", () => {
    // Real recorded values: client-asthetik acuops run 32236101007's job completed_at and the
    // human #280 END line for the same Heritage publish are IDENTICAL (2026-08-19T09:17:50Z) —
    // the prior version of computeAnchor treated this normal corroboration as ambiguity and
    // could never produce an anchor on a night where the human calendar agrees with the machine.
    const r = computeAnchor({
      now: "2026-08-19T12:00:00Z",
      danglingPlan: false,
      candidates: [
        { source: "client-asthetik-actions", completedAtIso: "2026-08-19T09:17:50Z", detail: "acuops run 32236101007" },
        { source: "manual-end-comment", completedAtIso: "2026-08-19T09:17:50Z", detail: "Heritage publish for client-asthetik#276" },
      ],
    });
    expect(r).toEqual({
      ok: true,
      anchorIso: "2026-08-19T09:17:50Z",
      source: "client-asthetik-actions",
      detail: "acuops run 32236101007",
    });
  });

  it("still fails closed when manual-end-comment corroborates ONE machine source while the OTHER machine source is genuinely close (three-candidate case)", () => {
    const r = computeAnchor({
      now: "2026-08-19T12:00:00Z",
      danglingPlan: false,
      candidates: [
        { source: "client-asthetik-actions", completedAtIso: "2026-08-19T09:17:50Z", detail: "a" },
        { source: "manual-end-comment", completedAtIso: "2026-08-19T09:17:50Z", detail: "c" },
        { source: "studiob-api-railway", completedAtIso: "2026-08-19T09:30:00Z", detail: "b" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/within 30 min/);
      expect(r.reason).toMatch(/client-asthetik-actions/);
      expect(r.reason).toMatch(/studiob-api-railway/);
    }
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
  it("is NOT dangling before ANY PLAN's own stamped slot has arrived", () => {
    // 20:00Z is before all four real PLAN stamps (earliest is the 20:15Z client-asthetik#281 one).
    const r = findDanglingPlan(REAL_280_COMMENTS, "2026-08-19T20:00:00Z");
    expect(r.dangling).toBe(false);
  });

  it("IS dangling once the EARLIEST overdue PLAN's slot has passed with nothing confirming it — even though a LATER, unrelated PLAN carries a higher stamp (codex P2, 2026-08-19)", () => {
    // The real fixture's client-asthetik#281 PLAN is stamped 20:15Z with nothing (END/START/
    // NOTE) at or after it in the fixture. A prior version of findDanglingPlan only inspected
    // the single latest-EMBEDDED-STAMP entry across ALL kinds — at now=21:00Z that was the
    // FUTURE 22:30Z `studiob#558` PLAN (not yet due), so it wrongly reported not-dangling and
    // stayed blind to the genuinely overdue ca#281 promise the whole fixture already contains.
    const r = findDanglingPlan(REAL_280_COMMENTS, "2026-08-19T21:00:00Z");
    expect(r.dangling).toBe(true);
    expect(r.detail).toMatch(/kbibelhausen/);
    expect(r.detail).toMatch(/20:15/);
    expect(r.detail).toMatch(/client-asthetik#281/);
  });

  it("reports the OLDEST unconfirmed overdue PLAN once several are overdue", () => {
    // At 23:00Z all four real PLANs are overdue; ca#281 (20:15Z) has been dangling longest and
    // is still reported first — NOT the 22:30Z studiob#558 PLAN a prior version pointed to.
    const r = findDanglingPlan(REAL_280_COMMENTS, "2026-08-19T23:00:00Z");
    expect(r.dangling).toBe(true);
    expect(r.detail).toMatch(/kbibelhausen/);
    expect(r.detail).toMatch(/20:15/);
  });

  it("is not dangling with no ledger entries at all", () => {
    expect(findDanglingPlan([], "2026-08-19T23:00:00Z")).toEqual({ dangling: false });
  });
});

describe("parseTrainPin (synthetic — no real train:ready ticket has ever existed, see fn doc)", () => {
  it("returns null for comments with no pin line", () => {
    const c: RestartTrainComment[] = [
      { id: 1, login: "kbibelhausen", createdAt: "2026-08-19T22:00:00Z", body: "looks good, merging soon" },
    ];
    expect(parseTrainPin(c)).toBeNull();
  });

  it("returns null for an empty comment list", () => {
    expect(parseTrainPin([])).toBeNull();
  });

  it("parses a well-formed pin line", () => {
    const c: RestartTrainComment[] = [
      {
        id: 1,
        login: "train-bot",
        createdAt: "2026-08-19T22:10:00Z",
        body: "`TRAIN-PIN 2026-08-19T22:10:00Z · head=abc1234def5678abc1234def5678abc1234def56 · applied-by=kbibelhausen`",
      },
    ];
    expect(parseTrainPin(c)).toEqual({
      appliedAtIso: "2026-08-19T22:10:00Z",
      pinnedHeadSha: "abc1234def5678abc1234def5678abc1234def56",
      appliedBy: "kbibelhausen",
    });
  });

  it("a short (abbreviated) sha is REJECTED — orderQueue compares the full 40-char headRefOid, so a short pin could only ever masquerade as head drift (codex P3)", () => {
    const c: RestartTrainComment[] = [
      { id: 1, login: "train-bot", createdAt: "2026-08-19T22:10:00Z", body: "`TRAIN-PIN 2026-08-19T22:10:00Z · head=abc1234 · applied-by=kbibelhausen`" },
    ];
    expect(parseTrainPin(c)).toBeNull();
  });

  it("the LATEST pin wins when a PR was re-pinned after a re-label", () => {
    const c: RestartTrainComment[] = [
      { id: 1, login: "train-bot", createdAt: "2026-08-19T20:00:00Z", body: "`TRAIN-PIN 2026-08-19T20:00:00Z · head=1111111111111111111111111111111111111111 · applied-by=kbibelhausen`" },
      { id: 2, login: "system", createdAt: "2026-08-19T20:30:00Z", body: "head drift detected, label removed" },
      { id: 3, login: "train-bot", createdAt: "2026-08-19T21:00:00Z", body: "`TRAIN-PIN 2026-08-19T21:00:00Z · head=2222222222222222222222222222222222222222 · applied-by=kbibelhausen`" },
    ];
    expect(parseTrainPin(c)).toEqual({
      appliedAtIso: "2026-08-19T21:00:00Z",
      pinnedHeadSha: "2222222222222222222222222222222222222222",
      appliedBy: "kbibelhausen",
    });
  });

  it("a malformed pin (bad ISO, non-hex sha) does not match and falls through to null", () => {
    const c: RestartTrainComment[] = [
      { id: 1, login: "train-bot", createdAt: "2026-08-19T22:10:00Z", body: "`TRAIN-PIN not-a-date · head=zzzzzzz · applied-by=kbibelhausen`" },
    ];
    expect(parseTrainPin(c)).toBeNull();
  });
});

describe("parseTrainAfterTokens (synthetic)", () => {
  it("returns an empty array with no train:after tokens present", () => {
    const c: RestartTrainComment[] = [{ id: 1, login: "k", createdAt: "2026-08-19T22:00:00Z", body: "no dependency here" }];
    expect(parseTrainAfterTokens(c)).toEqual([]);
  });

  it("extracts a single token", () => {
    const c: RestartTrainComment[] = [
      { id: 1, login: "k", createdAt: "2026-08-19T22:00:00Z", body: "train:after studio-b-ai/client-asthetik#275" },
    ];
    expect(parseTrainAfterTokens(c)).toEqual(["studio-b-ai/client-asthetik#275"]);
  });

  it("extracts multiple distinct tokens across separate comments, deduplicated", () => {
    const c: RestartTrainComment[] = [
      { id: 1, login: "k", createdAt: "2026-08-19T22:00:00Z", body: "train:after studio-b-ai/client-asthetik#275" },
      { id: 2, login: "k", createdAt: "2026-08-19T22:05:00Z", body: "also: train:after studio-b-ai/studiob#558 please" },
      { id: 3, login: "k", createdAt: "2026-08-19T22:06:00Z", body: "train:after studio-b-ai/client-asthetik#275 (again, same one)" },
    ];
    expect(parseTrainAfterTokens(c).sort()).toEqual(
      ["studio-b-ai/client-asthetik#275", "studio-b-ai/studiob#558"].sort(),
    );
  });
});

describe("hasTrainConsolidate (synthetic)", () => {
  it("is false with no consolidate token present", () => {
    const c: RestartTrainComment[] = [{ id: 1, login: "k", createdAt: "2026-08-19T22:00:00Z", body: "just a normal comment" }];
    expect(hasTrainConsolidate(c)).toBe(false);
  });

  it("is true when any comment carries the literal token", () => {
    const c: RestartTrainComment[] = [
      { id: 1, login: "k", createdAt: "2026-08-19T22:00:00Z", body: "unrelated" },
      { id: 2, login: "k", createdAt: "2026-08-19T22:05:00Z", body: "train:consolidate — ride ahead of #275" },
    ];
    expect(hasTrainConsolidate(c)).toBe(true);
  });

  it("does not false-positive on a similarly-worded but different token", () => {
    const c: RestartTrainComment[] = [{ id: 1, login: "k", createdAt: "2026-08-19T22:00:00Z", body: "train:consolidated-report is unrelated text" }];
    // \b after "consolidate" means "consolidated..." (no boundary between "e" and "d") does NOT match —
    // this asserts that word-boundary behavior explicitly rather than leaving it implicit.
    expect(hasTrainConsolidate(c)).toBe(false);
  });

  it("is false for an empty comment list", () => {
    expect(hasTrainConsolidate([])).toBe(false);
  });
});

// ───────────── orderQueue — train:after cycle fail-closed (codex P2 2026-08-19) ─────────────

describe("orderQueue — train:after cycles fail closed", () => {
  it("invalidates BOTH members of a mutual train:after cycle and schedules neither", () => {
    const a = ticket({ number: 1, appliedAt: "2026-08-19T19:00:00Z", afterTokens: ["studio-b-ai/studiob#2"] });
    const b = ticket({ number: 2, appliedAt: "2026-08-19T20:00:00Z", afterTokens: ["studio-b-ai/studiob#1"] });
    const entries = orderQueue([a, b]);
    expect(entries.filter((e) => e.status === "queued")).toHaveLength(0);
    const invalid = entries.filter((e) => e.status === "invalidated");
    expect(invalid.map((e) => e.ticket.number).sort()).toEqual([1, 2]);
    for (const e of invalid) {
      if (e.status === "invalidated") expect(e.reason).toMatch(/train:after cycle/);
    }
  });

  it("still schedules an independent ticket alongside an invalidated cycle pair", () => {
    const a = ticket({ number: 1, appliedAt: "2026-08-19T19:00:00Z", afterTokens: ["studio-b-ai/studiob#2"] });
    const b = ticket({ number: 2, appliedAt: "2026-08-19T20:00:00Z", afterTokens: ["studio-b-ai/studiob#1"] });
    const c = ticket({ number: 3, appliedAt: "2026-08-19T21:00:00Z" });
    const entries = orderQueue([a, b, c]);
    const queued = entries.filter((e) => e.status === "queued");
    expect(queued.map((e) => e.ticket.number)).toEqual([3]);
    expect(entries.filter((e) => e.status === "invalidated")).toHaveLength(2);
  });

  it("invalidates a ticket transitively blocked behind a cycle (its dep can never merge first)", () => {
    const a = ticket({ number: 1, appliedAt: "2026-08-19T19:00:00Z", afterTokens: ["studio-b-ai/studiob#2"] });
    const b = ticket({ number: 2, appliedAt: "2026-08-19T20:00:00Z", afterTokens: ["studio-b-ai/studiob#1"] });
    const c = ticket({ number: 3, appliedAt: "2026-08-19T21:00:00Z", afterTokens: ["studio-b-ai/studiob#1"] });
    const entries = orderQueue([a, b, c]);
    expect(entries.filter((e) => e.status === "queued")).toHaveLength(0);
    expect(entries.filter((e) => e.status === "invalidated")).toHaveLength(3);
  });

  it("negative control (Rule #322): an acyclic train:after chain still schedules fully, in order", () => {
    const a = ticket({ number: 1, appliedAt: "2026-08-19T21:00:00Z" });
    const b = ticket({ number: 2, appliedAt: "2026-08-19T19:00:00Z", afterTokens: ["studio-b-ai/studiob#1"] });
    const c = ticket({ number: 3, appliedAt: "2026-08-19T20:00:00Z", afterTokens: ["studio-b-ai/studiob#2"] });
    const entries = orderQueue([a, b, c]);
    const queued = entries.filter((e) => e.status === "queued");
    expect(queued.map((e) => e.ticket.number)).toEqual([1, 2, 3]);
    expect(entries.filter((e) => e.status === "invalidated")).toHaveLength(0);
  });
});

describe("orderQueue — train:after deps on drift-invalidated tickets fail closed (codex P2 pass 3)", () => {
  const DRIFTED = { pinnedHeadSha: "a".repeat(40), currentHeadSha: "b".repeat(40) };

  it("a ticket depending on a drift-invalidated ticket is invalidated, never scheduled ahead of its declared order", () => {
    const a = ticket({ number: 1, appliedAt: "2026-08-19T19:00:00Z", ...DRIFTED });
    const b = ticket({ number: 2, appliedAt: "2026-08-19T20:00:00Z", afterTokens: ["studio-b-ai/studiob#1"] });
    const entries = orderQueue([a, b]);
    expect(entries.filter((e) => e.status === "queued")).toHaveLength(0);
    const invalidated = entries.filter((e) => e.status === "invalidated");
    expect(invalidated).toHaveLength(2);
    const bEntry = invalidated.find((e) => e.ticket.number === 2);
    expect(bEntry && "reason" in bEntry ? bEntry.reason : "").toMatch(/train:after .* fails closed/);
    expect(bEntry && "reason" in bEntry ? bEntry.reason : "").toMatch(/invalidated by head drift/);
  });

  it("the block is transitive: C after B after drifted A invalidates all three, with the chained reason", () => {
    const a = ticket({ number: 1, appliedAt: "2026-08-19T19:00:00Z", ...DRIFTED });
    const b = ticket({ number: 2, appliedAt: "2026-08-19T20:00:00Z", afterTokens: ["studio-b-ai/studiob#1"] });
    const c = ticket({ number: 3, appliedAt: "2026-08-19T21:00:00Z", afterTokens: ["studio-b-ai/studiob#2"] });
    const entries = orderQueue([a, b, c]);
    expect(entries.filter((e) => e.status === "queued")).toHaveLength(0);
    expect(entries.filter((e) => e.status === "invalidated")).toHaveLength(3);
    const cEntry = entries.find((e) => e.status === "invalidated" && e.ticket.number === 3);
    expect(cEntry && "reason" in cEntry ? cEntry.reason : "").toMatch(/itself blocked behind a head-drift invalidation/);
  });

  it("negative control (Rule #322): a dep entirely ABSENT from the train stays a no-op — the ticket schedules", () => {
    const b = ticket({ number: 2, appliedAt: "2026-08-19T20:00:00Z", afterTokens: ["studio-b-ai/studiob#999"] });
    const entries = orderQueue([b]);
    const queued = entries.filter((e) => e.status === "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0].ticket.number).toBe(2);
    expect(entries.filter((e) => e.status === "invalidated")).toHaveLength(0);
  });

  it("an unrelated schedulable ticket still schedules while the drift-blocked pair is invalidated", () => {
    const a = ticket({ number: 1, appliedAt: "2026-08-19T19:00:00Z", ...DRIFTED });
    const b = ticket({ number: 2, appliedAt: "2026-08-19T20:00:00Z", afterTokens: ["studio-b-ai/studiob#1"] });
    const c = ticket({ number: 3, appliedAt: "2026-08-19T21:00:00Z" });
    const entries = orderQueue([a, b, c]);
    const queued = entries.filter((e) => e.status === "queued");
    expect(queued.map((e) => e.ticket.number)).toEqual([3]);
    expect(entries.filter((e) => e.status === "invalidated")).toHaveLength(2);
  });
});
