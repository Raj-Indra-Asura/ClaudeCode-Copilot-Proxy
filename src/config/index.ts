import dotenv from 'dotenv';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };

// Load environment variables
dotenv.config();

// Schema for env validation
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().default('3000'),
  HOST: z.string().default('localhost'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  GITHUB_COPILOT_CLIENT_ID: z.string().default('Iv1.b507a08c87ecfe98'),
  // Rate limiting settings (requests per minute)
  RATE_LIMIT_DEFAULT: z.string().default('600'),
  RATE_LIMIT_CHAT_COMPLETIONS: z.string().default('300'),
  // GitHub Copilot chat endpoint (override for enterprise/proxy setups)
  COPILOT_CHAT_ENDPOINT: z.string().url().default('https://api.githubcopilot.com/chat/completions'),
  // Identity headers required by the Copilot chat API
  COPILOT_INTEGRATION_ID: z.string().default('vscode-chat'),
  COPILOT_EDITOR_VERSION: z.string().default('vscode/1.99.3'),
  COPILOT_PLUGIN_VERSION: z.string().default('copilot-chat/0.26.7'),
  COPILOT_USER_AGENT: z.string().default('GitHubCopilotChat/0.26.7'),
  // Default model used when Claude Code does not send a known model
  DEFAULT_CLAUDE_MODEL: z.string().default('claude-sonnet-4.5'),
  // Upper bound applied to max_tokens sent upstream
  MAX_OUTPUT_TOKENS: z.string().default('64000'),
  // Set to 'false' to fall back to buffered (non-streaming) upstream requests
  ENABLE_UPSTREAM_STREAMING: z.enum(['true', 'false']).default('true'),
});

// Parse and validate environment variables
const env = envSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  HOST: process.env.HOST,
  LOG_LEVEL: process.env.LOG_LEVEL,
  GITHUB_COPILOT_CLIENT_ID: process.env.GITHUB_COPILOT_CLIENT_ID,
  RATE_LIMIT_DEFAULT: process.env.RATE_LIMIT_DEFAULT,
  RATE_LIMIT_CHAT_COMPLETIONS: process.env.RATE_LIMIT_CHAT_COMPLETIONS,
  COPILOT_CHAT_ENDPOINT: process.env.COPILOT_CHAT_ENDPOINT,
  COPILOT_INTEGRATION_ID: process.env.COPILOT_INTEGRATION_ID,
  COPILOT_EDITOR_VERSION: process.env.COPILOT_EDITOR_VERSION,
  COPILOT_PLUGIN_VERSION: process.env.COPILOT_PLUGIN_VERSION,
  COPILOT_USER_AGENT: process.env.COPILOT_USER_AGENT,
  DEFAULT_CLAUDE_MODEL: process.env.DEFAULT_CLAUDE_MODEL,
  MAX_OUTPUT_TOKENS: process.env.MAX_OUTPUT_TOKENS,
  ENABLE_UPSTREAM_STREAMING: process.env.ENABLE_UPSTREAM_STREAMING,
});

// API endpoints for OpenAI-compatible Copilot API
const API_ENDPOINTS = {
  GITHUB_COPILOT_TOKEN: 'https://api.github.com/copilot_internal/v2/token',
  GITHUB_COPILOT_COMPLETIONS: 'https://copilot-proxy.githubusercontent.com/v1/engines/copilot-codex/completions',
};

// API endpoints for Anthropic-compatible Copilot API (Claude models)
const ANTHROPIC_API_ENDPOINTS = {
  // GitHub Copilot's chat completions endpoint (OpenAI-compatible, supports Claude models)
  COPILOT_ANTHROPIC_CHAT: env.COPILOT_CHAT_ENDPOINT,
};

// Claude model mappings: Claude Code model names -> Copilot model names
// Uses prefix matching, so 'claude-opus-4-5' matches 'claude-opus-4-5-20251001' etc.
export const CLAUDE_MODEL_MAPPINGS: Record<string, string> = {
  // Claude Opus 4.5 / 4.1 / 4
  'claude-opus-4-5': 'claude-opus-4.5',
  'claude-opus-4-1': 'claude-opus-4.1',
  'claude-opus-4': 'claude-opus-4',
  'claude-3-opus': 'claude-opus-4.5',
  'opusplan': 'claude-opus-4.5',
  'opus': 'claude-opus-4.5',

  // Claude Sonnet 4.5 / 4 / 3.7 / 3.5
  'claude-sonnet-4-5': 'claude-sonnet-4.5',
  'claude-sonnet-4': 'claude-sonnet-4',
  'claude-3-7-sonnet': 'claude-3.7-sonnet',
  'claude-3-5-sonnet': 'claude-3.5-sonnet',
  'sonnet': 'claude-sonnet-4.5',

  // Claude Haiku 4.5 / 3.5 (Claude Code's background/"small fast" model)
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-3-5-haiku': 'claude-haiku-4.5',
  'haiku': 'claude-haiku-4.5',
};

// Models advertised on GET /v1/models. `DEFAULT_CLAUDE_MODEL` decides which
// Copilot model unrecognised Claude identifiers fall back to.
export const AVAILABLE_CLAUDE_MODELS = [
  {
    id: 'claude-opus-4-5',
    display_name: 'Claude Opus 4.5',
    copilot_model: 'claude-opus-4.5',
  },
  {
    id: 'claude-sonnet-4-5',
    display_name: 'Claude Sonnet 4.5',
    copilot_model: 'claude-sonnet-4.5',
  },
  {
    id: 'claude-haiku-4-5',
    display_name: 'Claude Haiku 4.5',
    copilot_model: 'claude-haiku-4.5',
  },
  {
    id: 'claude-sonnet-4',
    display_name: 'Claude Sonnet 4',
    copilot_model: 'claude-sonnet-4',
  },
  {
    id: 'claude-opus-4-1',
    display_name: 'Claude Opus 4.1',
    copilot_model: 'claude-opus-4.1',
  },
  // Optional: GPT and Gemini models (pass-through, user must specify in settings)
  {
    id: 'gpt-5.2',
    display_name: 'GPT 5.2 (Optional)',
    copilot_model: 'gpt-5.2',
  },
  {
    id: 'gemini-3-pro-preview',
    display_name: 'Gemini 3 Pro Preview (Optional)',
    copilot_model: 'gemini-3-pro-preview',
  },
];

// Configuration object
export const config = {
  version: pkg.version,
  isDevelopment: env.NODE_ENV === 'development',
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  server: {
    port: parseInt(env.PORT, 10),
    host: env.HOST,
  },
  logging: {
    level: env.LOG_LEVEL,
  },
  github: {
    copilot: {
      clientId: env.GITHUB_COPILOT_CLIENT_ID,
      apiEndpoints: API_ENDPOINTS,
      anthropicEndpoints: ANTHROPIC_API_ENDPOINTS,
    }
  },
  copilot: {
    integrationId: env.COPILOT_INTEGRATION_ID,
    editorVersion: env.COPILOT_EDITOR_VERSION,
    pluginVersion: env.COPILOT_PLUGIN_VERSION,
    userAgent: env.COPILOT_USER_AGENT,
  },
  anthropic: {
    defaultModel: env.DEFAULT_CLAUDE_MODEL,
    maxOutputTokens: parseInt(env.MAX_OUTPUT_TOKENS, 10),
    streamUpstream: env.ENABLE_UPSTREAM_STREAMING === 'true',
  },
  rateLimits: {
    default: parseInt(env.RATE_LIMIT_DEFAULT, 10),
    chatCompletions: parseInt(env.RATE_LIMIT_CHAT_COMPLETIONS, 10),
    // Token usage thresholds. Claude Code routinely sends very large
    // contexts, so these are advisory ceilings rather than tight limits.
    maxTokensPerRequest: parseInt(process.env.MAX_TOKENS_PER_REQUEST ?? '0', 10),
    maxTokensPerMinute: parseInt(process.env.MAX_TOKENS_PER_MINUTE ?? '0', 10),
    tokenRateLimitResetTime: 60 * 1000, // 1 minute in ms
  }
};
