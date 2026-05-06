/**
 * Shared config loader for sync + drift-check scripts.
 *
 * Reads ops.yaml + infra/hubspot.yaml from repo root.
 * When this file is extracted to studio-b-ai/ops-pipeline as a reusable
 * workflow, the consumer repo's path is passed via env var REPO_ROOT.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = process.env.REPO_ROOT || join(import.meta.dirname || ".", "..", "..");

export interface OpsConfig {
  version: number;
  repo: { owner: string; name: string; function: string; brand: string; description: string };
  slack: {
    workspace: string;
    team_id: string;
    channel_id: string;
    channel_name: string;
    canvas_id: string;
    canvas_title: string;
    canvas_source: Array<{ path: string; mode: string }>;
  };
  hubspot: {
    portal_id: number;
    brand: string;
    state_file: string;
    auto_fix: boolean;
    drift_report_channel: string;
  };
  drift_check: {
    cadence: string;
    day: string;
    hour_utc: number;
    channels: string[];
  };
  notifications: {
    on_sync_success: boolean;
    on_sync_failure: boolean;
    on_drift_detected: boolean;
    channel: string;
  };
}

export interface HubspotState {
  portal_id: number;
  pipelines: {
    deals: Array<{
      id: string;
      label: string;
      stages: Array<{
        id: string;
        label: string;
        display_order: number;
        probability: number;
        is_closed: boolean;
      }>;
    }>;
  };
  properties: {
    contacts: Array<PropertySpec>;
    deals: Array<PropertySpec>;
  };
  workflows: Array<{
    id: number;
    name: string;
    object_type: string;
    enabled: boolean;
    description: string;
    actions: string[];
  }>;
  forms: Array<{
    id: string;
    name: string;
    portal_id: number;
    embedded_on: string[];
    triggers: Array<{ workflow: number }>;
  }>;
}

export interface PropertySpec {
  name: string;
  label: string;
  type: string;
  field_type: string;
  group_name?: string;
  description?: string;
  options?: string[];
  managed?: boolean;
  note?: string;
}

export function loadOpsConfig(): OpsConfig {
  const path = join(REPO_ROOT, "ops.yaml");
  if (!existsSync(path)) throw new Error(`ops.yaml not found at ${path}`);
  return parseYaml(readFileSync(path, "utf-8")) as OpsConfig;
}

export function loadHubspotState(stateFile: string): HubspotState {
  const path = join(REPO_ROOT, stateFile);
  if (!existsSync(path)) throw new Error(`HubSpot state file not found at ${path}`);
  return parseYaml(readFileSync(path, "utf-8")) as HubspotState;
}

export function readSourceFile(relPath: string): string {
  const path = join(REPO_ROOT, relPath);
  if (!existsSync(path)) throw new Error(`Source file not found at ${path}`);
  return readFileSync(path, "utf-8");
}

export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}
