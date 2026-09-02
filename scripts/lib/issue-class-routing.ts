/**
 * Issue class → worker routing — ops-pipeline#260 leg 2.
 *
 * The committed data lives in scripts/issue-class-routing.yaml — one file,
 * read by the dispatcher (webhook-router, wr#829) from the ops-pipeline
 * checkout it already makes, so routing edits ship without a code change in
 * either repo. The two routine prompts mirror its semantics.
 *
 * FAIL-CLOSED SHAPES, deliberately (same discipline as the skip allowlist):
 *   - A missing or malformed data file THROWS — a broken deployment must be a
 *     loud failed job, never "no routes ⇒ nothing dispatches quietly", which
 *     is exactly the front-door defect this leg exists to close (#464).
 *   - parse is strict: unknown top-level keys, a route naming an undeclared
 *     worker, a default naming an undeclared worker, non-string entries — all
 *     throw rather than being skipped over.
 *
 * Evaluation order (documented at the top of the yaml; tests pin both verdicts
 * of every rung, #471): vetoes → never-prefixes → class routes (first match)
 * → default with restate.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
/** scripts/lib/ → scripts/issue-class-routing.yaml */
const DATA_FILE = join(HERE, "..", "issue-class-routing.yaml");

export type IssueRoutingTable = {
  readonly version: number;
  readonly workers: ReadonlyMap<string, { routine: string }>;
  readonly routes: ReadonlyArray<{ label: string; worker: string }>;
  readonly defaultRoute: { worker: string; restate: boolean };
  readonly vetoes: ReadonlySet<string>;
  readonly neverPrefixes: ReadonlyArray<string>;
};

export type IssueRoute =
  | { decision: "never"; reason: string }
  | { decision: "dispatch"; worker: string; routine: string; restate: boolean; reason: string };

const TOP_LEVEL_KEYS = new Set(["version", "workers", "routes", "default", "vetoes", "never_prefixes"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringList(v: unknown, where: string): string[] {
  if (!Array.isArray(v)) throw new Error(`issue-class-routing: \`${where}\` must be a list`);
  return v.map((e, i) => {
    if (typeof e !== "string" || e.trim() === "") {
      throw new Error(`issue-class-routing: \`${where}[${i}]\` must be a non-empty string`);
    }
    return e.trim();
  });
}

/**
 * Strict parse of the YAML text. Pure — the fs read stays in
 * `loadIssueRoutingTable` so tests exercise every malformed shape without disk.
 */
export function parseIssueRoutingTable(text: string): IssueRoutingTable {
  const doc: unknown = parseYaml(text);
  if (!isPlainObject(doc)) throw new Error("issue-class-routing: top level must be a mapping");
  for (const k of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.has(k)) throw new Error(`issue-class-routing: unknown top-level key \`${k}\``);
  }
  if (doc.version !== 1) throw new Error("issue-class-routing: `version` must be 1");

  if (!isPlainObject(doc.workers) || Object.keys(doc.workers).length === 0) {
    throw new Error("issue-class-routing: `workers` must be a non-empty mapping");
  }
  const workers = new Map<string, { routine: string }>();
  for (const [name, spec] of Object.entries(doc.workers)) {
    if (!isPlainObject(spec) || typeof spec.routine !== "string" || spec.routine.trim() === "") {
      throw new Error(`issue-class-routing: worker \`${name}\` needs a non-empty \`routine\``);
    }
    workers.set(name, { routine: spec.routine.trim() });
  }

  if (!Array.isArray(doc.routes)) throw new Error("issue-class-routing: `routes` must be a list");
  const routes = doc.routes.map((r, i) => {
    if (!isPlainObject(r) || typeof r.label !== "string" || typeof r.worker !== "string") {
      throw new Error(`issue-class-routing: routes[${i}] needs string \`label\` and \`worker\``);
    }
    if (!workers.has(r.worker)) {
      throw new Error(`issue-class-routing: routes[${i}] names undeclared worker \`${r.worker}\``);
    }
    return { label: r.label.trim(), worker: r.worker };
  });

  if (!isPlainObject(doc.default) || typeof doc.default.worker !== "string") {
    throw new Error("issue-class-routing: `default` needs a string `worker`");
  }
  if (!workers.has(doc.default.worker)) {
    throw new Error(`issue-class-routing: default names undeclared worker \`${doc.default.worker}\``);
  }
  const defaultRoute = { worker: doc.default.worker, restate: doc.default.restate === true };

  return {
    version: 1,
    workers,
    routes,
    defaultRoute,
    vetoes: new Set(stringList(doc.vetoes ?? [], "vetoes")),
    neverPrefixes: stringList(doc.never_prefixes ?? [], "never_prefixes"),
  };
}

/** Reads and strictly parses the committed data file. Throws loudly on any problem. */
export function loadIssueRoutingTable(path: string = DATA_FILE): IssueRoutingTable {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`issue-class-routing: cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseIssueRoutingTable(text);
}

/**
 * Route one open issue by its label set. Labels are compared case-insensitively
 * after trim (GitHub preserves case; humans do not).
 */
export function routeIssue(labels: ReadonlyArray<string>, table: IssueRoutingTable): IssueRoute {
  const norm = labels.map((l) => l.trim().toLowerCase()).filter((l) => l !== "");

  for (const l of norm) {
    if (table.vetoes.has(l)) return { decision: "never", reason: `veto label \`${l}\`` };
  }
  for (const l of norm) {
    for (const p of table.neverPrefixes) {
      if (l.startsWith(p.toLowerCase())) return { decision: "never", reason: `seat-owned label \`${l}\`` };
    }
  }
  for (const r of table.routes) {
    if (norm.includes(r.label.toLowerCase())) {
      const w = table.workers.get(r.worker)!;
      return { decision: "dispatch", worker: r.worker, routine: w.routine, restate: false, reason: `class label \`${r.label}\`` };
    }
  }
  const d = table.defaultRoute;
  const w = table.workers.get(d.worker)!;
  return {
    decision: "dispatch",
    worker: d.worker,
    routine: w.routine,
    restate: d.restate,
    reason: norm.length === 0 ? "no labels — default route" : "no class label — default route",
  };
}
