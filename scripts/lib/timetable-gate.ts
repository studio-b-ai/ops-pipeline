/**
 * Departure-timetable gate — the ten-check evaluation engine (ops-pipeline#242
 * unit 2; FRI-3 canon: brain library/decisions/2026-08-19-departure-timetable-rule.md
 * §4a/§4b/§4c + §8, as amended by Kevin 8/30 —
 * 2026-08-30-departure-timetable-kevin-amendments-windows-and-qa-98.md).
 *
 * PURE engine, deliberately: parsers take YAML *text*, the evaluator takes a
 * fully-probed facts object plus an explicit `now`. All live probing (gh, git
 * patch-id, Railway 429 counts, QA ledger reads) belongs to the caller — the
 * PreToolUse hook / deploy-command-guard allow-form on a later rung — so every
 * malformed shape and every check verdict is exercisable in unit tests without
 * touching disk, network, or the clock (the automerge-skip-allowlist pattern).
 *
 * FAIL-CLOSED SHAPES, deliberately (Rule #464 — an inert guard must not look
 * healthy):
 *   - A malformed registry FILE throws at parse — broken deployment, loud.
 *   - A malformed, expired, or unquoted arc ENTRY is NO ARC (excluded with a
 *     reason), never "best effort".
 *   - A holds file that fails to parse = ALL arcs held (§4b).
 *   - An unlisted surface, an unrecognized window band, a PROPOSED (un-RULED)
 *     window, and a RULED-GATED window all evaluate CLOSED.
 *   - Any unresolvable fact fails its check; the overall verdict is DEPART
 *     only when every check passes. There is no partial credit.
 *   - The gate-level DENYLIST (§8) is engine-owned: no arc's allowed_paths can
 *     allow those paths, ever.
 */

import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Arc {
  slug: string;
  repo: string;
  surface: string;
  allowed_paths: string[];
  decision_doc: string;
  registered_by: string;
  /** YYYY-MM-DD */
  expires: string;
  lane_manager: string;
  /** optional; default 300 changed lines; pure reverts exempt */
  diff_cap?: number;
  /** receipt ref ONLY after the #169 canary; null/absent = unproven */
  single_n_proven?: string | null;
}

export interface Hold {
  slug: string;
  held_by: string;
  issue?: string;
}

export interface WindowEntry {
  surface: string;
  repo?: string;
  band: string;
  cadence?: string;
  // pg-enum-drift-exempt: windows.yaml registry field (YAML in the brain vault), not a Postgres column
  status: "RULED" | "RULED-GATED" | "PROPOSED";
  gate_note?: string;
  build_lead_min?: number;
  coupled_note?: string;
}

export type CheckVerdict = "pass" | "fail";

export interface CheckResult {
  /** stable id, "01".."13" */
  id: string;
  name: string;
  verdict: CheckVerdict;
  reason: string;
}

export interface GateResult {
  verdict: "DEPART" | "FALL_THROUGH";
  arcSlug: string | null;
  checks: CheckResult[];
  /** every failing check's reason, for the ledger + the receipt comment */
  failures: string[];
}

/**
 * Everything the caller probed live before invoking the engine. Absent /
 * undefined members fail their checks (fail-closed) with an "unresolvable"
 * reason rather than throwing — a missing probe is a verdict, not a crash.
 */
export interface DepartureFacts {
  repo: string;
  /** merge-ref file list, fully paginated (#401) */
  changedPaths: string[];
  /** total changed lines (additions + deletions) */
  changedLineCount?: number;
  headSha?: string;
  /** all required CI checks with their JSON bucket (#459 — never --watch) */
  ciChecks?: { name: string; bucket: string }[];
  /** codex receipt: exact sha it reviewed + whether it was clean */
  codexReceipt?: { headSha: string; clean: boolean };
  /** patch-id equality vs the reverted commit, computed by the caller */
  isPureRevert?: boolean;
  /** rollback ref per #34 (verified snapshot / revert target) */
  rollbackRef?: string;
  /** /qa-only ledger receipt for the DEPLOYED build (#475, as amended: >98) */
  qaReceipt?: { score: number; ageDays: number; buildMatches: boolean };
  /** when the artifact is expected to PUBLISH (merge + build lead + buffer) */
  expectedPublishTime?: Date;
  openP0Count?: number;
  /** gateway pool_saturated 429s in the last 15 min (#437) */
  poolSaturated429Count15m?: number;
  /** minutes since the last deploy/publish touching the same substrate */
  minutesSinceLastSubstrateDeploy?: number;
  /** who is performing the merge (§8 item 11) */
  mergeActor?: string;
  /** GitHub mergeStateStatus (§8 item 12) */
  mergeStateStatus?: string;
  /**
   * §8 item 13 — which sanctioned interception point invoked the engine.
   * Structural: real coverage is the wiring's job; the engine records +
   * validates set MEMBERSHIP (typed as string because runtime callers are
   * outside TypeScript's union — truthiness alone would be fail-open).
   */
  invokedVia?: string;
}

/** §8 item 13 — the only interception points that may invoke the engine. */
export const SANCTIONED_INVOCATION_POINTS: readonly string[] = [
  "bash-gh-merge-hook",
  "mcp-merge-hook",
  "deploy-command-guard",
];

// ---------------------------------------------------------------------------
// Gate-level denylist (§8) — no arc can allow these. Engine-owned.
// ---------------------------------------------------------------------------

export const GATE_DENYLIST: readonly string[] = [
  ".github/**",
  "**/hooks/**",
  "**/*hook*.py",
  "**/lint-*",
  "**/*branch-protection*",
  "Customization/**",
  "**/pricing/**",
  "**/pricing-*",
];

// ---------------------------------------------------------------------------
// Glob matching (tiny, dependency-free: `**` crosses slashes, `*` does not)
// ---------------------------------------------------------------------------

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` at a boundary also matches zero directories
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (/[.+^${}()|[\]\\?]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function pathMatchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

// ---------------------------------------------------------------------------
// Registry parsers — strict, pure
// ---------------------------------------------------------------------------

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`timetable-gate: ${what} is not a mapping`);
  }
  return v as Record<string, unknown>;
}

function asList(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`timetable-gate: ${what} is not a list`);
  return v;
}

export interface ParsedArcs {
  /** structurally valid, unexpired, quoted entries */
  valid: Arc[];
  /** slug (or index) → why the entry is NO ARC */
  rejected: { ref: string; reason: string }[];
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Kevin's verbatim word must be QUOTED and timestamped: "…word…" — <UTC> */
const REGISTERED_BY = /["“”].+["“”].*—.*\d{4}-\d{2}-\d{2}/s;

/**
 * Parse arcs.yaml text. The FILE must be well-formed (throw otherwise);
 * individual entries that are malformed / expired / unquoted are rejected
 * (NO ARC) with a reason, per the registry's edit contract.
 *
 * `today` = evaluation day (UTC date). An arc whose `expires` is before today
 * is expired; one whose `expires` is more than 14 days out cannot have been
 * registered inside the ≤14-day contract and is rejected too.
 */
export function parseArcs(yamlText: string, today: Date): ParsedArcs {
  const doc = asRecord(parseYaml(yamlText), "arcs.yaml");
  const raw = asList(doc.arcs ?? [], "arcs.yaml `arcs`");
  const valid: Arc[] = [];
  const rejected: { ref: string; reason: string }[] = [];
  const todayMs = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  raw.forEach((entry, i) => {
    const ref = `arcs[${i}]`;
    let rec: Record<string, unknown>;
    try {
      rec = asRecord(entry, ref);
    } catch (e) {
      rejected.push({ ref, reason: String((e as Error).message) });
      return;
    }
    const slug = typeof rec.slug === "string" ? rec.slug : "";
    const label = slug || ref;
    const strFields = [
      "slug",
      "repo",
      "surface",
      "decision_doc",
      "registered_by",
      "expires",
      "lane_manager",
    ] as const;
    for (const f of strFields) {
      if (typeof rec[f] !== "string" || (rec[f] as string).trim() === "") {
        rejected.push({ ref: label, reason: `missing/non-string \`${f}\`` });
        return;
      }
    }
    if (
      !Array.isArray(rec.allowed_paths) ||
      rec.allowed_paths.length === 0 ||
      !rec.allowed_paths.every((p) => typeof p === "string" && p.trim() !== "")
    ) {
      rejected.push({ ref: label, reason: "allowed_paths missing or not a non-empty string list" });
      return;
    }
    if (!REGISTERED_BY.test(rec.registered_by as string)) {
      rejected.push({
        ref: label,
        reason: "registered_by lacks Kevin's QUOTED verbatim word + UTC timestamp",
      });
      return;
    }
    const expires = rec.expires as string;
    if (!ISO_DAY.test(expires)) {
      rejected.push({ ref: label, reason: `expires \`${expires}\` is not YYYY-MM-DD` });
      return;
    }
    const expMs = Date.parse(`${expires}T23:59:59Z`);
    if (Number.isNaN(expMs) || expMs < todayMs) {
      rejected.push({ ref: label, reason: `arc expired ${expires} — renewal = a fresh word` });
      return;
    }
    if (expMs > todayMs + 14 * 86_400_000 + 86_399_000) {
      rejected.push({
        ref: label,
        reason: `expires ${expires} is >14 days out — outside the §4a registration contract`,
      });
      return;
    }
    if (rec.diff_cap !== undefined && rec.diff_cap !== null) {
      if (typeof rec.diff_cap !== "number" || !Number.isInteger(rec.diff_cap) || rec.diff_cap <= 0) {
        rejected.push({ ref: label, reason: "diff_cap must be a positive integer when present" });
        return;
      }
    }
    valid.push({
      slug,
      repo: rec.repo as string,
      surface: rec.surface as string,
      allowed_paths: rec.allowed_paths as string[],
      decision_doc: rec.decision_doc as string,
      registered_by: rec.registered_by as string,
      expires,
      lane_manager: rec.lane_manager as string,
      diff_cap: (rec.diff_cap as number | undefined) ?? undefined,
      single_n_proven:
        typeof rec.single_n_proven === "string" && rec.single_n_proven.trim() !== ""
          ? rec.single_n_proven
          : null,
    });
  });
  return { valid, rejected };
}

/** Parse holds.yaml. ANY parse/shape failure throws — the caller must treat a throw as ALL ARCS HELD (§4b). */
export function parseHolds(yamlText: string): Hold[] {
  const doc = asRecord(parseYaml(yamlText), "holds.yaml");
  const raw = asList(doc.holds ?? [], "holds.yaml `holds`");
  return raw.map((entry, i) => {
    const rec = asRecord(entry, `holds[${i}]`);
    if (typeof rec.slug !== "string" || rec.slug.trim() === "") {
      throw new Error(`timetable-gate: holds[${i}] missing slug`);
    }
    if (typeof rec.held_by !== "string" || rec.held_by.trim() === "") {
      throw new Error(`timetable-gate: holds[${i}] missing held_by`);
    }
    return {
      slug: rec.slug,
      held_by: rec.held_by,
      issue: typeof rec.issue === "string" ? rec.issue : undefined,
    };
  });
}

/** Parse windows.yaml. The file is the ALLOWLIST — an unlisted surface cannot depart. */
export function parseWindows(yamlText: string): WindowEntry[] {
  const doc = asRecord(parseYaml(yamlText), "windows.yaml");
  const raw = asList(doc.windows ?? [], "windows.yaml `windows`");
  return raw.map((entry, i) => {
    const rec = asRecord(entry, `windows[${i}]`);
    if (typeof rec.surface !== "string" || rec.surface.trim() === "") {
      throw new Error(`timetable-gate: windows[${i}] missing surface`);
    }
    if (typeof rec.band !== "string" || rec.band.trim() === "") {
      throw new Error(`timetable-gate: windows[${i}] missing band`);
    }
    const status = rec.status;
    // pg-enum-drift-exempt: YAML registry status vocabulary, not a Postgres enum
    if (status !== "RULED" && status !== "RULED-GATED" && status !== "PROPOSED") {
      throw new Error(
        `timetable-gate: windows[${i}] status must be RULED | RULED-GATED | PROPOSED`,
      );
    }
    return {
      surface: rec.surface,
      repo: typeof rec.repo === "string" ? rec.repo : undefined,
      band: rec.band,
      cadence: typeof rec.cadence === "string" ? rec.cadence : undefined,
      status,
      gate_note: typeof rec.gate_note === "string" ? rec.gate_note : undefined,
      build_lead_min: typeof rec.build_lead_min === "number" ? rec.build_lead_min : undefined,
      coupled_note: typeof rec.coupled_note === "string" ? rec.coupled_note : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Window-band evaluation (recognized grammars only; unrecognized = CLOSED)
// ---------------------------------------------------------------------------

const ET = "America/New_York";

function etParts(d: Date): { dow: string; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // Intl can emit "24" for midnight with hour12:false + 2-digit on some ICU builds
  const hour = Number(get("hour")) % 24;
  return { dow: get("weekday"), minutes: hour * 60 + Number(get("minute")) };
}

export interface WindowVerdict {
  open: boolean;
  reason: string;
}

/**
 * Evaluate a window entry at the EXPECTED PUBLISH TIME (never merge time).
 * Recognized bands:
 *   - "always"
 *   - "on demand"                       (clock-free; the other checks gate)
 *   - "<Dow> HH:MM ET"                  (weekly, `windowMinutes` wide, default 60)
 *   - "outside HH:MM-HH:MM ET weekdays" (weekends open; weekdays outside the span)
 * Everything else — including any band containing BARRED — is CLOSED.
 * PROPOSED = CLOSED (not Kevin-RULED). RULED-GATED = CLOSED while gate_note stands.
 */
export function evaluateWindow(
  entry: WindowEntry,
  publishAt: Date,
  windowMinutes = 60,
): WindowVerdict {
  if (entry.status === "PROPOSED") {
    return { open: false, reason: `window for ${entry.surface} is PROPOSED, not Kevin-RULED` };
  }
  if (entry.status === "RULED-GATED") {
    return {
      open: false,
      reason: `window for ${entry.surface} is RULED-GATED: ${entry.gate_note ?? "gate note missing"}`,
    };
  }
  const band = entry.band.trim();
  if (/BARRED/i.test(band)) {
    return { open: false, reason: `band for ${entry.surface} carries a BAR: ${band}` };
  }
  if (/^always$/i.test(band)) return { open: true, reason: "band: always" };
  if (/^on demand$/i.test(band)) {
    return { open: true, reason: "band: on demand (clock-free; QA/drift checks gate)" };
  }
  const weekly = band.match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\w*\s+(\d{1,2}):(\d{2})\s+ET$/i);
  if (weekly) {
    const wantDow =
      weekly[1].slice(0, 1).toUpperCase() + weekly[1].slice(1, 3).toLowerCase();
    const start = Number(weekly[2]) * 60 + Number(weekly[3]);
    const { dow, minutes } = etParts(publishAt);
    if (dow !== wantDow) {
      return { open: false, reason: `publish lands ${dow}, window is ${wantDow} (${band})` };
    }
    if (minutes < start || minutes >= start + windowMinutes) {
      return {
        open: false,
        reason: `publish lands outside ${band} +${windowMinutes}min (ET minute ${minutes})`,
      };
    }
    return { open: true, reason: `inside ${band} +${windowMinutes}min` };
  }
  const outside = band.match(
    /^outside\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\s+ET\s+weekdays$/i,
  );
  if (outside) {
    const lo = Number(outside[1]) * 60 + Number(outside[2]);
    const hi = Number(outside[3]) * 60 + Number(outside[4]);
    const { dow, minutes } = etParts(publishAt);
    if (dow === "Sat" || dow === "Sun") return { open: true, reason: `weekend (${band})` };
    if (minutes >= lo && minutes < hi) {
      return {
        open: false,
        reason: `publish lands inside ${band.replace(/^outside\s+/i, "")} (ET minute ${minutes})`,
      };
    }
    return { open: true, reason: `outside business span (${band})` };
  }
  return { open: false, reason: `unrecognized band \`${band}\` — fail-closed` };
}

// ---------------------------------------------------------------------------
// The evaluator — §4c checks 1-10 + §8 items 11-13
// ---------------------------------------------------------------------------

export interface Registries {
  arcs: ParsedArcs;
  /** null = holds.yaml failed to parse ⇒ ALL arcs held */
  holds: Hold[] | null;
  windows: WindowEntry[];
}

export function evaluateDeparture(
  registries: Registries,
  facts: DepartureFacts,
): GateResult {
  const checks: CheckResult[] = [];
  const add = (id: string, name: string, verdict: CheckVerdict, reason: string) =>
    checks.push({ id, name, verdict, reason });
  const finish = (arcSlug: string | null): GateResult => {
    const failures = checks.filter((c) => c.verdict === "fail").map((c) => `[${c.id}] ${c.reason}`);
    return {
      verdict: failures.length === 0 && arcSlug !== null ? "DEPART" : "FALL_THROUGH",
      arcSlug,
      checks,
      failures,
    };
  };

  // -- Check 01: changed paths ⊆ exactly one registered arc, denylist clean --
  const denied = facts.changedPaths.filter((p) => pathMatchesAny(p, GATE_DENYLIST));
  if (denied.length > 0) {
    add("01", "paths-in-arc", "fail", `gate DENYLIST paths touched (no arc can allow): ${denied.join(", ")}`);
    return finish(null);
  }
  if (facts.changedPaths.length === 0) {
    add("01", "paths-in-arc", "fail", "empty changed-path set — unresolvable diff (paginate the files probe, #401)");
    return finish(null);
  }
  const candidates = registries.arcs.valid.filter(
    (a) =>
      a.repo === facts.repo &&
      facts.changedPaths.every((p) => pathMatchesAny(p, a.allowed_paths)),
  );
  if (candidates.length === 0) {
    const rej = registries.arcs.rejected.length
      ? ` (rejected entries: ${registries.arcs.rejected.map((r) => `${r.ref}: ${r.reason}`).join("; ")})`
      : "";
    add("01", "paths-in-arc", "fail", `no registered arc covers every changed path for ${facts.repo}${rej}`);
    return finish(null);
  }
  if (candidates.length > 1) {
    add(
      "01",
      "paths-in-arc",
      "fail",
      `ambiguous: ${candidates.length} arcs cover the diff (${candidates.map((a) => a.slug).join(", ")}) — fail-closed`,
    );
    return finish(null);
  }
  const arc = candidates[0];
  add("01", "paths-in-arc", "pass", `all ${facts.changedPaths.length} paths inside arc \`${arc.slug}\``);

  // -- Check 02: arc not held (holds parse failure = all held) --------------
  if (registries.holds === null) {
    add("02", "not-held", "fail", "holds.yaml unparseable — ALL arcs held (§4b fail-closed)");
  } else {
    const hold = registries.holds.find((h) => h.slug === arc.slug);
    if (hold) add("02", "not-held", "fail", `arc \`${arc.slug}\` is HELD: ${hold.held_by}`);
    else add("02", "not-held", "pass", "no hold on this arc");
  }

  // -- Check 03: CI rollup green via JSON buckets (#459) --------------------
  if (!facts.ciChecks || facts.ciChecks.length === 0) {
    add("03", "ci-green", "fail", "no CI check set resolved — unresolvable (empty rollup never counts as green)");
  } else {
    const notPass = facts.ciChecks.filter((c) => c.bucket !== "pass");
    if (notPass.length > 0) {
      add("03", "ci-green", "fail", `non-pass buckets: ${notPass.map((c) => `${c.name}=${c.bucket}`).join(", ")}`);
    } else {
      add("03", "ci-green", "pass", `${facts.ciChecks.length} checks all bucket=pass`);
    }
  }

  // -- Check 04: codex-clean receipt for THIS head sha ----------------------
  if (!facts.headSha) {
    add("04", "codex-clean", "fail", "head sha unresolved");
  } else if (!facts.codexReceipt) {
    add("04", "codex-clean", "fail", "no codex receipt for head sha");
  } else if (facts.codexReceipt.headSha !== facts.headSha) {
    add(
      "04",
      "codex-clean",
      "fail",
      `codex receipt is for ${facts.codexReceipt.headSha.slice(0, 8)}, head is ${facts.headSha.slice(0, 8)} — stale`,
    );
  } else if (!facts.codexReceipt.clean) {
    add("04", "codex-clean", "fail", "codex verdict not clean");
  } else {
    add("04", "codex-clean", "pass", `codex clean @${facts.headSha.slice(0, 8)}`);
  }

  // -- Check 05: pure revert (patch-id) OR single-N proven (#169) -----------
  if (facts.isPureRevert === true) {
    add("05", "revert-or-proven", "pass", "pure revert (patch-id equality, caller-verified)");
  } else if (arc.single_n_proven) {
    add("05", "revert-or-proven", "pass", `single-N proven: ${arc.single_n_proven}`);
  } else {
    add("05", "revert-or-proven", "fail", "neither a pure revert nor single_n_proven on the arc (#169 canary first)");
  }

  // -- Check 06: rollback ref present (#34) ---------------------------------
  if (facts.rollbackRef && facts.rollbackRef.trim() !== "") {
    add("06", "rollback-ref", "pass", `rollback ref: ${facts.rollbackRef}`);
  } else {
    add("06", "rollback-ref", "fail", "no verified rollback ref (#34 — rollback is a paper feature without it)");
  }

  // -- Check 07: /qa-only STRICTLY >98, deployed build, ≤14d (#475 amended) --
  if (!facts.qaReceipt) {
    add("07", "qa-score", "fail", "no /qa-only ledger receipt");
  } else if (!facts.qaReceipt.buildMatches) {
    add("07", "qa-score", "fail", "qa receipt is not for the DEPLOYED build");
  } else if (facts.qaReceipt.ageDays > 14) {
    add("07", "qa-score", "fail", `qa receipt is ${facts.qaReceipt.ageDays}d old (>14d)`);
  } else if (!(facts.qaReceipt.score > 98)) {
    add("07", "qa-score", "fail", `qa score ${facts.qaReceipt.score} — bar is STRICTLY >98 (Kevin 8/30; 98 itself fails)`);
  } else {
    add("07", "qa-score", "pass", `qa ${facts.qaReceipt.score} @${facts.qaReceipt.ageDays}d`);
  }

  // -- Check 08: window open at EXPECTED PUBLISH time -----------------------
  const win = registries.windows.find((w) => w.surface === arc.surface);
  if (!win) {
    add("08", "window-open", "fail", `surface \`${arc.surface}\` not in windows.yaml — unlisted surfaces cannot depart`);
  } else if (!facts.expectedPublishTime) {
    add("08", "window-open", "fail", "expected publish time unresolved (now + build lead + 15min buffer)");
  } else {
    const v = evaluateWindow(win, facts.expectedPublishTime);
    add("08", "window-open", v.open ? "pass" : "fail", v.reason);
  }

  // -- Check 09: no open P0, no load signal, 30-min substrate spacing -------
  const p0 = facts.openP0Count;
  const sat = facts.poolSaturated429Count15m;
  const spacing = facts.minutesSinceLastSubstrateDeploy;
  if (p0 === undefined || sat === undefined || spacing === undefined) {
    add("09", "no-p0-no-load", "fail", "P0 / pool-saturation / spacing probes unresolved");
  } else if (p0 > 0) {
    add("09", "no-p0-no-load", "fail", `${p0} open P0(s)`);
  } else if (sat > 0) {
    add("09", "no-p0-no-load", "fail", `${sat} pool_saturated 429s in last 15min (#437 LOAD signal)`);
  } else if (spacing < 30) {
    add("09", "no-p0-no-load", "fail", `last substrate deploy ${spacing}min ago (<30min spacing)`);
  } else {
    add("09", "no-p0-no-load", "pass", "0 P0s, 0 saturation 429s, spacing ok");
  }

  // -- Check 10: diff ≤ cap (default 300); pure reverts exempt --------------
  const cap = arc.diff_cap ?? 300;
  if (facts.isPureRevert === true) {
    add("10", "diff-cap", "pass", "pure revert — cap exempt");
  } else if (facts.changedLineCount === undefined) {
    add("10", "diff-cap", "fail", "changed line count unresolved");
  } else if (facts.changedLineCount > cap) {
    add("10", "diff-cap", "fail", `${facts.changedLineCount} changed lines > cap ${cap}`);
  } else {
    add("10", "diff-cap", "pass", `${facts.changedLineCount} ≤ ${cap}`);
  }

  // -- Check 11 (§8): merge actor == arc's lane_manager ---------------------
  if (!facts.mergeActor) {
    add("11", "merge-actor", "fail", "merge actor unresolved");
  } else if (facts.mergeActor !== arc.lane_manager) {
    add("11", "merge-actor", "fail", `merge actor \`${facts.mergeActor}\` ≠ arc lane_manager \`${arc.lane_manager}\``);
  } else {
    add("11", "merge-actor", "pass", `actor = ${arc.lane_manager}`);
  }

  // -- Check 12 (§8): mergeStateStatus == CLEAN -----------------------------
  if (facts.mergeStateStatus !== "CLEAN") {
    add("12", "merge-state-clean", "fail", `mergeStateStatus=${facts.mergeStateStatus ?? "unresolved"} (need CLEAN — a CONFLICTING PR has NO merge-ref CI, #433)`);
  } else {
    add("12", "merge-state-clean", "pass", "CLEAN");
  }

  // -- Check 13 (§8): invoked from a sanctioned interception point ----------
  if (!facts.invokedVia) {
    add("13", "gate-coverage", "fail", "caller did not declare its interception point — engine invoked out-of-band");
  } else if (!SANCTIONED_INVOCATION_POINTS.includes(facts.invokedVia)) {
    add(
      "13",
      "gate-coverage",
      "fail",
      `\`${facts.invokedVia}\` is not a sanctioned interception point (${SANCTIONED_INVOCATION_POINTS.join(", ")})`,
    );
  } else {
    add("13", "gate-coverage", "pass", `via ${facts.invokedVia}`);
  }

  return finish(arc.slug);
}

// ---------------------------------------------------------------------------
// Ledger line (jsonl; keyed on MERGE sha by the caller after the merge lands)
// ---------------------------------------------------------------------------

export function formatLedgerLine(
  result: GateResult,
  facts: DepartureFacts,
  now: Date,
  mergeSha?: string,
): string {
  return JSON.stringify({
    ts: now.toISOString(),
    verdict: result.verdict,
    arc: result.arcSlug,
    repo: facts.repo,
    head_sha: facts.headSha ?? null,
    merge_sha: mergeSha ?? null,
    invoked_via: facts.invokedVia ?? null,
    checks: result.checks.map((c) => ({ id: c.id, name: c.name, v: c.verdict })),
    failures: result.failures,
  });
}
