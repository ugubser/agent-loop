import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import type { SkillDef, CliToolDef } from "../types.js";

export async function loadSkill(skillPath: string): Promise<SkillDef> {
  const raw = fs.readFileSync(skillPath, "utf-8");
  const { data, content } = matter(raw);

  if (!data.name) {
    throw new Error(`Skill at ${skillPath} is missing required 'name' field`);
  }

  const tools: CliToolDef[] = [];
  if (Array.isArray(data.tools)) {
    for (const t of data.tools) {
      tools.push({
        name: t.name,
        description: t.description ?? `Tool: ${t.name}`,
        command: t.command,
        args: t.args ?? [],
        schema: parseSchema(t.schema ?? {}),
        stdinParam: t.stdinParam,
        timeout: parseTimeout(t.timeout),
        idempotent: t.idempotent ?? true,
      });
    }
  }

  return {
    name: data.name,
    description: data.description ?? "",
    instructions: content.trim(),
    tools,
  };
}

export async function discoverSkills(
  dirs: string[]
): Promise<Map<string, string>> {
  const skills = new Map<string, string>();

  for (const dir of dirs) {
    const resolved = dir.startsWith("~")
      ? path.join(process.env.HOME ?? "", dir.slice(1))
      : dir;

    if (!fs.existsSync(resolved)) continue;

    const files = fs.readdirSync(resolved).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      try {
        const filePath = path.join(resolved, file);
        const raw = fs.readFileSync(filePath, "utf-8");
        const { data } = matter(raw);
        if (data.name) {
          skills.set(data.name, filePath);
        }
      } catch {
        // Skip unparseable files
      }
    }
  }

  return skills;
}

const BASE_IDENTITY = `You are an autonomous agent running in a long-running loop. You have access to tools defined by your skill. Use them to accomplish the task.

Rules:
- Be systematic and thorough
- After each action, reflect on what you learned
- If a tool fails, try a different approach
- Summarize your progress periodically
- When the task is complete, provide a final summary`;

export function buildSystemPrompt(parts: {
  skill: SkillDef;
  task?: string;
}): string {
  const sections = [BASE_IDENTITY];

  sections.push(`\n## Skill: ${parts.skill.name}\n\n${parts.skill.instructions}`);

  if (parts.task) {
    sections.push(`\n## Task\n\n${parts.task}`);
  }

  return sections.join("\n");
}

function parseSchema(
  raw: Record<string, unknown>
): Record<string, { type: string; description?: string }> {
  const schema: Record<string, { type: string; description?: string }> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "object" && value !== null) {
      const v = value as Record<string, unknown>;
      schema[key] = {
        type: (v.type as string) ?? "string",
        description: v.description as string | undefined,
      };
    } else {
      schema[key] = { type: "string" };
    }
  }
  return schema;
}

function parseTimeout(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    return isNaN(n) ? 120 : n;
  }
  return 120;
}
