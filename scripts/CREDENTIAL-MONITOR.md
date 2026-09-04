# Credential Expiry Monitor (CLAUDE.md Rule #302)

Active expiry monitoring for every expiring Studio B production credential. Replaces passive
"rotate-by" notes (a wish, not a guard — Rule #159). Origin: the npm-token-expired →
clients-releases-broken-for-3-weeks silent incident (2026-06-07).

## What it does

Daily (GitHub Actions cron, 14:00 UTC), for each item in [`credentials.manifest.yaml`](./credentials.manifest.yaml):

1. Reads the value via the read-only **"Studio B Infrastructure"** 1Password Service Account
   (`OP_SERVICE_ACCOUNT_INFRA`) — or, for the monitor's OWN token, straight from its process env
   (`op_ref: env:OP_SERVICE_ACCOUNT_INFRA`, the self-probe scheme; the SA cannot `op read` itself).
2. Runs the type's **active probe** for the *real* expiry / aliveness (Rule #302 — not the recorded date):
   | type | probe |
   |---|---|
   | `github-pat-finegrained` | `api.github.com/octocat` → `github-authentication-token-expiration` header (classic PATs emit none → flagged non-expiring) |
   | `npm-granular` | `registry.npmjs.org/-/whoami` → alive/dead (countdown from `recorded_expiry`) |
   | `entra-client-secret` | Graph `applications(appId=…)?$select=passwordCredentials` → the pinned secret's `endDateTime` (by `app_secret_key_id`), else app-level min future |
   | `entra-user-password` | Graph `GET /users/{user_id}?$select=accountEnabled,lastPasswordChangeDateTime,passwordPolicies` → aliveness (accountEnabled); pw-change date surfaced in the run log; never reads the password value |
   | `1password-sa` | `op vault list` → alive/dead (countdown from `recorded_expiry`) |
   | `cloudflare-api-token` | `api.cloudflare.com/client/v4/user/tokens/verify` → `status` alive/dead (countdown from `recorded_expiry`; verify returns no expiry) |
   | `tls-cert` | `node:tls` peer cert `notAfter` |
   | `shipengine-api-key` | `api.shipengine.com/v1/carriers` (header `API-Key`) → 200 alive / 401 DEAD; non-expiring by design (rung 2) — aliveness-shaped, never returns an expiry |
3. Classifies → `OK | WARN(≤14/7/1) | DEAD | NO_EXPIRY | PROBE_FAILED`.
4. **v2 (2026-07-31, Kevin directive): alerts are GitHub issues, not Slack** — one issue per
   credential (label `credential-monitor`, title `[credential-monitor] <name> — <status>`), open =
   needs attention, auto-closed with a comment once the credential classifies back to OK. A
   status change while an issue is open (e.g. a WARN band tightening from 14d to 7d) comments +
   retitles in place instead of opening a second issue — see `lib/severity-issue-reconcile.ts`.
   An open issue for an active condition IS the dedup (Rules #292/#358 by construction); there is
   no separate beacon post — the issue list itself (`gh issue list --repo studio-b-ai/ops-pipeline
   --label credential-monitor`) is the current state.

**Security:** credential VALUES are read into variables and passed to probes; they are NEVER logged,
never put in issue text (Rule #259/#282). Only NAME-level metadata + derived expiry DATES leave the
process.

## Run locally

```bash
cd scripts
npm install
npm test                                   # vitest — classify bands + probe parsers (no network)
npx tsx credential-expiry-monitor.ts --dry-run   # classify from recorded dates only; NO secrets, NO probe network calls
```

`--dry-run` needs no Service Account and performs zero issue mutations — it IS the pre-SA
verification path + what CI runs. It DOES run a real (read-only) `gh issue list` against this
repo, since that needs only the workflow's own ambient `GITHUB_TOKEN`, not a Kevin-gated secret —
so the printed issue-action preview reflects real open-issue state.

## ⚠️ Gates before this goes live (Kevin)

ops-pipeline currently holds **zero** repo secrets, so all of these must be set:

1. **Provision a NEW read-only "Studio B Infrastructure" 1Password Service Account.** The existing
   `acuops-hub` SA is scoped *out* of that vault by design (see
   `~/Documents/brain/library/infrastructure/studiob-1password-service-accounts.md`). Negative-test it
   reads ONLY the Infra vault, then:
   ```bash
   gh secret set OP_SERVICE_ACCOUNT_INFRA --repo studio-b-ai/ops-pipeline --body "$INFRA_SA_TOKEN"
   ```
   (Rule #98 — direct `--body`, never stdin.)
2. **(Optional) Entra Graph probe identity** (`Application.Read.All`) for the EXO-secret item; absent ⇒
   that item degrades to `PROBE_FAILED` (flagged, not silent). `entra-user-password` additionally
   needs `User.Read.All` (application) admin-consented on the same identity; absent ⇒ that row
   degrades to `PROBE_FAILED` naming the missing grant:
   ```bash
   gh secret set ENTRA_TENANT_ID    --repo studio-b-ai/ops-pipeline --body "$ENTRA_TENANT_ID"
   gh secret set ENTRA_CLIENT_ID    --repo studio-b-ai/ops-pipeline --body "$ENTRA_CLIENT_ID"
   gh secret set ENTRA_CLIENT_SECRET --repo studio-b-ai/ops-pipeline --body "$ENTRA_CLIENT_SECRET"
   ```
3. **Confirm the full Infra-vault inventory** + verify each `op_ref` against the real 1P item names
   (the manifest was seeded WITHOUT vault access — `op_ref`s marked `# VERIFY` are best-guess).

Then live-verify (Rule #234): `gh workflow run "Credential Expiry Monitor" --repo studio-b-ai/ops-pipeline`
→ confirm it reads the Infra vault, classifies a known near-expiry item, and opens/updates a
`credential-monitor`-labeled issue for it.

## Adding a credential

Append an item to `credentials.manifest.yaml` (op:// ref + metadata only — never a value). Pick the
`type` whose probe matches, set `owner` + `keyless_alternative` (Rule #302 ladder), and `recorded_expiry`
where the probe can't read it live (npm, 1P SA).

## Inventory follow-ups (2026-06-10 fleet audit)

Manifest reconciled against a fleet-wide publish/secret audit. Live items: `op-sa-acuops-hub`,
`op-sa-client-asthetik-deploy`, `LMMI_REPO_PAT`, `entra-exo-app-secret`, `cloudflare-umbrella`.
Three items are tracked OUTSIDE the live manifest, by design:

- **Delete the dormant `PYPI_API_TOKEN`** on `studio-b-ai/acumatica-lint` — referenced only in a
  workflow comment (OIDC trusted publishing is the live publish path), so it's an unmonitored static
  secret with no consumer. Delete it rather than monitor it.
- **EXO app cert (app `7e2dd464…`) expires 2028-05-20** — EXO app-only auth uses a CERTIFICATE
  (Azure `keyCredentials`), not the client secret this monitor probes. It already has a 2028-03-20
  rotation reminder in `studiob-exo-app-only-writes.md`. Add a `keyCredentials` probe before then if
  active monitoring is wanted (low urgency — ~2 years out).
- **GitHub Packages consume-side PATs (Rule #36)** — if any CI repo stores an *expiring* PAT to READ
  `@studio-b-ai/*` GitHub-Packages, add it as a `github-pat-finegrained` item. Most consumers use the
  ephemeral `GITHUB_TOKEN` (non-expiring), so assess before adding.

**Dropped from scope (now keyless):** npm publish (`@studio-b-ai/clients` → OIDC), PyPI publish
(`acumatica-lint` → OIDC), all GitHub-Packages *publish* (ephemeral `GITHUB_TOKEN`). See
`~/Documents/brain/library/vendor/npm/2026-06-07-oidc-trusted-publishing-gotchas.md` § "Fleet audit 2026-06-10".

## Credential lifecycle — target rungs (decision 2026-08-17)

Kevin, 2026-08-17: "I never want to do this again… all of these tokens are rotated and we don't
need to mint fresh and delete." Every manifest item now carries `target_rung` + `rung_by`
(`brain/library/decisions/2026-08-17-credential-lifecycle-no-kevin-touch.md`):

| rung | meaning | manifest shape |
|---|---|---|
| 0 | keyless (GitHub App installation tokens, OIDC) — the entry is REMOVED once migrated | `target_rung: 0` |
| 1 | self-rotating — a job mints the successor, updates every store, verifies, revokes the old | `target_rung: 1` |
| 2 | non-expiring + monitored + revoke-on-signal | `target_rung: 2` + `non_expiring: true` (+ `recorded_expiry: null`) |
| 3 | one Kevin sitting per year at most | `target_rung: 3` |

A WARN/DEAD issue is the signal to run the migration named on the entry — never to hand Kevin a
fresh mint. `non_expiring: true` turns alive-with-no-expiry into OK (the daily aliveness probe IS
the monitoring); combining it with a `recorded_expiry` fails loud (PROBE_FAILED) so the manifest
can never say both.

