# box-patch-id: observe-only lap of the patch-id binding (ops-pipeline#190 rollout step 3)

**Status:** build complete this session, pre-PR verified live in the worktree · **Owner:** Mechanic
seat (board row 807) · **Date:** 2026-09-19/20
**Ruling:** brain `library/supplementary-regulations/2026-09-19-the-box-binds-to-the-patch-id.md`
("The box binds to the patch-id, not the sha," RULED 2026-09-19 19:2xZ, Kevin, board card 808,
option A) · **Tracks:** https://github.com/studio-b-ai/ops-pipeline/issues/190

## What this PR is

Rollout step 3 of six, and only step 3:

> 3. One pull request carrying this ruling, `scripts/lib/box-patch-id.ts`, the labeled handler and
>    the check-run record, observe-only for one lap. It tracks
>    https://github.com/studio-b-ai/ops-pipeline/issues/190.

The position predicate in `scripts/lib/label-authority.ts` still governs the box label alone. Nothing
in this PR strips or keeps `box` on any signal but the one that already governs it today. This PR
does **not** implement rollout steps 4 (the six controls run live), 5 (`boxPatchIdWins` flips true in
ops-pipeline) or 6 (power-unit, then the hourly lap) — those are later rungs, each gated on the
receipts the prior rung produced.

## What is built

| unit | file(s) | what it does |
|---|---|---|
| 1 | `scripts/lib/box-patch-id.ts` + `scripts/lib/__tests__/box-patch-id.test.ts` | Computes the `bp2:` patch-id per the ruling's recipe (hermetic `-U0` diff piped through `git patch-id --stable`, normalized-hunk-header hash for whitespace churn, raw-diff hash for blob identity), optionally HMAC-tagged with `BOX_PATCH_ID_KEY`. Reads a recorded patch-id back from a check run's `output.text`. Never throws — every failure mode returns a typed refusal. |
| 2 | `.github/workflows/box-patch-id-labeled.yml` + `scripts/box-patch-id-labeled.ts` | The `pull_request: [labeled]` handler the ruling calls for in "Where the patch-id is recorded." Mints via unit 1, records a `box-patch-id` check run on the labeled sha plus a marked, write-only PR comment. Skips minting entirely for a `isGateAuthorizedActor`-covered actor, per the ruling's "a patch-id may only preserve an authority a human granted." |
| 3 | `scripts/lib/label-authority.ts` + `scripts/lib/__tests__/label-authority.test.ts` | Adds two optional `AuthorityInput` fields (`boxPatchId`, `boxPatchIdWins`, defaulting false) and a log-only comparison at the existing Step 3 staleness gate. The comparison is written only to `console.error`; the function's returned `AuthorityVerdict` is unchanged for every caller in this repo, proven by six new tests including two that spy on the log call itself (Rule #464 — a guard's first live firing is part of its ship, not presumed). |
| 4 | this file | The build record and the six-controls table below, carried forward with an empty receipt column for rollout step 4. |

Per Rule #235, the predicate change (unit 3) and this document travel in the same pull request as
units 1 and 2 — all four are one PR.

## Six controls (ruling § Controls, planted in production, not in tests)

None of these six is planted or fired by this PR. They belong to rollout step 4, which runs only
after this observe-only lap ships and is read. The table is carried here verbatim from the ruling
with one addition: an empty **receipt** column, to be filled with the firing workflow run's id when
step 4 actually plants each one.

| control | planted | required verdict | receipt |
|---|---|---|---|
| 1 | a live ops-pipeline pull request behind its base, refreshed by a lap | `kept`, merge pinned to the new head | _(pending — rollout step 4)_ |
| 2 | one changed comment line pushed to a keyed head | `stripped`, path named | _(pending — rollout step 4)_ |
| 3 | one added line re-indented, whitespace only | `stripped` | _(pending — rollout step 4)_ |
| 4 | a change landed on the base in a non-adjacent region of the same file | `kept` | _(pending — rollout step 4)_ |
| 5 | the diff pointed at a nonexistent ref | `box-patch-id-uncomputable` | _(pending — rollout step 4)_ |
| 6 | a seat pushes a commit leaving the net diff unchanged | `stripped` | _(pending — rollout step 4)_ |

Control 1 is the known-good Rule #471 requires, because this guard's default verdict is stale and
every stale test passes on a guard that can only say stale. Controls 2, 5 and 6 are the known-bads
Rule #464 requires. Control 6 also proves the patch-id never excuses a push in general, only a
refresh the sweep itself performed.

## Verified live this session (in the worktree, pre-PR)

- `npm run typecheck` — clean, after each of units 1, 2 and 3.
- `npm test` — full suite green after each unit; final run: 56 files, 2018 tests passed (see
  `verify_output_tail` in this build's handoff).
- `npx vitest run lib/__tests__/label-authority.test.ts` — 67/67 passed (61 pre-existing + 6 new),
  with the observe-only log line visibly firing in the captured `stderr` for the "proves the branch
  is live" test.
- `.github/workflows/box-patch-id-labeled.yml` parses cleanly under `yaml.safe_load` (no in-repo YAML
  lint step exists to run instead; GitHub Actions itself is the only real syntax oracle, and this
  workflow has not yet fired live — see open items below).

None of the above is a live firing of the new workflow itself: `box-patch-id-labeled.yml` has never
executed against a real `box` LabeledEvent on this repo. That first firing, whenever a maintainer
applies `box` to a pull request after this PR merges, is this guard's actual ship moment per Rule
#464 — this build is "deployed, unproven" until it is observed.

## Open items (not fixable from this worktree)

- **`BOX_PATCH_ID_KEY` does not exist yet as an ops-pipeline repo secret.** Per the ruling's Open
  item 1, minting it is Kevin's hand. `mintBoxPatchId` and the new workflow both read it from the
  environment only, as the caller (Rule #79), and fail closed to shipping the patch-id **untagged**
  (relying on the check run alone, which a collaborator cannot edit) rather than refusing to mint,
  exactly as the ruling's decline path states.
- **`boxPatchIdWins` defaults to `false` and nothing in this PR sets it `true`.** No caller in this
  repo passes `boxPatchId` or `boxPatchIdWins` to `evaluateLabelAuthority` yet; the new fields exist
  on `AuthorityInput` only so flipping the flag in rollout step 5 is a call-site change, not another
  signature change.
- **`studiob-fleet-bot`'s `checks:write` scope is unconfirmed.** The App's permission list recorded
  live 2026-08-31 in `docs/plans/2026-08-31-ops250-squasher-fleet-sweep.md` (§ Fleet App permissions)
  reads `actions:write · checks:read · contents:write · issues:write · members:read · metadata:read ·
  organization_administration:read · pull_requests:write · workflows:write` — `checks:read` is
  listed, `checks:write` is not. If that holds true today, the new workflow's `POST
  repos/{owner}/{repo}/check-runs` call 403s on its first live firing. This cannot be verified or
  granted from this worktree (GitHub App installation permissions are Kevin's hand); flagged here and
  in this PR's body rather than assumed.

## Rollout step 4 — the control kit and its runbook

Six zsh scripts under `scripts/box-patch-id-controls/` (`control-1-refresh-kept.zsh` through
`control-6-no-net-diff.zsh`, sharing `_kit.zsh`, harvested by `harvest-receipt.zsh`) plant, push,
observe and harvest each of the six controls in the table above. This build only ships and
dry-run-tests the scripts; it does not plant a single probe PR — that is a later, live sitting, once
a human is ready to apply the box by hand.

### Runbook

Each control script takes `<plant|push|observe|harvest> [--dry-run] [pr-number] [run-id]`:

1. `plant` — cuts a fresh worktree off `origin/main` (Rule #460), writes the control's planted line
   into `docs/plants/2026-09-21-box-patch-id-control-kit.md` (built by a sibling unit, plan section
   H), commits, pushes, and opens the probe PR. `kit_assert_single_file_diff` refuses anything but a
   single-file diff, and refuses a `.gitattributes` path outright.
2. **A human applies `box`** to the opened PR — the single human merge key, never scripted here
   (Rule #97; `kit_forbid_check` refuses any `--add-label box`, `--remove-label box`, `pr merge`, or
   REST `/merge` call at the `run_cmd` layer, unconditionally, for every script in this kit).
3. `push <pr-number>` — plants the control's after-the-box change (a rewrite, a re-indent, a second
   commit pair, or, for control 4, a sibling base-edit PR) and pushes.
4. `observe <pr-number>` — dispatches `box-patch-id-observe.yml` (built by a sibling unit, plan
   section E) and resolves the firing run id.
5. `harvest <pr-number> <run-id>` — greps the run's own log for the
   `[box-patch-id observe-only] control=<n>` line, fails loud on zero matches (Rules #401/#465, never
   a silent pass), reads the `verdict=` token, cross-checks the `box-patch-id-observe` check run's
   conclusion on the resolved head sha, and rewrites ONLY that control's receipt cell in this file's
   table above — via a `python3` table pass, never a blind `sed` — to
   `` run [<run-id>](<run-url>) · `<verdict>` · check-run <conclusion> ``.

Every `git`/`gh` call in the kit routes through `_kit.zsh`'s `run_cmd`, which prints the exact
command under `DRY_RUN=1` (the default) and only executes it under `DRY_RUN=0`. This build tested
every script's five subcommands (`plant`/`push`/`observe`/`harvest`, plus bare usage) in dry-run
only — the printed git/gh commands are the evidence; no probe PR was opened.

### Both-directions coverage (Rule #322)

An instrument that can only reject proves nothing. This kit plants exactly two known-goods and four
known-bads, so a single receipt sweep proves the guard in both directions before rollout step 5 is
allowed to lean on it:

| verdict | controls | proves |
|---|---|---|
| known-good (`kept`) | 1, 4 | the guard does not default to reject-everything (Rule #471) |
| known-bad (`stripped` / `box-patch-id-uncomputable`) | 2, 3, 5, 6 | the guard actually rejects a real divergence, not just passes everything through |

Control 4 is paired explicitly against control 2 as the minimal pair that proves the instrument
distinguishes them: both touch the same file after the box, but control 4's edit lands in a
non-adjacent region (must be `kept`) while control 2's edit rewrites the very line the box was
recorded against (must be `stripped`). Control 3 (a pure whitespace re-indent) is a known-bad
alongside 2, 5 and 6 — not a third known-good — because a `-U0` patch-id is sensitive to whitespace
churn by the ruling's own recipe, so re-indenting a planted line is expected to strip, the same as a
content rewrite.

### Two receipts this table will carry as partial, not stale

- **Control 1's merge half is deferred to rollout step 5.** This build's `push` case for control 1
  intentionally never pushes a hand refresh — the control's whole premise is a PR that the fleet's
  own automated update-branch route refreshes, never a manual push. The receipt this control
  produces in step 4 covers only the `kept`-verdict half (the patch-id survives that refresh); the
  merge itself, and proof the surviving patch-id actually governed it, is step 5's own receipt, once
  `boxPatchIdWins` flips true. Do not read control 1's step-4 receipt as covering the merge.
- **Control 5 fires through a dispatch, never a `box` labeled event.** Per the amendment recorded in
  `control-5-nonexistent-ref.zsh`'s header, the probe PR is deliberately never boxed — a nonexistent
  ref can't be reached through the normal labeled-event mint path (predicate order returns
  `box-patch-id-missing` first when no recorded check run exists). `observe`/`harvest` instead
  dispatch `box-patch-id-observe.yml` with `mode=mint-dry` and an explicit `head_sha_override`, a
  mode this kit's sibling unit (plan section E, out of this PR's scope) must implement before control
  5 can be fired for real. Carry this fidelity caveat into the receipt cell verbatim, not just the
  verdict word.

### A bug this build found and fixed before it could ship

Every plant/push case, as first drafted, only printed a "would append/rewrite ..." message with no
file mutation behind it — in live mode `git commit` would find nothing staged, every single time.
Caught by a full code-reading audit (dry-run testing alone cannot catch this, since it never executes
the mutation branch at all — Rule #223). Fixed by adding three shared helpers to `_kit.zsh`
(`kit_write_line`, `kit_replace_line`, `kit_remove_line`), each a no-op under `DRY_RUN=1` and each
failing loud (`kit_die`) on a missing anchor or file rather than silently no-op-ing (Rules
#401/#465). Verified live against a scratch fixture doc, in both directions per Rule #322: the
positive path (insert into a named section, replace an existing line, insert into a second section,
remove a line) and all three negative controls (a missing heading, a missing replace-match, a
missing remove-match each correctly refuse with a non-zero exit).

A second bug surfaced during that same live test: zsh ties its special array `path` to the scalar
`$PATH`, so the helpers' first draft (`local path="..."`) silently corrupted `$PATH` inside their own
function scope, making every subsequent command in that scope — `python3` included — fail with
"command not found" even though `$PATH` was correct everywhere else in the process. Fixed by
renaming the local to `target_path`; re-verified with the same positive-path-plus-three-negative-
controls test above.
