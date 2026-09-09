/**
 * Anthropic Service - translation layer between Claude Code and GitHub Copilot.
 *
 * Claude Code speaks the Anthropic Messages API. GitHub Copilot exposes the
 * same Claude models behind an OpenAI-style chat completions endpoint. This
 * module performs a full, lossless-as-possible translation in both directions,
 * including tool calling, images, and server-sent-event streaming - the three
 * features Claude Code depends on for day-to-day work.
 */

import fetch, { Response } from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/index.js';
import {
  AnthropicError,
  AnthropicMessage,
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicStopReason,
  AnthropicStreamEvent,
  AnthropicSystemPrompt,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicUsage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
} from '../types/anthropic.js';
import {
  CopilotChatMessage,
  CopilotChatRequest,
  CopilotChatResponse,
  CopilotChatStreamChunk,
  CopilotContentPart,
  CopilotTool,
  CopilotToolCall,
  CopilotToolChoice,
} from '../types/copilot-chat.js';
import { mapClaudeModelToCopilot } from '../utils/model-mapper.js';
import { getMachineId } from '../utils/machine-id.js';
import { logger } from '../utils/logger.js';

/** Average characters per token, used for local estimates only. */
const CHARS_PER_TOKEN = 4;

/** OpenAI-style tool names accept `[a-zA-Z0-9_-]{1,64}`. */
const TOOL_NAME_PATTERN = /[^a-zA-Z0-9_-]/g;

/**
 * Error raised when GitHub Copilot rejects a request. Carries the upstream
 * status so the route layer can mirror it back to Claude Code instead of
 * flattening everything into a 500.
 */
export class CopilotApiError extends Error {
  readonly status: number;
  readonly errorType: AnthropicError['error']['type'];

  constructor(status: number, message: string) {
    super(message);
    this.name = 'CopilotApiError';
    this.status = status;
    this.errorType = mapStatusToAnthropicErrorType(status);
  }
}

/**
 * Map an upstream HTTP status onto an Anthropic error type.
 */
export function mapStatusToAnthropicErrorType(
  status: number
): AnthropicError['error']['type'] {
  switch (status) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 413:
      return 'invalid_request_error';
    case 429:
      return 'rate_limit_error';
    case 502:
    case 503:
    case 504:
      return 'overloaded_error';
    default:
      return 'api_error';
  }
}

// ============================================================================
// Request translation: Anthropic -> Copilot
// ============================================================================

/**
 * Flatten an Anthropic system prompt (string or array of text blocks) into a
 * single string. Claude Code always sends the array form.
 */
export function normalizeSystemPrompt(system?: AnthropicSystemPrompt): string {
  if (!system) {
    return '';
  }

  if (typeof system === 'string') {
    return system;
  }

  if (!Array.isArray(system)) {
    return '';
  }

  return system
    .filter((block): block is TextBlock => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n');
}

/**
 * Extract the plain text of Anthropic message content, ignoring non-text blocks.
 */
export function extractTextContent(content: string | ContentBlock[] | undefined): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((block): block is TextBlock => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Convert an Anthropic image block into an OpenAI-style image part.
 * Returns null when the block carries no usable payload.
 */
function convertImageBlock(block: Extract<ContentBlock, { type: 'image' }>): CopilotContentPart | null {
  const source = block.source;
  if (!source) {
    return null;
  }

  if (source.type === 'url' && source.url) {
    return { type: 'image_url', image_url: { url: source.url } };
  }

  if (source.type === 'base64' && source.data) {
    const mediaType = source.media_type || 'image/png';
    return {
      type: 'image_url',
      image_url: { url: `data:${mediaType};base64,${source.data}` },
    };
  }

  return null;
}

/**
 * Flatten `tool_result` content (string or nested blocks) into text that the
 * Copilot API accepts on a `tool` role message.
 */
export function flattenToolResultContent(content: string | ContentBlock[] | undefined): string {
  if (content === undefined || content === null) {
    return '';
  }

  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return String(content);
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'image') {
      // `tool` role messages are text-only upstream.
      parts.push('[image omitted]');
    }
  }

  return parts.join('\n');
}

/**
 * Sanitize a tool name so it satisfies the upstream tool-name constraints.
 */
export function sanitizeToolName(name: string): string {
  const sanitized = name.replace(TOOL_NAME_PATTERN, '_');
  return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

/**
 * Build the sanitized-name -> original-name lookup used to restore Claude
 * Code's tool names on the way back.
 */
export function buildToolNameMap(tools?: AnthropicTool[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools ?? []) {
    if (!tool?.name) {
      continue;
    }
    map.set(sanitizeToolName(tool.name), tool.name);
  }
  return map;
}

/**
 * Convert Anthropic tool definitions into Copilot/OpenAI function tools.
 */
export function convertAnthropicToolsToCopilot(tools?: AnthropicTool[]): CopilotTool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const converted = tools
    .filter((tool) => Boolean(tool?.name))
    .map((tool) => ({
      type: 'function' as const,
      function: {
        name: sanitizeToolName(tool.name),
        description: tool.description,
        parameters: (tool.input_schema as Record<string, unknown>) ?? {
          type: 'object',
          properties: {},
        },
      },
    }));

  return converted.length > 0 ? converted : undefined;
}

/**
 * Convert Anthropic `tool_choice` into the Copilot/OpenAI equivalent.
 */
export function convertAnthropicToolChoiceToCopilot(
  toolChoice?: AnthropicToolChoice
): CopilotToolChoice | undefined {
  if (!toolChoice) {
    return undefined;
  }

  switch (toolChoice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return { type: 'function', function: { name: sanitizeToolName(toolChoice.name) } };
    default:
      return undefined;
  }
}

/**
 * Convert Anthropic messages (plus an optional system prompt) into the
 * Copilot chat message list.
 *
 * Anthropic packs tool results into the *next user* message as
 * `tool_result` blocks; OpenAI expects them as standalone `tool` role
 * messages placed directly after the assistant turn that requested them. This
 * function performs that re-ordering.
 */
export function convertAnthropicMessagesToCopilot(
  messages: AnthropicMessage[],
  system?: AnthropicSystemPrompt
): CopilotChatMessage[] {
  const result: CopilotChatMessage[] = [];

  const systemPrompt = normalizeSystemPrompt(system);
  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const message of messages ?? []) {
    if (!message || !message.role) {
      continue;
    }

    if (typeof message.content === 'string') {
      // An empty assistant turn would be rejected upstream; skip it.
      if (message.content.length === 0 && message.role === 'assistant') {
        continue;
      }
      result.push({ role: message.role, content: message.content });
      continue;
    }

    const blocks = Array.isArray(message.content) ? message.content : [];

    if (message.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: CopilotToolCall[] = [];

      for (const block of blocks) {
        if (!block || typeof block !== 'object') {
          continue;
        }
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: sanitizeToolName(block.name),
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
        // `thinking` blocks are intentionally dropped: Copilot has no
        // equivalent field and echoing them back confuses the model.
      }

      if (textParts.length === 0 && toolCalls.length === 0) {
        continue;
      }

      const assistantMessage: CopilotChatMessage = {
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('\n') : null,
      };
      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls;
      }
      result.push(assistantMessage);
      continue;
    }

    // User turn: emit tool results first, then the remaining content.
    const userParts: CopilotContentPart[] = [];

    for (const block of blocks) {
      if (!block || typeof block !== 'object') {
        continue;
      }

      if (block.type === 'tool_result') {
        const text = flattenToolResultContent(block.content);
        result.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: block.is_error && text ? `Error: ${text}` : text || '(no output)',
        });
      } else if (block.type === 'text') {
        userParts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        const imagePart = convertImageBlock(block);
        if (imagePart) {
          userParts.push(imagePart);
        }
      }
    }

    if (userParts.length === 0) {
      continue;
    }

    const isTextOnly = userParts.every((part) => part.type === 'text');
    result.push({
      role: 'user',
      content: isTextOnly
        ? userParts.map((part) => (part as { text: string }).text).join('\n')
        : userParts,
    });
  }

  return result;
}

/**
 * True when any message carries an image, which requires the Copilot vision
 * request header.
 */
export function requestHasImages(messages: AnthropicMessage[]): boolean {
  return (messages ?? []).some(
    (message) =>
      Array.isArray(message?.content) &&
      message.content.some((block) => block?.type === 'image')
  );
}

/**
 * Build the full Copilot chat request body for an Anthropic message request.
 */
export function buildCopilotChatRequest(
  request: AnthropicMessageRequest,
  options: { stream: boolean }
): CopilotChatRequest {
  const copilotModel = mapClaudeModelToCopilot(request.model);

  const body: CopilotChatRequest = {
    model: copilotModel,
    messages: convertAnthropicMessagesToCopilot(request.messages, request.system),
    stream: options.stream,
  };

  const maxTokens = request.max_tokens;
  if (typeof maxTokens === 'number' && maxTokens > 0) {
    body.max_tokens = Math.min(maxTokens, config.anthropic.maxOutputTokens);
  }

  if (typeof request.temperature === 'number') {
    body.temperature = request.temperature;
  }

  if (typeof request.top_p === 'number') {
    body.top_p = request.top_p;
  }

  if (Array.isArray(request.stop_sequences) && request.stop_sequences.length > 0) {
    body.stop = request.stop_sequences;
  }

  const tools = convertAnthropicToolsToCopilot(request.tools);
  if (tools) {
    body.tools = tools;
    const toolChoice = convertAnthropicToolChoiceToCopilot(request.tool_choice);
    if (toolChoice) {
      body.tool_choice = toolChoice;
    }
  }

  return body;
}

/**
 * Build the headers required by GitHub Copilot's chat endpoint.
 */
export function buildCopilotHeaders(
  copilotToken: string,
  options: { stream: boolean; hasImages: boolean }
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: options.stream ? 'text/event-stream' : 'application/json',
    Authorization: 'Bearer ' + copilotToken,
    'X-Request-Id': uuidv4(),
    'X-Github-Api-Version': '2025-05-01',
    'Machine-Id': getMachineId(),
    'Copilot-Integration-Id': config.copilot.integrationId,
    'Editor-Version': config.copilot.editorVersion,
    'Editor-Plugin-Version': config.copilot.pluginVersion,
    'User-Agent': config.copilot.userAgent,
    'Openai-Intent': 'conversation-panel',
  };

  if (options.hasImages) {
    headers['Copilot-Vision-Request'] = 'true';
  }

  return headers;
}

// ============================================================================
// Response translation: Copilot -> Anthropic
// ============================================================================

/**
 * Map an OpenAI finish reason onto an Anthropic stop reason.
 */
export function mapFinishReasonToStopReason(
  finishReason: string | null | undefined,
  hasToolUse: boolean
): AnthropicStopReason {
  if (hasToolUse) {
    return 'tool_use';
  }

  switch (finishReason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    case 'stop':
    default:
      return 'end_turn';
  }
}

/**
 * Safely parse a tool call argument string into an object.
 */
export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw || raw.trim() === '') {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    logger.warn('Failed to parse tool call arguments as JSON, forwarding as raw text');
    return { __raw: raw };
  }
}

/**
 * Convert a Copilot chat completion response into an Anthropic message.
 */
export function convertCopilotToAnthropicResponse(
  data: CopilotChatResponse,
  model: string,
  toolNameMap: Map<string, string> = new Map()
): AnthropicMessageResponse {
  const choice = data?.choices?.[0];
  const message = choice?.message;

  const content: ContentBlock[] = [];

  const text = typeof message?.content === 'string' ? message.content : '';
  if (text) {
    content.push({ type: 'text', text });
  }

  for (const toolCall of message?.tool_calls ?? []) {
    if (!toolCall?.function?.name) {
      continue;
    }
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: toolCall.id || `toolu_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
      name: toolNameMap.get(toolCall.function.name) ?? toolCall.function.name,
      input: parseToolArguments(toolCall.function.arguments),
    };
    content.push(block);
  }

  // Anthropic clients expect at least one content block.
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const hasToolUse = content.some((block) => block.type === 'tool_use');

  const usage: AnthropicUsage = {
    input_tokens: data?.usage?.prompt_tokens ?? 0,
    output_tokens: data?.usage?.completion_tokens ?? 0,
  };

  return {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: mapFinishReasonToStopReason(choice?.finish_reason, hasToolUse),
    stop_sequence: null,
    usage,
  };
}

// ============================================================================
// Upstream requests
// ============================================================================

/**
 * Send a request to GitHub Copilot's chat endpoint.
 *
 * @throws {CopilotApiError} When Copilot responds with a non-2xx status.
 */
async function postToCopilot(
  request: AnthropicMessageRequest,
  copilotToken: string,
  stream: boolean
): Promise<Response> {
  const body = buildCopilotChatRequest(request, { stream });
  const headers = buildCopilotHeaders(copilotToken, {
    stream,
    hasImages: requestHasImages(request.messages),
  });

  logger.debug('Requesting Copilot chat completion', {
    model: body.model,
    requestedModel: request.model,
    messages: body.messages.length,
    tools: body.tools?.length ?? 0,
    stream,
  });

  const response = await fetch(config.github.copilot.anthropicEndpoints.COPILOT_ANTHROPIC_CHAT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    logger.error('Copilot chat API error', {
      status: response.status,
      statusText: response.statusText,
      body: errorText.slice(0, 2000),
    });
    throw new CopilotApiError(
      response.status,
      extractUpstreamErrorMessage(errorText) ||
        `Copilot API error: ${response.status} ${response.statusText}`
    );
  }

  return response;
}

/**
 * Pull a human-readable message out of an upstream error payload.
 */
function extractUpstreamErrorMessage(body: string): string {
  if (!body) {
    return '';
  }

  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === 'string') {
      return parsed.error;
    }
    if (parsed.error?.message) {
      return parsed.error.message;
    }
    if (parsed.message) {
      return parsed.message;
    }
  } catch {
    // Fall through to the raw body.
  }

  return body.slice(0, 500);
}

/**
 * Perform a non-streaming completion and return an Anthropic message.
 */
export async function makeAnthropicCompletionRequest(
  request: AnthropicMessageRequest,
  copilotToken: string
): Promise<AnthropicMessageResponse> {
  const response = await postToCopilot(request, copilotToken, false);
  const data = (await response.json()) as CopilotChatResponse;
  return convertCopilotToAnthropicResponse(data, request.model, buildToolNameMap(request.tools));
}

/**
 * Parse a raw SSE body into Copilot stream chunks.
 */
export async function* parseCopilotSseStream(
  body: NodeJS.ReadableStream
): AsyncGenerator<CopilotChatStreamChunk> {
  let buffer = '';

  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');

    // SSE events are separated by a blank line.
    let separator = /\r?\n\r?\n/.exec(buffer);
    while (separator) {
      const rawEvent = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);

      const dataLines = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());

      for (const data of dataLines) {
        if (!data || data === '[DONE]') {
          continue;
        }
        try {
          yield JSON.parse(data) as CopilotChatStreamChunk;
        } catch {
          logger.warn('Skipping unparsable SSE payload from Copilot');
        }
      }

      separator = /\r?\n\r?\n/.exec(buffer);
    }
  }
}

// ============================================================================
// Anthropic streaming
// ============================================================================

interface StreamingToolCall {
  /** Index of the Anthropic content block for this tool call. */
  blockIndex: number;
  id: string;
  name: string;
  argumentsJson: string;
}

/**
 * Run a streaming completion and yield Anthropic SSE events.
 *
 * When `config.anthropic.streamUpstream` is disabled, or the upstream response
 * is not a stream, this falls back to a buffered request and emits the same
 * event sequence so clients cannot tell the difference.
 */
export async function* streamAnthropicMessage(
  request: AnthropicMessageRequest,
  copilotToken: string
): AsyncGenerator<AnthropicStreamEvent> {
  const messageId = generateMessageId();
  const toolNameMap = buildToolNameMap(request.tools);

  if (!config.anthropic.streamUpstream) {
    const response = await makeAnthropicCompletionRequest(request, copilotToken);
    yield* replayResponseAsEvents(messageId, request.model, response);
    return;
  }

  const response = await postToCopilot(request, copilotToken, true);

  if (!response.body) {
    throw new CopilotApiError(502, 'Copilot returned an empty streaming response');
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let startedMessage = false;
  let textBlockIndex: number | null = null;
  let nextBlockIndex = 0;
  let finishReason: string | null = null;
  const toolCalls = new Map<number, StreamingToolCall>();

  const emitMessageStart = function* (): Generator<AnthropicStreamEvent> {
    if (startedMessage) {
      return;
    }
    startedMessage = true;
    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: request.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    };
  };

  for await (const chunk of parseCopilotSseStream(response.body as NodeJS.ReadableStream)) {
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
    }

    const choice = chunk.choices?.[0];
    if (!choice) {
      continue;
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }

    const delta = choice.delta;
    if (!delta) {
      continue;
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      yield* emitMessageStart();

      if (textBlockIndex === null) {
        textBlockIndex = nextBlockIndex++;
        yield {
          type: 'content_block_start',
          index: textBlockIndex,
          content_block: { type: 'text', text: '' },
        };
      }

      outputTokens += Math.ceil(delta.content.length / CHARS_PER_TOKEN);
      yield {
        type: 'content_block_delta',
        index: textBlockIndex,
        delta: { type: 'text_delta', text: delta.content },
      };
    }

    for (const toolDelta of delta.tool_calls ?? []) {
      yield* emitMessageStart();

      const key = toolDelta.index ?? 0;
      let tracked = toolCalls.get(key);

      if (!tracked) {
        // Close the text block first: Anthropic requires blocks to be
        // opened and closed in order.
        if (textBlockIndex !== null) {
          yield { type: 'content_block_stop', index: textBlockIndex };
          textBlockIndex = null;
        }

        const rawName = toolDelta.function?.name ?? '';
        tracked = {
          blockIndex: nextBlockIndex++,
          id: toolDelta.id || `toolu_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
          name: toolNameMap.get(rawName) ?? rawName,
          argumentsJson: '',
        };
        toolCalls.set(key, tracked);

        yield {
          type: 'content_block_start',
          index: tracked.blockIndex,
          content_block: {
            type: 'tool_use',
            id: tracked.id,
            name: tracked.name,
            input: {},
          },
        };
      }

      const argumentChunk = toolDelta.function?.arguments;
      if (argumentChunk) {
        tracked.argumentsJson += argumentChunk;
        outputTokens += Math.ceil(argumentChunk.length / CHARS_PER_TOKEN);
        yield {
          type: 'content_block_delta',
          index: tracked.blockIndex,
          delta: { type: 'input_json_delta', partial_json: argumentChunk },
        };
      }
    }
  }

  yield* emitMessageStart();

  if (textBlockIndex !== null) {
    yield { type: 'content_block_stop', index: textBlockIndex };
  } else if (toolCalls.size === 0) {
    // The model produced nothing; still emit a well-formed empty text block.
    const emptyIndex = nextBlockIndex++;
    yield {
      type: 'content_block_start',
      index: emptyIndex,
      content_block: { type: 'text', text: '' },
    };
    yield { type: 'content_block_stop', index: emptyIndex };
  }

  for (const tracked of toolCalls.values()) {
    yield { type: 'content_block_stop', index: tracked.blockIndex };
  }

  yield {
    type: 'message_delta',
    delta: {
      stop_reason: mapFinishReasonToStopReason(finishReason, toolCalls.size > 0),
      stop_sequence: null,
    },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };

  yield { type: 'message_stop' };
}

/**
 * Emit a complete (non-streamed) Anthropic message as a valid event sequence.
 */
function* replayResponseAsEvents(
  messageId: string,
  model: string,
  response: AnthropicMessageResponse
): Generator<AnthropicStreamEvent> {
  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: response.usage.input_tokens, output_tokens: 0 },
    },
  };

  let index = 0;
  for (const block of response.content) {
    if (block.type === 'text') {
      yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
      if (block.text) {
        yield {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        };
      }
      yield { type: 'content_block_stop', index };
      index += 1;
    } else if (block.type === 'tool_use') {
      yield {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      };
      yield {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
      };
      yield { type: 'content_block_stop', index };
      index += 1;
    }
  }

  yield {
    type: 'message_delta',
    delta: {
      stop_reason: response.stop_reason ?? 'end_turn',
      stop_sequence: response.stop_sequence,
    },
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };

  yield { type: 'message_stop' };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Estimate the input token count of a request without calling the model.
 * Used by `/v1/messages/count_tokens`, which Claude Code polls frequently.
 */
export function estimateInputTokens(
  messages: AnthropicMessage[],
  system?: AnthropicSystemPrompt,
  tools?: AnthropicTool[]
): number {
  let characters = normalizeSystemPrompt(system).length;

  for (const message of messages ?? []) {
    if (typeof message?.content === 'string') {
      characters += message.content.length;
      continue;
    }

    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      switch (block.type) {
        case 'text':
          characters += block.text.length;
          break;
        case 'tool_use':
          characters += block.name.length + JSON.stringify(block.input ?? {}).length;
          break;
        case 'tool_result':
          characters += flattenToolResultContent(block.content).length;
          break;
        case 'thinking':
          characters += block.thinking.length;
          break;
        case 'image':
          // Images are billed on dimensions; use a flat, conservative estimate.
          characters += 4 * CHARS_PER_TOKEN * 400;
          break;
        default:
          break;
      }
    }
  }

  for (const tool of tools ?? []) {
    characters += (tool.name?.length ?? 0) + (tool.description?.length ?? 0);
    characters += JSON.stringify(tool.input_schema ?? {}).length;
  }

  return Math.max(1, Math.ceil(characters / CHARS_PER_TOKEN));
}

/**
 * Create an Anthropic-shaped error response body.
 */
export function createAnthropicError(
  type: AnthropicError['error']['type'],
  message: string
): AnthropicError {
  return {
    type: 'error',
    error: { type, message },
  };
}

/**
 * Generate a message ID in Anthropic's format.
 */
export function generateMessageId(): string {
  return `msg_${uuidv4().replace(/-/g, '').substring(0, 24)}`;
}
