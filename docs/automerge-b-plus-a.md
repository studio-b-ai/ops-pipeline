# Squasher gate "B+A" — label-gated merges fleet-wide + the `code-fix` class (rung 0: design)

**Status:** rung 0 of `ops-pipeline#190`. Design only — NOTHING here is built. The gate's live behavior is exactly what `scripts/pr-automerge-gate.ts` does today until each rung below ships with its own plant receipts (#464/#471). Until then Kevin's "🐛 Merge to approve" texts keep coming; that is the honest state (#355).

**Ruling (Kevin, 2026-08-22 ~03:5xZ, verbatim): "b+A"** — answering the fork put to him after "I just went and merged a handful of PRs in various repos. I thought you were supposed to be automerging?" + the screenshot of five "🐛 Merge to approve" texts ("this is what I'm talking about"). Rule #279's exception set therefore widens: exception 2 (the 8/19 label-gated restart train) generalizes fleet-wide (**A**); exception 3, a squasher `code-fix` class under guardrails, is new (**B**). The rule text is the Dispatcher's to amend at the Friday batch; `#190` is the build of record; this doc is the design the build follows.

## 1. The substrate today (read 2026-08-22, every file in full)

| Piece | Where | What it does today | B+A touches it? |
|---|---|---|---|
| Gate runner | `scripts/pr-automerge-gate.ts` | Per PR: ci-rollup → truncation → diff-by-sha → `classifyPrDiffClass` → enabled-classes → `gateDecisionForClass` (author `kbibelhausen` + label `bugsquasher`) → paid independent review (Sonnet, strict `CLEAN`) → `gh pr merge --squash --match-head-commit <headRefOid>` → `[gate-receipt]` line + receipt comment. Never labels/closes/edits a PR. | A1 adds the label path; B3 adds one restart-class hand-off (§4.3). |
| Classifier | `scripts/lib/automerge-classify.ts` | `PrDiffClass = docs-comment (≤10) \| ci-infra (≤40) \| test-only (≤40)`; `sensitivePathPatterns` any-hit → `null`; `isMigrationPath = /migrat/i`; manifests/lockfiles disqualify ci-infra/test-only; `isRollupClean` (supersession-aware, in-flight = not clean, ties fail closed). | B1 adds `code-fix`. |
| Review prompt | `scripts/lib/automerge-review-prompt.ts` | `BASE_REVIEW_SYSTEM` = "CLEAN iff purely docs/comment/copy" (+ the test-only assertion question). **A code diff can NEVER be CLEAN under this prompt** — both new paths need their own prompt (§3.2, §4.1). | A1 + B1 add two prompts. |
| Args | `scripts/lib/automerge-args.ts` | `--enabled-classes` validated against `ALL_PR_DIFF_CLASSES`, default `docs-comment`. | B1 extends the allowlist; default unchanged. |
| Reusable workflow | `.github/workflows/squasher-automerge.yml` (`workflow_call`) | inputs `repo`, `pr_number`, `enabled_classes`, `sensitive_path_patterns`; secret `ANTHROPIC_API_KEY`; runs the gate with the CALLER's `github.token`. | A1/B2 add inputs + a canary job. |
| Callers | bolt-wms (`17 * * * *`, classes docs-comment,ci-infra,test-only) · studiob (`23`) · asthetik-trade-theme (`35`) · studiob-price-sync (`29`) · webhook-router = `#718` (`41`, OPEN, waits for the `reviewed` click) | `determine-prs` = `gh pr list --label bugsquasher` → `evaluate` matrix over the array. | A2 enumerates `train:ready` too. |
| Restart-train library | `scripts/lib/restart-train-lib.ts` (pure; 102 tests) | `repoClassFor(repo)` → `client-asthetik \| studiob \| other`; `parseTrainPin` (grammar below); `orderQueue` invalidates a ticket whose head drifted from its pin; window law (`windowState`, `isBusinessHoursBlockedET`, `isBatchBlackoutUtc`). | A imports `repoClassFor` + `parseTrainPin` — never a second reader. |
| Restart-train worker | `scripts/restart-train.ts` + `.github/workflows/heritage-restart-train.yml` | **LIVE rung 0** since `HERITAGE_TRAIN_ENABLED=true` (set 2026-08-20T00:39Z): `*/5` cron, reads `train:ready` PRs on `studiob` + `client-asthetik`, excludes any without a `TRAIN-PIN` comment, honors `train:hold` on `#172`, posts `PLAN (dry-run)`/`HELD` to `#172` (first live `HELD` receipt 2026-08-21T19:55Z). `--fire` throws. | A1's pin workflow is the train's own unbuilt "Day 1" step. |
| Railway probes | `scripts/lib/railway-deployment-probes.ts` | `fetchProjectRefs`, `fetchServiceDeployments`, `latestSuccessfulDeployment`, `RAILWAY_TERMINAL_STATUSES`. | B2 reuses them (#283). |
| Issues lib | `scripts/lib/github-issues.ts` | `gh`, `listIssueComments`, `commentIssue`, `removeLabel`, `openIssue`, `closeIssue`, `ensureLabel`. | A1/B2 reuse. |

The pin grammar the train already parses (`TRAIN_PIN_RE`, latest pin wins, 40-hex sha required):

```
`TRAIN-PIN 2026-08-22T04:00:00Z · head=<40-hex sha> · applied-by=<login>`
```

Its doc comment says it is "a PROPOSED CONVENTION … whoever builds the label-apply step must emit exactly this format". A1 is that step.

**Finding that reshapes §4 (read live 2026-08-22T04:22Z via the Railway GraphQL `serviceInstances.watchPatterns` sweep): `studiob-api` — and the three other `studiob`-repo services (`desk`, `auto-remediate`, `cos-brief-worker`) — have `watchPatterns = []` and `rootDirectory = /`.** Every merge to `studiob` main, docs included, redeploys all four, and a studiob-api boot is a #310 login burst against Heritage's api-bot seats. This is the read the 8/19 decision asked for before amending the squasher ("read the dashboard watch scope first") — the answer is "unfiltered". Consequences: (a) the train's rung 4 (`pr-automerge-gate.ts` honors `train:hold`) is needed NOW, for the docs-comment class the studiob caller already auto-merges — it ships as A1's first sub-leg; (b) `studiob` is restart-class for EVERY class, so its `code-fix` autonomy is coupled to the train's rung 3 (§4.3) and it moves to the END of the B3 order; (c) a watch-pattern on studiob-api is a separate Engineer/Kevin-gated Railway config change (filed alongside this doc), not something this build does. `bolt-wms` and `webhook-router` are also `watch=[]` (every merge redeploys) — expected, and not a #310 class (both reach Acumatica only through the gateway).

## 2. One label, two executors

`train:ready` means ONE thing to the human who applies it: **"this is merge-authorized; the machine picks the safe moment."** Which machine is decided by the repo, never by the human:

| `repoClassFor(repo)` | Executor | Safe moment |
|---|---|---|
| `studiob`, `client-asthetik` (restart-class) | the Heritage restart train (`#172`) | the window law — ≥30 min after the last restart END · outside 06:00–18:00 ET Mon–Fri for client-asthetik · outside 05:45–08:15Z · one ticket in flight · no `train:hold` |
| `other` (every squasher-supported repo) | the squasher gate's sweep | the next sweep tick once CI is green and the review is CLEAN |

The squasher gate DECLINES `train:ready` PRs on restart-class repos with `[wait] train-owned` (and their callers do not enumerate the label at all — belt and braces). A distinct label per executor was considered and rejected: it would make the human learn the topology; the point of A is that the label is the whole human interface.

`train:hold` keeps its meaning everywhere: on `ops-pipeline#172` it is the GLOBAL hold both executors read (the Dispatcher's window reservations already put it there — 2026-08-21 19:49Z→21:35Z was the first); on a PR it is a per-PR pause the squasher path honors too.

## 3. A — the label path

### 3.1 A1 (a): `train:hold` honored unconditionally — the train's rung 4, first

Before any other leg and before any class logic, the gate reads `train:hold` on `ops-pipeline#172` (one `gh issue view --json labels`) and on the PR itself. Present → `[wait] hold` receipt, no diff fetch, no spend, for EVERY path including today's docs-comment — and the same read repeats at the `revalidate` leg (§3.2 leg 10) right before the merge call, so a hold applied mid-evaluation also stops the merge. Plant: label the tracker, sweep a known-good docs PR, expect the hold receipt; remove, expect the merge; plant #2 = apply the hold while a sweep is between its review and merge legs (a planted slow review, `REVIEW_DELAY_MS` probe-scoped), expect `[wait] state changed during evaluation: hold`. This sub-leg ships alone, first, because of the §1 finding.

### 3.1 A1 (b): the pin workflow — `train-ready-pin.yml` (reusable) + a thin caller per repo

Trigger: `pull_request: types: [labeled, synchronize]` in the CALLER repo (it must run where the event fires — a reusable workflow in ops-pipeline cannot subscribe to another repo's events). Untrusted event strings go through `env`, never inline (#61 shape, as the train workflow does). Behavior:

- **`labeled` with `train:ready`** → FIRST the **authority gate** (codex pass-1 P1 #1/#2, §11): `${{ github.event.sender.login }}` must be in the merge-authority ROSTER (§3.2 leg 7 — org Actions variable `MERGE_AUTHORITY_LOGINS`, today exactly `kbibelhausen`) AND hold `write`+ on the repo (the floor). Not authorized → `gh pr edit --remove-label train:ready` + comment `` `not merge-authorized: <login> — train:ready removed (roster: ops-pipeline#190 §3.2)` `` and STOP: no pin is ever posted, so neither executor can act on an unauthorized label (fail-closed at the source, not at the consumer). Authorized → post exactly `` `TRAIN-PIN <now ISO> · head=${{ github.event.pull_request.head.sha }} · applied-by=${{ github.event.sender.login }}` `` as a PR comment (the train's grammar, byte-exact; a wire-format test in ops-pipeline asserts `parseTrainPin` round-trips the emitted string) — **unless the PR already carries a workflow-authored pin for the same head sha** (the B3 hand-off, §4.3: one pin per head, never a second that would win `latest pin wins`) — then dispatch the caller's sweep for this PR (`gh workflow run squasher-automerge.yml -f pr_number=N`; `workflow_dispatch` is one of the two events a `GITHUB_TOKEN` action IS allowed to trigger) so a green PR does not wait up to an hour for the cron.
- **`synchronize` while `train:ready` is present** → `gh pr edit --remove-label train:ready` + comment `head moved (<old12> → <new12>) — train:ready removed; re-label to re-pin`. This is design v0's "a later push invalidates the ticket (label auto-removed, comment says why)". Force-pushes fire `synchronize` too.
- **Fork PRs** get a read-only token: the pin cannot be posted and the label cannot be removed. Both failures are fail-closed (no pin → never merges; stale pin → drift decline) — stated, not fixed.
- On restart-class repos the same workflow runs and the same pin is what the TRAIN reads — this closes the train's own "Day 1" gap, so the train moves from "every `train:ready` PR is excluded for lack of a pin" to live queue reads with **one additive train change** (codex pass-1 P1 #1 — the earlier "no train code change" claim was wrong): the train's ticket step (`scripts/restart-train.ts` ticket building, which today accepts `train:ready` + any valid pin) gains the same roster check on the pin's `applied-by` — an unauthorized applier never becomes a ticket (`invalid: applier not merge-authorized`). Defense in depth behind the pin workflow's refusal: the workflow can be absent on a repo, or its label removal can have failed (fork token) — the train must not trust a pin's existence as proof of authority.

`parseTrainPin(comments, { allowedLogins? })` gains an optional pin-AUTHOR allowlist (`github-actions[bot]` — the identity of both the pin workflow and the B3 hand-off, which run on the caller's `GITHUB_TOKEN`; the train passes the same set). A hand-typed pin is ignored (fail-closed to "no pin"). The author allowlist is NOT the authority check: `applied-by` is written by the workflow from the trusted event payload, and it is what the roster check (leg 7 / the train's ticket step) reads. Default `undefined` preserves today's behavior; the 102 existing tests stay green.

### 3.2 A1 (c): the gate's label path

New pure module `scripts/lib/automerge-label-path.ts` (unit-tested like the classifier) + the runner wiring. Evaluation order, cheap → paid; the first failing leg decides and is the receipt's `leg`:

1. `ci-rollup` — unchanged and still first (OPEN · `isRollupClean` · `mergeStateStatus === "CLEAN"`). "Merge when green" is this leg re-running at the next sweep.
2. `truncation` — unchanged.
3. `hold` — §3.1(a).
4. `label` — `train:ready` present. Absent → fall through to the class path exactly as today (no behavior change for unlabeled PRs).
5. `train-owned` — `repoClassFor(repo) !== "other"` → `[wait] train-owned`.
6. `pin` — `parseTrainPin(listIssueComments(...), { allowedLogins })` non-null AND `pinnedHeadSha === prJson.headRefOid`. Drift → `[wait] head drift: pinned X != current Y` (the train's own reason string; the pin workflow will have removed the label by then in the normal case — this leg is the defense when it could not).
7. `label-authority` — the label carries "exactly today's authority" (8/19 decision: *in-arc manager … or Kevin*) only if the applier IS that authority. **Authority is an explicit ROSTER, never a repo-permission class** (codex pass-1 P1 #2: `write`-as-authority would let any collaborator self-authorize an auto-merge — a widening of the locked decision): `applied-by` ∈ `MERGE_AUTHORITY_LOGINS` (org-level Actions variable read by the pin workflow, the gate and the train; today exactly `kbibelhausen` — every seat acts through Kevin's login; a seat identity of its own is added to the roster only by Kevin's hand) AND not a `[bot]` AND `GET /repos/{repo}/collaborators/{login}/permission` ∈ {`admin`, `maintain`, `write`} as the FLOOR (a roster login whose collaborator access was revoked must not keep authority). Triage can label but cannot merge; a write collaborator outside the roster cannot self-authorize. The roster entry IS the "a human reviewed this" attestation leg 9 relies on — a second, separate APPROVED review is not required (Kevin is the sole human reviewer today; a second click would be theater, and the roster is where a second reviewer is added when one exists). (Verify live at A1 that the caller's `github.token` can read the permission endpoint (#50); fallback = the fleet App token with `metadata:read`.)
8. `review-size` — `additions + deletions ≤ 1500` and diff bytes ≤ 400 KB, else `[wait] too large for independent review — merge by hand` (#88: bounded spend; an oversize human PR is exactly the kind a human should click).
9. `review` — the paid leg with `LABEL_PATH_REVIEW_SYSTEM` (new; `BASE_REVIEW_SYSTEM` would FLAG every code diff). The bar is catastrophic-class only — the roster applier (leg 7) reviewed the change by definition: CLEAN iff none of: secrets/credentials/tokens in the diff · destructive data/migration operations · auth/authz/tenant-scoping (`setTenantSchema`, middleware exemptions) loosened · tests deleted/weakened/skipped (the existing test-only question, reused) · CI checks, hooks, lints disabled · `--force`/`rm -rf`/prod-destructive commands · an obvious runtime crash. Strict `raw === "CLEAN"` parse and fail-closed API errors, unchanged.
10. `revalidate` — **immediately before the merge call, after the paid leg** (codex pass-1 P1 #3: state checked at legs 3–7 and then trusted through a paid review is a fail-open window — a hold applied, a label removed, or a pin replaced mid-evaluation would still merge). One re-read pass: `train:hold` on `ops-pipeline#172` and on the PR · the PR's labels (`train:ready` still present on the label path; `bugsquasher` still present on the class path) · the latest pin (same comment id, same head sha, same `applied-by`) · `headRefOid` · state `OPEN` + `mergeStateStatus === "CLEAN"`. Any delta → `[wait] state changed during evaluation: <field>` and NO merge. The residual window is one API round-trip (seconds), stated and accepted; `--match-head-commit` closes the head-sha half at GitHub's side. This leg runs on EVERY path, today's docs-comment class included, and ships in A1(a) together with the hold leg (one PR — they are one property: *the state that authorized the merge still holds at the merge*).
11. `merge` — `gh pr merge --squash --match-head-commit <headRefOid>`, unchanged. Receipt comment gains a `path: label` row (`applied-by`, pin ISO, evaluated sha).

Legs the label path does NOT run: class-match · enabled-classes · line cap · `author === kbibelhausen` · `bugsquasher` label. A PR carrying both labels takes the label path (human authority outranks class inference); the receipt says which path ran. Telemetry: `formatGateReceiptLine`'s `prClass` gains `"label-gated"` (and `"code-fix"` for B1). `scripts/squasher-health.ts` needs NO change for that (codex pass-1 P3 #7 corrected an earlier false claim here): `squasher-health-classify.ts` parses `class=(\S+)` as an opaque token and its conditions key only on `leg=other` + run liveness/failure — the only contract is that the new values stay whitespace-free (they do); the receipt legend in `docs/` gains the two values.

The gate stays non-mutating on PRs (no label writes) — the pin workflow owns the label lifecycle. The one exception is the B3 restart-class hand-off (§4.3), receipted as such.

### 3.3 A2: callers enumerate both labels

`determine-prs` becomes two `gh pr list` calls (`--label bugsquasher`, `--label train:ready`) merged with `jq 'unique'`, same `MAX_FANOUT` cap + warning; restart-class callers (studiob) keep enumerating `bugsquasher` only. Each caller also gets the thin `train-ready-pin.yml` caller. Cadence: with the pin workflow's immediate dispatch the hourly sweep is only the catch-up path; moving the sweeps to `*/15` with the existing per-repo minute offsets preserved (`17,32,47,2`) is cheap (the sweep is one `gh pr list` unless candidates exist) and is proposed here for the codex pass to weigh.

**A2 order (changed 2026-08-22 for the demo freeze):** the Engineer's demo-freeze pins hold `studiob` (`c64a1ac`), `webhook-router` (`7ece7867`) and `bolt-wms` (`844bf760`) through the Monday 2026-08-24 demo — no plants and no merges into those three before the pins lift unless Kevin says otherwise. So A2's first target is **ops-pipeline itself**: a thin caller of its own reusable workflow (dogfood — `other` class, `docs-comment` default, no deploy behind a merge), then `studiob-price-sync` and `asthetik-trade-theme` (unpinned), then `webhook-router` once its pin lifts and `#718` has landed, then `bolt-wms`.

**A2 plants (one human label-click each — the label IS the authority, so a plant cannot self-apply it):** known-good = a trivial docs PR labeled `train:ready` by a roster login → merges with a `path: label` receipt; known-bad #1 = labeled, then one more push → label auto-removed + comment, sweep receipt `head drift`; known-bad #2 = `train:hold` on `#172` → `[wait] hold`; known-bad #3 = a hand-typed pin comment only → `[wait] no pin`; known-bad #4 = the label applied by a non-roster login (a test collaborator with `write`, or a planted roster variable that excludes the applier) → label removed + `not merge-authorized` comment, no pin, no merge. Receipts on `#190`.

## 4. B — the `code-fix` class

### 4.1 B1: classifier + prompt

`PrDiffClass` gains `"code-fix"`; `ALL_PR_DIFF_CLASSES` and the `--enabled-classes` validator extend; **the default stays `docs-comment`** — `code-fix` is opt-in per caller (`enabled_classes`), exactly how ci-infra/test-only were introduced. Shape (all must hold; any miss → the candidate fails like the others, and a mixed shape still resolves `null`):

- `totalChangedLines ≤ 150` (Kevin's number; the 151-line refusal is a unit test).
- No binary file; no file matching the **built-in denylist** (fleet-invariant, in the classifier): `isMigrationPath` (`/migrat/i`) · `\.sql$` · `(^|/)Customization/` · `^\.github/` (workflows AND actions — CI shape is ci-infra's domain; a fix that also edits CI is mixed) · **package manifests/lockfiles — the classifier's list is npm-only today (`package.json` + npm/yarn/pnpm lockfiles; codex pass-1 P2 #6) and B1 extends it into ONE shared `isManifestPath` used by ci-infra, test-only AND code-fix:** `bun.lock(b)` · `deno.lock` · `requirements*.txt`, `pyproject.toml`, `poetry.lock`, `Pipfile(.lock)`, `setup.(py|cfg)`, `uv.lock` · `go.(mod|sum)` · `Gemfile(.lock)` · `Cargo.(toml|lock)` · `composer.(json|lock)` · `*.csproj`, `packages.config`, `Directory.Packages.props`, `*.nuspec` (the Acumatica C# side) · runtime pins `.nvmrc`, `.node-version`, `.python-version`, `.tool-versions` (a runtime bump changes boot behavior the same way a dependency does) · `(^|/)(Dockerfile|railway\.(toml|json))$`, `^infra/railway/` (deploy config changes boot behavior, #68/#69) · `(^|/)\.env` · any path segment matching `/(auth|middleware|entra|session|permission|secret|credential|pricing|promote|worksheet)/i` (over-matching is tolerated on purpose — `author.ts` waiting for a human costs a click; an auth file auto-merging costs an incident). Widening the shared manifest list also narrows the two existing classes — strictly more conservative, so it rides in B1 without a separate ruling.
- Plus the caller's `sensitive_path_patterns` (per-repo names the built-ins cannot know: bolt-wms pricing-write paths, webhook-router's `.github/actions/`), unchanged mechanics (any hit → `null`, malformed regex → `null`).
- Author `kbibelhausen` + label `bugsquasher` — the existing `gateDecisionForClass` legs, unchanged.
- "CI green **including the wire-format tests**" is satisfied by `isRollupClean` over the repo's full status-check rollup (every check, not only branch-protection-required ones) — the gate cannot inspect a suite's contents; a repo whose wire tests are not in CI does not get `code-fix` enabled (B3 precondition, checked per repo).

`CODE_FIX_REVIEW_SYSTEM` (new): the §3.2 catastrophic list PLUS, because no human reviewed this diff: the change is a narrow, local fix consistent with the PR's stated bug — no new endpoints/routes/config surfaces/dependencies, no behavior change outside the stated defect, no widened error swallowing (`.catch(() => [])`-class, #82), no env-var fallback reads in factories (#79). Same strict parse.

### 4.2 B2: post-merge canary + auto-opened revert (co-designed with the Engineer — #208/#234 are the COO's domain)

Runs as a `canary` job in the reusable workflow, `needs: evaluate`, `if: !cancelled() && needs.evaluate.outputs.merged == 'true'` (#320), only when the caller passes `canary: true` plus its deploy target (`railway_project_id`, `railway_service`, `health_url`) and forwards `RAILWAY_API_TOKEN` (#38 — reusable workflows inherit nothing). Contract:

1. **Deploy receipt — attributed, never inferred** (codex pass-1 P2 #5: "a deployment created after the merge" can be an unrelated deploy — false PASS, or a revert PR opened for the wrong merge). `createdAt > mergedAt` is necessary and never sufficient: the canary REQUIRES a deployment whose commit equals the squash sha. `fetchServiceDeployments` is extended to select the deployment's commit (the Railway GraphQL `Deployment.meta` JSON carries the GitHub-triggered deploy's commit — the exact field name is the Engineer's first live read at B2, #50; until read it is not assumed); where the service is not GitHub-connected or the field is absent, the fallback is the `/build-sha.txt` pattern (#139 — the runtime writes `RAILWAY_GIT_COMMIT_SHA` at boot; the canary GETs it on the live host). No attributed deployment within 20 min → `canary: UNATTRIBUTED` → the page + a machinery issue, and **no revert** (a revert of a merge that never deployed is itself a deploy, and nothing has been shown to be broken). Attributed deployment `SUCCESS` required; `FAILED`/`CRASHED` → fail. Where a repo already runs a post-deploy smoke on main (webhook-router's `Post-Deploy Smoke`), that workflow's conclusion — for the run whose `head_sha` is the squash sha — is leg 1 instead (#283).
2. **Health window** — `health_url` 200 continuously for 10 min after the deploy is live, sampled every 30 s, **starting 3 min after terminal** (the boot burst is excluded, #208/#234); Railway `http_error_rate` for the service over the window vs the prior hour (threshold the Engineer sets per service; bolt-wms adds a `worker_health` staleness read, #298).
3. **Pass** → receipt comment on the merged PR (`canary: PASS`, window + numbers) and nothing else.
4. **Fail** → (a) `git revert <squash sha>` on branch `revert/<pr>-<sha8>` + `gh pr create` (title `revert: <original title> — canary failed`, body = the numbers + a link to the receipt); a revert that does not apply cleanly opens an issue instead of a PR — never a silent skip; (b) the page: human-actionable → Slack `#agent-escalations` (#165/#417; needs `STUDIOB_SLACK_BOT_TOKEN` forwarded) AND a machinery issue `canary-failed: <repo>#<pr>` opened via `github-issues.ts`, auto-closed when the revert merges (the open-issue set is the dedup state, #292). **The revert PR is never auto-merged** (#97/#279 — see Open questions).

Plant: a throwaway branch whose only change makes the health probe fail (a `/health` that returns 503 behind a `CANARY_PLANT=1` env read — or a deliberately wrong `health_url` input on a planted run) → the revert PR opens + the page fires; then a known-good run → `canary: PASS`. Both receipts on `#190` before B3.

### 4.3 B3: enable order + the restart-class hand-off

Order (changed from `#190`'s table because of the §1 finding): **webhook-router → bolt-wms → studiob-price-sync → asthetik-trade-theme → studiob.** Per repo, before flipping `enabled_classes`: read the deploy path from the deployed ref (#238/#466 — does main auto-deploy, where, with what smoke), confirm wire tests are in CI, set `sensitive_path_patterns`, then plant known-good (a real squasher fix merges + canary PASS) and known-bad (a planted `bugsquasher` PR touching a denylisted path → `[wait] sensitive path`; a 151-line one → `[wait] line-cap`). Theme is customer-facing (#97) — its live deploy is behind the `live-deployed`-baseline drift gate (#430); whether a main merge reaches the storefront at all is the read that decides its canary shape.

**studiob (restart-class):** a qualifying `code-fix` PR is never merged by the squasher. The gate's terminal action there is the hand-off: post `` `TRAIN-PIN <ISO> · head=<sha> · applied-by=squasher-gate` `` + apply `train:ready` (the one label write the gate makes, receipted `[gate-receipt] … verdict=qualified handoff=train`), and the train merges it at the next window slot. **Why this does not race the pin workflow** (codex pass-1 P2 #4): the gate runs on the caller's `GITHUB_TOKEN`, and a label applied with `GITHUB_TOKEN` does not fire `pull_request: labeled` workflows (GitHub's recursion guard — only `workflow_dispatch`/`repository_dispatch` fire from that token), so the pin workflow never posts a competing later pin; and should a caller ever move to the App token (which does trigger), the pin workflow's "one pin per head" rule (§3.1(b)) skips. The train accepts `applied-by=squasher-gate` ONLY when the PR also carries `bugsquasher` AND a gate receipt `verdict=qualified handoff=train` authored by the workflow identity for the same head sha — re-verified at ticket time, the roster check's one carve-out (a bot may hand off, never authorize). A later human re-label posts a human pin that legitimately wins `latest pin wins` — human authority outranks the hand-off. Until the train's rung 3 (mode A live — Kevin-gated) this means rung 1's `CLICK DUE` page and a human merge at the slot — still strictly better than today (the PR is pre-qualified and the window is enforced), and honest: **studiob's code-fix autonomy = train rung 3.**

## 5. What B+A does NOT do (unchanged from `#190`)

- No change to the docs-comment default; no `reviewed`-label semantics change; branch-protection edits stay Kevin's hands; `HERITAGE_TRAIN_ENABLED` and the train's `--fire` stay Kevin-gated.
- Acumatica `Customization/**` and pricing-write paths are permanently outside `code-fix` (every publish restarts the Heritage app pool, #11; #245/#266); `client-asthetik` and `acuops-*` never get a squasher caller.
- The gate never auto-merges a revert, never retries a failed merge in-run (#109/#161), and never widens a class without a caller's explicit `enabled_classes`.

## 6. Ladder (every rung = build + plants + receipts on `#190` before the next opens)

| # | Rung | Gate to next |
|---|---|---|
| 0 | this doc + codex design review (#179) | codex CLEAN on the design (findings folded) |
| A1 | (a) `train:hold` leg + the `revalidate` leg (every path) · (b) `train-ready-pin.yml` with the roster authority gate + one-pin-per-head + `parseTrainPin` author allowlist + the train's ticket-step roster check · (c) label path + `LABEL_PATH_REVIEW_SYSTEM` + telemetry values | unit tests incl. every negative leg (drift · hold · hold-mid-evaluation · label removed mid-evaluation · pin replaced mid-evaluation · no pin · hand-typed pin · non-roster applier · bot applier · oversize · FLAG) + the pin wire-format round-trip |
| A2 | callers (ops-pipeline self-caller first; webhook-router after its demo pin lifts and `#718` lands) enumerate `train:ready` + pin caller + immediate dispatch | the §3.3 plants (human label-click each) |
| B1 | `code-fix` class + denylist + `CODE_FIX_REVIEW_SYSTEM`, opt-in only | unit tests incl. every denylist path + the 151-line refusal |
| B2 | canary + revert PR + page (Engineer co-design) | planted failing canary opens the revert PR + pages; known-good passes |
| B3 | enable per repo in the §4.3 order; studiob via the train hand-off | per repo: known-good merges + canary PASS; known-bad refused |

Chips are Sonnet (#469); each rung is one PR, codex-reviewed, commit-per-unit (#262); the Mechanic sequences and verifies every completion independently (#151).

## 7. Open questions (for the codex pass · the Engineer · Kevin)

1. **Revert auto-merge on silence?** Kevin's words were "auto-revert PR + page". Auto-MERGING the revert (a return to the last-known-good) after N minutes unanswered would be a THIRD new behavior not in his ruling → default = human-merged revert (#97); presented as a fork, not assumed.
2. **Sweep cadence** `*/15` fleet-wide (§3.3) vs keep hourly + the pin workflow's immediate dispatch only.
3. **Railway deployment ↔ merge sha** — which `Deployment.meta` field carries the commit; else the `build-sha.txt` pattern (#139) per service (Engineer, live read). The contract is settled (§4.2 leg 1: attribution REQUIRED, unattributed = page, never revert); only the field name is open.
4. **Label-authority endpoint** under the caller's `github.token` (#50, live read at A1) — the FLOOR check only; the roster variable needs no endpoint.
5. **studiob-api watch scope** — filed as `ops-pipeline#192`; if a watch-pattern lands, studiob drops out of restart-class for non-API paths and §4.3 simplifies (re-read `repoClassFor` then, not before).
6. **Roster placement** — org-level Actions variable `MERGE_AUTHORITY_LOGINS` (one source, every caller reads it via `vars`) vs a committed file in ops-pipeline (reviewable, but each caller would need to fetch it). Default = the org variable; Kevin's hand creates it (org settings), today `kbibelhausen`.

## 8. Canon

- Ruling thread + build of record — `ops-pipeline#190` (Kevin "b+A", 2026-08-22)
- Gate v1/v2 — Rule #279 (Kevin 2026-07-30 · widened 2026-08-02); runner header in `scripts/pr-automerge-gate.ts`
- Train — `ops-pipeline#172` · `docs/heritage-restart-train.md` · brain `library/architecture/2026-08-19-heritage-restart-train-design.md` (`69c45ccf`) · brain `library/decisions/2026-08-19-heritage-restart-train-merge-authority-label-gated.md` (`9628252e`, incl. the 8/20 window-law widening: deploys queue behind a train-DONE signal, never a wall-clock alone)
- Plant law — Rules #464/#471; carried-claim law — #355

## 9. Labels · env · inputs

| Name | Kind | Purpose |
|---|---|---|
| `train:ready` | PR label | merge authority; executor = repo class (§2) |
| `train:hold` | label on `ops-pipeline#172` (global) / on a PR (per-PR) | hold, read by the train and (from A1a) the gate |
| `bugsquasher` | PR label | squasher lane marker (class path) |
| `TRAIN-PIN …` | PR comment (grammar §1) | head pin at label time; posted only by `train-ready-pin.yml` / the B3 hand-off; one per head |
| `MERGE_AUTHORITY_LOGINS` | org-level Actions variable (Kevin's hand) | the merge-authority roster — today exactly `kbibelhausen`; read by the pin workflow (refuse-at-source), the gate (leg 7) and the train (ticket step) |
| `enabled_classes` | caller input | `code-fix` opt-in (B3); default `docs-comment` |
| `sensitive_path_patterns` | caller input | per-repo denylist additions |
| `canary` + `railway_project_id` / `railway_service` / `health_url` | caller inputs (B2) | canary target |
| `ANTHROPIC_API_KEY` | secret (forwarded) | independent review |
| `RAILWAY_API_TOKEN` · `STUDIOB_SLACK_BOT_TOKEN` | secrets (forwarded, B2) | canary reads · the page |
| `HERITAGE_TRAIN_ENABLED` | repo variable (ops-pipeline) | the train's job gate — `true` since 2026-08-20; Kevin-gated |

## 10. App-permission dependency

The class path merges with the CALLER's `github.token` today (`contents: write`, `pull-requests: write`) and keeps doing so. New needs: `pull-requests: write` for the pin comment + label removal (present in every caller); possibly `issues: write` for label mutation via the issues API (verify at A1); the label-authority floor read (§3.2 leg 7, verify at A1); `vars.MERGE_AUTHORITY_LOGINS` readable in the caller context (org variable visibility = all repos — verify once). The train's merges (rung 3) stay on the fleet App token per the 2026-08-19 grant (`pull_requests:write`, `contents:write`, `checks:read`, `actions:write`, `workflows:write`, `issues:write`, `metadata:read`).

## 11. Codex design review — pass 1 (2026-08-22T04:4xZ, `VERDICT: FINDINGS`, 7) and how each folded

| # | Finding (codex) | Fold |
|---|---|---|
| P1 | restart-class `train:ready` had no applier-authority check on the train side ("no train code change") | §3.1(b): the pin workflow refuses at the source (no pin for a non-roster applier) AND the train's ticket step re-checks `applied-by` against the roster — one additive train change, stated |
| P1 | authority = repo permission `write`+ broadened the locked decision | §3.2 leg 7: explicit roster `MERGE_AUTHORITY_LOGINS` is the authority; repo permission is only the floor; roster entry = the review attestation |
| P1 | hold/label/pin checked early, no pre-merge revalidation → fail-open window | §3.2 leg 10 `revalidate` on every path, ships with A1(a); plant #2 in §3.1(a) |
| P2 | B3 hand-off pin overwritten by the pin workflow's later pin (`latest pin wins`) | §4.3: a `GITHUB_TOKEN` label does not fire `labeled` workflows (recursion guard) + one-pin-per-head in the workflow + `squasher-gate` accepted only with `bugsquasher` + receipt, re-verified at ticket time |
| P2 | canary attribution open (`created after merge` ≠ this merge) | §4.2 leg 1: attribution REQUIRED via the deployment commit (field = Engineer's live read) or `/build-sha.txt`; unattributed → page, never revert |
| P2 | manifest denylist npm-only | §4.1: one shared `isManifestPath` across ci-infra/test-only/code-fix, extended to Python/Go/Ruby/Rust/PHP/.NET/bun/deno + runtime pins |
| P3 | false claim that `squasher-health` must learn the new class values | §3.2 corrected: health parses `class=` opaquely; only the receipt legend changes |

Pass 2 runs on this revision (ceiling 4, #276). Per #201, three P1s on a SECOND consecutive pass would mean the design is wrong and gets redone, not iterated.
