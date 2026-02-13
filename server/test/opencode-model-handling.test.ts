import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ModelIdSchema,
  NewConversationMessageSchema,
  SetModelMessageSchema,
} from '../../shared/src/index';
import { isModelIdValidForProvider } from '../src/providers/model-validation';
import opencodeProvider from '../src/providers/opencode';

const conversationId = '550e8400-e29b-41d4-a716-446655440000';

test('shared model schemas accept practical OpenCode ids', () => {
  assert.equal(ModelIdSchema.safeParse('opencode/big-pickle').success, true);
  assert.equal(
    NewConversationMessageSchema.safeParse({
      type: 'new_conversation',
      provider: 'opencode',
      model: 'opencode/big-pickle',
    }).success,
    true
  );
  assert.equal(
    SetModelMessageSchema.safeParse({
      type: 'set_model',
      conversationId,
      model: 'opencode/big-pickle',
    }).success,
    true
  );
});

test('shared model schema keeps claude/codex ids strict', () => {
  assert.equal(ModelIdSchema.safeParse('opus').success, true);
  assert.equal(ModelIdSchema.safeParse('gpt-5.3-codex-high').success, true);

  // Missing provider/model separator should still be rejected.
  assert.equal(ModelIdSchema.safeParse('openai').success, false);
  assert.equal(ModelIdSchema.safeParse('gpt-5.3-codex-ultra').success, false);
});

test('server provider/model compatibility validation works per provider', () => {
  assert.equal(isModelIdValidForProvider('claude', 'opus'), true);
  assert.equal(isModelIdValidForProvider('claude', 'opencode/gpt-5'), false);

  assert.equal(isModelIdValidForProvider('codex', 'gpt-5.3-codex-medium'), true);
  assert.equal(isModelIdValidForProvider('codex', 'opencode/gpt-5'), false);

  assert.equal(isModelIdValidForProvider('opencode', 'opencode/gpt-5'), true);
  assert.equal(isModelIdValidForProvider('opencode', 'openai/gpt-5'), true);
  assert.equal(isModelIdValidForProvider('opencode', 'opus'), false);
});

test('OpenCode provider model params enforce provider/model ids', () => {
  assert.deepEqual(opencodeProvider.modelToParams('openai/gpt-5'), ['-m', 'opencode/gpt-5']);
  assert.deepEqual(opencodeProvider.modelToParams('opencode/gpt-5'), ['-m', 'opencode/gpt-5']);
  assert.deepEqual(opencodeProvider.modelToParams('opencode/big-pickle'), ['-m', 'opencode/big-pickle']);
  assert.throws(() => opencodeProvider.modelToParams('opus'));
});

test('OpenCode listModels remains dropdown-friendly with one default', () => {
  const models = opencodeProvider.listModels();
  const defaults = models.filter((m) => m.isDefault);

  assert.equal(models.some((m) => m.id === 'opencode/big-pickle'), true);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].id, 'opencode/big-pickle');
});

test('OpenCode spawn config uses --session + --continue only for valid resume IDs', () => {
  const resumeConfig = opencodeProvider.getSpawnConfig(
    'ses_abc123',
    '/tmp',
    true,
    'opencode/big-pickle'
  );
  assert.deepEqual(resumeConfig.args, [
    'run',
    '--format',
    'json',
    '-m',
    'opencode/big-pickle',
    '--session',
    'ses_abc123',
    '--continue',
  ]);

  const freshConfig = opencodeProvider.getSpawnConfig(
    'temporary-client-id',
    '/tmp',
    true,
    'opencode/big-pickle'
  );
  assert.deepEqual(freshConfig.args, [
    'run',
    '--format',
    'json',
    '-m',
    'opencode/gpt-5',
  ]);
});
