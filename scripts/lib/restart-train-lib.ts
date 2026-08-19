/**
 * restart-train-lib.ts — Heritage restart train, RUNG 0 (ops-pipeline#172).
 *
 * PURE functions only — no I/O, no `gh`, no `fetch`, no `Date.now()`. Every clock reference is
 * an explicit `nowIso` parameter passed in by the caller (the worker, `scripts/restart-train.ts`,
 * or a test). This is deliberate: rung 0's entire acceptance bar is "computed slots you can
 * replay against recorded facts" — a function that reads the wall clock itself can't be replayed.
 *
 * Canon: brain vault `library/architecture/2026-08-19-heritage-restart-train-design.md`
 * (design v0) + `library/decisions/2026-08-19-heritage-restart-train-merge-authority-label-gated.md`
 * (Kevin LOCKED option A, merge authority, 2026-08-19T20:45Z) + tracker `ops-pipeline#172`.
 *
 * Rung 0 fires nothing, merges nothing, labels nothing — it computes an anchor (the latest known
 * fleet-restart-class event), a window-law clearance state, an ordered ticket queue, and renders
 * `PLAN (dry-run)` lines mirroring the stamp format humans already post by hand on
 * client-asthetik#280 (the "calendar"). #412: a PLAN line describes an intended future slot, not
 * a completed action — never "deployed", never "started" (this file never emits a START line;
 * only a human merge, or rung 3+, produces a real START).
 *
 * Five named functions per the rung-0 brief, in the order it lists them:
 *   1. computeAnchor    — reduce up to 3 candidate "last restart" facts to one, fail-closed on
 *                          any ambiguity.
 *   2. windowState       — is `now` clear to fire a ticket of this repo class, given the anchor?
 *   3. orderQueue        — FIFO + `train:after` + `train:consolidate` + head-drift invalidation.
 *   4. planLines          — render `PLAN (dry-run)` lines for an ordered queue.
 *   5. parseEndComments  — extract the human `END <ISO> · ...` lines from client-asthetik#280.
 * A handful of small named helpers (`repoClassFor`, `parseTrainLedger`, `findDanglingPlan`,
 * `computePlanSlots`, the ET/UTC window-law predicates) support those five and are exported for
 * independent unit testing — none of them do I/O either.
 */

// ───────────────────────────── repo / ticket types ─────────────────────────────

export type RepoClass = "client-asthetik" | "studiob" | "other";

/** The only two repos the train currently reads `train:ready` from (brief §2). Anything else
 * classifies as "other" — `windowState` never applies the client-asthetik ET gate to it, and the
 * worker should never have produced such a ticket in the first place; kept total rather than
 * throwing so a stray future repo fails closed at the window-law layer, not with a crash. */
export function repoClassFor(repo: string): RepoClass {
  if (repo === "studio-b-ai/client-asthetik") return "client-asthetik";
  if (repo === "studio-b-ai/studiob") return "studiob";
  return "other";
}

export interface Ticket {
  repo: string; // "org/repo"
  number: number;
  repoClass: RepoClass;
  /** ISO instant the `train:ready` label was applied — the FIFO sort key. */
  appliedAt: string;
  /** Head sha recorded at label-apply time (the pin comment, per design §1.1). */
  pinnedHeadSha: string;
  /** Head sha as of THIS read (from the PR API) — a mismatch means the PR moved after being
   * queued and must never be scheduled blind (design §5 / Rule #136). */
  currentHeadSha: string;
  /** Parsed `train:after <org/repo>#<n>` comment tokens naming other tickets this one must not
   * be scheduled ahead of, when the named ticket is present in the same queue. */
  afterTokens: string[];
  /** `train:consolidate` present — "ride the ticket ahead" (design §1.1: one restart, two PRs,
   * Rule #22 merge-mode co-publish). Only meaningful for client-asthetik tickets in practice,
   * but not enforced here — orderQueue treats it uniformly and lets the worker choose whether to
   * ever set it true for a non-client-asthetik ticket. */
  consolidate: boolean;
}

export type QueueEntry =
  | { status: "queued"; ticket: Ticket; slotGroup: number }
  | { status: "invalidated"; ticket: Ticket; reason: string };

// ───────────────────────────── anchor computation ─────────────────────────────

export type AnchorSource = "client-asthetik-actions" | "studiob-api-railway" | "manual-end-comment";

export interface AnchorCandidate {
  source: AnchorSource;
  /** ISO instant this source's restart-class event reached a terminal state. */
  completedAtIso: string;
  /** Free-text description for the PLAN-line `reason=`/log output — never parsed structurally. */
  detail: string;
}

export type AnchorResult =
  | { ok: true; anchorIso: string; source: AnchorSource; detail: string }
  | { ok: false; reason: string };

export interface AnchorFacts {
  /** The instant this anchor is being computed AT — needed for the "no candidates yet" vs
   * "genuinely ambiguous" distinction and threaded through so this stays a pure function. */
  now: string;
  /** 0-3 entries: the worker builds these from client-asthetik Actions, Railway, and
   * `parseEndComments` — never more than one candidate per source. */
  candidates: AnchorCandidate[];
  /** From `findDanglingPlan` — a #280 PLAN whose own stamped instant is already due/past with no
   * confirming START/END/NOTE stamped at or after it. computeAnchor itself never re-derives this
   * (it doesn't have the raw comments) — the worker (or a test) computes it once and passes it
   * in, keeping this function's contract to exactly "reduce these facts", nothing more. */
  danglingPlan: boolean;
  danglingPlanDetail?: string;
}

/**
 * Reduce up to three "last restart-class event" candidates to ONE anchor, fail-closed on any
 * ambiguity (design §1.2 step 2): unparsable timestamps, zero candidates, two INDEPENDENT
 * machine sources (`client-asthetik-actions`, `studiob-api-railway`) reaching a terminal state
 * within 30 minutes of EACH OTHER (not of `now` — a close pair between the two systems means
 * the fleet's restart picture has two near-simultaneous DIFFERENT events and neither can be
 * confidently treated as canonical; #322), or a dangling PLAN on #280 (§ findDanglingPlan).
 *
 * `manual-end-comment` is deliberately EXCLUDED from that pairwise check: it is a human's
 * report ON one of the other two events, not a third independent restart target, and is
 * expected to land within (often seconds of) the machine candidate it corroborates — the
 * normal, unambiguous case where the #280 END line agrees with the Actions/Railway event it
 * describes must not permanently fail-closed the scheduler (codex P2, 2026-08-19: the prior
 * version compared every pair regardless of source, so agreement read as ambiguity).
 *
 * On success, the anchor is the candidate with the LATEST `completedAtIso` — ties between the
 * two machine sources are covered by the 30-minute-pair check above; a `manual-end-comment` tie
 * with a machine candidate is fine (they describe the same instant) and just picks whichever
 * carries the marginally later stamp.
 */
export function computeAnchor(facts: AnchorFacts): AnchorResult {
  if (Number.isNaN(Date.parse(facts.now))) {
    return { ok: false, reason: `unparsable now: ${facts.now}` };
  }

  if (facts.danglingPlan) {
    return {
      ok: false,
      reason: `dangling PLAN on client-asthetik#280 with no confirming START/END/NOTE posted at or after its slot${facts.danglingPlanDetail ? `: ${facts.danglingPlanDetail}` : ""}`,
    };
  }

  const parsed: Array<{ c: AnchorCandidate; ms: number }> = [];
  for (const c of facts.candidates) {
    const ms = Date.parse(c.completedAtIso);
    if (Number.isNaN(ms)) {
      return { ok: false, reason: `unparsable candidate timestamp from ${c.source}: ${c.completedAtIso}` };
    }
    parsed.push({ c, ms });
  }

  if (parsed.length === 0) {
    return { ok: false, reason: "no anchor candidates available from any source" };
  }

  const THIRTY_MIN_MS = 30 * 60 * 1000;
  const MACHINE_SOURCES: AnchorSource[] = ["client-asthetik-actions", "studiob-api-railway"];
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      // Only the two independent machine sources can be genuinely ambiguous with each other —
      // a `manual-end-comment` candidate is corroboration of one of them, never a third event.
      if (!MACHINE_SOURCES.includes(parsed[i].c.source) || !MACHINE_SOURCES.includes(parsed[j].c.source)) {
        continue;
      }
      if (Math.abs(parsed[i].ms - parsed[j].ms) < THIRTY_MIN_MS) {
        return {
          ok: false,
          reason: `two terminal states within 30 min of each other: ${parsed[i].c.source}@${parsed[i].c.completedAtIso} and ${parsed[j].c.source}@${parsed[j].c.completedAtIso}`,
        };
      }
    }
  }

  parsed.sort((a, b) => b.ms - a.ms);
  const latest = parsed[0];
  return { ok: true, anchorIso: latest.c.completedAtIso, source: latest.c.source, detail: latest.c.detail };
}

// ───────────────────────────── window law (DST-correct, no deps) ─────────────────────────────

const ET_ZONE = "America/New_York";

/** Format a UTC epoch-ms instant as a second-precision ISO stamp (`2026-08-19T22:20:00Z`) — the
 * ACTUAL client-asthetik#280 grammar is always second-precision, never millisecond-suffixed (every
 * recorded `END`/`PLAN`/`NOTE` line in the fixture matches this). Raw `Date#toISOString()` always
 * appends `.SSS`, which would render PLAN lines in a format nobody on #280 has ever posted — every
 * internally-computed instant (window-law jumps) renders through this, never `.toISOString()`
 * directly. Facts passed in from callers (anchors, appliedAt) are echoed verbatim and are NOT
 * reformatted here — only instants this module itself computes. */
function toIsoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `Intl.DateTimeFormat.formatToParts`-based zoned wall-clock reader — the ONLY way to ask "what
 * hour/weekday is it in a named IANA zone at this UTC instant" without a date library (brief
 * FORBIDS dayjs/luxon). Some ICU builds render hour 24 instead of 0 at midnight even under
 * `hourCycle: "h23"` (a long-lived, still-occasionally-seen Intl quirk) — normalized below. */
function getZonedParts(
  iso: string,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number } {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Unparsable ISO timestamp: ${iso}`);
  return getZonedPartsFromMs(ms, timeZone);
}

function getZonedPartsFromMs(
  ms: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const parts = dtf.formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const WEEKDAY_MAP: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const hourRaw = Number(get("hour"));
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: hourRaw === 24 ? 0 : hourRaw, // ICU midnight quirk guard
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAY_MAP[get("weekday")] ?? 0,
  };
}

/** The zone's UTC offset (in minutes, positive east of UTC) AT a given UTC instant — derived by
 * formatting that instant in the zone and diffing the parsed wall clock back against the input,
 * never a hardcoded offset table (so DST transitions fall out correctly for free). */
function getOffsetMinutesAt(utcMs: number, timeZone: string): number {
  const p = getZonedPartsFromMs(utcMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUtc - utcMs) / 60000;
}

/** Inverse of getZonedParts: given a WALL-CLOCK instant in a named zone, return its UTC ms value.
 * Standard two-pass offset-correction (guess as if UTC, read the zone's offset at that guess,
 * correct, re-check once more in case the correction crossed a DST boundary) — converges for
 * every real-world zone since no zone's offset changes by more than its own width in one shift.
 * Exported for tests to construct exact ET boundary instants without hardcoding UTC offsets. */
export function zonedWallClockToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number {
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = getOffsetMinutesAt(guessMs, timeZone);
  let candidateMs = guessMs - offset1 * 60000;
  const offset2 = getOffsetMinutesAt(candidateMs, timeZone);
  if (offset2 !== offset1) {
    candidateMs = guessMs - offset2 * 60000;
  }
  return candidateMs;
}

/**
 * Mirrors `acuops-pipeline/.github/workflows/acuops-deploy.yml` L1049-1087's hardcoded
 * after-hours gate LITERALLY (brief: "do NOT read acuops.yaml" — there is nothing to read, the
 * gate is bash inline in that workflow, not config). Verified against the real file: it compares
 * `date +%H` (integer hour, TZ=America/New_York) and `date +%u` (ISO weekday, 1=Mon..7=Sun);
 * blocked ⟺ DOW<6 AND HOUR>=6 AND HOUR<18. Both boundaries land on exact whole hours, so this is
 * equivalent to the continuous half-open interval [06:00:00, 18:00:00) America/New_York on
 * ISO weekdays 1-5 (Mon-Fri) — minute/second-level comparison below reproduces the bash
 * integer-hour truncation exactly, it does not add new precision the original gate lacked.
 */
export function isBusinessHoursBlockedET(iso: string): boolean {
  const p = getZonedParts(iso, ET_ZONE);
  const isWeekday = p.weekday >= 1 && p.weekday <= 5;
  const minutesOfDay = p.hour * 60 + p.minute;
  return isWeekday && minutesOfDay >= 6 * 60 && minutesOfDay < 18 * 60;
}

/**
 * The 05:45-08:15Z "batch blackout" — design §1.2 step 2 / tracker #172. NOT mirrored from any
 * existing code (confirmed via repo-wide grep — there is no prior codified constant for this
 * window anywhere in ops-pipeline, unlike the ET gate above); implemented fresh from the design
 * doc's literal text as the half-open UTC interval [05:45:00Z, 08:15:00Z), chosen for consistency
 * with the ET gate's half-open style. Applies to EVERY ticket regardless of repo class.
 */
export function isBatchBlackoutUtc(iso: string): boolean {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Unparsable ISO timestamp: ${iso}`);
  const d = new Date(ms);
  const minutesOfDayUtc = d.getUTCHours() * 60 + d.getUTCMinutes();
  return minutesOfDayUtc >= 5 * 60 + 45 && minutesOfDayUtc < 8 * 60 + 15;
}

function nextBatchBlackoutExitUtcMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 15, 0, 0);
}

function nextEtBusinessHoursExitMs(ms: number): number {
  const p = getZonedPartsFromMs(ms, ET_ZONE);
  return zonedWallClockToUtcMs(p.year, p.month, p.day, 18, 0, 0, ET_ZONE);
}

function describeBlockAt(nowMs: number, anchorMs: number, repoClass: RepoClass): string {
  const nowIso = toIsoSeconds(nowMs);
  const SPACING_MS = 30 * 60 * 1000;
  if (nowMs - anchorMs < SPACING_MS) {
    return `spacing: now is <30min after anchor (${toIsoSeconds(anchorMs)})`;
  }
  if (isBatchBlackoutUtc(nowIso)) return "batch-blackout: 05:45-08:15Z";
  if (repoClass === "client-asthetik" && isBusinessHoursBlockedET(nowIso)) {
    return "business-hours: America/New_York Mon-Fri 06:00-18:00";
  }
  return "clear";
}

export type WindowClearance = { clear: true } | { clear: false; nextClearIso: string; reason: string };

/**
 * Is `nowIso` clear to fire a ticket of `repoClass`, given `anchorIso`? Three clauses, ALL must
 * hold: (a) `now - anchor >= 30 min` (applies to every ticket); (b) outside the 05:45-08:15Z
 * batch blackout (every ticket); (c) for client-asthetik tickets ONLY, outside the ET
 * business-hours gate. When not clear, walks forward to the next instant where all three hold —
 * a bounded fixed-point loop, since jumping past one clause's boundary can land inside another
 * (e.g. clearing the ET gate at 18:00 ET on a Friday can land inside that Friday's already-past
 * blackout window from the FOLLOWING Monday only if the walk crosses days, which the loop handles
 * by re-checking everything from scratch after every jump).
 */
export function windowState(nowIso: string, repoClass: RepoClass, anchorIso: string): WindowClearance {
  const nowMs = Date.parse(nowIso);
  const anchorMs = Date.parse(anchorIso);
  if (Number.isNaN(nowMs)) throw new Error(`Unparsable now: ${nowIso}`);
  if (Number.isNaN(anchorMs)) throw new Error(`Unparsable anchor: ${anchorIso}`);

  const SPACING_MS = 30 * 60 * 1000;
  let candidateMs = nowMs;
  const MAX_ITERATIONS = 40; // generous bound; real convergence is 2-4 hops even worst-case

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (candidateMs - anchorMs < SPACING_MS) {
      candidateMs = anchorMs + SPACING_MS;
      continue;
    }
    const candidateIso = toIsoSeconds(candidateMs);
    if (isBatchBlackoutUtc(candidateIso)) {
      candidateMs = nextBatchBlackoutExitUtcMs(candidateMs);
      continue;
    }
    if (repoClass === "client-asthetik" && isBusinessHoursBlockedET(candidateIso)) {
      candidateMs = nextEtBusinessHoursExitMs(candidateMs);
      continue;
    }
    if (candidateMs === nowMs) return { clear: true };
    return { clear: false, nextClearIso: candidateIso, reason: describeBlockAt(nowMs, anchorMs, repoClass) };
  }
  throw new Error(
    `windowState: failed to converge on a clear instant within ${MAX_ITERATIONS} iterations (now=${nowIso} anchor=${anchorIso} repoClass=${repoClass})`,
  );
}

// ───────────────────────────── queue ordering ─────────────────────────────

/**
 * FIFO by `appliedAt`, then two adjustments, then head-drift invalidation:
 *   - `train:after <org/repo>#<n>` — a ticket must not sit ahead of a ticket it names, WHEN that
 *     named ticket is present in this same queue (an unresolvable reference is a no-op: nothing
 *     to reorder against, per brief). A reference to a ticket present in this train but
 *     invalidated by head drift is NOT absent — the dependent fails closed transitively
 *     (codex P2, pass 3): scheduling it would publish B before A against the declared order.
 *   - `train:consolidate` — a client-asthetik ticket rides the SAME slot as whichever ticket sits
 *      immediately ahead of it after the above reordering (design §1.1 / Rule #22: one restart,
 *      two PRs). No ticket ahead (first in queue) → falls back to its own slot.
 *   - `currentHeadSha !== pinnedHeadSha` — the PR moved after being queued; invalidated, never
 *     scheduled, reported at the end of the returned list so callers can still see + react to it.
 */
export function orderQueue(tickets: Ticket[]): QueueEntry[] {
  const key = (t: Ticket) => `${t.repo}#${t.number}`;

  const withValidity = tickets.map((t) => ({ ticket: t, valid: t.currentHeadSha === t.pinnedHeadSha }));
  const validTickets = withValidity.filter((x) => x.valid).map((x) => x.ticket);

  const ordered = [...validTickets].sort((a, b) => Date.parse(a.appliedAt) - Date.parse(b.appliedAt));

  const indexOf = (k: string) => ordered.findIndex((t) => key(t) === k);
  const MAX_PASSES = ordered.length + 2;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = false;
    for (const token of ordered) {
      const tIdx = indexOf(key(token));
      for (const dep of token.afterTokens) {
        const depIdx = indexOf(dep);
        if (depIdx === -1) continue; // dependency not in this queue — no-op, per brief
        if (depIdx > tIdx) {
          ordered.splice(tIdx, 1);
          const newDepIdx = indexOf(dep);
          ordered.splice(newDepIdx + 1, 0, token);
          moved = true;
          break;
        }
      }
      if (moved) break;
    }
    if (!moved) break;
  }

  // codex P2 (2026-08-19 pass 2): mutually-dependent `train:after` tokens (A after B, B after A)
  // can never converge — the bounded passes above stop with at least one declared dependency
  // still violated, and proceeding would publish a plan that schedules an unsatisfiable order.
  // Fail closed instead (design §5): a Kahn-style resolution pass over the IN-QUEUE dependency
  // graph; any ticket that cannot resolve (a cycle member, or one transitively blocked behind a
  // cycle) is invalidated, never scheduled. Acyclic queues resolve completely — zero behavior
  // change for every already-tested case.
  const keySet = new Set(ordered.map((t) => key(t)));
  // codex P2 (2026-08-19 pass 3): keys of tickets present in this train but invalidated by head
  // drift. They participate in dependency resolution below but NEVER resolve, so a ticket whose
  // train:after names one (directly or transitively) fails closed instead of scheduling ahead of
  // its declared order. A dependency entirely absent from the train (already merged / never
  // labeled) stays a no-op per the brief — that order is already satisfied or vacuous.
  const driftedKeys = new Set(withValidity.filter((x) => !x.valid).map((x) => key(x.ticket)));
  const resolved = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const t of ordered) {
      const k = key(t);
      if (resolved.has(k)) continue;
      const inQueueDeps = t.afterTokens.filter((d) => keySet.has(d) || driftedKeys.has(d));
      if (inQueueDeps.every((d) => resolved.has(d))) {
        resolved.add(k);
        progress = true;
      }
    }
  }
  // Partition the unresolved: blocked behind a head-drift invalidation (directly or through a
  // chain) vs a genuine cycle — the reasons must state which (#412: prose matches the fact).
  const driftBlockedVia = new Map<string, string>();
  let dbProgress = true;
  while (dbProgress) {
    dbProgress = false;
    for (const t of ordered) {
      const k = key(t);
      if (driftBlockedVia.has(k)) continue;
      const via = t.afterTokens.find((d) => driftedKeys.has(d) || driftBlockedVia.has(d));
      if (via !== undefined) {
        driftBlockedVia.set(k, via);
        dbProgress = true;
      }
    }
  }
  const cycleInvalid = ordered.filter((t) => !resolved.has(key(t)) && !driftBlockedVia.has(key(t)));
  const schedulable = ordered.filter((t) => resolved.has(key(t)));

  const entries: QueueEntry[] = [];
  const groupByKey = new Map<string, number>();
  let nextGroup = 0;
  for (let i = 0; i < schedulable.length; i++) {
    const t = schedulable[i];
    let group: number;
    if (t.consolidate && i > 0) {
      const prevGroup = groupByKey.get(key(schedulable[i - 1]));
      group = prevGroup !== undefined ? prevGroup : nextGroup++;
    } else {
      group = nextGroup++;
    }
    groupByKey.set(key(t), group);
    entries.push({ status: "queued", ticket: t, slotGroup: group });
  }

  for (const x of withValidity) {
    if (!x.valid) {
      entries.push({
        status: "invalidated",
        ticket: x.ticket,
        reason: `head drift: pinned ${x.ticket.pinnedHeadSha.slice(0, 12)} != current ${x.ticket.currentHeadSha.slice(0, 12)}`,
      });
    }
  }

  for (const t of ordered) {
    const via = driftBlockedVia.get(key(t));
    if (via !== undefined) {
      entries.push({
        status: "invalidated",
        ticket: t,
        reason: `train:after ${via} fails closed: that ticket is in this train but ${
          driftedKeys.has(via) ? "invalidated by head drift" : "itself blocked behind a head-drift invalidation"
        } — never scheduling ahead of a declared order (codex P2, 2026-08-19)`,
      });
    }
  }

  for (const t of cycleInvalid) {
    entries.push({
      status: "invalidated",
      ticket: t,
      reason: `train:after cycle: ${key(t)}'s declared order can never be satisfied (mutual/circular train:after among queued tickets) — failing closed, never scheduled`,
    });
  }

  return entries;
}

// ───────────────────────────── PLAN line rendering ─────────────────────────────

export interface PlanSlot {
  ticket: Ticket;
  slotIso: string;
  slotGroup: number;
  windowReason: string;
}

/**
 * Structured slot computation behind `planLines` — exported separately so tests can assert on
 * the data without string-parsing the rendered line. Walks the queued (never invalidated)
 * tickets in order, simulating each one's slot as a stand-in anchor for the NEXT ticket's window
 * check. This is a rung-0 PLANNING convenience only: #355 / design §1.2 step 2 — "the anchor is
 * computed from facts, never from a PLAN" — rung 3's real scheduler recomputes the true anchor
 * from live facts on every 5-minute tick regardless of what a stale PLAN once said; nothing here
 * is persisted or fed back into computeAnchor.
 */
export function computePlanSlots(queue: QueueEntry[], anchor: AnchorResult, nowIso: string): PlanSlot[] {
  if (!anchor.ok) return [];
  const queued = queue.filter((e): e is Extract<QueueEntry, { status: "queued" }> => e.status === "queued");
  if (queued.length === 0) return [];

  const slots: PlanSlot[] = [];
  let simulatedAnchorIso = anchor.anchorIso;
  let lastGroup: number | null = null;
  let lastGroupSlotIso: string | null = null;

  for (const entry of queued) {
    if (lastGroup !== null && entry.slotGroup === lastGroup && lastGroupSlotIso) {
      slots.push({
        ticket: entry.ticket,
        slotIso: lastGroupSlotIso,
        slotGroup: entry.slotGroup,
        windowReason: "consolidated with the ticket ahead of it in this slot",
      });
      continue;
    }
    const clearance = windowState(nowIso, entry.ticket.repoClass, simulatedAnchorIso);
    const slotIso = clearance.clear ? nowIso : clearance.nextClearIso;
    const windowReason = clearance.clear ? "clear now" : clearance.reason;
    slots.push({ ticket: entry.ticket, slotIso, slotGroup: entry.slotGroup, windowReason });
    simulatedAnchorIso = slotIso;
    lastGroup = entry.slotGroup;
    lastGroupSlotIso = slotIso;
  }
  return slots;
}

/**
 * `PLAN (dry-run) · <org/repo>#<n> @ <slot ISO> · anchor=<ISO> · reason=<window-clause>` —
 * backtick-wrapped to mirror the stamp format actually posted by hand on client-asthetik#280
 * (every observed START/END/PLAN/NOTE line there is a backtick-delimited inline code span,
 * ` · ` middle-dot separated fields, Z-suffixed ISO timestamps). Never "deployed" (#412): this
 * is always a PLAN, never a START or END — rung 0 fires nothing.
 */
export function planLines(queue: QueueEntry[], anchor: AnchorResult, nowIso: string): string[] {
  if (!anchor.ok) {
    return [`PLAN (dry-run) · no ticket can be scheduled · anchor unavailable: ${anchor.reason}`];
  }
  const slots = computePlanSlots(queue, anchor, nowIso);
  return slots.map(
    (s) =>
      `\`PLAN (dry-run) · ${s.ticket.repo}#${s.ticket.number} @ ${s.slotIso} · anchor=${anchor.anchorIso} · reason=${s.windowReason}\``,
  );
}

// ───────────────────────────── #280 ledger parsing ─────────────────────────────

export interface RestartTrainComment {
  id: number;
  body: string;
  login: string;
  /** ISO `created_at` — REST API field name; the worker adapts `listIssueComments`'s response
   * into this shape (that helper's `IssueComment` was extended with `createdAt` for this file). */
  createdAt: string;
}

export interface TrainLedgerEntry {
  kind: "END" | "START" | "PLAN" | "NOTE" | "HELD";
  /** The stamp's own leading ISO instant (a PLAN range's end, if any, is folded into `detail` as
   * prose — nothing in rung 0 needs the range end structurally). Empty string if the line had no
   * parseable leading ISO stamp (kept rather than dropped, so a malformed line is still visible). */
  isoStamp: string;
  detail: string;
  commentId: number;
  commentCreatedAt: string;
  commentLogin: string;
}

// First token inside a backtick span must be exactly one of the five grammar keywords, matching
// every observed line on client-asthetik#280 (a stray unrelated backtick span, e.g. `` `/details` ``
// inside the SAME comment, correctly never matches since it doesn't start with a keyword).
const LEDGER_LINE_RE = /`(END|START|PLAN|NOTE|HELD)\s+([^`]*)`/g;
const ISO_PREFIX_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)(?:[–-](?:\d{4}-\d{2}-\d{2}T)?\d{2}:\d{2}(?::\d{2})?Z)?/;

/**
 * Extract every grammar-tagged line (`` `KIND <ISO> · detail` ``) across all comment bodies,
 * chronological by the COMMENT's own `created_at` (not the embedded stamp — two lines in one
 * comment keep body-scan order via `Array.prototype.sort`'s stability guarantee, ES2019+).
 * General-purpose; `parseEndComments` below is the brief-named END-only view over this.
 */
export function parseTrainLedger(comments: RestartTrainComment[]): TrainLedgerEntry[] {
  const entries: TrainLedgerEntry[] = [];
  for (const c of comments) {
    for (const m of c.body.matchAll(LEDGER_LINE_RE)) {
      const kind = m[1] as TrainLedgerEntry["kind"];
      const rest = m[2].trim();
      const isoMatch = rest.match(ISO_PREFIX_RE);
      const isoStamp = isoMatch ? isoMatch[1] : "";
      // Strip everything up to and including the first ` · ` — handles a plain " · ", a range
      // tail ("–23:30Z · "), and a loose "+ · " suffix (all three observed on real #280 lines)
      // uniformly, rather than assuming the separator sits immediately after the ISO match.
      const detail = isoMatch ? rest.slice(isoMatch[0].length).replace(/^[^·]*·\s*/, "").trim() : rest;
      entries.push({ kind, isoStamp, detail, commentId: c.id, commentCreatedAt: c.createdAt, commentLogin: c.login });
    }
  }
  entries.sort((a, b) => Date.parse(a.commentCreatedAt) - Date.parse(b.commentCreatedAt));
  return entries;
}

/** The human `END <ISO> · ...` lines from client-asthetik#280 — source (c) for computeAnchor. */
export function parseEndComments(comments: RestartTrainComment[]): TrainLedgerEntry[] {
  return parseTrainLedger(comments).filter((e) => e.kind === "END");
}

/**
 * A dangling PLAN: ANY parsed PLAN line whose own embedded ISO stamp is already at-or-before
 * `nowIso`, with nothing (END/START/NOTE — anything non-PLAN) stamped at or after THAT PLAN's
 * own instant. We cannot tell whether that PLAN fired, was blocked, or slipped — fail closed
 * rather than guess (#322: silence is not confirmation). Checks every overdue PLAN independently
 * (oldest first) rather than only the single latest-embedded-stamp entry — a prior version did
 * the latter and could miss a genuinely overdue PLAN hiding behind an unrelated FUTURE PLAN that
 * happened to carry a later stamp (codex P2, 2026-08-19: live-reproduced against the real
 * client-asthetik#280 fixture — a `client-asthetik#281` PLAN stamped 20:15Z was still invisible
 * at `now=21:00Z` because a later, unrelated `studiob#558` PLAN stamped 22:30Z sorted first).
 * This deliberately does NOT try to correlate a PLAN to a specific ticket via free text (the real
 * lines embed a repo#number in prose position, not a fixed field) — it is a conservative,
 * ticket-agnostic tripwire: "is there an unconfirmed promise whose slot has already passed?"
 * Reports the OLDEST unconfirmed overdue PLAN when more than one qualifies, since that is the
 * promise that has been dangling longest.
 */
export function findDanglingPlan(comments: RestartTrainComment[], nowIso: string): { dangling: boolean; detail?: string } {
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) throw new Error(`Unparsable now: ${nowIso}`);

  const entries = parseTrainLedger(comments);
  const withMs = entries.map((e) => ({ e, ms: Date.parse(e.isoStamp) })).filter((x) => !Number.isNaN(x.ms));
  if (withMs.length === 0) return { dangling: false };

  const overduePlans = withMs
    .filter((x) => x.e.kind === "PLAN" && x.ms <= nowMs)
    .sort((a, b) => a.ms - b.ms); // oldest overdue PLAN first

  for (const plan of overduePlans) {
    const confirmed = withMs.some((x) => x.e.kind !== "PLAN" && x.ms >= plan.ms);
    if (!confirmed) {
      return { dangling: true, detail: `${plan.e.commentLogin}'s PLAN ${plan.e.isoStamp} · ${plan.e.detail}` };
    }
  }

  return { dangling: false };
}

// ───────────────────────────── train:ready ticket-building support ─────────────────────────────

export interface TrainPinInfo {
  appliedAtIso: string;
  pinnedHeadSha: string;
  appliedBy: string;
}

const TRAIN_PIN_RE =
  /`TRAIN-PIN\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)\s*·\s*head=([0-9a-f]{40})\s*·\s*applied-by=([^`]+?)\s*`/;

/**
 * Parse the `train:ready` PIN comment a PR receives at label-apply time (design §1.1: "The train
 * records head sha + applied-by + applied-at in a PR comment at label time — the head is pinned
 * there"). Grammar mirrors the #280 ledger style for consistency:
 * `` `TRAIN-PIN <ISO> · head=<sha> · applied-by=<login>` ``
 *
 * ⚠️ UNVERIFIED-LIVE (see ops-pipeline#172 rung-0 PR body): no `train:ready` ticket has ever
 * existed on any repo, and the label-apply mechanism that is supposed to POST this comment is a
 * SEPARATE, not-yet-built piece of work (design §4 "Day 1", CTO-owned) — so unlike
 * `parseTrainLedger`'s #280 grammar (mirrored from real recorded lines), this grammar is a
 * PROPOSED CONVENTION invented here because rung 0's `Ticket`-building needs *something*
 * parseable. Whoever builds the label-apply step must emit exactly this format, or this parser
 * (and its synthetic-fixture test, since no real example exists to record) needs updating to
 * match whatever they actually emit instead — flag this explicitly at that build's kickoff
 * (#464: this parser's first REAL input is part of its ship, not a footnote already covered by
 * rung 0's).
 *
 * Returns null (never throws) when no pin comment is found — the worker excludes that PR from
 * this tick's queue rather than fabricating a Ticket, matching the design's fail-closed posture;
 * a label with no pin posted yet is a normal race (the label-apply step hasn't finished), not a
 * fault. When multiple pin comments exist (a re-label after a head-drift invalidation posts a
 * NEW one — design §1.1), the LATEST one wins; comments must already be in chronological order
 * (same input contract as `parseTrainLedger`). A pin whose head is not a FULL 40-character
 * sha is treated as no pin at all (codex P3, pass 3): `orderQueue` compares `pinnedHeadSha` to
 * GitHub's full `headRefOid` with exact equality, so an abbreviated pin could never validate and
 * would masquerade as permanent head drift — rejecting it at parse yields the truthful
 * "no valid pin" exclusion instead.
 */
export function parseTrainPin(comments: RestartTrainComment[]): TrainPinInfo | null {
  let found: TrainPinInfo | null = null;
  for (const c of comments) {
    const m = c.body.match(TRAIN_PIN_RE);
    if (m) found = { appliedAtIso: m[1], pinnedHeadSha: m[2], appliedBy: m[3].trim() };
  }
  return found;
}

const TRAIN_AFTER_RE = /train:after\s+([\w.-]+\/[\w.-]+#\d+)/g;

/** Every `train:after <org/repo>#<n>` token across all comments on a PR (design §1.1: "a comment
 * token", not tied to the pin comment specifically). Deduplicated; order not meaningful —
 * `orderQueue` treats `afterTokens` as an unordered dependency set. */
export function parseTrainAfterTokens(comments: RestartTrainComment[]): string[] {
  const tokens = new Set<string>();
  for (const c of comments) {
    for (const m of c.body.matchAll(TRAIN_AFTER_RE)) tokens.add(m[1]);
  }
  return [...tokens];
}

/** Whether any comment on the PR carries the literal `train:consolidate` token (design §1.1). */
export function hasTrainConsolidate(comments: RestartTrainComment[]): boolean {
  return comments.some((c) => /train:consolidate\b/.test(c.body));
}
