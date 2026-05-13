import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { FileStore } from "../persistence/file-store.js";
import { BUILTIN_HANDLERS } from "./builtin.js";
import { resolvePrompts } from "../core/prompts.js";
import type { SessionState, TranscriptEntry } from "../types.js";

const prompts = resolvePrompts(undefined);

function makeState(overrides?: Partial<SessionState>): SessionState {
  return {
    id: "test-session",
    status: "completed",
    skillName: "test-skill",
    startedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:01:00Z",
    iteration: 5,
    tokenUsage: { input: 100, output: 50, total: 150 },
    config: {
      model: { provider: "anthropic", model: "claude-sonnet-4-6", maxTokens: 4096 },
      session: { maxContext: 200000, checkpointInterval: 5, timeout: 21600 },
      skills: { dirs: ["./skills"] },
      persistence: { backend: "file", dir: "./sessions" },
      tools: { cli: { allowedCommands: ["echo"], timeout: 120 } },
      prompts,
    },
    ...overrides,
  };
}

describe("Built-in tools", () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-builtin-test-"));
    store = new FileStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("check_process", () => {
    it("returns not_found when no sub-process matches", async () => {
      const parent = makeState({ id: "parent" });
      await store.initSession("parent", parent);

      const result = await BUILTIN_HANDLERS.check_process.execute(
        { name: "run_build" },
        { parentSessionId: "parent", store }
      );

      expect(result).toContain("name: run_build");
      expect(result).toContain("status: not_found");
    });

    it("returns summary fields for an existing sub-process", async () => {
      const parent = makeState({ id: "parent" });
      const child = makeState({
        id: "child",
        parent_id: "parent",
        process_name: "run_build",
        skillName: "ecofin-build-local",
        status: "completed",
        iteration: 3,
        tokenUsage: { input: 1000, output: 500, total: 1500 },
      });
      await store.initSession("parent", parent);
      await store.initSession("child", child);

      // Add a tool_result transcript entry that looks like an MCP build response
      const entry: TranscriptEntry = {
        type: "tool_result",
        timestamp: "2026-01-01T00:01:00Z",
        iteration: 3,
        data: {
          content: [
            {
              content: JSON.stringify({
                status: "needs_property_review",
                session_id: "build_abc123",
                questions: [{ id: "po1" }, { id: "po2" }],
              }),
            },
          ],
        },
      };
      await store.appendTranscript("child", entry);

      const result = await BUILTIN_HANDLERS.check_process.execute(
        { name: "run_build" },
        { parentSessionId: "parent", store }
      );

      expect(result).toContain("name: run_build");
      expect(result).toContain("status: completed");
      expect(result).toContain("skill: ecofin-build-local");
      expect(result).toContain("build_status: needs_property_review");
      expect(result).toContain("mcp_session_id: build_abc123");
      expect(result).toContain("pending_questions: 2");
    });

    it("finds an earlier build_instrument response when the last tool_result is not JSON (regression)", async () => {
      // Reproduces session 1b69f5f3: stage-1 ended with a save_file call
      // whose result was just "build_xyz" (a plain string), masking the
      // earlier build_instrument response.
      const parent = makeState({ id: "parent" });
      const child = makeState({ id: "child", parent_id: "parent", process_name: "run_build" });
      await store.initSession("parent", parent);
      await store.initSession("child", child);

      // Earlier: a real build_instrument result with the build fields
      const buildEntry: TranscriptEntry = {
        type: "tool_result",
        timestamp: "2026-01-01T00:00:00Z",
        iteration: 3,
        data: {
          content: [
            {
              content: JSON.stringify({
                status: "needs_property_review",
                session_id: "build_xyz123",
                questions: [{ id: "po1" }, { id: "po2" }, { id: "po3" }],
              }),
            },
          ],
        },
      };
      // Later (last): a plain string output from save_file or similar
      const saveEntry: TranscriptEntry = {
        type: "tool_result",
        timestamp: "2026-01-01T00:01:00Z",
        iteration: 4,
        data: {
          content: [
            { content: "build_xyz123\n" },
          ],
        },
      };
      await store.appendTranscript("child", buildEntry);
      await store.appendTranscript("child", saveEntry);

      const result = await BUILTIN_HANDLERS.check_process.execute(
        { name: "run_build" },
        { parentSessionId: "parent", store }
      );

      // Despite the save_file result being last, we should still surface
      // build_status, mcp_session_id, and pending_questions from the
      // earlier build_instrument response.
      expect(result).toContain("build_status: needs_property_review");
      expect(result).toContain("mcp_session_id: build_xyz123");
      expect(result).toContain("pending_questions: 3");
    });

    it("includes object_count and saved_to when present", async () => {
      const parent = makeState({ id: "parent" });
      const child = makeState({ id: "child", parent_id: "parent", process_name: "run_build" });
      await store.initSession("parent", parent);
      await store.initSession("child", child);

      const entry: TranscriptEntry = {
        type: "tool_result",
        timestamp: "2026-01-01T00:01:00Z",
        data: {
          content: [
            {
              content: JSON.stringify({
                status: "complete",
                session_id: "build_xyz",
                summary: { object_count: 9 },
                saved_to: "/tmp/instrument.json",
              }),
            },
          ],
        },
      };
      await store.appendTranscript("child", entry);

      const result = await BUILTIN_HANDLERS.check_process.execute(
        { name: "run_build" },
        { parentSessionId: "parent", store }
      );

      expect(result).toContain("build_status: complete");
      expect(result).toContain("object_count: 9");
      expect(result).toContain("saved_to: /tmp/instrument.json");
    });

    it("requires a name argument", async () => {
      const parent = makeState({ id: "parent" });
      await store.initSession("parent", parent);

      const result = await BUILTIN_HANDLERS.check_process.execute(
        {},
        { parentSessionId: "parent", store }
      );

      expect(result).toContain("status: error");
      expect(result).toContain("name is required");
    });
  });

  describe("resume_process", () => {
    it("returns not_found when no sub-process matches", async () => {
      const parent = makeState({ id: "parent" });
      await store.initSession("parent", parent);

      const result = await BUILTIN_HANDLERS.resume_process.execute(
        { name: "missing" },
        { parentSessionId: "parent", store }
      );

      expect(result).toContain("status: not_found");
    });

    it("errors if sub-process has no config_path", async () => {
      const parent = makeState({ id: "parent" });
      const child = makeState({ id: "child", parent_id: "parent", process_name: "run_build" });
      await store.initSession("parent", parent);
      await store.initSession("child", child);

      const result = await BUILTIN_HANDLERS.resume_process.execute(
        { name: "run_build" },
        { parentSessionId: "parent", store }
      );

      expect(result).toContain("status: error");
      expect(result).toContain("no config_path");
    });
  });
});
