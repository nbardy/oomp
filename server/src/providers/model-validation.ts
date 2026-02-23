import type { Provider as ProviderName } from '@claude-web-view/shared';

const CLAUDE_MODEL_IDS = new Set(['opus', 'sonnet', 'haiku']);
const CODEX_MODEL_IDS = new Set([
  'gpt-5.3-codex-medium', 'gpt-5.3-codex-high', 'gpt-5.3-codex-xhigh',
  'gpt-5.3-codex-spark',
  'gpt-5.3-codex-spark-medium', 'gpt-5.3-codex-spark-high', 'gpt-5.3-codex-spark-xhigh',
]);
const GEMINI_MODEL_IDS = new Set([
  'gemini-3-pro-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
]);

// OpenCode model IDs are path-style: provider/model (or provider/subprovider/model).
const OPENCODE_MODEL_ID_REGEX = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._:+-]*)+$/i;

export function isOpenCodeModelId(modelId: string): boolean {
  return OPENCODE_MODEL_ID_REGEX.test(modelId);
}

export function isModelIdValidForProvider(provider: ProviderName, modelId?: string): boolean {
  if (!modelId) return true;

  switch (provider) {
    case 'claude':
      return CLAUDE_MODEL_IDS.has(modelId);
    case 'codex':
      return CODEX_MODEL_IDS.has(modelId);
    case 'gemini':
      return GEMINI_MODEL_IDS.has(modelId);
    case 'opencode':
      return isOpenCodeModelId(modelId);
    default:
      return false;
  }
}

export function modelValidationHint(provider: ProviderName): string {
  switch (provider) {
    case 'claude':
      return "one of: 'opus', 'sonnet', 'haiku'";
    case 'codex':
      return "one of: 'gpt-5.3-codex-{medium,high,xhigh}', 'gpt-5.3-codex-spark', 'gpt-5.3-codex-spark-{medium,high,xhigh}'";
    case 'gemini':
      return "one of: 'gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'";
    case 'opencode':
      return "'provider/model' format (e.g. 'opencode/big-pickle')";
    default:
      return 'a valid model id for the selected provider';
  }
}
