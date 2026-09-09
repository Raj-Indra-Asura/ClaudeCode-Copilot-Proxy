# GitHub Copilot Proxy for Claude Code & Cursor IDE

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20.0+-green.svg)](https://nodejs.org/)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org)

> ⚠️ **Disclaimer**: This project is for **educational purposes only**. It demonstrates API proxy patterns and OAuth device flow authentication. Use at your own risk and ensure compliance with GitHub Copilot's Terms of Service.

An **Anthropic Messages API-compatible** proxy that lets **Claude Code** run on your **GitHub Copilot** subscription (Pro, Pro+, Business, Enterprise). It also exposes an OpenAI-compatible surface for **Cursor IDE**.

## ✨ What works

The proxy implements the parts of the Anthropic API that Claude Code actually exercises, so agentic workflows behave the same as they do against `api.anthropic.com`:

| Capability | Status | Notes |
|---|---|---|
| `POST /v1/messages` (buffered) | ✅ | Full request/response translation |
| `POST /v1/messages` (streaming) | ✅ | True SSE pass-through from Copilot, not simulated |
| **Tool calling** | ✅ | `tools`, `tool_choice`, `tool_use` ⇄ `tool_calls`, `tool_result` ⇄ `role: tool` |
| **Streamed tool calls** | ✅ | `content_block_start` + `input_json_delta` fragments |
| **Images** | ✅ | `base64` / `url` image blocks → data URIs, with `Copilot-Vision-Request` |
| **System prompts** | ✅ | Both the `string` and the block-array form Claude Code sends |
| Sampling parameters | ✅ | `temperature`, `top_p`, `stop_sequences`, `max_tokens` |
| `POST /v1/messages/count_tokens` | ✅ | Local estimate (no upstream call, no premium request) |
| `GET /v1/models`, `GET /v1/models/:model` | ✅ | Anthropic pagination envelope |
| Error semantics | ✅ | Upstream status codes and Anthropic error types are preserved |
| Prompt caching (`cache_control`) | ➖ | Accepted and ignored; Copilot manages caching server-side |
| Extended thinking | ➖ | Accepted and ignored; Copilot does not expose thinking blocks |

## 📋 Prerequisites

- **Node.js 20.0 or higher**
- A **GitHub Copilot subscription** with access to the Claude models
- **Claude Code** (or Cursor IDE)

## 🔧 Installation

### Option A: Quick install

```bash
npm install -g claudecode-copilot-proxy
claudecode-copilot-proxy
```

The server starts at http://localhost:3000.

### Option B: From source

```bash
git clone https://github.com/shyamsridhar123/ClaudeCode-Copilot-Proxy.git
cd ClaudeCode-Copilot-Proxy
npm install
npm run build
npm start
```

## 🤖 Configuration with Claude Code

1. **Start the proxy** and open http://localhost:3000. Complete the GitHub device-flow login by entering the displayed code. Tokens are cached in `~/.github-copilot-proxy/` (owner-only permissions) and refreshed automatically, so you only do this once.

2. **Point Claude Code at the proxy.** Add the environment block to `.claude/settings.local.json` in your project (or `~/.claude/settings.json` globally):

   ```json
   {
     "env": {
       "ANTHROPIC_BASE_URL": "http://localhost:3000",
       "ANTHROPIC_AUTH_TOKEN": "sk-dummy",
       "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
       "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
     }
   }
   ```

   `ANTHROPIC_AUTH_TOKEN` is a placeholder: the proxy authorises with your GitHub Copilot token, not an Anthropic key. The two `DISABLE_*` flags suppress telemetry and other non-essential model calls, which keeps your premium-request usage down.

3. **Run `claude`** in your terminal.

### Verifying it works

- The server log shows `POST /v1/messages - 200`.
- The log line `Requesting Copilot chat completion` reports the mapped model, e.g. `claude-sonnet-4.5`.
- Token usage is visible at http://localhost:3000/usage.html.
- Editing files, running Bash, and other tool-driven workflows complete normally — that exercises the tool-calling path.

### Supported models

Claude Code's model identifiers (including the dated ones such as `claude-sonnet-4-5-20250929` and the `sonnet` / `opus` / `haiku` / `opusplan` aliases) are mapped automatically:

| Claude Code model | Copilot model |
|---|---|
| `claude-opus-4-5*`, `opus`, `opusplan` | `claude-opus-4.5` |
| `claude-opus-4-1*` | `claude-opus-4.1` |
| `claude-sonnet-4-5*`, `sonnet` | `claude-sonnet-4.5` |
| `claude-sonnet-4*` | `claude-sonnet-4` |
| `claude-haiku-4-5*`, `claude-3-5-haiku*`, `haiku` | `claude-haiku-4.5` |
| `claude-3-7-sonnet*` | `claude-3.7-sonnet` |
| `claude-3-5-sonnet*` | `claude-3.5-sonnet` |

Unrecognised `claude-*` identifiers fall back to `DEFAULT_CLAUDE_MODEL` (`claude-sonnet-4.5`), so a model rename on Anthropic's side will not break your session.

### Getting the most from a Copilot Pro+ plan

GitHub bills Copilot usage in **premium requests**, and each model carries a multiplier. A few settings make a large difference:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3000",
    "ANTHROPIC_AUTH_TOKEN": "sk-dummy",
    "ANTHROPIC_MODEL": "claude-sonnet-4-5",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

- Use **Sonnet** as the main model and reserve **Opus** for hard problems (`/model opus`) — Opus costs several times more per request.
- Keep a cheap model for Claude Code's background work (conversation summaries, titles) via `ANTHROPIC_SMALL_FAST_MODEL`.
- `count_tokens` is answered locally, so Claude Code's frequent context-size checks cost nothing.
- Use `/compact` and `/clear` regularly: fewer, larger turns cost less than many small ones, because billing is per request rather than per token.

### Optional: GPT and Gemini models

Any other model your Copilot plan exposes is passed through untouched:

```json
{ "env": { "ANTHROPIC_MODEL": "gpt-5.2" } }
```

## 🔌 Configuration with Cursor IDE

1. Open Cursor IDE → Settings → API Keys.
2. Set **Override OpenAI Base URL** to `http://localhost:3000/openai/v1`.
3. Authenticate at http://localhost:3000 if you have not already.

To switch back, remove the base URL override.

## 🤔 How it works

```
┌─────────────────┐     ┌────────────────────────────┐     ┌──────────────────────┐
│   Claude Code   │────▶│    Copilot Proxy Server    │────▶│  GitHub Copilot API  │
│ (Anthropic API) │     │                            │     │ (OpenAI-style chat)  │
│                 │◀────│  • OAuth device flow       │◀────│  • claude-opus-4.5   │
└─────────────────┘ SSE │  • Messages ⇄ chat         │ SSE │  • claude-sonnet-4.5 │
                        │  • Tools ⇄ tool_calls      │     │  • claude-haiku-4.5  │
                        │  • SSE ⇄ SSE               │     └──────────────────────┘
                        └────────────────────────────┘
```

1. The proxy runs the GitHub OAuth device flow and exchanges the GitHub token for a Copilot token, refreshing it before expiry.
2. Claude Code posts Anthropic Messages API requests to `/v1/messages`.
3. `anthropic-service.ts` translates the request into Copilot's chat-completions dialect: system blocks are flattened, `tool_result` blocks are re-ordered into standalone `tool` messages, images become data URIs, and tool schemas become function definitions.
4. The upstream SSE stream is converted back into Anthropic events (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`) as it arrives.
5. Upstream failures are surfaced with their original status code and the matching Anthropic error type, so Claude Code's retry logic behaves correctly.

### Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /v1/messages` | Anthropic Messages API (also at `/anthropic/v1/messages`) |
| `POST /v1/messages/count_tokens` | Local input-token estimate |
| `GET /v1/models`, `GET /v1/models/:model` | Model discovery |
| `POST /openai/v1/chat/completions` | OpenAI-compatible surface for Cursor |
| `GET /health` | Health check |
| `GET /auth.html`, `GET /usage.html` | Authentication portal and usage dashboard |
| `POST /auth/login`, `/auth/check`, `/auth/logout`, `GET /auth/status` | Device-flow control |

### Project layout

```
src/
├── config/       Environment parsing, model mappings, endpoints
├── middleware/   Rate limiting, request logging, error handling
├── public/       Auth portal and usage dashboard
├── routes/       anthropic.ts (Claude Code), openai.ts (Cursor), auth.ts, usage.ts
├── services/     anthropic-service.ts (translation), auth-service.ts, copilot-service.ts
├── types/        anthropic.ts, copilot-chat.ts, openai.ts, github.ts
└── utils/        model-mapper.ts, logger.ts, machine-id.ts
```

## ⚙️ Configuration reference

All settings are optional; see [`.env.example`](.env.example) for the full list.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `localhost` | Listen address |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |
| `COPILOT_CHAT_ENDPOINT` | `https://api.githubcopilot.com/chat/completions` | Override for GitHub Enterprise |
| `COPILOT_INTEGRATION_ID` | `vscode-chat` | Client identity required by Copilot |
| `COPILOT_EDITOR_VERSION` / `COPILOT_PLUGIN_VERSION` / `COPILOT_USER_AGENT` | vscode defaults | Client identity headers |
| `DEFAULT_CLAUDE_MODEL` | `claude-sonnet-4.5` | Fallback for unknown Claude models |
| `MAX_OUTPUT_TOKENS` | `64000` | Ceiling applied to `max_tokens` |
| `ENABLE_UPSTREAM_STREAMING` | `true` | Set to `false` to buffer upstream responses |
| `RATE_LIMIT_DEFAULT` / `RATE_LIMIT_CHAT_COMPLETIONS` | `600` / `300` | Requests per minute (`0` disables) |
| `MAX_TOKENS_PER_REQUEST` / `MAX_TOKENS_PER_MINUTE` | `0` | Optional token ceilings (`0` disables) |

## 🐳 Docker

```bash
docker build -t claudecode-copilot-proxy .
docker run -p 3000:3000 -v ~/.github-copilot-proxy:/root/.github-copilot-proxy claudecode-copilot-proxy
```

Mounting the token directory preserves your authentication across container restarts.

## 🛠️ Development

```bash
npm run dev        # Run from source with ts-node
npm run typecheck  # tsc --noEmit
npm run lint       # ESLint
npm test           # Jest
npm run build      # Compile to dist/
```

## 🩺 Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `401 authentication_error` | Not signed in, or the GitHub token was revoked. Re-authenticate at http://localhost:3000. |
| `403 permission_error` | Your Copilot plan does not include the requested model. Pick another with `/model`. |
| `429 rate_limit_error` | You hit the proxy's request limit or Copilot's. Raise `RATE_LIMIT_*` or wait for the `Retry-After` window. |
| `404 not_found_error` on a model | The model is not offered by Copilot. Check `GET /v1/models`. |
| Tools never fire | Confirm you are on this version: earlier releases dropped `tools` entirely. `npm run build` after pulling. |
| Streaming looks buffered | A corporate proxy is buffering SSE. Set `ENABLE_UPSTREAM_STREAMING=false` as a fallback. |

Run with `LOG_LEVEL=debug` to see the mapped model, message count, and tool count for every request.

## 📄 License

MIT — see the [LICENSE](LICENSE) file.

## 🤝 Contributing

Contributions are welcome.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit using conventional commits (`git commit -m 'feat: add amazing feature'`)
4. Push and open a Pull Request
