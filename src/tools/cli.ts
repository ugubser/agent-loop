import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { CliToolDef, ToolSchema } from "../types.js";
import type { FileStore } from "../persistence/file-store.js";
import { BUILTIN_HANDLERS, builtinSchemas } from "./builtin.js";

export class CliToolExecutor {
  private tools: Map<string, CliToolDef> = new Map();
  private builtinNames: Set<string> = new Set();
  private resolvedCommands: Map<string, string> = new Map(); // name → absolute path
  private currentSessionId: string | undefined;
  private store: FileStore | undefined;

  constructor(
    private allowedCommands: string[],
    private defaultTimeout: number
  ) {
    // Resolve each allowed command to absolute path at startup
    for (const cmd of allowedCommands) {
      if (path.isAbsolute(cmd)) {
        // Absolute paths are used as-is (e.g. venv python interpreters)
        this.resolvedCommands.set(cmd, cmd);
      } else {
        try {
          const resolved = execFileSync("which", [cmd], { encoding: "utf-8" }).trim();
          this.resolvedCommands.set(cmd, resolved);
        } catch {
          // Command not found on PATH — will error at registration time
        }
      }
    }
  }

  register(tool: CliToolDef): void {
    if (!this.resolvedCommands.has(tool.command)) {
      if (!this.allowedCommands.includes(tool.command)) {
        throw new Error(
          `Command "${tool.command}" is not in the allowed commands list`
        );
      }
      throw new Error(
        `Command "${tool.command}" is allowed but not found on PATH`
      );
    }
    this.tools.set(tool.name, tool);
  }

  registerBuiltin(name: string): void {
    if (!BUILTIN_HANDLERS[name]) {
      throw new Error(`Unknown built-in tool "${name}". Known: ${Object.keys(BUILTIN_HANDLERS).join(", ")}`);
    }
    this.builtinNames.add(name);
  }

  clearTools(): void {
    this.tools.clear();
    this.builtinNames.clear();
  }

  registerAll(tools: CliToolDef[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** Attach the current session ID and store so the executor can propagate
   *  AGENT_LOOP_PARENT_SESSION / AGENT_LOOP_PROCESS_NAME to spawned CLI
   *  tools and run built-in handlers. Call once per session lifetime. */
  setSessionContext(sessionId: string, store: FileStore): void {
    this.currentSessionId = sessionId;
    this.store = store;
  }

  schemas(): ToolSchema[] {
    const cliSchemas = Array.from(this.tools.values()).map((tool) => {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, def] of Object.entries(tool.schema)) {
        properties[key] = {
          type: def.type,
          ...(def.description ? { description: def.description } : {}),
        };
        required.push(key);
      }

      return {
        name: tool.name,
        description: tool.description,
        input_schema: {
          type: "object" as const,
          properties,
          required,
        },
      };
    });
    const bs = builtinSchemas(this.builtinNames);
    return [...cliSchemas, ...bs];
  }

  resolve(name: string): CliToolDef | undefined {
    return this.tools.get(name);
  }

  isBuiltin(name: string): boolean {
    return this.builtinNames.has(name);
  }

  /** Return names of all tools with context.preserveResult=true. Built-in
   *  tools are also treated as preserved (their summaries are infrastructure
   *  signals, not subject to context trimming). */
  preservedToolNames(): Set<string> {
    const result = new Set<string>();
    for (const [name, tool] of this.tools) {
      if (tool.context?.preserveResult) result.add(name);
    }
    for (const name of this.builtinNames) result.add(name);
    return result;
  }

  async execute(
    name: string,
    input: Record<string, unknown>
  ): Promise<string> {
    // Built-in dispatch
    if (this.builtinNames.has(name)) {
      const handler = BUILTIN_HANDLERS[name];
      if (!handler) throw new Error(`Built-in tool "${name}" missing handler`);
      if (!this.currentSessionId || !this.store) {
        throw new Error(`Built-in tool "${name}" requires session context; setSessionContext was not called`);
      }
      return handler.execute(input, {
        parentSessionId: this.currentSessionId,
        store: this.store,
      });
    }

    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const command = this.resolvedCommands.get(tool.command);
    if (!command) {
      throw new Error(`Command "${tool.command}" not resolved`);
    }

    const args = expandTemplates(tool.args, input);
    const timeout = (tool.timeout || this.defaultTimeout) * 1000;

    // Validate: if any expanded arg looks like JSON but doesn't parse, reject early
    for (const arg of args) {
      const trimmed = arg.trim();
      if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 2) {
        try {
          JSON.parse(trimmed);
        } catch (parseErr) {
          return `ERROR: Malformed JSON in tool argument. ${diagnoseJson(trimmed)} ` +
            `Parser: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. ` +
            `Fix the JSON and resend. Here is what you sent:\n${trimmed.slice(0, 2000)}`;
        }
      }
    }

    // Determine if we need to pipe stdin
    const stdinData = tool.stdinParam ? String(input[tool.stdinParam] ?? "") : null;

    // Build env: parent linkage vars + tool-specific vars + process env.
    // The child process — which may itself be `bun src/cli.ts run …` —
    // picks up AGENT_LOOP_PARENT_SESSION / AGENT_LOOP_PROCESS_NAME and
    // links its session back to the current one.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.currentSessionId) env.AGENT_LOOP_PARENT_SESSION = this.currentSessionId;
    env.AGENT_LOOP_PROCESS_NAME = name;
    if (tool.env) Object.assign(env, tool.env);

    return new Promise((resolve, reject) => {
      const child = execFile(
        command,
        args,
        { timeout, maxBuffer: 1024 * 1024, env },
        (error, stdout, stderr) => {
          if (error) {
            if (error.killed) {
              resolve(`ERROR: timeout after ${timeout / 1000}s`);
              return;
            }
            const exitCode = error.code ?? "unknown";
            resolve(`ERROR (exit ${exitCode}): ${stderr || error.message}`);
            return;
          }
          resolve(stdout);
        }
      );

      // Pipe stdin if configured
      if (stdinData !== null && child.stdin) {
        child.stdin.write(stdinData);
        child.stdin.end();
      }
    });
  }
}

/**
 * Expand template placeholders in args array.
 *
 * Rules:
 * 1. Only expand ${paramName} where paramName matches a key in input
 * 2. Unknown ${...} patterns are left literal
 * 3. No environment variable expansion
 * 4. Raw substitution (no URL encoding — security comes from execFile, not encoding)
 * 5. Single pass, no recursion
 */
/**
 * Diagnose common JSON issues and return a human-readable hint.
 */
function diagnoseJson(s: string): string {
  let openBraces = 0, closeBraces = 0;
  let openBrackets = 0, closeBrackets = 0;
  let inString = false;
  let escape = false;

  for (const c of s) {
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") openBraces++;
    if (c === "}") closeBraces++;
    if (c === "[") openBrackets++;
    if (c === "]") closeBrackets++;
  }

  const hints: string[] = [];
  const missingBraces = openBraces - closeBraces;
  const missingBrackets = openBrackets - closeBrackets;

  if (missingBraces > 0) hints.push(`Missing ${missingBraces} closing "}" brace(s).`);
  if (missingBraces < 0) hints.push(`Extra ${-missingBraces} closing "}" brace(s).`);
  if (missingBrackets > 0) hints.push(`Missing ${missingBrackets} closing "]" bracket(s).`);
  if (missingBrackets < 0) hints.push(`Extra ${-missingBrackets} closing "]" bracket(s).`);

  if (s.endsWith(",")) hints.push(`Trailing comma at end.`);

  if (hints.length === 0) hints.push("JSON structure issue.");

  return hints.join(" ");
}

export function expandTemplates(
  args: string[],
  input: Record<string, unknown>
): string[] {
  return args.map((arg) =>
    arg.replace(/\$\{(\w+)\}/g, (match, key) => {
      if (key in input) {
        return String(input[key]);
      }
      return match; // Unknown — leave literal
    })
  );
}
