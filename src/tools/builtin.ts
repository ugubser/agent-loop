import { execFile } from "node:child_process";
import type { ToolSchema, TranscriptEntry, SessionState } from "../types.js";
import type { FileStore } from "../persistence/file-store.js";

export interface BuiltinContext {
  parentSessionId: string;
  store: FileStore;
}

export interface BuiltinHandler {
  name: string;
  description: string;
  inputSchema: ToolSchema["input_schema"];
  execute(input: Record<string, unknown>, ctx: BuiltinContext): Promise<string>;
}

// --- check_process ---------------------------------------------------------

const checkProcessHandler: BuiltinHandler = {
  name: "check_process",
  description:
    "Return a structured summary of a sub-process that the current session dispatched, addressed by its process name (the name of the tool used to dispatch it, e.g. 'run_build'). Returns build_status, mcp_session_id, pending_questions, object_count, saved_to where applicable. No agent-loop session UUIDs in input or output.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The name of the dispatching tool whose sub-process you want to inspect (e.g. 'run_build', 'run_build_redacted').",
      },
    },
    required: ["name"],
  },
  async execute(input, ctx) {
    const name = String(input.name ?? "");
    if (!name) return "status: error\nreason: name is required";
    const sub = await ctx.store.findSubProcessByName(ctx.parentSessionId, name);
    if (!sub) return `name: ${name}\nstatus: not_found`;
    return summarizeSubProcess(ctx.store, sub);
  },
};

// --- resume_process --------------------------------------------------------

const resumeProcessHandler: BuiltinHandler = {
  name: "resume_process",
  description:
    "Resume a sub-process the current session dispatched, addressed by its process name. The sub-process continues from its last checkpoint under its own original config. Synchronous — blocks until the resumed sub-process exits. Returns the same summary shape as check_process.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The name of the dispatching tool whose sub-process you want to resume.",
      },
    },
    required: ["name"],
  },
  async execute(input, ctx) {
    const name = String(input.name ?? "");
    if (!name) return "status: error\nreason: name is required";
    const sub = await ctx.store.findSubProcessByName(ctx.parentSessionId, name);
    if (!sub) return `name: ${name}\nstatus: not_found`;
    if (!sub.config_path) {
      return `name: ${name}\nstatus: error\nreason: sub-process has no config_path recorded; cannot resume`;
    }

    await runResumeSubprocess(sub.id, sub.config_path, ctx);
    // Re-read post-resume state
    const post = await ctx.store.readState(sub.id);
    return summarizeSubProcess(ctx.store, post);
  },
};

export const BUILTIN_HANDLERS: Record<string, BuiltinHandler> = {
  check_process: checkProcessHandler,
  resume_process: resumeProcessHandler,
};

// --- Helpers ---------------------------------------------------------------

async function summarizeSubProcess(
  store: FileStore,
  state: SessionState
): Promise<string> {
  const lines: string[] = [];
  lines.push(`name: ${state.process_name ?? "(unnamed)"}`);
  lines.push(`status: ${state.status}`);
  if (state.reason) lines.push(`reason: ${state.reason}`);
  lines.push(`skill: ${state.skillName}`);
  lines.push(`iteration: ${state.iteration}`);
  lines.push(`tokens: ${state.tokenUsage.total}`);

  // Walk the transcript backwards to find:
  //   1. `lastToolResult`: the absolute last tool_result (for raw context)
  //   2. The most recent tool_result whose content looks like an
  //      `build_instrument` response (JSON with a `status` field) — that's
  //      where we pull build_status / mcp_session_id / pending_questions
  //      / object_count / saved_to from.
  // Without (2), a stage that ended with an incidental tool call
  // (e.g. save_file writing the session_id to disk) would mask the
  // earlier successful build_instrument response.
  let buildStatus: string | undefined;
  let pendingQuestions: number | undefined;
  let objectCount: number | undefined;
  let savedTo: string | undefined;
  let mcpSessionId: string | undefined;
  let lastToolResult: string | undefined;
  let buildResultPreview: string | undefined; // preview of the build_instrument response if found

  try {
    const transcript = await store.readTranscript(state.id);
    for (let i = transcript.length - 1; i >= 0; i--) {
      const entry = transcript[i] as TranscriptEntry;
      if (entry.type !== "tool_result") continue;
      const data = entry.data as { content?: unknown };
      const content = (data?.content as Array<{ content?: string }>) ?? [];
      if (!Array.isArray(content)) continue;
      const block = content[0];
      if (!block || typeof block.content !== "string") continue;
      // Capture the absolute last tool_result (first one we encounter, walking back)
      if (lastToolResult === undefined) {
        lastToolResult = truncate(block.content, 500);
      }
      // Try to extract build_instrument fields from this entry
      try {
        const parsed = JSON.parse(block.content) as Record<string, unknown>;
        // We accept a build_instrument response as having a string `status`
        // field. The actual values are: needs_input,
        // needs_property_review, complete, complete_with_warnings, error.
        if (typeof parsed.status === "string") {
          buildStatus = parsed.status;
          if (Array.isArray(parsed.questions)) pendingQuestions = (parsed.questions as unknown[]).length;
          const summary = parsed.summary as Record<string, unknown> | undefined;
          if (summary && typeof summary.object_count === "number") {
            objectCount = summary.object_count;
          }
          if (typeof parsed.saved_to === "string") savedTo = parsed.saved_to;
          if (typeof parsed.session_id === "string") mcpSessionId = parsed.session_id;
          if (typeof parsed.active_session_id === "string" && !mcpSessionId) {
            mcpSessionId = parsed.active_session_id;
          }
          buildResultPreview = truncate(block.content, 500);
          break; // found the most recent build_instrument response; stop walking
        }
      } catch { /* not JSON — keep walking */ }
    }
  } catch { /* missing transcript — fall through */ }

  // If we found a build_instrument response, prefer its preview as the
  // `last_tool_result` field — that's the result the orchestrator cares
  // about. Otherwise show the literal last tool_result.
  if (buildResultPreview !== undefined) {
    lastToolResult = buildResultPreview;
  }

  if (buildStatus !== undefined) lines.push(`build_status: ${buildStatus}`);
  if (pendingQuestions !== undefined) lines.push(`pending_questions: ${pendingQuestions}`);
  if (objectCount !== undefined) lines.push(`object_count: ${objectCount}`);
  if (savedTo !== undefined) lines.push(`saved_to: ${savedTo}`);
  if (mcpSessionId !== undefined) lines.push(`mcp_session_id: ${mcpSessionId}`);
  if (lastToolResult !== undefined) lines.push(`last_tool_result: ${lastToolResult}`);

  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  const normalized = s.replace(/\s+/g, " ").trim();
  return normalized.length > n ? normalized.slice(0, n) + "…" : normalized;
}

function runResumeSubprocess(
  subprocessId: string,
  configPath: string,
  ctx: BuiltinContext
): Promise<void> {
  // Locate src/cli.ts relative to this file. When agent-loop is run
  // from its repo root, src/cli.ts is the entrypoint.
  // We assume the parent process's cwd is the agent-loop repo root
  // (true for all CLI invocations via `bun run src/cli.ts`).
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      AGENT_LOOP_PARENT_SESSION: ctx.parentSessionId,
      // Re-use the same process_name on resume so grand-sub-processes
      // see consistent linkage. The resumed session already has its own
      // process_name on disk; this env var is for any further dispatch
      // tools fired from within it.
    };

    const child = execFile(
      "bun",
      ["run", "src/cli.ts", "resume", subprocessId, "--config", configPath],
      { env, maxBuffer: 10 * 1024 * 1024 },
      (error) => {
        if (error) {
          reject(new Error(`resume_process subprocess failed: ${error.message}`));
          return;
        }
        resolve();
      }
    );

    // Stream child output to the parent's stderr so audit-UI / logs see it,
    // but it does NOT flow back to the LLM via the tool result.
    child.stdout?.on("data", (chunk: Buffer) => process.stderr.write(`[resume ${subprocessId.slice(0, 8)}] ${chunk}`));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[resume ${subprocessId.slice(0, 8)}] ${chunk}`));
  });
}

// Re-export for convenience
export function builtinSchemas(names: Iterable<string>): ToolSchema[] {
  const out: ToolSchema[] = [];
  for (const n of names) {
    const h = BUILTIN_HANDLERS[n];
    if (!h) continue;
    out.push({
      name: h.name,
      description: h.description,
      input_schema: h.inputSchema,
    });
  }
  return out;
}

