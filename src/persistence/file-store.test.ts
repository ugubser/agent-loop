import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { FileStore } from "./file-store.js";
import type { SessionState, TranscriptEntry, Checkpoint } from "../types.js";

function makeState(overrides?: Partial<SessionState>): SessionState {
  return {
    id: "test-session",
    status: "running",
    skillName: "test-skill",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    iteration: 0,
    tokenUsage: { input: 0, output: 0, total: 0 },
    config: {
      model: { provider: "anthropic", model: "claude-sonnet-4-6", maxTokens: 4096 },
      session: { maxContext: 200000, checkpointInterval: 5, timeout: 21600 },
      skills: { dirs: ["./skills"] },
      persistence: { backend: "file", dir: "./sessions" },
      tools: { cli: { allowedCommands: ["echo"], timeout: 120 } },
    },
    ...overrides,
  };
}

function makeEntry(type: TranscriptEntry["type"] = "message"): TranscriptEntry {
  return { type, timestamp: new Date().toISOString(), data: { text: "hello" } };
}

function makeCheckpoint(iteration: number): Checkpoint {
  return {
    sessionId: "test-session",
    iteration,
    timestamp: new Date().toISOString(),
    messages: [{ role: "user", content: "test" }],
    systemPrompt: "You are a test agent.",
    tokenUsage: { input: 100, output: 50, total: 150 },
  };
}

describe("FileStore", () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-test-"));
    store = new FileStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("initSession", () => {
    it("creates directory structure and files", async () => {
      const state = makeState();
      await store.initSession("test-session", state);

      const dir = path.join(tmpDir, "test-session");
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.existsSync(path.join(dir, "state.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "transcript.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "artifacts"))).toBe(true);
    });

    it("writes correct state", async () => {
      const state = makeState({ id: "abc" });
      await store.initSession("abc", state);
      const read = await store.readState("abc");
      expect(read.id).toBe("abc");
      expect(read.status).toBe("running");
    });
  });

  describe("transcript", () => {
    it("appends and reads entries", async () => {
      await store.initSession("test-session", makeState());
      const entry1 = makeEntry("message");
      const entry2 = makeEntry("tool_result");

      await store.appendTranscript("test-session", entry1);
      await store.appendTranscript("test-session", entry2);

      const entries = await store.readTranscript("test-session");
      expect(entries).toHaveLength(2);
      expect(entries[0].type).toBe("message");
      expect(entries[1].type).toBe("tool_result");
    });

    it("returns empty array for empty transcript", async () => {
      await store.initSession("test-session", makeState());
      const entries = await store.readTranscript("test-session");
      expect(entries).toHaveLength(0);
    });

    it("tailTranscript returns last N entries", async () => {
      await store.initSession("test-session", makeState());
      for (let i = 0; i < 10; i++) {
        await store.appendTranscript("test-session", makeEntry());
      }
      const tail = await store.tailTranscript("test-session", 3);
      expect(tail).toHaveLength(3);
    });
  });

  describe("checkpoints", () => {
    it("writes and reads checkpoint", async () => {
      await store.initSession("test-session", makeState());
      const cp = makeCheckpoint(5);
      await store.writeCheckpoint("test-session", cp);

      const read = await store.readCheckpoint("test-session");
      expect(read).not.toBeNull();
      expect(read!.iteration).toBe(5);
      expect(read!.messages).toHaveLength(1);
    });

    it("uses atomic rename (no .tmp files left)", async () => {
      await store.initSession("test-session", makeState());
      await store.writeCheckpoint("test-session", makeCheckpoint(1));

      const dir = path.join(tmpDir, "test-session");
      const files = fs.readdirSync(dir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });

    it("updates state.json lastCheckpoint", async () => {
      await store.initSession("test-session", makeState());
      await store.writeCheckpoint("test-session", makeCheckpoint(3));

      const state = await store.readState("test-session");
      expect(state.lastCheckpoint).toBe("checkpoint-00003.json");
    });

    it("reads checkpoint by name", async () => {
      await store.initSession("test-session", makeState());
      await store.writeCheckpoint("test-session", makeCheckpoint(1));
      await store.writeCheckpoint("test-session", makeCheckpoint(2));

      const cp = await store.readCheckpoint("test-session", "checkpoint-00001.json");
      expect(cp!.iteration).toBe(1);
    });

    it("returns null for missing checkpoint", async () => {
      await store.initSession("test-session", makeState());
      const cp = await store.readCheckpoint("test-session");
      expect(cp).toBeNull();
    });

    it("listCheckpoints returns sorted names", async () => {
      await store.initSession("test-session", makeState());
      await store.writeCheckpoint("test-session", makeCheckpoint(3));
      await store.writeCheckpoint("test-session", makeCheckpoint(1));
      await store.writeCheckpoint("test-session", makeCheckpoint(2));

      const list = await store.listCheckpoints("test-session");
      expect(list).toEqual([
        "checkpoint-00001.json",
        "checkpoint-00002.json",
        "checkpoint-00003.json",
      ]);
    });
  });

  describe("file locking", () => {
    it("acquires and releases lock", async () => {
      await store.initSession("test-session", makeState());
      const handle = await store.acquireLock("test-session");
      expect(handle.fd).toBeGreaterThan(0);
      await store.releaseLock(handle);
    });

    it("throws when lock already held", async () => {
      await store.initSession("test-session", makeState());
      const handle = await store.acquireLock("test-session");
      await expect(store.acquireLock("test-session")).rejects.toThrow(
        "already running"
      );
      await store.releaseLock(handle);
    });

    it("detects stale lock from dead process", async () => {
      await store.initSession("test-session", makeState());
      // Write a lock file with a PID that doesn't exist
      const lockPath = path.join(tmpDir, "test-session", "session.lock");
      fs.writeFileSync(lockPath, "999999999");

      // Should succeed because the PID is dead
      const handle = await store.acquireLock("test-session");
      await store.releaseLock(handle);
    });
  });

  describe("listSessions", () => {
    it("lists multiple sessions sorted by updatedAt", async () => {
      const s1 = makeState({ id: "s1", updatedAt: "2026-01-01T00:00:00Z" });
      const s2 = makeState({ id: "s2", updatedAt: "2026-01-02T00:00:00Z" });
      await store.initSession("s1", s1);
      await store.initSession("s2", s2);

      const sessions = await store.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe("s2"); // newer first
    });

    it("returns empty array when no sessions", async () => {
      const sessions = await store.listSessions();
      expect(sessions).toHaveLength(0);
    });
  });
});
