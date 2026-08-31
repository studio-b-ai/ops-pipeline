# ops#250 — Squasher fleet sweep: relocate autonomous merges to where the PEM lives

**Status:** design — codex-reviewed 2026-08-31 02:2xZ, **zero P1**; the four P2 + three P3 findings are
folded in below (marked ⟨codex⟩) · **Owner:** Mechanic seat · **Date:** 2026-08-31
**Supersedes:** the "mint in the reusable gate" fix filed on ops#250 (premise falsified — see §1), and
`automerge-sweep.yml`'s header doctrine "the squasher fleet rollout is a separate, per-repo decision.
One repo, one sweep shape." Per-repo callers are structurally incapable of un-suppressed merges under
D3; the sweep shape must be fleet-central for the squasher.

## 1. Problem — three latent legs, one genus

1. **Merge-event suppression.** The reusable gate (`.github/workflows/squasher-automerge.yml`) merges
   with `GH_TOKEN: ${{ github.token }}`. GitHub suppresses workflow triggers for GITHUB_TOKEN-caused
   events (Rule #38's named class) — so on every **autonomous** merge, the target repo's
   `pull_request: [closed]` post-merge tripwire never runs and push-to-main workflows are suppressed.
   Known-bad baseline: **wr#806** (merged 2026-08-31 01:49:17Z, `mergedBy=app/github-actions`, sha
   9a1e2300 — zero tripwire runs; every hand-merged PR the same night produced one within seconds).
   Railway deploys are unaffected (Railway's own GitHub App webhook, not Actions).
2. **Tripwire revert-mint inert since birth.** `FLEET_APP_ID`/`FLEET_APP_PRIVATE_KEY` exist **only in
   ops-pipeline repo secrets** (verified via `gh secret list` on every caller repo + the org-secrets
   admin view). webhook-router's tripwire caller maps them anyway → empty strings → the revert-leg App
   mint would fail at first TRIP (Rule #38: missing secret = empty string + misleading error).
3. **Same defect on the train legs.** Per-repo callers also run `train_ready: true` evaluations and
   merge with `github.token` — train merges are equally suppression-broken (never surfaced: both prior
   tripwire firings were hand merges, #464).

**Root constraint (locked D3, CTO):** one fleet App (`studiob-fleet-bot`, App ID 4595770, installation
153748636, `repository_selection=all`), **PEM held ONLY in ops-pipeline**. A reusable workflow executes
in the **caller's** secrets context, so no caller-context design can ever mint — the filed fix is dead
as written. The merge execution must move to where the PEM lives.

**Fleet App permissions (verified live 2026-08-31):** actions:write · checks:read · contents:write ·
issues:write · members:read · metadata:read · organization_administration:read · pull_requests:write ·
workflows:write. Sufficient for cross-repo enumeration, `statusCheckRollup` traversal (incl.
`checkSuite.workflowRun` — the ops#19 actions-resource lesson), sha-pinned merges, labels, comments,
and workflow dispatch.

## 2. Design — (B) ops-pipeline-resident fleet sweep

Working sibling (#168): `automerge-sweep.yml`, the train self-sweep. The fleet sweep is that shape,
pointed outward, minting App tokens.

### 2.1 New workflow: `.github/workflows/squasher-fleet-sweep.yml` (ops-pipeline)

- **Triggers:** `schedule: cron "11 * * * *"` (off :00/:30 peaks #298, off the train self-sweep's :41;
  the retiring caller minutes are irrelevant post-cutover) + `workflow_dispatch` with `repo` +
  `pr_number` inputs ("evaluate NOW" — replaces the callers' dispatch affordance). Both inputs
  validated before matrix interpolation (positive-integer PR, repo ∈ fleet config — the codex-P3
  pattern from the train sweep).
- **Job 1 `determine-prs`:** mints its own App token (heritage-restart-train sibling:
  `actions/create-github-app-token@v1`, `owner: studio-b-ai`, fail-loud empty-token step), reads
  `scripts/squasher-fleet.json`, enumerates open `bugsquasher` **and** `train:ready` PRs per fleet
  repo (`gh pr list --repo … --label … --limit 100` #331), emits a matrix of
  `{repo, pr_number, train_ready, enabled_classes, sensitive_path_patterns, safe_path_globs,
  required_checks}` entries. `MAX_FANOUT: 20` with a loud over-cap warning (#331 — no silent caps).
  Tokens are never passed between jobs (GitHub masks/blocks secrets in outputs) — each job mints its
  own.
- **Job 2 `gate`:** matrix over the entries, `uses: ./.github/workflows/squasher-automerge.yml` with
  the entry's inputs + `secrets: ANTHROPIC_API_KEY / FLEET_APP_ID / FLEET_APP_PRIVATE_KEY`. The
  reusable's existing per-(repo,PR) concurrency group carries over unchanged.

### 2.2 Reusable gate changes (`.github/workflows/squasher-automerge.yml`)

- `secrets:` block adds `FLEET_APP_ID` + `FLEET_APP_PRIVATE_KEY`, **required: true** — optional-with-
  fallback would let the suppression silently return (#412/#464). Making them required also
  **fail-closes every un-retired legacy caller loudly** (missing secret = error at call time, no
  merge) — the cutover cannot half-work.
- New mint step (sibling pattern) + fail-loud empty-token check before the gate step.
- The "Run pr-automerge-gate" step's env changes `GH_TOKEN: ${{ github.token }}` →
  `GH_TOKEN: ${{ steps.mint.outputs.token }}`. **The gate script itself is zero-diff**: every read and
  write already flows through the `gh()` helper, which inherits env; cross-repo reads need the App
  token anyway, so there is no read/write token split to engineer. Evaluation semantics (GraphQL
  label attribution, sha-pinned merge, CLEAN-only review) are untouched.
- Checkout simplifies in practice: the caller is now ops-pipeline itself, so the scripts checkout is
  an own-repo read.

### 2.3 Fleet config: `scripts/squasher-fleet.json`

Caller inputs migrate **verbatim** (extracted from each caller on origin/main, 2026-08-31):

| repo | legacy cron | enabled_classes | sensitive_path_patterns | safe_path_globs | required_checks | train leg |
|---|---|---|---|---|---|---|
| bolt-wms | :17 | docs-comment,ci-infra,test-only | `^\.github/actions/` | — | — | yes |
| studiob | :23 | (default docs-comment) | — | — | — | no |
| studiob-price-sync | :29 | (default) | — | — | — | yes |
| asthetik-trade-theme | :35 | (default) | — | — | — | yes |
| asthetik-portal | :47 | (default) | — | — | — | yes |
| webhook-router | :53 | docs-comment,code-fix | `^\.github/actions/,(^\|/)(auth\|credential\|secret\|token)` | `src/**` | Build & Check,Cross-System QA / API Tests (Vitest) | yes |

Notes: bolt-wms composes its own `require-review-label.yml` check on sensitive paths — that check
gates via the full-CI-rollup leg and needs nothing here. wr's gitleaks check name contains a comma and
cannot ride the comma-split `required_checks` input — unchanged pre-existing limitation, still gated
by the full-rollup leg. (Follow-up, not this PR: teach the gate script to read this config file
directly and retire the comma-split inputs.)

⟨codex P2⟩ **`required_checks` applies to squasher invocations only.** Train mode deliberately does
not forward it (reusable gate lines ~129-136; `automerge-args.ts` rejects `--train-ready` combined
with required-check flags; named-check enforcement in train mode is a standing TODO at
`pr-automerge-gate.ts:854`). The sweep passes `required_checks` only on `bugsquasher` entries;
`train:ready` entries pass only `train_ready: true` — exact status quo.

⟨codex P3⟩ This config file is **enumeration + gate inputs only** — it is NOT class policy.
`repoClassFor()` (`automerge-classify.ts:519`) stays the hardcoded source of truth for
train-class/code-fix partitioning; the fleet config never overrides it.

### 2.4 Per-repo caller retirement (6 PRs)

Delete `.github/workflows/squasher-automerge.yml` in each caller repo. This retires both the squasher
leg **and** the train leg per repo — deliberate: leaving train legs alive would knowingly preserve a
suppressed-merge path, and the fleet sweep absorbs `train:ready` enumeration with identical gate
semantics (authority still = a human's GraphQL-attributed `train:ready` label; only the cron's
residence and the merging token change). Zero open `train:ready` PRs fleet-wide at design time, so the
cutover pause costs nothing on the train side.

`automerge-sweep.yml` (ops-pipeline self-sweep) **stays** — it covers ops-pipeline's own PRs, which
the fleet sweep deliberately excludes (one repo, one sweep). It passes the two new required secrets in
the same PR; its merges thereby also become App-token merges (side benefit: un-suppressed events on
ops-pipeline train merges).

### 2.5 Tripwire revert leg (same D3 wall, settled here)

The tripwire caller still executes in the target repo, which can never mint under D3. Fix in the same
ops-pipeline PR:

- Reusable `post-merge-tripwire.yml`: drop the App-mint; create the revert PR with `github.token`.
  Consequence: the revert PR gets no CI runs (GITHUB_TOKEN-created) — acceptable because revert PRs
  are **human-merged by standing law** anyway; the human triggers CI with a close/reopen (#303's
  human-token pattern), documented in the revert PR body template.
  ⟨codex P2⟩ That documentation does not exist yet: the current body template
  (`post-merge-tripwire.ts:279-288`) says only "never auto-merged", and the CI-less warning lives
  only in workflow logs (`post-merge-tripwire.yml:154-168`). So the tripwire **script** takes a small
  edit — add the close/reopen-for-CI instruction to the revert PR body. (The GATE script stays
  zero-diff; the zero-diff claim was always gate-scoped.)
  ⟨codex P3⟩ Attribution mismatch handled in the same edit: `post-merge-tripwire.ts:73-74` hardcodes
  the revert commit author as `studiob-fleet-bot` while the actor will now be `github-actions[bot]` —
  align the commit identity with the actual actor.
- webhook-router caller PR: drop the two dead `FLEET_APP_*` secret mappings (they resolve empty
  today).
- Noted alternative if revert-CI friction proves real: an ops-pipeline-resident revert executor
  (App-token PR creation on a `repository_dispatch`/marker signal). Not built now (#28 vs YAGNI — the
  human is already in the loop).

### 2.6 Rejected alternatives

- **(A) Distribute the PEM** to callers or an org secret — contradicts locked D3. Rejected.
- **(C′) Two-phase label relay** (caller gate applies an approved-label; ops-pipeline executor
  merges) — splits authority across runs and re-opens the label-attribution surface the train side
  closed with GraphQL attribution. Rejected.
- **PAT instead of App** — Rule #38 prefers App installation tokens (rotate, correct attribution);
  a PAT is a person's ambient authority. Rejected.

## 3. Cutover sequence (fail-closed at every step)

0. ⟨codex P2⟩ **Instant fleet pause first:** `gh workflow disable squasher-automerge.yml` on all six
   caller repos in one pass (reversible, fail-closed). Six independent retirement PRs cannot land
   atomically — until each lands, that repo's hourly cron could still merge via the old suppressed
   path; the disable closes that window in seconds. Verify no caller run is queued/in-progress after
   the disable.
1. **Merge the 6 caller-retirement PRs.** Autonomous merges + train evaluation pause fleet-wide
   (fail-closed; queued `bugsquasher` PRs lose only latency, #462), preserving the #471 proving
   vehicle.
2. **Merge the ops-pipeline PR** (sweep + reusable + fleet config + automerge-sweep secrets + tripwire
   revert-leg change). If order inverts by accident, legacy callers red-fail loudly on the now-required
   secrets — noisy, but no unsafe merge can occur.
3. **Prove (#471/#280)** — see §4. Only then declare the interim over.

Interim state until step 3 completes (unchanged from the ops#250 correction comment, #412): autonomous
merges tripwire-OFF → paused at step 1 → restored un-suppressed at step 3. Mechanic session is the
manual tripwire throughout.

## 4. Verification (#471 both directions, #280 real firings)

- **Trigger it for real (#280):** `workflow_dispatch` the fleet sweep with `repo=webhook-router`,
  `pr_number=<vehicle>` (wr#811 if still open; else the squasher's next PR — it self-feeds). A
  scheduled run must also be observed completing (cron identifiers/skips are exactly where workflows
  break silently, #280/#320).
- **Known-good (the non-default verdict, #471):** the vehicle's autonomous merge must show
  `mergedBy = studiob-fleet-bot[bot]` **and** a tripwire-caller run **CREATED** in webhook-router for
  the merged PR (running its health leg, not merely skipped), green. wr#806 = banked known-bad
  baseline (zero runs). ⟨codex P2⟩ Also assert at least one **push-triggered** workflow run exists on
  the merge commit in the target repo (§1 names push-to-main suppression as part of the defect; the
  tripwire alone doesn't prove that half). If the target repo has no push-to-main workflows, say so
  and narrow the criterion explicitly rather than silently.
- **Known-bad still refused:** a fleet-sweep evaluation of a PR that fails the gate (red CI or
  unlisted skip) must refuse exactly as before — the gate script is zero-diff, but one observed
  refusal through the new path guards the token swap.
- **Retirement verified by absence + reach (#322):** post-cutover, each caller repo shows no caller
  cron runs after the retirement merge (positive control: the runs that existed before it).
- **Empty-sweep honesty (#465):** a cycle finding zero labeled PRs logs the per-repo enumeration
  counts, so "no candidates" is distinguishable from "blind instrument".

## 5. Risks / notes

- **Fanout:** 6 repos × open labeled PRs, capped at 20 with a loud warning (#331). Installation-token
  rate limits (5k/hr) are far above this usage.
- **#356:** cron lateness up to ~2h is tolerable (latency-only). The sweep is idempotent — the gate
  re-derives everything per cycle; a rerun after a merge finds no open PR.
- **Attribution change:** merges now read `studiob-fleet-bot[bot]`. Anything keying on
  `app/github-actions` as "the gate merged this" must key on the label + gate receipt instead (grep
  showed no such consumer; the tripwire keys on the label).
- **Train-machinery touch:** train evaluation moves residence without authority change; flagged in the
  PR body. Fail-closed worst case: train PRs don't merge until fixed — and a human labeled them, so a
  human notices.
- The squasher itself (bug-hunting cron) is untouched — this is only the merge-gate side.
