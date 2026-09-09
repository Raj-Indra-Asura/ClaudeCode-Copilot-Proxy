/**
 * Model mapping utilities for Claude Code -> GitHub Copilot
 *
 * Supports Claude, GPT, Gemini, and other models available in Copilot.
 */

import { AVAILABLE_CLAUDE_MODELS, CLAUDE_MODEL_MAPPINGS, config } from '../config/index.js';
import { AnthropicModel, AnthropicModelList } from '../types/anthropic.js';

/**
 * Map a model name to the Copilot model name.
 *
 * Claude Code sends dated identifiers (`claude-sonnet-4-5-20250929`) and short
 * aliases (`sonnet`, `haiku`, `opusplan`). Matching is done longest-prefix
 * first so `claude-sonnet-4-5-...` never falls back to the `claude-sonnet-4`
 * entry.
 *
 * @param model - The requested model name
 * @returns The corresponding Copilot model name
 */
export function mapClaudeModelToCopilot(model: string): string {
  if (!model) {
    return config.anthropic.defaultModel;
  }

  const normalized = model.trim().toLowerCase();

  const direct = CLAUDE_MODEL_MAPPINGS[normalized];
  if (direct) {
    return direct;
  }

  // Already a Copilot model identifier (e.g. "claude-sonnet-4.5").
  if (Object.values(CLAUDE_MODEL_MAPPINGS).includes(normalized)) {
    return normalized;
  }

  // Longest matching prefix wins so dated suffixes resolve correctly.
  const prefixMatch = Object.keys(CLAUDE_MODEL_MAPPINGS)
    .filter((key) => normalized.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];

  if (prefixMatch) {
    return CLAUDE_MODEL_MAPPINGS[prefixMatch];
  }

  // Unknown Claude variants fall back to the configured default so Claude Code
  // never fails outright on a model rename.
  if (normalized.startsWith('claude')) {
    return config.anthropic.defaultModel;
  }

  // Non-Claude models (GPT, Gemini, ...) pass through untouched.
  return model;
}

/**
 * Check if a model is a known Claude model.
 *
 * @param model - The model name to check
 * @returns True if the model is a known Claude model
 */
export function isValidClaudeModel(model: string): boolean {
  if (!model) {
    return false;
  }

  const normalized = model.trim().toLowerCase();

  if (CLAUDE_MODEL_MAPPINGS[normalized]) {
    return true;
  }

  if (Object.values(CLAUDE_MODEL_MAPPINGS).includes(normalized)) {
    return true;
  }

  return normalized.startsWith('claude');
}

/**
 * Build an Anthropic `/v1/models` entry.
 */
function toAnthropicModel(model: { id: string; display_name: string }): AnthropicModel {
  return {
    type: 'model',
    id: model.id,
    display_name: model.display_name,
    created_at: new Date(0).toISOString(),
  };
}

/**
 * Get the list of available models for the `/v1/models` endpoint, in
 * Anthropic's pagination envelope.
 */
export function getAvailableModels(): AnthropicModelList {
  const models: AnthropicModel[] = AVAILABLE_CLAUDE_MODELS.map(toAnthropicModel);

  return {
    data: models,
    has_more: false,
    first_id: models[0]?.id ?? null,
    last_id: models[models.length - 1]?.id ?? null,
  };
}

/**
 * Look up a single model for `GET /v1/models/:model`.
 *
 * @returns The model entry, or null when the model is not recognised
 */
export function getModelById(modelId: string): AnthropicModel | null {
  const found = AVAILABLE_CLAUDE_MODELS.find(
    (model) => model.id === modelId || model.copilot_model === modelId
  );

  if (found) {
    return toAnthropicModel(found);
  }

  // Claude Code also asks about dated aliases; report those as valid too.
  if (isValidClaudeModel(modelId)) {
    return toAnthropicModel({ id: modelId, display_name: getModelDisplayName(modelId) });
  }

  return null;
}

/**
 * Get a human-readable display name for a model.
 *
 * @param model - The model name
 * @returns Human-readable display name
 */
export function getModelDisplayName(model: string): string {
  const found = AVAILABLE_CLAUDE_MODELS.find(
    (m) => m.id === model || m.copilot_model === model
  );

  if (found) {
    return found.display_name;
  }

  return model
    .replace(/-/g, ' ')
    .replace(/(\d+)/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
