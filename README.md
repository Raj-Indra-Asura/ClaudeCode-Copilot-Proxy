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

## 📖 Contents

**New here?** Read [Getting started](#-getting-started) — it covers everything
from installing Node.js to your first Claude Code session.

- [Getting started](#-getting-started) — the full step-by-step walkthrough
- [Install without cloning](#-alternative-install-without-cloning)
- [Claude Code configuration reference](#-claude-code-configuration-reference) — models, cost tuning
- [Configuration with Cursor IDE](#-configuration-with-cursor-ide)
- [How it works](#-how-it-works) — architecture, endpoints, project layout
- [Configuration reference](#️-configuration-reference) — environment variables
- [Docker](#-docker) · [Development](#️-development) · [Troubleshooting](#-troubleshooting)

## 🚀 Getting started

This walkthrough assumes **no prior knowledge** of the project. Follow it top to
bottom and you will have Claude Code running on your Copilot subscription. It
takes about five minutes.

> Every command below is typed into a terminal: **Terminal** on macOS/Linux, or
> **PowerShell** on Windows.

### Step 1 — Check what you need

| Requirement | Why | Check it |
|---|---|---|
| **Node.js 20 or newer** | Runs the proxy | `node --version` |
| **Git** | Clones the repository | `git --version` |
| **A GitHub Copilot subscription** | Provides the Claude models | Pro, Pro+, Business or Enterprise |
| **Claude Code** | The client you'll be using | `claude --version` |

Each of those commands should print a version number. If any of them says
`command not found`, install the missing tool:

- **Node.js** — download the LTS installer from [nodejs.org](https://nodejs.org/),
  or use a version manager:
  ```bash
  # macOS (Homebrew)
  brew install node

  # Windows (winget)
  winget install OpenJS.NodeJS.LTS

  # Linux / macOS (nvm — recommended if you juggle Node versions)
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  nvm install 20
  ```
  If `node --version` prints something lower than `v20`, upgrade — the proxy
  will not start on older versions.

- **Claude Code** — install it globally:
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```

You do **not** need an Anthropic API key or an Anthropic account. That is the
entire point of this proxy.

### Step 2 — Get the code

```bash
git clone https://github.com/shyamsridhar123/ClaudeCode-Copilot-Proxy.git
cd ClaudeCode-Copilot-Proxy
```

Stay in this folder for the next three steps.

### Step 3 — Install dependencies

```bash
npm install
```

This downloads the libraries into a `node_modules/` folder. It only needs to be
done once (and again after you pull updates). Warnings about deprecated
sub-dependencies are normal; errors are not.

### Step 4 — Build it

```bash
npm run build
```

The project is written in TypeScript, which browsers and Node cannot run
directly. This step compiles `src/` into plain JavaScript in `dist/`. **If you
skip this, `npm start` will fail with "Cannot find module".**

### Step 5 — Start the proxy

```bash
npm start
```

You should see:

```
info: Server running at http://localhost:3000/
info: Press CTRL-C to stop the server
```

**Leave this terminal window open.** The proxy has to keep running for Claude
Code to work — closing it or pressing `Ctrl-C` stops everything. From here on,
open a **second** terminal window for the remaining commands.

### Step 6 — Sign in with GitHub

Open <http://localhost:3000> in your browser. You will land on the
authentication page.

1. Click **Sign in with GitHub**.
2. The page shows an **8-character code** (like `A1B2-C3D4`) and a link to
   <https://github.com/login/device>.
3. Open that link, paste the code, and approve the request.
4. Return to the proxy tab — it polls automatically and switches to
   **Authenticated** within a few seconds.

Your tokens are cached in `~/.github-copilot-proxy/` with owner-only
permissions and refreshed automatically before they expire, so **this is a
one-time step**. It survives restarts and reboots.

> Nothing is sent to Anthropic, and no password is shared with this project —
> GitHub's device flow hands back a scoped token directly.

### Step 7 — Confirm the proxy is healthy

Before wiring up Claude Code, prove the proxy works on its own. In your second
terminal:

```bash
curl http://localhost:3000/health
```

Expected:

```json
{"status":"healthy","version":"0.1.0"}
```

Now check which models your account can actually reach:

```bash
curl -s http://localhost:3000/v1/models
```

You should see entries such as `claude-opus-5`, `claude-sonnet-5` and
`claude-haiku-4.5`. If instead you get:

```json
{"type":"error","error":{"type":"authentication_error","message":"GitHub Copilot authentication required..."}}
```

then Step 6 did not complete — go back and finish the GitHub sign-in.

Finally, send a real message through Copilot:

```bash
curl -s http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"sonnet","max_tokens":64,"messages":[{"role":"user","content":"Say hello in five words."}]}'
```

A JSON reply containing a `"text"` block means the whole chain — proxy, GitHub
auth, Copilot — is working. **If this succeeds, any later problem is Claude Code
configuration, not the proxy.**

<details>
<summary>Windows PowerShell versions of the commands above</summary>

PowerShell aliases `curl` to `Invoke-WebRequest`, which uses different syntax.
Use `curl.exe` explicitly, or:

```powershell
Invoke-RestMethod http://localhost:3000/health

Invoke-RestMethod http://localhost:3000/v1/messages `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"model":"sonnet","max_tokens":64,"messages":[{"role":"user","content":"Say hello in five words."}]}'
```

</details>

### Step 8 — Point Claude Code at the proxy

Claude Code reads settings from a JSON file. Create or edit one of these:

| Scope | Path |
|---|---|
| **This project only** | `.claude/settings.local.json` inside your project folder |
| **Everything you do** (recommended) | `~/.claude/settings.json` — on Windows, `%USERPROFILE%\.claude\settings.json` |

Put this in it:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3000",
    "ANTHROPIC_AUTH_TOKEN": "sk-dummy",
    "ANTHROPIC_MODEL": "sonnet",
    "ANTHROPIC_SMALL_FAST_MODEL": "haiku",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

What each line does:

- `ANTHROPIC_BASE_URL` — sends Claude Code to your proxy instead of Anthropic. **This is the key setting.**
- `ANTHROPIC_AUTH_TOKEN` — a deliberate placeholder. Claude Code refuses to start without *some* value, but the proxy authorises using your GitHub Copilot token. Leave it as `sk-dummy`.
- `ANTHROPIC_MODEL` — your everyday model. `sonnet` is the best balance of cost and capability.
- `ANTHROPIC_SMALL_FAST_MODEL` — the cheap model for background chores like conversation titles.
- The two `DISABLE_*` flags — suppress telemetry and non-essential model calls, which directly reduces premium-request usage.

If the folder does not exist yet, create it first:

```bash
mkdir -p ~/.claude          # macOS / Linux
```
```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude"   # Windows
```

### Step 9 — Run Claude Code

With the proxy still running in the first terminal, go to any project folder and
start Claude Code:

```bash
cd ~/some-project
claude
```

Ask it something that touches your files, for example *"what does this
repository do?"*. Watch the proxy's terminal — you should see lines like:

```
info: POST /v1/messages - 200 - 1423ms
```

That is your Copilot subscription answering. **You're done.**

### Everyday use after setup

You never repeat Steps 1–4 or Step 6. A normal session is just:

```bash
# Terminal 1 — start the proxy, leave it running
cd ClaudeCode-Copilot-Proxy && npm start

# Terminal 2 — work as usual
claude
```

**Updating to a newer version:**

```bash
cd ClaudeCode-Copilot-Proxy
git pull
npm install
npm run build      # don't forget this — stale dist/ causes confusing bugs
npm start
```

**Stopping:** press `Ctrl-C` in the proxy terminal.

**Signing out:** delete `~/.github-copilot-proxy/`, or use the sign-out button
on the auth page.

### First-run problems

| What you see | What it means |
|---|---|
| `Cannot find module '.../dist/index.js'` | You skipped `npm run build` (Step 4). |
| `EADDRINUSE: address already in use :::3000` | Something else owns port 3000 — often a second copy of this proxy. Stop it, or start with `PORT=3001 npm start` and update `ANTHROPIC_BASE_URL` to match. |
| Claude Code still asks you to log in to Anthropic | Your settings file is not being read. Check the filename spelling exactly, and that the JSON has no trailing commas. |
| `Connection refused` from Claude Code | The proxy is not running. Restart it in Terminal 1. |
| Browser shows the code but never says *Authenticated* | The device code expired (they are short-lived). Click **Sign in with GitHub** again for a fresh code. |
| `command not found: claude` | Claude Code is not installed — see Step 1. |
| Everything works but answers seem to come from the wrong model | Run `/model` inside Claude Code to see what it selected, and check the mapping table below. |

Still stuck? Restart the proxy with debug logging and read what it reports for
each request:

```bash
LOG_LEVEL=debug npm start
```

## 📦 Alternative: install without cloning

If you would rather not keep a source checkout, install the published package
globally. Steps 6–9 above still apply.

```bash
npm install -g claudecode-copilot-proxy
claudecode-copilot-proxy
```

The server starts at http://localhost:3000, and there is no build step.

## 🤖 Claude Code configuration reference

The settings file from Step 8 is the minimum. Everything below is optional
tuning.

### Verifying it works

- The server log shows `POST /v1/messages - 200 - <duration>ms`.
- The log line `Requesting Copilot chat completion` reports the mapped model, e.g. `claude-sonnet-5`.
- Token usage is visible at http://localhost:3000/usage.html.
- Editing files, running Bash, and other tool-driven workflows complete normally — that exercises the tool-calling path.

### Supported models

GitHub Copilot does **not** serve Anthropic's public model names, and it retires
model IDs quickly. Claude Code's identifiers (including dated ones such as
`claude-sonnet-4-5-20250929` and the `sonnet` / `opus` / `haiku` / `opusplan`
aliases) are therefore mapped onto whatever Copilot currently serves:

| Claude Code model | Copilot model |
|---|---|
| `claude-opus-4-5*`, `claude-opus-4-1*`, `opus`, `opusplan` | `claude-opus-5` |
| `claude-sonnet-4-5*`, `claude-sonnet-4*`, `sonnet` | `claude-sonnet-5` |
| `claude-haiku-4-5*`, `claude-3-5-haiku*`, `haiku` | `claude-haiku-4.5` |
| `claude-3-7-sonnet*`, `claude-3-5-sonnet*` | `claude-sonnet-5` |

A live Copilot model ID (`claude-opus-5`, `claude-opus-4.8`, `claude-opus-4.8-fast`,
`claude-opus-4.7`, `claude-sonnet-5`, `claude-haiku-4.5`) is forwarded verbatim.
Unrecognised `claude-*` identifiers fall back to `DEFAULT_CLAUDE_MODEL`
(`claude-sonnet-5`), so a model rename will not break your session.

To see exactly what your own account can serve:

```bash
curl -s http://localhost:3000/v1/models | jq '.data[].id'
```

If a request fails with `model_not_supported`, Copilot has retired that ID —
update `CLAUDE_MODEL_MAPPINGS` in `src/config/index.ts` to a live one.

### Getting the most from a Copilot Pro+ plan

GitHub bills Copilot usage in **premium requests**, and each model carries a multiplier. A few settings make a large difference:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3000",
    "ANTHROPIC_AUTH_TOKEN": "sk-dummy",
    "ANTHROPIC_MODEL": "sonnet",
    "ANTHROPIC_SMALL_FAST_MODEL": "haiku",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "haiku",
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
{ "env": { "ANTHROPIC_MODEL": "gpt-5.5" } }
```

## 🔌 Configuration with Cursor IDE

Cursor speaks the OpenAI API rather than Anthropic's, so it uses a different
base URL on the same running proxy.

1. Complete Steps 1–6 above so the proxy is running and authenticated.
2. Open Cursor IDE → **Settings** → **API Keys**.
3. Enable **Override OpenAI Base URL** and set it to
   `http://localhost:3000/openai/v1` — note the `/openai/v1` suffix, which is
   where these routes are mounted.
4. Enter any non-empty API key; as with Claude Code, it is a placeholder.

To switch back to normal Cursor behaviour, turn off the base URL override.

## 🤔 How it works

```
┌─────────────────┐     ┌────────────────────────────┐     ┌──────────────────────┐
│   Claude Code   │────▶│    Copilot Proxy Server    │────▶│  GitHub Copilot API  │
│ (Anthropic API) │     │                            │     │ (OpenAI-style chat)  │
│                 │◀────│  • OAuth device flow       │◀────│  • claude-opus-5     │
└─────────────────┘ SSE │  • Messages ⇄ chat         │ SSE │  • claude-sonnet-5   │
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
| `COPILOT_CHAT_ENDPOINT` | *(from your Copilot token)* | Pin a GitHub Enterprise host or corporate proxy. Leave unset to use the account-specific host GitHub advertises, e.g. `api.individual.githubcopilot.com`. |
| `COPILOT_INTEGRATION_ID` | `vscode-chat` | Client identity required by Copilot |
| `COPILOT_EDITOR_VERSION` / `COPILOT_PLUGIN_VERSION` / `COPILOT_USER_AGENT` | vscode defaults | Client identity headers |
| `DEFAULT_CLAUDE_MODEL` | `claude-sonnet-5` | Fallback for unknown Claude models |
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
