import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { config } from '../config/index.js';
import { getUsage } from '../services/usage-service.js';

const token = { token: 'test-only-token' };
const ensureToken = jest.fn(async () => token);
jest.unstable_mockModule('../services/auth-service.js', () => ({
  ensureCopilotToken: ensureToken, getCopilotToken: () => token,
  isTokenValid: () => false,
}));
const { openaiRoutes } = await import('./openai.js');

describe('legacy OpenAI lifecycle', () => {
  let server: http.Server;
  let handler: http.RequestListener;
  let app: express.Express;
  let session: string;
  let sequence = 0;
  let calls: number;
  const original = config.github.copilot.apiEndpoints.GITHUB_COPILOT_COMPLETIONS;
  const payload = { model: 'gpt-4', messages: [{ role: 'user', content: 'Hello' }] };

  beforeEach(async () => {
    session = `openai-route-${sequence++}`;
    calls = 0;
    ensureToken.mockClear();
    handler = (_req, res) => res.end(JSON.stringify({
      choices: [{ text: 'Hello', finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }));
    server = http.createServer((req, res) => {
      calls++;
      res.setHeader('Connection', 'close');
      handler(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    config.github.copilot.apiEndpoints.GITHUB_COPILOT_COMPLETIONS =
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    app = express();
    app.use(express.json());
    app.use((_req, res, next) => { res.locals.sessionId = session; next(); });
    app.use('/v1', openaiRoutes);
  });

  afterEach(async () => {
    config.github.copilot.apiEndpoints.GITHUB_COPILOT_COMPLETIONS = original;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('refreshes expired credentials and counts a buffered completion once', async () => {
    const response = await request(app).post('/v1/chat/completions').send(payload);
    expect(response.status).toBe(200);
    expect(ensureToken).toHaveBeenCalledTimes(1);
    expect(getUsage(session)).toMatchObject({ requestCount: 1, tokenCount: 7 });
    expect(calls).toBe(1);
  });

  it('keeps one stream ID and estimates usage once across tiny chunks', async () => {
    handler = (_req, res) => {
      for (const text of ['a', 'b', 'c', 'd']) {
        res.write(`data: ${JSON.stringify({ choices: [{ text }] })}\r\n\r\n`);
      }
      res.end('data: [DONE]\r\n\r\n');
    };
    const response = await request(app).post('/v1/chat/completions')
      .send({ ...payload, stream: true });
    expect(response.status).toBe(200);
    expect(response.text).toContain('data: [DONE]');
    const chunks = response.text.split('\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)));
    expect(chunks).toHaveLength(4);
    expect(new Set(chunks.map(chunk => chunk.id)).size).toBe(1);
    expect(getUsage(session)).toMatchObject({ requestCount: 1, tokenCount: 1 });
    expect(calls).toBe(1);
  });

  it('does not reconnect after malformed data or expose its contents', async () => {
    handler = (_req, res) => {
      res.write('data: {"choices":[{"text":"first"}]}\n\n');
      res.end('data: private-prompt-not-json\n\n');
    };
    const response = await request(app).post('/v1/chat/completions')
      .send({ ...payload, stream: true });
    expect(response.text).toContain('Upstream streaming failed');
    expect(response.text).not.toContain('private-prompt-not-json');
    expect(response.text).not.toContain('[DONE]');
    expect(calls).toBe(1);
    expect(getUsage(session)?.requestCount).toBe(1);
  });
});
