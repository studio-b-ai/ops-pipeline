/**
 * credential-probes.ts — active probes per credential type (CLAUDE.md Rule #302).
 *
 * Each probe reads the credential's REAL expiry / aliveness (not the recorded date). The PURE
 * PARSERS (header → ISO, Graph json → min future endDateTime, cert notAfter → ISO) are exported
 * separately and unit-tested WITHOUT network; the network/exec calls are thin seams around them.
 *
 * SECURITY (Rule #259/#282): a credential VALUE enters a probe as an argument and NEVER leaves —
 * it is never logged, never put in an error message, never returned. Only the derived expiry
 * DATE + aliveness flow out.
 */

import { execFileSync } from "node:child_process";
import { connect as tlsConnect } from "node:tls";
import type { ProbeResult } from "./credential-classify.js";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Per-call deadline so a stalled connection becomes PROBE_FAILED, never a hung job (Rule #114/#269). */
const PROBE_TIMEOUT_MS = 15_000;

// ───────────────────────────── PURE PARSERS (unit-tested, no network) ─────────────────────────────

/**
 * Parse GitHub's `github-authentication-token-expiration` response header.
 * - missing/empty  → non-expiring (classic PAT — flag "scope down" upstream)
 * - "2026-08-20 12:00:00 UTC" or ISO → ISO string
 * - present but unparseable → throws (caller turns it into a PROBE_FAILED).
 */
export function parseGithubExpiryHeader(headerValue: string | null | undefined): {
  expiry: string | null;
  nonExpiring: boolean;
} {
  if (headerValue == null || headerValue.trim() === "") {
    return { expiry: null, nonExpiring: true };
  }
  // GitHub emits e.g. "2026-08-20 12:00:00 UTC" — normalize to ISO before parsing.
  const normalized = headerValue.trim().replace(/\s*UTC$/i, "Z").replace(" ", "T");
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) {
    throw new Error(`unparseable github token-expiration header`);
  }
  return { expiry: new Date(ms).toISOString(), nonExpiring: false };
}

/** Pick the minimum FUTURE `endDateTime` from a Graph app's passwordCredentials. null if none future. */
export function minFutureEndDateTime(
  passwordCredentials: Array<{ endDateTime?: string | null }>,
  now: Date = new Date(),
): string | null {
  const nowMs = now.getTime();
  const future = passwordCredentials
    .map((c) => (c.endDateTime ? Date.parse(c.endDateTime) : Number.NaN))
    .filter((ms) => !Number.isNaN(ms) && ms > nowMs)
    .sort((a, b) => a - b);
  return future.length > 0 ? new Date(future[0]).toISOString() : null;
}

/**
 * Pure: turn an Entra app's passwordCredentials into a ProbeResult (exported for tests).
 *
 * When `keyId` is pinned (manifest `app_secret_key_id`) the probe validates THAT specific secret —
 * so during rotation another future secret can't mask the monitored one being revoked/expired:
 *   - keyId absent from the list (secret deleted) OR its endDateTime past → alive:false (DEAD)
 *   - keyId present + future                                              → alive + that expiry
 * When no `keyId` is pinned it falls back to the app-level min future (catches "every secret
 * expired" → DEAD, but cannot distinguish a single rotated-out secret — see the manifest note).
 * NO future secret at all → alive:false → DEAD (a rotate/remove incident, NOT a backfill task —
 * without this a null min-future would fall through to NO_EXPIRY and misroute).
 */
export function entraResultFromPasswordCredentials(
  passwordCredentials: Array<{ endDateTime?: string | null; keyId?: string | null }>,
  now: Date = new Date(),
  keyId?: string | null,
): ProbeResult {
  if (keyId) {
    const match = passwordCredentials.find((c) => c.keyId === keyId);
    if (!match || !match.endDateTime) return { alive: false, expiry: null, source: "probe" };
    const ms = Date.parse(match.endDateTime);
    if (Number.isNaN(ms)) return { alive: true, expiry: null, source: "probe", error: "unparseable endDateTime for the monitored Entra secret" };
    if (ms <= now.getTime()) return { alive: false, expiry: null, source: "probe" };
    return { alive: true, expiry: new Date(ms).toISOString(), source: "probe" };
  }
  const expiry = minFutureEndDateTime(passwordCredentials, now);
  if (expiry) return { alive: true, expiry, source: "probe" };
  return { alive: false, expiry: null, source: "probe" };
}

/** Parse a TLS cert `valid_to` / openssl `notAfter` value ("Aug 20 12:00:00 2026 GMT") → ISO. */
export function parseCertNotAfter(value: string): string {
  const ms = Date.parse(value.trim());
  if (Number.isNaN(ms)) {
    throw new Error(`unparseable cert notAfter`);
  }
  return new Date(ms).toISOString();
}

/**
 * Shape of a Cloudflare /client/v4/zones response (just the fields we need for the aliveness probe).
 *
 * WHY /zones INSTEAD OF /user/tokens/verify:
 * The umbrella token (`studiob-cloudflare-dns-umbrella`) is ZONE-SCOPED (Zone:DNS:Edit +
 * Zone:Zone:Read).  `/user/tokens/verify` requires `User:Read`, which this token intentionally
 * does NOT have — the endpoint returns `success:false "Invalid API Token"` even when the token
 * is perfectly valid.  This caused a daily false "Credential DEAD — cloudflare-umbrella" alert.
 * The canonical fix (studiob-cloudflare-api-tokens.md lines 91-104) is to use `/zones` as the
 * aliveness probe: `success:true` from a live /zones call proves the token works.
 */
export interface CloudflareZonesResponse {
  success?: boolean;
  result?: Array<{ id?: string; name?: string }> | null;
}

/**
 * Pure: turn a Cloudflare `/client/v4/zones` response + the manifest's recorded expiry into a
 * ProbeResult (exported for tests).
 *
 * Zone-scoped tokens cannot self-introspect via /user/tokens/verify (requires User:Read); the
 * /zones endpoint proves the token is accepted by the CF API — that IS aliveness. The expiry
 * countdown comes from `recordedExpiry` (same idiom as npm-granular / 1password-sa).
 *   - success:true  → alive; expiry = recordedExpiry
 *   - success:false → DEAD (token rejected / expired / revoked)
 *   - unexpected shape (success absent) → PROBE_FAILED (never a silent OK)
 */
export function cloudflareResultFromZones(
  json: CloudflareZonesResponse,
  recordedExpiry: string | null,
): ProbeResult {
  if (json.success === true) {
    return { alive: true, expiry: recordedExpiry, source: "recorded" };
  }
  if (json.success === false) {
    return { alive: false, expiry: recordedExpiry, source: "recorded" };
  }
  // success field absent — unexpected API shape (never a silent OK).
  return { alive: true, expiry: null, source: "probe", error: "cloudflare /zones returned unexpected shape (no success field)" };
}

// Keep the old verify-response type and parser exported so existing tests compile; the
// NETWORK seam below now calls /zones instead.
export interface CloudflareVerifyResponse {
  success?: boolean;
  result?: { status?: string } | null;
}

/**
 * @deprecated The /user/tokens/verify endpoint is incompatible with zone-scoped tokens.
 * Use cloudflareResultFromZones() instead. Retained only so existing test suites compile;
 * the network seam (probeCloudflareToken) no longer calls this function.
 */
export function cloudflareResultFromVerify(
  json: CloudflareVerifyResponse,
  recordedExpiry: string | null,
): ProbeResult {
  if (json.success === false) {
    return { alive: false, expiry: recordedExpiry, source: "recorded" };
  }
  const status = json.result?.status;
  if (status === "active") {
    return { alive: true, expiry: recordedExpiry, source: "recorded" };
  }
  if (status == null || status === "") {
    return { alive: true, expiry: null, source: "probe", error: "cloudflare verify returned no token status" };
  }
  return { alive: false, expiry: recordedExpiry, source: "recorded" };
}

// ───────────────────────────── NETWORK / EXEC SEAMS ─────────────────────────────

/**
 * GitHub fine-grained PAT: GET api.github.com/octocat with the token.
 * 200 → alive + expiry header; 401 → DEAD; 403 (rate-limit/revoked, ambiguous) / other → PROBE_FAILED.
 */
export async function probeGithubPat(token: string): Promise<ProbeResult> {
  try {
    const resp = await fetch("https://api.github.com/octocat", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "studiob-credential-monitor",
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (resp.status === 401) {
      return { alive: false, expiry: null, source: "probe" };
    }
    if (resp.status === 403) {
      return { alive: true, expiry: null, source: "probe", error: "github 403 (rate-limit or revoked — verify manually)" };
    }
    if (!resp.ok) {
      return { alive: true, expiry: null, source: "probe", error: `github probe HTTP ${resp.status}` };
    }
    const { expiry, nonExpiring } = parseGithubExpiryHeader(
      resp.headers.get("github-authentication-token-expiration"),
    );
    return { alive: true, expiry, source: "probe", nonExpiring };
  } catch (err) {
    return { alive: true, expiry: null, source: "probe", error: `github probe failed: ${errMsg(err)}` };
  }
}

/**
 * npm granular token: GET registry.npmjs.org/-/whoami with the token.
 * 200 → alive; 401/403 → DEAD. npm doesn't expose granular expiry via API, so the countdown
 * comes from the manifest's recorded_expiry (null → classify yields NO_EXPIRY = backfill flag).
 */
export async function probeNpmGranular(token: string, recordedExpiry: string | null): Promise<ProbeResult> {
  try {
    const resp = await fetch("https://registry.npmjs.org/-/whoami", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (resp.status === 401 || resp.status === 403) {
      return { alive: false, expiry: recordedExpiry, source: "recorded" };
    }
    if (!resp.ok) {
      return { alive: true, expiry: null, source: "probe", error: `npm whoami HTTP ${resp.status}` };
    }
    return { alive: true, expiry: recordedExpiry, source: "recorded" };
  } catch (err) {
    return { alive: true, expiry: null, source: "probe", error: `npm probe failed: ${errMsg(err)}` };
  }
}

/**
 * Cloudflare API token aliveness probe: GET /client/v4/zones?per_page=1.
 *
 * WHY /zones AND NOT /user/tokens/verify:
 * Zone-scoped tokens (e.g. studiob-cloudflare-dns-umbrella with Zone:DNS:Edit + Zone:Zone:Read)
 * do NOT have User:Read, so /user/tokens/verify returns success:false "Invalid API Token" even
 * for a perfectly valid token — causing a daily false DEAD alert. The /zones endpoint is the
 * canonical probe for zone-scoped tokens (studiob-cloudflare-api-tokens.md §"Verifying token
 * validity", lines 91-104): success:true proves the token is accepted. The expiry countdown
 * comes from recordedExpiry (zone-scoped tokens cannot read their own expires_on either).
 *   - success:true  → alive; expiry from recordedExpiry
 *   - success:false → DEAD (rejected/expired/revoked)
 *   - 401/403       → DEAD
 *   - other non-2xx → PROBE_FAILED
 */
export async function probeCloudflareToken(token: string, recordedExpiry: string | null): Promise<ProbeResult> {
  try {
    const resp = await fetch("https://api.cloudflare.com/client/v4/zones?per_page=1", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (resp.status === 401 || resp.status === 403) {
      return { alive: false, expiry: recordedExpiry, source: "recorded" };
    }
    if (!resp.ok) {
      return { alive: true, expiry: null, source: "probe", error: `cloudflare /zones HTTP ${resp.status}` };
    }
    return cloudflareResultFromZones((await resp.json()) as CloudflareZonesResponse, recordedExpiry);
  } catch (err) {
    return { alive: true, expiry: null, source: "probe", error: `cloudflare probe failed: ${errMsg(err)}` };
  }
}

export interface EntraProbeCreds {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Entra app client secret: get an app-only Graph token with the PROBING identity (ENTRA_* creds),
 * then GET /applications(appId='{monitoredAppId}')?$select=passwordCredentials → min future endDateTime.
 * The probing identity needs Application.Read.All. Missing creds → caller emits PROBE_FAILED.
 */
export async function probeEntraSecret(
  monitoredAppId: string,
  creds: EntraProbeCreds,
  keyId?: string | null,
): Promise<ProbeResult> {
  try {
    const tokenResp = await fetch(`https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!tokenResp.ok) {
      return { alive: true, expiry: null, source: "probe", error: `entra token HTTP ${tokenResp.status}` };
    }
    const tokenJson = (await tokenResp.json()) as { access_token?: string };
    if (!tokenJson.access_token) {
      return { alive: true, expiry: null, source: "probe", error: "entra token response missing access_token" };
    }
    const appResp = await fetch(
      `https://graph.microsoft.com/v1.0/applications(appId='${monitoredAppId}')?$select=passwordCredentials`,
      { headers: { Authorization: `Bearer ${tokenJson.access_token}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    );
    if (!appResp.ok) {
      return { alive: true, expiry: null, source: "probe", error: `graph application HTTP ${appResp.status}` };
    }
    const appJson = (await appResp.json()) as { passwordCredentials?: Array<{ endDateTime?: string; keyId?: string }> };
    return entraResultFromPasswordCredentials(appJson.passwordCredentials ?? [], new Date(), keyId);
  } catch (err) {
    return { alive: true, expiry: null, source: "probe", error: `entra probe failed: ${errMsg(err)}` };
  }
}

/**
 * 1Password Service Account token: `op vault list` with the token.
 * Exit 0 → alive; non-zero (op ran, token rejected) → DEAD; op binary missing → PROBE_FAILED.
 * Expiry comes from the manifest's recorded_expiry (SA tokens don't expose expiry via the CLI).
 */
export async function probe1PasswordSA(token: string, recordedExpiry: string | null): Promise<ProbeResult> {
  try {
    execFileSync("op", ["vault", "list", "--format", "json"], {
      env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token },
      stdio: ["ignore", "ignore", "ignore"],
      timeout: PROBE_TIMEOUT_MS,
    });
    return { alive: true, expiry: recordedExpiry, source: "recorded" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { alive: true, expiry: null, source: "probe", error: "op CLI not found on PATH" };
    }
    // op ran and exited non-zero → the SA token is rejected/expired.
    return { alive: false, expiry: recordedExpiry, source: "recorded" };
  }
}

/**
 * TLS certificate: open a TLS connection and read the peer cert's notAfter.
 * Uses node:tls (no shell, no openssl) so there is no command-injection surface.
 */
export function getCertExpiry(host: string, port = 443): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host, port, servername: host, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) {
        resolve({ alive: true, expiry: null, source: "probe", error: "no peer certificate" });
        return;
      }
      try {
        resolve({ alive: true, expiry: parseCertNotAfter(cert.valid_to), source: "probe" });
      } catch (err) {
        resolve({ alive: true, expiry: null, source: "probe", error: errMsg(err) });
      }
    });
    socket.on("error", (err) => resolve({ alive: true, expiry: null, source: "probe", error: `tls connect failed: ${err.message}` }));
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ alive: true, expiry: null, source: "probe", error: "tls connect timeout" });
    });
  });
}
