# Using Codex with agent-loop

## Prerequisites

1. Install and run [Codex](https://github.com/openai/codex) at least once to create the auth token:
   ```bash
   npx codex
   ```

2. If the token expires, refresh it:
   ```bash
   npx openai-oauth --oauth-file ~/.codex/auth.json
   ```

3. Codex runs a local proxy at `http://127.0.0.1:10531/v1` that handles authentication automatically.

## Running agent-loop with Codex

```bash
bun src/cli.ts run ecofin-build --config config.codex.yaml --task "Build a FIDM instrument graph from the term sheet at /path/to/termsheet.txt"
```

## Configuration

See `config.codex.yaml` for the full configuration. Key settings:

- **model**: `gpt-5.1-codex-mini`
- **baseUrl**: `http://127.0.0.1:10531/v1` (local Codex proxy)
- **provider**: `openai-compat` (standard OpenAI chat completions API)
