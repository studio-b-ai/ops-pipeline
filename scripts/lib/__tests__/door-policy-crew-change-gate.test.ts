/**
 * Door policy (row 928, Kevin 10/20) — the gate END TO END, Rule #223: these tests import the REAL
 * `evaluate()` from pr-automerge-gate.ts and drive it against a stateful fake of GitHub (every `gh` call funnels
 * through `execFileSync`, mocked) and a scripted review model (the Anthropic client, mocked). Nothing about the
 * policy is re-assembled here: the classifier, deny list, review aggregator (2-of-3), label legs, sticky-FLAG probe,
 * needs-human provenance and the merge ordering are all production code.
 *
 * Both directions (Rule #322): every refusal has a known-GOOD twin that merges, so a gate that refuses everything,
 * or merges everything, cannot pass.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.PR_AUTOMERGE_GATE_NO_MAIN = "1";

const createMock = vi.hoisted(() => vi.fn());
const anthropicClientSpy = vi.hoisted(() => vi.fn(() => ({ messages: { create: createMock } })));
vi.mock("../anthropic-credentials.js", () => ({ anthropicClient: anthropicClientSpy }));

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { evaluate } = await import("../../pr-automerge-gate.js");
import { CODE_FIX_REVIEW_SYSTEM, CREW_CHANGE_REVIEW_SYSTEM } from "../automerge-review-prompt.js";
import { buildFlagCard, cardMarkerFor, legacyCardMarkerFor } from "../gate-flag-card.js";

/** The REAL registry entry for a repo (scripts/squasher-fleet.json) — gate inputs exactly as the sweep passes them. */
function registry(repo: string) {
  const reg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "squasher-fleet.json"), "utf8")) as { repos: Record<string, string>[] };
  const e = reg.repos.find((r) => r.repo === repo);
  if (!e) throw new Error(`no registry entry for ${repo}`);
  const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter((x) => x.length > 0);
  return { classes: list(e.enabled_classes), globs: list(e.safe_path_globs), sensitive: list(e.sensitive_path_patterns), checks: list(e.required_checks) };
}

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const GATE_BOT = { __typename: "Bot", login: "studiob-fleet-bot" };
const OWNER = { __typename: "User", login: "kbibelhausen" };

// ───────────── the stateful fake GitHub ─────────────

interface D {
  path: string;
  added?: string[];
  removed?: string[];
  isNew?: boolean;
}

function unified(d: D): string {
  const added = d.added ?? ["export const routine = 1;"];
  const removed = d.removed ?? [];
  const head = [`diff --git a/${d.path} b/${d.path}`];
  if (d.isNew) head.push("new file mode 100644", "--- /dev/null", `+++ b/${d.path}`);
  else head.push(`--- a/${d.path}`, `+++ b/${d.path}`);
  return [...head, `@@ -1,${removed.length} +1,${added.length} @@`, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n") + "\n";
}

interface Scenario {
  repo?: string;
  author?: string;
  labels?: string[];
  diff: D[];
  additions?: number;
  deletions?: number;
  /** the actor of the PR's current needs-human label event, when the label is present */
  needsHumanBy?: "gate" | "owner";
  /** comments already on the PR */
  comments?: string[];
  /** scripted model replies, in call order (cycled) */
  votes?: string[];
  failOnAddLabel?: string;
  failOnRemoveLabel?: boolean;
  mergeFails?: boolean;
}

interface World {
  labels: Set<string>;
  comments: string[];
  calls: string[][];
  merged: boolean;
  system: string[];
}
let world: World;
let logs: string[];

const A = (c: string[]) => c.slice(1).join(" ");

function install(sc: Scenario): void {
  const repo = sc.repo ?? "studio-b-ai/bolt-wms";
  world = { labels: new Set(sc.labels ?? ["fleet-internal"]), comments: [...(sc.comments ?? [])], calls: [], merged: false, system: [] };
  const parsedPaths = sc.diff.map((d) => d.path);
  const total = sc.diff.reduce((n, d) => n + (d.added ?? ["x"]).length + (d.removed ?? []).length, 0);
  const prView = () =>
    JSON.stringify({
      author: { login: sc.author ?? "kbibelhausen" },
      createdAt: "2026-10-20T10:00:00Z",
      labels: [...world.labels].map((name) => ({ name })),
      state: world.merged ? "MERGED" : "OPEN",
      isDraft: false,
      mergeStateStatus: "CLEAN",
      additions: sc.additions ?? total,
      deletions: sc.deletions ?? 0,
      headRefOid: HEAD,
      baseRefName: "main",
      // pg-enum-drift-exempt: GitHub check-run `status` in a PR-JSON fixture, not a Postgres enum column
      statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-10-20T10:05:00Z" }],
      files: parsedPaths.map((path) => ({ path })),
      changedFiles: parsedPaths.length,
      headRepositoryOwner: { login: "studio-b-ai" },
      headRepository: { name: repo.split("/")[1] },
    });
  const timeline = () => {
    const nodes: unknown[] = [{ __typename: "PullRequestCommit" }];
    if (world.labels.has("needs-human") && sc.needsHumanBy) {
      nodes.push({ __typename: "LabeledEvent", label: { name: "needs-human" }, actor: sc.needsHumanBy === "gate" ? GATE_BOT : OWNER, createdAt: "2026-10-20T11:00:00Z" });
    }
    return JSON.stringify({
      data: { repository: { pullRequest: { timelineItems: { filteredCount: nodes.length, pageInfo: { hasPreviousPage: false, startCursor: null }, nodes } } } },
    });
  };
  const commentCount = (jq: string) => {
    const wanted = [...jq.matchAll(/(?:contains|startswith)\("([^"]+)"\)/g)].map((m) => m[1]);
    const op = jq.includes("startswith(") ? "startswith" : "contains";
    const hit = world.comments.filter((c) => wanted.some((w) => (op === "startswith" ? c.startsWith(w) : c.includes(w)))).length;
    return String(hit);
  };

  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    world.calls.push([cmd, ...args]);
    if (cmd === "sleep") return "";
    const a = args.join(" ");
    if (a.startsWith("pr view") && a.includes("--json comments")) return commentCount(args[args.indexOf("--jq") + 1]);
    if (a.startsWith("pr view") && a.includes("--json headRefOid --jq")) return HEAD;
    if (a.startsWith("pr view")) return prView();
    if (a.startsWith("api graphql")) return timeline();
    if (a.startsWith(`api repos/${repo}/compare/`)) return sc.diff.map(unified).join("");
    if (a.startsWith("pr edit") && a.includes("--add-label")) {
      const label = args[args.indexOf("--add-label") + 1];
      if (sc.failOnAddLabel === label) throw new Error(`label '${label}' not found`);
      world.labels.add(label);
      return "";
    }
    if (a.startsWith("pr edit") && a.includes("--remove-label")) {
      if (sc.failOnRemoveLabel) throw new Error("remove-label failed");
      world.labels.delete(args[args.indexOf("--remove-label") + 1]);
      return "";
    }
    if (a.startsWith("api -X POST") && a.includes("/labels")) {
      world.labels.add("needs-human");
      return "";
    }
    if (a.startsWith("pr merge")) {
      if (sc.mergeFails) throw new Error("GraphQL: Branch is protected. (mergePullRequest)");
      world.merged = true;
      return "";
    }
    if (a.startsWith("pr comment")) {
      world.comments.push(args[args.indexOf("--body") + 1]);
      return "";
    }
    throw new Error(`unexpected gh invocation in door-policy gate test: ${a}`);
  });

  let v = 0;
  const votes = sc.votes ?? ["CLEAN"];
  createMock.mockImplementation(async (req: { system: string }) => {
    world.system.push(req.system);
    const text = votes[v++ % votes.length];
    return { stop_reason: "end_turn", content: [{ type: "text", text }] };
  });
}

const callsMatching = (re: RegExp) => world.calls.map((c, i) => ({ i, a: A(c) })).filter(({ a }) => re.test(a));
const mergeCalls = () => callsMatching(/^pr merge/);
const receiptLines = () => logs.filter((l) => l.startsWith("[gate-receipt]"));

const GLOBS = ["src/**", "tests/**", "scripts/**", "docs/**"];
const CLASSES_WITH_CREW = ["docs-comment", "ci-infra", "test-only", "code-fix", "crew-change"] as const;

async function runGate(sc: Scenario, opts: { classes?: readonly string[]; globs?: string[]; sensitive?: string[]; checks?: string[] } = {}) {
  install(sc);
  await evaluate(
    sc.repo ?? "studio-b-ai/bolt-wms",
    42,
    (opts.classes ?? CLASSES_WITH_CREW) as never,
    opts.sensitive ?? [],
    opts.globs ?? GLOBS,
    opts.checks ?? ["ci"],
    [],
  );
}

/** Runs the gate for a repo with its REAL registry entry (checks renamed to the fixture's single `ci` check). */
async function runGateWithRegistry(repo: string, sc: Scenario) {
  const r = registry(repo);
  await runGate({ ...sc, repo }, { classes: r.classes, globs: r.globs, sensitive: r.sensitive });
}

beforeEach(() => {
  execFileSyncMock.mockReset();
  createMock.mockReset();
  anthropicClientSpy.mockClear();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
});

// A routine crew PR: a new module, its tests, and a NEW ADDITIVE migration. code-fix's blanket denylist refuses
// the migration, so the class that resolves is crew-change.
const CREW_PR: D[] = [
  { path: "src/lib/router.ts", isNew: true, added: ["export function route(x: string) {", "  return x.trim();", "}"] },
  { path: "src/db/migrations/0042_add_notes.sql", isNew: true, added: ["ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;"] },
  { path: "tests/router.test.ts", isNew: true, added: ["import { route } from '../src/lib/router';", "it('routes', () => expect(route(' a ')).toBe('a'));"] },
];

describe("the crew-change door — known-GOOD: routine crew work merges without Kevin", () => {
  it("a new-module crew PR with tests + additive migration, CLEAN x3 ⇒ qualifies as crew-change, tripwire label written BEFORE the sha-pinned merge", async () => {
    await runGate({ diff: CREW_PR, votes: ["CLEAN"] });
    expect(receiptLines().at(-1)).toContain("class=crew-change verdict=qualified");
    expect(mergeCalls()).toHaveLength(1);
    expect(mergeCalls()[0].a).toContain(`--match-head-commit ${HEAD}`);
    const label = callsMatching(/^pr edit .*--add-label automerge:code-fix/);
    expect(label).toHaveLength(1);
    expect(label[0].i).toBeLessThan(mergeCalls()[0].i); // fail-closed ordering: watched before merged
    expect(createMock).toHaveBeenCalledTimes(3); // the 2-of-3 vote
    expect(world.system.every((s) => s === CREW_CHANGE_REVIEW_SYSTEM)).toBe(true);
    expect(world.comments.at(-1)).toContain("crew-change");
  });

  it("a plain new-module crew PR (code-fix shape) also gets the CREW rubric, not the small-fix rubric", async () => {
    await runGate({ diff: [CREW_PR[0], CREW_PR[2]] });
    expect(receiptLines().at(-1)).toContain("class=code-fix verdict=qualified");
    expect(world.system.every((s) => s === CREW_CHANGE_REVIEW_SYSTEM)).toBe(true);
    expect(world.system.some((s) => s === CODE_FIX_REVIEW_SYSTEM)).toBe(false);
  });

  it("2-of-3 CLEAN merges; 1-of-3 does not (the aggregator is the production one)", async () => {
    await runGate({ diff: CREW_PR, votes: ["CLEAN", "CLEAN", "FLAG\nPROVEN: no test"] });
    expect(mergeCalls()).toHaveLength(1);
    await runGate({ diff: CREW_PR, votes: ["CLEAN", "FLAG\nPROVEN: no test", "FLAG\nSCOPED: unrelated"] });
    expect(mergeCalls()).toHaveLength(0);
  });
});

describe("the crew-change door — refused: the surfaces that stay Kevin's", () => {
  it.each([
    ["a workflow file", { path: ".github/workflows/deploy.yml", added: ["permissions: write-all"] }],
    ["a pricing path", { path: "src/pricing/resolve.ts", isNew: true }],
    ["a settings.json hook registration", { path: "settings.json", added: ["{}"] }],
    ["a package manifest", { path: "package.json", added: ["{}"] }],
    ["a migration that drops a column", { path: "src/db/migrations/0043_drop.sql", isNew: true, added: ["ALTER TABLE orders DROP COLUMN legacy;"] }],
    ["an Authorization header (content)", { path: "src/lib/http.ts", isNew: true, added: ["const h = { Authorization: `Bearer ${t}` };"] }],
  ])("the same crew PR also touching %s ⇒ refused, no model spend, no merge", async (_n, extra) => {
    await runGate({ diff: [...CREW_PR, extra] });
    expect(mergeCalls()).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled(); // the shape gate refuses BEFORE any paid vote
    expect(receiptLines().at(-1)).toMatch(/verdict=missed leg=class-match/);
  });

  // The REAL ops-pipeline registry entry (crew-change enabled, scripts/** safe, door-machinery sensitive).
  it.each([
    "scripts/pr-automerge-gate.ts",
    "scripts/lib/automerge-classify.ts",
    "scripts/lib/label-authority.ts",
    "scripts/restart-train.ts",
    "scripts/squasher-fleet.json",
  ])("touching the gate itself (%s) ⇒ refused under ops-pipeline's real registry entry; no spend, no merge", async (gatePath) => {
    await runGateWithRegistry("studio-b-ai/ops-pipeline", { diff: [{ path: gatePath, added: ["// policy edit"] }, { path: "scripts/lib/new-worker.ts", isNew: true }] });
    expect(mergeCalls()).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled();
    expect(receiptLines().at(-1)).toMatch(/verdict=missed leg=class-match/);
  });

  it("…and the crew-change deny list refuses the gate on its own, even with NO sensitive patterns declared (defense in depth)", async () => {
    await runGate(
      { repo: "studio-b-ai/ops-pipeline", diff: [{ path: "scripts/pr-automerge-gate.ts", added: ["// policy edit"] }, { path: "scripts/lib/new-worker.ts", isNew: true }] },
      { classes: ["crew-change"], globs: ["scripts/**"], sensitive: [] },
    );
    expect(mergeCalls()).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("known-GOOD twin: the same real registry, an ordinary new script + test ⇒ merges", async () => {
    await runGateWithRegistry("studio-b-ai/ops-pipeline", { diff: [{ path: "scripts/lib/new-worker.ts", isNew: true }, { path: "scripts/lib/__tests__/new-worker.test.ts", isNew: true }] });
    expect(mergeCalls()).toHaveLength(1);
  });

  it("over the 1500 cap (additions + deletions) ⇒ refused at line-cap, no spend", async () => {
    await runGate({ diff: CREW_PR, additions: 1000, deletions: 501 });
    expect(mergeCalls()).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled();
    expect(receiptLines().at(-1)).toMatch(/verdict=missed leg=line-cap/);
  });

  it("a named required check that never reported ⇒ refused at named-checks, no spend (the named-checks leg is live for crew-change)", async () => {
    await runGate({ diff: CREW_PR }, { checks: ["ci", "Server — TypeScript + Tests"] });
    expect(mergeCalls()).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled();
    expect(receiptLines().at(-1)).toMatch(/verdict=missed leg=named-checks/);
  });

  it("no required_checks declared at all ⇒ the class is inert (an empty list fails closed)", async () => {
    await runGate({ diff: CREW_PR }, { checks: [] });
    expect(mergeCalls()).toHaveLength(0);
    expect(receiptLines().at(-1)).toMatch(/verdict=missed leg=named-checks/);
  });

  it("exactly 1500 ⇒ the cap does not refuse", async () => {
    await runGate({ diff: CREW_PR, additions: 1000, deletions: 500 });
    expect(mergeCalls()).toHaveLength(1);
  });
});

describe("the crew-change door — non-crew PRs never get the class", () => {
  it("a PR by someone else carrying fleet-internal ⇒ refused, the class never applies (class-match), no spend", async () => {
    await runGate({ diff: CREW_PR, author: "somebody-else" });
    expect(mergeCalls()).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled();
    expect(receiptLines().at(-1)).toMatch(/verdict=missed leg=class-match/);
  });

  it("the owner identity with only `bugsquasher` (no fleet-internal) ⇒ refused likewise: the class is the crew lane's", async () => {
    await runGate({ diff: CREW_PR, labels: ["bugsquasher"] });
    expect(mergeCalls()).toHaveLength(0);
    expect(receiptLines().at(-1)).toMatch(/verdict=missed leg=class-match/);
  });

  it("a caller whose enabled classes lack crew-change never sees it (acuops/acudev/note-intelligence/client-asthetik shape) — its receipt does not even MENTION the class", async () => {
    await runGate({ diff: CREW_PR }, { classes: ["docs-comment"] });
    expect(mergeCalls()).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled();
    expect(receiptLines().at(-1)).toMatch(/verdict=missed leg=class-match/);
    expect(receiptLines().at(-1)).not.toContain("crew-change"); // byte-identical receipts for callers that never opted in
  });

  it("BUGSQUASHER LANE UNCHANGED: a bugsquasher-only code-fix PR still gets the CODE_FIX rubric and merges as before", async () => {
    await runGate({ diff: [{ path: "src/lib/router.ts", removed: ["return x;"], added: ["return x.trim();"] }], labels: ["bugsquasher"] });
    expect(receiptLines().at(-1)).toContain("class=code-fix verdict=qualified");
    expect(world.system.every((s) => s === CODE_FIX_REVIEW_SYSTEM)).toBe(true);
    expect(mergeCalls()).toHaveLength(1);
  });

  it("BUGSQUASHER LANE UNCHANGED: a gate-written needs-human on a bugsquasher PR is left alone", async () => {
    await runGate({
      diff: [{ path: "src/lib/router.ts", removed: ["return x;"], added: ["return x.trim();"] }],
      labels: ["bugsquasher", "needs-human"],
      needsHumanBy: "gate",
      comments: [buildFlagCard({ leg: "review", headSha: "0".repeat(40), reasons: ["old"] }).body],
    });
    expect(callsMatching(/--remove-label needs-human/)).toHaveLength(0);
  });
});

describe("the crew-change door — the review rubric's verdict is binding", () => {
  it("a FLAG naming SAFE x3 ⇒ refused at the review leg; the card names SAFE; needs-human is written; no merge", async () => {
    await runGate({ diff: CREW_PR, votes: ["FLAG\nSAFE: src/lib/http.ts adds an unauthenticated outbound POST"] });
    expect(mergeCalls()).toHaveLength(0);
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(receiptLines().at(-1)).toMatch(/verdict=missed leg=review/);
    const card = world.comments.find((c) => c.startsWith("<!-- gate-flag review "));
    expect(card).toBeDefined();
    expect(card).toContain("SAFE:");
    expect(world.labels.has("needs-human")).toBe(true);
  });

  it("each of the four criteria, when it is the one that fails, refuses (CORRECT / SAFE / SCOPED / PROVEN)", async () => {
    for (const k of ["CORRECT", "SAFE", "SCOPED", "PROVEN"]) {
      await runGate({ diff: CREW_PR, votes: [`FLAG\n${k}: concrete defect`] });
      expect(mergeCalls(), k).toHaveLength(0);
      expect(receiptLines().at(-1), k).toMatch(/leg=review/);
    }
  });

  it("an unparseable / chatty reply is a FLAG (strict CLEAN parse is unchanged)", async () => {
    await runGate({ diff: CREW_PR, votes: ["CLEAN, looks good to me"] });
    expect(mergeCalls()).toHaveLength(0);
  });

  it("tripwire label cannot be written ⇒ merge ABORTED (fail-closed: an unwatched merge is refused)", async () => {
    await runGate({ diff: CREW_PR, failOnAddLabel: "automerge:code-fix" });
    expect(mergeCalls()).toHaveLength(0);
    expect(logs.join("\n")).toContain("merge ABORTED");
  });
});

describe("the parked pile — the gate's OWN needs-human is retired; a human's never is", () => {
  const OLD_CARD = (policy?: string) =>
    policy === undefined
      ? `<!-- gate-flag review ${HEAD} -->\n**Release door — review FLAG** (head \`a1b2c3d\`)\n\nFLAG: behavioral logic change, introduces a new module`
      : `${cardMarkerFor("review", HEAD, policy)}\n**Release door — review FLAG**`;

  it("known-GOOD: a parked crew PR (gate-written needs-human + an OLD-policy FLAG card on this head) is RE-VOTED, merges, and the gate's own needs-human is stripped AFTER the merge", async () => {
    await runGate({ diff: CREW_PR, labels: ["fleet-internal", "needs-human"], needsHumanBy: "gate", comments: [OLD_CARD()], votes: ["CLEAN"] });
    expect(createMock).toHaveBeenCalledTimes(3); // the one-time re-vote under the new rubric
    expect(mergeCalls()).toHaveLength(1);
    const strip = callsMatching(/--remove-label needs-human/);
    expect(strip).toHaveLength(1);
    expect(strip[0].i).toBeGreaterThan(mergeCalls()[0].i); // the card stays on the glass until the PR actually merges
    expect(world.labels.has("needs-human")).toBe(false);
    expect(logs.join("\n")).toContain("the GATE'S OWN card");
  });

  it("a legacy (pre-#313) FLAG card and a card from another policy version also allow the re-vote", async () => {
    for (const card of [`${legacyCardMarkerFor(HEAD)}\n**Release door — review FLAG**`, OLD_CARD("2026-09-01-small-fix-rubric")]) {
      await runGate({ diff: CREW_PR, labels: ["fleet-internal", "needs-human"], needsHumanBy: "gate", comments: [card], votes: ["CLEAN"] });
      expect(mergeCalls()).toHaveLength(1);
    }
  });

  it("STICKY HOLDS WITHIN ONE POLICY: a CURRENT-policy FLAG card on this head parks it — no vote, no merge, no strip (stint #724 intact)", async () => {
    await runGate({
      diff: CREW_PR,
      labels: ["fleet-internal", "needs-human"],
      needsHumanBy: "gate",
      comments: [buildFlagCard({ leg: "review", headSha: HEAD, reasons: ["votes: FLAG,FLAG,FLAG"] }).body],
    });
    expect(createMock).not.toHaveBeenCalled();
    expect(mergeCalls()).toHaveLength(0);
    expect(callsMatching(/--remove-label needs-human/)).toHaveLength(0);
    expect(world.labels.has("needs-human")).toBe(true);
  });

  it("re-voted under the new rubric and FLAGGED again ⇒ stays parked: the card is re-posted under THIS policy, the label stays", async () => {
    await runGate({ diff: CREW_PR, labels: ["fleet-internal", "needs-human"], needsHumanBy: "gate", comments: [OLD_CARD()], votes: ["FLAG\nSAFE: x"] });
    expect(mergeCalls()).toHaveLength(0);
    expect(callsMatching(/--remove-label needs-human/)).toHaveLength(0);
    expect(world.comments.some((c) => c.startsWith(cardMarkerFor("review", HEAD)))).toBe(true);
    expect(world.labels.has("needs-human")).toBe(true);
  });

  it("a needs-human added by a HUMAN is untouched: refused at the lane, no vote, no strip, no merge", async () => {
    await runGate({ diff: CREW_PR, labels: ["fleet-internal", "needs-human"], needsHumanBy: "owner", comments: [OLD_CARD()] });
    expect(createMock).not.toHaveBeenCalled();
    expect(mergeCalls()).toHaveLength(0);
    expect(callsMatching(/--remove-label needs-human/)).toHaveLength(0);
    expect(world.labels.has("needs-human")).toBe(true);
    expect(receiptLines().at(-1)).toMatch(/leg=eligibility/);
  });

  it("a fleet-App needs-human with NO gate card on the PR is not proven to be the gate's: untouched", async () => {
    await runGate({ diff: CREW_PR, labels: ["fleet-internal", "needs-human"], needsHumanBy: "gate", comments: [] });
    expect(mergeCalls()).toHaveLength(0);
    expect(callsMatching(/--remove-label needs-human/)).toHaveLength(0);
  });

  it("an unreadable timeline is fail-closed: the label is treated as a human's and the PR stays parked", async () => {
    install({ diff: CREW_PR, labels: ["fleet-internal", "needs-human"], needsHumanBy: "gate", comments: [OLD_CARD()] });
    const inner = execFileSyncMock.getMockImplementation()!;
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.join(" ").startsWith("api graphql")) throw new Error("GraphQL 502");
      return inner(cmd, args);
    });
    await evaluate("studio-b-ai/bolt-wms", 42, CLASSES_WITH_CREW as never, [], GLOBS, ["ci"], []);
    expect(mergeCalls()).toHaveLength(0);
    expect(callsMatching(/--remove-label needs-human/)).toHaveLength(0);
  });

  it("a merge that FAILS leaves the gate's card in place (a stuck PR must stay visible on the glass)", async () => {
    await runGate({ diff: CREW_PR, labels: ["fleet-internal", "needs-human"], needsHumanBy: "gate", comments: [OLD_CARD()], mergeFails: true });
    expect(callsMatching(/--remove-label needs-human/)).toHaveLength(0);
    expect(world.labels.has("needs-human")).toBe(true);
  });

  it("a failed strip after a successful merge is non-fatal (the merge stands; the receipt says so)", async () => {
    await runGate({ diff: CREW_PR, labels: ["fleet-internal", "needs-human"], needsHumanBy: "gate", comments: [OLD_CARD()], failOnRemoveLabel: true });
    expect(mergeCalls()).toHaveLength(1);
    expect(world.comments.at(-1)).toContain("not removed");
  });

  it("`hold` still parks everything first (Kevin's word beats the new policy)", async () => {
    await runGate({ diff: CREW_PR, labels: ["fleet-internal", "needs-human", "hold"], needsHumanBy: "gate", comments: [OLD_CARD()] });
    expect(createMock).not.toHaveBeenCalled();
    expect(mergeCalls()).toHaveLength(0);
    expect(receiptLines().at(-1)).toMatch(/leg=held/);
  });
});

describe("TRAIN-class repos — crew-change takes the candidate path, never a direct merge", () => {
  it("studiob: every leg passes ⇒ `candidate` + `box` written by the gate, NO merge, the gate's own stale needs-human retired", async () => {
    await runGate(
      {
        repo: "studio-b-ai/studiob",
        diff: CREW_PR,
        labels: ["fleet-internal", "needs-human"],
        needsHumanBy: "gate",
        comments: [`<!-- gate-flag review ${HEAD} -->\n**Release door — review FLAG**`],
        votes: ["CLEAN"],
      },
      { globs: GLOBS },
    );
    expect(mergeCalls()).toHaveLength(0);
    expect(world.labels.has("candidate")).toBe(true);
    expect(world.labels.has("box")).toBe(true);
    expect(world.labels.has("needs-human")).toBe(false);
    expect(receiptLines().at(-1)).toContain("class=crew-change verdict=candidate");
  });
});
