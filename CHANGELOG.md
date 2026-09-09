# Changelog

## [Unreleased]

### Added
- **Tool calling** for Claude Code: Anthropic `tools` / `tool_choice` are translated to
  Copilot function tools, `tool_use` blocks to `tool_calls`, and `tool_result` blocks
  to standalone `tool` messages in the order the upstream API expects.
- **Real SSE streaming**: upstream Copilot events are converted to Anthropic events as
  they arrive, including streamed tool-call arguments as `input_json_delta`.
- **Image support**: `base64` and `url` image blocks become data URIs and set the
  `Copilot-Vision-Request` header.
- Support for the block-array form of `system` that Claude Code sends.
- Pass-through of `temperature`, `top_p` and `stop_sequences`.
- `GET /v1/models/:model`, and `GET /v1/models` now returns Anthropic's pagination envelope.
- `src/types/copilot-chat.ts` describing Copilot's chat-completions dialect.
- Configurable Copilot endpoint, client identity headers, default model, output-token
  ceiling and upstream streaming toggle.
- Unit and route tests for the translation layer, streaming, model mapping and auth errors.
- `npm run typecheck` and `npm run lint:fix` scripts.

### Fixed
- **Missing `Copilot-Integration-Id` header**, which caused the Copilot chat endpoint to
  reject requests.
- **Rate limiter compared the cumulative request count** against the per-minute limit,
  permanently rate-limiting long-running Claude Code sessions. It now uses a sliding
  one-minute window.
- Per-request and per-minute token ceilings rejected normal Claude Code contexts; they
  are now opt-in and disabled by default.
- Rate-limit errors on Anthropic routes are returned in the Anthropic error envelope.
- Authentication middleware returned 401 without attempting a token refresh; refreshes
  are now attempted and de-duplicated across concurrent requests.
- Upstream errors are surfaced with their original status code and matching Anthropic
  error type instead of a blanket 500.
- Non-text content (tool calls, images) is no longer silently dropped when converting
  requests.
- Persisted token files are written with owner-only permissions.
- Cursor IDE base URL documented as `/openai/v1`, matching where the routes are mounted.

### Changed
- Minimum supported Node.js version is now 20; CI runs on Node 20 and 22 and the Docker
  image is based on Node 22.
- Model mapping resolves the longest matching prefix and falls back to
  `DEFAULT_CLAUDE_MODEL` for unknown Claude identifiers.
- `count_tokens` estimates from all content blocks and tool schemas rather than text only.

## [v0.1.0] - 2025-03-24

### Added
- Initial release of GitHub Copilot Proxy
- OAuth Device Flow Authentication with GitHub
- OpenAI-Compatible API endpoints (`/v1/models` and `/v1/chat/completions`)
- Token management with automatic refresh and validation
- Streaming support for real-time completions
- Rate limiting based on requests and token usage
- Usage monitoring and metrics dashboard
- Web-based authentication UI
- Environment variable configuration with Zod validation
- Enhanced .gitignore with additional standard entries

