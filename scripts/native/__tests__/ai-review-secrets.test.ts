/**
 * go-native P1 — the deterministic secret scan (category S), run through the REAL `scanDiffForSecrets`.
 *
 * Every fake credential here is ASSEMBLED AT RUN TIME from fragments, so no source line in this repo contains a contiguous secret shape (the
 * repo's own gitleaks guard scans these files, and a planted fixture must not trip it). Each detection has a known-bad (the shape, found) and
 * a known-good (the near-miss that must NOT be found) through the same instrument (#322 / #471).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sanitizeReasons } from "../../lib/ai-review-rubric.js";
import { describeFinding, scanDiffForSecrets, type SecretKind } from "../../lib/ai-review-secrets.js";
import { CLEAN_DIFF } from "./helpers.js";

const j = (...parts: string[]): string => parts.join("");
const ALPHABET = "aZ3kQ9mT2vB7nL4xW8cR1dF6hJ5pY0sEuG";
/** a deterministic, realistic-looking (many distinct characters, digits included) body of exactly n characters */
const body = (n: number, seed = 0): string => Array.from({ length: n }, (_, i) => ALPHABET[(i * 7 + seed) % ALPHABET.length]).join("");

const diffFor = (path: string, added: string[]): string =>
  [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${added.length} @@`, ...added.map((l) => "+" + l)].join("\n") + "\n";

const kindsOf = (diff: string): SecretKind[] => scanDiffForSecrets(diff).map((f) => f.kind);

// ── private keys ──
const pemBegin = (kind = "RSA "): string => j("-----BEGIN ", kind, "PRIV", "ATE KEY-----");
const pemEnd = (kind = "RSA "): string => j("-----END ", kind, "PRIV", "ATE KEY-----");
const pemLine = (seed: number): string => body(64, seed);

describe("private keys: a header with key material behind it", () => {
  it("a PEM block on consecutive added lines is found, with the file it is in", () => {
    const f = scanDiffForSecrets(diffFor("deploy/id.pem", [pemBegin(), pemLine(1), pemLine(2), pemEnd()]));
    expect(f).toEqual([{ kind: "private-key", path: "deploy/id.pem" }]);
  });
  it("every common header flavor is found: RSA, EC, OPENSSH, ENCRYPTED, PGP block, and the bare PKCS#8 form", () => {
    for (const kind of ["RSA ", "EC ", "OPENSSH ", "ENCRYPTED ", "DSA ", ""]) {
      expect(kindsOf(diffFor("k", [pemBegin(kind), pemLine(3), pemEnd(kind)])), kind).toEqual(["private-key"]);
    }
    expect(kindsOf(diffFor("k", [j("-----BEGIN PGP PRIV", "ATE KEY BLOCK-----"), "", pemLine(4), j("-----END PGP PRIV", "ATE KEY BLOCK-----")]))).toEqual(["private-key"]);
  });
  it("a key re-wrapped narrower than PEM's 64 columns is still found", () => {
    expect(kindsOf(diffFor("k", [pemBegin(), body(30, 1), body(30, 2), body(30, 3), pemEnd()]))).toEqual(["private-key"]);
  });
  it("RFC 1421 headers and a blank line between the header and the body do not hide it", () => {
    expect(kindsOf(diffFor("k", [pemBegin(), "Proc-Type: 4,ENCRYPTED", "DEK-Info: AES-128-CBC,0123456789ABCDEF", "", pemLine(5), pemEnd()]))).toEqual(["private-key"]);
  });
  it("a service-account JSON string with escaped newlines on ONE line is found", () => {
    const line = j('  "private_key": "', pemBegin("") , "\\n", pemLine(6), "\\n", pemEnd(""), '\\n",');
    expect(kindsOf(diffFor("sa.json", [line]))).toEqual(["private-key"]);
  });
  it("a key spread over quoted, concatenated string lines is found", () => {
    const lines = [j('const k = "', pemBegin(), '\\n" +'), j('  "', pemLine(7), '\\n" +'), j('  "', pemEnd(), '\\n";')];
    expect(kindsOf(diffFor("k.ts", lines))).toEqual(["private-key"]);
  });

  it("KNOWN-GOOD: a header with no key material behind it is documentation, not a secret", () => {
    for (const lines of [
      [`Paste the key, including the ${pemBegin()} line, into the form.`],
      [pemBegin(), pemEnd()],
      [pemBegin(), "...", pemEnd()],
      [pemBegin(), "<your key goes here>", pemEnd()],
      [pemBegin(), "(redacted)", pemEnd()],
      [pemBegin()],
    ]) {
      expect(scanDiffForSecrets(diffFor("README.md", lines)), JSON.stringify(lines)).toEqual([]);
    }
  });
  it("KNOWN-GOOD: public keys and certificates are not private keys", () => {
    expect(scanDiffForSecrets(diffFor("c.pem", ["-----BEGIN CERTIFICATE-----", pemLine(8), "-----END CERTIFICATE-----"]))).toEqual([]);
    expect(scanDiffForSecrets(diffFor("p.pem", ["-----BEGIN PUBLIC KEY-----", pemLine(9), "-----END PUBLIC KEY-----"]))).toEqual([]);
  });
});

// ── token shapes ──
const SHAPES: Array<{ kind: SecretKind; name: string; token: string }> = [
  { kind: "github-token", name: "ghp_", token: j("gh", "p_", body(36)) },
  { kind: "github-token", name: "gho_", token: j("gh", "o_", body(36, 1)) },
  { kind: "github-token", name: "ghu_", token: j("gh", "u_", body(36, 2)) },
  { kind: "github-token", name: "ghs_", token: j("gh", "s_", body(36, 3)) },
  { kind: "github-token", name: "ghr_", token: j("gh", "r_", body(36, 4)) },
  { kind: "github-token", name: "github_pat_", token: j("github", "_pat_", body(22, 5), "_", body(40, 6)) },
  { kind: "aws-access-key", name: "AKIA", token: j("AK", "IA", "QWERTY8ASDF2LMN7") },
  { kind: "aws-access-key", name: "ASIA", token: j("AS", "IA", "QWERTY8ASDF2LMN7") },
  { kind: "api-key", name: "sk- (openai style)", token: j("sk", "-", body(48)) },
  { kind: "api-key", name: "sk-proj-", token: j("sk", "-proj-", body(60, 1)) },
  { kind: "api-key", name: "sk-ant-", token: j("sk", "-ant-api03-", body(80, 2)) },
  { kind: "slack-token", name: "xoxb-", token: j("xo", "xb-", "1234567890-", body(24)) },
  { kind: "slack-token", name: "xoxp-", token: j("xo", "xp-", "1234567890-", body(24, 3)) },
];

describe("token shapes: found in an added line, labelled by kind and file", () => {
  for (const s of SHAPES) {
    it(`${s.name}`, () => {
      const f = scanDiffForSecrets(diffFor("config/app.env", [`API_VALUE=${s.token}`]));
      expect(f).toEqual([{ kind: s.kind, path: "config/app.env" }]);
    });
    it(`${s.name} — the same shape in quotes, in a URL, and as a bare word is found`, () => {
      for (const line of [`x = "${s.token}"`, `https://u:${s.token}@example.com/r`, s.token, `// ${s.token} // trailing`]) {
        expect(kindsOf(diffFor("a.ts", [line])), line.length > 20 ? line.slice(0, 12) : line).toContain(s.kind);
      }
    });
    it(`${s.name} — KNOWN-GOOD control: the same token on a REMOVED or CONTEXT line is not a finding (a PR that deletes a leaked key passes)`, () => {
      const diff = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,2 @@", ` context ${s.token}`, `-old ${s.token}`, "+safe line", ""].join("\n");
      expect(scanDiffForSecrets(diff)).toEqual([]);
    });
    it(`${s.name} — the redaction in reasons covers everything the scan detects (a finding's text can never reach a reason unredacted)`, () => {
      expect(sanitizeReasons(`found ${s.token} in a.ts`)).not.toContain(s.token.slice(8));
    });
  }
  it("the private-key shape is also redacted from reasons", () => {
    const text = j(pemBegin(), "\n", pemLine(1), "\n", pemEnd());
    expect(sanitizeReasons(text)).not.toContain(pemLine(1));
  });
});

describe("token shapes: the near-misses that must NOT be found (a false S cannot be waived, so the floors matter)", () => {
  const clean = (line: string, why: string): void => expect(scanDiffForSecrets(diffFor("a.css", [line])), why).toEqual([]);

  it("`sk-` inside other words and CSS-class shapes", () => {
    clean(".sk-fading-circle { }", "a spinner class");
    clean("risk-assessment-for-module-number-twelve-and-more", "inside `risk-`");
    clean("task-scheduler-with-a-long-hyphenated-identifier-12345678", "inside `task-`");
    clean("disk-usage-monitor-with-a-long-hyphenated-identifier-1234", "inside `disk-`");
    clean(j("sk", "-learn-thing"), "a short `sk-` word");
  });
  it("`sk-` needs 32+ characters and a digit: 31 characters and a long all-letter run are not keys, 32 with a digit are", () => {
    clean(j("sk", "-", body(31)), "31 chars");
    clean(j("sk", "-", "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"), "no digit");
    expect(kindsOf(diffFor("a", [j("sk", "-", body(32))]))).toEqual(["api-key"]);
  });
  it("GitHub token: below the 30-character floor is not a token (29), 30 is", () => {
    clean(j("gh", "p_", body(29)), "29");
    expect(kindsOf(diffFor("a", [j("gh", "p_", body(30))]))).toEqual(["github-token"]);
    clean("ghp_", "the bare prefix");
    clean("a ghp_ prefix in prose", "prose");
  });
  it("placeholders: a body of three or fewer distinct characters is not a credential", () => {
    clean(j("gh", "p_", "x".repeat(36)), "x");
    clean(j("gh", "p_", "0".repeat(36)), "0");
    clean(j("gh", "p_", "ab".repeat(18)), "ab");
    clean(j("AK", "IA", "0".repeat(16)), "AKIA zeros");
    clean(j("xo", "xb-", "0000000000-", "0".repeat(20)), "xoxb zeros");
    // …and four distinct characters is already a real-looking body
    expect(kindsOf(diffFor("a", [j("gh", "p_", "abcd".repeat(9))]))).toEqual(["github-token"]);
  });
  it("the AWS documentation key id (ends in EXAMPLE) is not a credential; a real-looking one is", () => {
    clean(j("AK", "IA", "IOSFODNN7EXAMPLE"), "AWS docs example");
    expect(kindsOf(diffFor("a", [j("AK", "IA", "IOSFODNN7QWERTYZ")]))).toEqual(["aws-access-key"]);
  });
  it("AKIA inside a longer word, and an id one character too long or short", () => {
    clean(j("XAK", "IAQWERTY8ASDF2LMN7"), "inside a word");
    clean(j("AK", "IA", "QWERTY8ASDF2LMN7X"), "17 characters");
    clean(j("AK", "IA", "QWERTY8ASDF2LM"), "14 characters");
  });
  it("a Slack-looking word that is too short", () => {
    clean(j("xo", "xb-", "short"), "xoxb-short");
  });
});

describe("the diff cannot hide a secret from the scan", () => {
  const TOKEN = j("gh", "p_", body(36));

  it("an added line whose content starts with `++ ` renders as a `+++ ` header-shaped line — it is scanned, not skipped", () => {
    // the removed line "-- x" renders `--- x`, the added line "++ <token>" renders `+++ <token>`: together they look like a file header pair
    const diff = ["diff --git a/a.sql b/a.sql", "--- a/a.sql", "+++ b/a.sql", "@@ -1,1 +1,1 @@", "--- x", `+++ ${TOKEN}`, ""].join("\n");
    expect(kindsOf(diff)).toEqual(["github-token"]);
  });
  it("a secret on a very long (minified) line is found", () => {
    expect(kindsOf(diffFor("bundle.min.js", [`${"a=1;".repeat(200000)}k="${TOKEN}";${"b=2;".repeat(1000)}`]))).toEqual(["github-token"]);
  });
  it("CRLF line endings do not hide a PEM body or a token", () => {
    const crlf = diffFor("k", [pemBegin(), pemLine(1), pemEnd(), `t=${TOKEN}`]).split("\n").join("\r\n");
    expect(kindsOf(crlf).sort()).toEqual(["github-token", "private-key"]);
  });
  it("a secret in a SECOND file is attributed to that file; one finding per (kind, file), capped at 10", () => {
    const diff = diffFor("a/one.txt", ["fine"]) + diffFor("b/two.txt", [`x=${TOKEN}`, `y=${j("gh", "p_", body(36, 3))}`]);
    expect(scanDiffForSecrets(diff)).toEqual([{ kind: "github-token", path: "b/two.txt" }]);
    const many = Array.from({ length: 40 }, (_, i) => diffFor(`f${i}.txt`, [`x=${j("gh", "p_", body(36, i))}`])).join("");
    expect(scanDiffForSecrets(many)).toHaveLength(10);
  });
  it("a file name cannot inject text into a finding: the path is reduced to a safe charset and length", () => {
    const f = scanDiffForSecrets(diffFor("x/[evil](http://e.example)`\u0000 *bold*" + "y".repeat(300), [TOKEN]));
    expect(f).toHaveLength(1);
    expect(f[0].path).toMatch(/^[A-Za-z0-9._/@+?-]{1,120}$/);
    expect(describeFinding(f[0])).not.toMatch(/[\[\]()`*]/);
  });
  it("no finding carries any part of the matched text", () => {
    const diff = diffFor("a.txt", [`x=${TOKEN}`, pemBegin(), pemLine(1), pemEnd()]);
    const dump = JSON.stringify(scanDiffForSecrets(diff)) + scanDiffForSecrets(diff).map(describeFinding).join("\n");
    expect(dump).not.toContain(TOKEN.slice(6));
    expect(dump).not.toContain(pemLine(1).slice(0, 20));
  });
});

describe("known-good controls through the same instrument", () => {
  it("an empty diff, and an ordinary diff, have no findings", () => {
    expect(scanDiffForSecrets("")).toEqual([]);
    expect(scanDiffForSecrets(CLEAN_DIFF)).toEqual([]);
  });
  it("never throws, whatever it is given", () => {
    for (const t of ["\n\n\n", "+", "+++", "+++ ", "+\u0000\u0001", "x".repeat(10), "+" + "\r".repeat(100)]) expect(() => scanDiffForSecrets(t)).not.toThrow();
  });
  it("a pathological run of `sk-` (the one pattern with a look-ahead) stays linear: 3 MB scans in well under a second", () => {
    const started = Date.now();
    scanDiffForSecrets(diffFor("p.txt", ["sk-".repeat(1_000_000)]));
    expect(Date.now() - started).toBeLessThan(3000);
  });
  it("pathological lines built to defeat every pattern (header, GitHub, AWS, Slack, `sk-` look-alikes, base64 runs) stay linear: ~12 MB scan in under 5 seconds", () => {
    const lines = [
      "-----BEGIN ".repeat(300_000),
      "ghp_".repeat(500_000),
      "github_pat_".repeat(200_000),
      "AKIA".repeat(500_000),
      "xoxb-".repeat(400_000),
      "sk-1".repeat(500_000),
      "A".repeat(2_000_000),
    ];
    const started = Date.now();
    const found = scanDiffForSecrets(diffFor("p.txt", lines));
    expect(Date.now() - started).toBeLessThan(5000);
    // some of these repeats ARE token-shaped (a 30+ character run after `github_pat_`, `xoxb-` or `sk-1` is what those patterns mean), so only the time and the bound are asserted
    expect(found.length).toBeLessThanOrEqual(10);
  });
  it("the reviewer's own source (regex literals, a redaction table, comments about keys) has no findings — it can ship through its own scan", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const scripts = join(here, "..", "..");
    const files = [join(scripts, "ai-review.ts"), ...readdirSync(join(scripts, "lib")).filter((f) => /^ai-review-.*\.ts$/.test(f)).map((f) => join(scripts, "lib", f))];
    expect(files.length).toBeGreaterThan(6);
    for (const file of files) expect(scanDiffForSecrets(diffFor(file, readFileSync(file, "utf-8").split("\n"))), file).toEqual([]);
  });
});
