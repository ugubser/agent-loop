import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import type { SkillDef, SkillSummary, CliToolDef } from "../types.js";

export async function loadSkill(skillPath: string): Promise<SkillDef> {
  const raw = fs.readFileSync(skillPath, "utf-8");
  const { data, content } = matter(raw);

  if (!data.name) {
    throw new Error(`Skill at ${skillPath} is missing required 'name' field`);
  }

  // Skill-level env vars are inherited by all tools
  const skillEnv = (data.env as Record<string, string>) ?? {};

  const tools: CliToolDef[] = [];
  if (Array.isArray(data.tools)) {
    for (const t of data.tools) {
      const toolEnv = { ...skillEnv, ...(t.env ?? {}) };
      tools.push({
        name: t.name,
        description: t.description ?? `Tool: ${t.name}`,
        command: t.command,
        args: t.args ?? [],
        schema: parseSchema(t.schema ?? {}),
        stdinParam: t.stdinParam,
        env: Object.keys(toolEnv).length > 0 ? toolEnv : undefined,
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

const ROUTER_IDENTITY = `You are an autonomous agent with access to multiple skills. Each skill provides a set of tools for a specific domain.

To start working, call the use_skill tool with the skill that best matches the task. You can switch skills at any time by calling use_skill again.

Rules:
- Pick the most appropriate skill for the task
- If the task spans multiple domains, start with the primary skill and switch as needed
- Be systematic and thorough
- After each action, reflect on what you learned
- If a tool fails, try a different approach
- When the task is complete, provide a final summary`;

export async function loadSkillSummaries(
  dirs: string[]
): Promise<SkillSummary[]> {
  const skillMap = await discoverSkills(dirs);
  const summaries: SkillSummary[] = [];

  for (const [name, filePath] of skillMap) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const { data } = matter(raw);
      summaries.push({
        name,
        description: (data.description as string) ?? "",
      });
    } catch {
      summaries.push({ name, description: "" });
    }
  }

  return summaries;
}

export function buildRouterPrompt(parts: {
  skills: SkillSummary[];
  task?: string;
}): string {
  const sections = [ROUTER_IDENTITY];

  sections.push("\n## Available Skills\n");
  for (const skill of parts.skills) {
    sections.push(`- **${skill.name}**: ${skill.description}`);
  }

  if (parts.task) {
    sections.push(`\n## Task\n\n${parts.task}`);
  }

  return sections.join("\n");
}

export function buildSystemPrompt(parts: {
  skill: SkillDef;
  task?: string;
  availableSkills?: SkillSummary[];
}): string {
  const sections = [BASE_IDENTITY];

  if (parts.availableSkills?.length) {
    sections.push("\n## Available Skills (use use_skill to switch)\n");
    for (const s of parts.availableSkills) {
      sections.push(`- **${s.name}**: ${s.description}`);
    }
  }

  sections.push(`\n## Active Skill: ${parts.skill.name}\n\n${parts.skill.instructions}`);

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
