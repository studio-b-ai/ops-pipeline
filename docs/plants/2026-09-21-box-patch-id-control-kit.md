# box-patch-id observe-only control kit — plants & runbook (ops-pipeline#807 rollout step 4)

Companion to `docs/plans/2026-09-19-box-patch-id-observe-only-build.md`'s six-controls table
(plan section H). This file is the plant-target the six `scripts/box-patch-id-controls/control-*.zsh`
scripts write into, via `_kit.zsh`'s `kit_write_line` / `kit_replace_line` / `kit_remove_line`
primitives — it holds the literal lines each control plants and the runbook for firing them.
Verdict receipts land in the build doc's six-controls table (written by `harvest-receipt.zsh`), not
here — this file only ever grows a plant line or a runbook note.

## Controls table

| # | Shape | Script | Expected verdict | Disposition |
|---|-------|--------|-------------------|-------------|
| 1 | a live PR behind its base, made genuinely `DIRTY`, labelled `fleet-internal`, refreshed by the lap's own sweep (never a seat-driven `update-branch`) | `control-1-refresh-kept.zsh` | `kept` | MERGE |
| 2 | one HTML-comment marker line changed on a keyed head, after the box | `control-2-comment-line.zsh` | `stripped` | CLOSED UNMERGED |
| 3 | a whitespace-only push to a keyed head | `control-3-whitespace.zsh` | `stripped` | CLOSED UNMERGED |
| 4 | an unrelated base edit lands in a non-adjacent region of this same file | `control-4-base-nonadjacent.zsh` | `kept` | MERGE |
| 5 | a `mode` other than `observe` fired against a keyed head | `control-5-nonexistent-ref.zsh` | `box-patch-id-observe-unsupported-mode` | fails closed, never crashes (mode=mint-dry itself is a sibling unit's job — see that script's header) |
| 6 | add line Y then remove line Y — net diff byte-identical to pre-box, but the moved commit shas never land in the recorded record's `refreshShas` | `control-6-no-net-diff.zsh` | `stripped` | CLOSED UNMERGED |

Controls 2 and 4 are the both-directions pair (Rule #322): 2 proves a real content change made after
the box gets caught; 4 proves an unrelated base edit in a non-adjacent region of THIS file does not
falsely trip the same alarm. Control 6 is the control the `refreshShas` leg exists for (Rule #223
finding 4.0.1) — patch-id equality alone is not sufficient once a commit sha has moved out from
under the recorded record.

## Runbook

Every control script exposes the same four subcommands — `plant`, `push`, `observe`, `harvest` —
each accepting `--dry-run` (the kit's default; see `_kit.zsh`'s header). Fire them in this order,
one control at a time, never in parallel (Rule #101 shared-file sequencing — every control writes
this same file):

1. `plant` — cuts the control's branch, writes its plant line into the region named below, opens the
   probe PR as a draft via `kit_open_pr`. Never applies the `box` label itself.
2. Kevin (or the sanctioned labelling route) applies `box` to the probe PR by hand — `_kit.zsh`'s
   `kit_forbid_check` refuses any `box`-label/merge command from inside the kit (Rule #97 / #279
   exception 1, the NO-BOX/NO-MERGE guard).
3. `push` — for controls 2/3/6, lands the keyed-head change under test; for control 4, opens the
   sibling base-edit PR (labelled `bugsquasher`, lands via the squasher-fleet sweep, never a hand
   merge) after `kit_no_unharvested_box_elsewhere` confirms no sibling probe from this same row-807
   build still carries an unharvested box; for control 1, asserts the PR is genuinely
   `mergeStateStatus=DIRTY` and stops there — the lap's own sweep performs the refresh, never a
   seat-driven `update-branch`.
4. `observe` — dispatches `box-patch-id-observe.yml` via `kit_observe` and resolves the run id.
5. `harvest` — hands the run id to `harvest-receipt.zsh`, which greps the run log for the
   `[box-patch-id observe-only] control=<n> ...` line, reads the `box-patch-id-observe` check run's
   conclusion from the PR's current head via the Checks API, and writes the receipt cell into the
   build doc's six-controls table — never inferring a verdict from the probe PR's merge/close state
   (Rule #465, predicate-is-part-of-the-receipt).

`harvest-receipt.zsh --assert-negative` proves the harvester itself can detect an absent line before
any control's positive receipt is trusted (Rule #322 — both directions on the oracle, not only on
the thing under test).

## Plant lines

<!-- Controls 1, 2, 3, 5 and 6 each insert exactly one line immediately below this heading via
     kit_write_line (which skips this blank separator line), so new plants stack newest-on-top.
     Nothing below this comment is planted yet. -->

## Sequencing note

No control's `plant` has fired for real as of this PR (ops-pipeline#807 rollout step 4, PR #545) —
this PR ships the kit itself, dry-run only (`DRY_RUN` defaults to `"1"` in `_kit.zsh`). Firing any
control for real, and the `workflow_dispatch` that `kit_observe` relies on, can only happen once
`.github/workflows/box-patch-id-observe.yml` is on `main` — a `workflow_dispatch`-triggered workflow
cannot be dispatched from a ref where the workflow file itself doesn't yet exist on the default
branch. That is a separate, later lap, tracked in the build doc, not in this PR.

This section is intentionally never written to by any control script. It exists to keep the two
machine-checked regions above and below (`## Plant lines` and `## Base-edit region`) far enough
apart, and separated by an unmodified section, that their respective `-U0` diff hunks can never sit
adjacent or merge into one — `control-4-base-nonadjacent.zsh`'s `MIN_LINE_GAP=40` dry-run assertion
checks exactly that, against this file's own structure, before it ever opens the base-edit PR.

Firing order, once the kit is live on `main`:

1. Controls 1 and 4 (the known-goods) fire first, so the both-directions pair has a `kept` result
   on record before either known-bad runs — Rule #471 (plant the non-default-verdict control first
   on a fail-closed instrument, so the harness's positive case is proven before its negatives are
   trusted to mean anything).
2. Controls 2 and 3 (the plain known-bads) fire next, independently — order between the two does
   not matter, since neither shares a branch, a labelled PR, or a plants-doc region with the other.
3. Control 6 fires after 2 and 3 — it is the sharpest known-bad (net-diff-identical, moved-sha-only)
   and is easiest to read correctly once the plainer stripped cases already have receipts to compare
   against.
4. Control 5 (the unsupported-mode fail-closed case) can fire at any point after control 1 opens at
   least one keyed head to observe against — it needs a real PR to point `mode` at, not a specific
   verdict history.
5. `harvest-receipt.zsh --assert-negative` runs once, before control 1's real harvest, proving the
   harvester rejects an absent line — never after, and never skipped because the positive harvests
   "look right" on their own (Rule #322).

Kevin performs every `box` label application and every `bugsquasher` label application by hand (or
via the sanctioned labelling route) — this kit's own guard (`kit_forbid_check`) refuses to do either
for itself, by design (Rule #97 / #279 exception 1).

## Base-edit region

- control 4 base edit · 2026-09-22T03:15:39Z · non-adjacent region
<!-- Control 4's `push` step inserts its base-edit-branch line immediately below this heading, on
     the SIBLING `tp/807-control-4-base-edit` branch — never on control 4's own probe branch. This
     section must stay at least `MIN_LINE_GAP` (40) lines below "## Plant lines", separated by the
     "## Sequencing note" section above, so a `-U0` diff can never merge the two regions into one
     hunk. Nothing below this comment is planted yet. -->

## Receipts

Verdict receipts land in `docs/plans/2026-09-19-box-patch-id-observe-only-build.md`'s six-controls
table, written by `harvest-receipt.zsh` — never here. This section exists only for narrative notes
about a firing (a retry, an environmental caveat) that don't fit that table's one-cell-per-control
shape.

- No control has fired yet as of 2026-09-20 — this PR ships the kit itself (build only, no probes
  fired). Firing is a separate, later lap once `box-patch-id-observe.yml` is live on `main` (see
  the Sequencing note above).
