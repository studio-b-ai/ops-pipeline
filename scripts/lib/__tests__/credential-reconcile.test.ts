import { describe, expect, it } from "vitest";
import { sweepUnmonitoredCredentialIssues, type CredentialSweepIssue } from "../credential-reconcile.js";
import { buildSeverityTitle } from "../severity-issue-reconcile.js";

const LABEL = "credential-monitor";
const title = (entity: string, status: string) => buildSeverityTitle(LABEL, entity, status);

describe("sweepUnmonitoredCredentialIssues", () => {
  // Negative controls first (Rule #322).

  // The most important test in this file (ops-pipeline#74's own design comment, mirroring
  // railway-volume-reconcile.ts's `probedOkProjects.size === 0` guard): an empty manifest-names
  // set must NEVER be read as "everything is an orphan" — that would close-all on a run that
  // proved nothing (e.g. a caller bug that fails to populate the set before calling in).
  it("global guard: manifestNames.size === 0 → whole sweep no-ops, even with a genuine orphan present (the close-all guard)", () => {
    const orphan: CredentialSweepIssue = { number: 1, title: title("gone-token", "WARN-7"), state: "OPEN" };
    const out = sweepUnmonitoredCredentialIssues([orphan], new Set());
    expect(out.actions).toEqual([]);
  });

  it("does NOT act on an active known-good credential still in the manifest (the non-default verdict's inverse)", () => {
    const active: CredentialSweepIssue = { number: 2, title: title("op-sa-acuops-hub", "WARN-7"), state: "OPEN" };
    const out = sweepUnmonitoredCredentialIssues([active], new Set(["op-sa-acuops-hub"]));
    expect(out.actions).toEqual([]);
  });

  it("does NOT act on an unparseable title filed under the label (human-filed, no severity suffix)", () => {
    const human: CredentialSweepIssue = { number: 3, title: "[credential-monitor] please rotate NPM_TOKEN soon", state: "OPEN" };
    const out = sweepUnmonitoredCredentialIssues([human], new Set(["NPM_TOKEN-clients"]));
    expect(out.actions).toEqual([]);
  });

  it("does NOT act on a wrong-label title (e.g. volume-monitor's own severity-title shape)", () => {
    const wrongLabel: CredentialSweepIssue = {
      number: 4,
      title: "[volume-monitor] some-project/production/svc/vol [11111111-1111-1111-1111-111111111111] — WARN",
      state: "OPEN",
    };
    // Even with an EMPTY manifest set the wrong-label title never reaches the entity check at
    // all (parseSeverityTitle requires the exact "[credential-monitor] " prefix) — proven with a
    // non-empty set too, so this isn't just riding the global guard from the test above.
    const out = sweepUnmonitoredCredentialIssues([wrongLabel], new Set(["unrelated-credential"]));
    expect(out.actions).toEqual([]);
  });

  it("does NOT act on a CLOSED issue, even one that would otherwise be a clear orphan", () => {
    const closedOrphan: CredentialSweepIssue = { number: 5, title: title("gone-token", "DEAD"), state: "CLOSED" };
    const out = sweepUnmonitoredCredentialIssues([closedOrphan], new Set(["still-here"]));
    expect(out.actions).toEqual([]);
  });

  // Positive cases.

  it("closes an open issue whose entity has left the manifest (the orphan)", () => {
    const orphan: CredentialSweepIssue = { number: 6, title: title("NPM_TOKEN-clients", "WARN-14"), state: "OPEN" };
    const out = sweepUnmonitoredCredentialIssues([orphan], new Set(["still-here"]));
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0]).toMatchObject({ number: 6, entity: "NPM_TOKEN-clients", title: orphan.title });
  });

  // Exact-match set semantics only (Rule #315's spirit) — no prefix/fuzzy rescue. A manifest name
  // that happens to EXTEND the issue's entity as a string is a DIFFERENT credential, not the same
  // one under a longer name.
  it("exact-match set semantics only — a manifest name that merely extends the issue's entity as a prefix does NOT rescue it", () => {
    const orphan: CredentialSweepIssue = { number: 7, title: title("op-sa-acuops", "WARN-7"), state: "OPEN" };
    const out = sweepUnmonitoredCredentialIssues([orphan], new Set(["op-sa-acuops-hub"]));
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].entity).toBe("op-sa-acuops");
  });

  // Mixed fixture: proves disjointness with the main per-credential loop in the same run — two
  // active WARN-7 credentials (still in the manifest) are left alone, a human-filed issue and a
  // closed issue are left alone, and exactly the one genuine orphan is actioned.
  it("mixed fixture: exactly the one orphan is actioned; active ×2 + unparseable + closed are all left alone", () => {
    const issues: CredentialSweepIssue[] = [
      { number: 10, title: title("op-sa-acuops-hub", "WARN-7"), state: "OPEN" },
      { number: 11, title: title("op-sa-client-asthetik-deploy", "WARN-7"), state: "OPEN" },
      { number: 12, title: title("NPM_TOKEN-clients", "DEAD"), state: "OPEN" },
      { number: 13, title: "[credential-monitor] a human note, no severity suffix here", state: "OPEN" },
      { number: 14, title: title("some-old-cert", "WARN-1"), state: "CLOSED" },
    ];
    const manifestNames = new Set(["op-sa-acuops-hub", "op-sa-client-asthetik-deploy"]);
    const out = sweepUnmonitoredCredentialIssues(issues, manifestNames);
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0]).toMatchObject({ number: 12, entity: "NPM_TOKEN-clients" });
  });
});
