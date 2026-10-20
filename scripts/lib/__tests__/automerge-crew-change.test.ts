/**
 * Door policy (row 928, Kevin 10/20: "I don't want to have to manually box PRs") — the `crew-change`
 * class, through the REAL parse -> reconcile -> classify path (Rule #223: every case builds a real
 * unified diff and runs parseUnifiedDiff / reconcileFileClasses / fileContentsFromParsed /
 * classifyPrDiffClass — never a self-assembled verdict).
 *
 * Both directions (Rule #322): every refusal below has a known-GOOD twin that resolves, so a deny
 * rule that refuses everything cannot pass, and an allow path that admits everything cannot pass.
 *
 * ISOLATION NOTE. A crew PR carries `fleet-internal`, so the fleet-internal candidate (no globs, no
 * cap, path-only denylist) ALWAYS joins behind crew-change, and code-fix joins whenever safe globs are
 * given. So: (a) positive "resolves crew-change" cases run with NO safe globs (code-fix inert;
 * crew-change precedes fleet-internal), (b) a refusal means "does not resolve crew-change" and the deny
 * RULE that fired is asserted by name through crewChangeDenyHits on the same parsed contents, and
 * (c) the discriminating fixture for the globbed path is an additive migration (code-fix's blanket
 * denylist refuses migrations — proven by a control below — so only crew-change can admit it).
 */
import { describe, expect, it } from "vitest";
import {
  ALL_PR_DIFF_CLASSES,
  classifyPrDiffClass,
  crewChangeDenyHits,
  fileContentsFromParsed,
  gateDecisionForClass,
  isCrewPr,
  parseUnifiedDiff,
  reconcileFileClasses,
  TRIPWIRE_WATCHED_CLASSES,
} from "../automerge-classify.js";
import { parseArgs } from "../automerge-args.js";

interface D {
  path: string;
  added?: string[];
  removed?: string[];
  isNew?: boolean;
}

/** One file's real unified diff, in the shape `gh api compare ... Accept: diff` returns. */
function unified(d: D): string {
  const added = d.added ?? ["export const routine = 1;"];
  const removed = d.removed ?? [];
  const head = [`diff --git a/${d.path} b/${d.path}`];
  if (d.isNew) head.push("new file mode 100644", "--- /dev/null", `+++ b/${d.path}`);
  else head.push(`--- a/${d.path}`, `+++ b/${d.path}`);
  return [...head, `@@ -1,${removed.length} +1,${added.length} @@`, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n") + "\n";
}

const CREW = { author: "kbibelhausen", labels: ["fleet-internal"] };
const SAFE = ["src/**", "tests/**", "scripts/**", "docs/**"];

function run(
  ds: D[],
  over: {
    author?: string;
    labels?: string[];
    safe?: string[];
    sensitive?: string[];
    enabled?: boolean;
    extraAuthoritative?: string[];
    totalOverride?: number;
  } = {},
) {
  const parsed = parseUnifiedDiff(ds.map(unified).join(""));
  const authoritative = [...ds.map((d) => d.path), ...(over.extraAuthoritative ?? [])];
  const files = reconcileFileClasses(authoritative, parsed);
  const total = over.totalOverride ?? ds.reduce((n, d) => n + (d.added ?? ["x"]).length + (d.removed ?? []).length, 0);
  return classifyPrDiffClass({
    files,
    totalChangedLines: total,
    additions: total,
    sensitivePathPatterns: over.sensitive,
    safePathGlobs: over.safe,
    labels: over.labels ?? CREW.labels,
    author: over.author ?? CREW.author,
    crewChangeEnabled: over.enabled ?? true,
    fileContents: fileContentsFromParsed(parsed),
  });
}

/** The deny-rule labels the pure rule reports for these exact diffs (path + parsed content). */
function hitsFor(ds: D[]): string {
  const parsed = parseUnifiedDiff(ds.map(unified).join(""));
  const contents = fileContentsFromParsed(parsed);
  return ds.flatMap((d) => crewChangeDenyHits(d.path, contents.get(d.path))).join(" | ");
}

/** Refused by crew-change: it did NOT resolve (some later class may, and the runner's own legs decide that). */
function refused(ds: D[], over: Parameters<typeof run>[1] = {}, rule?: string): void {
  expect(run(ds, over).prClass).not.toBe("crew-change");
  if (rule) expect(hitsFor(ds)).toContain(rule);
}

const NEW_MODULE: D[] = [
  { path: "src/lib/router.ts", isNew: true, added: ["export function route(x: string) {", "  return x.trim();", "}"] },
  { path: "tests/router.test.ts", isNew: true, added: ["import { route } from '../src/lib/router';", "it('routes', () => expect(route(' a ')).toBe('a'));"] },
];

describe("crew-change — known-GOOD: routine crew work resolves", () => {
  it("a NEW module with its tests resolves crew-change (the shape the old small-fix rubric called 'introduces a new module')", () => {
    expect(run(NEW_MODULE)).toEqual({ prClass: "crew-change", failureLeg: null, reasons: [] });
  });

  it("a MODIFIED file (added + removed lines) resolves crew-change", () => {
    const res = run([{ path: "src/lib/router.ts", removed: ["return x;"], added: ["return x.trim();"] }, { path: "tests/router.test.ts", isNew: true }]);
    expect(res.prClass).toBe("crew-change");
  });

  it("with safe_path_globs declared, a clean in-glob PR still resolves (code-fix, which precedes it, takes it first)", () => {
    expect(run(NEW_MODULE, { safe: SAFE }).prClass).toBe("code-fix");
  });

  it("sensitive_path_patterns still beat the class entirely (the existing law, class-match refusal)", () => {
    const res = run(NEW_MODULE, { sensitive: ["^src/lib/"] });
    expect(res.prClass).toBeNull();
    expect(res.failureLeg).toBe("class-match");
  });

  it("exactly at the cap (1500 changed lines) resolves", () => {
    expect(run(NEW_MODULE, { totalOverride: 1500 }).prClass).toBe("crew-change");
  });

  it("is a member of ALL_PR_DIFF_CLASSES and a valid --enabled-classes value (and a typo is still rejected)", () => {
    expect(ALL_PR_DIFF_CLASSES).toContain("crew-change");
    const args = parseArgs(["--repo", "o/r", "--pr", "1", "--enabled-classes", "docs-comment,code-fix,crew-change"]);
    expect(args.enabledClasses).toContain("crew-change");
    expect(() => parseArgs(["--repo", "o/r", "--pr", "1", "--enabled-classes", "crew-chage"])).toThrow(/unknown class/);
  });

  it("the post-merge tripwire watches code-fix AND crew-change (both carry the pre-merge automerge:code-fix label)", () => {
    expect([...TRIPWIRE_WATCHED_CLASSES].sort()).toEqual(["code-fix", "crew-change"]);
  });
});

describe("crew-change — refused: the CI/workflow surface", () => {
  it.each([".github/workflows/deploy.yml", ".github/actions/setup/action.yml", ".github/actions/setup/run.sh", ".github/CODEOWNERS"])(
    "a new module PLUS %s is refused (.github/**), and the same module alone resolves",
    (ghPath) => {
      refused([...NEW_MODULE, { path: ghPath, added: ["x"] }], {}, ".github/**");
      expect(run(NEW_MODULE).prClass).toBe("crew-change");
    },
  );

  it("a workflows-only diff is refused by crew-change and resolves the existing ci-infra class instead (the narrow, longer-proven class is untouched)", () => {
    const res = run([{ path: ".github/workflows/ci.yml", added: ["    timeout-minutes: 20"] }]);
    expect(res.prClass).toBe("ci-infra");
  });
});

describe("crew-change — refused: pricing / price-sync", () => {
  it.each(["src/pricing/resolve.ts", "src/lib/price-sync.ts", "src/worksheet/build.ts", "src/catalog/assign.ts"])(
    "a PATH matching price|pricing|worksheet|catalog (%s) is refused",
    (p) => refused([{ path: p, isNew: true }], {}, "pricing/price-sync"),
  );

  it("pricing CONTENT in an innocently-named file is refused (path alone is not the guard)", () => {
    refused([{ path: "src/lib/helpers.ts", isNew: true, added: ["export const x = body.priceOverride ?? 0;"] }], {}, "pricing/price-sync (content)");
  });

  it("known-GOOD twin: the same file with no pricing vocabulary resolves", () => {
    expect(run([{ path: "src/lib/helpers.ts", isNew: true, added: ["export const x = body.quantity ?? 0;"] }]).prClass).toBe("crew-change");
  });

  it("pricing words in a DOC or a TEST body do not trip the content rule (they change no behaviour)", () => {
    const res = run([
      { path: "docs/notes.md", added: ["we never change the price list here"] },
      { path: "tests/helpers.test.ts", isNew: true, added: ["it('doc', () => expect('price').toBe('price'));"] },
      { path: "src/lib/helpers.ts", isNew: true, added: ["export const ok = true;"] },
    ]);
    expect(res.prClass).toBe("crew-change");
  });
});

describe("crew-change — refused: auth / credentials / secrets / token handling", () => {
  it.each(["src/auth/session.ts", "src/lib/token.ts", "src/lib/secrets.ts", "src/lib/credential-store.ts", "src/middleware/exempt.ts", "src/lib/oauth-client.ts"])(
    "a PATH on the auth surface (%s) is refused",
    (p) => refused([{ path: p, isNew: true }], {}, "auth/credentials/secrets/token"),
  );

  it.each([
    ["an Authorization header", "const h = { Authorization: `Bearer ${t}` };"],
    ["a secret env read", "const k = process.env.STRIPE_SECRET_KEY;"],
    ["a token env read", "const t = process.env.GH_TOKEN;"],
    ["a python env secret read", "key = os.environ['SLACK_BOT_TOKEN']"],
    ["a secret-shaped literal", "const k = 'sk-ant-api03-abcdef';"],
    ["a private key block", "-----BEGIN RSA PRIVATE KEY-----"],
    ["hmac verification", "crypto.createHmac('sha256', s).update(b).digest('hex');"],
  ])("CONTENT: %s in an innocently-named file is refused", (_n, line) => {
    refused([{ path: "src/lib/client.ts", isNew: true, added: [line] }], {}, "auth/credentials/secrets/token (content)");
  });

  it("known-GOOD controls: `author`, `max_tokens` and an unrelated env read are NOT auth", () => {
    expect(run([{ path: "src/lib/author.ts", isNew: true }]).prClass).toBe("crew-change");
    expect(run([{ path: "src/lib/llm.ts", isNew: true, added: ["const body = { max_tokens: 512 };"] }]).prClass).toBe("crew-change");
    expect(run([{ path: "src/lib/cfg.ts", isNew: true, added: ["const r = process.env.REGION;"] }]).prClass).toBe("crew-change");
  });
});

describe("crew-change — refused: hook registration (settings.json)", () => {
  it.each(["settings.json", "config/settings.json", ".claude/settings.local.json"])("%s is refused", (p) => {
    refused([{ path: p, isNew: true, added: ["{}"] }], {}, "hook registration (settings.json)");
  });
  it("a hook FILE (not its registration) resolves — Rule #491: the code rides the door, the registration does not", () => {
    expect(run([{ path: "hook-x.py", isNew: true, added: ["print('x')"] }]).prClass).toBe("crew-change");
  });
});

describe("crew-change — refused: the gate itself (the door never merges its own policy)", () => {
  const GATE = [
    "scripts/pr-automerge-gate.ts",
    "scripts/lib/automerge-classify.ts",
    "scripts/lib/automerge-review-prompt.ts",
    "scripts/lib/label-authority.ts",
    "scripts/restart-train.ts",
    "scripts/lib/restart-train-lib.ts",
    "scripts/squasher-fleet.json",
    // the door's own machinery beyond the named minimum
    "scripts/lib/merge-door.ts",
    "scripts/lib/gate-flag-card.ts",
    "scripts/lib/fleet-sweep-changed.ts",
    "scripts/post-merge-tripwire.ts",
    "scripts/lib/__tests__/automerge-classify.test.ts",
  ];
  it.each(GATE)("%s is refused even with scripts/** as the safe glob (the deny list beats the allowlist)", (p) => {
    refused([{ path: p, added: ["// edit"] }], { safe: ["scripts/**"] }, "gate/door machinery");
  });

  it("known-GOOD twin: an ordinary new script under scripts/** resolves", () => {
    expect(run([{ path: "scripts/lib/new-worker.ts", isNew: true }]).prClass).toBe("crew-change");
  });
});

describe("crew-change — migrations: additive and NEW only", () => {
  const M = "src/db/migrations/0042_add_notes.sql";
  const ADDITIVE = ["ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;", "CREATE INDEX IF NOT EXISTS idx_notes ON orders (notes);"];

  it("DISCRIMINATING CONTROL: code-fix's blanket denylist refuses a new additive migration", () => {
    const res = run([{ path: M, isNew: true, added: ADDITIVE }], { safe: SAFE, enabled: false });
    expect(res.prClass).not.toBe("code-fix");
  });

  it("…while crew-change admits it, through the globbed path (the real widening)", () => {
    expect(run([{ path: M, isNew: true, added: ADDITIVE }], { safe: SAFE }).prClass).toBe("crew-change");
  });

  it.each([
    ["DROP COLUMN", "ALTER TABLE orders DROP COLUMN legacy;"],
    ["ALTER COLUMN", "ALTER TABLE orders ALTER COLUMN qty TYPE bigint;"],
    ["RENAME", "ALTER TABLE orders RENAME COLUMN a TO b;"],
    ["DROP TABLE", "DROP TABLE orders_old;"],
    ["TRUNCATE", "TRUNCATE orders;"],
    ["UPDATE ... SET (a data rewrite)", "UPDATE orders SET qty = 0;"],
    ["ALTER TYPE", "ALTER TYPE status ADD VALUE 'x';"],
  ])("a NEW migration that does %s is refused", (_n, sql) => {
    refused([{ path: M, isNew: true, added: [sql] }], { safe: SAFE }, "migration: drops/alters existing columns");
  });

  it("an EDIT to an existing migration is refused even when the added lines are additive (append-only, Rule #156)", () => {
    refused([{ path: M, isNew: false, added: ["CREATE INDEX IF NOT EXISTS i ON t (c);"] }], { safe: SAFE }, "modifies an existing file");
  });

  it("a migration NOTE in docs/ is not a migration (docs are exempt from the migration leg)", () => {
    expect(run([{ path: "docs/migration-guide.md", added: ["drop the column later"] }]).prClass).toBe("docs-comment");
  });
});

describe("crew-change — refused: dependency manifests, binaries, renames, missing contents", () => {
  it.each(["package.json", "package-lock.json", "src/package.json"])("%s is refused (Rule #289)", (p) => {
    refused([{ path: p, isNew: true, added: ["{}"] }], {}, "package manifest/lockfile");
  });

  it("a rename with no hunks (path authoritative, absent from the diff parse) is refused: uninspectable", () => {
    const res = run(NEW_MODULE, { extraAuthoritative: ["src/lib/moved.ts"] });
    expect(res.prClass).not.toBe("crew-change");
    expect(crewChangeDenyHits("src/lib/moved.ts", undefined).join(" ")).toContain("uninspectable");
  });

  it("a binary file is refused (no reviewable text)", () => {
    const parsed = parseUnifiedDiff("diff --git a/src/logo.png b/src/logo.png\nBinary files /dev/null and b/src/logo.png differ\n");
    const files = reconcileFileClasses(["src/logo.png"], parsed);
    const res = classifyPrDiffClass({
      files, totalChangedLines: 0, labels: ["fleet-internal"], author: "kbibelhausen", crewChangeEnabled: true, fileContents: fileContentsFromParsed(parsed),
    });
    expect(res.prClass).not.toBe("crew-change");
    expect(crewChangeDenyHits("src/logo.png", fileContentsFromParsed(parsed).get("src/logo.png")).join(" ")).toContain("binary file");
  });

  it("no diff contents supplied at all: crew-change cannot inspect and does not resolve (fail-closed)", () => {
    const parsed = parseUnifiedDiff(NEW_MODULE.map(unified).join(""));
    const files = reconcileFileClasses(NEW_MODULE.map((d) => d.path), parsed);
    const res = classifyPrDiffClass({ files, totalChangedLines: 5, labels: ["fleet-internal"], author: "kbibelhausen", crewChangeEnabled: true });
    expect(res.prClass).not.toBe("crew-change");
  });

  it("crewChangeDenyHits is empty for a clean file and names every rule a dirty one trips", () => {
    expect(crewChangeDenyHits("src/lib/ok.ts", { added: ["export const a = 1;"], removed: [] })).toEqual([]);
    expect(crewChangeDenyHits("src/auth/pricing.ts", { added: ["Authorization"], removed: [] }).length).toBeGreaterThanOrEqual(3);
  });

  it("a path literally named __proto__ does not read back Object.prototype as content", () => {
    const contents = fileContentsFromParsed([]);
    expect(contents.get("__proto__")).toBeUndefined();
    expect(crewChangeDenyHits("__proto__", contents.get("__proto__")).join(" ")).toContain("uninspectable");
  });
});

describe("crew-change — outside the declared safe paths, and over the cap", () => {
  const MIGRATION_PLUS_OUTSIDE: D[] = [
    { path: "src/db/migrations/0042_add.sql", isNew: true, added: ["ALTER TABLE t ADD COLUMN c TEXT;"] },
    { path: "infra/terraform.tf", isNew: true },
  ];

  it("a file outside safe_path_globs keeps crew-change from resolving", () => {
    expect(run(MIGRATION_PLUS_OUTSIDE, { safe: SAFE }).prClass).not.toBe("crew-change");
  });

  it("known-GOOD twin: the same PR with the outside file removed resolves", () => {
    expect(run(MIGRATION_PLUS_OUTSIDE.slice(0, 1), { safe: SAFE }).prClass).toBe("crew-change");
  });

  it("1501 changed lines: crew-change does not resolve (cap is additions + deletions, 1500)", () => {
    // a migration so ONLY crew-change could have matched under the globs — the cap is what refuses it
    const m: D[] = [{ path: "src/db/migrations/0042_add.sql", isNew: true, added: ["ALTER TABLE t ADD COLUMN c TEXT;"] }];
    const res = run(m, { safe: SAFE, totalOverride: 1501 });
    expect(res.prClass).not.toBe("crew-change");
    expect(res.reasons.join(" ")).toContain("crew-change: totalChangedLines 1501 > 1500");
    expect(run(m, { safe: SAFE, totalOverride: 1500 }).prClass).toBe("crew-change");
  });
});

describe("crew-change — non-crew PRs never get the class (the bugsquasher lane is byte-identical)", () => {
  // The discriminating fixture: a NEW additive migration. code-fix AND fleet-internal refuse it on their
  // own denylists; ONLY crew-change admits it — so "null" below can only mean crew-change did not join.
  const MIGRATION: D[] = [{ path: "src/db/migrations/0042_add_notes.sql", isNew: true, added: ["ALTER TABLE t ADD COLUMN notes TEXT;"] }];

  it("known-GOOD control: the crew PR resolves crew-change", () => {
    expect(run(MIGRATION, { safe: SAFE }).prClass).toBe("crew-change");
  });
  it("a PR by someone else, even carrying fleet-internal, never resolves crew-change and carries no crew-change reason", () => {
    const res = run(MIGRATION, { safe: SAFE, author: "somebody-else" });
    expect(res.prClass).toBeNull();
    expect(res.reasons.join(" ")).not.toContain("crew-change");
  });
  it("a bugsquasher-only PR by the owner identity (no fleet-internal label) never resolves crew-change", () => {
    const res = run(MIGRATION, { safe: SAFE, labels: ["bugsquasher"] });
    expect(res.prClass).toBeNull();
    expect(res.reasons.join(" ")).not.toContain("crew-change");
  });
  it("a caller that has not opted in (crew-change absent from its enabled classes) never sees the class", () => {
    const res = run(MIGRATION, { safe: SAFE, enabled: false });
    expect(res.prClass).toBeNull();
    expect(res.reasons.join(" ")).not.toContain("crew-change");
  });
  it("a caller that passes no author never sees the class (older callers byte-identical)", () => {
    const parsed = parseUnifiedDiff(MIGRATION.map(unified).join(""));
    const res = classifyPrDiffClass({
      files: reconcileFileClasses(MIGRATION.map((d) => d.path), parsed), totalChangedLines: 1, safePathGlobs: SAFE, labels: ["fleet-internal"], crewChangeEnabled: true, fileContents: fileContentsFromParsed(parsed),
    });
    expect(res.prClass).toBeNull();
  });
  it("isCrewPr: exactly author kbibelhausen AND the fleet-internal label", () => {
    expect(isCrewPr("kbibelhausen", ["fleet-internal"])).toBe(true);
    expect(isCrewPr("kbibelhausen", ["bugsquasher"])).toBe(false);
    expect(isCrewPr("someone", ["fleet-internal"])).toBe(false);
    expect(isCrewPr("kbibelhausen", [])).toBe(false);
  });
});

describe("crew-change — precedence", () => {
  it("code-fix still wins for a crew PR that fits code-fix (every narrower class keeps first refusal)", () => {
    expect(run([{ path: "src/lib/router.ts", isNew: true }], { safe: SAFE }).prClass).toBe("code-fix");
  });
  it("crew-change wins over the fleet-internal fallback when both fit (it is the one that writes the tripwire label)", () => {
    expect(run(NEW_MODULE).prClass).toBe("crew-change");
  });
  it("over crew-change's cap the fleet-internal fallback still resolves exactly as before (no regression for the chassis repos)", () => {
    // 1600 > 1500 refuses crew-change; fleet-internal carries no cap and still takes the PR
    expect(run(NEW_MODULE, { totalOverride: 1600 }).prClass).toBe("fleet-internal");
  });
});

describe("gateDecisionForClass — crew-change label legs (same lane law as fleet-internal)", () => {
  const input = (over: Partial<Parameters<typeof gateDecisionForClass>[0]> = {}) => ({
    prClass: "crew-change" as const,
    author: "kbibelhausen",
    labels: ["fleet-internal"],
    ciClean: true,
    reviewVerdict: "CLEAN" as const,
    ...over,
  });

  it("known-GOOD: merges with every leg green", () => {
    expect(gateDecisionForClass(input()).decision).toBe("merge");
  });
  it("waits when needs-human is present (a human was asked; only box opens it)", () => {
    const res = gateDecisionForClass(input({ labels: ["fleet-internal", "needs-human"] }));
    expect(res.decision).toBe("wait");
    expect(res.reasons.join(" ")).toContain("'needs-human' is present");
  });
  it("waits when hold is present", () => {
    expect(gateDecisionForClass(input({ labels: ["fleet-internal", "hold"] })).decision).toBe("wait");
  });
  it("waits when the fleet-internal label is missing (bugsquasher alone is not the crew lane)", () => {
    const res = gateDecisionForClass(input({ labels: ["bugsquasher"] }));
    expect(res.decision).toBe("wait");
    expect(res.reasons.join(" ")).toContain("requires the 'fleet-internal' label");
  });
  it("waits for a non-owner author", () => {
    expect(gateDecisionForClass(input({ author: "somebody" })).decision).toBe("wait");
  });
  it("waits on a FLAG review verdict and on a red CI", () => {
    expect(gateDecisionForClass(input({ reviewVerdict: "FLAG" })).decision).toBe("wait");
    expect(gateDecisionForClass(input({ ciClean: false })).decision).toBe("wait");
  });
  it("scoping control: needs-human still does NOT block code-fix (the bugsquasher lane's blue-card flow is untouched)", () => {
    expect(gateDecisionForClass({ prClass: "code-fix", author: "kbibelhausen", labels: ["bugsquasher", "needs-human"], ciClean: true, reviewVerdict: "CLEAN" }).decision).toBe("merge");
  });
});

describe("parseUnifiedDiff — isNew (the migration leg's 'provably new' fact)", () => {
  it("a `new file mode` header sets isNew; a modification does not", () => {
    const parsed = parseUnifiedDiff(unified({ path: "a.ts", isNew: true }) + unified({ path: "b.ts" }));
    expect(parsed.find((f) => f.path === "a.ts")?.isNew).toBe(true);
    expect(parsed.find((f) => f.path === "b.ts")?.isNew).toBeUndefined();
  });
  it("a `new file mode` text INSIDE a hunk does not flip a modified file to new (header-zone only)", () => {
    const parsed = parseUnifiedDiff(unified({ path: "c.ts", added: ["new file mode 100644"] }));
    expect(parsed[0].isNew).toBeUndefined();
  });
});
