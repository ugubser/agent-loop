#!/usr/bin/env bun
/**
 * Check session status and last build result.
 * Usage: bun scripts/check-session.ts <session-id>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const sessionId = process.argv[2];
if (!sessionId) { console.log("Usage: check-session.ts <session-id>"); process.exit(1); }

const sessionsDir = "./sessions";
const stateFile = path.join(sessionsDir, sessionId, "state.json");
const transcriptFile = path.join(sessionsDir, sessionId, "transcript.jsonl");

if (!fs.existsSync(stateFile)) { console.log(`Session ${sessionId} not found.`); process.exit(1); }

const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
console.log(`session_id: ${state.id}`);
console.log(`status: ${state.status}${state.reason ? ` (${state.reason})` : ""}`);
console.log(`skill: ${state.skillName}`);
console.log(`iteration: ${state.iteration}`);
console.log(`tokens: ${state.tokenUsage.total}`);

// Find last build_instrument result
const lines = fs.readFileSync(transcriptFile, "utf-8").trim().split("\n");
let lastBuildResult: Record<string, unknown> | null = null;

for (let i = lines.length - 1; i >= 0; i--) {
  try {
    const entry = JSON.parse(lines[i]);
    if (entry.type === "tool_result") {
      const content = entry.data?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result" && typeof block.content === "string") {
            try {
              const result = JSON.parse(block.content);
              if (result.status) {
                lastBuildResult = result;
                break;
              }
            } catch { /* not JSON */ }
          }
        }
      }
    }
  } catch { /* skip */ }
  if (lastBuildResult) break;
}

if (lastBuildResult) {
  console.log(`build_status: ${lastBuildResult.status}`);
  const summary = lastBuildResult.summary as Record<string, unknown> | undefined;
  if (summary) {
    console.log(`object_count: ${summary.object_count}`);
    const objects = summary.objects as Array<Record<string, unknown>> | undefined;
    if (objects) {
      for (const obj of objects) {
        console.log(`  - ${obj.id} (${obj.class})`);
      }
    }
  }
  if (lastBuildResult.saved_to) {
    console.log(`saved_to: ${lastBuildResult.saved_to}`);
  }
  if (lastBuildResult.questions) {
    const qs = lastBuildResult.questions as Array<unknown>;
    console.log(`pending_questions: ${qs.length}`);
  }
} else {
  console.log("build_status: no build result found");
}
