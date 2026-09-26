/**
 * cadences.ts — type definitions for cadences.yaml (mechanic stint #903)
 *
 * Consumed by validation and future worker generation. The canonical source of
 * truth is power-unit/cadences.yaml; this file mirrors its schema in TypeScript.
 * Born 2026-09-24.
 */

export type Cadence =
  | "daily"
  | "twice-daily"
  | "thrice-daily"
  | "weekly"
  | "biweekly"
  | "per-increment"
  | "monthly"
  | "quarterly"
  | "on-demand";

export type Channel =
  | "slack"
  | "email"
  | "github-issue"
  | "tower"
  | "board"
  | "vault";

export type Audience =
  | "team-principal"
  | "race-engineer-sb"
  | "race-engineer-ae"
  | "engineer"
  | "mechanic"
  | "financial-sb"
  | "commercial"
  | "crew-chief-sb"
  | "scout"
  | "dispatcher";

export type ContentSource =
  | "morning-brief"
  | "digest"
  | "board"
  | "decisions"
  | "scorecard"
  | "rocks"
  | "issues-list"
  | "to-do-list"
  | "backlog-staleness"
  | "backlog-compliance"
  | "credential-expiry"
  | "cfo-monthly"
  | "volume-monitor"
  | "token-watch"
  | "repo-hygiene"
  | "stale-pr-sweep"
  | "grants-drift"
  | "shipped-ledger"
  | "session-liveness"
  | "vault-hygiene"
  | "pricing-digest"
  | "alert-digest"
  | "stuck-ticket-digest"
  | "train-liveness"
  | "squasher-health";

export type ReceiptTarget = "board" | "tracker" | "tower";

export type MigrationStatus = "live" | "pending";

export interface CadenceEntry {
  report: string;
  audience: Audience | Audience[];
  cadence: Cadence;
  channel: Channel;
  channel_target: string;
  content: ContentSource | ContentSource[];
  receipt_on: ReceiptTarget;
  preset?: string;
  enabled: boolean;
  migration?: MigrationStatus;
  note?: string;
}

export interface CadencesConfig {
  reports: CadenceEntry[];
  schema_version: number;
  valid_cadences: Cadence[];
  valid_channels: Channel[];
  valid_audiences: Audience[];
  valid_content: ContentSource[];
}

/**
 * Predicate: is this entry a template (preset row, not yet activated)?
 * A template row carries `preset:` and is enabled:false until the buyer
 * selects the operating model at setup.
 */
export function isTemplate(entry: CadenceEntry): boolean {
  return entry.preset !== undefined;
}

/**
 * Predicate: is this entry live (enabled + not a template)?
 */
export function isLive(entry: CadenceEntry): boolean {
  return entry.enabled && !isTemplate(entry);
}

/**
 * Predicate: has this entry been migrated from hardcoded cron/workflow config?
 */
export function isMigrated(entry: CadenceEntry): boolean {
  return entry.migration === "live";
}

/**
 * Return the report's cadence in human-readable form — used by the brief
 * generator to stamp "daily / weekly / monthly / quarterly" attribution.
 */
export function cadenceLabel(cadence: Cadence): string {
  const labels: Record<Cadence, string> = {
    "daily": "Daily",
    "twice-daily": "Twice daily",
    "thrice-daily": "Three times daily",
    "weekly": "Weekly",
    "biweekly": "Every two weeks",
    "per-increment": "Per increment",
    "monthly": "Monthly",
    "quarterly": "Quarterly",
    "on-demand": "On demand",
  };
  return labels[cadence];
}