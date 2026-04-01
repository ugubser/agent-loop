# Using Codex with agent-loop

## Proxy Options

### Option A: codex-proxy (recommended)

Uses [codex-proxy](https://github.com/icebear0828/codex-proxy) — a proper Responses→ChatCompletions translator without the Vercel AI SDK (which silently drops large requests).

```bash
# First time setup
cd /home/ugubser/Github/codex-proxy
npm install
cd web && npm install && cd ..
npm run build

# Start the proxy
npm start
# Dashboard at http://localhost:8888 — log in with your ChatGPT account
```

Config: `config/default.yaml` — key settings:
- `tls.transport: curl-cli` (uses system curl)
- `server.port: 8888`
- API key is auto-generated in `data/local.yaml` on first run (default: `pwd`)

To import an existing Codex CLI token instead of browser login:
```bash
curl -X POST http://localhost:8888/auth/import-cli
```

### Option B: openai-oauth (simpler, but has issues with large requests)

```bash
npx openai-oauth --oauth-file ~/.codex/auth.json
# Proxy runs at http://127.0.0.1:10531/v1
```

Known issue: the Vercel AI SDK layer silently returns empty responses (`content: null, finish_reason: null, 0 tokens`) when the request payload is large (~40K+ chars of tool results). This causes the builder to fail during the property_fill phase.

## Running agent-loop with Codex

```bash
# With codex-proxy (Option A)
bun src/cli.ts run ecofin-orchestrator --config config.codex.yaml --task "Build a FIDM instrument graph from the term sheet at /path/to/termsheet.txt"

# Direct build (without orchestrator)
bun src/cli.ts run ecofin-build --config config.codex.yaml --task "Build a FIDM instrument graph from the term sheet at /path/to/termsheet.txt"
```

## Configuration

See `config.codex.yaml`:

- **model**: `gpt-5.3-codex`
- **baseUrl**: `http://localhost:8888/v1` (codex-proxy)
- **apiKey**: must match `proxy_api_key` in `codex-proxy/data/local.yaml`
- **provider**: `openai-compat`
- **maxSteps**: 60

## Alternative: Anthropic (Sonnet 4.6)

If Codex is rate-limited or failing, use the Anthropic provider directly:

```bash
bun src/cli.ts run ecofin-orchestrator --config config.yaml --task "Build a FIDM instrument graph from the term sheet at /path/to/termsheet.txt"
```

Requires `ANTHROPIC_API_KEY` in `.env`. Sonnet 4.6 handles large property_fill responses without issues.
