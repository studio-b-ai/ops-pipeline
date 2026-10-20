/**
 * A STATEFUL fake of the slice of GitHub the crew-merge guards touch, driven through a mocked
 * `node:child_process` `execFileSync` (every `gh` call in pr-automerge-gate.ts, lib/crew-merge-guards.ts,
 * lib/label-authority.ts, lib/github-issues.ts and restart-train.ts funnels through it).
 *
 * Why a stateful world and not canned strings (Rule #223 / #322): the review of #580 at a9b614c
 * (door-580-review.json) found defects that only exist ACROSS sweeps — a flag card that stops matching
 * after the gate's own update-branch, a box whose timeline position a push can precede, a label write
 * that lands after a head move. A canned response per call cannot express those. The world keeps the
 * PR's labels, head, timeline, comments, check runs, CI and base-lag, mutates them as the code under
 * test writes, and answers the next read from the mutated state — so a test asserts on what the code
 * CAUSED, not on what the fixture said.
 *
 * Fidelity notes (each is a place a fake can lie; each is pinned):
 *  - `pr merge --match-head-commit X` THROWS unless X is the current head (GitHub's sha pin).
 *  - `update-branch` with a wrong `expected_head_sha` THROWS (HTTP 422), like GitHub; on success it
 *    appends a GitHub-signed two-parent merge commit (parents [head, base tip]), moves the head and
 *    re-runs CI green, as `PUT /pulls/{n}/update-branch` does once GitHub has finished the merge.
 *  - Check runs posted through the API carry `app = world.appSlug` (the fleet App in production);
 *    check runs are readable per sha, never per PR — exactly how GitHub scopes them.
 *  - The PR's `statusCheckRollup` includes the check runs for the CURRENT head (NEUTRAL stays clean).
 *  - The comments `--jq` probe is EVALUATED: markers are parsed out of the `contains("…")` terms, so a
 *    gate that changes its marker format or probes the wrong head sees zero hits, as in prod.
 *  - Label events are timeline events in order; a label added by the gate is attributed to the fleet bot,
 *    one added with `world.kevinLabels()` to Kevin; a push after a label sits after it in the timeline.
 */

export const FLEET_APP_SLUG = "studiob-fleet-bot";
export const TIP = "2026-10-20T12:00:00Z";
export const OLD_MERGE_BASE = "2026-10-16T12:00:00Z"; // 4 days before TIP: the toto#131 shape
const RECENT_MERGE_BASE = "2026-10-20T10:00:00Z";

export type Compare = { ahead_by: number; merge_base_date: string | null; files: string[]; file_count?: number };
export const FRESH: Compare = { ahead_by: 0, merge_base_date: TIP, files: [] };
export const STALE_BY_AGE: Compare = { ahead_by: 41, merge_base_date: OLD_MERGE_BASE, files: ["src/unrelated.ts"] };
export const STALE_BY_FILE: Compare = { ahead_by: 1, merge_base_date: RECENT_MERGE_BASE, files: ["README.md", "src/fix.ts"] };

export interface WorldInit {
  repo: string;
  pr: number;
  labels: string[];
  files?: string[];
  additions?: number;
  deletions?: number;
  head?: string;
  /** Who applied `box` if it is pre-seeded (it must also be in `labels`). */
  boxBy?: "kevin" | "bot" | null;
  baseBehind?: Compare;
  /** Labels that already exist in the repo. Default: the fleet's vocabulary INCLUDING automerge:code-fix. */
  repoLabels?: string[];
  ci?: "green" | "red";
}

type Node = Record<string, unknown>;
type RollupRow = { name: string; status: string; conclusion: string; completedAt: string };

const hex = (prefix: string, n: number) => (prefix + String(n).padStart(2, "0") + "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0").slice(0, 40);

export class World {
  repo: string;
  pr: number;
  labels: string[];
  files: string[];
  additions: number;
  deletions: number;
  head: string;
  baseRefName = "main";
  author = "kbibelhausen";
  createdAt = "2026-10-01T00:00:00Z";
  state = "OPEN";
  mergeStateStatus = "CLEAN";
  title = "crew fix";
  diff: string;
  baseBehind: Compare;
  mainTipDate = TIP;
  /** Oids that are ancestors of (or equal to) the base tip — answers `compare <oid>...<base>`. */
  baseHistory = new Set<string>();
  baseTip = hex("b0", 1);

  timeline: Node[] = [];
  comments: string[] = [];
  checkRuns: { name: string; head_sha: string; conclusion: string; app: string; text: string }[] = [];
  repoLabels: Set<string>;
  ciRows: RollupRow[];

  calls: string[][] = [];
  merges: { pin: string; head: string; labels: string[] }[] = [];
  updateBranchCalls: { expected: string; at: string }[] = [];

  // ── behaviors ──
  updateBranchMode: "ok" | "refuse" = "ok";
  /** A label whose `--add-label` write throws. */
  failLabelAdd?: string;
  /** Every `--remove-label` throws. */
  failRemoveLabel = false;
  failCheckRunPost = false;
  failCheckRunPostFor?: string;
  compareThrows = false;
  /** The slug stamped on check runs the code under test POSTS. Production: the fleet App. */
  appSlug = FLEET_APP_SLUG;
  /** Sign the merge commit update-branch creates (GitHub does). */
  signMerge = true;
  /** Runs BEFORE a label write is applied; `nth` counts label writes (1-based) — the TOCTOU hook. */
  beforeLabelWrite?: (label: string, nth: number, world: World) => void;
  labelWrites = 0;
  /** Extra check runs the CI rollup shows, besides the named CI row and any posted check runs. */
  private clock = 0;
  private commitSeq = 0;

  constructor(init: WorldInit) {
    this.repo = init.repo;
    this.pr = init.pr;
    this.labels = [...init.labels];
    this.files = init.files ?? ["src/fix.ts"];
    this.additions = init.additions ?? 22;
    this.deletions = init.deletions ?? 2;
    this.head = init.head ?? hex("c0", 1);
    this.baseBehind = init.baseBehind ?? FRESH;
    this.baseHistory.add(this.baseTip);
    this.repoLabels = new Set(
      init.repoLabels ?? ["fleet-internal", "bugsquasher", "candidate", "box", "needs-human", "hold", "reviewed", "automerge:code-fix", "train:in-flight"],
    );
    this.ciRows = [{ name: "ci", status: "COMPLETED", conclusion: init.ci === "red" ? "FAILURE" : "SUCCESS", completedAt: this.stamp() }];
    this.diff = [
      `diff --git a/${this.files[0]} b/${this.files[0]}`,
      `--- a/${this.files[0]}`,
      `+++ b/${this.files[0]}`,
      "@@ -1,2 +1,3 @@",
      "-const a = 1;",
      "+const a = 2;",
      "+export const b = 3;",
      "",
    ].join("\n");
    // The PR's first commit (parent: an old base commit).
    this.timeline.push(this.commitNode(this.head, [hex("b0", 0)], false));
    if (init.boxBy) this.timeline.push(this.labeledNode("box", init.boxBy));
  }

  // ── time / commit helpers ──
  private stamp(): string {
    this.clock += 1;
    return new Date(Date.parse("2026-10-20T10:00:00Z") + this.clock * 60_000).toISOString();
  }
  private commitNode(oid: string, parents: string[], signed: boolean): Node {
    return {
      __typename: "PullRequestCommit",
      commit: { oid, parents: { nodes: parents.map((p) => ({ oid: p })) }, signature: signed ? { isValid: true, wasSignedByGitHub: true } : null },
    };
  }
  private labeledNode(label: string, by: "kevin" | "bot"): Node {
    return {
      __typename: "LabeledEvent",
      label: { name: label },
      actor: by === "bot" ? { __typename: "Bot", login: "studiob-fleet-bot" } : { __typename: "User", login: "kbibelhausen" },
      createdAt: this.stamp(),
    };
  }

  // ── test-side mutators (the crew / Kevin / main acting) ──
  /** A crew pushes a plain (unsigned, single-parent) commit; the head moves, CI re-runs green. */
  push(): string {
    this.commitSeq += 1;
    const oid = hex("d0", this.commitSeq);
    this.timeline.push(this.commitNode(oid, [this.head], false));
    this.head = oid;
    this.ciRows = [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS", completedAt: this.stamp() }];
    return oid;
  }
  /** A crew pushes a hand-built merge commit of base into the branch (unsigned, no gate attestation). */
  pushForeignMerge(opts: { signed?: boolean } = {}): string {
    this.commitSeq += 1;
    const oid = hex("e0", this.commitSeq);
    this.timeline.push(this.commitNode(oid, [this.head, this.baseTip], opts.signed ?? false));
    this.head = oid;
    this.ciRows = [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS", completedAt: this.stamp() }];
    return oid;
  }
  /** Kevin applies labels (attributed to him, in timeline order). */
  kevinLabels(...labels: string[]): void {
    for (const l of labels) this.applyLabel(l, "kevin");
  }
  /** The fleet bot applies labels (the gate's own writes, applied by the test directly). */
  botLabels(...labels: string[]): void {
    for (const l of labels) this.applyLabel(l, "bot");
  }
  /** Main moves on: the PR is behind again. */
  mainMoves(compare: Compare = STALE_BY_AGE): void {
    this.baseBehind = compare;
  }
  injectCheck(c: { name: string; head_sha: string; app: string; conclusion?: string; text?: string }): void {
    this.checkRuns.push({ name: c.name, head_sha: c.head_sha, conclusion: c.conclusion ?? "neutral", app: c.app, text: c.text ?? "" });
  }
  setCi(state: "green" | "red" | "pending"): void {
    this.ciRows = [
      {
        name: "ci",
        status: state === "pending" ? "IN_PROGRESS" : "COMPLETED",
        conclusion: state === "green" ? "SUCCESS" : state === "red" ? "FAILURE" : "",
        completedAt: this.stamp(),
      },
    ];
  }

  private applyLabel(label: string, by: "kevin" | "bot"): void {
    if (this.labels.includes(label)) return; // GitHub: adding a label already present is a no-op (no event)
    if (label === this.failLabelAdd && by === "bot") throw new Error(`gh: could not add label '${label}' (HTTP 422)\nsecond line`);
    this.labelWrites += 1;
    this.beforeLabelWrite?.(label, this.labelWrites, this);
    this.labels.push(label);
    this.timeline.push(this.labeledNode(label, by));
  }
  private removeLabel(label: string): void {
    if (this.failRemoveLabel) throw new Error(`gh: could not remove label '${label}' (HTTP 500)`);
    if (this.labels.includes(label)) {
      this.labels = this.labels.filter((l) => l !== label);
      this.timeline.push({ __typename: "UnlabeledEvent", label: { name: label }, actor: { __typename: "Bot", login: "studiob-fleet-bot" } });
    }
  }

  // ── derived views ──
  rollup(): RollupRow[] {
    const posted = this.checkRuns
      .filter((c) => c.head_sha === this.head)
      .map((c) => ({ name: c.name, status: "COMPLETED", conclusion: c.conclusion.toUpperCase(), completedAt: this.stamp() }));
    return [...this.ciRows, ...posted];
  }
  prJson(): Record<string, unknown> {
    return {
      author: { login: this.author },
      createdAt: this.createdAt,
      labels: this.labels.map((name) => ({ name })),
      state: this.state,
      isDraft: false,
      mergeStateStatus: this.mergeStateStatus,
      additions: this.additions,
      deletions: this.deletions,
      headRefOid: this.head,
      baseRefName: this.baseRefName,
      statusCheckRollup: this.rollup(),
      files: this.files.map((path) => ({ path })),
      changedFiles: this.files.length,
      title: this.title,
    };
  }
  timelineJson(): string {
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            timelineItems: { filteredCount: this.timeline.length, pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: this.timeline },
          },
        },
      },
    });
  }

  // ── convenience for assertions ──
  joined(c: string[]): string {
    return c.slice(1).join(" ");
  }
  callsMatching(prefix: string): string[][] {
    return this.calls.filter((c) => this.joined(c).startsWith(prefix));
  }
  /** Label names passed to `pr edit --add-label`, in call order (writes attempted, including failed ones). */
  labelAddAttempts(): string[] {
    return this.callsMatching("pr edit").filter((c) => c.includes("--add-label")).map((c) => c[c.indexOf("--add-label") + 1]);
  }
  factsReads(): string[][] {
    return this.calls.filter((c) => /^api repos\/[^/]+\/[^/]+\/compare\//.test(this.joined(c)) && this.joined(c).includes("per_page=1") && c.some((a) => a.startsWith("{ahead_by")));
  }
  updateBranchAttempts(): string[][] {
    return this.calls.filter((c) => /^api -X PUT repos\/[^/]+\/[^/]+\/pulls\/\d+\/update-branch/.test(this.joined(c)));
  }
  mergeCalls(): string[][] {
    return this.callsMatching("pr merge");
  }
  checkPosts(name?: string): string[][] {
    return this.calls.filter((c) => this.joined(c).startsWith(`api repos/${this.repo}/check-runs -X POST`) && (name === undefined || c.includes(`name=${name}`)));
  }
  commentsMatching(s: string): string[] {
    return this.comments.filter((c) => c.includes(s));
  }

  // ── the gh router ──
  handle(cmd: string, args: string[]): string {
    this.calls.push([cmd, ...args]);
    if (cmd === "sleep") return "";
    const a = args.join(" ");
    const R = this.repo;
    const N = this.pr;

    if (a.startsWith("api graphql")) return this.timelineJson();

    if (args[0] === "pr" || args[0] === "issue") {
      // `pr view`
      if (args[0] === "pr" && args[1] === "view") {
        const jsonIdx = args.indexOf("--json");
        const fields = jsonIdx >= 0 ? args[jsonIdx + 1].split(",") : [];
        const jqIdx = args.indexOf("--jq");
        const jq = jqIdx >= 0 ? args[jqIdx + 1] : undefined;
        if (fields.length === 1 && fields[0] === "comments" && jq) {
          const markers = [...jq.matchAll(/contains\("((?:[^"\\]|\\.)*)"\)/g)].map((m) => m[1]);
          const n = this.comments.filter((c) => markers.some((m) => c.includes(m))).length;
          return `${n}\n`;
        }
        if (fields.length === 1 && fields[0] === "headRefOid" && jq === ".headRefOid") return `${this.head}\n`;
        const all = this.prJson();
        const out: Record<string, unknown> = {};
        for (const f of fields) out[f] = all[f];
        return JSON.stringify(out);
      }
      // `pr list --repo X --label L ...` (restart-train's ticket enumeration)
      if (args[0] === "pr" && args[1] === "list") {
        const repoArg = args[args.indexOf("--repo") + 1];
        const label = args[args.indexOf("--label") + 1];
        if (repoArg !== this.repo || !this.labels.includes(label)) return "[]";
        return JSON.stringify([{ number: this.pr, headRefOid: this.head, labels: this.labels.map((name) => ({ name })), baseRefName: this.baseRefName }]);
      }
      // `pr edit` / `issue edit`
      if (args[1] === "edit") {
        const addIdx = args.indexOf("--add-label");
        const remIdx = args.indexOf("--remove-label");
        if (addIdx >= 0) this.applyLabel(args[addIdx + 1], "bot");
        if (remIdx >= 0) this.removeLabel(args[remIdx + 1]);
        return "";
      }
      // `pr comment` / `issue comment`
      if (args[1] === "comment") {
        this.comments.push(args[args.indexOf("--body") + 1]);
        return "";
      }
      // `pr merge`
      if (args[0] === "pr" && args[1] === "merge") {
        const pin = args[args.indexOf("--match-head-commit") + 1];
        if (pin !== this.head) throw new Error(`GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest) [pin ${pin} != head ${this.head}]`);
        this.merges.push({ pin, head: this.head, labels: [...this.labels] });
        this.state = "MERGED";
        return "";
      }
    }

    if (args[0] === "label" && args[1] === "create") {
      const name = args[2];
      if (this.repoLabels.has(name) && !args.includes("--force")) throw new Error(`gh: label '${name}' already exists`);
      this.repoLabels.add(name);
      return "";
    }

    if (args[0] === "api") {
      // label existence GET
      const lm = /^api repos\/[^/]+\/[^/]+\/labels\/(.+)$/.exec(a);
      if (lm) {
        const name = decodeURIComponent(lm[1]);
        if (this.repoLabels.has(name)) return JSON.stringify({ name });
        throw new Error("gh: Not Found (HTTP 404)");
      }
      // needs-human add through the issues API (postFlagCard)
      if (a.startsWith(`api -X POST repos/${R}/issues/${N}/labels`)) {
        const f = args.find((x) => x.startsWith("labels[]="));
        if (f) this.applyLabel(f.slice("labels[]=".length), "bot");
        return "";
      }
      // check-run POST
      if (a.startsWith(`api repos/${R}/check-runs -X POST`)) {
        const get = (k: string) => args.find((x) => x.startsWith(`${k}=`))?.slice(k.length + 1) ?? "";
        const name = get("name");
        if (this.failCheckRunPost || this.failCheckRunPostFor === name) throw new Error("gh: Resource not accessible by integration (HTTP 403)");
        this.checkRuns.push({ name, head_sha: get("head_sha"), conclusion: get("conclusion"), app: this.appSlug, text: get("output[text]") });
        return "{}";
      }
      // check-runs GET per sha
      const cm = /^api repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})\/check-runs/.exec(a);
      if (cm) {
        return this.checkRuns
          .filter((c) => c.head_sha === cm[1])
          .map((c) => JSON.stringify({ name: c.name, conclusion: c.conclusion, app: c.app, text: c.text }))
          .join("\n");
      }
      // issue comments (listIssueComments) — none in the world
      if (a.startsWith(`api repos/${R}/issues/${N}/comments`)) return "";
      // the diff
      if (a.startsWith(`api repos/${R}/compare/`) && args.includes("-H")) return this.diff;
      // compare reads
      const cmp = /^api repos\/[^/]+\/[^/]+\/compare\/([^.]+)\.\.\.([^?]+)\?per_page=1/.exec(a);
      if (cmp) {
        if (this.compareThrows) throw new Error("gh: HTTP 502 Bad Gateway");
        const jq = args[args.indexOf("--jq") + 1];
        if (jq === ".status") return `${this.baseHistory.has(cmp[1]) ? "ahead" : "diverged"}\n`;
        const c = this.baseBehind;
        return JSON.stringify({ ahead_by: c.ahead_by, merge_base_date: c.merge_base_date, file_count: c.file_count ?? c.files.length, files: c.files });
      }
      if (a.startsWith(`api repos/${R}/commits/${this.baseRefName}`)) return `${this.mainTipDate}\n`;
      if (a.startsWith(`api repos/${R}/pulls/${N} --jq`)) return `${this.head}\n`;
      // update-branch
      if (a.startsWith(`api -X PUT repos/${R}/pulls/${N}/update-branch`)) {
        const expected = args.find((x) => x.startsWith("expected_head_sha="))?.slice("expected_head_sha=".length) ?? "";
        this.updateBranchCalls.push({ expected, at: this.head });
        if (this.updateBranchMode === "refuse") throw new Error("gh: merge conflict between base and head (HTTP 422)\nsecond line");
        if (expected !== this.head) throw new Error("gh: expected head sha didn't match current head ref (HTTP 422)");
        this.commitSeq += 1;
        const oid = hex("f0", this.commitSeq);
        this.timeline.push(this.commitNode(oid, [this.head, this.baseTip], this.signMerge));
        this.head = oid;
        this.baseBehind = FRESH;
        this.ciRows = [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS", completedAt: this.stamp() }];
        return '{"message":"Updating pull request branch."}';
      }
    }
    throw new Error(`unexpected gh invocation in fake-gh: ${cmd} ${a}`);
  }
}
