/**
 * Anthropic API routes - the endpoints Claude Code talks to.
 *
 * Implements the subset of the Anthropic Messages API that Claude Code uses:
 * `POST /v1/messages` (streaming and buffered), `POST /v1/messages/count_tokens`,
 * `GET /v1/models` and `GET /v1/models/:model`.
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  ensureCopilotToken,
  getCopilotToken,
  isTokenValid,
} from '../services/auth-service.js';
import {
  CopilotApiError,
  createAnthropicError,
  estimateInputTokens,
  makeAnthropicCompletionRequest,
  streamAnthropicMessage,
} from '../services/anthropic-service.js';
import { getAvailableModels, getModelById } from '../utils/model-mapper.js';
import { refreshModelCatalog } from '../services/model-catalog.js';
import {
  AnthropicCountTokensRequest,
  AnthropicError,
  AnthropicMessageRequest,
  AnthropicStreamEvent,
} from '../types/anthropic.js';
import { logger } from '../utils/logger.js';
import { trackRequest, trackTokens } from '../services/usage-service.js';
import { abortOnDisconnect, writeResponse } from '../utils/response-stream.js';
import { UpstreamTimeoutError } from '../utils/upstream-fetch.js';

export const anthropicRoutes = express.Router();

/**
 * Ensure a usable GitHub Copilot token is available, refreshing it when the
 * cached one has expired.
 */
const requireAuth = async (
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  if (isTokenValid()) {
    return next();
  }

  try {
    await ensureCopilotToken();
    return next();
  } catch (error) {
    logger.warn('Copilot authentication unavailable');
    return res
      .status(401)
      .json(
        createAnthropicError(
          'authentication_error',
          'GitHub Copilot authentication required. Please authenticate at /auth.html'
        )
      );
  }
};

/**
 * Validate an incoming Messages API request.
 *
 * @returns An Anthropic error body when the request is invalid, otherwise null
 */
function validateMessageRequest(request: AnthropicMessageRequest): AnthropicError | null {
  if (!request || typeof request !== 'object') {
    return createAnthropicError('invalid_request_error', 'Request body must be a JSON object');
  }

  if (!request.model || typeof request.model !== 'string') {
    return createAnthropicError('invalid_request_error', 'model: field required');
  }

  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return createAnthropicError('invalid_request_error', 'messages: field required');
  }

  if (!Number.isSafeInteger(request.max_tokens) || request.max_tokens <= 0) {
    return createAnthropicError(
      'invalid_request_error',
      'max_tokens: field required and must be a positive integer'
    );
  }

  for (const message of request.messages) {
    // `system` is permitted by the mid-conversation-system beta that Claude Code sends.
    if (!message || !['user', 'assistant', 'system'].includes(message.role)) {
      return createAnthropicError(
        'invalid_request_error',
        'messages: each message must have a valid role (user, assistant or system)'
      );
    }
    if (message.content === undefined || message.content === null) {
      return createAnthropicError(
        'invalid_request_error',
        'messages: each message must have content'
      );
    }
  }

  return null;
}

/**
 * Translate a thrown error into an Anthropic error body plus HTTP status.
 */
function toAnthropicErrorResponse(error: unknown): { status: number; body: AnthropicError } {
  if (error instanceof Error && error.name === 'ModelSelectionError') {
    return { status: 400, body: createAnthropicError('invalid_request_error', error.message) };
  }
  if (error instanceof UpstreamTimeoutError) {
    return { status: 504, body: createAnthropicError('api_error', error.message) };
  }
  if (error instanceof CopilotApiError) {
    return {
      status: error.status,
      body: createAnthropicError(error.errorType, error.message),
    };
  }

  return {
    status: 500,
    body: createAnthropicError(
      'api_error',
      'Internal server error'
    ),
  };
}

// GET /v1/models - list every Copilot model the account can use
anthropicRoutes.get('/models', requireAuth, async (_req, res) => {
  await refreshModelCatalog();
  res.json(getAvailableModels());
});

// GET /v1/models/:model - describe a single model
anthropicRoutes.get('/models/:model', requireAuth, async (req, res) => {
  await refreshModelCatalog();
  const model = getModelById(req.params.model);

  if (!model) {
    return res
      .status(404)
      .json(createAnthropicError('not_found_error', `model: ${req.params.model} not found`));
  }

  return res.json(model);
});

// POST /v1/messages/count_tokens - local token estimate
anthropicRoutes.post('/messages/count_tokens', requireAuth, (req, res) => {
  const { messages, system, tools } = (req.body ?? {}) as AnthropicCountTokensRequest;

  res.json({ input_tokens: estimateInputTokens(messages ?? [], system, tools) });
});

// POST /v1/messages - the main Claude Code endpoint
anthropicRoutes.post('/messages', requireAuth, async (req, res) => {
  const sessionId: string = res.locals.sessionId || uuidv4();
  const request = req.body as AnthropicMessageRequest;

  const validationError = validateMessageRequest(request);
  if (validationError) {
    return res.status(400).json(validationError);
  }

  const copilotToken = getCopilotToken();
  if (!copilotToken) {
    return res
      .status(401)
      .json(createAnthropicError('authentication_error', 'GitHub Copilot token not available'));
  }

  trackRequest(sessionId);
  const { signal, cleanup } = abortOnDisconnect(res);
  try {
    await refreshModelCatalog({ signal });
    if (signal.aborted) {
      return;
    }
    if (request.stream) {
      return await handleStreamingMessage(res, request, copilotToken.token, sessionId, signal);
    }
    const response = await makeAnthropicCompletionRequest(request, copilotToken.token, signal);
    trackTokens(sessionId, response.usage.input_tokens + response.usage.output_tokens);
    if (signal.aborted || res.destroyed) {
      return;
    }
    return res.json(response);
  } catch (error) {
    if (signal.aborted || res.destroyed) {
      return;
    }
    logger.error('Anthropic completion failed');
    const { status, body } = toAnthropicErrorResponse(error);
    return res.status(status).json(body);
  } finally {
    cleanup();
  }
});

/**
 * Write a single Anthropic SSE event.
 */
function writeEvent(res: express.Response, event: AnthropicStreamEvent): Promise<boolean> {
  return writeResponse(res, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

/**
 * Stream a response to Claude Code in Anthropic SSE format.
 */
async function handleStreamingMessage(
  res: express.Response,
  request: AnthropicMessageRequest,
  copilotToken: string,
  sessionId: string,
  signal: AbortSignal
): Promise<void> {
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    for await (const event of streamAnthropicMessage(request, copilotToken, signal)) {
      if (signal.aborted || res.destroyed) {
        logger.debug('Client disconnected, aborting stream');
        break;
      }

      if (!res.headersSent) {
        // Headers are only committed once the upstream call succeeds, so that
        // early failures can still be reported with a real status code.
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
      }

      if (event.type === 'message_start') {
        inputTokens = event.message.usage.input_tokens;
      } else if (event.type === 'message_delta') {
        inputTokens = event.usage.input_tokens ?? inputTokens;
        outputTokens = event.usage.output_tokens;
      }

      if (!await writeEvent(res, event)) {
        break;
      }
    }

    if (!signal.aborted && !res.destroyed) {
      res.end();
    }
  } catch (error) {
    logger.error('Anthropic streaming failed');
    const { status, body } = toAnthropicErrorResponse(error);

    if (signal.aborted || res.destroyed) {
      return;
    }

    if (!res.headersSent) {
      res.status(status).json(body);
      return;
    }

    if (await writeEvent(res, { type: 'error', error: body.error })) {
      res.end();
    }
  } finally {
    trackTokens(sessionId, inputTokens + outputTokens);
  }
}
