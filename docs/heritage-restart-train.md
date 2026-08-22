# Heritage Restart Train — Rung 0 (dry-run scheduler)

**Status:** rung 0 of `ops-pipeline#172`. Dry-run only — fires nothing.

## What rung 0 does

A GHA cron (`.github/workflows/heritage-restart-train.yml`, every 5 minutes, plus `workflow_dispatch`) computes:

- **Clearance anchor** — the latest of: last client-asthetik acuops production `deploy` job's `completed_at` · last studiob-api Railway deployment SUCCESS · newest human `END <ISO>` posted on client-asthetik#280.
- **Window law** — restarts must land ≥30 min apart · client-asthetik tickets only fire outside 06:00–18:00 America/New_York Mon–Fri (mirrors the acuops-deploy.yml business-hours gate) · nothing 05:45–08:15Z (batch blackout) · one ticket in flight at a time · no hold (`train:hold` label on `ops-pipeline#172`, or env `HERITAGE_TRAIN_HOLD=1`).
- **FIFO queue** — `train:ready`-labeled PRs across `studiob` + `client-asthetik`, head-pinned at label time (a push after labeling invalidates the pin); `train:after` reorders; `train:consolidate` rides with the ticket ahead of it.

It posts `PLAN (dry-run)` lines to `--target` (default `studio-b-ai/ops-pipeline#172` — **never** `client-asthetik#280`, which stays the human ledger until rung 5).

## What rung 0 does NOT do

- Does not merge, label, or touch any PR in `studiob` or `client-asthetik`.
- Does not fire anything — `--fire` throws `"rung 3 not built"` unconditionally; dry-run is the only mode this build supports.
- Is gated by a repo variable: the cron job runs only under `if: vars.HERITAGE_TRAIN_ENABLED == 'true'`. **Live since 2026-08-20T00:39Z** — the variable was set to `true` that night (`gh variable list --repo studio-b-ai/ops-pipeline`), and the scheduler has been posting to `ops-pipeline#172` since (first live `HELD` receipt from `studiob-fleet-bot` 2026-08-21T19:55Z, while a `train:hold` was on the tracker). Unsetting it (or setting anything other than `true`) makes every tick no-op again.
- Does not post to client-asthetik#280 (the human calendar) — only to `--target`.

## Ladder above rung 0 (from `ops-pipeline#172`)

1. **Rung 1 — mode B (sequence-and-page).** Posts `CLICK DUE` on one real ticket + pages the manager/Kevin at the computed slot; a human still merges.
2. **Rung 2 — planted controls (#464/#471).** A known-bad ticket (head moved after label) must be REFUSED; a known-good low-blast ticket must fire at its slot. Both receipts land on `#172` before rung 3 opens.
3. **Rung 3 — mode A live (Kevin-gated).** Sha-pinned squash-merge via the fleet App token at the computed slot; observes the real terminal state (Railway deployment terminal + `/health` 200 for studiob; push-run `deploy` job conclusion for client-asthetik) before posting `END`.
4. **Rung 4 — squasher amendment.** `pr-automerge-gate.ts` (or its successor) honors `train:hold` unconditionally; studiob deploy-path PRs may become train tickets instead of immediate squash-merges, pending a read of the Railway dashboard watch scope.
5. **Rung 5 — retire human duty.** The hand-posted PLAN/START/END lines on client-asthetik#280 stop for pipeline-visible events; the hold marker becomes the only valid deploy-hold form.

## Canon

- Design v0 — brain `library/architecture/2026-08-19-heritage-restart-train-design.md` (`69c45ccf`)
- Decision (LOCKED, merge-authority option A) — brain `library/decisions/2026-08-19-heritage-restart-train-merge-authority-label-gated.md` (`9628252e`)
- Tracker — `ops-pipeline#172`

## Env / vars

| Name | Kind | Purpose |
|---|---|---|
| `HERITAGE_TRAIN_ENABLED` | repo variable | Job-level gate. Absent/false means the cron is inert. |
| `HERITAGE_TRAIN_HOLD` | env (or `train:hold` label on `#172`) | Hold marker, checked before every tick. |
| `FLEET_APP_ID` / `FLEET_APP_PRIVATE_KEY` | secrets | Mint the `studiob-fleet-bot` installation token used for reads (and, from rung 3, merges). |
| `RAILWAY_API_TOKEN` | secret | Reads studiob-api deployment state on the `studiob-platform` project. |
| `--target` (flag) | worker arg | Where PLAN lines post. Default `studio-b-ai/ops-pipeline#172`. |
| `--fire` (flag) | worker arg | Always throws in this build; reserved for rung 3. |

## App-permission dependency

`studiob-fleet-bot`'s GitHub App installation was granted `pull_requests:write`, `contents:write`, `checks:read`, `actions:write`, `workflows:write` (plus `issues:write`, `metadata:read`) on 2026-08-19 ~21:52Z (Rule #78 — Kevin's UI-only grant). Rung 0 only needs read scopes; the write scopes are provisioned ahead of rung 1+. The worker still classifies any `READ_DENIED:<scope>` response defensively, in case a future token narrows again.
