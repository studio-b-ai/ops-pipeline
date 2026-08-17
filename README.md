# studio-b-ai/ops-pipeline

Reusable GitHub Actions workflows for Studio B operations repos (marketing-ops, sales-ops, eng-ops, future per-brand variants).

Consumer repos pin `@v1` to get auto-sync from the canonical repo to downstream mirrors (Slack canvas, HubSpot pipeline + custom properties + workflows). Mirror logic lives here so all consumers move in lockstep when patterns evolve.

## Pattern

```
studio-b-ai/<role>-ops/                   ← canonical source of truth (per repo)
├── ops.yaml                              ← config: which canvas, channel, portal
├── infra/<system>.yaml                   ← canonical state for each integrated system
├── docs/canvas/*.md                      ← canvas-source mirrors
├── playbooks/, kpis/, templates/, ...    ← role-specific content
└── .github/workflows/
    ├── sync.yml                          ← uses: studio-b-ai/ops-pipeline/.github/workflows/sync.yml@v1
    └── drift-check.yml                   ← uses: studio-b-ai/ops-pipeline/.github/workflows/drift-check.yml@v1
```

## Reusable workflows

### `sync.yml`

Pushes consumer repo state to downstream mirrors. Triggered on every push to `main` in the consumer repo.

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch: {}

jobs:
  sync:
    uses: studio-b-ai/ops-pipeline/.github/workflows/sync.yml@v1
    secrets:
      SLACK_BOT_TOKEN: ${{ secrets.STUDIOB_SLACK_BOT_TOKEN }}
      HUBSPOT_ACCESS_TOKEN: ${{ secrets.HUBSPOT_ACCESS_TOKEN }}
```

Inputs:
- `checkout_ref` (optional, default `""`) — git ref of consumer repo to checkout
- `report_only` (optional, default `true`) — if true, sync-hubspot runs in report-only mode (no PATCH; just diff). Flip to `false` after a confidence period to enable auto-fix.

### `drift-check.yml`

Weekly probe. Diffs canonical repo state vs live downstream state. Posts drift to configured channel.

```yaml
on:
  schedule:
    - cron: "0 13 * * 1"   # Mondays 09:00 ET
  workflow_dispatch: {}

jobs:
  drift:
    uses: studio-b-ai/ops-pipeline/.github/workflows/drift-check.yml@v1
    secrets:
      SLACK_BOT_TOKEN: ${{ secrets.STUDIOB_SLACK_BOT_TOKEN }}
      HUBSPOT_ACCESS_TOKEN: ${{ secrets.HUBSPOT_ACCESS_TOKEN }}
```

## Required secrets in consumer repo

- `STUDIOB_SLACK_BOT_TOKEN` — `xoxb-…` from `studio_b_admin` Slack app with scopes:
  - `canvases:write` (canvas edits)
  - `chat:write` (drift notifications)
  - `channels:read`, `channels:join`
- `HUBSPOT_ACCESS_TOKEN` — `pat-na1-…` HubSpot Private App token with scopes:
  - `crm.schemas.contacts.read`, `crm.schemas.deals.read`
  - `automation` (workflows read)

## Required consumer repo files

| File | Purpose |
|------|---------|
| `ops.yaml` | Per-repo config: Slack canvas/channel IDs, HubSpot portal/pipeline IDs, drift-check channels, notification preferences |
| `infra/hubspot.yaml` | Canonical state of the HubSpot pipeline + custom properties + workflow names this repo manages |
| `docs/canvas/*.md` | Canvas-source files referenced by `ops.yaml.slack.canvas_source[]` |

For a working example, see [`studio-b-ai/marketing-ops`](https://github.com/studio-b-ai/marketing-ops) (the prototype consumer).

For a starting template, see [`studio-b-ai/ops-template`](https://github.com/studio-b-ai/ops-template).

## Versioning

- `v1` tag tracks the latest stable workflow + script set
- Consumer repos pin `@v1` (mutable major-version tag, fast-forwarded as patches land)
- Breaking changes bump to `@v2` with deprecation notice for `v1` consumers

## Spawning a new ops repo

```bash
# 1. Create from template
gh repo create studio-b-ai/<role>-ops --template studio-b-ai/ops-template --public

# 2. Edit ops.yaml (canvas ID, channel ID, HubSpot portal/pipeline IDs)
# 3. Edit infra/hubspot.yaml (codify your HubSpot state)
# 4. Set repo secrets (STUDIOB_SLACK_BOT_TOKEN, HUBSPOT_ACCESS_TOKEN)
# 5. Push to main → sync workflow auto-runs → canvas + HubSpot reconciled
```

Detailed runbook in [`studio-b-ai/marketing-ops/docs/runbooks/sync-mirrors.md`](https://github.com/studio-b-ai/marketing-ops/blob/main/docs/runbooks/sync-mirrors.md).

## Fleet monitors

Recurring GitHub Actions workers (distinct from the reusable `sync.yml`/`drift-check.yml`
workflows above) that read live fleet state and open/retitle/close ONE auto-reconciled
issue per finding-holder — the open-issue set IS the dedup state (Rule #165) — rather than
posting to a channel nobody reads (#60).

### `backlog-staleness` (ops-pipeline#136)

Daily instrument for LANES rule 17(d)'s per-manager backlog stall check. Reads every open
issue on each repo listed in `scripts/backlog-managers.yaml`, classifies it against that
file's `thresholds:`, and groups findings by the owning manager (CTO/CoS/CMO/COO/…).

**What it measures**, per repo:
- `p0p1-stale` — a P0/P1 issue untouched (by `updatedAt`) longer than `p0p1_days` (default 2)
- `p2-stale` — a P2 issue untouched longer than `p2_days` (default 14)
- `unranked` — an issue carrying none of P0–P3, open longer than `unranked_days` (default 3)
- `headless` — the repo has ranked (P0–P3) issues but none carries `next`
- `multi-next` — more than one issue carries `next` ("a head is one item")
- `labels-missing` — informational: the repo has open issues but P0–P3 don't exist as
  labels there at all

An issue carrying a `machinery_labels:` label (e.g. `bug`, `credential-monitor`) is
excluded from all of the above **only if it also carries no P0–P3 label** — once a human
prioritizes a monitor-opened issue with a P-label, it's ranked backlog like anything else.

**How a manager clears a finding:** re-rank it, escalate to the CoS with a recommendation,
or apply the missing label — the same rule-17 remedy line every finding's table row
carries. This worker never touches the finding's own issue (flags-only); it only
opens/retitles+comments/closes ITS OWN per-manager aggregate issue on
`studio-b-ai/ops-pipeline`, labeled `backlog-staleness`.

**Plant recipe** (Rules #464/#471 — verify both verdicts before trusting a "clean" run):

```bash
cd scripts
# known-bad: full fleet, force every currently-fresh P0-P2 to read as stale
npx tsx backlog-staleness-worker.ts --dry-run --now 2026-12-01T00:00:00Z
# known-good: full fleet, the real clock — reflects today's actual backlog-staleness state
npx tsx backlog-staleness-worker.ts --dry-run
# single-repo negative control: a repo scoped run against its manager's FULL repo set shows
# the real "would OPEN/UPDATE/CLOSE/NONE" preview; a PARTIAL scope for that manager instead
# prints "SKIPPING <action>" (codex pass-2 P2 guard — a partial --repos view must never mutate
# a manager's aggregate, since unscanned repos for that manager could still carry findings)
npx tsx backlog-staleness-worker.ts --dry-run --repos studio-b-ai/ops-pipeline
```

`--repos <csv>` scopes a run to a subset of the configured repos (useful for local testing
without a fleet App token — `gh`'s own ambient auth is enough for a single-repo dry run). Any
name absent from `backlog-managers.yaml` throws. A NON-dry-run scoped run additionally skips
mutating any manager whose scope is only partial — see the guard above.

### `backlog-compliance` (ops-pipeline#151)

Daily instrument for LANES rule 17(g): every session's git-tracked backlog must be first
ranked by the lane, then the manager, then the CoS, then Kevin. Reads
`studio-b-ai/brain`'s `LANES.md` row-by-row and, for each active row not listed in
`backlog-managers.yaml`'s `compliance.skip:`, checks its resolved brief
(`coldstarts/…md` or `library/backlogs/<slug>.md`) for a `## Backlog (ranked)` section, a
`ranked-by:` stamp, and shaped items. Full grammar + the checks table:
`library/product/2026-08-17-backlog-compliance-leg-design.md` (brain repo) — this worker
implements that doc, it does not restate it.

**What it measures**, per active non-skip row:
- `P1` — the resolved brief doesn't exist
- `P2` — the brief exists but has no `## Backlog (ranked)` section
- `P3` — the section exists but its `ranked-by:` stamp is missing/unparseable
- `F1` — the lane's own stamp is older than `lane_stamp_max_age_days` (default 7)
- `F2` — the row's rule-15 manager (if any) hasn't stamped, stamped as the wrong seat, or is
  lagging the lane stamp by more than `manager_lag_max_hours` (default 48) — SEAT rows have
  no rule-15 manager and are exempt from F2 entirely (a seat is its own manager)
- `F3` — the CoS stamp is missing or older than `cos_stamp_max_age_days` (default 7)
- `S1` — one or more items are missing a tier, an `owner`, or a clock (a date/weekday/`wk
  N`/`by …`/`≥…`/AM-PM token, or the literal `unclocked`) — a bare tracker-handle item (e.g.
  `1. ops#129`) fails both owner and clock, with no separate "prose" bucket

F2/F3 report `pending` (not a failure) before `manager_stamp_enforced_from` /
`cos_stamp_enforced_from` respectively — a ramp-up grace window, not a free pass forever.
Findings from a row's own git-tracked brief never reach GitHub issues on any OTHER repo; the
only issues this worker mutates are its own rollup or per-lane issues, both on
`studio-b-ai/brain`, labeled `backlog-compliance`.

**Rollup vs per-lane**: before `compliance.per_lane_issues_from`, every active non-skip row
lands as one row in a single standing rollup issue (body rewritten every run, no comment
spam — it's a refreshed checklist, not a sequence of alert events). At/after that date the
rollup closes for good and each non-compliant row gets (or keeps) its own issue instead,
gated on FAILED findings only — a lane with only `pending` findings stays clean.

**How a lane clears a finding:** fix the brief per the grammar (add the missing section/
stamp/item field) and let the next run re-evaluate — this worker never edits a brief itself,
it only reads.

**Plant recipe** (Rules #464/#471 — verify both verdicts before trusting a "clean" run):

```bash
cd scripts
# known-bad: force every stamp in the fleet to read as expired
npx tsx backlog-compliance-worker.ts --dry-run --now 2026-12-01T00:00:00Z
# known-good: the real clock — reflects today's actual compliance state
npx tsx backlog-compliance-worker.ts --dry-run
# single-lane negative control against the real vault checkout (no gh Contents-API round
# trip; --brain-dir never writes, LANES.md + briefs are read straight off disk)
npx tsx backlog-compliance-worker.ts --dry-run --brain-dir ~/Documents/brain --lanes CTO
```

`--lanes <csv>` scopes a run to a subset of `LANES.md`'s row names; any name that doesn't
match a real row throws. In rollup mode a partial `--lanes` scope skips the rollup mutation
outright (a partial checklist must never overwrite the complete one) — the cutover close and
per-lane mutations are unaffected, since each lane's own issue is independent. `--brain-dir
<path>` switches from the default GitHub Contents API mode (reads the pushed HEAD of
`compliance.brain_repo`) to reading a local checkout instead — used for the ship-gate
dry-run against the real vault; issue mutations still always go through `gh`, in both modes.
A `compliance.briefs:` key that matches no `LANES.md` row prints a `warn:` line every run,
never silently.

The 12:30Z **schedule** is gated on the `BACKLOG_COMPLIANCE_CI_ENABLED` repo variable (off by
default until ops#104's `studiob-fleet-bot` `contents:read` grant on `studio-b-ai/brain` lands)
— `workflow_dispatch` always runs regardless (issue #153 item 4).

## Why this exists

Operations repos are canonical, but the surfaces ops people use day-to-day (Slack canvases, HubSpot UI) drift the moment the repo changes without manual mirror updates. This pipeline makes drift impossible (sync-on-push) and auditable (weekly drift-check) — without sacrificing the GitOps workflow that makes the repo trustworthy in the first place.

Pattern is the same one used by [`studio-b-ai/acuops-pipeline`](https://github.com/studio-b-ai/acuops-pipeline) for Acumatica deploys: one canonical engine, many consumer repos, all pinned `@v1` and moving together.
