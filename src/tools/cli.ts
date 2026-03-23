import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import type { CliToolDef, ToolSchema } from "../types.js";

export class CliToolExecutor {
  private tools: Map<string, CliToolDef> = new Map();
  private resolvedCommands: Map<string, string> = new Map(); // name → absolute path

  constructor(
    private allowedCommands: string[],
    private defaultTimeout: number
  ) {
    // Resolve each allowed command to absolute path at startup
    for (const cmd of allowedCommands) {
      try {
        const resolved = execFileSync("which", [cmd], { encoding: "utf-8" }).trim();
        this.resolvedCommands.set(cmd, resolved);
      } catch {
        // Command not found on PATH — will error at registration time
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

  clearTools(): void {
    this.tools.clear();
  }

  registerAll(tools: CliToolDef[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  schemas(): ToolSchema[] {
    return Array.from(this.tools.values()).map((tool) => {
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
  }

  resolve(name: string): CliToolDef | undefined {
    return this.tools.get(name);
  }

  async execute(
    name: string,
    input: Record<string, unknown>
  ): Promise<string> {
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

    // Determine if we need to pipe stdin
    const stdinData = tool.stdinParam ? String(input[tool.stdinParam] ?? "") : null;

    return new Promise((resolve, reject) => {
      const child = execFile(
        command,
        args,
        { timeout, maxBuffer: 1024 * 1024 },
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
