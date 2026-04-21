#!/usr/bin/env bun
/**
 * Audit/inspection web UI for agent-loop sessions.
 * Standalone server — reads session data from disk, serves a SPA.
 *
 * Usage:
 *   bun run src/audit/server.ts [--sessions ./sessions] [--port 3900]
 *   bun run src/cli.ts audit --config config.codex.yaml
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionState, TranscriptEntry } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readState(dir: string, id: string): SessionState {
  const raw = fs.readFileSync(path.join(dir, id, "state.json"), "utf-8");
  return JSON.parse(raw) as SessionState;
}

function readTranscript(dir: string, id: string): TranscriptEntry[] {
  const raw = fs.readFileSync(path.join(dir, id, "transcript.jsonl"), "utf-8");
  if (!raw.trim()) return [];
  return raw.trim().split("\n").map((l) => JSON.parse(l) as TranscriptEntry);
}

/** Read the system prompt from the first available checkpoint. */
function readSystemPrompt(dir: string, id: string): string {
  try {
    const sessionDir = path.join(dir, id);
    const files = fs.readdirSync(sessionDir)
      .filter((f) => f.startsWith("checkpoint-") && f.endsWith(".json"))
      .sort();
    if (files.length === 0) return "";
    const raw = fs.readFileSync(path.join(sessionDir, files[0]), "utf-8");
    const cp = JSON.parse(raw) as { systemPrompt?: string };
    return cp.systemPrompt ?? "";
  } catch {
    return "";
  }
}

/** Extract the first user message from a transcript (fast — reads only first 4KB). */
function taskPreview(dir: string, id: string): string {
  try {
    const fd = fs.openSync(path.join(dir, id, "transcript.jsonl"), "r");
    const buf = Buffer.alloc(4096);
    fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const firstLine = buf.toString("utf-8").split("\n")[0];
    if (!firstLine) return "";
    const entry = JSON.parse(firstLine) as TranscriptEntry;
    const data = entry.data as { role?: string; content?: string | unknown[] };
    if (data?.role === "user" && typeof data.content === "string") {
      return data.content.slice(0, 200);
    }
    return "";
  } catch {
    return "";
  }
}

/** Strip sensitive fields from config before sending to the frontend. */
function sanitizeState(state: SessionState): SessionState {
  const s = structuredClone(state);
  if (s.config?.model) {
    delete (s.config.model as Record<string, unknown>).apiKey;
    delete (s.config.model as Record<string, unknown>).authToken;
  }
  return s;
}

// ---------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startAuditServer(sessionsDir: string, port = 3900) {
  // Resolve public dir relative to this file's location
  const publicDir = path.join(path.dirname(new URL(import.meta.url).pathname), "public");
  const absSessionsDir = path.resolve(sessionsDir);

  console.log(`Audit UI: http://localhost:${port}`);
  console.log(`Sessions: ${absSessionsDir}`);

  // Use Bun.serve at runtime (cast to any to satisfy Node-only tsconfig)
  const runtime = globalThis as Record<string, unknown>;
  const BunRef = runtime.Bun as { serve: (opts: unknown) => void };
  BunRef.serve({
    port,
    async fetch(req: Request) {
      const url = new URL(req.url);
      const p = url.pathname;

      // ---- API routes ----

      if (p === "/api/sessions") {
        try {
          const entries = fs.readdirSync(absSessionsDir, { withFileTypes: true });
          const sessions: Array<Record<string, unknown>> = [];
          for (const e of entries) {
            if (!e.isDirectory()) continue;
            try {
              const state = sanitizeState(readState(absSessionsDir, e.name));
              sessions.push({
                ...state,
                shortId: state.id.slice(0, 8),
                taskPreview: taskPreview(absSessionsDir, e.name),
              });
            } catch { /* skip invalid */ }
          }
          sessions.sort((a, b) =>
            new Date(b.updatedAt as string).getTime() - new Date(a.updatedAt as string).getTime()
          );
          return Response.json(sessions);
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 500 });
        }
      }

      const sessionMatch = p.match(/^\/api\/sessions\/([a-f0-9-]{36})$/);
      if (sessionMatch) {
        const id = sessionMatch[1];
        try {
          const state = sanitizeState(readState(absSessionsDir, id));
          const transcript = readTranscript(absSessionsDir, id);
          const systemPrompt = readSystemPrompt(absSessionsDir, id);
          return Response.json({ state, transcript, systemPrompt });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 404 });
        }
      }

      // ---- Static files ----

      let filePath = path.join(publicDir, p === "/" ? "index.html" : p);
      if (!fs.existsSync(filePath)) {
        filePath = path.join(publicDir, "index.html"); // SPA fallback
      }

      const ext = path.extname(filePath);
      const contentType = MIME[ext] ?? "application/octet-stream";
      const body = fs.readFileSync(filePath);
      return new Response(body, { headers: { "Content-Type": contentType } });
    },
  });
}

// ---------------------------------------------------------------------------
// Direct invocation: bun run src/audit/server.ts [--sessions ./sessions] [--port 3900]
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  let sessionsDir = "./sessions";
  let port = 3900;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sessions" && args[i + 1]) sessionsDir = args[++i];
    if (args[i] === "--port" && args[i + 1]) port = parseInt(args[++i]);
  }
  startAuditServer(sessionsDir, port);
}
