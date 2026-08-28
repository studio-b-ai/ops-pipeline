# Heritage Restart Train — Rung 0 + Rung 1 (label authority + paging)

**Status:** rung 0 (dry-run scheduler) plus rung 1 — both legs — of `ops-pipeline#172`: Leg A
(kill the D1 comment-text-authority defect in ticket assembly) and Leg B (mode B,
sequence-and-page — post `CLICK DUE` and let a human click merge). Still fires nothing: no merge
capability exists in this build. `--fire` throws `"rung 3 not built"` unconditionally.

## What this build does

A GHA cron (`.github/workflows/heritage-restart-train.yml`, every 5 minutes, plus
`workflow_dispatch`) runs `restart-train.ts` with `--post --page` on every trigger.

### Rung 0 — dry-run scheduling

- **Clearance anchor** — the latest of: last client-asthetik acuops production `deploy` job's
  `completed_at` · last studiob-api Railway deployment SUCCESS · newest human `END <ISO>` posted
  on client-asthetik#280.
- **Window law** — restarts must land ≥30 min apart · client-asthetik tickets only fire outside
  06:00–18:00 America/New_York Mon–Fri (mirrors the acuops-deploy.yml business-hours gate) ·
  nothing 05:45–08:15Z (batch blackout) · one ticket in flight at a time · no hold (`train:hold`
  label on `ops-pipeline#172`, or env `HERITAGE_TRAIN_HOLD=1`).
- **FIFO queue** — `train:ready`-labeled PRs across `studiob` + `client-asthetik`, head-pinned at
  label time (a push after labeling invalidates the pin); `train:after` reorders;
  `train:consolidate` rides with the ticket ahead of it.
- Posts `PLAN (dry-run)` lines to `--target` (default `studio-b-ai/ops-pipeline#172` — **never**
  `client-asthetik#280`, which stays the human ledger until rung 5).

### Rung 1 Leg A — label authority (kills D1)

`train:ready` authority no longer comes from parsing a comment's text/timestamp — it comes from
GitHub-attributed GraphQL timeline events (`scripts/lib/label-authority.ts`, the `timelineItems`
query), which the labeler cannot spoof by editing a comment body after the fact:

- AUTHORIZED builds a `Ticket` whose `labeledAt` is the authorizing `LabeledEvent`'s server
  `createdAt`, and whose `pinnedHeadSha` is the head observed at this same fetch (AUTHORIZED
  already certifies no push landed after labeling).
- STALE (a push landed after the label) strips the `train:ready` label and posts a write-only
  receipt comment **on the ticket's own PR** — never silently excluded like v1's D1 behavior.
- Any other refusal (bot actor, unauthorized actor, `train:hold` present, no ready label,
  truncated/empty timeline, a timeline fetch error) excludes the PR for that tick with one log
  line — never fabricated, matching this worker's original fail-closed posture.

### Rung 1 Leg B — paging (`CLICK DUE`)

Behind `--page` (independent of `--post`; wired unconditionally into the cron invocation
alongside `--post`). Once, for the queue head only:

1. its window is CLEAR (rung 0's window law, above),
2. nothing is already in flight — no previously posted `CLICK DUE` whose own stamp is still newer
   than the current clearance anchor (`isClickDueStillInFlight`, fails CLOSED on any parse
   ambiguity), and
3. its CI rollup is green (`state=OPEN`, not draft, `mergeStateStatus=CLEAN`, checks clean —
   `evaluateMergeReadiness`, the same predicate `pr-automerge-gate.ts` uses),

the worker posts exactly ONE `CLICK DUE` comment on the queue-head PR itself (plus a mirror on
`--target`), asking a human to click merge. A red/pending rollup posts a HELD-style deduped line
on `--target` only instead (Rule #89 — never page a human to a red-CI PR; reuses the same
`postHeldIfNotDuped` rung 0 already posts HELD through, so there's no separate HELD posting
primitive for Leg B). `CLICK DUE` only ever **asks** a human to click merge; it never clicks for
them — that capability doesn't exist until rung 3.

## What this build does NOT do

- Does not merge any PR, ever — `--fire` throws `"rung 3 not built"` unconditionally; dry-run
  scheduling plus label-authority plus paging is the entire capability surface of this build.
- Does not touch branch protection.
- Does not post to client-asthetik#280 (the human calendar) under any leg — it stays a
  READ-ONLY source. Writes land on `--target` (PLAN, HELD — both leg-0-style and Leg B's
  rollup-not-green case — plus the `CLICK DUE` mirror) and, for Leg A's stale-label receipts and
  Leg B's `CLICK DUE`, additionally on the ticket's own PR — never `#280`. HELD lines are
  `--target`-only; they never land on a ticket's own PR.
- ⚠️ Unlike rung 0 alone, this build DOES touch a PR's labels (strips a stale `train:ready`, Leg
  A) and DOES comment on PRs beyond `--target` (Leg A's stale-label receipts, Leg B's `CLICK
  DUE`) — both strictly narrower than a merge and both gated behind `--post`, same as every other
  write this worker makes.
- Is inert by default: the cron job is gated `if: vars.HERITAGE_TRAIN_ENABLED == 'true'`; that
  repo variable does not exist yet, so the workflow no-ops on every trigger until someone
  deliberately sets it.

## Ladder (from `ops-pipeline#172`)

1. ~~**Rung 1 — mode B (sequence-and-page).**~~ **DONE, this build.** Leg A kills the D1 defect
   (comment-text authority) in ticket assembly. Leg B posts `CLICK DUE` on the queue head + a
   mirror on `--target` at the computed slot; a human still clicks merge.
2. **Rung 2 — planted controls (#464/#471).** A known-bad ticket (head moved after label) must be
   REFUSED; a known-good low-blast ticket must fire at its slot. Both receipts land on `#172`
   before rung 3 opens.
3. **Rung 3 — mode A live (Kevin-gated).** Sha-pinned squash-merge via the fleet App token at the
   computed slot; observes the real terminal state (Railway deployment terminal + `/health` 200
   for studiob; push-run `deploy` job conclusion for client-asthetik) before posting `END`.
4. **Rung 4 — squasher amendment.** `pr-automerge-gate.ts` (or its successor) honors `train:hold`
   unconditionally; studiob deploy-path PRs may become train tickets instead of immediate
   squash-merges, pending a read of the Railway dashboard watch scope.
5. **Rung 5 — retire human duty.** The hand-posted PLAN/START/END lines on client-asthetik#280
   stop for pipeline-visible events; the hold marker becomes the only valid deploy-hold form.

## Canon

- Design v0 — brain `library/architecture/2026-08-19-heritage-restart-train-design.md`
  (`69c45ccf`)
- Decision (LOCKED, merge-authority option A) — brain
  `library/decisions/2026-08-19-heritage-restart-train-merge-authority-label-gated.md`
  (`9628252e`)
- Tracker — `ops-pipeline#172`
- Rung-1 ruling (this build's scope: kill D1 + mode B sequence-and-page) —
  `ops-pipeline#172` issue comment `5457035760`

## Env / vars

| Name | Kind | Purpose |
|---|---|---|
| `HERITAGE_TRAIN_ENABLED` | repo variable | Job-level gate. Absent/false means the cron is inert. |
| `HERITAGE_TRAIN_HOLD` | env (or `train:hold` label on `#172`) | Hold marker, checked before every tick. |
| `FLEET_APP_ID` / `FLEET_APP_PRIVATE_KEY` | secrets | Mint the `studiob-fleet-bot` installation token used for reads and this build's writes (label strip, comments). |
| `RAILWAY_API_TOKEN` | secret | Reads studiob-api deployment state on the `studiob-platform` project. |
| `--target` (flag) | worker arg | Where PLAN/HELD/CLICK-DUE-mirror lines post. Default `studio-b-ai/ops-pipeline#172`. Refused if pointed at `client-asthetik#280` (read-only calendar). |
| `--post` (flag) | worker arg | Default false. Gates every write this worker makes: PLAN/HELD lines, Leg A's stale-label strip + receipt, Leg B's `CLICK DUE`. |
| `--page` (flag) | worker arg | Default false, independent of `--post`. Turns on Leg B's paging check (`maybePage`); wired unconditionally into the cron invocation. Omitting it leaves the worker at Leg-A-only behavior. |
| `--fire` (flag) | worker arg | Always throws in this build; reserved for rung 3. |

## App-permission dependency

`studiob-fleet-bot`'s GitHub App installation was granted `pull_requests:write`,
`contents:write`, `checks:read`, `actions:write`, `workflows:write` (plus `issues:write`,
`metadata:read`) on 2026-08-19 ~21:52Z (Rule #78 — Kevin's UI-only grant). Rung 0 alone only ever
needed read scopes; this build is the first to actually spend the write scopes — Leg A's stale
`train:ready` removal (`pull_requests:write`) and its receipt comment, plus Leg B's `CLICK
DUE`/HELD posts (`issues:write`) — both already covered by the 2026-08-19 grant, so this PR
requests no new permission. `checks:read` backs Leg B's queue-head rollup check
(`fetchQueueHeadRollup`). The worker still classifies any `READ_DENIED:<scope>` response
defensively, in case a future token narrows again.
