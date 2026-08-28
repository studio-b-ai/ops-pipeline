# Railway exit playbook

> ops-pipeline#167 leg 3. **This is a contingency runbook, not a commitment to leave.**
> The go-forward stack remains Cloudflare + Railway (CLAUDE.md Rule #117) unless and until
> the decision triggers below fire. The point of writing this while calm is that vendor
> exits planned during an outage are the worst-executed kind.
>
> This repo is public: everything here is either Railway's own published status history or
> generic architecture. No tokens, no URLs beyond public ones, no customer data.

## Evidence base

The **Railway incident ledger** — the standing auto-reconciled issue labeled
`railway-incident-ledger` in this repo — is the durable record, maintained every 6h by
`.github/workflows/railway-incident-ledger.yml` from status.railway.com's own
`activeIncidents` + `recentIncidents`. Rows survive the page's ~3-month retention, so the
ledger is the only place month-over-month platform reliability can actually be read.

Why it exists: **August 2026 alone had nine Railway platform incidents, five of them
deploy-path** (Deployments / Builds / GitHub Auto-Deploys / API components) — including
2026-08-18's "Deployments are slow to progress and are prone to timeout failure"
(`YYU63JUO`), into which one of our deploys launched and stalled mid-flight. The companion
deploy gate (`.github/workflows/railway-status-gate.yml`) stops that class going forward;
this playbook covers the larger question the density raises.

## Decision triggers (read from the ledger, not from vibes)

Evaluate at each month boundary. Trigger states, in escalating order:

| State | Condition (from ledger rows) | Action |
|---|---|---|
| **GREEN** | < 3 deploy-path incidents in the trailing month | Nothing. Stack stands (Rule #117). |
| **YELLOW** | ≥ 3 deploy-path incidents in a month, first occurrence | Re-verify this playbook's inventory section is current. No spend. |
| **ORANGE** | ≥ 3 deploy-path incidents/month for **2 consecutive months**, OR any single incident causing customer-visible downtime > 4h | Run the 2-week bake-off (below) on the top alternative. Still no migration. |
| **RED** | ORANGE condition persists a 3rd month, OR Railway suffers a data-loss / multi-day incident, OR pricing/terms change materially against us | Present the bake-off results + this playbook as a migration decision. Migration itself is a Kevin decision, never automatic. |

Counting rule: an incident is "deploy-path" when the ledger row's **deploy-path?** column
is **YES** (components Deployments / Builds / GitHub Auto-Deploys / API in a relevant
region — same predicate the deploy gate uses, one shared implementation in
`scripts/lib/railway-status.ts`).

## What portability requires (the invariants)

Anything replacing Railway must cover all of these, because the fleet actually uses all of
them. This is the checklist a bake-off scores against:

1. **Managed Postgres with volume-backed durability** — multiple production databases,
   the largest measured in GB not TB. Exit path from Railway Postgres is standard
   `pg_dump`/restore for small DBs and logical replication for the big ones (near-zero
   downtime). Nothing uses Railway-proprietary Postgres features.
2. **Persistent volumes** — a handful of services mount volumes (Postgres, caches).
   Sizes are monitored by `railway-volume-monitor` in this repo; treat its inventory as
   the current list.
3. **Private service-to-service networking** — internal hostnames (`*.railway.internal`
   equivalents) with non-public ports. Several services are deliberately unreachable from
   the public internet.
4. **Cron / scheduled execution** — some in-platform crons exist, but the fleet has been
   deliberately externalizing schedules to GitHub Actions cron → authenticated `POST`
   (Rule #94 pattern), which is already platform-neutral. A bake-off should assume GHA
   remains the scheduler.
5. **Env-var store with reference variables** — dozens of vars per service; some use
   Railway `${{Service.VAR}}` references (same-project only — Rule #345). Migration
   requires a per-service env inventory dump and a reference-variable flattening pass.
6. **Custom domains + automatic TLS** — many customer-facing hostnames CNAME'd to
   per-attachment aliases. Every domain move is a DNS + cert re-issue event (Rules
   #185–#188 document how fiddly this is on Railway itself; budget the same care anywhere).
7. **Deploys from GitHub** — mostly Railway's native GitHub auto-deploy; exactly one
   GHA-driven `railway up` (the gate's first consumer). Auto-deploy is table stakes
   everywhere; the GHA path ports by swapping the CLI.
8. **Logs + restart/rollback controls** reachable from CLI/API — the ops tooling in this
   repo shells out for status, logs, redeploys.

**Deliberately NOT required:** multi-region active-active, autoscaling beyond
one-knob vertical, Kubernetes. Don't let a bake-off score points for capabilities the
fleet doesn't use.

## The 2-week bake-off (ORANGE state)

Goal: prove one alternative can run a REAL slice of the fleet, with numbers, before any
migration decision exists.

1. **Pick the slice:** one stateless HTTP service (low blast radius) + one worker with a
   cron-fired job + one throwaway Postgres restored from a real dump. No customer traffic.
2. **Week 1 — stand it up:** deploy from the same GitHub repos, wire private networking
   between the service and the DB, set env vars from the flattened inventory, attach one
   test subdomain with TLS. Score each invariant above pass/fail with notes.
3. **Week 2 — operate it:** leave it running. Deploy ≥ 5 times (including one deliberate
   bad deploy + rollback). Kill the service and measure recovery. Pull logs via CLI. Note
   every papercut.
4. **Scorecard:** invariant coverage (8 rows) · deploy latency vs Railway · monthly cost
   for the slice extrapolated to fleet scale · operational papercuts count. File the
   scorecard as an issue in this repo linked from the ledger.

Candidate shortlist (revalidate at bake-off time; the market moves): Fly.io and Render as
like-for-like PaaS; a Hetzner/OVH box under Coolify or Dokploy as the self-managed
cost-floor option. Cloudflare stays the DNS/CDN layer in every scenario (Rule #117 — the
exit question is Railway's compute/DB seat only).

## Execution order (RED state, after the decision — strangler pattern)

1. Stateless, low-traffic internal services first (proves the pipeline; instant rollback
   by flipping DNS back).
2. Workers/crons next (GHA schedulers just change their POST target).
3. Customer-facing stateless services, one at a time, DNS TTL lowered ahead of each.
4. Postgres LAST, one database at a time: logical replication → verify row counts +
   app-level probes against the replica → cutover window → old primary kept read-only for
   a week.
5. Railway teardown only after a full month clean — and per Rule #366, retirement
   retires ALL legs: services, volumes, domains, env stores, tokens, monitors.

## Maintenance

- The ledger maintains itself; this file is re-read at every YELLOW evaluation.
- If the status page's inline-data shape changes, the parser fails loud (PARSE_ERROR →
  red ledger runs + fail-open gate warnings) — fix `scripts/lib/railway-status.ts`, whose
  fixtures are real captured bytes for exactly this purpose.
