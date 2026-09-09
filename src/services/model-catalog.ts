/**
 * Live GitHub Copilot model catalog.
 *
 * Copilot advertises exactly the models an account is entitled to at
 * `GET {endpoints.api}/models`. Claude Code should see that list - not a
 * hardcoded snapshot that drifts every time Copilot rotates a model ID - so the
 * catalog is fetched on demand, cached, and used for `/v1/models`, alias
 * resolution and per-model output limits.
 *
 * Every failure path falls back to the last good snapshot (or an empty one, in
 * which case the static config in `config/index.ts` still applies), so the
 * proxy keeps working offline or before authentication.
 */

import fetch from 'node-fetch';
import { config } from '../config/index.js';
import { getCopilotToken } from './auth-service.js';
import { buildCopilotHeaders } from '../utils/copilot-headers.js';
import { logger } from '../utils/logger.js';

/** How long a fetched catalog is considered fresh. */
const CATALOG_TTL_MS = 10 * 60 * 1000;

/** A chat model offered by the signed-in Copilot account. */
export interface CatalogModel {
  id: string;
  displayName: string;
  vendor: string;
  family?: string;
  /** Anthropic-vendored (Claude) model. */
  isClaude: boolean;
  /** Copilot shows this model in its own picker. */
  pickerEnabled: boolean;
  isChatDefault: boolean;
  maxOutputTokens?: number;
  maxContextTokens?: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

/** Subset of Copilot's `/models` payload that this proxy relies on. */
interface RawCopilotModel {
  id?: string;
  name?: string;
  vendor?: string;
  preview?: boolean;
  model_picker_enabled?: boolean;
  is_chat_default?: boolean;
  policy?: { state?: string };
  capabilities?: {
    type?: string;
    family?: string;
    limits?: {
      max_output_tokens?: number;
      max_context_window_tokens?: number;
      vision?: unknown;
    };
    supports?: {
      tool_calls?: boolean;
      vision?: boolean;
      streaming?: boolean;
    };
  };
}

let catalog: CatalogModel[] = [];
let fetchedAt = 0;
let inFlight: Promise<CatalogModel[]> | null = null;

/**
 * Resolve the account-specific `/models` URL.
 *
 * Mirrors `resolveCopilotChatEndpoint`: the host advertised by the Copilot
 * token wins, because individual and business plans are served from different
 * hosts.
 */
function resolveModelsEndpoint(): string {
  const api = getCopilotToken()?.endpoints?.api;
  if (api) {
    return `${api.replace(/\/+$/, '')}/models`;
  }

  return config.github.copilot.anthropicEndpoints.COPILOT_ANTHROPIC_CHAT.replace(
    /\/chat\/completions\/?$/,
    '/models'
  );
}

/**
 * Normalise one upstream entry, or null when it is not a usable chat model.
 */
function toCatalogModel(raw: RawCopilotModel): CatalogModel | null {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  if (!id) {
    return null;
  }

  // Embedding and completion models cannot serve Messages API traffic.
  const type = raw.capabilities?.type;
  if (type && type !== 'chat') {
    return null;
  }

  // Models gated behind an org policy the user has not accepted return 403.
  const policyState = raw.policy?.state;
  if (policyState && policyState !== 'enabled') {
    return null;
  }

  const vendor = raw.vendor ?? '';
  const limits = raw.capabilities?.limits;

  return {
    id,
    displayName: raw.name?.trim() || id,
    vendor,
    family: raw.capabilities?.family,
    isClaude: vendor.toLowerCase() === 'anthropic' || id.toLowerCase().startsWith('claude'),
    pickerEnabled: raw.model_picker_enabled !== false,
    isChatDefault: raw.is_chat_default === true,
    maxOutputTokens:
      typeof limits?.max_output_tokens === 'number' ? limits.max_output_tokens : undefined,
    maxContextTokens:
      typeof limits?.max_context_window_tokens === 'number'
        ? limits.max_context_window_tokens
        : undefined,
    supportsTools: raw.capabilities?.supports?.tool_calls !== false,
    supportsVision:
      raw.capabilities?.supports?.vision === true || limits?.vision !== undefined,
  };
}

/**
 * The cached catalog. Empty until the first successful fetch, which lets every
 * caller degrade to the static configuration.
 */
export function getCatalogSnapshot(): CatalogModel[] {
  return catalog;
}

/** Claude models from the cached catalog. */
export function getClaudeCatalogModels(): CatalogModel[] {
  return catalog.filter((model) => model.isClaude);
}

/** Case-insensitive lookup against the cached catalog. */
export function findCatalogModel(id: string): CatalogModel | undefined {
  if (!id) {
    return undefined;
  }

  const normalized = id.trim().toLowerCase();
  return catalog.find((model) => model.id.toLowerCase() === normalized);
}

/** Upstream output-token ceiling for a model, when Copilot published one. */
export function getCatalogOutputLimit(id: string): number | undefined {
  return findCatalogModel(id)?.maxOutputTokens;
}

/**
 * Fetch the catalog, reusing the cached copy while it is fresh.
 *
 * Never rejects: on failure the previous snapshot is returned so a transient
 * upstream error cannot empty Claude Code's model list.
 */
export async function refreshModelCatalog(
  options: { force?: boolean } = {}
): Promise<CatalogModel[]> {
  const isFresh = catalog.length > 0 && Date.now() - fetchedAt < CATALOG_TTL_MS;
  if (!options.force && isFresh) {
    return catalog;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = fetchCatalog().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

async function fetchCatalog(): Promise<CatalogModel[]> {
  const token = getCopilotToken()?.token;
  if (!token) {
    return catalog;
  }

  const url = resolveModelsEndpoint();

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: buildCopilotHeaders(token, { stream: false, hasImages: false }),
    });

    if (!response.ok) {
      logger.warn('Copilot model catalog request failed', {
        status: response.status,
        statusText: response.statusText,
      });
      return catalog;
    }

    const payload = (await response.json()) as { data?: RawCopilotModel[] };
    const models: CatalogModel[] = [];
    const seen = new Set<string>();

    for (const raw of payload?.data ?? []) {
      const model = toCatalogModel(raw);
      if (!model) {
        continue;
      }
      const key = model.id.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      models.push(model);
    }

    if (models.length === 0) {
      logger.warn('Copilot model catalog was empty, keeping previous snapshot');
      return catalog;
    }

    catalog = models;
    fetchedAt = Date.now();

    logger.info('Loaded Copilot model catalog', {
      total: models.length,
      claude: models.filter((model) => model.isClaude).length,
    });

    return catalog;
  } catch (error) {
    logger.warn(
      `Could not load Copilot model catalog: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return catalog;
  }
}

/**
 * Warm the catalog in the background at startup. Safe to call unauthenticated.
 */
export function primeModelCatalog(): void {
  void refreshModelCatalog();
}

/** Test hook: replace or clear the cached catalog. */
export function setCatalogForTesting(models: CatalogModel[]): void {
  catalog = models;
  fetchedAt = models.length > 0 ? Date.now() : 0;
}
