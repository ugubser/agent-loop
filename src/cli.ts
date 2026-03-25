#!/usr/bin/env bun
import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import "dotenv/config";
import type { AgentConfig, SessionState } from "./types.js";
import { execFileSync } from "node:child_process";
import { FileStore } from "./persistence/file-store.js";
import { startNewSession, resumeSession } from "./core/loop.js";
import { discoverSkills } from "./skills/loader.js";

const DEFAULT_CONFIG: AgentConfig = {
  model: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    maxTokens: 8192,
  },
  session: {
    maxContext: 200000,
    checkpointInterval: 5,
    timeout: 21600, // 6 hours
  },
  skills: {
    dirs: ["./skills", path.join(process.env.HOME ?? "", ".agent-loop/skills")],
  },
  persistence: {
    backend: "file",
    dir: "./sessions",
  },
  tools: {
    cli: {
      allowedCommands: ["curl", "jq", "grep", "python3", "echo", "cat", "tee"],
      timeout: 120,
    },
  },
};

export function loadConfig(configPath: string): AgentConfig {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = yaml.load(raw) as Record<string, unknown>;
    return deepMerge(DEFAULT_CONFIG, parsed) as AgentConfig;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (
    typeof target !== "object" || target === null ||
    typeof source !== "object" || source === null
  ) {
    return source ?? target;
  }
  // Arrays replace, not merge
  if (Array.isArray(source)) {
    return source;
  }
  const result = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (value !== undefined) {
      result[key] = deepMerge(result[key], value);
    }
  }
  return result;
}

// --- Session index resolution ---
// Allows using short numeric indices (1, 2, 3...) instead of full UUIDs.
// The index maps to sessions sorted by updatedAt (most recent = 1).

async function resolveSessionId(
  idOrIndex: string,
  store: FileStore
): Promise<string> {
  // If it looks like a UUID, return as-is
  if (idOrIndex.includes("-") && idOrIndex.length > 8) {
    return idOrIndex;
  }
  // Try as numeric index
  const idx = parseInt(idOrIndex, 10);
  if (isNaN(idx) || idx < 1) {
    return idOrIndex; // Let it fail downstream
  }
  const sessions = await store.listSessions();
  if (idx > sessions.length) {
    throw new Error(`Session index ${idx} out of range (${sessions.length} sessions)`);
  }
  return sessions[idx - 1].id;
}

function getSessionPid(sessionDir: string, sessionId: string): number | null {
  const lockFile = path.join(sessionDir, sessionId, "session.lock");
  try {
    const content = fs.readFileSync(lockFile, "utf-8").trim();
    const pid = parseInt(content, 10);
    if (pid && isProcessAlive(pid)) {
      return pid;
    }
  } catch {
    // No lock file
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const program = new Command();

program
  .name("agent-loop")
  .description("Pluggable durable agent runtime")
  .version("0.1.0");

program
  .command("run [skill]")
  .description("Start a new agent session. Omit skill for auto-routing mode.")
  .option("-c, --config <path>", "Config file path", "config.yaml")
  .option("-t, --task <text>", "Task description for the session")
  .action(async (skill: string | undefined, opts: { config: string; task?: string }) => {
    const config = loadConfig(opts.config);
    const store = new FileStore(config.persistence.dir);
    fs.mkdirSync(config.persistence.dir, { recursive: true });

    if (skill) {
      console.log(`Starting session with skill: ${skill}`);
    } else {
      console.log("Starting session in auto-routing mode");
    }
    if (opts.task) console.log(`Task: ${opts.task}`);

    try {
      const sessionId = await startNewSession(skill, config, store, opts.task);
      console.log(`\nSession ${sessionId} finished.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      process.exit(1);
    }
  });

program
  .command("resume <session>")
  .description("Resume a paused or crashed session (accepts index or UUID)")
  .option("-c, --config <path>", "Config file path", "config.yaml")
  .action(async (session: string, opts: { config: string }) => {
    const config = loadConfig(opts.config);
    const store = new FileStore(config.persistence.dir);
    const sessionId = await resolveSessionId(session, store);

    console.log(`Resuming session: ${sessionId}`);
    try {
      await resumeSession(sessionId, config, store);
      console.log(`\nSession ${sessionId} finished.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("auth [skill] [url]")
  .description("Open a headed browser to warm up a session (accept cookies, solve CAPTCHAs, log in)")
  .option("-c, --config <path>", "Config file path", "config.yaml")
  .action(async (skill: string | undefined, url: string | undefined, opts: { config: string }) => {
    const config = loadConfig(opts.config);

    // Determine session name — use skill name, or "default"
    let sessionName = skill ?? "default";

    // If a skill name was given, verify it exists
    if (skill) {
      const skills = await discoverSkills(config.skills.dirs);
      if (!skills.has(skill)) {
        const available = Array.from(skills.keys()).join(", ");
        console.error(`Skill "${skill}" not found. Available: ${available || "none"}`);
        process.exit(1);
      }
    }

    const target = url ?? "https://www.google.com";

    // Close any running headless daemon first
    try {
      execFileSync("agent-browser", ["close"], { stdio: "pipe" });
    } catch {
      // No daemon running — fine
    }

    console.log(`Opening headed browser for session "${sessionName}"...`);
    console.log(`Navigate, accept cookies, solve CAPTCHAs — the session is saved automatically.`);
    console.log(`\nPress Enter here when you're done.\n`);

    // Open headed browser with the session name
    try {
      execFileSync("agent-browser", [
        "--headed",
        "--session-name", sessionName,
        "open", target,
      ], { stdio: "pipe" });
    } catch {
      // Ignore errors from open
    }

    // Wait for user to press Enter
    await new Promise<void>((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", () => {
        process.stdin.pause();
        resolve();
      });
    });

    // Close the headed browser so next agent run starts headless
    try {
      execFileSync("agent-browser", ["close"], { stdio: "pipe" });
    } catch {
      // Already closed
    }

    console.log(`Session "${sessionName}" saved. The agent will reuse these cookies.`);
  });

program
  .command("list")
  .description("List all sessions")
  .option("-c, --config <path>", "Config file path", "config.yaml")
  .action(async (opts: { config: string }) => {
    const config = loadConfig(opts.config);
    const store = new FileStore(config.persistence.dir);
    const sessions = await store.listSessions();

    if (sessions.length === 0) {
      console.log("No sessions found.");
      return;
    }

    console.log(
      "#".padEnd(5) +
        "ID".padEnd(38) +
        "Status".padEnd(18) +
        "Skill".padEnd(20) +
        "Iter".padEnd(7) +
        "Updated"
    );
    console.log("-".repeat(105));

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const status = s.reason ? `${s.status}(${s.reason})` : s.status;
      console.log(
        String(i + 1).padEnd(5) +
          s.id.padEnd(38) +
          status.padEnd(18) +
          s.skillName.padEnd(20) +
          String(s.iteration).padEnd(7) +
          s.updatedAt
      );
    }
  });

program
  .command("status <session>")
  .description("Show detailed session status (accepts index or UUID)")
  .option("-c, --config <path>", "Config file path", "config.yaml")
  .action(async (session: string, opts: { config: string }) => {
    const config = loadConfig(opts.config);
    const store = new FileStore(config.persistence.dir);
    const sessionId = await resolveSessionId(session, store);

    try {
      const state = await store.readState(sessionId);
      const pid = getSessionPid(config.persistence.dir, sessionId);
      console.log(`Session: ${state.id}`);
      console.log(`Status:  ${state.status}${state.reason ? ` (${state.reason})` : ""}${pid ? ` [PID ${pid}]` : ""}`);
      console.log(`Skill:   ${state.skillName}`);
      console.log(`Started: ${state.startedAt}`);
      console.log(`Updated: ${state.updatedAt}`);
      console.log(`Iteration: ${state.iteration}`);
      console.log(`Tokens:  ${state.tokenUsage.total} (in: ${state.tokenUsage.input}, out: ${state.tokenUsage.output})`);
      if (state.lastCheckpoint) {
        console.log(`Last checkpoint: ${state.lastCheckpoint}`);
      }
    } catch {
      console.error(`Session ${sessionId} not found.`);
      process.exit(1);
    }
  });

program
  .command("stop <session>")
  .description("Stop a running session by sending SIGTERM (accepts index or UUID)")
  .option("-c, --config <path>", "Config file path", "config.yaml")
  .action(async (session: string, opts: { config: string }) => {
    const config = loadConfig(opts.config);
    const store = new FileStore(config.persistence.dir);
    const sessionId = await resolveSessionId(session, store);

    const pid = getSessionPid(config.persistence.dir, sessionId);
    if (!pid) {
      console.log(`Session ${sessionId} is not running (no active process found).`);
      process.exit(1);
    }

    console.log(`Stopping session ${sessionId} (PID ${pid})...`);
    try {
      process.kill(pid, "SIGTERM");
      console.log("SIGTERM sent. Session will pause gracefully.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to stop: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("tail <session>")
  .description("Stream the session transcript in real-time (accepts index or UUID)")
  .option("-c, --config <path>", "Config file path", "config.yaml")
  .option("-n, --lines <n>", "Initial lines to show", "10")
  .option("-d, --debug", "Show full request/response payloads with color coding")
  .action(async (session: string, opts: { config: string; lines: string; debug?: boolean }) => {
    const config = loadConfig(opts.config);
    const store = new FileStore(config.persistence.dir);
    const sessionId = await resolveSessionId(session, store);
    const n = parseInt(opts.lines, 10);
    const debug = opts.debug ?? false;

    // Show last N entries
    const entries = await store.tailTranscript(sessionId, n);
    for (const entry of entries) {
      printTranscriptEntry(entry, debug);
    }

    // Watch for new entries
    const transcriptPath = path.join(config.persistence.dir, sessionId, "transcript.jsonl");
    let lastSize = fs.statSync(transcriptPath).size;

    console.log("\n--- watching for new entries (Ctrl+C to stop) ---\n");

    const watcher = fs.watch(transcriptPath, () => {
      try {
        const stat = fs.statSync(transcriptPath);
        if (stat.size > lastSize) {
          const fd = fs.openSync(transcriptPath, "r");
          const buf = Buffer.alloc(stat.size - lastSize);
          fs.readSync(fd, buf, 0, buf.length, lastSize);
          fs.closeSync(fd);
          lastSize = stat.size;

          const lines = buf.toString("utf-8").trim().split("\n");
          for (const line of lines) {
            try {
              printTranscriptEntry(JSON.parse(line), debug);
            } catch {
              // Skip malformed lines
            }
          }
        }
      } catch {
        // File might not exist yet
      }
    });

    // Keep process alive until Ctrl+C
    process.on("SIGINT", () => {
      watcher.close();
      process.exit(0);
    });

    // Wait indefinitely
    await new Promise(() => {});
  });

program
  .command("inspect <session>")
  .description("Show the latest checkpoint contents (accepts index or UUID)")
  .option("-c, --config <path>", "Config file path", "config.yaml")
  .action(async (session: string, opts: { config: string }) => {
    const config = loadConfig(opts.config);
    const store = new FileStore(config.persistence.dir);
    const sessionId = await resolveSessionId(session, store);
    const cp = await store.readCheckpoint(sessionId);

    if (!cp) {
      console.log("No checkpoint found for this session.");
      return;
    }

    console.log(JSON.stringify(cp, null, 2));
  });

// ANSI color codes
const C = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

function printTranscriptEntry(
  entry: { type: string; timestamp: string; iteration?: number; data: unknown },
  debug = false
): void {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const iter = entry.iteration !== undefined ? ` i=${entry.iteration}` : "";
  const prefix = `${C.dim}[${time}${iter}]${C.reset}`;
  const data = entry.data as Record<string, unknown>;

  switch (entry.type) {
    case "message": {
      const role = (data as { role?: string }).role ?? "unknown";
      const content = (data as { content?: unknown }).content;

      if (role === "user") {
        // User messages = requests to LLM (green)
        if (typeof content === "string") {
          if (debug) {
            console.log(`${prefix} ${C.green}${C.bold}USER →${C.reset}`);
            console.log(`${C.green}${content}${C.reset}`);
          } else {
            console.log(`${prefix} ${C.green}user: ${content.slice(0, 200)}${C.reset}`);
          }
        } else {
          // Tool result content blocks in user message
          const blocks = content as Array<Record<string, unknown>>;
          if (debug) {
            console.log(`${prefix} ${C.green}${C.bold}TOOL RESULT →${C.reset}`);
            for (const b of blocks) {
              if (b.type === "tool_result") {
                const c = String(b.content ?? "");
                const isErr = b.is_error;
                const color = isErr ? C.red : C.green;
                console.log(`${color}  [${b.tool_use_id}] ${c.slice(0, 50000)}${C.reset}`);
              }
            }
          } else {
            console.log(`${prefix} ${C.green}user: ${JSON.stringify(content).slice(0, 200)}${C.reset}`);
          }
        }
        break;
      }

      if (role === "assistant") {
        // Assistant messages = responses from LLM (red)
        const blocks = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];

        if (debug) {
          console.log(`${prefix} ${C.red}${C.bold}← ASSISTANT${C.reset}`);
          for (const b of blocks) {
            if (b.type === "text" && b.text) {
              console.log(`${C.red}  ${String(b.text).slice(0, 50000)}${C.reset}`);
            } else if (b.type === "tool_use") {
              console.log(`${C.red}  CALL ${C.bold}${b.name}${C.reset}${C.red}(${JSON.stringify(b.input).slice(0, 50000)})${C.reset}`);
            }
          }
        } else {
          for (const b of blocks) {
            if (b.type === "text" && b.text) {
              console.log(`${prefix} ${C.red}assistant: ${String(b.text).slice(0, 200)}${C.reset}`);
            } else if (b.type === "tool_use") {
              console.log(`${prefix} ${C.red}CALL ${b.name}(${JSON.stringify(b.input).slice(0, 150)})${C.reset}`);
            }
          }
        }
        break;
      }

      // Fallback for other roles
      const text = typeof content === "string" ? content.slice(0, 200) : JSON.stringify(content).slice(0, 200);
      console.log(`${prefix} ${role}: ${text}`);
      break;
    }
    case "tool_result": {
      // Tool results logged separately (green = request to LLM)
      const blocks = (data as { content?: unknown }).content;
      if (debug && Array.isArray(blocks)) {
        console.log(`${prefix} ${C.green}${C.bold}TOOL RESULT →${C.reset}`);
        for (const b of blocks as Array<Record<string, unknown>>) {
          if (b.type === "tool_result") {
            const c = String(b.content ?? "");
            const isErr = b.is_error;
            const color = isErr ? C.red : C.green;
            console.log(`${color}  [${b.tool_use_id}] ${c.slice(0, 50000)}${C.reset}`);
          }
        }
      } else if (debug) {
        console.log(`${prefix} ${C.green}tool_result: ${JSON.stringify(data).slice(0, 50000)}${C.reset}`);
      } else {
        console.log(`${prefix} ${C.green}tool_result: ${JSON.stringify(data).slice(0, 200)}${C.reset}`);
      }
      break;
    }
    case "status_change":
      console.log(`${prefix} ${C.yellow}${C.bold}STATUS: ${JSON.stringify(data)}${C.reset}`);
      break;
    case "compaction":
      console.log(`${prefix} ${C.cyan}COMPACTION: ${JSON.stringify(data)}${C.reset}`);
      break;
    default:
      console.log(`${prefix} ${entry.type}: ${JSON.stringify(data).slice(0, 200)}`);
  }
}

// Only parse when run directly (not when imported for testing)
if (import.meta.main) {
  program.parse();
}
