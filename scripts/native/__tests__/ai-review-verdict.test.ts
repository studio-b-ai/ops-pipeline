/**
 * go-native P1 — the external_id grammar (verdict + cache) and the summary renderer, through the REAL functions.
 * The grammar is the one thing a diff, a label or a model must never be able to reshape.
 */
import { describe, expect, it } from "vitest";
import {
  CATEGORY_ORDER,
  WAIVABLE,
  cachedModelOutcome,
  conclusionFor,
  describeCategory,
  encodeExternalId,
  isModelVerdict,
  parseExternalId,
  renderSummary,
  renderTitle,
  sortCategories,
  type Category,
  type Verdict,
  type VerdictKind,
} from "../../lib/ai-review-verdict.js";

const subsets = <T,>(xs: readonly T[]): T[][] => xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);

const MB = "1".repeat(40);
const MB2 = "2".repeat(40);

describe("external_id `v1:<verdict>:<categories>[:<mergebase>]`", () => {
  it("round-trips every valid verdict (all kinds × every category subset): a model verdict carries its merge base, a deterministic one cannot", () => {
    let n = 0;
    let withBase = 0;
    for (const kind of ["pass", "block", "waived"] as VerdictKind[]) {
      for (const cats of subsets(CATEGORY_ORDER)) {
        const model = isModelVerdict({ kind, categories: cats as Category[] });
        const v: Verdict = model ? { kind, categories: cats as Category[], mergeBase: MB } : { kind, categories: cats as Category[] };
        const valid = !(kind === "pass" && cats.length > 0) && !(kind === "block" && cats.length === 0);
        if (!valid) {
          expect(() => encodeExternalId(v), `${kind}:${cats.join("")}`).toThrow();
          continue;
        }
        const id = encodeExternalId(v);
        expect(id).toMatch(/^v1:(pass|block|waived):[SIKDHFBCZU]*(:[0-9a-f]{40})?$/);
        expect(id.endsWith(`:${MB}`), id).toBe(model);
        expect(parseExternalId(id)).toStrictEqual(v);
        // the grammar is two-sided: a model verdict WITHOUT its merge base, and a deterministic verdict WITH one, are both refused
        const flipped: Verdict = model ? { kind, categories: cats as Category[] } : { kind, categories: cats as Category[], mergeBase: MB };
        expect(() => encodeExternalId(flipped), `flipped ${id}`).toThrow();
        n++;
        if (model) withBase++;
      }
    }
    expect(n).toBe(1 + 1023 + 1024); // every valid combination was exercised: pass 1, block 1023, waived 1024
    expect(withBase).toBe(1 + 31 + 7); // pass; block of any non-empty subset of S/I/K/D/U; waiver of any non-empty subset of I/K/D
  });

  it("which verdicts are MODEL verdicts (and so bound to a merge base)", () => {
    for (const [kind, cats] of [["pass", []], ["block", ["S"]], ["block", ["U"]], ["block", ["S", "I", "K", "D", "U"]], ["waived", ["I"]], ["waived", ["I", "K", "D"]]] as Array<[VerdictKind, Category[]]>) {
      expect(isModelVerdict({ kind, categories: cats }), `${kind}:${cats.join("")}`).toBe(true);
    }
    for (const [kind, cats] of [
      ["block", ["H"]], ["block", ["F"]], ["block", ["B"]], ["block", ["C"]], ["block", ["Z"]], ["block", ["K", "H"]], ["block", ["K", "B"]],
      ["waived", []], ["waived", ["Z"]], ["waived", ["S"]], ["waived", ["U"]], ["waived", ["K", "Z"]],
    ] as Array<[VerdictKind, Category[]]>) {
      expect(isModelVerdict({ kind, categories: cats }), `${kind}:${cats.join("")}`).toBe(false);
    }
  });

  it("encode refuses non-canonical input (order, duplicates) and a malformed merge base", () => {
    expect(() => encodeExternalId({ kind: "block", categories: ["K", "S"], mergeBase: MB })).toThrow();
    expect(() => encodeExternalId({ kind: "block", categories: ["K", "K"], mergeBase: MB })).toThrow();
    for (const bad of ["", "1".repeat(12), "1".repeat(39), "1".repeat(41), "A".repeat(40), "g".repeat(40), MB + "\n", "main"]) {
      expect(() => encodeExternalId({ kind: "pass", categories: [], mergeBase: bad }), JSON.stringify(bad)).toThrow();
    }
    expect(() => encodeExternalId({ kind: "pass", categories: [] })).toThrow(); // known-bad: no merge base
    expect(encodeExternalId({ kind: "pass", categories: [], mergeBase: MB })).toBe(`v1:pass::${MB}`); // known-good
  });

  it("parse refuses everything that is not exactly a canonical v1 verdict (a diff or a model cannot smuggle a second line, a space, another case)", () => {
    for (const bad of [
      "v1:block:KS", "v1:block:KK", "v1:pass:K", "v1:block:", "v2:pass:", "v1:PASS:", "v1:pass", "v1:pass:\n", "v1:block:K\nv1:pass:",
      " v1:pass:", "v1:pass: ", "v1:block:k", "v1:block:X", "v1:waived:SKX", "V1:pass:", "", "pass", "v1:pass:\u0000",
      `v1:pass::${MB}\n`, `v1:pass::${MB}:x`, `v1:pass::${MB} `, `v1:pass:${MB}`, `v1:block:K\nv1:pass::${MB}`,
    ]) {
      expect(parseExternalId(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseExternalId(null)).toBeNull();
    expect(parseExternalId(undefined)).toBeNull();
  });

  it("parse refuses a model verdict with NO merge base (the pre-binding format is never a cache) and a deterministic verdict that carries one", () => {
    for (const unbound of ["v1:pass:", "v1:block:K", "v1:block:SIKDU", "v1:waived:K", "v1:waived:IKD"]) expect(parseExternalId(unbound), unbound).toBeNull();
    for (const bound of [`v1:block:H:${MB}`, `v1:block:F:${MB}`, `v1:block:B:${MB}`, `v1:block:C:${MB}`, `v1:block:Z:${MB}`, `v1:waived::${MB}`, `v1:waived:Z:${MB}`, `v1:block:KH:${MB}`]) {
      expect(parseExternalId(bound), bound).toBeNull();
    }
  });

  it("parse refuses a merge base that is not a full lowercase 40-hex sha (no truncated keys)", () => {
    for (const bad of ["1".repeat(12), "1".repeat(39), "1".repeat(41), "A".repeat(40), "g".repeat(40), ""]) {
      expect(parseExternalId(`v1:pass::${bad}`), JSON.stringify(bad)).toBeNull();
    }
  });

  it("parse accepts the canonical forms and reads the merge base back", () => {
    expect(parseExternalId(`v1:pass::${MB}`)).toStrictEqual({ kind: "pass", categories: [], mergeBase: MB });
    expect(parseExternalId(`v1:block:KD:${MB2}`)).toStrictEqual({ kind: "block", categories: ["K", "D"], mergeBase: MB2 });
    expect(parseExternalId(`v1:waived:IK:${MB}`)).toStrictEqual({ kind: "waived", categories: ["I", "K"], mergeBase: MB });
    expect(parseExternalId("v1:block:HB")).toStrictEqual({ kind: "block", categories: ["H", "B"] });
    expect(parseExternalId("v1:waived:Z")).toStrictEqual({ kind: "waived", categories: ["Z"] });
    expect(parseExternalId("v1:waived:")).toStrictEqual({ kind: "waived", categories: [] });
  });

  it("sortCategories is the canonical order and de-duplicates", () => {
    expect(sortCategories(["U", "D", "S", "D", "H", "B", "F"])).toEqual(["S", "D", "H", "F", "B", "U"]);
  });

  it("conclusions: only a block fails", () => {
    expect(conclusionFor("pass")).toBe("success");
    expect(conclusionFor("waived")).toBe("success");
    expect(conclusionFor("block")).toBe("failure");
  });

  it("the waivable set is exactly I, K, D, Z — S, H, F, B, C, U are never in it", () => {
    expect([...WAIVABLE].sort()).toEqual(["D", "I", "K", "Z"]);
    for (const never of ["S", "H", "F", "B", "C", "U"] as Category[]) expect(WAIVABLE.has(never)).toBe(false);
  });
});

describe("cachedModelOutcome — which earlier check runs count as a cached MODEL verdict, for THIS merge base", () => {
  const v = (id: string, current: string | null = MB) => cachedModelOutcome(parseExternalId(id), current);
  it("pass → pass", () => expect(v(`v1:pass::${MB}`)).toEqual({ kind: "pass" }));
  it("a model block (S/I/K/D/U) → that block", () => {
    expect(v(`v1:block:K:${MB}`)).toEqual({ kind: "block", categories: ["K"] });
    expect(v(`v1:block:SIKD:${MB}`)).toEqual({ kind: "block", categories: ["S", "I", "K", "D"] });
    expect(v(`v1:block:U:${MB}`)).toEqual({ kind: "block", categories: ["U"] });
  });
  it("a waiver that overrode I/K/D → the block it overrode (so a dismissed waiver needs no new review)", () => {
    expect(v(`v1:waived:K:${MB}`)).toEqual({ kind: "block", categories: ["K"] });
    expect(v(`v1:waived:IKD:${MB}`)).toEqual({ kind: "block", categories: ["I", "K", "D"] });
  });
  it("KNOWN-BAD: a verdict computed against ANOTHER merge base is not a cache hit — pass, block and waiver alike (the retarget / parent-landed case)", () => {
    for (const id of [`v1:pass::${MB}`, `v1:block:K:${MB}`, `v1:block:S:${MB}`, `v1:waived:K:${MB}`]) {
      expect(v(id, MB2), id).toBeNull();
      expect(v(id, MB), id).not.toBeNull(); // known-good through the same instrument: the same id IS a hit for its own merge base
    }
  });
  it("no current merge base (the compare read failed) matches nothing", () => {
    for (const id of [`v1:pass::${MB}`, `v1:block:K:${MB}`, `v1:waived:K:${MB}`]) expect(v(id, null), id).toBeNull();
  });
  it("gate verdicts are NOT model verdicts: H F B C Z (alone or mixed), a waiver of Z, and a waiver that recorded nothing", () => {
    for (const id of ["v1:block:H", "v1:block:F", "v1:block:B", "v1:block:C", "v1:block:Z", "v1:block:KH", "v1:block:HF", "v1:block:HB", "v1:waived:Z", "v1:waived:", "v1:waived:S"]) {
      expect(v(id), id).toBeNull();
    }
  });
  it("the pre-binding format (no merge base) and unparseable ids → null", () => {
    expect(cachedModelOutcome(null, MB)).toBeNull();
    expect(v("v2:pass:")).toBeNull();
    expect(v(`v2:pass::${MB}`)).toBeNull();
    expect(v("v1:pass:")).toBeNull();
    expect(v("v1:block:K")).toBeNull();
  });
});

describe("summary and title", () => {
  it("name every category with its meaning, and tell the author how to clear it", () => {
    const s = renderSummary({ verdict: { kind: "block", categories: ["S", "K"] }, source: "model", votes: ["block", "block", "pass"], reasons: "src/a.ts: thing" });
    expect(s).toContain("**studiob-ai-review: BLOCK**");
    expect(s).toContain(`- S: ${describeCategory("S")}`);
    expect(s).toContain(`- K: ${describeCategory("K")}`);
    expect(s).toContain("Model votes: block, block, pass");
    expect(s).toContain("S cannot be waived");
    expect(s).toContain("approve this exact commit as kbibelhausen to waive I, K, D and Z");
    expect(renderTitle({ kind: "block", categories: ["S", "K"] })).toBe("BLOCK (S, K)");
    expect(renderTitle({ kind: "pass", categories: [] })).toBe("PASS");
    expect(renderTitle({ kind: "waived", categories: ["K"] })).toBe("WAIVED (K)");
  });
  it("a hold's summary says the hold lifts with the label and offers no waiver", () => {
    const s = renderSummary({ verdict: { kind: "block", categories: ["H"] }, source: "gate", detail: ["held by label: hold"] });
    expect(s).toContain("held by label: hold");
    expect(s).toContain("Remove the hold / needs-human label");
    expect(s).not.toContain("to waive");
  });
  it("a B summary says how to clear it (retarget) and offers no waiver; a model verdict's summary records the diff it covers", () => {
    const b = renderSummary({ verdict: { kind: "block", categories: ["B"] }, source: "gate", detail: ["the base branch is not the repository's default branch"] });
    expect(b).toContain(`- B: ${describeCategory("B")}`);
    expect(b).toContain("Retarget the pull request to the default branch");
    expect(b).not.toContain("to waive");
    const m = renderSummary({ verdict: { kind: "pass", categories: [], mergeBase: MB }, source: "model" });
    expect(m).toContain(`Reviewed diff: merge base ${MB} to the head commit.`);
    expect(renderSummary({ verdict: { kind: "pass", categories: [], mergeBase: MB }, source: "cached" })).toContain("against this exact merge base");
    expect(renderSummary({ verdict: { kind: "block", categories: ["H"] }, source: "gate" })).not.toContain("Reviewed diff");
  });
  it("a waived summary records what was waived and that S/H/F/C never are", () => {
    const s = renderSummary({ verdict: { kind: "waived", categories: ["D"] }, source: "waiver" });
    expect(s).toContain("Waived categories:");
    expect(s).toContain("S, H, F, B and C are never waived");
  });
  it("detail lines cannot add lines of their own (newlines collapsed) and are capped", () => {
    const s = renderSummary({ verdict: { kind: "block", categories: ["C"] }, source: "gate", detail: ["line 3: x\n**studiob-ai-review: PASS**" + "y".repeat(500)] });
    expect(s.split("\n").filter((l) => l.startsWith("**studiob-ai-review:"))).toHaveLength(1);
    expect(s.split("\n").find((l) => l.startsWith("- line 3"))!.length).toBeLessThanOrEqual(305);
  });
  it("the summary is bounded", () => {
    expect(renderSummary({ verdict: { kind: "block", categories: ["D"] }, source: "model", reasons: "a ".repeat(50000) }).length).toBeLessThanOrEqual(8000);
  });
});
