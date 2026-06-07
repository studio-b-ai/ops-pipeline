# Credential Expiry Monitor (CLAUDE.md Rule #302)

Active expiry monitoring for every expiring Studio B production credential. Replaces passive
"rotate-by" notes (a wish, not a guard — Rule #159). Origin: the npm-token-expired →
clients-releases-broken-for-3-weeks silent incident (2026-06-07).

## What it does

Daily (GitHub Actions cron, 14:00 UTC), for each item in [`credentials.manifest.yaml`](./credentials.manifest.yaml):

1. Reads the value via the read-only **"Studio B Infrastructure"** 1Password Service Account
   (`OP_SERVICE_ACCOUNT_INFRA`).
2. Runs the type's **active probe** for the *real* expiry / aliveness (Rule #302 — not the recorded date):
   | type | probe |
   |---|---|
   | `github-pat-finegrained` | `api.github.com/octocat` → `github-authentication-token-expiration` header (classic PATs emit none → flagged non-expiring) |
   | `npm-granular` | `registry.npmjs.org/-/whoami` → alive/dead (countdown from `recorded_expiry`) |
   | `entra-client-secret` | Graph `applications(appId=…)?$select=passwordCredentials` → the pinned secret's `endDateTime` (by `app_secret_key_id`), else app-level min future |
   | `1password-sa` | `op vault list` → alive/dead (countdown from `recorded_expiry`) |
   | `tls-cert` | `node:tls` peer cert `notAfter` |
3. Classifies → `OK | WARN(≤14/7/1) | DEAD | NO_EXPIRY | PROBE_FAILED`.
4. Routes (Rule #165) — `WARN/DEAD/NO_EXPIRY/PROBE_FAILED` → **#agent-escalations** (`C0ATMSL2CR2`),
   deduped per `(name, threshold)` so a daily cron doesn't re-fire (Rule #292; `DEAD` posts every run).
   A daily `✅ N checked …` beacon → **#agent-notifications** (`C0B4B3F62H2`) — its **absence** is the
   monitor's own staleness signal (Rule #279).

**Security:** credential VALUES are read into variables and passed to probes; they are NEVER logged,
never put in alert text, never written to the state file (Rule #259/#282). Only NAME-level metadata +
derived expiry DATES leave the process.

## Run locally

```bash
cd scripts
npm install
npm test                                   # vitest — classify bands + probe parsers (no network)
npx tsx credential-expiry-monitor.ts --dry-run   # classify from recorded dates only; NO secrets, NO Slack
```

`--dry-run` needs no Service Account and posts nothing — it is the pre-SA verification path + what CI runs.

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
2. **Slack bot token** (the alert channels are in the studiob-ai workspace — Rule #32):
   ```bash
   gh secret set STUDIOB_SLACK_BOT_TOKEN --repo studio-b-ai/ops-pipeline --body "$STUDIOB_SLACK_BOT_TOKEN"
   ```
3. **(Optional) Entra Graph probe identity** (`Application.Read.All`) for the EXO-secret item; absent ⇒
   that item degrades to `PROBE_FAILED` (flagged, not silent):
   ```bash
   gh secret set ENTRA_TENANT_ID    --repo studio-b-ai/ops-pipeline --body "$ENTRA_TENANT_ID"
   gh secret set ENTRA_CLIENT_ID    --repo studio-b-ai/ops-pipeline --body "$ENTRA_CLIENT_ID"
   gh secret set ENTRA_CLIENT_SECRET --repo studio-b-ai/ops-pipeline --body "$ENTRA_CLIENT_SECRET"
   ```
4. **Confirm the full Infra-vault inventory** + verify each `op_ref` against the real 1P item names
   (the manifest was seeded WITHOUT vault access — `op_ref`s marked `# VERIFY` are best-guess).

Then live-verify (Rule #234): `gh workflow run "Credential Expiry Monitor" --repo studio-b-ai/ops-pipeline`
→ confirm it reads the Infra vault, classifies a known near-expiry item, and posts to #agent-escalations.

## Adding a credential

Append an item to `credentials.manifest.yaml` (op:// ref + metadata only — never a value). Pick the
`type` whose probe matches, set `owner` + `keyless_alternative` (Rule #302 ladder), and `recorded_expiry`
where the probe can't read it live (npm, 1P SA).
