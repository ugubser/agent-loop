import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadSkill, discoverSkills, buildSystemPrompt } from "./loader.js";

const VALID_SKILL = `---
name: test-search
description: Search the web
tools:
  - name: search
    command: curl
    args: ["-s", "https://api.com/q=\${query}"]
    schema:
      query: { type: "string", description: "Search query" }
    timeout: 30
    idempotent: true
  - name: fetch
    command: curl
    args: ["-s", "\${url}"]
    schema:
      url: { type: "string", description: "URL to fetch" }
    timeout: 60
---

## Instructions
Search for information using the search tool, then fetch pages.
`;

const MINIMAL_SKILL = `---
name: minimal
---

Just follow instructions.
`;

const INVALID_SKILL = `---
description: Missing name field
---

No name here.
`;

describe("loadSkill", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-skill-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses valid skill with tools", async () => {
    const p = path.join(tmpDir, "search.md");
    fs.writeFileSync(p, VALID_SKILL);
    const skill = await loadSkill(p);

    expect(skill.name).toBe("test-search");
    expect(skill.description).toBe("Search the web");
    expect(skill.tools).toHaveLength(2);
    expect(skill.tools[0].name).toBe("search");
    expect(skill.tools[0].command).toBe("curl");
    expect(skill.tools[0].timeout).toBe(30);
    expect(skill.tools[0].idempotent).toBe(true);
    expect(skill.tools[0].schema.query.type).toBe("string");
    expect(skill.instructions).toContain("Search for information");
  });

  it("parses minimal skill with no tools", async () => {
    const p = path.join(tmpDir, "minimal.md");
    fs.writeFileSync(p, MINIMAL_SKILL);
    const skill = await loadSkill(p);

    expect(skill.name).toBe("minimal");
    expect(skill.tools).toHaveLength(0);
    expect(skill.instructions).toContain("Just follow instructions");
  });

  it("throws for skill missing name", async () => {
    const p = path.join(tmpDir, "invalid.md");
    fs.writeFileSync(p, INVALID_SKILL);
    await expect(loadSkill(p)).rejects.toThrow("missing required 'name'");
  });
});

describe("discoverSkills", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-discover-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("discovers .md files with name in frontmatter", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.md"), VALID_SKILL);
    fs.writeFileSync(path.join(tmpDir, "b.md"), MINIMAL_SKILL);
    fs.writeFileSync(path.join(tmpDir, "not-a-skill.txt"), "hello");

    const skills = await discoverSkills([tmpDir]);
    expect(skills.size).toBe(2);
    expect(skills.has("test-search")).toBe(true);
    expect(skills.has("minimal")).toBe(true);
  });

  it("skips non-existent directories", async () => {
    const skills = await discoverSkills(["/nonexistent/path"]);
    expect(skills.size).toBe(0);
  });

  it("skips unparseable files", async () => {
    fs.writeFileSync(path.join(tmpDir, "bad.md"), "not valid frontmatter {{{");
    const skills = await discoverSkills([tmpDir]);
    // gray-matter may still parse it, just no frontmatter data
    // The important thing is it doesn't throw
    expect(skills.size).toBe(0);
  });
});

describe("buildSystemPrompt", () => {
  it("builds 3-part prompt", () => {
    const prompt = buildSystemPrompt({
      skill: {
        name: "research",
        description: "Research agent",
        instructions: "Search the web and synthesize.",
        tools: [],
      },
      task: "Research TypeScript history",
    });

    expect(prompt).toContain("autonomous agent");
    expect(prompt).toContain("## Skill: research");
    expect(prompt).toContain("Search the web and synthesize.");
    expect(prompt).toContain("## Task");
    expect(prompt).toContain("Research TypeScript history");
  });

  it("works without task", () => {
    const prompt = buildSystemPrompt({
      skill: {
        name: "test",
        description: "",
        instructions: "Do stuff.",
        tools: [],
      },
    });

    expect(prompt).toContain("## Skill: test");
    expect(prompt).not.toContain("## Task");
  });
});
