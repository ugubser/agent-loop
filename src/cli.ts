#!/usr/bin/env bun
import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import "dotenv/config";
import type { AgentConfig } from "./types.js";
import { FileStore } from "./persistence/file-store.js";
import { startNewSession, resumeSession } from "./core/loop.js";

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

const program = new Command();

program
  .name("agent-loop")
  .description("Pluggable durable agent runtime")
  .version("0.1.0");

program
  .command("run <skill>")
  .description("Start a new agent session with the given skill")
  .option("-c, --config <path>", "Config file path", "config.yaml")
  .option("-t, --task <text>", "Task description for the session")
  .action(async (skill: string, opts: { config: string; task?: string }) => {
    const config = loadConfig(opts.config);
    const store = new FileStore(config.persistence.dir);
    fs.mkdirSync(config.persistence.dir, { recursive: true });

    console.log(`Starting session with skill: ${skill}`);
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
  .command("resume <session-id>")
  .description("Resume a paused or crashed session")
  .option("-c, --config <path>", "Config file path", "config.yaml")
  .action(async (sessionId: string, opts: { config: string }) => {
    const config = loadConfig(opts.config);
    const store = new FileStore(config.persistence.dir);

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
      "ID".padEnd(38) +
        "Status".padEnd(12) +
        "Skill".padEnd(20) +
        "Iterations".padEnd(12) +
        "Updated"
    );
    console.log("-".repeat(95));

    for (const s of sessions) {
      const status = s.reason ? `${s.status}(${s.reason})` : s.status;
      console.log(
        s.id.padEnd(38) +
          status.padEnd(12) +
          s.skillName.padEnd(20) +
          String(s.iteration).padEnd(12) +
          s.updatedAt
      );
    }
  });

program
  .command("status <session-id>")
  .description("Show detailed session status")
  .option("-c, --config <path>", "Config file path", "config.yaml")
  .action(async (sessionId: string, opts: { config: string }) => {
    const config = loadConfig(opts.config);
    const store = new FileStore(config.persistence.dir);

    try {
      const state = await store.readState(sessionId);
      console.log(`Session: ${state.id}`);
      console.log(`Status:  ${state.status}${state.reason ? ` (${state.reason})` : ""}`);
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
  .command("tail <session-id>")
  .description("Stream the session transcript in real-time")
  .option("-c, --config <path>", "Config file path", "config.yaml")
  .option("-n, --lines <n>", "Initial lines to show", "10")
  .action(async (sessionId: string, opts: { config: string; lines: string }) => {
    const config = loadConfig(opts.config);
    const store = new FileStore(config.persistence.dir);
    const n = parseInt(opts.lines, 10);

    // Show last N entries
    const entries = await store.tailTranscript(sessionId, n);
    for (const entry of entries) {
      printTranscriptEntry(entry);
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
              printTranscriptEntry(JSON.parse(line));
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
  .command("inspect <session-id>")
  .description("Show the latest checkpoint contents")
  .option("-c, --config <path>", "Config file path", "config.yaml")
  .action(async (sessionId: string, opts: { config: string }) => {
    const config = loadConfig(opts.config);
    const store = new FileStore(config.persistence.dir);
    const cp = await store.readCheckpoint(sessionId);

    if (!cp) {
      console.log("No checkpoint found for this session.");
      return;
    }

    console.log(JSON.stringify(cp, null, 2));
  });

function printTranscriptEntry(entry: { type: string; timestamp: string; data: unknown }): void {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const data = entry.data as Record<string, unknown>;

  switch (entry.type) {
    case "message": {
      const role = (data as { role?: string }).role ?? "unknown";
      const content = (data as { content?: unknown }).content;
      const text =
        typeof content === "string"
          ? content.slice(0, 200)
          : JSON.stringify(content).slice(0, 200);
      console.log(`[${time}] ${role}: ${text}`);
      break;
    }
    case "tool_result":
      console.log(`[${time}] tool_result: ${JSON.stringify(data).slice(0, 200)}`);
      break;
    case "status_change":
      console.log(`[${time}] STATUS: ${JSON.stringify(data)}`);
      break;
    case "compaction":
      console.log(`[${time}] COMPACTION: ${JSON.stringify(data)}`);
      break;
    default:
      console.log(`[${time}] ${entry.type}: ${JSON.stringify(data).slice(0, 200)}`);
  }
}

// Only parse when run directly (not when imported for testing)
if (import.meta.main) {
  program.parse();
}
