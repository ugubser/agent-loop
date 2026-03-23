# agent-loop

Pluggable durable agent runtime — long-running LLM agents with checkpoint/resume, CLI tool execution, and markdown skill definitions.

## What is this?

An autonomous agent that can run for hours, survive crashes, and resume exactly where it left off. No database, no message queue, no Kubernetes — just a binary, a config file, and a directory of checkpoints.

```
agent-loop run research --task "Research the history of TypeScript"
```

The agent searches the web, reads pages, synthesizes findings, and writes a report — autonomously. If the process crashes mid-run, `agent-loop resume <session-id>` picks up from the last checkpoint.

## Features

- **Durable checkpointing** — JSONL transcript + atomic checkpoint snapshots. Survives crashes.
- **CLI tool execution** — Any command-line tool becomes an agent tool. Secure: `execFile` (no shell), command whitelist, timeout enforcement.
- **Markdown skills** — Define agent capabilities in markdown files with YAML frontmatter. No code required.
- **Context compaction** — Dual-threshold auto-summarization (70% soft, 90% hard) enables runs that exceed a single context window.
- **Session management** — List, inspect, tail, and resume sessions.

## Quick Start

```bash
# Install dependencies
bun install

# Set your API key
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# Run the research agent
bun run src/cli.ts run research --task "Research how Temporal handles durable execution"

# In another terminal, watch the session
bun run src/cli.ts tail <session-id>
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `agent-loop run <skill> [--task "..."]` | Start a new agent session |
| `agent-loop resume <session-id>` | Resume a paused or crashed session |
| `agent-loop list` | List all sessions with status |
| `agent-loop status <session-id>` | Show detailed session info |
| `agent-loop tail <session-id>` | Stream transcript in real-time |
| `agent-loop inspect <session-id>` | Show latest checkpoint contents |

## Creating Skills

Add a `.md` file to `skills/`:

```markdown
---
name: my-skill
description: What this skill does
tools:
  - name: search
    description: Search the web
    command: curl
    args: ["-s", "https://api.example.com/q=${query}"]
    schema:
      query: { type: "string", description: "Search query" }
    timeout: 30
    idempotent: true
---

## Instructions

Tell the agent what to do with these tools.
```

Then run it: `bun run src/cli.ts run my-skill --task "Do the thing"`

### Tool Definition

| Field | Description |
|-------|-------------|
| `name` | Tool name the LLM calls |
| `description` | What the tool does (shown to the LLM) |
| `command` | CLI command (must be in `allowedCommands` config) |
| `args` | Argument array with `${param}` placeholders |
| `schema` | Parameter definitions (type + description) |
| `timeout` | Seconds before the tool is killed |
| `idempotent` | Whether re-execution on crash recovery is safe |

## Configuration

Edit `config.yaml`:

```yaml
model:
  provider: anthropic
  model: claude-sonnet-4-6
  maxTokens: 8192

session:
  maxContext: 200000        # Tokens before compaction triggers
  checkpointInterval: 5    # Checkpoint every N iterations
  timeout: 21600            # Max run time in seconds (6 hours)

tools:
  cli:
    allowedCommands:        # Whitelist of CLI commands
      - curl
      - jq
      - grep
      - python3
    timeout: 120            # Default tool timeout (seconds)
```

## Architecture

```
src/
├── core/
│   ├── loop.ts           # Agentic loop + signal handling
│   ├── session.ts        # State machine, token tracking, checkpointing
│   └── compaction.ts     # Dual-threshold context compaction
├── tools/
│   └── cli.ts            # CLI tool executor with security model
├── skills/
│   └── loader.ts         # Markdown skill parser
├── persistence/
│   └── file-store.ts     # JSONL transcript, atomic checkpoints, file locking
├── providers/
│   └── anthropic.ts      # Thin @anthropic-ai/sdk wrapper
├── types.ts              # Shared type definitions
└── cli.ts                # Commander-based CLI
```

**Core loop:** `model call → tool execution → checkpoint → repeat` until the model returns text with no tool calls.

**Durability:** Every message is fsync'd to a JSONL transcript. Checkpoints (full state snapshots) are written every N iterations via atomic rename. On crash, resume replays transcript entries after the last checkpoint.

**Security:** CLI tools run via `execFile` (no shell interpolation). Commands must be in the whitelist. Arguments are passed as arrays. Template placeholders are expanded with URL encoding.

## Testing

```bash
bun test              # 84 tests — unit + integration
bun test --watch      # Watch mode
```

## License

MIT
