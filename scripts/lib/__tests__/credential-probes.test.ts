import { describe, it, expect } from "vitest";
import {
  parseGithubExpiryHeader,
  minFutureEndDateTime,
  parseCertNotAfter,
  entraResultFromPasswordCredentials,
  entraUserResultFromGraph,
  cloudflareResultFromVerify,
  cloudflareResultFromZones,
  type CloudflareVerifyResponse,
  type CloudflareZonesResponse,
  type EntraUserGraphResponse,
} from "../credential-probes.js";

describe("parseGithubExpiryHeader", () => {
  it("treats missing/empty header as non-expiring (classic PAT)", () => {
    expect(parseGithubExpiryHeader(null)).toEqual({ expiry: null, nonExpiring: true });
    expect(parseGithubExpiryHeader(undefined)).toEqual({ expiry: null, nonExpiring: true });
    expect(parseGithubExpiryHeader("")).toEqual({ expiry: null, nonExpiring: true });
    expect(parseGithubExpiryHeader("   ")).toEqual({ expiry: null, nonExpiring: true });
  });

  it("parses GitHub's '… UTC' format to ISO", () => {
    expect(parseGithubExpiryHeader("2026-08-20 12:00:00 UTC")).toEqual({
      expiry: "2026-08-20T12:00:00.000Z",
      nonExpiring: false,
    });
  });

  it("parses an already-ISO value", () => {
    expect(parseGithubExpiryHeader("2026-08-20T12:00:00Z")).toEqual({
      expiry: "2026-08-20T12:00:00.000Z",
      nonExpiring: false,
    });
  });

  it("throws on an unparseable header (→ caller emits PROBE_FAILED)", () => {
    expect(() => parseGithubExpiryHeader("whenever")).toThrow();
  });
});

describe("minFutureEndDateTime", () => {
  const NOW = new Date("2026-06-07T12:00:00Z");

  it("returns null for no credentials", () => {
    expect(minFutureEndDateTime([], NOW)).toBeNull();
  });

  it("returns null when every endDateTime is in the past", () => {
    expect(minFutureEndDateTime([{ endDateTime: "2026-05-01T00:00:00Z" }, { endDateTime: "2025-01-01T00:00:00Z" }], NOW)).toBeNull();
  });

  it("picks the minimum FUTURE endDateTime", () => {
    expect(
      minFutureEndDateTime(
        [
          { endDateTime: "2026-05-01T00:00:00Z" }, // past — ignored
          { endDateTime: "2026-09-01T00:00:00Z" },
          { endDateTime: "2026-07-01T00:00:00Z" }, // soonest future
        ],
        NOW,
      ),
    ).toBe("2026-07-01T00:00:00.000Z");
  });

  it("ignores null/blank/unparseable endDateTimes", () => {
    expect(
      minFutureEndDateTime([{ endDateTime: null }, { endDateTime: "" }, { endDateTime: "nope" }, { endDateTime: "2026-08-01T00:00:00Z" }], NOW),
    ).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("parseCertNotAfter", () => {
  it("parses the openssl/TLS notAfter format to ISO", () => {
    expect(parseCertNotAfter("Aug 20 12:00:00 2026 GMT")).toBe("2026-08-20T12:00:00.000Z");
  });
  it("throws on garbage", () => {
    expect(() => parseCertNotAfter("not a date")).toThrow();
  });
});

describe("entraResultFromPasswordCredentials", () => {
  const NOW = new Date("2026-06-07T12:00:00Z");

  it("a future secret → alive with that expiry", () => {
    expect(entraResultFromPasswordCredentials([{ endDateTime: "2026-09-01T00:00:00Z" }], NOW)).toEqual({
      alive: true,
      expiry: "2026-09-01T00:00:00.000Z",
      source: "probe",
    });
  });

  it("all secrets expired → DEAD (alive false), not NO_EXPIRY", () => {
    expect(entraResultFromPasswordCredentials([{ endDateTime: "2026-01-01T00:00:00Z" }], NOW)).toEqual({
      alive: false,
      expiry: null,
      source: "probe",
    });
  });

  it("no secrets at all → DEAD (rotate or remove from manifest)", () => {
    expect(entraResultFromPasswordCredentials([], NOW)).toEqual({ alive: false, expiry: null, source: "probe" });
  });

  describe("pinned by keyId (validates the SPECIFIC monitored secret)", () => {
    const creds = [
      { keyId: "AAA", endDateTime: "2026-01-01T00:00:00Z" }, // monitored — already expired
      { keyId: "BBB", endDateTime: "2026-12-01T00:00:00Z" }, // a different, still-future secret
    ];

    it("expired monitored secret → DEAD even though another future secret exists", () => {
      expect(entraResultFromPasswordCredentials(creds, NOW, "AAA")).toEqual({ alive: false, expiry: null, source: "probe" });
    });

    it("future monitored secret → alive with ITS expiry (not the app min)", () => {
      expect(entraResultFromPasswordCredentials(creds, NOW, "BBB")).toEqual({
        alive: true,
        expiry: "2026-12-01T00:00:00.000Z",
        source: "probe",
      });
    });

    it("pinned keyId absent from the app (secret deleted) → DEAD", () => {
      expect(entraResultFromPasswordCredentials(creds, NOW, "GONE")).toEqual({ alive: false, expiry: null, source: "probe" });
    });
  });
});

describe("entraUserResultFromGraph", () => {
  // FABRICATED — not a real Entra object id.
  it("enabled + lastPasswordChangeDateTime → alive, note = pw-changed=<date>", () => {
    const json: EntraUserGraphResponse = { accountEnabled: true, lastPasswordChangeDateTime: "2026-08-24T13:02:11Z" };
    expect(entraUserResultFromGraph(json)).toEqual({ alive: true, expiry: null, source: "probe", note: "pw-changed=2026-08-24" });
  });

  it("enabled + no lastPasswordChangeDateTime → note = pw-changed=unknown", () => {
    const json: EntraUserGraphResponse = { accountEnabled: true, lastPasswordChangeDateTime: null };
    expect(entraUserResultFromGraph(json)).toEqual({ alive: true, expiry: null, source: "probe", note: "pw-changed=unknown" });
  });

  it("enabled + passwordPolicies DisablePasswordExpiration → no policy suffix", () => {
    const json: EntraUserGraphResponse = {
      accountEnabled: true,
      lastPasswordChangeDateTime: "2026-08-24T13:02:11Z",
      passwordPolicies: "DisablePasswordExpiration",
    };
    expect(entraUserResultFromGraph(json)).toEqual({ alive: true, expiry: null, source: "probe", note: "pw-changed=2026-08-24" });
  });

  it("enabled + non-empty passwordPolicies lacking the marker → policy!=DisablePasswordExpiration suffix", () => {
    const json: EntraUserGraphResponse = {
      accountEnabled: true,
      lastPasswordChangeDateTime: "2026-08-24T13:02:11Z",
      passwordPolicies: "DisableStrongPassword",
    };
    expect(entraUserResultFromGraph(json)).toEqual({
      alive: true,
      expiry: null,
      source: "probe",
      note: "pw-changed=2026-08-24 policy!=DisablePasswordExpiration",
    });
  });

  it("enabled + passwordPolicies null → no policy suffix (tenant default may already be never-expire)", () => {
    const json: EntraUserGraphResponse = {
      accountEnabled: true,
      lastPasswordChangeDateTime: "2026-08-24T13:02:11Z",
      passwordPolicies: null,
    };
    expect(entraUserResultFromGraph(json)).toEqual({ alive: true, expiry: null, source: "probe", note: "pw-changed=2026-08-24" });
  });

  it("accountEnabled false → DEAD (alive:false, no note)", () => {
    const json: EntraUserGraphResponse = { accountEnabled: false };
    expect(entraUserResultFromGraph(json)).toEqual({ alive: false, expiry: null, source: "probe" });
  });

  it("accountEnabled absent → PROBE_FAILED shape naming the missing field", () => {
    const json: EntraUserGraphResponse = {};
    const r = entraUserResultFromGraph(json);
    expect(r.alive).toBe(true);
    expect(r.error).toContain("missing accountEnabled");
  });
});

// ── cloudflareResultFromZones (the CURRENT probe parser — replaces /user/tokens/verify) ──────────
//
// WHY: zone-scoped tokens (Zone:DNS:Edit + Zone:Zone:Read) cannot pass /user/tokens/verify because
// that endpoint requires User:Read.  The /zones endpoint proves the token is accepted by CF.
// See studiob-cloudflare-api-tokens.md §"Verifying token validity".

describe("cloudflareResultFromZones", () => {
  const REC = "2027-05-24"; // manifest recorded_expiry

  it("success:true → alive; countdown from recorded date (token cannot read its own expires_on)", () => {
    const zones: CloudflareZonesResponse = { success: true, result: [{ id: "abc", name: "acuops.com" }] };
    expect(cloudflareResultFromZones(zones, REC)).toEqual({ alive: true, expiry: REC, source: "recorded" });
  });

  it("success:true with empty result array → alive (token accepted even if no zones visible)", () => {
    const zones: CloudflareZonesResponse = { success: true, result: [] };
    expect(cloudflareResultFromZones(zones, REC)).toEqual({ alive: true, expiry: REC, source: "recorded" });
  });

  it("success:true with no recorded date → alive, no expiry (NO_EXPIRY upstream = backfill flag)", () => {
    const zones: CloudflareZonesResponse = { success: true, result: [] };
    expect(cloudflareResultFromZones(zones, null)).toEqual({ alive: true, expiry: null, source: "recorded" });
  });

  it("success:false → DEAD (token rejected / expired / revoked)", () => {
    const zones: CloudflareZonesResponse = { success: false, result: null };
    expect(cloudflareResultFromZones(zones, REC)).toEqual({ alive: false, expiry: REC, source: "recorded" });
  });

  it("success field absent → PROBE_FAILED (unexpected shape, never a silent OK)", () => {
    const zones: CloudflareZonesResponse = {}; // no success field
    const r = cloudflareResultFromZones(zones, REC);
    expect(r.alive).toBe(true);
    expect(r.error).toBeTruthy();
  });
});

// ── cloudflareResultFromVerify (DEPRECATED — retained for test-compile; network seam uses /zones) ─

describe("cloudflareResultFromVerify (deprecated — kept for existing test coverage)", () => {
  const REC = "2027-05-24"; // manifest recorded_expiry (CF verify has no live expiry to read)
  // `st` is the Cloudflare token-verify STATUS (CF's own API field — unrelated to any Postgres
  // enum); passed as a variable so the value never sits adjacent to a `status:` key.
  const resp = (st?: string): CloudflareVerifyResponse => {
    const result: { status?: string } = {};
    if (st !== undefined) result.status = st;
    return { success: true, result };
  };

  it("active token → alive; countdown from recorded date (verify returns no expires_on)", () => {
    expect(cloudflareResultFromVerify(resp("active"), REC)).toEqual({ alive: true, expiry: REC, source: "recorded" });
  });

  it("active token with no recorded date → alive, no expiry (NO_EXPIRY upstream = backfill flag)", () => {
    expect(cloudflareResultFromVerify(resp("active"), null)).toEqual({ alive: true, expiry: null, source: "recorded" });
  });

  it("explicit non-active status (disabled/expired) → DEAD", () => {
    expect(cloudflareResultFromVerify(resp("disabled"), REC)).toEqual({ alive: false, expiry: REC, source: "recorded" });
  });

  it("success:false → DEAD (token rejected)", () => {
    expect(cloudflareResultFromVerify({ success: false }, REC)).toEqual({ alive: false, expiry: REC, source: "recorded" });
  });

  it("200 but missing/empty status (unexpected shape) → PROBE_FAILED, never a silent OK", () => {
    const noStatus = cloudflareResultFromVerify(resp(), REC); // success:true, result:{}
    expect(noStatus.alive).toBe(true);
    expect(noStatus.error).toBeTruthy();
    const noResult = cloudflareResultFromVerify({ success: true, result: null }, REC);
    expect(noResult.error).toBeTruthy();
  });
});
