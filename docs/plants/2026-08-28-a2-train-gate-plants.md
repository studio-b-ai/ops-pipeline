# A2 train:ready gate — both-direction plants (Rules #464/#471)

Doc §5 of `docs/plans/2026-08-28-automerge-b-plus-a-v2.md`: the A-side gate is
DEPLOYED-UNPROVEN until a planted known-GOOD merges through it and a planted
known-BAD (label-then-push staleness) is refused with the label stripped.

## Plant 1 — known-GOOD (this PR)

This file IS the plant: a trivial docs-only PR, `train:ready` applied by an
authority login, evaluated via `workflow_dispatch` on `automerge-sweep.yml`.
Expected: sha-pinned merge + authority receipt comment + telemetry line
`[train-gate-receipt] ... outcome=merged`. If you are reading this on `main`,
the plant passed — the merge that landed it is the receipt.

## Plant 2 — known-BAD (separate PR, never merges)

Same protocol, but a second commit is pushed AFTER the authorizing label event.
Expected: `train:ready` stripped + stale-removal receipt comment + telemetry
`outcome=stale-label-removed`, regardless of CI state on the new sha (the
codex pass-2 P2 fix — stale-label authority runs before CI/mergeability
refusal). The PR is then closed by hand; receipts recorded below by follow-up.

## Receipts

Both directions proven 2026-08-28 — the gate is live on ops-pipeline per
Rules #464/#471 (no longer "deployed, unproven").

- **Plant 1 — PASSED** 05:47:48Z: PR #213 merged AUTONOMOUSLY by the gate
  (sha-pinned squash of `954a815`). Receipt comment on the PR carries the full
  leg table — authority: `train:ready` LabeledEvent by kbibelhausen at timeline
  position 1; merge-readiness + CI rollup clean; independent review exactly
  CLEAN. Telemetry: `[train-gate-receipt] repo=studio-b-ai/ops-pipeline pr=213
  outcome=merged`.
- **Plant 2 — PASSED** 05:50:10Z: PR #214 (closed by hand afterward, never
  merged): `train:ready` STRIPPED with a stale-removal receipt comment naming
  the mechanism — "a PULL_REQUEST_COMMIT event at position 3 sits AFTER the
  authorizing train:ready LabeledEvent at position 2 (applied by
  kbibelhausen)"; evaluated sha `06c642ba`. Telemetry:
  `outcome=stale-label-removed`. The sweep was dispatched while CI was still
  PENDING on the new sha — directly proving the codex pass-2 fix (stale-label
  authority runs ahead of the CI/mergeability refusal, so a label-then-push
  never leaves a stale authorization sitting on a red/pending PR).
