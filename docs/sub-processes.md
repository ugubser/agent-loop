# Sub-Process Sessions — Design

Status: draft  
Owner: agent-loop core + audit UI  
Scope: agent-loop runtime + skill API + audit UI. No external repo changes required.

## 1. Problem

A skill in agent-loop can spawn another agent-loop session via a CLI tool
that runs `bun src/cli.ts run …`. Today, agent-loop has no idea this is
happening — the spawned process is just an opaque subprocess. Skills that
orchestrate sub-builds (e.g. `ecofin-orchestrator`,
`ecofin-orchestrator-multi`) therefore have to:

1. Parse the sub-process's stdout to extract its agent-loop session
   UUID.
2. Pass that UUID back to the LLM in tool results.
3. Have the LLM re-emit the UUID as an argument to follow-up tools
   (`check_session`, `read_transcript`, `resume_session`).

This routes a 36-character infrastructure identifier through the LLM's
context, which produces:

- **Transcription errors.** Long hex UUIDs are easy for an LLM to
  mis-copy (we've seen `cecbf661-…` written back as `cec6bf661-…`).
- **Wrong-session bugs.** A stage-2 result can be verified against
  stage-1's stale session ID, producing apparent failures.
- **Cross-config corruption risk.** An LLM that confuses stage IDs can
  resume one stage's session under another stage's config, which mixes
  incompatible skill+model state.
- **Skill-side bash growth.** The only pure-skill workaround is more
  bash wrappers and tag files, duplicated in every multi-process skill.

The right home for this concern is agent-loop itself: it already knows
when one of its tool calls spawns another `agent-loop run`. It can record
that relationship, expose first-class introspection tools that operate
on named sub-processes of the calling session, and surface the
relationship in the audit UI.

## 2. Goals

- A skill can introspect and resume the calling session's sub-processes
  **without** the LLM ever seeing an agent-loop session UUID.
- Sub-processes are addressable by **name** (e.g. `run_build`,
  `run_build_redacted`), not by UUID and not by "latest". Names come
  from the dispatching tool's own name — no LLM-supplied identifiers.
- The audit UI shows parent-process relationships explicitly.
- Zero new state files in skill land — agent-loop owns parent-process
  tracking via existing `state.json`.
- Backwards compatible: existing skills that wrap `check_session.ts`
  etc. continue to work unchanged. Opt-in for the new built-ins.

## 3. Non-goals (v1)

- Parallel sub-processes. The current orchestrators block on each
  dispatch sequentially. Concurrent fan-out is Phase 2 (the design
  accommodates it — multiple distinct process names can coexist — but
  the semantics of "all sub-processes running at once" introspection
  are deferred).
- Multi-hop introspection ("my sub-process's sub-process"). Out of
  scope.
- Replacing the MCP `build_id` concept. The MCP server keeps its own
  session identifiers; this feature only deals with agent-loop sessions.

## 4. Design

### 4.1 Data model

Add two optional fields to `SessionState` (`src/types.ts`):

```typescript
export interface SessionState {
  // existing fields …
  parent_id?: string;       // UUID of the parent agent-loop session
  process_name?: string;    // the dispatching tool's name — used as the
                            // logical handle by which the parent refers
                            // to this sub-process (e.g. "run_build",
                            // "run_build_redacted")
}
```

Persisted to `state.json` on every checkpoint write. Both are absent
for top-level sessions (the user's direct invocation).

### 4.2 Parent linkage and naming at sub-process start

When a sub-process session starts, it picks up two pieces of context
from the parent:

1. `parent_id` — the parent session's UUID.
2. `process_name` — the name of the tool, in the parent's skill, that
   spawned this sub-process. **The LLM doesn't supply this**; the tool
   executor injects it automatically.

Both are propagated via environment variables that the spawned CLI
picks up:

- `AGENT_LOOP_PARENT_SESSION=<uuid>`
- `AGENT_LOOP_PROCESS_NAME=<tool_name>`

When agent-loop **executes a CLI tool** (`src/tools/cli.ts`), it extends
the child process's environment with both variables, valued from the
currently running session's UUID and the executing tool's name.

When agent-loop **starts a new session** via `bun src/cli.ts run …`
or `bun src/cli.ts resume …`, it checks the environment (or explicit
CLI flags) and writes the values into `state.parent_id` /
`state.process_name` on the new session.

Explicit CLI flags exist as overrides (mainly for tests):
```
bun src/cli.ts run <skill> --config <file> --task "<text>"
  [--parent <uuid>] [--process-name <name>]
```

Resolution order for each: explicit flag → env var → undefined.

### 4.3 Sub-process lookup

New methods on `FileStore` (`src/persistence/file-store.ts`):

```typescript
listSubProcesses(parentId: string): Promise<SessionState[]>
findSubProcessByName(parentId: string, processName: string): Promise<SessionState | null>
```

Implementation: walk `sessions/`, read each `state.json`, filter where
`state.parent_id === parentId`. For `findSubProcessByName`,
additionally filter on `process_name`, sort by `startedAt` descending,
return the most recent match (so re-dispatching the same name picks up
the latest attempt — older same-named sub-processes remain on disk but
aren't returned).

### 4.4 Built-in tools

Skills opt in to agent-loop-provided built-in tools by adding a
`builtins:` array in the YAML frontmatter alongside the existing
`tools:` array:

```yaml
---
name: my-orchestrator
description: …
tools:
  - name: run_build
    command: bash
    # … existing CLI tool def — dispatches a sub-process
  - name: run_build_redacted
    command: bash
    # … existing CLI tool def — dispatches another sub-process
builtins:
  - check_process
  - resume_process
---
```

Built-in tools have **no `command` / `args` / `schema`** in the YAML.
Agent-loop registers each with its canonical schema and dispatches it
internally.

Loader change (`src/skills/loader.ts`): parse the `builtins:` array and
attach a `kind: "builtin"` tool definition to the skill's tool list,
pulling the schema and handler from a built-in registry.

Executor change: when a tool of `kind: "builtin"` fires, route to the
registry (a new `src/tools/builtin.ts`) instead of invoking a CLI
command.

### 4.5 Built-in tool catalog (v1)

Two tools, each takes one required arg: the sub-process's name.

#### `check_process(name)`

Returns a structured summary of the sub-process of the calling session
whose `process_name` matches `name`. If multiple exist (re-dispatched),
the most recent one. No agent-loop UUIDs in the response.

Schema (input):
```json
{ "name": "string — the dispatching tool's name (e.g. 'run_build')" }
```

Response (text body, one `key: value` per line):
```
name: <process_name>
status: <running|completed|paused|crashed>
reason: <string>                       # only if status != running
skill: <skill name>
iteration: <int>
tokens: <int>
build_status: <complete|complete_with_warnings|needs_input|needs_property_review|none>
pending_questions: <int>               # if known
object_count: <int>                    # if known
saved_to: <absolute path>              # if known
last_tool_result: <truncated string>   # tail of the sub-process's transcript, last tool_result.content truncated to ~500 chars
mcp_session_id: <string>               # if a `session_id` field is present in the latest tool_result's JSON
```

The `mcp_session_id` extraction is generic: agent-loop parses the
latest tool_result's content as JSON and looks for a top-level
`session_id` field. This is universal across MCP tools that maintain
server-side session state, with no ecofin-specific knowledge.

Error mode: if no sub-process with that name exists, the tool returns
`status: not_found name: <name>` and the orchestrator's LLM decides
what to do (typically: report that no such dispatch occurred).

#### `resume_process(name)`

Resumes the named sub-process under its **own** original config.
Synchronous — blocks until the resumed sub-process exits. Returns the
same response shape as `check_process` (post-resume state).

Schema (input):
```json
{ "name": "string — the dispatching tool's name to resume" }
```

Implementation: find the named sub-process via
`findSubProcessByName(currentId, name)`, look up its config from the
sub-process's `state.json`, then `execFile("bun", ["run", "src/cli.ts",
"resume", subprocess.id, "--config", subprocess.config_path], { env:
…including AGENT_LOOP_PARENT_SESSION / AGENT_LOOP_PROCESS_NAME so
re-spawned grand-sub-processes inherit linkage })`. Stream sub-process
output to logs (not to the tool result), then run the same summary
extraction as `check_process` and return it.

The agent-loop session UUID is **read internally** from the
persistence layer; it never appears in the tool's input or output
schema.

### 4.6 What the LLM sees

The skill YAML declares two built-in tools. The orchestrator's LLM sees
them in its tool catalog as:

- `check_process(name="run_build")` — returns structured summary of
  the sub-process dispatched by the `run_build` tool.
- `resume_process(name="run_build_redacted")` — resumes the
  sub-process dispatched by the `run_build_redacted` tool and returns
  its summary.

The LLM only types **tool names it already knows from the skill's
`tools:` list**. No UUIDs, no opaque identifiers from prior tool
results, no transcription risk.

### 4.7 Audit UI changes

The audit UI surfaces parent-process relationships in two places.

**Session list sidebar (`src/audit/public/index.html`,
`src/audit/public/app.js`):**

- Default view: top-level sessions only (parents and standalone runs).
  Sub-processes are hidden until you click to expand.
- Each top-level session that has sub-processes shows an expand
  affordance (a `<details>`-style chevron) — clicking it reveals the
  sub-process list inline, indented one level. Matches the existing
  collapsible-block idiom in the timeline.
- A "show all sessions" toggle at the top of the sidebar surfaces
  every session flat (the current behaviour).

**Session detail header (`renderHeader` in `app.js`):**

- If `state.parent_id` is set, show a "Parent" row with a clickable
  link to the parent session (skill name + short ID + the
  `process_name` this session was dispatched under).
- A "Sub-processes" section lists all sub-processes of the current
  session, each with their `process_name`, status, and a clickable
  link. New sub-processes appearing via SSE are added live.

**Backend (`src/audit/server.ts`):**

- The `/api/sessions/:id` endpoint enriches the response with:
  - `parent`: `{ id, skill, process_name }` if `state.parent_id` is
    set, else `null`
  - `subprocesses`: array of `{ id, skill, process_name, status,
    startedAt }`, freshly computed from `listSubProcesses`
- The `/api/sessions` list endpoint optionally includes `parent_id` so
  the sidebar can render hierarchy without N+1 fetches.

The parent-process tree is purely visual — clicking a sub-process opens
that sub-process's detail panel exactly as today.

## 5. Migration / compatibility

### 5.1 Existing skills

`ecofin-orchestrator.md` and `ecofin-orchestrator-multi.md` continue to
work unchanged. The legacy CLI-wrapped `check_session` /
`read_transcript` / `resume_session` tools are still valid; agent-loop
simply records the new `parent_id` / `process_name` on sub-processes
regardless of whether the parent uses the built-ins.

To migrate a skill:

1. Add `builtins: [check_process, resume_process]` in frontmatter.
2. Remove the `check_session`, `read_transcript`, `resume_session` tool
   entries from the `tools:` array.
3. Rewrite the workflow section to refer to sub-processes by name
   (e.g. "after `run_build` returns, call
   `check_process(name='run_build')` to see its outcome").
4. Drop all UUID-handling rules from the Rules section.

### 5.2 Existing sessions

`state.json` files written before this feature have neither `parent_id`
nor `process_name`. Reads tolerate the absent fields. No migration
needed.

## 6. CLI surface

```
bun src/cli.ts run <skill> --config <file> --task "<text>"
  [--parent <uuid>] [--process-name <name>]
bun src/cli.ts resume <id> --config <file>
  [--parent <uuid>] [--process-name <name>]
```

Both flags are optional. When omitted, agent-loop reads
`AGENT_LOOP_PARENT_SESSION` and `AGENT_LOOP_PROCESS_NAME` from the
environment. They are normally set automatically by agent-loop's
CLI-tool executor.

## 7. Failure modes

| Case | Behaviour |
|---|---|
| `check_process(name=…)` with no matching sub-process | Tool returns `status: not_found name: <name>`. |
| Sub-process is still running (mid-flight) | `status: running` — the orchestrator's dispatching tool already blocks until the sub-process exits, so in sequential flows this rarely happens. |
| Sub-process's `state.json` is missing or corrupt | Tool returns an error result with the exception. Skill instructions tell the LLM to report and stop. |
| Sub-process has no transcript yet (crashed immediately) | Summary fields beyond `status` are absent. LLM can detect via `iteration: 0` or missing `build_status`. |
| Same name dispatched twice | Latest dispatch wins (most recent `startedAt`). Older same-named sub-processes remain on disk for audit-UI inspection but are not returned by `findSubProcessByName`. |
| Dispatch tool calls `bun src/cli.ts run` with a custom `--process-name` override | Honoured. Useful in tests and for skill authors who want to override the auto-injected name. |

## 8. Implementation plan

1. **Data model + persistence** (~30 LOC)
   - Add `parent_id?: string` and `process_name?: string` to
     `SessionState` in `src/types.ts`.
   - Plumb through session creation.
   - Add `listSubProcesses(parentId)` and
     `findSubProcessByName(parentId, name)` to `FileStore`.
   - Tests: create sub-process sessions, verify state.json fields,
     verify lookups.

2. **CLI flags + env vars** (~25 LOC)
   - Add `--parent <uuid>` and `--process-name <name>` to `run` and
     `resume` in `src/cli.ts`.
   - Resolution order: explicit flag → env var → undefined.

3. **Tool env propagation** (~15 LOC)
   - In `src/tools/cli.ts`, when invoking `execFile`, extend the child
     env with `AGENT_LOOP_PARENT_SESSION` = current session ID and
     `AGENT_LOOP_PROCESS_NAME` = the executing tool's name.
   - Test: spawn a tool that echoes both vars, verify values.

4. **Built-in tool registry** (~80 LOC)
   - New `src/tools/builtin.ts` with a registry of built-in handlers
     keyed by name and their canonical schemas.
   - Skill loader recognises the `builtins:` array and produces tool
     definitions with `kind: "builtin"`.
   - Tool executor dispatches builtins to the registry.

5. **`check_process` handler** (~60 LOC)
   - `findSubProcessByName(currentSessionId, name)`.
   - Read its `state.json` and the tail of its `transcript.jsonl`.
   - Extract `build_status`, `pending_questions`, `object_count`,
     `saved_to`, `mcp_session_id` (by walking the last tool_result's
     JSON for a `session_id` field), `last_tool_result` (truncated).
   - Emit the structured text response per §4.5.

6. **`resume_process` handler** (~40 LOC)
   - Same lookup. Spawn `bun src/cli.ts resume <subprocess.id>
     --config <subprocess.config>` with env vars set so re-spawned
     grand-sub-processes inherit linkage.
   - Capture exit, run summary, return same shape.

7. **Audit UI — backend** (~60 LOC)
   - Extend `/api/sessions/:id` with `parent` and `subprocesses`
     blocks.
   - Optionally extend `/api/sessions` with `parent_id` for hierarchy.

8. **Audit UI — frontend** (~120 LOC)
   - Sidebar: hide sub-processes by default, expand-on-click via a
     `<details>` block under each parent, "show all" toggle for the
     flat view.
   - Detail header: Parent row + Sub-processes section.
   - SSE: when a sub-process appears, the parent's open detail panel
     adds it live to the Sub-processes list.

9. **Skill migration** (separate PR in `ecofin-mcp-graph`)
   - Update `ecofin-orchestrator-multi.md` and `ecofin-orchestrator.md`
     to use the built-ins.
   - Rewrite workflow + rules text.
   - Smoke-test with a real two-stage build.

Total agent-loop diff: ~430 LOC of source + ~150 LOC of tests.

## 9. Open questions

- **What happens when a sub-process shares its name with another
  parent's sub-process?** Names are scoped per-parent (always:
  parent_id + process_name pair). Two different parents can both have
  a `run_build` sub-process; they don't collide. (Resolved — this is
  the chosen behaviour.)
- **Crash-time `state.json` integrity.** If a sub-process crashes
  before writing its initial state.json, `parent_id` / `process_name`
  may be lost. Mitigation: write the initial state.json immediately on
  session creation, before any LLM work begins. Already the case in
  `startNewSession`, so no change needed — call it out for review.

## 10. Verification

A successful end-to-end test:

1. Start an orchestrator session that uses built-in tools.
2. The orchestrator dispatches a sub-build via `run_build`.
3. The sub-build session has `parent_id` set to the orchestrator's ID
   and `process_name = "run_build"` in its `state.json`.
4. The orchestrator calls `check_process(name="run_build")` and
   receives the sub-build's status, build_status, mcp_session_id, etc.
5. The agent-loop session UUID of the sub-build appears nowhere in the
   orchestrator's transcript (no UUID-shaped strings in any tool
   result or LLM response).
6. The orchestrator dispatches a second sub-build via
   `run_build_redacted`. Its sub-process has `process_name =
   "run_build_redacted"`.
7. `check_process(name="run_build_redacted")` returns its summary;
   `check_process(name="run_build")` still returns the first stage's
   summary (names don't collide).
8. If the stage-2 sub-process is `needs_input`, the orchestrator calls
   `resume_process(name="run_build_redacted")` and observes
   pending_questions decrease.
9. Final report from the orchestrator mentions both stages by name
   without ever quoting an agent-loop session UUID.
10. Audit UI: the orchestrator session appears top-level in the
    sidebar with a collapsible affordance; expanding it reveals both
    sub-processes by `process_name`. The detail panel's Parent row
    on each sub-process links back to the orchestrator. The
    Sub-processes section on the orchestrator's detail panel lists
    both with their `process_name`, status, and updates live via SSE.
