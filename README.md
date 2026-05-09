# codex-responses-bridge

A small HTTP service that translates between the OpenAI **Responses API**
and the OpenAI **Chat Completions API**, with first-class support for
codex-sdk / codex-rs clients talking to chat-completions-only backends.

In practice: lets you point [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk)
or any [codex-rs](https://github.com/openai/codex)-based client at any
OpenAI-compatible chat-completions backend (LiteLLM, vLLM, Ollama,
OpenRouter, OpenAI itself) without losing reasoning traces or MCP tool
namespacing.

## Why

Codex's SDK and Rust binary speak the **Responses API** (`/v1/responses`).
But:

- Some backends (vLLM ≤ 0.10) only implement `/v1/chat/completions`.
- Some implement `/v1/responses` but reject codex's rich `input_text`
  content variants with a 215 pydantic-union error.
- Some break on codex's `mcp__<server>__` namespace tool format.
- Some lose chain-of-thought (`reasoning`) round-trips because they
  don't translate `reasoning_content` ↔ `reasoning` field names.

This bridge handles all of that:

- ✅ Responses-API request → Chat-completions request, including
  multimodal content (`input_text`, `input_image`, `input_audio`)
- ✅ MCP tool **namespace expansion** (`{type: "namespace", tools:[…]}` →
  flat top-level functions with bare names) and **restoration** on the
  way back
- ✅ Reasoning round-trip — incoming `reasoning` items become
  `reasoning_content` on the assistant message; the chat-completions
  upstream re-injects them as `<think>` blocks (preserve_thinking) when
  it supports that
- ✅ Tool-call coalescing (parallel `function_call` items → single
  assistant message with `tool_calls=[…]`)
- ✅ Synthetic SSE streaming compatible with codex-rs's strict parser
- ✅ Hard-error on Responses-API features that have no chat-completions
  equivalent (`background:true`, `previous_response_id`) instead of
  silently dropping

The bridge is a pure translator: it doesn't pick models, inject sampling
defaults, or hold credentials. The model name, sampling parameters,
tools, and `Authorization` header all flow through from the client.

## Quick start (Docker)

```bash
docker run --rm -p 8090:8090 \
  -e OPENAI_BASE_URL=http://your-chat-completions-backend:4000/v1 \
  ghcr.io/aidenlabsdotdev/codex-responses-bridge:latest
```

Then point your codex client at `http://localhost:8090/v1` and it'll
work as if it were talking to a real Responses-API endpoint.

For codex-sdk:

```ts
import { Codex } from "@openai/codex-sdk";

const codex = new Codex({
  apiKey: process.env.OPENAI_API_KEY,  // forwarded as Authorization header
  config: {
    model: "qwen/qwen3.6-27b-think",       // whatever model your upstream knows
    model_provider: "bridge",
    model_providers: {
      bridge: {
        name: "via codex-responses-bridge",
        base_url: "http://localhost:8090/v1",
        env_key: "OPENAI_API_KEY",
        wire_api: "responses",             // codex speaks Responses to the bridge
      },
    },
    // ...
  },
});
```

## Configuration

All knobs are env vars. The bridge intentionally has very few — it's a
translator, not a policy layer.

| Var | Required | Default | Description |
|---|---|---|---|
| `OPENAI_BASE_URL` | recommended | `http://localhost:4000/v1` | Upstream chat-completions root |
| `BRIDGE_PORT` | no | `8090` | Listen port |
| `BRIDGE_LOG_LEVEL` | no | `info` | `error`, `info`, `debug` |

**Authentication**: the bridge forwards the caller's `Authorization`
header verbatim to the upstream. Configure your bridge client with the
backend's API key — the bridge stores no credentials.

**Model & sampling**: pass-through. Set `model`, `temperature`, `top_p`,
`presence_penalty`, etc. on each request from the client side. Vendor
extras like `top_k`, `min_p`, `repetition_penalty` also pass through if
the client sends them.

## Endpoints

- `POST /v1/responses` — main endpoint. Accepts a Responses-API request,
  returns a Responses-API response (JSON or SSE depending on
  `stream:true`).
- `GET /v1/models` — passes through to upstream so codex's preflight
  works.

The bridge does **not** implement `/v1/chat/completions` — clients that
speak chat-completions natively should hit the upstream directly.

## Deploy options

### Docker (recommended)

Pre-built multi-arch images (linux/amd64, linux/arm64) at
`ghcr.io/aidenlabsdotdev/codex-responses-bridge`. Tag `latest` tracks
`main`; semver tags pin specific releases.

### docker-compose

```yaml
services:
  responses-bridge:
    image: ghcr.io/aidenlabsdotdev/codex-responses-bridge:latest
    ports:
      - "8090:8090"
    environment:
      OPENAI_BASE_URL: http://litellm:4000/v1
    restart: unless-stopped
```

### Run from source

```bash
git clone https://github.com/aidenlabsdotdev/codex-responses-bridge
cd codex-responses-bridge
npm install
OPENAI_BASE_URL=http://localhost:4000/v1 npm start
```

Requires Node ≥ 22 (uses `tsx` to run TypeScript directly via
`--experimental-strip-types`; no build step).

## Development

```bash
npm install
npm run dev       # auto-reloads on edits, debug logging
npm run typecheck # tsc --noEmit
```

## How it works

```
codex-sdk / codex-rs  ──Responses API──▶  bridge  ──Chat Completions──▶  upstream
                                            │                              │
                  ◀──Responses SSE──────────┤                              │
                                            └◀──Chat Completion JSON──────┘
```

- **Outbound**: `responsesToChat` walks the Responses input items and
  builds a Chat Completions message array. Reasoning items attach as
  `reasoning_content` on the next assistant message; namespaced tools
  get expanded to top-level functions with bare names.
- **Inbound**: `chatToResponses` (one-shot JSON) or `buildSseEvents`
  (synthetic SSE stream) reconstructs Responses-API output items from
  the chat completion. Bare tool-call names are re-mapped to their
  namespace via the per-request `bareToNamespace` map.

The translation is **stable** — same input produces byte-identical
upstream messages, so vLLM/LiteLLM prefix-caching works across turns.

## Tested with

- [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) v0.129
- [LiteLLM proxy](https://github.com/BerriAI/litellm) v1.82.6
- [vLLM](https://github.com/vllm-project/vllm) serving Qwen3.6-27B
- Chrome MCP server (full namespace expansion path)

## License

MIT — see [LICENSE](./LICENSE).
