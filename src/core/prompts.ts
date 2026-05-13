import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { PromptsConfig } from "../types.js";

// The default prompts file lives at the agent-loop repo root.
// We resolve it relative to THIS source file's location so the file is
// discoverable regardless of the user's working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROMPTS_FILE = path.resolve(
  __dirname,
  "..",
  "..",
  "config.prompts.default.yaml"
);

/** Load the canonical default prompts file. Throws if missing or unparseable. */
export function loadDefaultPrompts(): Record<string, unknown> {
  if (!fs.existsSync(DEFAULT_PROMPTS_FILE)) {
    throw new Error(
      `Default prompts file missing at ${DEFAULT_PROMPTS_FILE}. ` +
      `This file ships with agent-loop and must be present.`
    );
  }
  const raw = fs.readFileSync(DEFAULT_PROMPTS_FILE, "utf-8");
  const parsed = yaml.load(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Default prompts file ${DEFAULT_PROMPTS_FILE} is not a YAML mapping`);
  }
  return parsed as Record<string, unknown>;
}

/** Load a user-supplied prompts file. Throws if the path is unreadable. */
export function loadPromptsFile(filePath: string, baseDir?: string): Record<string, unknown> {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(baseDir ?? process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Prompts override file not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, "utf-8");
  const parsed = yaml.load(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Prompts override file ${resolved} is not a YAML mapping`);
  }
  return parsed as Record<string, unknown>;
}

/** Deep-merge override onto base. Arrays replace, primitives override, objects recurse. */
export function mergePrompts(
  base: Record<string, unknown>,
  override: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!override) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    const baseV = base[k];
    if (
      typeof baseV === "object" && baseV !== null && !Array.isArray(baseV) &&
      typeof v === "object" && v !== null && !Array.isArray(v)
    ) {
      out[k] = mergePrompts(
        baseV as Record<string, unknown>,
        v as Record<string, unknown>
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** The full set of required keys for runtime validation. Mirrors PromptsConfig. */
const REQUIRED_KEYS: string[] = [
  "identities.base",
  "identities.router",
  "nudges.empty_response_first",
  "nudges.empty_response_repeated",
  "nudges.text_only_continuation",
  "nudges.malformed_json",
  "nudges.loop_detected",
  "markers.truncation",
  "markers.prior_result_summary",
  "markers.prior_call_summary",
  "markers.compaction_fallback",
  "compaction.summarizer_system",
  "thresholds.empty_response_max_attempts",
  "thresholds.text_only_max_attempts",
  "thresholds.text_only_completion_min_chars",
  "thresholds.malformed_json_threshold",
  "thresholds.loop_window_size",
  "thresholds.loop_match_length",
  "thresholds.loop_pause_warnings",
  "thresholds.compaction_soft_ratio",
  "thresholds.compaction_hard_ratio",
  "thresholds.compaction_soft_recent_n",
  "thresholds.compaction_hard_recent_n",
];

/** Validate that every required key is present after merging. */
export function validatePrompts(merged: Record<string, unknown>): asserts merged is PromptsConfig & Record<string, unknown> {
  const missing: string[] = [];
  for (const key of REQUIRED_KEYS) {
    if (!hasPath(merged, key)) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `Prompts config is missing required keys after merge:\n` +
      missing.map((k) => `  - ${k}`).join("\n") +
      `\nEnsure ${DEFAULT_PROMPTS_FILE} is complete and any user override does not delete required keys.`
    );
  }
}

/** Whole-config resolver: default file + optional override = validated PromptsConfig. */
export function resolvePrompts(
  override: Record<string, unknown> | string | undefined,
  baseDir?: string
): PromptsConfig {
  const base = loadDefaultPrompts();
  let overrideObj: Record<string, unknown> | undefined;
  if (typeof override === "string") {
    overrideObj = loadPromptsFile(override, baseDir);
  } else if (override && typeof override === "object") {
    overrideObj = override;
  }
  const merged = mergePrompts(base, overrideObj);
  validatePrompts(merged);
  return merged as unknown as PromptsConfig;
}

// --- Helpers used by call sites ---------------------------------------------

/** Read a dotted-path value from PromptsConfig. Throws if missing. */
export function getPrompt(prompts: PromptsConfig, dottedPath: string): string {
  const v = getPath(prompts as unknown as Record<string, unknown>, dottedPath);
  if (typeof v !== "string") {
    throw new Error(`Prompt at "${dottedPath}" missing or not a string`);
  }
  return v;
}

/** Read a numeric threshold by key. Throws if missing or not a number. */
export function getThreshold(
  prompts: PromptsConfig,
  key: keyof PromptsConfig["thresholds"]
): number {
  const v = prompts.thresholds[key];
  if (typeof v !== "number") {
    throw new Error(`Threshold "${key}" missing or not a number`);
  }
  return v;
}

/** Substitute `{name}` placeholders in a template string with values from `vars`. */
export function format(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, k) =>
    k in vars ? String(vars[k]) : match
  );
}

// --- Internal helpers --------------------------------------------------------

function hasPath(obj: Record<string, unknown>, dotted: string): boolean {
  const parts = dotted.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (typeof cur !== "object" || cur === null) return false;
    if (!(p in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur !== undefined && cur !== null;
}

function getPath(obj: Record<string, unknown>, dotted: string): unknown {
  const parts = dotted.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
