import { describe, expect, it } from "vitest";
import { CALENDAR_ISSUE, CALENDAR_REPO, DEFAULT_TARGET, parseArgs, parseTarget } from "../restart-train-args.js";

describe("parseArgs (restart-train)", () => {
  // ───── Negative controls first (Rule #322) ─────

  it("throws on --fire (rung 3 not built)", () => {
    expect(() => parseArgs(["--fire"])).toThrow(/rung 3 not built/);
  });

  it("throws on an unparsable --now", () => {
    expect(() => parseArgs(["--now", "yesterday-ish"])).toThrow(/not a parsable ISO/);
    expect(() => parseArgs(["--now"])).toThrow(/--now requires/);
  });

  it("throws on a malformed --target", () => {
    expect(() => parseArgs(["--target", "not-a-target"])).toThrow(/org\/repo#n/);
    expect(() => parseArgs(["--target"])).toThrow(/--target requires/);
  });

  it("REFUSES the human calendar issue as a target (codex P2 2026-08-19): the worker reads #280, never writes it", () => {
    expect(() => parseArgs(["--target", `${CALENDAR_REPO}#${CALENDAR_ISSUE}`])).toThrow(/must never be/);
    expect(() => parseArgs(["--target", "studio-b-ai/client-asthetik#280"])).toThrow(/READ-ONLY/);
  });

  // ───── Positive paths ─────

  it("defaults: dry-run true, post false, page false, target = ops-pipeline#172, now = a parsable timestamp", () => {
    const f = parseArgs([]);
    expect(f.dryRun).toBe(true);
    expect(f.post).toBe(false);
    expect(f.page).toBe(false);
    expect(f.target).toBe(DEFAULT_TARGET);
    expect(Number.isNaN(Date.parse(f.now))).toBe(false);
  });

  it("accepts an explicit non-calendar target and --now/--post", () => {
    const f = parseArgs(["--target", "studio-b-ai/ops-pipeline#172", "--now", "2026-08-19T22:00:00Z", "--post"]);
    expect(f.target).toBe("studio-b-ai/ops-pipeline#172");
    expect(f.now).toBe("2026-08-19T22:00:00Z");
    expect(f.post).toBe(true);
    expect(f.page).toBe(false);
  });

  it("--page is independent of --post (rung 1 Leg B, ops-pipeline#172) — either can be set without the other", () => {
    expect(parseArgs(["--page"]).page).toBe(true);
    expect(parseArgs(["--page"]).post).toBe(false);
    expect(parseArgs(["--post"]).page).toBe(false);
    expect(parseArgs(["--page", "--post"])).toMatchObject({ page: true, post: true });
  });

  it("a DIFFERENT client-asthetik issue is not blocked — only the calendar is (guard is exact, not repo-wide)", () => {
    const f = parseArgs(["--target", "studio-b-ai/client-asthetik#281"]);
    expect(f.target).toBe("studio-b-ai/client-asthetik#281");
  });
});

describe("parseTarget", () => {
  it("round-trips org/repo#n", () => {
    expect(parseTarget("studio-b-ai/ops-pipeline#172")).toEqual({ repo: "studio-b-ai/ops-pipeline", number: 172 });
  });
  it("throws on junk", () => {
    expect(() => parseTarget("nope")).toThrow(/unparsable/);
  });
});
