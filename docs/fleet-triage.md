# Fleet engineering triage — ranked (CTO seat)

> **Contract (Kevin, 2026-08-05):** the CTO lane ranks and prioritizes fleet
> engineering work, then moves on and continues building. Owning sessions pull
> from this board when they get to it; nothing here blocks the seat's build
> queue. Refreshed each CTO sitting from live issue state — a stale row is a
> bug (#355). Diagnoses link to probe pre-briefs on the issues themselves.

**Refreshed:** 2026-08-06 (hook-precision pass: #47+#49) · **Coverage:** bolt-wms · studiob ·
studiob-price-sync · asthetik-trade-theme · aesthetik-portal · ops-pipeline

## P0 — customer-facing: money or orders wrong/stuck

| rank | issue | one-line state | acts |
|---|---|---|---|
| 1 | bolt-wms#1475 orders not syncing | Acumatica-LOAD symptom (not #441-class); freeze/orphan/PaceJet decisions pending | **Kevin** + bolt lane |
| 2 | bolt-wms#1466 wrong tariff amounts on auto-sent invoices | Probe: discrepancy is Acumatica-side (SO vs invoice docs), not bolt code | Operator/Kevin |
| 3 | **studiob#469 SHIP-TO UMBRELLA** (#431 #444 #467) | **DIRECTION A LOCKED (Kevin 8/06)** — bridge masters Shopify-side create+role+ExtRefNbr, THEN #1453 flips Import; full spec + verification battery + 1b backfill on the umbrella; #1453 sequencing-locked behind Phase 1 | **COO seat implements** (CoS routing 8/06; #1475 outranks); CTO verifies receipts |
| 5 | bolt-wms#1486 false back-order badge (moved from price-sync#122) | Probe: filed in wrong repo; trace = wms_inventory sync → connector → badge logic | bolt lane |
| 6 | price-sync#112 Calista Raffia absent from site + portal | Single-SKU pipeline/config gap (catalog publication or pricing rail), not extension code | Portal lane |
| 7 | price-sync#123 "conflicting" inventory | Possibly NOT a bug: two surfaces answering different questions (gross-vs-net, #407 family) — labeling fix if confirmed | Portal lane |

## P1 — staff pain / blind spots

| rank | issue | one-line state | acts |
|---|---|---|---|
| 8 | bolt-wms#1416 SOContact record locks block order saves | Probe: optimistic-lock collision bot-vs-Sarah via SharedRecordAttribute; culprit writer = log correlation | bolt lane |
| 9 | bolt-wms#1360 integration tests dead on main | #99 split-brain: `ACUMATICA_TEST_PASSWORD` GH secret diverged from live api-bot | **Kevin** (secret re-sync) |
| 10 | studiob#454 checkout draft-vs-auto audit | Not a defect — audit capability gated on `SHOPIFY_ADMIN_TOKEN_ASTHETIK` mint | **Kevin** (token), then lane |
| 11 | studiob#434 strip reps from customer contacts | No "sales rep" definition exists; bulk live-data mutation → #97/#375 | **Kevin** (policy), then metered job |
| 12 | team-action queue (bolt #1442 #1452 #1433 #1434) | Flowing via the team-asks digest (#1476) | Sarah/CS |

## P2 — data quality / deferred engineering

| rank | issue | one-line state | acts |
|---|---|---|---|
| 13 | bolt-wms#1469 non-positive stage durations | Probe falsified "writer inverts": bad SOURCE dates (Acumatica entry + unconfirmed T49 `?? new Date()` fallback) | bolt lane (#304 layer) |
| 14 | bolt-wms#1480 freshness-monitor hardening | #358 rung + output-oracle watchdog | bolt lane / CTO |
| 15 | bolt-wms#1455 retire dormant deploy-customization.yml | #366 leg check then strip | CTO, rides #21 |
| 16 | ~~ops-pipeline#37~~ CLOSED 8/05 (orphan sweep shipped, ops#43) | — | done |
| 16b | ~~Hook-precision pass: ops#47 + ops#49~~ **CLOSED 8/06** | Both shipped (hooks `699d4a9`, `6d33698`), each live-fired both directions. #49 audit found a bigger collision than reported: `PAT` matched inside **`$PATH`**, so every path echo was blocked fleet-wide, silently. #47's WARN path proven against a **planted** stale checkout (#464) — the four natural probes only ever returned the default verdict | done |
| 16c | **ops-pipeline#51 settings.json unversioned** | Near-miss while shipping #47: an entry-level filter deleted 4 sibling SessionStart hooks (vault-review #278, Qdrant preload, brain-push backstop, OneDrive guard) — valid JSON, silent, recoverable only by an ad-hoc backup. 68 hook registrations with no history. Fix pair = git root up + a registration-integrity assertion | CTO build queue |
| 17 | ops-pipeline#21 org consolidation | Data delivered; classification = Kevin's dedicated sitting. ⚠️ Zombie classifier has a precision defect — `shuttle` mis-classed dormant (merges 6/10, active thru 8/05); every zombie hit re-reads against last-merge recency, and shuttle's Railway disposition parks on the Creative-Director ruling | **Kevin** sitting |
| 18 | ops-pipeline#12 wasala volume WARN | Static corpus; disposition rides #21 | rides #21 |

## Parked (deliberate, with resume runbooks)

- **Mobile E2E bring-up** — app never deployed, dev paused 5/17; layers A–C fixed, D parked on bolt-wms#1483 (closed-as-parked, runbook inside); schedule removal = bolt-wms#1484 (awaiting `reviewed`). Bottom of the list by Kevin's word.

## CTO build queue (the seat's own, in order)

*(refreshed 8/06 — items 1, 2 and the hook-precision pass have shipped)*

1. **ops-pipeline#51** — settings.json versioning + registration-integrity check. Top of the queue because it removes a class of *silent, unrecoverable* fleet damage: a deleted hook registration doesn't error, it just stops protecting (#464), and there is currently no history to restore from.
2. `studiob-cto` agent first-dispatch validation.
3. Recurring repo-hygiene worker (deferred until after #21's classification — deliberate, see #21 comment; the shuttle mis-class in row 17 is a second reason the classifier needs work before it drives anything).

**Shipped from this queue:** squasher-health widening to 4 callers · ops#37 orphan sweep · ops#47 + ops#49 hook-precision pass.

## Standing watches (armed, idle until their signal)

- **Freeze↔SM604000 correlation** — fires same-day on each crew freeze timestamp (Railway log retention is short). Crew asked 8/06 via Zoom; zero timestamps so far.
- **Three organic gate receipts** — price-sync, trade-theme, portal still need a first real auto-merge firing each. bolt-wms and studiob are proven.
