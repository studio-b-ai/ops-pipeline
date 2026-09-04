/**
 * The `queued` — MERGED receipt's DOOR line (Rule #412 fix, Dispatcher ask
 * 9/04): the receipt used to hardcode "MERGED by the restart train" regardless
 * of which GitHub Actions workflow actually executed the merge. The RUNG
 * (label-authority v2 A1, ops#190 — WHO is authorized to merge) and the DOOR
 * (the workflow run that actually did it) are two different facts; only the
 * rung was ever named, and the rung's own name was reused as a stand-in for
 * the door. Three seats inferred the door from that wrong name on
 * webhook-router#891/#900 (15:24Z) and bolt-wms#2148 (19:17Z) — the real door
 * was squasher-fleet-sweep.yml (hourly ~:16, fleet-wide over every open
 * `queued` PR); heritage-restart-train.yml is the door only for its OWN
 * ticket repos and never calls evaluateTrainReady at all (it has its own,
 * separate fire()/receipt path in restart-train.ts — see that file's header).
 *
 * `mergeDoorFrom` reads the door fact from the live Actions environment
 * instead of asserting it: `GITHUB_WORKFLOW_REF` names the workflow FILE that
 * is actually executing the current step — ground truth GitHub itself
 * computes (correct even across a reusable-workflow `uses:` chain), never a
 * guess about which caller kicked things off. A local/dry-run invocation
 * outside Actions has none of these set — that renders the honest
 * "(unknown — not run under Actions)" form rather than a fabricated door.
 */

export type MergeDoor = { workflowFile: string; runId: string; runUrl: string };

const RESTART_TRAIN_WORKFLOW_FILE = "heritage-restart-train.yml";
const RUNG_NOTE = "label-authority v2, ops#190 rung A1; one vocabulary 9/02";

/**
 * Pulls the `<file>` segment out of `GITHUB_WORKFLOW_REF`
 * (`owner/repo/.github/workflows/<file>@<ref>`). Returns null on anything
 * that doesn't match — never throws, never guesses a filename.
 */
function workflowFileFrom(workflowRef: string): string | null {
  const match = /\.github\/workflows\/([^@/]+)@/.exec(workflowRef);
  return match ? match[1] : null;
}

/**
 * Reads the door facts from the Actions environment; null (not throw) when
 * any required piece is missing or unparseable — e.g. a local/dry-run
 * invocation outside GitHub Actions, or a malformed `GITHUB_WORKFLOW_REF`.
 */
export function mergeDoorFrom(env: NodeJS.ProcessEnv = process.env): MergeDoor | null {
  const workflowRef = (env.GITHUB_WORKFLOW_REF ?? "").trim();
  const runId = (env.GITHUB_RUN_ID ?? "").trim();
  const serverUrl = (env.GITHUB_SERVER_URL ?? "").trim().replace(/\/+$/, "");
  const repository = (env.GITHUB_REPOSITORY ?? "").trim();
  const workflowFile = workflowFileFrom(workflowRef);
  if (!workflowFile || !runId || !serverUrl || !repository) {
    return null;
  }
  return { workflowFile, runId, runUrl: `${serverUrl}/${repository}/actions/runs/${runId}` };
}

/**
 * The receipt's first line: names the DOOR (workflow file + a link to the
 * run) and the RUNG separately, never conflating the two (#412 — prose is a
 * claim about scope; it must match the actual mechanism, not stand in for
 * it). `door` is null for a local/dry-run invocation outside GitHub Actions,
 * in which case the door renders honestly as unknown but the rung is still
 * named. The "MERGED by the restart train" phrasing survives ONLY for the
 * one door it is actually true of — every other door gets the neutral,
 * file-naming form.
 */
export function formatMergeDoorLine(door: MergeDoor | null): string {
  if (!door) {
    return `**\`queued\` — MERGED** · door: (unknown — not run under Actions) · rung: ${RUNG_NOTE}`;
  }
  const title =
    door.workflowFile === RESTART_TRAIN_WORKFLOW_FILE
      ? "**`queued` — MERGED by the restart train**"
      : "**`queued` — MERGED**";
  return `${title} · door: \`${door.workflowFile}\` [run ${door.runId}](${door.runUrl}) · rung: ${RUNG_NOTE}`;
}

/** The facts `evaluateTrainReadyInner` (pr-automerge-gate.ts) has on hand at the
 *  point it posts the write-only merge receipt — everything the template needs,
 *  nothing it has to re-derive. */
export type TrainMergeReceiptFacts = {
  door: MergeDoor | null;
  authorizingLogin: string;
  authorizingPosition: number;
  headRefOid: string;
};

/**
 * The full `queued` — MERGED receipt body. Pulled out to a pure function (was
 * inlined in pr-automerge-gate.ts) so the #412 door-line fix is unit-testable
 * without standing up that file's whole `gh`/Anthropic-mocked evaluation path —
 * this is the entire template, byte-for-byte, so a test can assert the door
 * line is the ONLY thing that changed.
 */
export function formatTrainMergeReceipt(facts: TrainMergeReceiptFacts): string {
  return [
    formatMergeDoorLine(facts.door),
    "",
    "| Leg | Result |",
    "|---|---|",
    `| authority (label-authority v2, revalidated pre-merge) | ✅ authorized by \`${facts.authorizingLogin}\` (timeline position ${facts.authorizingPosition}) |`,
    "| merge-ready (OPEN, not draft, mergeStateStatus CLEAN) + CI rollup clean | ✅ |",
    "| independent review (Claude Sonnet 5) | ✅ CLEAN |",
    "| revalidate: PR snapshot (labels/sha/state/mergeStateStatus) | ✅ no drift |",
    "| revalidate: authority timeline re-check | ✅ still authorized |",
    "",
    `Evaluated sha: \`${facts.headRefOid}\` (merge was SHA-pinned via \`--match-head-commit\`).`,
    "",
    "This comment is a write-only receipt — no automation reads it back.",
  ].join("\n");
}
