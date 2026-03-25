#!/usr/bin/env bun
/**
 * Compare two agent-loop sessions side by side.
 *
 * Usage:
 *   bun run scripts/compare-sessions.ts <session-a> <session-b> [--config path]
 *   bun run scripts/compare-sessions.ts 1 2 --config config.spark.yaml
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface TranscriptEntry {
  type: string;
  timestamp: string;
  iteration?: number;
  data: unknown;
}

interface SessionState {
  id: string;
  status: string;
  reason?: string;
  skillName: string;
  startedAt: string;
  updatedAt: string;
  iteration: number;
  tokenUsage: { input: number; output: number; total: number };
  config: { model: { model: string; maxTokens: number }; session: { maxContext: number } };
}

const C = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
  magenta: "\x1b[35m",
};

function loadState(sessionsDir: string, id: string): SessionState {
  const raw = fs.readFileSync(path.join(sessionsDir, id, "state.json"), "utf-8");
  return JSON.parse(raw);
}

function loadTranscript(sessionsDir: string, id: string): TranscriptEntry[] {
  const raw = fs.readFileSync(path.join(sessionsDir, id, "transcript.jsonl"), "utf-8");
  if (!raw.trim()) return [];
  return raw.trim().split("\n").map((l) => JSON.parse(l));
}

function listSessions(sessionsDir: string): SessionState[] {
  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  const sessions: SessionState[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      sessions.push(loadState(sessionsDir, e.name));
    } catch { /* skip */ }
  }
  return sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function resolveId(idOrIndex: string, sessions: SessionState[]): string {
  if (idOrIndex.includes("-") && idOrIndex.length > 8) return idOrIndex;
  const idx = parseInt(idOrIndex, 10);
  if (isNaN(idx) || idx < 1 || idx > sessions.length) {
    throw new Error(`Invalid session: ${idOrIndex}`);
  }
  return sessions[idx - 1].id;
}

interface SessionAnalysis {
  state: SessionState;
  transcript: TranscriptEntry[];
  durationSec: number;
  toolCalls: { name: string; iteration: number; timestamp: string; durationMs?: number }[];
  toolErrors: { name: string; iteration: number; error: string }[];
  buildCalls: { iteration: number; status?: string; objectCount?: number; questionCount?: number }[];
  parallelCalls: number; // iterations with >1 tool call
  totalToolCalls: number;
  uniqueToolsUsed: string[];
  finalStatus?: string;
  finalObjectCount?: number;
}

function analyzeSession(sessionsDir: string, id: string): SessionAnalysis {
  const state = loadState(sessionsDir, id);
  const transcript = loadTranscript(sessionsDir, id);

  const startTime = new Date(state.startedAt).getTime();
  const endTime = new Date(state.updatedAt).getTime();
  const durationSec = (endTime - startTime) / 1000;

  const toolCalls: SessionAnalysis["toolCalls"] = [];
  const toolErrors: SessionAnalysis["toolErrors"] = [];
  const buildCalls: SessionAnalysis["buildCalls"] = [];
  const toolsByIteration = new Map<number, number>();

  let lastCallTimestamps = new Map<string, number>(); // tool_use_id → timestamp

  for (const entry of transcript) {
    if (entry.type === "message") {
      const data = entry.data as { role?: string; content?: unknown };
      if (data.role === "assistant" && Array.isArray(data.content)) {
        for (const block of data.content) {
          const b = block as Record<string, unknown>;
          if (b.type === "tool_use") {
            const iter = entry.iteration ?? 0;
            toolCalls.push({
              name: String(b.name),
              iteration: iter,
              timestamp: entry.timestamp,
            });
            toolsByIteration.set(iter, (toolsByIteration.get(iter) ?? 0) + 1);
            lastCallTimestamps.set(String(b.id), new Date(entry.timestamp).getTime());
          }
        }
      }
    }

    if (entry.type === "tool_result") {
      const data = entry.data as { content?: unknown };
      if (Array.isArray(data.content)) {
        for (const block of data.content) {
          const b = block as Record<string, unknown>;
          if (b.type === "tool_result") {
            const content = String(b.content ?? "");
            const toolId = String(b.tool_use_id ?? "");

            // Calculate duration
            const callTime = lastCallTimestamps.get(toolId);
            if (callTime) {
              const resultTime = new Date(entry.timestamp).getTime();
              const tc = toolCalls.find(
                (t) => !t.durationMs && lastCallTimestamps.get(toolId) === callTime
              );
              if (tc) tc.durationMs = resultTime - callTime;
            }

            if (content.startsWith("ERROR")) {
              // Find the tool name for this error
              const tc = toolCalls.find(
                (t) => t.iteration === entry.iteration && !toolErrors.some(
                  (e) => e.iteration === t.iteration && e.name === t.name
                )
              );
              toolErrors.push({
                name: tc?.name ?? "unknown",
                iteration: entry.iteration ?? 0,
                error: content.slice(0, 200),
              });
            }

            // Parse build results
            if (content.includes('"status"')) {
              try {
                const result = JSON.parse(content);
                buildCalls.push({
                  iteration: entry.iteration ?? 0,
                  status: result.status,
                  objectCount: result.summary?.object_count,
                  questionCount: result.questions?.length,
                });
              } catch { /* not json */ }
            }
          }
        }
      }
    }
  }

  const parallelCalls = Array.from(toolsByIteration.values()).filter((n) => n > 1).length;
  const uniqueToolsUsed = [...new Set(toolCalls.map((t) => t.name))];

  const lastBuild = buildCalls[buildCalls.length - 1];

  return {
    state,
    transcript,
    durationSec,
    toolCalls,
    toolErrors,
    buildCalls,
    parallelCalls,
    totalToolCalls: toolCalls.length,
    uniqueToolsUsed,
    finalStatus: lastBuild?.status,
    finalObjectCount: lastBuild?.objectCount,
  };
}

function printComparison(a: SessionAnalysis, b: SessionAnalysis): void {
  const labelA = `${C.cyan}Session A${C.reset}`;
  const labelB = `${C.magenta}Session B${C.reset}`;

  console.log(`\n${C.bold}=== Session Comparison ===${C.reset}\n`);

  // Header
  console.log(`  ${"".padEnd(30)} ${labelA.padEnd(50)} ${labelB}`);
  console.log(`  ${"".padEnd(30)} ${C.dim}${a.state.id}${C.reset}   ${C.dim}${b.state.id}${C.reset}`);
  console.log();

  // Metrics table
  const rows: [string, string, string, boolean?][] = [
    ["Model", a.state.config.model.model, b.state.config.model.model],
    ["Status", `${a.state.status}${a.state.reason ? ` (${a.state.reason})` : ""}`, `${b.state.status}${b.state.reason ? ` (${b.state.reason})` : ""}`],
    ["Iterations", String(a.state.iteration), String(b.state.iteration), true],
    ["Duration", `${a.durationSec.toFixed(0)}s`, `${b.durationSec.toFixed(0)}s`, true],
    ["Tool calls", String(a.totalToolCalls), String(b.totalToolCalls), true],
    ["Parallel iterations", String(a.parallelCalls), String(b.parallelCalls)],
    ["Errors", String(a.toolErrors.length), String(b.toolErrors.length), true],
    ["Build calls", String(a.buildCalls.length), String(b.buildCalls.length)],
    ["Final build status", a.finalStatus ?? "n/a", b.finalStatus ?? "n/a"],
    ["Objects created", String(a.finalObjectCount ?? 0), String(b.finalObjectCount ?? 0)],
    ["Tokens (total)", String(a.state.tokenUsage.total), String(b.state.tokenUsage.total)],
    ["maxTokens", String(a.state.config.model.maxTokens), String(b.state.config.model.maxTokens)],
  ];

  for (const [label, va, vb, highlight] of rows) {
    const colorA = highlight && va !== vb ? (parseFloat(va) < parseFloat(vb) ? C.green : C.yellow) : "";
    const colorB = highlight && va !== vb ? (parseFloat(vb) < parseFloat(va) ? C.green : C.yellow) : "";
    console.log(
      `  ${label.padEnd(30)} ${colorA}${va.padEnd(30)}${C.reset} ${colorB}${vb}${C.reset}`
    );
  }

  // Tool usage comparison
  console.log(`\n${C.bold}--- Tool Usage ---${C.reset}\n`);
  const allTools = [...new Set([...a.uniqueToolsUsed, ...b.uniqueToolsUsed])].sort();
  for (const tool of allTools) {
    const countA = a.toolCalls.filter((t) => t.name === tool).length;
    const countB = b.toolCalls.filter((t) => t.name === tool).length;
    const avgA = a.toolCalls.filter((t) => t.name === tool && t.durationMs).reduce((s, t) => s + (t.durationMs ?? 0), 0) / (countA || 1);
    const avgB = b.toolCalls.filter((t) => t.name === tool && t.durationMs).reduce((s, t) => s + (t.durationMs ?? 0), 0) / (countB || 1);
    console.log(
      `  ${tool.padEnd(30)} ${String(countA).padEnd(5)} (avg ${(avgA / 1000).toFixed(1)}s)`.padEnd(50) +
      `${String(countB).padEnd(5)} (avg ${(avgB / 1000).toFixed(1)}s)`
    );
  }

  // Build progression
  console.log(`\n${C.bold}--- Build Progression ---${C.reset}\n`);
  console.log(`  ${C.cyan}Session A:${C.reset}`);
  for (const bc of a.buildCalls) {
    const qs = bc.questionCount ? ` (${bc.questionCount} questions)` : "";
    const objs = bc.objectCount ? ` → ${bc.objectCount} objects` : "";
    console.log(`    i=${bc.iteration}: ${bc.status}${qs}${objs}`);
  }
  console.log(`  ${C.magenta}Session B:${C.reset}`);
  for (const bc of b.buildCalls) {
    const qs = bc.questionCount ? ` (${bc.questionCount} questions)` : "";
    const objs = bc.objectCount ? ` → ${bc.objectCount} objects` : "";
    console.log(`    i=${bc.iteration}: ${bc.status}${qs}${objs}`);
  }

  // Errors
  if (a.toolErrors.length > 0 || b.toolErrors.length > 0) {
    console.log(`\n${C.bold}--- Errors ---${C.reset}\n`);
    if (a.toolErrors.length > 0) {
      console.log(`  ${C.cyan}Session A:${C.reset}`);
      for (const e of a.toolErrors) {
        console.log(`    ${C.red}i=${e.iteration} ${e.name}: ${e.error.slice(0, 100)}${C.reset}`);
      }
    }
    if (b.toolErrors.length > 0) {
      console.log(`  ${C.magenta}Session B:${C.reset}`);
      for (const e of b.toolErrors) {
        console.log(`    ${C.red}i=${e.iteration} ${e.name}: ${e.error.slice(0, 100)}${C.reset}`);
      }
    }
  }

  // Timeline
  console.log(`\n${C.bold}--- Call Timeline ---${C.reset}\n`);
  console.log(`  ${C.cyan}Session A:${C.reset}`);
  let prevIterA = -1;
  for (const tc of a.toolCalls) {
    const ts = tc.timestamp.slice(11, 19);
    const dur = tc.durationMs ? ` (${(tc.durationMs / 1000).toFixed(1)}s)` : "";
    const iterLabel = tc.iteration !== prevIterA ? `i=${tc.iteration}` : "    ";
    prevIterA = tc.iteration;
    console.log(`    ${C.dim}${ts}${C.reset} ${iterLabel.padEnd(6)} ${tc.name}${dur}`);
  }

  console.log(`  ${C.magenta}Session B:${C.reset}`);
  let prevIterB = -1;
  for (const tc of b.toolCalls) {
    const ts = tc.timestamp.slice(11, 19);
    const dur = tc.durationMs ? ` (${(tc.durationMs / 1000).toFixed(1)}s)` : "";
    const iterLabel = tc.iteration !== prevIterB ? `i=${tc.iteration}` : "    ";
    prevIterB = tc.iteration;
    console.log(`    ${C.dim}${ts}${C.reset} ${iterLabel.padEnd(6)} ${tc.name}${dur}`);
  }

  console.log();
}

// --- Main ---
const args = process.argv.slice(2);
const configIdx = args.indexOf("--config");
const configPath = configIdx >= 0 ? args[configIdx + 1] : "config.yaml";
const sessionArgs = args.filter((a, i) => a !== "--config" && (configIdx < 0 || i !== configIdx + 1));

if (sessionArgs.length !== 2) {
  console.error("Usage: compare-sessions.ts <session-a> <session-b> [--config path]");
  process.exit(1);
}

// Load config to find sessions dir
let sessionsDir = "./sessions";
try {
  const raw = fs.readFileSync(configPath, "utf-8");
  const yaml = await import("js-yaml");
  const config = yaml.default.load(raw) as Record<string, unknown>;
  const persistence = config.persistence as Record<string, unknown> | undefined;
  if (persistence?.dir) sessionsDir = String(persistence.dir);
} catch { /* use default */ }

const sessions = listSessions(sessionsDir);
const idA = resolveId(sessionArgs[0], sessions);
const idB = resolveId(sessionArgs[1], sessions);

const analysisA = analyzeSession(sessionsDir, idA);
const analysisB = analyzeSession(sessionsDir, idB);

printComparison(analysisA, analysisB);
