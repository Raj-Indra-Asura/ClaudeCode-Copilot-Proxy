import {
  getAvailableModels,
  getModelById,
  getModelDisplayName,
  isValidClaudeModel,
  mapClaudeModelToCopilot,
} from './model-mapper.js';

describe('Model Mapper', () => {
  describe('mapClaudeModelToCopilot', () => {
    it('maps the dated identifiers Claude Code sends', () => {
      expect(mapClaudeModelToCopilot('claude-opus-4-5-20251101')).toBe('claude-opus-4.5');
      expect(mapClaudeModelToCopilot('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4.5');
      expect(mapClaudeModelToCopilot('claude-haiku-4-5-20251001')).toBe('claude-haiku-4.5');
    });

    it('prefers the longest matching prefix', () => {
      // Must not collapse to the shorter `claude-sonnet-4` entry.
      expect(mapClaudeModelToCopilot('claude-sonnet-4-5')).toBe('claude-sonnet-4.5');
      expect(mapClaudeModelToCopilot('claude-sonnet-4-20250514')).toBe('claude-sonnet-4');
    });

    it('maps the short aliases', () => {
      expect(mapClaudeModelToCopilot('sonnet')).toBe('claude-sonnet-4.5');
      expect(mapClaudeModelToCopilot('haiku')).toBe('claude-haiku-4.5');
      expect(mapClaudeModelToCopilot('opus')).toBe('claude-opus-4.5');
      expect(mapClaudeModelToCopilot('opusplan')).toBe('claude-opus-4.5');
    });

    it('accepts Copilot model identifiers unchanged', () => {
      expect(mapClaudeModelToCopilot('claude-sonnet-4.5')).toBe('claude-sonnet-4.5');
    });

    it('falls back to the default for unknown Claude models', () => {
      expect(mapClaudeModelToCopilot('claude-something-new-2099')).toBe('claude-sonnet-4.5');
      expect(mapClaudeModelToCopilot('')).toBe('claude-sonnet-4.5');
    });

    it('passes non-Claude models through untouched', () => {
      expect(mapClaudeModelToCopilot('gpt-5.2')).toBe('gpt-5.2');
      expect(mapClaudeModelToCopilot('gemini-3-pro-preview')).toBe('gemini-3-pro-preview');
    });
  });

  describe('isValidClaudeModel', () => {
    it('recognises aliases, Copilot names and unknown Claude variants', () => {
      expect(isValidClaudeModel('sonnet')).toBe(true);
      expect(isValidClaudeModel('claude-sonnet-4.5')).toBe(true);
      expect(isValidClaudeModel('claude-future-9')).toBe(true);
      expect(isValidClaudeModel('gpt-5.2')).toBe(false);
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
        'claude-opus-4-5',
        'claude-sonnet-4-5',
        'claude-haiku-4-5',
      ]));
    });
  });

  describe('getModelById', () => {
    it('resolves advertised models and dated aliases', () => {
      expect(getModelById('claude-sonnet-4-5')?.id).toBe('claude-sonnet-4-5');
      expect(getModelById('claude-sonnet-4-5-20250929')?.id).toBe('claude-sonnet-4-5-20250929');
    });

    it('returns null for unknown models', () => {
      expect(getModelById('definitely-not-a-model')).toBeNull();
    });
  });

  describe('getModelDisplayName', () => {
    it('uses the configured display name when available', () => {
      expect(getModelDisplayName('claude-sonnet-4-5')).toBe('Claude Sonnet 4.5');
    });

    it('derives a readable name otherwise', () => {
      expect(getModelDisplayName('some-model')).toBe('Some Model');
    });
  });
});
