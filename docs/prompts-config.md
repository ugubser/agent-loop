# Prompts and thresholds — configuration

agent-loop reads **all** of its hardcoded-looking strings (system-prompt
identity, nudges, trim placeholders, compaction prompts) and all of its
behavioural thresholds (loop-detector window, empty-response retry cap,
compaction ratios, etc.) from a YAML file at startup.

The canonical defaults live in `config.prompts.default.yaml` at the
agent-loop repo root. There are **no code-baked fallbacks** — the YAML
file is loaded on every agent-loop run, and any missing required key
causes a startup error with a clear message.

A user config can override any subset of the defaults by adding a
`prompts:` entry. Two forms are supported.

## Override forms

### 1. Reference another YAML file

```yaml
# config.spark.yaml
model:
  provider: lmstudio
  model: qwen
  ...
prompts: ./config.prompts.qwen.yaml
```

`./config.prompts.qwen.yaml` only needs to contain the keys you want to
change — everything else falls through to `config.prompts.default.yaml`:

```yaml
# config.prompts.qwen.yaml — small file, just the overrides
identities:
  base: |
    You are a careful agent. Never emit progress text mid-flight.
    ...

thresholds:
  empty_response_max_attempts: 3
```

The path is resolved relative to the directory of the config file that
references it (so `config.spark.yaml` referencing `./prompts/qwen.yaml`
finds the file next to itself).

### 2. Inline object

```yaml
# config.codex.yaml
model:
  provider: openai-compat
  model: gpt-5.3-codex
  ...
prompts:
  thresholds:
    empty_response_max_attempts: 2
  nudges:
    empty_response_first: |
      The previous response was empty. Call build_instrument now.
```

## Schema

All sections are optional in an override — missing keys fall back to
defaults from `config.prompts.default.yaml`. The defaults file itself
must contain every key.

### `identities`

| Key | Used for |
|---|---|
| `base` | Prepended to every skill-mode system prompt. |
| `router` | Prepended to the router/auto-skill system prompt. |

### `nudges`

Strings injected as `user` messages by the loop's recovery paths.

| Key | Trigger | Placeholders |
|---|---|---|
| `empty_response_first` | Model returns no text and no tool calls, 1st time in a row | — |
| `empty_response_repeated` | Empty response, 2nd onwards | `{n}` = consecutive count |
| `text_only_continuation` | Model returns text but no tool call, and not yet a final summary | — |
| `malformed_json` | After `thresholds.malformed_json_threshold` consecutive malformed-JSON tool calls | — |
| `loop_detected` | First trip of the loop detector | — |

### `markers`

Boilerplate text emitted into tool-result content or message content
(visible to the LLM).

| Key | Used at | Placeholders |
|---|---|---|
| `truncation` | Appended when a single tool result exceeds `tools.cli.maxResultChars` | — |
| `prior_result_summary` | Replaces older tool results during context-trim's `autoTrimConsumedResults` | `{name}` `{preview}` `{chars}` |
| `prior_call_summary` | Replaces older call+result pairs during `trimToolContext` (when `context.keep_last` is set on a tool) | `{name}` `{preview}` `{status}` |
| `compaction_fallback` | Marker inserted when LLM-driven compaction itself fails | — |

### `compaction`

| Key | Used at | Placeholders |
|---|---|---|
| `summarizer_system` | System prompt for the LLM call that compacts older messages | `{target_tokens}` |

### `thresholds`

All numeric.

| Key | Meaning | Default |
|---|---|---|
| `empty_response_max_attempts` | Consecutive empty responses before declaring the session completed (nudges fire on attempts 1..N−1). | 5 |
| `text_only_max_attempts` | Consecutive text-only responses (no tool calls) before declaring completed. | 3 |
| `text_only_completion_min_chars` | A single text-only response of at least this many chars + completion keywords terminates the session immediately. | 200 |
| `malformed_json_threshold` | Consecutive malformed-JSON tool calls before firing `nudges.malformed_json`. | 3 |
| `loop_window_size` | Recent tool-call signatures retained by the loop detector. | 6 |
| `loop_match_length` | Last-N identical sigs that trip the detector. | 3 |
| `loop_pause_warnings` | Number of trips before the session is paused with reason `loop_detected`. | 2 |
| `compaction_soft_ratio` | Context-fill ratio that triggers the "soft" (LLM-summarised) compaction path. | 0.7 |
| `compaction_hard_ratio` | Ratio for the more aggressive "hard" path. | 0.9 |
| `compaction_soft_recent_n` | Iterations preserved verbatim during a soft compaction. | 10 |
| `compaction_hard_recent_n` | Iterations preserved verbatim during a hard compaction. | 3 |

## Placeholder substitution

Strings with `{name}` placeholders are resolved at emission time. Unknown
placeholders are left literal (so `{maybe_not_set}` would survive
unchanged in output — usually a hint that a template was edited).

## Recommended per-model tuning

Some models behave very differently. Suggestions:

- **gpt-5.3-codex (frontier):** prone to emitting "Progress update" text
  mid-flight. Use a stricter `identities.base` that explicitly bans
  status text during in-progress workflows. Set
  `thresholds.empty_response_max_attempts: 3` so failing fast on
  empty-response cascades.
- **qwen / local models:** generally rule-following at temperature 0.2.
  Defaults are usually fine.
- **Anthropic frontier:** native tool-use behaviour means
  `nudges.text_only_continuation` rarely fires; defaults work well.

## Verifying overrides

After editing a prompts file, you can verify the resolved config without
running a full session:

```bash
bun -e "
import { loadConfig } from './src/cli.ts';
const c = loadConfig('config.spark.yaml');
console.log(c.prompts.identities.base);
console.log('empty_max:', c.prompts.thresholds.empty_response_max_attempts);
"
```

If a required key is missing from both your override and the default
file, agent-loop fails to start with a list of the missing dotted keys.
