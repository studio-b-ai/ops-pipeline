# Org repo inventory + consolidation scaffold (ops-pipeline#21)

> Generated 2026-08-04 by the CTO seat. DATA for the dedicated consolidation
> sitting — mechanical signals only; the #293 classification judgment
> (Product / Internal Tooling / IP / Dead) is Kevin's, per item.
> Regenerate: `gh repo list studio-b-ai --limit 200 --json name,pushedAt,isArchived,diskUsage`

## Headline numbers

- **101 repos** · 24 archived · **14 pushed in the last 30 days** · **39 stale-active (90+ days)** · 24 dormant (30–90d)
- ⚠️ **Live Railway projects pointed at dormant repos** (the Rule #366 zombie class — infra billing for stopped work):
  `context-engine` (repo last push 2026-04-18) · `relay` (2026-04-19) · `nzt` (2026-04-26) · `shuttle` (2026-06-10) · `gi-lint` (2026-06-01)
  Each needs the full #366 leg check before retirement: Railway services, env vars, routines, crons, monitoring, credentials.
- Railway projects (from `railway list`): shuttle · gi-lint · studiob-platform · wasala-platform · aesthetik-production · context-engine · bolt-roth · relay · nzt · aesthetik-staging
- **wasala-platform**: 158GB static PD-modeling corpus on a WARN volume (ops-pipeline#12) — its disposition follows this classification: parked-IP ⇒ cold-store raw corpus to R2 (#117) + shrink volume.

## Branch-hygiene sweep — EXECUTED 2026-08-04

The org squash-merges, so `git branch --merged` sees almost nothing; the landed
class is "branch name has a MERGED PR". Deleted tonight, with the #328 guard
(never delete a branch an OPEN PR uses as head or base; open-PR counts verified
unchanged before/after in every repo):

| repo | local before → after | remote before → after |
|---|---|---|
| bolt-wms | 303 → 25 | 844 → 174 |
| studiob | 138 → 8 | 240 → 22 |
| webhook-router | 75 → 2 | 177 → 170 |
| ops-pipeline | 14 → 4 | 10 → 1 |

**~1,450 branches removed** (all merged-PR-backed). Remaining classes need
judgment, not automation: closed-unmerged-PR branches (abandoned work) and
never-PR'd branches (webhook-router's `delegation/*` auto-branches are most of
its 170). Those ride the dedicated sitting.

## Retirement runbook (Rule #366 — every leg, same pass)

Per retired repo, in order:

1. **Inventory the legs**: Railway services + volumes · env vars referencing it · claude.ai routines whose sources/prompts name it · GHA crons (its own AND other repos' workflows calling it) · monitors watching it · npm packages it publishes · DNS at hosts it serves
2. **Kill consumers first**: routines deleted, crons disabled, callers repointed
3. **Credentials**: revoke tokens it held (gateway tokens via `gateway-revoke-token.ts`); check BOTH stores per #99
4. **Data**: cold-store anything worth keeping to R2 (#117) BEFORE deleting volumes
5. **Railway**: delete services/volumes (GraphQL `serviceDelete`; volumes resize/delete dashboard-only per #435)
6. **Archive the repo** (never delete) — and update the CLAUDE.md repo map in the same pass (#235)
7. **Receipt**: one comment on the tracking issue naming every leg killed

The zoomhub precedent is why step 2 precedes step 6: a drift routine fired daily
for ~2 months against a deliberately-deleted endpoint, with live credentials in
its prompt.

## Full inventory (newest push first)

| repo | last push | state | size |
|---|---|---|---|
| webhook-router | 2026-08-04 | active | 18MB |
| studiob | 2026-08-04 | active | 3MB |
| bolt-wms | 2026-08-04 | active | 62MB |
| asthetik-trade-theme | 2026-08-04 | active | 58MB |
| ops-pipeline | 2026-08-04 | active | 0MB |
| brain | 2026-08-04 | active | 12MB |
| acuops-website | 2026-08-04 | active | 1MB |
| client-asthetik | 2026-08-04 | active | 3MB |
| studiob-price-sync | 2026-08-04 | active | 0MB |
| clients | 2026-08-03 | active | 0MB |
| aesthetik-portal | 2026-07-30 | active | 0MB |
| asthetik-redirect | 2026-07-18 | active | 0MB |
| acuops-pipeline | 2026-07-11 | active | 1MB |
| ui-test-suite | 2026-07-06 | active | 0MB |
| enhancement-executor | 2026-06-27 | active | 0MB |
| switchboard-app | 2026-06-11 | active | 3MB |
| shuttle | 2026-06-10 | active | 0MB |
| quarterbook | 2026-06-08 | active | 0MB |
| support-agent | 2026-06-08 | active | 0MB |
| ots-puller | 2026-06-02 | active | 0MB |
| gi-lint | 2026-06-01 | active | 0MB |
| acumatica-lint | 2026-06-01 | active | 0MB |
| client-smoke-test-002 | 2026-05-24 | ARCHIVED | 2MB |
| acuops-cli | 2026-05-24 | active | 0MB |
| enhancement-portal | 2026-05-24 | active | 0MB |
| client-smoke-test-001 | 2026-05-24 | ARCHIVED | 0MB |
| bootstrap | 2026-05-23 | active | 0MB |
| acuops-hub | 2026-05-23 | active | 0MB |
| markdown-b-studio | 2026-05-21 | active | 0MB |
| Acuminator | 2026-05-20 | active | 30MB |
| claude-plugins | 2026-05-16 | active | 0MB |
| amplify | 2026-05-16 | active | 1MB |
| acuops | 2026-05-10 | active | 0MB |
| b-studio-website | 2026-05-10 | active | 0MB |
| studiob-agents | 2026-05-10 | active | 0MB |
| amplify-website | 2026-05-10 | active | 0MB |
| lmmi-b-studio | 2026-05-09 | active | 0MB |
| marketing-ops | 2026-05-07 | active | 0MB |
| invest-b-studio | 2026-05-06 | active | 0MB |
| ops-template | 2026-05-06 | active | 0MB |
| dli-b-studio | 2026-05-05 | active | 0MB |
| acudev | 2026-05-04 | active | 1MB |
| consulting-b-studio | 2026-05-04 | active | 1MB |
| benchmarks-b-studio | 2026-05-04 | active | 0MB |
| capital-b-studio | 2026-05-04 | active | 0MB |
| build-b-studio | 2026-05-04 | active | 0MB |
| dispatch-b-studio | 2026-05-04 | active | 0MB |
| signatures | 2026-05-01 | active | 0MB |
| bolt-website | 2026-04-29 | active | 0MB |
| provisioning-agent | 2026-04-28 | active | 0MB |
| acusync | 2026-04-28 | active | 0MB |
| business-dashboard | 2026-04-28 | active | 0MB |
| probe-test-repo | 2026-04-28 | active | 0MB |
| bolt-zoom-app | 2026-04-26 | ARCHIVED | 0MB |
| tiered-close-out | 2026-04-26 | active | 0MB |
| nzt | 2026-04-26 | active | 3MB |
| relay-website | 2026-04-20 | active | 0MB |
| acureport | 2026-04-19 | active | 0MB |
| relay | 2026-04-19 | active | 0MB |
| studiob-docs | 2026-04-19 | active | 0MB |
| studiob-acumatica-ci-cd-template | 2026-04-19 | ARCHIVED | 0MB |
| acumatica-ci-cd | 2026-04-19 | ARCHIVED | 4MB |
| context-engine | 2026-04-18 | active | 0MB |
| nexus-analyzer | 2026-04-18 | active | 0MB |
| skuba-steve | 2026-04-18 | active | 0MB |
| note-intelligence | 2026-04-17 | active | 0MB |
| bolt-order-entry | 2026-04-16 | ARCHIVED | 0MB |
| nzt-prototype-archive | 2026-04-15 | ARCHIVED | 0MB |
| curtain-studio | 2026-04-13 | active | 0MB |
| rpx-designer | 2026-04-03 | active | 0MB |
| doc-generator | 2026-03-26 | active | 0MB |
| skuba-apps | 2026-03-25 | active | 0MB |
| skuba-theme | 2026-03-25 | active | 0MB |
| acuconfig | 2026-03-23 | active | 0MB |
| window-detector | 2026-03-21 | active | 0MB |
| studiob-client-template | 2026-03-21 | active | 0MB |
| acudocs-extension | 2026-03-21 | active | 0MB |
| guide-harness | 2026-03-19 | active | 0MB |
| studiob-test-template | 2026-03-19 | active | 0MB |
| test-utils | 2026-03-19 | active | 0MB |
| acudocs | 2026-03-18 | active | 0MB |
| integration-tester | 2026-03-16 | ARCHIVED | 0MB |
| compliance-engine | 2026-03-16 | active | 0MB |
| acumatica-configs | 2026-03-13 | ARCHIVED | 0MB |
| hubspot-configs | 2026-03-13 | ARCHIVED | 0MB |
| devops-mcp | 2026-03-13 | ARCHIVED | 0MB |
| acumatica-mcp | 2026-03-13 | ARCHIVED | 0MB |
| microsoft-mcp | 2026-03-13 | ARCHIVED | 0MB |
| zoom-mcp | 2026-03-13 | ARCHIVED | 0MB |
| godaddy-mcp | 2026-03-13 | ARCHIVED | 0MB |
| acumatica-hubspot-sync | 2026-03-12 | ARCHIVED | 0MB |
| infra-config | 2026-03-09 | ARCHIVED | 0MB |
| claude-code-config | 2026-03-09 | active | 0MB |
| acumatica-order-entry | 2026-03-08 | active | 0MB |
| studiob-qa | 2026-03-05 | ARCHIVED | 0MB |
| studiob-aesthetik-orders-sync | 2026-03-04 | ARCHIVED | 0MB |
| health-checker | 2026-02-28 | ARCHIVED | 0MB |
| sales-intelligence-agent | 2026-02-27 | ARCHIVED | 0MB |
| access-control | 2026-02-27 | ARCHIVED | 0MB |
| hubspot-mcp | 2026-02-27 | ARCHIVED | 0MB |
| studiob-templates | 2026-02-26 | ARCHIVED | 0MB |
