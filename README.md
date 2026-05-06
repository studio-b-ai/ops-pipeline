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

## Why this exists

Operations repos are canonical, but the surfaces ops people use day-to-day (Slack canvases, HubSpot UI) drift the moment the repo changes without manual mirror updates. This pipeline makes drift impossible (sync-on-push) and auditable (weekly drift-check) — without sacrificing the GitOps workflow that makes the repo trustworthy in the first place.

Pattern is the same one used by [`studio-b-ai/acuops-pipeline`](https://github.com/studio-b-ai/acuops-pipeline) for Acumatica deploys: one canonical engine, many consumer repos, all pinned `@v1` and moving together.
