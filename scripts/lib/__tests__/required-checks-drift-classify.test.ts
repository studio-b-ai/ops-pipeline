import { describe, expect, it } from "vitest";
import {
  extractJobCheckNames,
  diffRequiredChecks,
  classifyWorkflowYamlParse,
  classifyProtectionProbeError,
  alertWorthyCount,
  summarizeRequiredCheckDead,
  summarizeWorkflowUnparseable,
  renderRequiredCheckDeadIssueBody,
  renderWorkflowUnparseableIssueBody,
  type WorkflowFileObservation,
} from "../required-checks-drift-classify.js";
import { planIssueAction } from "../repo-hygiene-lib.js";

const NOW = "2026-09-04T09:00:00Z";

// ───────────────────────────── extractJobCheckNames ─────────────────────────────

describe("extractJobCheckNames", () => {
  it("a job declaring `name:` renders that name, and the composite `<workflow> / <job>` form", () => {
    const yamlText = ["name: CI", "jobs:", "  build:", '    name: "Build & Test"', "    runs-on: ubuntu-latest"].join("\n");
    const names = extractJobCheckNames(yamlText, "ci");
    expect(names).not.toBeNull();
    expect(names).toEqual(expect.arrayContaining(["Build & Test", "CI / Build & Test"]));
  });

  it("a job with NO `name:` reports its KEY (the issue's exact spec)", () => {
    const yamlText = ["name: CI", "jobs:", "  lint:", "    runs-on: ubuntu-latest"].join("\n");
    const names = extractJobCheckNames(yamlText, "ci");
    expect(names).toEqual(expect.arrayContaining(["lint", "CI / lint"]));
  });

  it("no top-level `name:` falls back to the caller-supplied file basename for the composite form", () => {
    const yamlText = ["jobs:", "  build:", "    runs-on: ubuntu-latest"].join("\n");
    const names = extractJobCheckNames(yamlText, "ci");
    expect(names).toEqual(expect.arrayContaining(["build", "ci / build"]));
  });

  it("multiple jobs each contribute both forms", () => {
    const yamlText = ["name: Pipeline", "jobs:", "  a:", "    name: Alpha", "  b:", "    runs-on: ubuntu-latest"].join("\n");
    const names = extractJobCheckNames(yamlText, "pipeline");
    expect(names?.sort()).toEqual(["Alpha", "Pipeline / Alpha", "Pipeline / b", "b"].sort());
  });

  it("structurally unparseable YAML → null (never a false empty result)", () => {
    const badYaml = "jobs:\n  build:\n  - this is not a mapping\n\tinvalid tab indent";
    expect(extractJobCheckNames(badYaml, "ci")).toBeNull();
  });

  it("a top-level scalar document (not an object) → null", () => {
    expect(extractJobCheckNames("just a string", "ci")).toBeNull();
  });

  it("a top-level array document → [] (arrays are structurally objects with no `.jobs` — parsed fine, nothing to contribute, not a parse error)", () => {
    expect(extractJobCheckNames("- a\n- b", "ci")).toEqual([]);
  });

  it("a well-formed document with no `jobs:` key → [] (parsed fine, nothing to contribute)", () => {
    expect(extractJobCheckNames("name: Empty\non: push\n", "empty")).toEqual([]);
  });

  it("a `jobs:` value that isn't a mapping → [] (not a crash)", () => {
    expect(extractJobCheckNames("name: Weird\njobs: not-a-mapping\n", "weird")).toEqual([]);
  });
});

// ───────────────────────────── classifyProtectionProbeError (404 vs 403 — both verdicts) ─────────────────────────────

describe("classifyProtectionProbeError", () => {
  it("404 → no-protection (definitive: no branch protection at all; never a finding, never an error)", () => {
    expect(classifyProtectionProbeError("gh: Branch not protected (HTTP 404)")).toBe("no-protection");
  });
  it("403 → probe-failed (an inconclusive read, never treated as 'no protection')", () => {
    expect(classifyProtectionProbeError("gh: Resource not accessible by integration (HTTP 403)")).toBe("probe-failed");
  });
  it("a 5xx or transport error also → probe-failed (only 404 is definitive)", () => {
    expect(classifyProtectionProbeError("gh: Internal Server Error (HTTP 502)")).toBe("probe-failed");
    expect(classifyProtectionProbeError("connect ECONNRESET")).toBe("probe-failed");
  });
});

// ───────────────────────────── diffRequiredChecks (class: required_check_dead) ─────────────────────────────

function fileObs(path: string, jobNames: string[] | null): WorkflowFileObservation {
  return { path, jobNames };
}

describe("diffRequiredChecks", () => {
  it("required context `TypeScript Build`, workflows declaring only `Build & Test` → ONE finding naming the context (the note-intelligence incident, verbatim)", () => {
    const files = [fileObs(".github/workflows/ci.yml", extractJobCheckNames('name: CI\njobs:\n  build:\n    name: "Build & Test"\n', "ci"))];
    const { findings, inconclusive } = diffRequiredChecks("note-intelligence", ["TypeScript Build"], files);
    expect(inconclusive).toBe(false);
    expect(findings).toHaveLength(1);
    expect(findings[0].class).toBe("required_check_dead");
    expect(findings[0].repo).toBe("note-intelligence");
    expect(findings[0].context).toBe("TypeScript Build");
    expect(findings[0].detail).toContain("TypeScript Build");
    expect(findings[0].detail).toContain("note-intelligence");
  });

  it("KNOWN-GOOD: the same repo where a workflow declares job `name: \"TypeScript Build\"` → no finding (#471 positive control)", () => {
    const files = [fileObs(".github/workflows/ci.yml", extractJobCheckNames('name: CI\njobs:\n  build:\n    name: "TypeScript Build"\n', "ci"))];
    const { findings, inconclusive } = diffRequiredChecks("note-intelligence", ["TypeScript Build"], files);
    expect(inconclusive).toBe(false);
    expect(findings).toHaveLength(0);
  });

  it("a job with NO `name:` whose KEY equals the required context → no finding", () => {
    const files = [fileObs(".github/workflows/ci.yml", extractJobCheckNames("name: CI\njobs:\n  Build & Test:\n    runs-on: ubuntu-latest\n", "ci"))];
    const { findings } = diffRequiredChecks("some-repo", ["Build & Test"], files);
    expect(findings).toHaveLength(0);
  });

  it("a required context matching only the composite `<workflow> / <job>` form → no finding", () => {
    const files = [fileObs(".github/workflows/ci.yml", extractJobCheckNames("name: CI\njobs:\n  build:\n    runs-on: ubuntu-latest\n", "ci"))];
    const { findings } = diffRequiredChecks("some-repo", ["CI / build"], files);
    expect(findings).toHaveLength(0);
  });

  it("empty required contexts → no findings, not inconclusive, regardless of workflow state", () => {
    expect(diffRequiredChecks("repo", [], [])).toEqual({ findings: [], inconclusive: false });
    expect(diffRequiredChecks("repo", [], [fileObs("x.yml", null)])).toEqual({ findings: [], inconclusive: false });
  });

  it("ANY unreadable/unparseable workflow file (jobNames: null) → inconclusive, zero findings (Rule #425 — never a false positive off a read failure)", () => {
    const files = [fileObs(".github/workflows/a.yml", ["Build & Test"]), fileObs(".github/workflows/b.yml", null)];
    const { findings, inconclusive } = diffRequiredChecks("repo", ["TypeScript Build"], files);
    expect(inconclusive).toBe(true);
    expect(findings).toHaveLength(0);
  });

  it("multiple dead contexts on one repo → one finding each, sorted by context", () => {
    const files = [fileObs("x.yml", ["Live Job"])];
    const { findings } = diffRequiredChecks("repo", ["Zed Dead", "Alpha Dead"], files);
    expect(findings.map((f) => f.context)).toEqual(["Alpha Dead", "Zed Dead"]);
  });
});

// ───────────────────────────── classifyWorkflowYamlParse (class: workflow_unparseable) ─────────────────────────────
// ops-pipeline#307: the ORIGINAL design (run name === file path — GitHub's own tell) fired
// on 5/5 clean workflows at first live firing (Rule #425). Fixed to derive the finding from
// THIS leg's own YAML parse of the fetched content instead — both verdicts planted below.

describe("classifyWorkflowYamlParse", () => {
  it("invalid YAML (planted: bad tab indentation) → ONE finding carrying the parser's message (#471 the non-default verdict, planted)", () => {
    const badYaml = "jobs:\n  build:\n  - this is not a mapping\n\tinvalid tab indent";
    const finding = classifyWorkflowYamlParse("note-intelligence", ".github/workflows/ci.yml", badYaml);
    expect(finding).not.toBeNull();
    expect(finding?.class).toBe("workflow_unparseable");
    expect(finding?.repo).toBe("note-intelligence");
    expect(finding?.workflowPath).toBe(".github/workflows/ci.yml");
    expect(finding?.detail).toMatch(/fails to parse as YAML/);
    // the actual parser message is carried, not a generic "it's broken" string
    expect(finding?.detail.length).toBeGreaterThan("`note-intelligence`'s workflow `.github/workflows/ci.yml` fails to parse as YAML: ".length);
  });

  it("a long parser error message (verified 214 chars raw — a duplicate-key error with a 200-char key name) is truncated to 160 chars plus an ellipsis marker", () => {
    const longKey = "a".repeat(200);
    const yamlText = `jobs:\n  build:\n    ${longKey}: 1\n    ${longKey}: 2\n`;
    const finding = classifyWorkflowYamlParse("repo", ".github/workflows/huge.yml", yamlText);
    expect(finding).not.toBeNull();
    const afterPrefix = finding!.detail.split("fails to parse as YAML: ")[1].split(" — every job")[0];
    expect(afterPrefix.endsWith("…")).toBe(true);
    expect(afterPrefix.length).toBe(161); // 160 chars of message + the ellipsis marker
  });

  it("KNOWN-GOOD: a clean `workflow_call` reusable whose latest run would be named by its path → NO finding (the exact #307 false-positive shape, #471 positive control)", () => {
    const cleanReusable = ["name: AcuOps Deploy", "on:", "  workflow_call:", "    inputs:", "      environment:", "        required: true", "        type: string", "jobs:", "  deploy:", "    runs-on: ubuntu-latest"].join("\n");
    expect(classifyWorkflowYamlParse("acuops-pipeline", ".github/workflows/acuops-deploy.yml", cleanReusable)).toBeNull();
  });

  it("a workflow with no top-level `name:` key that parses fine → no finding (structure, not syntax, is not this class's concern)", () => {
    const noName = ["on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest"].join("\n");
    expect(classifyWorkflowYamlParse("repo", ".github/workflows/nameless.yml", noName)).toBeNull();
  });

  it("a top-level scalar document (parses fine, just not object-shaped) → no finding — that's `extractJobCheckNames`'s concern for class 1, not a YAML parse failure", () => {
    expect(classifyWorkflowYamlParse("repo", ".github/workflows/weird.yml", "just a string")).toBeNull();
  });
});

// ───────────────────────────── alertWorthyCount + summaries (Rule #465) ─────────────────────────────

describe("alertWorthyCount", () => {
  it("0 findings, no systemic failure → 0", () => {
    expect(alertWorthyCount(0, false)).toBe(0);
  });
  it("0 findings, systemic failure → 1 (never silently reads as clean)", () => {
    expect(alertWorthyCount(0, true)).toBe(1);
  });
  it("N findings, no systemic failure → N", () => {
    expect(alertWorthyCount(3, false)).toBe(3);
  });
  it("N findings, systemic failure → N+1", () => {
    expect(alertWorthyCount(3, true)).toBe(4);
  });
});

describe("summaries always report the class and count, including 0", () => {
  it("required_check_dead", () => {
    expect(summarizeRequiredCheckDead([])).toBe("required-checks-drift summary — required_check_dead=0");
  });
  it("workflow_unparseable", () => {
    expect(summarizeWorkflowUnparseable([])).toBe("required-checks-drift summary — workflow_unparseable=0");
  });
});

// ───────────────────────────── reconcile path (planIssueAction, imported — already exhaustively tested in repo-hygiene-lib.test.ts; this file's own test suite grep shows NO existing test mocks `gh`/network, so the reconcile decision is exercised as the pure function it is, matching every other worker in this repo) ─────────────────────────────

describe("the reconcile path — findings present opens/updates, findings absent closes", () => {
  it("findings present, no existing issue → open", () => {
    expect(planIssueAction(alertWorthyCount(1, false), false)).toBe("open");
  });
  it("findings present, existing issue → update (not a duplicate open)", () => {
    expect(planIssueAction(alertWorthyCount(1, false), true)).toBe("update");
  });
  it("findings absent, existing issue → close", () => {
    expect(planIssueAction(alertWorthyCount(0, false), true)).toBe("close");
  });
  it("findings absent, no existing issue → none", () => {
    expect(planIssueAction(alertWorthyCount(0, false), false)).toBe("none");
  });
  it("findings absent but the read capability is systemically dead, existing issue stays open (updates, never silently closes) — the repo-hygiene bot-churn regression, applied to this leg", () => {
    expect(planIssueAction(alertWorthyCount(0, true), true)).toBe("update");
  });
  it("findings absent but systemically dead, no existing issue yet → opens (carries the degradation note)", () => {
    expect(planIssueAction(alertWorthyCount(0, true), false)).toBe("open");
  });
});

// ───────────────────────────── issue-body rendering ─────────────────────────────

describe("renderRequiredCheckDeadIssueBody", () => {
  it("zero findings renders _none_ and the summary line", () => {
    const body = renderRequiredCheckDeadIssueBody([], {
      org: "studio-b-ai",
      scannedRepoCount: 5,
      generatedAt: NOW,
      probeFailedRepos: [],
      inconclusiveRepos: [],
      systemicFailures: [],
    });
    expect(body).toContain("_none_");
    expect(body).toContain("required_check_dead=0");
    expect(body).not.toContain("structurally degraded");
  });

  it("a finding's detail appears in the body; probe-failed and inconclusive repos are named", () => {
    const files = [fileObs(".github/workflows/ci.yml", extractJobCheckNames("jobs:\n  build:\n", "ci"))];
    const { findings } = diffRequiredChecks("note-intelligence", ["TypeScript Build"], files);
    const body = renderRequiredCheckDeadIssueBody(findings, {
      org: "studio-b-ai",
      scannedRepoCount: 3,
      generatedAt: NOW,
      probeFailedRepos: ["some-403-repo"],
      inconclusiveRepos: ["some-unparseable-repo"],
      systemicFailures: [],
    });
    expect(body).toContain("TypeScript Build");
    expect(body).toContain("some-403-repo");
    expect(body).toContain("some-unparseable-repo");
    expect(body).toContain("required_check_dead=1");
  });

  it("a systemic failure renders the Rule #464 degradation note with the capability and first error", () => {
    const body = renderRequiredCheckDeadIssueBody([], {
      org: "studio-b-ai",
      scannedRepoCount: 10,
      generatedAt: NOW,
      probeFailedRepos: [],
      inconclusiveRepos: [],
      systemicFailures: [{ capability: "branch-protection reads (Administration:read)", attempted: 10, firstError: "HTTP 403" }],
    });
    expect(body).toContain("structurally degraded");
    expect(body).toContain("branch-protection reads (Administration:read)");
    expect(body).toContain("HTTP 403");
  });

  it("multiple simultaneous systemic failures BOTH render (array, not a single optional field — the day-one expected shape)", () => {
    const body = renderRequiredCheckDeadIssueBody([], {
      org: "studio-b-ai",
      scannedRepoCount: 10,
      generatedAt: NOW,
      probeFailedRepos: [],
      inconclusiveRepos: [],
      systemicFailures: [
        { capability: "branch-protection reads (Administration:read)", attempted: 10, firstError: "HTTP 403" },
        { capability: "workflow-file reads (Contents:read)", attempted: 10, firstError: "HTTP 403" },
      ],
    });
    expect(body).toContain("branch-protection reads (Administration:read)");
    expect(body).toContain("workflow-file reads (Contents:read)");
  });
});

describe("renderWorkflowUnparseableIssueBody", () => {
  it("zero findings renders _none_", () => {
    const body = renderWorkflowUnparseableIssueBody([], {
      org: "studio-b-ai",
      scannedWorkflowCount: 12,
      generatedAt: NOW,
      probeFailedWorkflows: [],
      systemicFailures: [],
    });
    expect(body).toContain("_none_");
    expect(body).toContain("workflow_unparseable=0");
  });

  it("a finding's detail appears in the body", () => {
    const badYaml = "jobs:\n  build:\n  - this is not a mapping\n\tinvalid tab indent";
    const finding = classifyWorkflowYamlParse("note-intelligence", ".github/workflows/ci.yml", badYaml);
    const body = renderWorkflowUnparseableIssueBody(finding ? [finding] : [], {
      org: "studio-b-ai",
      scannedWorkflowCount: 12,
      generatedAt: NOW,
      probeFailedWorkflows: [],
      systemicFailures: [],
    });
    expect(body).toContain("note-intelligence");
    expect(body).toContain(".github/workflows/ci.yml");
    expect(body).toContain("workflow_unparseable=1");
  });

  it("a Contents-API fetch failure (404/500) names the repo/path as probe_failed — never silence, never a finding (ops-pipeline#307's explicit third verdict)", () => {
    const body = renderWorkflowUnparseableIssueBody([], {
      org: "studio-b-ai",
      scannedWorkflowCount: 5,
      generatedAt: NOW,
      probeFailedWorkflows: ["some-repo/.github/workflows/unreadable.yml"],
      systemicFailures: [],
    });
    expect(body).toContain("some-repo/.github/workflows/unreadable.yml");
    expect(body).toContain("workflow_unparseable=0"); // a fetch failure is not evidence either way — never counted as a finding
    expect(body).toContain("Content fetch failed via the Contents API"); // the probe-failed note renders even though the findings section is empty ("_none_")
  });
});
