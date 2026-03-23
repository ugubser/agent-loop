import * as fs from "node:fs";
import * as path from "node:path";
import type {
  SessionState,
  TranscriptEntry,
  Checkpoint,
  LockHandle,
} from "../types.js";

export class FileStore {
  constructor(private baseDir: string) {}

  private sessionDir(id: string): string {
    return path.join(this.baseDir, id);
  }

  private statePath(id: string): string {
    return path.join(this.sessionDir(id), "state.json");
  }

  private transcriptPath(id: string): string {
    return path.join(this.sessionDir(id), "transcript.jsonl");
  }

  private lockPath(id: string): string {
    return path.join(this.sessionDir(id), "session.lock");
  }

  // --- Session directory management ---

  async initSession(id: string, state: SessionState): Promise<void> {
    const dir = this.sessionDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    this.writeStateSync(id, state);
    fs.writeFileSync(this.transcriptPath(id), "");
  }

  // --- State ---

  async readState(id: string): Promise<SessionState> {
    const raw = fs.readFileSync(this.statePath(id), "utf-8");
    return JSON.parse(raw) as SessionState;
  }

  async writeState(id: string, state: SessionState): Promise<void> {
    this.writeStateSync(id, state);
  }

  private writeStateSync(id: string, state: SessionState): void {
    const p = this.statePath(id);
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, p);
  }

  // --- Transcript (append-only JSONL) ---

  async appendTranscript(
    id: string,
    entry: TranscriptEntry
  ): Promise<{ error?: string }> {
    const line = JSON.stringify(entry) + "\n";
    try {
      const fd = fs.openSync(this.transcriptPath(id), "a");
      try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return {};
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOSPC") {
        return { error: "disk_full" };
      }
      throw err;
    }
  }

  async readTranscript(id: string): Promise<TranscriptEntry[]> {
    const raw = fs.readFileSync(this.transcriptPath(id), "utf-8");
    if (!raw.trim()) return [];
    return raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TranscriptEntry);
  }

  async tailTranscript(id: string, n: number): Promise<TranscriptEntry[]> {
    const entries = await this.readTranscript(id);
    return entries.slice(-n);
  }

  // --- Checkpoints (atomic rename) ---

  async writeCheckpoint(id: string, checkpoint: Checkpoint): Promise<void> {
    const name = `checkpoint-${String(checkpoint.iteration).padStart(5, "0")}.json`;
    const dir = this.sessionDir(id);
    const filePath = path.join(dir, name);
    const tmp = filePath + ".tmp";

    fs.writeFileSync(tmp, JSON.stringify(checkpoint, null, 2));
    fs.renameSync(tmp, filePath);

    // Update state.json with lastCheckpoint
    const state = await this.readState(id);
    state.lastCheckpoint = name;
    state.updatedAt = new Date().toISOString();
    await this.writeState(id, state);
  }

  async readCheckpoint(id: string, name?: string): Promise<Checkpoint | null> {
    try {
      if (!name) {
        const state = await this.readState(id);
        name = state.lastCheckpoint;
        if (!name) return null;
      }
      const filePath = path.join(this.sessionDir(id), name);
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as Checkpoint;
    } catch {
      return null;
    }
  }

  async listCheckpoints(id: string): Promise<string[]> {
    const dir = this.sessionDir(id);
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.startsWith("checkpoint-") && f.endsWith(".json"))
        .sort();
    } catch {
      return [];
    }
  }

  // --- File locking (OS advisory lock via O_EXCL) ---

  async acquireLock(id: string): Promise<LockHandle> {
    const lockFile = this.lockPath(id);

    // Check for stale lock
    try {
      const existing = fs.readFileSync(lockFile, "utf-8").trim();
      const pid = parseInt(existing, 10);
      if (pid && !isProcessAlive(pid)) {
        // Stale lock — process died, remove it
        fs.unlinkSync(lockFile);
      }
    } catch {
      // Lock file doesn't exist — good
    }

    try {
      const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      fs.writeSync(fd, String(process.pid));
      fs.fsyncSync(fd);
      return { fd, path: lockFile };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new Error(`Session ${id} is already running (lock held)`);
      }
      throw err;
    }
  }

  async releaseLock(handle: LockHandle): Promise<void> {
    try {
      fs.closeSync(handle.fd);
    } catch {
      // fd may already be closed
    }
    try {
      fs.unlinkSync(handle.path);
    } catch {
      // lock file may already be removed
    }
  }

  // --- Session listing ---

  async listSessions(): Promise<SessionState[]> {
    try {
      const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
      const sessions: SessionState[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const state = await this.readState(entry.name);
          sessions.push(state);
        } catch {
          // Skip directories that aren't valid sessions
        }
      }
      return sessions.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    } catch {
      return [];
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
