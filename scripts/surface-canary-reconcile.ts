/**
 * surface-canary-reconcile.ts — turn one surface-canary sweep's results into
 * auto-reconciled GitHub issues on the OWNING repos (surface canary program,
 * stint #461).
 *
 * The pattern (Kevin directive 2026-07-30, same as every alert monitor): an open
 * issue labeled `surface-canary` IS the alert/dedup state — a FAIL opens (or
 * comments on) the per-check issue, a PASS closes it with a comment
 * (Rules #292/#358 by construction). Runs HERE, in ops-pipeline, because the
 * studiob-fleet-bot App PEM lives ONLY in this repo's secrets (locked D3,
 * ops#250); the sweep lives in the private surface-canary repo and only emits
 * the surface-sweep-results artifact.
 *
 * Env: GH_TOKEN (the minted fleet App token), RUN_URL (the sweep run, quoted in
 * every issue body/comment), RESULTS_FILE (default surface-sweep-results.json).
 */
import { readFileSync } from "node:fs";
import { listIssuesByLabel, ensureLabel, openIssue, closeIssue, commentIssue } from "./lib/github-issues.js";

const LABEL = "surface-canary";
const LABEL_DESC = "Surface canary finding";
const LABEL_COLOR = "B60205";
const HOME = "studio-b-ai/surface-canary";
const RUN_URL = process.env.RUN_URL || "";
const BLIND_TITLE = "[surface-canary] instrument blind (bot-challenged or crashed)";

interface CheckRow {
  name: string;
  class: string;
  owner: string;
  outcome: "PASS" | "FAIL" | "BLOCKED" | "SKIP";
  evidence: string;
}

const results = JSON.parse(readFileSync(process.env.RESULTS_FILE || "surface-sweep-results.json", "utf8")) as {
  instrumentBlind?: boolean;
  checks: CheckRow[];
};

// --- Instrument-blind leg (mirrors storefront-qa.yml): blind opens one distinct
// issue on the HOME repo and suppresses per-check reconciliation (no visibility
// either way); sighted-again closes it. ---
ensureLabel(HOME, LABEL, LABEL_DESC, LABEL_COLOR);
const homeOpen = listIssuesByLabel(HOME, LABEL, "open");
const blindExisting = homeOpen.find((i) => i.title === BLIND_TITLE);

if (results.instrumentBlind) {
  if (!blindExisting) {
    openIssue(
      HOME,
      LABEL,
      BLIND_TITLE,
      `The sweep could not see its surfaces (majority of checks bot-challenged, or the instrument crashed). A blind instrument is not a healthy fleet (#456). Run: ${RUN_URL}`,
    );
    console.log("instrument blind — issue opened on home repo");
  } else {
    commentIssue(HOME, blindExisting.number, `Still blind: ${RUN_URL}`);
    console.log("instrument blind — still-blind comment posted");
  }
  process.exit(0);
}
if (blindExisting) {
  closeIssue(HOME, blindExisting.number, `Instrument sees its surfaces again: ${RUN_URL}`);
  console.log(`closed lingering blind issue #${blindExisting.number}`);
}

// --- Per-check leg: FAIL opens/comments on the OWNING repo, PASS closes. ---
const owners = [...new Set(results.checks.map((c) => c.owner))];
const openByOwner = new Map<string, ReturnType<typeof listIssuesByLabel>>();
for (const owner of owners) {
  ensureLabel(owner, LABEL, LABEL_DESC, LABEL_COLOR);
  openByOwner.set(owner, listIssuesByLabel(owner, LABEL, "open"));
}

let opened = 0;
let closed = 0;
for (const check of results.checks) {
  const title = `[surface-canary] ${check.name} failing`;
  const existing = (openByOwner.get(check.owner) || []).find((i) => i.title === title);
  if (check.outcome === "FAIL") {
    if (!existing) {
      openIssue(
        check.owner,
        LABEL,
        title,
        `Surface canary regression: **${check.name}** (${check.class}) — ${check.evidence}. Run: ${RUN_URL}`,
      );
      opened++;
      console.log(`OPENED on ${check.owner}: ${title}`);
    } else {
      commentIssue(check.owner, existing.number, `Still failing: ${check.evidence} (${RUN_URL})`);
      console.log(`still failing on ${check.owner}#${existing.number}: ${check.name}`);
    }
  } else if (check.outcome === "PASS" && existing) {
    closeIssue(check.owner, existing.number, `Cleared: ${check.evidence} (${RUN_URL})`);
    closed++;
    console.log(`CLOSED on ${check.owner}#${existing.number}: ${check.name}`);
  }
}
console.log(`reconcile complete: ${opened} opened, ${closed} closed, ${results.checks.length} checks`);
