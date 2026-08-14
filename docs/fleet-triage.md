# Fleet engineering triage — ranked (CTO seat)

> **Contract (Kevin, 2026-08-05):** the CTO lane ranks and prioritizes fleet
> engineering work, then moves on and continues building. Owning sessions pull
> from this board when they get to it; nothing here blocks the seat's build
> queue. Refreshed each CTO sitting from live issue state — a stale row is a
> bug (#355). Diagnoses link to probe pre-briefs on the issues themselves.

**Refreshed:** 2026-08-14 (Batch 7 sitting) · **Coverage:** bolt-wms · studiob ·
studiob-price-sync · asthetik-trade-theme · asthetik-portal · ops-pipeline

## P0 — customer-facing: money or orders wrong/stuck

| rank | issue | one-line state | acts |
|---|---|---|---|
| 1 | bolt-wms#1475 orders not syncing | Acumatica-LOAD symptom (not #441-class); 8/12: rescue import mid-drain of the 85 stranded orders — the inventory is finally consuming; freeze/orphan decisions still pending | **Kevin** + bolt lane |
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
| 12b | **bolt-wms#1641 + #1642 — the ~0.5-seat demand pair** (quiet-window read DONE 8/13; #1511 CLOSED — its 63%-error headline DISSOLVED at steady state: 24,445 calls / 0 transport errors, duress fallout not a standing defect) | Both callsites confirmed steady-state #1/#2 gateway-wide (42% of ALL gateway seat-time, 24/7). **#1641**: hourly status-refresh live-verifies 1,095 frozen-`Closed` candidates forever, discards the live truth it fetches, and `CANCEL_LIKE_STATUSES` misses one-L `Canceled` — ~1,095 customer-visible Shopify orders carry frozen/absent erp_status (correctness half, not just load); ≈0.31 seats, positive slope (~+20/day). **#1642**: `syncPortalShipments` re-fetches all 8,493 stubs every 15 min, 94.6% terminal `Completed`; ≈0.21 seats. **BOTH FIXES SHIPPED + FIRST-FIRING-RECEIPTED same night (Kevin 'go' 8/13 eve)**: PR #1644 (refresh: live-truth writes + CAS-guarded heal + 'Canceled' in TWO vocabularies — codex found the second in order-state.ts) + PR #1643 (sweep scope + the MISSING nightly full pass codex caught — the issue's safety-net premise was false, #399 class). Receipts: `refresh(candidates=1095,applied=1024,healed=1024,skipped=7)` first pass (93.5% drained, zero CAS losses, 1,024 customer statuses truthful again) · `portal-shipments (incremental): 1836/2168 (0 errors)` (population 8,493→2,168, 74.5% cut → ~95% as tracking drains). Standing watch: tomorrow's gateway buckets (SalesOrder <100/hr was ~1,100; Shipment ~175/hr was 680) | receipts on the issues; bucket read = next sitting |
| 12c | **bolt-wms#1590 storefront-vs-ItemStatus drift detector** (NEW 8/12, CoS routing from COO wrap) | Rescue import surfaced Shopify actively selling an Acumatica-Inactive item (paid order #3217, 9X9 AMHERST:TAN). #420/#453 family: the storefront can silently sell what the ERP killed. Shape: new leg on the existing drift-detector worker — live-verify each hit (#453) + auto-reconciled issue (#165), same consumed channel (#60). Ranked below the #1641/#1642 pair (bigger lever) — instance handled, this is the recurrence guard | bolt lane |
| 12 | team-action queue (bolt #1442 #1452 #1433 #1434) | Flowing via the team-asks digest (#1476) | Sarah/CS |

## P2 — data quality / deferred engineering

| rank | issue | one-line state | acts |
|---|---|---|---|
| 13 | bolt-wms#1469 non-positive stage durations | Probe falsified "writer inverts": bad SOURCE dates (Acumatica entry + unconfirmed T49 `?? new Date()` fallback) | bolt lane (#304 layer) |
| 14 | bolt-wms#1480 freshness-monitor hardening | #358 rung + output-oracle watchdog | bolt lane / CTO |
| 15 | bolt-wms#1455 retire dormant deploy-customization.yml | #366 leg check then strip | CTO, rides #21 |
| 16 | ~~ops-pipeline#37~~ CLOSED 8/05 (orphan sweep shipped, ops#43) | — | done |
| 16b | ~~Hook-precision pass: ops#47 + ops#49~~ **CLOSED 8/06** | Both shipped (hooks `699d4a9`, `6d33698`), each live-fired both directions. #49 audit found a bigger collision than reported: `PAT` matched inside **`$PATH`**, so every path echo was blocked fleet-wide, silently. #47's WARN path proven against a **planted** stale checkout (#464) — the four natural probes only ever returned the default verdict | done |
| 16c | ~~ops-pipeline#51~~ **CLOSED 8/12** — both halves shipped: guard (8/06) + default-deny ~/.claude config repo w/ auto-checkpoint (8/12, live-fired through the real hook path) | Receipts on the issue | done |
| 17 | ~~ops-pipeline#21~~ **CLOSED 8/12** — Kevin's words landed + executed same day (16 archives, 7 Railway retirements, qa-runner inline, invest DARK); map FINAL w/ Lane column (ops#67); spelling-split rename executed (ops#68); wasala transferred | done (Batch 7 → ops#61) |
| 18 | ~~ops-pipeline#12~~ **CLOSED honestly 8/13** — per-volume accepted-state (85%, review 11/30) shipped + plant-proven (ops#71); alert returns on breach or expiry | done |
| 19 | ~~ops-pipeline#61~~ **CLOSED 8/14** — Batch 7 executed on Kevin's word (4 idle agent services retired + 16 dead mesh vars purged + acuconfig/acureport archived as IP + acuops.com metrics cron */5→hourly); acuops-hub proven LIVE (license gate traffic same-day), acudev proven LIVE (certification cron + community monitor) | done |
| 20 | doc-generator#2 broken-silent since 7/24 (`getaddrinfo redis.railway.internal`, zero logs since) — surfaced by the Batch 7 sweep; owner decides fix-or-retire (#366) | doc-gen/COO lane |

## Parked (deliberate, with resume runbooks)

- **Mobile E2E bring-up** — app never deployed, dev paused 5/17; layers A–C fixed, D parked on bolt-wms#1483 (closed-as-parked, runbook inside); schedule removal = bolt-wms#1484 (awaiting `reviewed`). Bottom of the list by Kevin's word.

## CTO build queue (the seat's own, in order)

*(refreshed 8/14 late-2 — Batch 7 executed + closed; the hygiene worker's deferral condition is now resolved)*

1. **Recurring repo-hygiene worker** — UNBLOCKED (its deferral was "after #21's classification", complete as of Batch 7). Design note carried from row 17: the classifier mis-classed shuttle once, so the worker FLAGS drift for the board, never auto-acts on classification alone (instrument-first, the Batch 7 law).

**Shipped from this queue:** squasher-health widening to 4 callers · ops#37 orphan sweep · ops#47 + ops#49 hook-precision pass · **ops#51 both halves (guard 8/06 + config-plane versioning 8/12)** · **ops#71 both legs, designed by the studiob-cto agent (first-dispatch validation PASS) + plant-PROVEN in production 8/13 (11 runs, all controls held)** · **studiob-cto agent first-dispatch validation (rode ops#71)** · **ops#74 absent-entity sweep ported to credential-expiry-monitor + plant-PROVEN live 8/14 (PR #85; plant #86 closed "no longer monitored", live WARN-7 controls #56/#57 held) — all three monitors now carry the sweep, standing ahead of the 8/20 rotation** · **ops#88 cross-repo sweep MERGED 8/14 PM (fleet App `studiob-fleet-bot` Kevin+seat co-driven; PR #97, 462/462, codex ×4; App-token mint first-fired + bot login API-verified; twin-filing awaits first ORGANIC cross-repo case — :47 cron standing; probe plant-resistance finding → CoS)** · **wr#567 closed same sitting (key live, 5 issues probed + drained)** · **ops#66 needs-human AUTOPILOT shipped whole 8/14 (Kevin: "auto-route immediately" — reaction is a brake): reusable router (ops#89) + 5 staggered hourly cron callers + wr/trade-theme probe callers + brake fix (ops#91, the org-visibility P1 found→fixed→re-proven live in one sitting); plant-proven both directions (route #1656 / brake #1657); bolt drained 10/10 first firing (pool 10→4). Kevin-gates: ops#88 fleet App (cross-repo filing) · wr#567 probe key** · **ops#61 Batch 7 executed whole 8/14 eve (Kevin: full package + hourly): instrument sweep over the 18 acu* repos (traffic/log receipts, zero naming calls) → acuops-hub + acudev proven LIVE · acusync/acuconfig/acudocs/acureport proven instrument-dead and RETIRED (name-echo-verified deletes; cascade falls back to acudev by construction; wr's ACUDOCS/ACUREPORT URLs were already pointing at nonexistent domains — nobody noticed, confirming dormancy) · 16 dead mesh vars purged (8 env-shared + 8 wr) · acuconfig/acureport archived as IP w/ pointer descriptions · acuops.com metrics cron */5→hourly (acuops-website#33, `6af2c01b`) · doc-generator#2 filed (broken-silent since 7/24)**.

## Standing watches (armed, idle until their signal)

- **Freeze↔SM604000 correlation** — fires same-day on each crew freeze timestamp (Railway log retention is short). Crew asked 8/06 via Zoom; zero timestamps so far.
- **Three organic gate receipts** — price-sync, trade-theme, portal still need a first real auto-merge firing each. bolt-wms and studiob are proven.
