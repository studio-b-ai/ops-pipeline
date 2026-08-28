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

- Plant 1: (this PR's merge — see the PR's own timeline)
- Plant 2: _pending — filled by the follow-up edit after plant 2 runs_

<!-- plant-2 vehicle: first commit — the authorizing label lands on THIS sha -->
