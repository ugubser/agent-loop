import { randomUUID } from "node:crypto";
import type {
  SessionState,
  SessionStatus,
  AgentConfig,
  Message,
  ContentBlock,
  ToolResultBlock,
  TranscriptEntry,
  Checkpoint,
  TokenUsage,
  ProviderResponse,
} from "../types.js";
import type { FileStore } from "../persistence/file-store.js";

const DEFAULT_TOOL_RESULT_MAX_CHARS = 100_000; // ~25,000 tokens at 4 chars/token
const TRUNCATION_MARKER = "\n\n[TRUNCATED — result exceeded size limit]";

export class Session {
  private _messages: Message[] = [];
  private _systemPrompt = "";
  private _state: SessionState;
  private store: FileStore;

  private constructor(state: SessionState, store: FileStore) {
    this._state = state;
    this.store = store;
  }

  // --- Factory methods ---

  static async create(
    skillName: string,
    config: AgentConfig,
    store: FileStore
  ): Promise<Session> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const state: SessionState = {
      id,
      status: "running",
      skillName,
      startedAt: now,
      updatedAt: now,
      iteration: 0,
      tokenUsage: { input: 0, output: 0, total: 0 },
      config,
    };
    await store.initSession(id, state);
    return new Session(state, store);
  }

  static async resume(id: string, store: FileStore): Promise<Session> {
    const state = await store.readState(id);

    // Detect crash: if status is "running" but we're resuming, the process died
    if (state.status === "running") {
      state.status = "crashed";
      state.reason = "process_died";
    }

    const session = new Session(state, store);

    // Load from checkpoint
    const checkpoint = await store.readCheckpoint(id);
    if (checkpoint) {
      session._messages = checkpoint.messages;
      session._systemPrompt = checkpoint.systemPrompt;
      session._state.tokenUsage = checkpoint.tokenUsage;

      // Replay transcript entries after checkpoint
      const transcript = await store.readTranscript(id);
      const cpTimestamp = new Date(checkpoint.timestamp).getTime();
      for (const entry of transcript) {
        const entryTime = new Date(entry.timestamp).getTime();
        if (entryTime <= cpTimestamp) continue;
        if (entry.type === "message" && entry.data) {
          session._messages.push(entry.data as Message);
        }
      }
    } else {
      // No checkpoint — replay entire transcript
      const transcript = await store.readTranscript(id);
      for (const entry of transcript) {
        if (entry.type === "message" && entry.data) {
          session._messages.push(entry.data as Message);
        }
      }
    }

    return session;
  }

  // --- Accessors ---

  get id(): string {
    return this._state.id;
  }

  get status(): SessionStatus {
    return this._state.status;
  }

  get reason(): string | undefined {
    return this._state.reason;
  }

  get iteration(): number {
    return this._state.iteration;
  }

  set iteration(n: number) {
    this._state.iteration = n;
  }

  get skillName(): string {
    return this._state.skillName;
  }

  get config(): AgentConfig {
    return this._state.config;
  }

  get tokenUsage(): TokenUsage {
    return this._state.tokenUsage;
  }

  get state(): SessionState {
    return this._state;
  }

  get messages(): Message[] {
    return this._messages;
  }

  get systemPrompt(): string {
    return this._systemPrompt;
  }

  set systemPrompt(prompt: string) {
    this._systemPrompt = prompt;
  }

  // --- Message management ---

  async addAssistantMessage(response: ProviderResponse): Promise<void> {
    const msg: Message = { role: "assistant", content: response.content };
    this._messages.push(msg);

    // Accumulate token usage across all API calls
    this._state.tokenUsage = {
      input: this._state.tokenUsage.input + response.usage.input,
      output: this._state.tokenUsage.output + response.usage.output,
      total: this._state.tokenUsage.total + response.usage.input + response.usage.output,
    };

    const result = await this.store.appendTranscript(this._state.id, {
      type: "message",
      timestamp: new Date().toISOString(),
      iteration: this._state.iteration,
      data: msg,
    });

    if (result.error === "disk_full") {
      await this.setPaused("disk_full");
      throw new Error("Disk full — session paused");
    }
  }

  async addToolResult(
    toolUseId: string,
    content: string,
    isError = false
  ): Promise<void> {
    // Truncate large results
    const maxChars = this._state.config.tools?.cli?.maxResultChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
    let truncated = content;
    if (content.length > maxChars) {
      truncated =
        content.slice(0, maxChars) + TRUNCATION_MARKER;
    }

    const block: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: truncated,
      is_error: isError || undefined,
    };

    // Tool results are appended as a user message with tool_result content
    const msg: Message = { role: "user", content: [block] };
    this._messages.push(msg);

    const result = await this.store.appendTranscript(this._state.id, {
      type: "tool_result",
      timestamp: new Date().toISOString(),
      iteration: this._state.iteration,
      data: msg,
    });

    if (result.error === "disk_full") {
      await this.setPaused("disk_full");
      throw new Error("Disk full — session paused");
    }
  }

  // --- Checkpoint ---

  async checkpoint(): Promise<void> {
    const interval = this._state.config.session.checkpointInterval;
    if (this._state.iteration % interval !== 0 && this._state.iteration !== 0) {
      return; // Skip — not on interval
    }

    const cp: Checkpoint = {
      sessionId: this._state.id,
      iteration: this._state.iteration,
      timestamp: new Date().toISOString(),
      messages: [...this._messages],
      systemPrompt: this._systemPrompt,
      tokenUsage: { ...this._state.tokenUsage },
    };
    await this.store.writeCheckpoint(this._state.id, cp);
  }

  async forceCheckpoint(): Promise<void> {
    const cp: Checkpoint = {
      sessionId: this._state.id,
      iteration: this._state.iteration,
      timestamp: new Date().toISOString(),
      messages: [...this._messages],
      systemPrompt: this._systemPrompt,
      tokenUsage: { ...this._state.tokenUsage },
    };
    await this.store.writeCheckpoint(this._state.id, cp);
  }

  // --- Status transitions ---

  async setRunning(): Promise<void> {
    this._state.status = "running";
    this._state.reason = undefined;
    this._state.updatedAt = new Date().toISOString();
    await this.store.writeState(this._state.id, this._state);
    await this.store.appendTranscript(this._state.id, {
      type: "status_change",
      timestamp: this._state.updatedAt,
      data: { status: "running" },
    });
  }

  async setPaused(reason?: string): Promise<void> {
    this._state.status = "paused";
    this._state.reason = reason;
    this._state.updatedAt = new Date().toISOString();
    await this.store.writeState(this._state.id, this._state);
    await this.store.appendTranscript(this._state.id, {
      type: "status_change",
      timestamp: this._state.updatedAt,
      data: { status: "paused", reason },
    });
  }

  async setCompleted(): Promise<void> {
    this._state.status = "completed";
    this._state.reason = undefined;
    this._state.updatedAt = new Date().toISOString();
    await this.store.writeState(this._state.id, this._state);
    await this.store.appendTranscript(this._state.id, {
      type: "status_change",
      timestamp: this._state.updatedAt,
      data: { status: "completed" },
    });
  }

  // --- Context budget ---

  contextTokens(): number {
    // Always estimate from current messages — API usage becomes stale after
    // compaction or context trimming removes messages.
    return this.estimateTokens();
  }

  private estimateTokens(): number {
    let chars = this._systemPrompt.length;
    for (const msg of this._messages) {
      if (typeof msg.content === "string") {
        chars += msg.content.length;
      } else {
        for (const block of msg.content) {
          if (block.type === "text") chars += block.text.length;
          else if (block.type === "tool_result") chars += block.content.length;
          else if (block.type === "tool_use")
            chars += JSON.stringify(block.input).length;
        }
      }
    }
    return Math.ceil(chars / 4);
  }

  contextRatio(): number {
    return this.contextTokens() / this._state.config.session.maxContext;
  }

  getCompactionTarget(): {
    needed: "none" | "soft" | "hard";
    recentN: number;
  } {
    const ratio = this.contextRatio();
    if (ratio >= 0.9) return { needed: "hard", recentN: 3 };
    if (ratio >= 0.7) return { needed: "soft", recentN: 10 };
    return { needed: "none", recentN: 10 };
  }

  // --- Compaction support ---

  replaceMessages(newMessages: Message[]): void {
    this._messages = newMessages;
  }

  // --- Termination checks ---

  isTimedOut(): boolean {
    const elapsed =
      (Date.now() - new Date(this._state.startedAt).getTime()) / 1000;
    return elapsed >= this._state.config.session.timeout;
  }

  isMaxSteps(): boolean {
    const max = this._state.config.session.maxSteps;
    if (!max) return false;
    return this._state.iteration >= max;
  }

  isTokenBudgetExhausted(): boolean {
    const max = this._state.config.session.maxTotalTokens;
    if (!max) return false;
    return this._state.tokenUsage.input >= max;
  }

  isTokenBudgetWarning(): boolean {
    const max = this._state.config.session.maxTotalTokens;
    if (!max) return false;
    return this._state.tokenUsage.input >= max * 0.8;
  }
}
