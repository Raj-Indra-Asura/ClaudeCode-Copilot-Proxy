import { CatalogModel, setCatalogForTesting } from '../services/model-catalog.js';
import {
  getAvailableModels,
  getModelById,
  getModelDisplayName,
  isValidClaudeModel,
  mapClaudeModelToCopilot,
} from './model-mapper.js';

const catalogModel = (
  id: string,
  overrides: Partial<CatalogModel> = {}
): CatalogModel => ({
  id,
  displayName: id,
  vendor: 'Anthropic',
  isClaude: true,
  pickerEnabled: true,
  isChatDefault: false,
  supportsTools: true,
  supportsVision: false,
  ...overrides,
});

afterEach(() => {
  setCatalogForTesting([]);
});

describe('Model Mapper', () => {
  describe('mapClaudeModelToCopilot', () => {
    it('maps the dated identifiers Claude Code sends', () => {
      expect(mapClaudeModelToCopilot('claude-opus-4-5-20251101')).toBe('claude-opus-5');
      expect(mapClaudeModelToCopilot('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-5');
      expect(mapClaudeModelToCopilot('claude-haiku-4-5-20251001')).toBe('claude-haiku-4.5');
    });

    it('prefers the longest matching prefix', () => {
      expect(mapClaudeModelToCopilot('claude-sonnet-4-5')).toBe('claude-sonnet-5');
      expect(mapClaudeModelToCopilot('claude-sonnet-4-20250514')).toBe('claude-sonnet-5');
    });

    it('maps the short aliases', () => {
      expect(mapClaudeModelToCopilot('sonnet')).toBe('claude-sonnet-5');
      expect(mapClaudeModelToCopilot('haiku')).toBe('claude-haiku-4.5');
      expect(mapClaudeModelToCopilot('opus')).toBe('claude-opus-5');
      expect(mapClaudeModelToCopilot('opusplan')).toBe('claude-opus-5');
    });

    it('forwards live Copilot model identifiers unchanged', () => {
      expect(mapClaudeModelToCopilot('claude-sonnet-5')).toBe('claude-sonnet-5');
      // Must not be rewritten by the shorter 'claude-opus-4' mapping key.
      expect(mapClaudeModelToCopilot('claude-opus-4.7')).toBe('claude-opus-4.7');
      expect(mapClaudeModelToCopilot('claude-opus-4.8-fast')).toBe('claude-opus-4.8-fast');
    });

    it('falls back to the default for unknown Claude models', () => {
      expect(mapClaudeModelToCopilot('claude-something-new-2099')).toBe('claude-sonnet-5');
      expect(mapClaudeModelToCopilot('')).toBe('claude-sonnet-5');
    });

    it('passes non-Claude models through untouched', () => {
      expect(mapClaudeModelToCopilot('gpt-5.5')).toBe('gpt-5.5');
      expect(mapClaudeModelToCopilot('gemini-3.8-flash')).toBe('gemini-3.8-flash');
    });

    it('forwards any model the live catalog offers', () => {
      setCatalogForTesting([
        catalogModel('claude-opus-4.9'),
        catalogModel('claude-sonnet-6'),
        catalogModel('gpt-6', { vendor: 'OpenAI', isClaude: false }),
      ]);

      expect(mapClaudeModelToCopilot('claude-opus-4.9')).toBe('claude-opus-4.9');
      expect(mapClaudeModelToCopilot('CLAUDE-SONNET-6')).toBe('claude-sonnet-6');
      expect(mapClaudeModelToCopilot('gpt-6')).toBe('gpt-6');
    });

    it('retargets aliases when the mapped model is not offered', () => {
      setCatalogForTesting([
        catalogModel('claude-opus-4.9'),
        catalogModel('claude-opus-4.9-fast'),
        catalogModel('claude-sonnet-6'),
        catalogModel('claude-haiku-5'),
      ]);

      // Static mappings point at claude-opus-5 / claude-sonnet-5, which this
      // account does not have.
      expect(mapClaudeModelToCopilot('opus')).toBe('claude-opus-4.9');
      expect(mapClaudeModelToCopilot('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-6');
      expect(mapClaudeModelToCopilot('haiku')).toBe('claude-haiku-5');
      expect(mapClaudeModelToCopilot('claude-opus-9-20991231')).toBe('claude-opus-4.9');
    });
  });

  describe('isValidClaudeModel', () => {
    it('recognises aliases, Copilot names and unknown Claude variants', () => {
      expect(isValidClaudeModel('sonnet')).toBe(true);
      expect(isValidClaudeModel('claude-sonnet-5')).toBe(true);
      expect(isValidClaudeModel('claude-future-9')).toBe(true);
      expect(isValidClaudeModel('gpt-5.5')).toBe(false);
      expect(isValidClaudeModel('')).toBe(false);
    });
  });

  describe('getAvailableModels', () => {
    it('returns the Anthropic pagination envelope', () => {
      const list = getAvailableModels();

      expect(list.has_more).toBe(false);
      expect(list.data.length).toBeGreaterThan(0);
      expect(list.first_id).toBe(list.data[0].id);
      expect(list.last_id).toBe(list.data[list.data.length - 1].id);

      for (const model of list.data) {
        expect(model.type).toBe('model');
        expect(typeof model.display_name).toBe('string');
        expect(typeof model.created_at).toBe('string');
      }
    });

    it('advertises the current Claude models', () => {
      const ids = getAvailableModels().data.map((model) => model.id);
      expect(ids).toEqual(expect.arrayContaining([
        'claude-opus-5',
        'claude-sonnet-5',
        'claude-haiku-4.5',
      ]));
    });

    it('advertises every Claude model the account can use', () => {
      setCatalogForTesting([
        catalogModel('claude-opus-4.9', { displayName: 'Claude Opus 4.9' }),
        catalogModel('claude-sonnet-6', { displayName: 'Claude Sonnet 6' }),
        catalogModel('claude-haiku-5', { displayName: 'Claude Haiku 5' }),
        catalogModel('claude-retired-1', { pickerEnabled: false }),
        catalogModel('gpt-6', { vendor: 'OpenAI', isClaude: false }),
      ]);

      const models = getAvailableModels().data;
      expect(models.map((model) => model.id)).toEqual([
        'claude-opus-4.9',
        'claude-sonnet-6',
        'claude-haiku-5',
      ]);
      expect(models[0].display_name).toBe('Claude Opus 4.9');
    });
  });

  describe('getModelById', () => {
    it('resolves advertised models and dated aliases', () => {
      expect(getModelById('claude-sonnet-5')?.id).toBe('claude-sonnet-5');
      expect(getModelById('claude-sonnet-4-5-20250929')?.id).toBe('claude-sonnet-4-5-20250929');
    });

    it('returns null for unknown models', () => {
      expect(getModelById('definitely-not-a-model')).toBeNull();
    });
  });

  describe('getModelDisplayName', () => {
    it('uses the configured display name when available', () => {
      expect(getModelDisplayName('claude-sonnet-5')).toBe('Claude Sonnet 5');
    });

    it('derives a readable name otherwise', () => {
      expect(getModelDisplayName('some-model')).toBe('Some Model');
    });
  });
});
