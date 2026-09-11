import express from 'express';
import { StringDecoder } from 'node:string_decoder';
import { Readable } from 'node:stream';
import { v4 as uuidv4 } from 'uuid';
import { 
  ensureCopilotToken,
  getCopilotToken,
} from '../services/auth-service.js';
import { 
  convertMessagesToCopilotPrompt,
  detectLanguageFromMessages,
  makeCompletionRequest
} from '../services/copilot-service.js';
import { OpenAICompletionRequest, OpenAICompletion } from '../types/openai.js';
import { AppError } from '../middleware/error-handler.js';
import { config } from '../config/index.js';
import { getMachineId } from '../utils/machine-id.js';
import { logger } from '../utils/logger.js';
import { trackRequest, trackTokens } from '../services/usage-service.js';
import { upstreamFetch } from '../utils/upstream-fetch.js';
import { abortOnDisconnect, writeResponse } from '../utils/response-stream.js';

export const openaiRoutes = express.Router();

// Authentication middleware
const requireAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    await ensureCopilotToken();
    next();
  } catch (error) {
    logger.error('Token refresh failed in middleware');
    const authError = new Error('Authentication failed') as AppError;
    authError.status = 401;
    authError.code = 'authentication_failed';
    next(authError);
  }
};

// GET /v1/models - List available models
openaiRoutes.get('/models', requireAuth, (req, res) => {
  // Return a simple model list that includes models compatible with GitHub Copilot
  res.json({
    object: 'list',
    data: [
      {
        id: 'gpt-4',
        object: 'model',
        created: Date.now(),
        owned_by: 'github-copilot',
      },
      {
        id: 'gpt-4o',
        object: 'model',
        created: Date.now(),
        owned_by: 'github-copilot',
      },
      {
        id: 'gpt-3.5-turbo',
        object: 'model',
        created: Date.now(),
        owned_by: 'github-copilot',
      }
    ]
  });
});

// POST /v1/chat/completions - Create a completion
openaiRoutes.post('/chat/completions', requireAuth, async (req, res, next) => {
  // Track this request
  const sessionId = res.locals.sessionId || uuidv4();
  const { signal, cleanup } = abortOnDisconnect(res);
  try {
    const request = req.body as OpenAICompletionRequest;
    const { messages, stream = false, model = 'gpt-4' } = request;
    
    // Validate request
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      const error = new Error('Messages array is required') as AppError;
      error.status = 400;
      error.code = 'invalid_request';
      return next(error);
    }
    
    const copilotToken = getCopilotToken();
    if (!copilotToken) {
      const error = new Error('Authentication required') as AppError;
      error.status = 401;
      error.code = 'authentication_required';
      return next(error);
    }
    trackRequest(sessionId);
    
    // Handle streaming response
    if (stream) {
      await handleStreamingCompletion(req, res, next, sessionId, signal);
    } else {
      // Handle non-streaming response
      try {
        const completionData = await makeCompletionRequest(request, copilotToken.token, signal);
        
        // Convert to OpenAI format
        const openAIResponse: OpenAICompletion = {
          id: `chatcmpl-${uuidv4()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: completionData.choices.map((choice, index) => ({
            index,
            message: {
              role: 'assistant',
              content: choice.text,
            },
            finish_reason: choice.finish_reason || 'stop',
          })),
          usage: completionData.usage
        };
        
        // Track token usage
        const totalTokens = openAIResponse.usage?.total_tokens || 0;
        trackTokens(sessionId, totalTokens);
        
        if (!signal.aborted && !res.destroyed) {
          res.json(openAIResponse);
        }
      } catch (error) {
        logger.error('Error in non-streaming completion');
        if (!signal.aborted && !res.destroyed) {
          next(error);
        }
      }
    }
  } catch (error) {
    if (!signal.aborted && !res.destroyed) {
      next(error);
    }
  } finally {
    cleanup();
  }
});

// Handle streaming completions
async function handleStreamingCompletion(
  req: express.Request, 
  res: express.Response, 
  next: express.NextFunction,
  sessionId: string,
  signal: AbortSignal
) {
  let body: Readable | null = null;
  let responseCharacters = 0;
  try {
    const request = req.body as OpenAICompletionRequest;
    const { messages, temperature, max_tokens, top_p, n, model = 'gpt-4' } = request;
    
    const copilotToken = getCopilotToken();
    if (!copilotToken || !copilotToken.token) {
      const error = new Error('Authentication required') as AppError;
      error.status = 401;
      error.code = 'authentication_required';
      return next(error);
    }
    
    // Convert OpenAI messages to Copilot format
    const prompt = convertMessagesToCopilotPrompt(messages);
    const suffix = ""; // Empty for chat completions
    
    // Get machine ID for request
    const machineId = getMachineId();
    
    const completionsUrl = config.github.copilot.apiEndpoints.GITHUB_COPILOT_COMPLETIONS;
    
    const upstream = await upstreamFetch(completionsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${copilotToken.token}`,
        'X-Request-Id': uuidv4(),
        'Machine-Id': machineId,
        'User-Agent': 'GitHubCopilotChat/0.12.0',
        'Editor-Version': 'Cursor-IDE/1.0.0',
        'Editor-Plugin-Version': 'copilot-cursor/1.0.0',
        'Openai-Organization': 'github-copilot',
        'Openai-Intent': 'copilot-ghost'
      },
      body: JSON.stringify({
        prompt,
        suffix,
        max_tokens: max_tokens || 500,
        temperature: temperature ?? 0.7,
        top_p: top_p ?? 1,
        n: n || 1,
        stream: true,
        stop: ["\n\n"],
        extra: {
          language: detectLanguageFromMessages(messages),
          next_indent: 0,
          trim_by_indentation: true,
        }
      }),
      signal,
    });
    body = upstream.body as Readable | null;
    if (!upstream.ok || !body) {
      throw new Error(`Stream connection error: ${upstream.status}`);
    }
    if (signal.aborted || res.destroyed) {
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const id = `chatcmpl-${uuidv4()}`;
    const created = Math.floor(Date.now() / 1000);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    for await (const chunk of body) {
      if (signal.aborted || res.destroyed) {
        return;
      }
      pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (pending.length > 1024 * 1024) {
        throw new Error('Upstream stream event too large');
      }
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const dataText = frame.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!dataText) {
          continue;
        }
        if (dataText === '[DONE]') {
          if (await writeResponse(res, 'data: [DONE]\n\n')) {
            res.end();
          }
          return;
        }
        const data = JSON.parse(dataText) as {
          choices?: Array<{ index?: number; text?: string; finish_reason?: string | null }>;
        };
        if (!Array.isArray(data.choices)) {
          throw new Error('Invalid upstream stream event');
        }
        const choices = data.choices.map((choice, index) => {
          const text = choice.text ?? '';
          responseCharacters += text.length;
          return {
            index: choice.index ?? index,
            delta: { content: text },
            finish_reason: choice.finish_reason ?? null,
          };
        });
        if (!await writeResponse(res, `data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model, choices,
        })}\n\n`)) {
          return;
        }
      }
    }
    throw new Error('Upstream stream ended before completion');
  } catch (error) {
    if (signal.aborted || res.destroyed) {
      return;
    }
    logger.error('Error in streaming completion');
    if (!res.headersSent) {
      return next(error);
    }
    if (await writeResponse(res, 'data: {"error":"Upstream streaming failed"}\n\n')) {
      res.end();
    }
  } finally {
    body?.destroy();
    trackTokens(sessionId, Math.ceil(responseCharacters / 4));
  }
}
