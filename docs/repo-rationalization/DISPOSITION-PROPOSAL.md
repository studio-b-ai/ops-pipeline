# Repo rationalization — disposition proposal + decision surface

Generated 2026-08-12 (CTO seat, synthesis sitting). Inputs: the classification
sweep (`SWEEP-REPORT.md` + `evidence.jsonl`, merged as #58) joined against the
same-day **live-surface probe** (Railway GraphQL fleet enumeration — 10 projects,
full service/source/domain tree, raw response archived in the sitting scratchpad —
plus GitHub Pages API + HTTP probes on all 27 LIVE-SURFACE-CHECK repos).

Standing constraints: **deletion is Kevin-only and is not proposed for any repo**
(archive = reversible, is the strongest action here) · **`shuttle` = PRESERVE**
(Creative Director ruling — and the probe confirms it live: deploy timestamp
matches the repo's last push to the minute) · live-surface changes need Kevin's
explicit word (#97) · every disposition below is a **proposal awaiting Kevin's
word** — nothing in this document has been executed.

## What the probe changed (deltas vs the classification sweep)

| Prior claim | Probe verdict |
|---|---|
| `nzt` Railway zombie | **REFUTED — fully live.** Rebranded "OMO": `omo-api` + `omo-web` respond, **5 Postgres instances** on org billing. Repo dormant since 4/26 but the product runs. |
| `shuttle` zombie | **REFUTED** — live at shuttle.asthetik.com, deploy matches last push to the minute. |
| `gi-lint` zombie | **REFUTED** — service responds (root 404 = API-only, normal). |
| `relay` zombie | **CONFIRMED (the only true one)** — service responds but serves a build from 4/8 that predates the repo's own 4/19 push; sibling design doc calls the product "Exchange (not yet built)". |
| `context-engine` zombie | **REFRAMED** — the Railway project named context-engine deploys a *different repo*, `studio-b-ai/signatures` ("shared infra for Signatures, Amplify, Relay Pro"); its intended domain signatures.b.studio is NXDOMAIN. The context-engine *repo* has zero footprint anywhere. |
| consulting.b.studio → markdown.b.studio redirect (5/04 decision) | **REFUTED — never wired.** consulting.b.studio is NXDOMAIN; no redirect exists. |
| 7 `-b-studio` one-pagers "plausibly live" | **6 of 7 are fully dead surfaces** (benchmarks, build, capital, consulting, dispatch, dli): Pages `status:"built"` but no DNS, and the github.io fallback 301-loops into the dead CNAME — zero reachable path. **`invest` is LIVE** — see Batch 0. |
| `wasala-platform` unmapped | LMMI/Wasala credit-data batch pipeline (17 domain-less workers) + `wasala-backtester` at backtester.b.studio — which deploys from **`kbibelhausen/wasala`, a personal repo outside the org** (governance flag). |
| `bolt-roth` unmapped | Single-tenant Bolt WMS deploy (roth.bolt.b.studio) from `bolt-wms`. Real product deployment, not a zombie. |
| `quarterbook` IP/low "pure speculation" | **Live internal surface**: Railway service with custom domain **board.asthetik.com — "Quarterbook — Ästhetik Board Decks."** Reclassify Internal Tooling (live). Follow-up: confirm it is auth-gated (anonymous fetch returned only a title shell, consistent with a login gate/SPA — unverified). |
| `switchboard-app` | Live and **deliberately dual-deployed** (studiob-platform with 3 domains + aesthetik-production second instance) — a #49 multi-tenant pattern; any "one repo = one service" assumption in this program is wrong. |

Surface tally on the 27: **18 LIVE · 7 DEAD-SURFACE · 1 NO-SURFACE (context-engine repo) · 1 UNCLEAR (relay)**.

## ⚠️ Batch 0 — #341 exposure set (URGENT-ADJACENT; routes to the Corporate lane; listed first, decided first)

**invest.b.studio is publicly serving flagrant fund/LP framing right now**:
"Studio b. LMM Bridge Fund I · LP ENTRY · Verify accreditation →". This is the
same class the Corporate lane firewalled off b.studio proper on **8/11** — this
sibling surface was not covered. Two soft siblings feed it: **markdown.b.studio
and lmmi.b.studio both carry a live "Invest with us →" nav link.**
(capital.b.studio and dli.b.studio being NXDOMAIN is the *good* news — nothing
serves there.)

**Recommended**: take invest.b.studio dark (remove the DNS record or the Pages
CNAME — content stays in git; the gated-memo architecture is where accredited
material belongs), and hand the "Invest with us" link treatment on
markdown/lmmi to the Corporate lane's #341 architecture. Repo archival for
`invest-b-studio` then rides Batch 2.

**Kevin's word needed**: "take invest dark" (or route the whole set to the
Corporate lane's queue). Execution is minutes either way.

## Batch 1 — archive five Dead-active repos (one word: "archive them")

| repo | evidence |
|---|---|
| probe-test-repo | Own description: "E2E audit probe — safe to nuke" |
| tiered-close-out | "Generic scaffold" by own description; zero refs, zero runs |
| skuba-steve | Zero refs anywhere incl. bootstrap manifest; theme shows no consumption |
| acumatica-order-entry | Orphaned prototype; its superseding sibling was itself retired |
| Acuminator | Unmaintained **public** fork of Acumatica/Acuminator, zero Studio B commits. Archiving freezes it (stays public — flag if you want visibility flipped first) |

## Batch 2 — archive seven dead-surface Pages repos (one word)

`benchmarks-b-studio` · `build-b-studio` · `capital-b-studio` ·
`consulting-b-studio` · `dispatch-b-studio` · `dli-b-studio` · `relay-website`
— all unreachable today (dead DNS + 301-looping github.io fallback), all
superseded by the 5/04 retire-divisions decision and the 6/17 v0.3 single-holdco
narrative. Archive + disable Pages; no user-visible change is possible since no
path reaches them. (`invest-b-studio` joins after Batch 0; `markdown-b-studio`
stays — live, surviving division per 5/04.)

## Batch 3 — studiob-qa paradox (one word on the approach)

Archived-but-load-bearing: webhook-router's CI calls its `qa-runner.yml` on
every PR (run 31463593410 verified green 8/11). **Recommended: move
`qa-runner.yml` into webhook-router itself** — org-wide code search shows
webhook-router is the *sole* workflow consumer, so the reusable indirection
serves no one; the archive then stands honestly. Alternative: un-archive and
keep as QA home. (business-dashboard's aggregator lists studiob-qa in a
hardcoded repo array that already contains archived repos — tolerant, but
stale; noted for its own cleanup.)

## Batch 4 — Railway service-side retirements (#366 full legs; per-item words)

The enumeration found running services whose repos are dead, archived, or
superseded — these cost money and are attack surface. Each retirement = the
#366 checklist (service + domains + env + monitoring + any routines/crons).

| service (project) | evidence | recommended |
|---|---|---|
| `relay` + 3 infra (relay) | Stale build predating last repo push; product never shipped | **Retire project** |
| `bolt-zoom-app` (studiob-platform) | Repo archived; service still deployed — the exact leftover Rule #366's own incident flagged on 7/12, still unretired | **Retire service** |
| `studiob-agents` (studiob-platform) | Repo superseded by `studiob/packages/csuite` (#153); service still running | **Retire service** (archive repo in Batch 5) |
| `skuba-apps` + `skuba-theme` (studiob-platform) | IP/low repos, dormant since 3/25; services still deployed | **Retire services**, keep repos as IP |
| `mcp-amplify` (studiob-platform) | No source repo bound at all | **Retire** unless Amplify lane claims it |
| `context-engine` project | Deploys `signatures` to a domain that was never wired (NXDOMAIN) | **Kevin intent call**: wire signatures.b.studio, or retire the deployment (repo stays IP) |
| `nzt` project (omo-api, omo-web, nzt-proxy, **5× Postgres**) | Live rebranded product, unrelated to Studio B's business | **Kevin intent call**: personal side-project → move off org billing/infra, or keep deliberately |
| `aesthetik-staging` | Near-empty (one domain-less studiob-api-staging + 2 Redis) | **Retire project** unless a staging need is live |
| `acudocs`, `acuconfig`, `acureport` (studiob-platform, 2 envs each) | The "unbuilt AI-agent family" — repos have real described scope but no confirmed mesh integration; services deployed anyway | **Ride Batch 7** (acu* pass) — don't retire blind |
| `wasala-backtester` (wasala-platform) | Live at backtester.b.studio but deploys from **personal repo `kbibelhausen/wasala`** | **Governance word**: transfer repo into org (or accept deliberately) |

## Batch 5 — folds (word per fold)

| fold | rationale |
|---|---|
| `acuops` → `acuops-pipeline` | Superseded monorepo shell; pipeline docs mirror verbatim. Extract anything unique, archive shell |
| `window-detector` → `curtain-studio` | Trained-model artifact whose own description names its sole consumer |
| `studiob-agents` → archive as superseded | #153 locked the C-suite home to `studiob/packages/csuite`; nothing to fold, just retire (pairs with its Batch 4 service) |

## Batch 6 — reclassifications + standing items (no words needed except where marked)

- `quarterbook` → **Internal Tooling (live)** — board.asthetik.com. Follow-up: verify auth gate.
- `nzt` → IP/low but **live product** — disposition is the Batch 4 intent call.
- `compliance-engine` — probe found it **live and auth-gated (401)** at its real
  suffixed domain, not 404 as previously recorded. The locked parked-decision
  stands; classification IP/high unchanged.
- `wasala` 158GB volume (ops#12) — static LMMI PD corpus; cold-store to R2 +
  shrink **after** the LMMI/wasala workstream's own disposition here (it's
  live-ish: the batch pipeline + backtester run). Rides the Batch 4 wasala row.
- `asthetik-redirect` — confirmed working redirect utility (302 → Shopify). Keep.
- 34 Product repos + remaining Internal Tooling — **no action**; healthy.
- 23 already-archived Dead repos — archives stand; no challenge found.

## Batch 7 — acu* family pass (one word: schedule it)

18 repos share Acumatica-tooling naming; the probe shows `acudev`/`acusync`
live-deployed (executor mesh) alongside the deployed-but-unconfirmed
`acudocs`/`acuconfig`/`acureport` family and the superseded `acuops` shell.
Recommended: a dedicated follow-up pass with the mesh's own telemetry (which
services actually receive traffic) before any retirement — same instrument-first
law the gateway attribution work proved (grep/naming is inadmissible; the
Railway map + traffic receipts decide).

## Execution order once words land

1. Batch 0 (minutes; Corporate lane or this seat on Kevin's word)
2. Batches 1+2 archives (one `gh repo archive` sweep; business-dashboard list cleanup rides along)
3. Batch 3 qa-runner migration (webhook-router PR)
4. Batch 4 service retirements, one at a time, each with #366 legs + a
   post-retirement probe receipt (#463: no credit without causal order)
5. Batch 5 folds
6. Batch 7 scheduled as its own sitting

## Rebuilt Repo Map (draft for CLAUDE.md — CoS stewards placement; #160 pointers-not-mirrors)

> Repo Map (verified against live Railway + surface probes 2026-08-12).
> Authoritative full inventory + dispositions:
> `ops-pipeline/docs/repo-rationalization/`.

| Repo | Serves | Purpose |
|---|---|---|
| `studiob` | Studio B platform | Monorepo: studiob-api (L1 gateway; orderhub.b.studio, api.switchboard.b.studio) + acudev, business-dashboard, cos-brief-worker, auto-remediate + packages/csuite |
| `bolt-wms` | Bolt product + Ästhetik/HF | WMS; deploys aesthetik-production (wms.asthetik.com) + bolt-roth tenant (roth.bolt.b.studio) |
| `webhook-router` | Ästhetik/HF | Slack intake, sync pipeline, intranet (internal.asthetik.com) |
| `acuops-pipeline` | AcuOps product (VAR) | Acumatica CI/CD engine; clients pin `@v1` |
| `client-asthetik` | Ästhetik/HF | HF Acumatica instance (customization + config + tests) |
| `studiob-price-sync` | Ästhetik/HF | Pricing sync + Shopify B2B catalogs |
| `asthetik-trade-theme` | Ästhetik | Live Shopify theme |
| `aesthetik-portal` | Ästhetik | Trade portal |
| `amplify` | Amplify product | 4 Railway services (engine, workers, linkedin-engine, luminary) |
| `switchboard-app` | Switchboard product | HubSpot calling; dual-deployed (platform + aesthetik tenants) |
| `shuttle` | Ästhetik internal | Product-dev OS — **PRESERVE** (CD ruling); shuttle.asthetik.com |
| `quarterbook` | Ästhetik internal | Board decks (board.asthetik.com) |
| `ops-pipeline` | Studio B fleet | Fleet machinery: squasher, merge gates, health monitors, triage board, repo inventory (authoritative) |
| `brain` | Studio B | The vault |
| public sites | — | b.studio (#341-firewalled 8/11) · bolt.b.studio · docs.b.studio · amplify.b.studio · lmmi.b.studio · acuops.com (Pages) · markdown.b.studio |

*Retired from the old map: godaddy-mcp/microsoft-mcp/zoom-mcp rows (archived,
already marked) and the standalone acumatica-ci-cd row. The old map's missing-repos
warning is resolved by this rebuild.*
