/**
 * scripts/box-patch-id-labeled.ts — ops-pipeline#190 rollout step 3 (observe-only
 * lap). The companion script .github/workflows/box-patch-id-labeled.yml invokes for
 * every `box` LabeledEvent on THIS repo's own pull requests.
 *
 * NOT literally named in the plan's file list for this unit (that list names only the
 * workflow YAML) — added anyway because this repo's own, universal convention (every
 * workflow read while building this PR: squasher-automerge.yml, needs-human-probe.yml,
 * post-merge-tripwire.yml, heritage-restart-train.yml) is a thin YAML wrapper plus a
 * dedicated scripts/*.ts file holding all real logic. mintBoxPatchId and
 * readBoxPatchIdCheckRuns (scripts/lib/box-patch-id.ts) are TypeScript functions;
 * nothing in pure YAML/bash can call them, and reimplementing the bp2 recipe as raw
 * shell in the workflow would risk silently diverging from the one tested
 * implementation. Flagged as a deviation in this PR's body.
 *
 * Mints the bp2 patch-id and records it as a "box-patch-id" check run on the labeled
 * sha (ruling: "Where the patch-id is recorded") plus a marked, write-only PR
 * comment. OBSERVE-ONLY THIS LAP: nothing reads either record back to strip or keep
 * `box` — label-authority.ts's boxPatchIdWins flag stays false (see that file's Step 3
 * comment), so a refusal here NEVER fails this workflow or touches the PR's mergeability.
 *
 * "Never mint for an actor that already satisfies isGateAuthorizedActor" (ruling §2:
 * "a patch-id may only preserve an authority a human granted") — checked first, before
 * any git or GitHub API work, using the SAME currentLabels the labeling webhook already
 * carries (no extra fetch).
 *
 * labelEventDbId sourcing: GitHub's GraphQL schema exposes NO databaseId on
 * LabeledEvent — the first live firing of this handler (run 35523361685, PR #536) died
 * on `gh: Field 'databaseId' doesn't exist on type 'LabeledEvent'`, and
 * label-authority.ts's own AUTHORITY_TIMELINE_QUERY never needed one (its `position` is
 * an array index). The id therefore comes from the REST issue-events list
 * (`GET /repos/{owner}/{repo}/issues/{number}/events`, `event == "labeled"`), whose
 * numeric `id` is the label event's database id — the per-event integer GraphQL never
 * exposes. The most recent `box` event wins, and this script refuses cleanly (never
 * guesses) if none is found.
 *
 * Uses the studiob-fleet-bot App installation token exclusively (GH_TOKEN, minted by
 * the workflow via actions/create-github-app-token@v1) — never github.token — for the
 * same reason squasher-automerge.yml does: a check run is owned by the App identity
 * that creates it, so only a workflow holding the App's credentials can create or
 * update this one.
 */

import { execFileSync } from "node:child_process";
import { isGateAuthorizedActor, TRAIN_READY_LABEL } from "./lib/label-authority.js";
import { boxPatchIdKeyState, BOX_PATCH_ID_CHECK_NAME, mintBoxPatchId } from "./lib/box-patch-id.js";

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`box-patch-id-labeled: required env var ${name} is missing or empty.`);
  return v;
}

/** The REST issue-events list comes back oldest-first — walk from the end to find the
 *  MOST RECENT `labeled` event for `labelName`. `--jq` keeps the output one line per
 *  event even under `--paginate` (bare `--paginate` concatenates JSON arrays). Throws
 *  (never guesses) if none is found, matching this repo's fail-closed doctrine
 *  (label-authority.ts's own header). */
function fetchLabelEventDbId(owner: string, repo: string, prNumber: number, labelName: string): number {
  const out = gh([
    "api",
    `repos/${owner}/${repo}/issues/${prNumber}/events?per_page=100`,
    "--paginate",
    "--jq",
    '.[] | select(.event == "labeled") | "\\(.id) \\(.label.name)"',
  ]);
  const lines = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const sp = lines[i].indexOf(" ");
    if (sp < 0) continue;
    const id = Number(lines[i].slice(0, sp));
    const name = lines[i].slice(sp + 1);
    if (name === labelName && Number.isSafeInteger(id) && id > 0) {
      return id;
    }
  }
  throw new Error(
    `box-patch-id-labeled: no "labeled" issue event found for label "${labelName}" among ${lines.length} labeled events on ${owner}/${repo}#${prNumber}.`,
  );
}

function fetchChangedPaths(repo: string, prNumber: number): string[] {
  const out = gh(["api", `repos/${repo}/pulls/${prNumber}/files`, "--paginate", "--jq", ".[].filename"]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** `summary` and `text` both carry `title` and `body` respectively — `output.summary`
 *  is a required, short field per the Checks API; `output.text` is where
 *  readBoxPatchIdCheckRuns (scripts/lib/box-patch-id.ts) looks for the JSON record.
 *  Always `neutral`, never `skipped`: a `skipped` conclusion on a NAMED check run
 *  ("box-patch-id") is unclean in ops-pipeline's release check (same rule that
 *  motivated the job-level→step-level fix above) unless allowlisted, and this repo's
 *  allowlist intentionally carries no ops-pipeline row — see the fix for finding 1 on
 *  code review of ops-pipeline#536. */
function postCheckRun(repo: string, headSha: string, conclusion: "neutral", title: string, text: string): void {
  gh([
    "api",
    `repos/${repo}/check-runs`,
    "-X",
    "POST",
    "-f",
    `name=${BOX_PATCH_ID_CHECK_NAME}`,
    "-f",
    `head_sha=${headSha}`,
    "-f",
    "status=completed",
    "-f",
    `conclusion=${conclusion}`,
    "-f",
    `output[title]=${title}`,
    "-f",
    `output[summary]=${title}`,
    "-f",
    `output[text]=${text}`,
  ]);
}

function main(): void {
  const repo = env("BOX_REPO"); // "owner/repo"
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) throw new Error(`box-patch-id-labeled: BOX_REPO must be "owner/repo", got ${JSON.stringify(repo)}`);
  const prNumber = Number(env("BOX_PR_NUMBER"));
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`box-patch-id-labeled: BOX_PR_NUMBER must be a positive integer, got ${JSON.stringify(process.env.BOX_PR_NUMBER)}`);
  }
  const headSha = env("BOX_HEAD_SHA");
  const headRepo = env("BOX_HEAD_REPO");
  const baseRef = env("BOX_BASE_REF");
  const actorLogin = env("BOX_ACTOR_LOGIN");
  const currentLabels = (process.env.BOX_CURRENT_LABELS ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const key = process.env.BOX_PATCH_ID_KEY || undefined; // absent ⇒ ship untagged, per the ruling's decline path — never a refusal.

  if (isGateAuthorizedActor(actorLogin, currentLabels)) {
    const detail = `"${actorLogin}" is gate-authorized on this PR's current labels [${currentLabels.join(", ")}] — the ruling requires never minting a patch-id for an actor isGateAuthorizedActor already covers (a patch-id may only preserve an authority a human granted). Skipping mint.`;
    postCheckRun(repo, headSha, "neutral", "box-patch-id-skipped-gate-actor", detail);
    console.log(`box-patch-id-labeled: ${detail}`);
    return;
  }

  const changedPaths = fetchChangedPaths(repo, prNumber);
  const labelEventDbId = fetchLabelEventDbId(owner, repoName, prNumber, TRAIN_READY_LABEL);

  const verdict = mintBoxPatchId({
    repo,
    prNumber,
    headRepo,
    headSha,
    baseRef,
    labelEventDbId,
    changedPaths,
    repoDir: process.cwd(),
    key,
  });

  if (!verdict.ok) {
    // A refusal is itself the observation this lap exists to make — record it as a
    // check run (never silently skip) so a later rung's receipts have something real
    // to read. conclusion=neutral: this workflow never fails the PR's checks over a
    // refusal (observe-only — the position predicate alone still governs this lap).
    postCheckRun(repo, headSha, "neutral", verdict.reason, verdict.detail);
    console.error(`box-patch-id-labeled: refused — ${verdict.reason}: ${verdict.detail}`);
    return;
  }

  const record = verdict.record;
  const keyState = boxPatchIdKeyState(record);
  postCheckRun(repo, headSha, "neutral", `${record.patchId} (${keyState})`, JSON.stringify(record));

  const commentBody = [
    "<!-- box-patch-id v2, ops-pipeline#190, observe-only -->",
    `**box-patch-id recorded (observe-only).** ops-pipeline#190 rollout step 3.`,
    "",
    `Patch-id \`${record.patchId}\` (${keyState}) recorded on \`${headSha.slice(0, 7)}\` against base \`${baseRef}\` @ \`${record.baseSha.slice(0, 7)}\`.`,
    "",
    `This is a write-only receipt: no automation reads it back to strip or keep \`${TRAIN_READY_LABEL}\` this lap — the position predicate in label-authority.ts still governs alone.`,
  ].join("\n");
  gh(["pr", "comment", String(prNumber), "--repo", repo, "--body", commentBody]);

  console.log(`box-patch-id-labeled: recorded ${record.patchId} (${keyState}) on ${headSha}.`);
}

main();
