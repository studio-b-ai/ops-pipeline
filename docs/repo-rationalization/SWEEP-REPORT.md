# studio-b-ai repo-rationalization evidence sweep

Generated 2026-08-12. Read-only evidence gathering — no mutations, no gh/Railway
writes. Starts from `ops-pipeline` PR/branch `cto/21-repo-inventory`'s scaffold
(`docs/2026-08-04-repo-inventory-consolidation-scaffold.md`, generated 2026-08-04)
and refreshes + enriches + adds consumer-signal evidence on top of it.

Full per-repo evidence: `evidence.jsonl` (101 rows, one per repo).

## Headline numbers

**101 repos** (unchanged from the 8/04 scaffold — no repos created, deleted,
transferred, or archive-flag-flipped since then). Classification split:

| Classification | Count | High conf. | Medium conf. | Low conf. |
|---|---|---|---|---|
| Product | 34 | 33 | 1 | 0 |
| Internal Tooling | 16 | 7 | 9 | 0 |
| IP | 23 | 4 | 13 | 6 |
| Dead | 28 | 24 | 4 | 0 |
| **Total** | **101** | **68** | **27** | **6** |

Of the 28 Dead: 24 are already archived in GitHub (correctly — this sweep found
no reason to challenge those archivals except the one flagged below), and 4 are
**active but unarchived Dead candidates**: `probe-test-repo`, `tiered-close-out`,
`skuba-steve`, `acumatica-order-entry`, plus `Acuminator` (5 total — see below).

## The single most decision-relevant finding: studiob-qa

**`studiob-qa` is flagged `archived: true` in GitHub but is a live, successfully
running CI dependency** for `webhook-router`. Its `.github/workflows/ci.yml`
calls `uses: studio-b-ai/studiob-qa/.github/workflows/qa-runner.yml@main` on
every pull request. Verified via an actual run: PR run
`31463593410` on 2026-08-11 — jobs `Cross-System QA / E2E Tests (Playwright)`,
`Cross-System QA / API Tests (Vitest)`, and `Cross-System QA / Slack
Notification` all completed with `conclusion: success`. GitHub permits checking
out archived repos (only writes are blocked), so this doesn't hard-fail — but it
means load-bearing QA infrastructure sits inside a repo whose "archived" label
tells every human reader it's retired. This sweep classifies `studiob-qa` as
**Internal Tooling (high confidence)** by actual function, not as Dead by its
GitHub label — the label and the classification now disagree, and that
disagreement is itself the finding. Two ways to resolve: un-archive it and keep
it as the QA reusable-workflow home, or migrate `qa-runner.yml` ownership into
`ops-pipeline`/`acuops-pipeline` (both confirmed live reusable-workflow
providers) and let the archive stand.

## State changes since the 2026-08-04 scaffold

No repos were added, deleted, transferred, or had their archived flag flipped.
**11 repos received new pushes** since the scaffold was generated:

| repo | scaffold push | now |
|---|---|---|
| acuops-website | 2026-08-04 | 2026-08-12 |
| asthetik-trade-theme | 2026-08-04 | 2026-08-12 |
| bolt-wms | 2026-08-04 | 2026-08-12 |
| brain | 2026-08-04 | 2026-08-12 |
| **b-studio-website** | **2026-05-10** | **2026-08-11** |
| client-asthetik | 2026-08-04 | 2026-08-11 |
| studiob | 2026-08-04 | 2026-08-11 |
| webhook-router | 2026-08-04 | 2026-08-11 |
| studiob-price-sync | 2026-08-04 | 2026-08-10 |
| ops-pipeline | 2026-08-04 | 2026-08-07 |
| aesthetik-portal | 2026-07-30 | 2026-08-05 |

`b-studio-website` is the notable one: it jumped from 3 months stale (5/10) to
fresh (8/11) — nine of the other ten repos were already in the scaffold's
"active in the last 30 days" bucket, but `b-studio-website` crossed from
stale-active into fresh between the scaffold and now. This lines up with
MEMORY.md's "Corporate lane next arc" note about implementing the Rule #341
public-materials firewall on `b-studio-website` — worth checking whether that
work has started.

## PRESERVE (hard flag, overrides all other signals)

- **`shuttle`** — PRESERVE per task brief pending Creative Director ruling.
  Carries a proven Acumatica bridge/worker. CLAUDE.md repo map: "product-
  development OS (sourcing → live SKU)... L3 (consumes studiob-api L1)."
  MEMORY.md shows live decision activity as recently as this week ("CARDS
  REOPENED under the logo system") even though the repo's own last push is
  2026-06-10 (stale by push-date alone). Classified IP here (dormant repo,
  live product) — never a Dead candidate regardless of any future staleness
  signal.

## LIVE-SURFACE-CHECK-REQUIRED (27 repos — controller runs the #387 probes)

These either match a Railway project name from the scaffold's project list
(`shuttle`, `gi-lint`, `context-engine`, `relay`, `nzt`), match the confirmed
`{product}-website` convention (bolt-website's README names the sibling list),
match a `-app`/`-portal`/`-hub` live-surface suffix, or were independently
confirmed via docs to have (or have had) a production Railway URL or a
GitHub-Pages CNAME domain. This sweep did **not** verify current DNS/Railway
status for any of these — that's explicitly the controller's job per the task
brief.

**Confirmed-Product tier, just need a liveness re-check** (high confidence on
classification, the flag is only about current-live-or-not):
`acuops-hub`, `acuops-website`, `aesthetik-portal`, `amplify-website`,
`b-studio-website`, `bolt-website`, `enhancement-portal`, `gi-lint`,
`lmmi-b-studio`, `note-intelligence`, `relay-website`, `studiob-docs`,
`switchboard-app`

**IP tier, liveness genuinely uncertain** (this is where the flag carries the
most weight — these could be live, quietly dead, or mid-redirect):
`benchmarks-b-studio`, `build-b-studio`, `capital-b-studio`, `compliance-engine`
(known 404 per a locked decision doc — see below), `consulting-b-studio`,
`context-engine` (known Railway zombie per scaffold), `dispatch-b-studio`,
`dli-b-studio`, `invest-b-studio`, `markdown-b-studio`, `nzt` (known Railway
zombie), `relay` (known Railway zombie), `shuttle` (PRESERVE, also zombie)

**Internal Tooling tier:** `asthetik-redirect` (a redirect service is live by
definition even without commits)

Additional scaffold-confirmed Railway zombies not independently re-verified by
this sweep beyond citing the scaffold: the scaffold's Railway project list also
includes `studiob-platform`, `wasala-platform`, `aesthetik-production`,
`bolt-roth`, `aesthetik-staging` — none of these map 1:1 to a single repo name
(`studiob-platform` plausibly hosts `acudev`, `business-dashboard`, and others
per CLAUDE.md; `wasala-platform` plausibly maps to `lmmi-b-studio`, formerly
Wasala; `bolt-roth` and the aesthetik environments don't have an obvious single
repo owner). See COULD-NOT-VERIFY below.

## fold_candidate (consolidation bias — alive-but-tiny into a bigger home)

- **`acuops`** → `acuops-pipeline` — `acuops` (bare) looks like an older,
  broader monorepo shell: its `packages/pipeline/README.md` and
  `packages/pipeline/docs/index.md` mirror `acuops-pipeline`'s own README/
  badges/CHANGELOG almost verbatim. `acuops-pipeline` is the actively
  developed, BSL-licensed, confirmed reusable-workflow provider (pushed 7/11
  vs. `acuops`'s 5/10). Reads as an extraction that outgrew its parent shell.
- **`benchmarks-b-studio`, `build-b-studio`, `capital-b-studio`,
  `consulting-b-studio`, `dispatch-b-studio`, `dli-b-studio`,
  `invest-b-studio`** → `b-studio-website` (pending Kevin confirmation) — all
  seven are GitHub-Pages one-pagers built together per
  `b-studio-website/docs/superpowers/specs/2026-05-02-firm-sites-design.md`.
  `brain/project_studio-b-positioning.md` documents a "2026-05-04
  retire-divisions decision" (`consulting-b-studio#1`, described as "canonical")
  and a `consulting.b.studio → markdown.b.studio` redirect — meaning at least
  one of these seven was already slated for consolidation as of early May, only
  two days after being spec'd. CLAUDE.md's v0.3 identity lock (2026-06-17)
  reinforces a single-holdco-narrative direction over separate branded
  division sites. This sweep could **not** confirm how much of the
  retire-divisions decision actually executed — fold_candidate is offered at
  medium confidence, pending Kevin's word on which (if any) of these seven
  still need to exist as separate repos/domains.
- **`window-detector`** → `curtain-studio` — `window-detector`'s own
  description says it's "exported to TF.js for Curtain Studio." A trained-model
  artifact repo that's a direct, named dependency of a single consumer is a
  clean fold candidate (or at minimum, should live in the same repo/monorepo).
- **`studiob-agents`** → `studiob` — "Studio B Agent Fleet — autonomous
  business agents (RevOps, Ops, BD, Comms, Content)," pushed 5/10, likely
  **superseded**: CLAUDE.md Rule #153 names `studiob` monorepo's
  `packages/csuite/` as the current, locked repo home for C-suite
  orchestration, a different repo than this one.

## All 28 Dead candidates (24 high-confidence + 4 medium; the "top 25" the task asked for, plus 3 more since the full Dead set is barely over 25)

**High confidence (24) — 23 already archived correctly, 1 active-and-should-be:**

- `probe-test-repo` (**active, not yet archived**) — repo's own description:
  "E2E audit probe — safe to nuke." Self-declared disposability.
- `access-control` (archived) — service account registry/MFA audit; likely
  folded into `claude-code-config` or `provisioning-agent`.
- `acumatica-ci-cd` (archived) — CLAUDE.md: "Split into acuops-pipeline
  (engine) + client-asthetik (HF instance)." Successors confirmed live.
- `acumatica-configs` (archived) — Acumatica config baseline; superseded by
  `client-asthetik`.
- `acumatica-hubspot-sync` (archived) — sync agent; superseded, likely by
  `webhook-router`'s sync pipeline.
- `acumatica-mcp` (archived) — consolidated into studiob-api per CLAUDE.md.
- `bolt-order-entry` (archived) — "CS Agent Order Entry"; superseded lineage
  (bootstrap manifest's `cs-order-entry` alias still points here — it was the
  last canonical attempt before the concept was dropped).
- `bolt-zoom-app` (archived) — "Zoom App embed for Order Hub"; the current
  Hub round-3 work (MEMORY.md, 2026-08-06) makes no reference to a
  Zoom-embedded surface.
- `client-smoke-test-001` (archived) — own description: "safe to hard-delete."
- `client-smoke-test-002` (archived) — sibling of the above, same class.
- `devops-mcp`, `godaddy-mcp`, `microsoft-mcp`, `zoom-mcp`, `hubspot-mcp`
  (all archived) — CLAUDE.md repo map states each explicitly: "Consolidated
  into studiob-api."
- `health-checker` (archived) — likely superseded by `business-dashboard` +
  the worker-staleness-watchdog pattern (Rule #298/#448).
- `hubspot-configs` (archived) — likely folded into `webhook-router`/
  `client-asthetik` config.
- `infra-config` (archived) — likely folded into `ops-pipeline` or per-repo
  configs.
- `integration-tester` (archived) — "End-to-end regression testing for all
  sync paths"; likely superseded by `ui-test-suite`.
- `nzt-prototype-archive` (archived) — self-describing name.
- `sales-intelligence-agent` (archived) — no successor identified; simply
  retired.
- `studiob-acumatica-ci-cd-template` (archived) — superseded alongside
  `acumatica-ci-cd`'s split.
- `studiob-aesthetik-orders-sync` (archived) — superseded, likely by
  `webhook-router`.
- `studiob-templates` (archived) — superseded by the
  `ops-template`/`studiob-client-template`/`studiob-test-template` family.

**Medium confidence (4, all active/unarchived):**

- `Acuminator` — this is a **fork** (`isFork: true`) of the public
  `Acumatica/Acuminator` tool. Last commit (5/12) merges an *upstream* PR by a
  non-Studio-B author (`SENya1990`); zero Studio B modifications, zero issues,
  zero Actions runs, and it hasn't even been kept in sync with upstream since.
  An unmaintained mirror, not Studio B work product. Also flagged: it's
  **PUBLIC** visibility inside an otherwise-private org — worth confirming
  that's intentional.
- `acumatica-order-entry` — "Multi-tenant SaaS app (Viewer, Order Entry, Full
  Suite...)," zero cross-references anywhere in org-wide code search (not even
  a self-referential README badge), pushed 3/8 (one of the oldest active
  pushes). The bootstrap manifest's `cs-order-entry` alias points at
  `bolt-order-entry` instead (now archived) — this repo reads as an earlier
  parallel prototype that its own sibling superseded, then got orphaned when
  the sibling was itself retired.
- `skuba-steve` — "Shopify Dev Agent"; zero cross-references, not even present
  in the bootstrap manifest (unlike siblings `skuba-apps`/`skuba-theme`), zero
  Actions runs ever, pushed 4/18. `asthetik-trade-theme` (the actual live
  Shopify theme) shows no sign of consuming it.
- `tiered-close-out` — "generic scaffold" by its own description, zero Actions
  runs, zero cross-references, pushed 4/26.

## Low-confidence rows needing controller/Kevin judgment (6)

- **`nexus-analyzer`** [IP] — "Economic sales-tax nexus analysis for Acumatica
  distributors evaluating AvaTax." Real described scope, zero cross-references,
  zero Actions runs, pushed 4/18. No confirming evidence either way.
- **`nzt`** [IP] — "OMO - One More Once: The Social Music Learning & Jam
  Platform." Description is **completely unrelated** to Studio B's Acumatica/
  textile business. Known Railway zombie (live project + billing, per
  scaffold), repo dormant since 4/26, zero Actions runs ever. Reads like a
  personal side-project riding on org infra — needs Kevin's call on intent,
  this sweep can't determine it from evidence alone.
- **`quarterbook`** [IP] — empty description, zero Actions runs, pushed 6/8
  (not yet 90-day-stale). Name suggests financial/accounting scope, possibly
  early tooling for the CFO seat opened 2026-08-05 per MEMORY.md — pure
  speculation, no confirming evidence.
- **`relay`** [IP] — empty description, known Railway zombie. Its own sibling
  `relay-website`'s design doc calls Relay "Exchange (not yet built)" — the
  underlying product may never have shipped, so the Railway deployment could
  be an unfinished stub rather than a working service.
- **`skuba-apps`, `skuba-theme`** [IP] — both empty description, siblings of
  `skuba-steve` (classified Dead above); no search budget was spent
  independently verifying these two specific names, so their classification
  rests entirely on sibling-naming inference.

## acu_graveyard_candidate (18 repos, per hard-flag rule — tag only, not a classification)

`Acuminator`, `acuconfig`, `acudev`, `acudocs`, `acudocs-extension`,
`acumatica-ci-cd`, `acumatica-configs`, `acumatica-hubspot-sync`,
`acumatica-lint`, `acumatica-mcp`, `acumatica-order-entry`, `acuops`,
`acuops-cli`, `acuops-hub`, `acuops-pipeline`, `acuops-website`, `acureport`,
`acusync`.

Worth the controller's attention as a group: this is 18 repos (11 active + 4
archived + `Acuminator` + `acumatica-order-entry`, both Dead-active) all
carrying Acumatica-tooling naming. Several are confirmed live/real
(`acuops-pipeline`, `acudev`, `acusync`, `acumatica-lint`, `gi-lint`'s pair),
several look like an unbuilt "AI-powered X agent for AcuOps" family
(`acuconfig`, `acudocs`, `acureport` — real described scope, no confirmed
integration into the executor mesh that `acudev`/`acusync` are confirmed
members of), and one (`acuops` bare) looks like a superseded monorepo shell.
This is the single largest naming-family in the org and the best-evidenced
candidate for a dedicated consolidation pass beyond what this sweep can fully
resolve from the outside.

## Notable IP: compliance-engine (Kevin already ruled on this one)

Not Dead, not a rediscovery needed — `bolt-wms/docs/plans/2026-04-15-bolt-
compliance-engine-decision.md` is an existing locked decision: "repo stays in
place. Code is parked, not deleted. Re-examined when (a) multi-tenant
onboarding is solved, (b) a paying customer surfaces real compliance-automation
demand, and (c) the scope is big enough to justify a dedicated workstream."
`project_bolt-packaging.md` separately confirms 1,666 LOC (routes + 4 workers)
but `compliance-engine-production.up.railway.app` → 404 (undeployed) — and
warns that selling it as an Enterprise feature "is dishonest" while it's in
this state. `enhancement-executor`'s routing table (`hubspot-client.ts`) still
has a live literal entry for it, worth checking whether that's dead code now.
Surfacing this here only because it's exactly the kind of repo a naive
staleness sweep would flag Dead — the locked decision doc is why it's IP
instead.

## COULD NOT VERIFY

- **Live Railway/DNS status for all 27 LIVE-SURFACE-CHECK-REQUIRED repos** —
  by task design, this sweep does not run Railway probes; that's explicitly
  the controller's #387-probe job. Everything in that section is "plausibly
  live," not "confirmed live."
- **Which repo (if any) backs the scaffold's `studiob-platform`,
  `wasala-platform`, `bolt-roth`, `aesthetik-production`/`aesthetik-staging`
  Railway projects, exhaustively.** `studiob-platform` plausibly hosts
  `acudev` (CLAUDE.md names this explicitly) plus others; `wasala-platform`
  plausibly maps to `lmmi-b-studio` (formerly Wasala per CLAUDE.md); `bolt-roth`
  has no plausible repo-name match at all (possibly a customer-specific
  deployment name, e.g. a "Roth" test instance of `bolt-wms`); the aesthetik
  environments plausibly map to `bolt-wms` (its own bootstrap-manifest alias is
  literally `aesthetik-platform`). None of this was independently confirmed —
  flagged as inference, not fact.
- **Exact execution status of the "2026-05-04 retire-divisions decision"**
  (`consulting-b-studio#1`) referenced in `brain/project_studio-b-positioning.md`
  — this sweep read the reference but did not open the PR or trace which of
  the seven `-b-studio` vertical sites actually got redirected/retired vs.
  which are still independently live. Directly affects how confidently the
  `fold_candidate` calls on that family of 7 repos should be acted on.
  RATE-LIMIT NOTE: the `gh search code` (code_search) API bucket is a tight
  10-requests-per-minute window (far tighter than the ~20-total budget implied
  in the task brief suggested) — 20 targets were still fully covered across two
  batches with a ~40s wait between them, but reading the actual PR content
  behind these hits was out of scope for the allotted search budget.
- **`acuconfig`, `acureport`** — classified Product at high confidence based on
  pattern-matching against the confirmed-live `acudev`/`acusync` sibling
  pattern and (for `acureport`) an explicit CLAUDE.md CFO-seat citation, but
  **no `gh search code` budget was spent confirming either directly** — this
  confidence level rests on inference from siblings, not direct cross-reference
  proof. Flagging so the controller can decide whether to spend 2 more search
  calls confirming them.
- **`skuba-apps`, `skuba-theme`, `dispatch-b-studio`, `dli-b-studio`,
  `nexus-analyzer`, `quarterbook`, `relay`, `nzt`** — all 6 (nexus-analyzer/
  quarterbook/relay/nzt/skuba-apps/skuba-theme) low-confidence rows above, plus
  `dispatch-b-studio`/`dli-b-studio` (medium confidence, IP) — none had direct,
  repo-specific verification beyond one shared design-doc citation or sibling
  inference. This is the honest floor of what a 20-search-call budget can cover
  across 77 active repos; the remaining ~57 repos not directly search-verified
  were classified from description text + enrichment signals (push recency,
  PR/issue counts, Actions activity) + CLAUDE.md/MEMORY.md canon citations
  where available.
- **GitHub code search recall limits, structurally.** `gh search code` only
  indexes each repo's **default branch**, has known gaps on very large files,
  and is described by GitHub itself as running on "a legacy code search
  engine" whose results may not match github.com's UI. A zero-hit result is
  evidence of likely non-use, not proof of it — every Dead/low-confidence
  classification resting partly on "zero cross-references found" carries this
  caveat.
- **GitHub Packages registry** — this sweep did not query
  `npm.pkg.github.com` directly; the four published packages surfaced
  (`@studio-b-ai/clients`, `@studio-b-ai/test-utils`, `@studio-b-ai/context-
  engine`, `@studio-b-ai/acuops-test-helpers`) were incidental hits inside
  `gh search code` results (specifically the OIDC-trusted-publishing-gotchas
  doc), not an exhaustive registry listing. There may be more published
  packages this sweep didn't surface.
- **Source-level verification of any repo's actual code** — all classification
  reasoning is from repo metadata (description, push/PR/issue/Actions
  signals), cross-repo documentation references, and CLAUDE.md/MEMORY.md canon.
  No repo's actual source tree was opened and read (out of scope/budget for a
  101-repo sweep) beyond the 5 local checkouts' `.github/workflows/` dirs.
- **Two `gh search code` calls initially failed on a self-inflicted query bug**
  (a stray trailing quote character malformed the search string for `ops-
  template` on the first pass) — caught immediately via a manual verification
  call and the entire 20-target batch was re-run cleanly; no data gap resulted,
  noting only as a methodology correction for transparency.

## Output files

- `/private/tmp/claude-501/-Users-kevin-dev/b7c2030a-0bf2-4912-b91e-f3db1900d976/scratchpad/repo-rationalization/evidence.jsonl` — 101 rows, one per repo
- `/private/tmp/claude-501/-Users-kevin-dev/b7c2030a-0bf2-4912-b91e-f3db1900d976/scratchpad/repo-rationalization/SWEEP-REPORT.md` — this file
- `/private/tmp/claude-501/-Users-kevin-dev/b7c2030a-0bf2-4912-b91e-f3db1900d976/scratchpad/repo-rationalization/raw-repo-list.json` — raw `gh repo list` output (101 repos, full metadata)
- `/private/tmp/claude-501/-Users-kevin-dev/b7c2030a-0bf2-4912-b91e-f3db1900d976/scratchpad/repo-rationalization/enrich/*.json` — per-repo enrichment (77 active repos)
- `/private/tmp/claude-501/-Users-kevin-dev/b7c2030a-0bf2-4912-b91e-f3db1900d976/scratchpad/repo-rationalization/search_results/*.txt` — raw `gh search code` output for the 20 consumer-signal targets
