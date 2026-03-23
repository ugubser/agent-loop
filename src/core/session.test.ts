import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Session } from "./session.js";
import { FileStore } from "../persistence/file-store.js";
import type { AgentConfig, ProviderResponse } from "../types.js";

const testConfig: AgentConfig = {
  model: { provider: "anthropic", model: "claude-sonnet-4-6", maxTokens: 4096 },
  session: { maxContext: 200000, checkpointInterval: 5, timeout: 21600 },
  skills: { dirs: ["./skills"] },
  persistence: { backend: "file", dir: "./sessions" },
  tools: { cli: { allowedCommands: ["echo"], timeout: 120 } },
};

function mockResponse(text: string, inputTokens = 100, outputTokens = 50): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    usage: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
    stopReason: "end_turn",
  };
}

function mockToolResponse(toolId: string, toolName: string, input: Record<string, unknown>): ProviderResponse {
  return {
    content: [
      { type: "text", text: "Let me use a tool." },
      { type: "tool_use", id: toolId, name: toolName, input },
    ],
    usage: { input: 200, output: 100, total: 300 },
    stopReason: "tool_use",
  };
}

describe("Session", () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-session-"));
    store = new FileStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates a new session with running status", async () => {
      const session = await Session.create("test-skill", testConfig, store);
      expect(session.id).toBeTruthy();
      expect(session.status).toBe("running");
      expect(session.iteration).toBe(0);
      expect(session.messages).toHaveLength(0);
      expect(session.skillName).toBe("test-skill");
    });

    it("persists state to disk", async () => {
      const session = await Session.create("test-skill", testConfig, store);
      const state = await store.readState(session.id);
      expect(state.id).toBe(session.id);
      expect(state.status).toBe("running");
    });
  });

  describe("messages", () => {
    it("adds assistant message and updates token usage", async () => {
      const session = await Session.create("test-skill", testConfig, store);
      await session.addAssistantMessage(mockResponse("Hello!", 500, 200));

      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].role).toBe("assistant");
      expect(session.tokenUsage.input).toBe(500);
      expect(session.tokenUsage.output).toBe(200);
    });

    it("adds tool result", async () => {
      const session = await Session.create("test-skill", testConfig, store);
      await session.addAssistantMessage(mockToolResponse("t1", "search", { q: "test" }));
      await session.addToolResult("t1", "search results here");

      expect(session.messages).toHaveLength(2);
      expect(session.messages[1].role).toBe("user");
    });

    it("truncates large tool results", async () => {
      const session = await Session.create("test-skill", testConfig, store);
      await session.addAssistantMessage(mockToolResponse("t1", "fetch", { url: "http://example.com" }));

      const largeContent = "x".repeat(50_000);
      await session.addToolResult("t1", largeContent);

      const msg = session.messages[1];
      const block = (msg.content as Array<{ type: string; content: string }>)[0];
      expect(block.content.length).toBeLessThan(50_000);
      expect(block.content).toContain("TRUNCATED");
    });

    it("writes to transcript", async () => {
      const session = await Session.create("test-skill", testConfig, store);
      await session.addAssistantMessage(mockResponse("Hi"));

      const entries = await store.readTranscript(session.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("message");
    });
  });

  describe("status transitions", () => {
    it("transitions running → paused", async () => {
      const session = await Session.create("test-skill", testConfig, store);
      await session.setPaused("signal");
      expect(session.status).toBe("paused");
      expect(session.reason).toBe("signal");
    });

    it("transitions running → completed", async () => {
      const session = await Session.create("test-skill", testConfig, store);
      await session.setCompleted();
      expect(session.status).toBe("completed");
    });

    it("persists status change to disk", async () => {
      const session = await Session.create("test-skill", testConfig, store);
      await session.setPaused("timeout");
      const state = await store.readState(session.id);
      expect(state.status).toBe("paused");
      expect(state.reason).toBe("timeout");
    });

    it("logs status change to transcript", async () => {
      const session = await Session.create("test-skill", testConfig, store);
      await session.setCompleted();
      const entries = await store.readTranscript(session.id);
      expect(entries.some((e) => e.type === "status_change")).toBe(true);
    });
  });

  describe("checkpoint", () => {
    it("writes checkpoint on interval", async () => {
      const config = { ...testConfig, session: { ...testConfig.session, checkpointInterval: 5 } };
      const session = await Session.create("test-skill", config, store);
      session.iteration = 5;
      await session.checkpoint();

      const cp = await store.readCheckpoint(session.id);
      expect(cp).not.toBeNull();
      expect(cp!.iteration).toBe(5);
    });

    it("skips checkpoint off interval", async () => {
      const config = { ...testConfig, session: { ...testConfig.session, checkpointInterval: 5 } };
      const session = await Session.create("test-skill", config, store);
      session.iteration = 3;
      await session.checkpoint();

      const cp = await store.readCheckpoint(session.id);
      expect(cp).toBeNull();
    });

    it("forceCheckpoint always writes", async () => {
      const config = { ...testConfig, session: { ...testConfig.session, checkpointInterval: 5 } };
      const session = await Session.create("test-skill", config, store);
      session.iteration = 3;
      await session.forceCheckpoint();

      const cp = await store.readCheckpoint(session.id);
      expect(cp).not.toBeNull();
    });
  });

  describe("context budget", () => {
    it("returns ratio based on token usage", async () => {
      const config = { ...testConfig, session: { ...testConfig.session, maxContext: 1000 } };
      const session = await Session.create("test-skill", config, store);
      await session.addAssistantMessage(mockResponse("test", 700, 50));

      expect(session.contextRatio()).toBe(0.7);
    });

    it("getCompactionTarget returns soft at 70%", async () => {
      const config = { ...testConfig, session: { ...testConfig.session, maxContext: 1000 } };
      const session = await Session.create("test-skill", config, store);
      await session.addAssistantMessage(mockResponse("test", 750, 50));

      const target = session.getCompactionTarget();
      expect(target.needed).toBe("soft");
      expect(target.recentN).toBe(10);
    });

    it("getCompactionTarget returns hard at 90%", async () => {
      const config = { ...testConfig, session: { ...testConfig.session, maxContext: 1000 } };
      const session = await Session.create("test-skill", config, store);
      await session.addAssistantMessage(mockResponse("test", 950, 50));

      const target = session.getCompactionTarget();
      expect(target.needed).toBe("hard");
      expect(target.recentN).toBe(3);
    });

    it("getCompactionTarget returns none below 70%", async () => {
      const config = { ...testConfig, session: { ...testConfig.session, maxContext: 1000 } };
      const session = await Session.create("test-skill", config, store);
      await session.addAssistantMessage(mockResponse("test", 500, 50));

      expect(session.getCompactionTarget().needed).toBe("none");
    });
  });

  describe("termination checks", () => {
    it("isTimedOut returns false for fresh session", async () => {
      const session = await Session.create("test-skill", testConfig, store);
      expect(session.isTimedOut()).toBe(false);
    });

    it("isMaxSteps returns false when no max set", async () => {
      const session = await Session.create("test-skill", testConfig, store);
      session.iteration = 1000;
      expect(session.isMaxSteps()).toBe(false);
    });

    it("isMaxSteps returns true when exceeded", async () => {
      const config = { ...testConfig, session: { ...testConfig.session, maxSteps: 10 } };
      const session = await Session.create("test-skill", config, store);
      session.iteration = 10;
      expect(session.isMaxSteps()).toBe(true);
    });
  });

  describe("resume", () => {
    it("detects crashed session", async () => {
      const session = await Session.create("test-skill", testConfig, store);
      // State is "running" — simulates a crash
      const resumed = await Session.resume(session.id, store);
      expect(resumed.status).toBe("crashed");
      expect(resumed.reason).toBe("process_died");
    });

    it("restores messages from checkpoint", async () => {
      const session = await Session.create("test-skill", testConfig, store);
      session.systemPrompt = "You are a test agent.";
      await session.addAssistantMessage(mockResponse("Hello"));
      session.iteration = 5;
      await session.forceCheckpoint();

      // Simulate crash and resume
      const resumed = await Session.resume(session.id, store);
      expect(resumed.messages).toHaveLength(1);
      expect(resumed.systemPrompt).toBe("You are a test agent.");
    });
  });

  describe("replaceMessages", () => {
    it("replaces message array for compaction", async () => {
      const session = await Session.create("test-skill", testConfig, store);
      await session.addAssistantMessage(mockResponse("msg1"));
      await session.addAssistantMessage(mockResponse("msg2"));
      expect(session.messages).toHaveLength(2);

      session.replaceMessages([{ role: "user", content: "summary" }]);
      expect(session.messages).toHaveLength(1);
    });
  });
});
