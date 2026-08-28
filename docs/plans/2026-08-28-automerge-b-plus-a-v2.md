# Automerge b+A v2 — label-gated train merges + squasher code-fix class

**2026-08-28 · Mechanic seat · rung 0 of ops#190 (v2 — supersedes the dead v1, PR #191, closed per Rule #201 after codex returned ≥3 P1 on two consecutive passes).**

Kevin's build-of-record word (2026-08-22, verbatim): **"b+A"** — A = fleet-wide `train:ready` label-gated merge for human PRs; B = a squasher `code-fix` diff class with guardrails + a post-merge canary. Canon: `brain/library/decisions/2026-08-19-heritage-restart-train-merge-authority-label-gated.md` + CLAUDE.md Rule #279 (exceptions 1–2). Nothing in this doc touches branch protection (Kevin's hands, permanently).

---

## 1. Why v1 died — the two axioms that could not stand

Both pass-1 and pass-2 codex reviews of PR #191 converged on the same structural root: **v1 derived authority and attribution from writable, forgeable, or losable channels.**

| # | v1 defect (codex P1, both passes) | Mechanism |
|---|---|---|
| D1 | **Authority from comment text.** `parseTrainPin` read `applied-by=` out of a TRAIN-PIN comment body posted by the shared `github-actions[bot]` identity (restart-train-lib.ts:844-849). Any workflow able to comment could forge the pin — comment bodies are attacker-writable data, not provenance. | Comment text = data. GitHub does not attribute comment *content*; it only attributes the poster, and the poster was a shared bot login. |
| D2 | **Receipts as job outputs.** Gate receipts existed only as stdout lines (automerge-telemetry.ts) and step outputs — a later fallible step could lose them, and nothing downstream could re-derive the decision from server state. | Job outputs are process-local. A canary or auditor cannot verify a merge decision it cannot reconstruct. |
| D3 | **Canary attribution by inference.** v1's canary guessed which deploy corresponded to which merge from timing + branch name. | Timing correlation is #463's exact failure class (post-hoc ≠ causal). |

**v2's single design law: every load-bearing fact is re-derived, at decision time, from GitHub/Railway server-attributed state. Comments and logs are write-only receipts — never inputs.**

## 2. The five structural moves (contract, from ops#190)

1. **Authority = the GitHub `labeled` timeline event** by a login in `MERGE_AUTHORITY_LOGINS`. The TRAIN-PIN comment is demoted to a human-readable receipt.
2. **No bot hand-off.** Restart-class (train-class) repos' code-fix PRs get `train:candidate` only; a HUMAN applies `train:ready`. The candidate label carries zero authority.
3. **Canary triggered by the `pull_request` `closed` (merged=true) workflow event** — squash sha from the event payload (`pull_request.merge_commit_sha`), never inferred.
4. **`code-fix` requires named checks `success`** — a per-repo allowlist of check names, each with conclusion `SUCCESS`. SKIPPED ≠ green (#320 kin).
5. **Per-path `revalidate`** — the full predicate re-runs on freshly fetched server state immediately before merge; the merge itself is sha-pinned (`--match-head-commit`).

## 3. A-side — `train:ready` label-gated merge (human PRs, fleet-wide)

### 3.1 Authority predicate (the core of v2)

A PR is **merge-authorized** iff ALL of, evaluated in one pass against fresh server state:

1. **Label present:** `train:ready` in the PR's current labels; `train:hold` absent (hold wins, always).
2. **Authorized application:** GraphQL `timelineItems(itemTypes:[LABELED_EVENT, UNLABELED_EVENT, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT], last:250)` — walked in server chronological order. The LAST `LabeledEvent` for `train:ready` must have `actor.login ∈ MERGE_AUTHORITY_LOGINS`, with no subsequent `UnlabeledEvent` for that label. Any actor whose login ends `[bot]` is categorically refused regardless of roster contents.
3. **Sha-pin by timeline order (no timestamps):** NO `PULL_REQUEST_COMMIT` or `HEAD_REF_FORCE_PUSHED_EVENT` item may appear AFTER that authorizing `LabeledEvent` in the timeline sequence. A push after labeling ⇒ the label is **stale**: the gate removes `train:ready`, comments why (receipt), and stops. Timeline order is server-maintained — no forgeable timestamps, no client clocks.
4. **CI:** full rollup green (`isRollupClean`, carried from #203's `evaluateMergeReadiness`) AND — where the repo config names `required_check_names` — each named check present with conclusion `SUCCESS` on the head sha.
5. **Independent review:** the existing sha-pinned Sonnet review (`independentReview` over `fetchDiffBySha(headRefOid)`) returns exactly CLEAN.
6. **Window law:** restart-train repos merge only inside the window rules already encoded in `restart-train-lib.ts` (`windowState`, `orderQueue`) — unchanged.
7. **Revalidate-then-merge (move 5):** after 1–6 pass, re-fetch the PR once more (labels, headRefOid, state, mergeStateStatus); any delta ⇒ abort this cycle. Merge via existing `mergePr(repo, pr, headRefOid)` — sha-pinned server-side, so a race past the revalidate still cannot merge moved code.

Fail-closed at every step: any fetch error, empty timeline, GraphQL truncation (≥250 items), or unknown state ⇒ NO merge, receipt comment, retry next cycle.

### 3.2 The trust boundary, stated honestly

`MERGE_AUTHORITY_LOGINS` is a **human login allowlist** (initial: `["kbibelhausen"]`), defined once in ops-pipeline config; per-repo callers may narrow it, never widen. GitHub attributes label events to the authenticated login — a workflow's `GITHUB_TOKEN` labels as `github-actions[bot]` (refused), an App token as `<app>[bot]` (refused). This kills D1: no workflow, comment, or output can mint authority.

**Known residual, accepted:** the squasher operates with a PAT under the `kbibelhausen` login (`BUGSQUASHER_AUTHOR`). Within one login, GitHub cannot distinguish which hand applied a label. This does not weaken v2 relative to today: that PAT can already merge any PR directly — the label gate defends against every OTHER actor, and the squasher's own code is prohibited (B-side, §4.1) from ever applying `train:ready`, enforced by its own tests + a plant. Migrating the squasher to a dedicated machine identity is a listed follow-up, not a rung of this build.

### 3.3 Receipts (write-only)

On every decision the gate posts/updates one comment: verdict, head sha evaluated, authorizing label event id + actor, check rollup, review verdict, and — on merge — the merge sha. Receipts are for humans and audits; **no code path reads them back** (D2 killed).

## 4. B-side — squasher `code-fix` class + post-merge canary

### 4.1 Classifier + guardrails (B1)

New `PrDiffClass = "code-fix"` in `automerge-classify.ts`, **opt-in only** via caller `enabled_classes` (default OFF everywhere at ship):

- Author `BUGSQUASHER_AUTHOR` + `bugsquasher` label; ≤150 changed lines.
- **Denylist (built-in, non-overridable):** migrations, `*.sql`, auth/middleware paths, pricing-write paths, `Customization/**`, `.github/actions/**` — plus per-repo `sensitive_path_patterns`. `Customization/**` and pricing-write are **permanently** outside code-fix (Rule #279's exception set does not extend there).
- Named checks `success` per move (4).
- **Repo-class partition (move 2):** `repoClassFor(repo) == train` (studiob, client-asthetik — deploys ride the Heritage restart train) ⇒ the squasher NEVER merges; it applies `train:candidate` + a candidate comment, and a human decides `train:ready` (A-side takes over). Non-train repos with the class enabled ⇒ squasher merges via the same gate predicate (§3.1 steps 4–7, label steps replaced by the class guardrails).

### 4.2 Post-merge canary (B2 — Engineer's accepted numbers)

- **Trigger:** `pull_request` workflow event, `types: [closed]`, `merged == true`, PR carries the `automerge:code-fix` label (applied by the gate at merge time — a server-state marker, not a log). Squash sha = `event.pull_request.merge_commit_sha` (move 3; D3 killed).
- **Attribution:** poll Railway for the repo's mapped service until a deployment with `meta.commitHash == merge_commit_sha` reaches `SUCCESS`. Timeout 15 min ⇒ escalate "deploy never attributed" (no revert — nothing deployed).
- **Health window:** 10 minutes / 20 samples from deployment SUCCESS; **5xx-only gate** scoped to the deployed service (#295: trigger-signal scope == remediation scope — no fleet metrics, no sibling services).
- **On fail:** auto-open a revert PR (`git revert` of the squash sha) + escalation page. The revert PR is **never auto-merged** (#97) — a human lands it (it is itself label-gateable).
- Boot-burst discipline (#208/#234): the window starts at deployment SUCCESS, and the first 60s of samples are recorded but non-gating.

## 5. Plants — #464/#471 per rung (first firing is part of the ship)

The gate's default verdict is REFUSE (fail-closed) ⇒ **the load-bearing plant is the known-GOOD that actually merges** (#471: plant the non-default verdict). Every rung ships BOTH directions before it counts as landed:

| Rung | Known-GOOD plant (must merge) | Known-BAD plants (must refuse, each with receipt) |
|---|---|---|
| A1 gate lib | Throwaway docs PR, Kevin labels `train:ready` → merges | label applied then push (stale-label removal fires); label by `github-actions[bot]`; `train:hold` present; red check |
| A2 each caller | Same per repo (ops-pipeline self-caller first) | one refusal plant per repo |
| B1 class | 3-line code-fix in an enabled non-train repo → merges | 151-line diff; denylist path touch; named check SKIPPED; train-class repo (must get `train:candidate`, never merge) |
| B2 canary | Merge a plant that deploys clean → canary PASS receipt | plant with a forced 5xx burst on a throwaway service → revert PR OPENS (and is NOT auto-merged) |
| B3 enable | First real code-fix merge per repo observed | per-repo refusal receipt re-verified |

Cross-check probe available to plants (not the runtime predicate): earliest `check_suite.created_at` for the head sha is a server-side push-time proxy — plants use it to independently verify the timeline-order staleness verdicts.

## 6. Rollout order + closure

- **Rung 0** — this doc + codex design review CLEAN/minor (#179). Re-opens ops#190 rung 0.
- **A1** — authority predicate + stale-label leg in `pr-automerge-gate.ts`/lib. Plants per §5.
- **A2** — callers: ops-pipeline (self) → price-sync + asthetik-trade-theme → webhook-router (after its pin lifts + #718) → bolt-wms.
- **B1** — `code-fix` class, everywhere-OFF. **B2** — canary + revert. **B3** — per-repo enablement: webhook-router → bolt-wms → studiob (candidate-flow only, train-class) → price-sync → theme LAST (storefront).
- **Closes** when all six rungs carry both-direction plant receipts and Rule #279's text is amended (Dispatcher's batch) to name the v2 mechanism.

## 7. Out of scope, permanently or here

Branch-protection edits (Kevin only) · `Customization/**` + pricing-write auto-merge (never) · the squasher's `reviewed` label semantics (unchanged) · auto-merging revert PRs (never, #97) · squasher machine-identity migration (follow-up issue, not a rung).
