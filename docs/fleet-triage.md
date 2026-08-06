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
| 16b | **Hook-precision pass: ops#47 + ops#49** | #47 scope the #15 stale-checkout boot injection (SessionStart → PreToolUse-on-first-touch) · #49 no-secret-var-echo PAT substring → standalone-token match (precision-tune, never loosen — the hook caught a real leak the same sitting) | CTO build queue |
| 17 | ops-pipeline#21 org consolidation | Data delivered; classification = Kevin's dedicated sitting | **Kevin** sitting |
| 18 | ops-pipeline#12 wasala volume WARN | Static corpus; disposition rides #21 | rides #21 |

## Parked (deliberate, with resume runbooks)

- **Mobile E2E bring-up** — app never deployed, dev paused 5/17; layers A–C fixed, D parked on bolt-wms#1483 (closed-as-parked, runbook inside); schedule removal = bolt-wms#1484 (awaiting `reviewed`). Bottom of the list by Kevin's word.

## CTO build queue (the seat's own, in order)

1. **squasher-health callers → studiob, price-sync, trade-theme, portal** (Project 2 widening; bolt canary proven; each gets its own planted control)
2. ops-pipeline#37 (small)
3. Recurring repo-hygiene worker (deferred until after #21's classification — deliberate, see #21 comment)
4. `studiob-cto` agent first-dispatch validation
