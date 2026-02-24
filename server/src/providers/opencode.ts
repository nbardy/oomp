/**
 * OpenCode CLI Provider
 *
 * Handles spawning and parsing OpenCode CLI (`opencode run --format json`).
 *
 * Session behavior:
 * - First message starts a new session automatically (no --session flag)
 * - Subsequent messages resume with `--session <id>` when we have a real
 *   OpenCode session ID (captured from stdout events in server.ts)
 *
 * JSON output notes:
 * - OpenCode emits line-delimited JSON in `--format json`
 * - Event shape is still evolving, so parsing is intentionally defensive:
 *   known event types are handled explicitly, and unknown events degrade
 *   gracefully while still extracting assistant text when possible.
 */

import type { ModelInfo } from '@claude-web-view/shared';
import { buildCommand } from '@nbardy/agent-cli';
import { type Provider, type ProviderEvent, ProviderParseError, type SpawnConfig } from './index';

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null ? (value as JsonObject) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function basename(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() ?? filePath;
}

function normalizeType(raw: string | null): string | null {
  if (!raw) return null;
  return raw.replace(/-/g, '_').toLowerCase();
}

function opencodeToolEmoji(toolName: string): string {
  switch (toolName.toLowerCase()) {
    case 'read':
      return '📖';
    case 'write':
      return '✍️';
    case 'edit':
      return '✏️';
    case 'bash':
      return '⚡';
    case 'glob':
      return '📂';
    case 'grep':
      return '🔍';
    case 'webfetch':
      return '🌐';
    case 'websearch':
      return '🌐';
    case 'task':
      return '🤖';
    default:
      return '🔧';
  }
}

/**
 * Extract assistant text from known/likely OpenCode event shapes.
 * Intentionally conservative: avoids generic recursive scanning so we don't
 * accidentally treat tool output as assistant response text.
 */
function extractAssistantText(obj: JsonObject): string | null {
  const directText = asString(obj.text);
  if (directText) return directText;

  const part = asObject(obj.part);
  if (part) {
    const partText = asString(part.text);
    if (partText) return partText;

    const delta = asObject(part.delta);
    if (delta) {
      const deltaText = asString(delta.text);
      if (deltaText) return deltaText;
    }
  }

  const message = asObject(obj.message);
  if (message) {
    const messageText = asString(message.text);
    if (messageText) return messageText;

    const messageContent = message.content;
    if (typeof messageContent === 'string') return messageContent;
    if (Array.isArray(messageContent)) {
      const chunks: string[] = [];
      for (const item of messageContent) {
        const itemObj = asObject(item);
        const text = itemObj ? asString(itemObj.text) : null;
        if (text) chunks.push(text);
      }
      if (chunks.length > 0) return chunks.join('');
    }
  }

  return null;
}

function buildToolDisplayName(toolName: string, input: JsonObject): string {
  const pathLike =
    asString(input.file_path) ??
    asString(input.path) ??
    asString(input.file) ??
    asString(input.target);

  if (pathLike) return `${toolName} ${basename(pathLike)}`;

  const pattern = asString(input.pattern);
  if (pattern) return `${toolName} ${pattern}`;

  const command = asString(input.command);
  if (command) {
    const short = command.length > 50 ? `${command.slice(0, 47)}...` : command;
    return `${toolName} ${short}`;
  }

  return toolName;
}

const opencodeProvider: Provider = {
  name: 'opencode',

  listModels(): ModelInfo[] {
    return [
      // Prefer OpenCode Zen free-tier models by default.
      { id: 'opencode/big-pickle', displayName: 'OpenCode Big Pickle (Free)', isDefault: true },
      { id: 'opencode/gpt-5-nano', displayName: 'OpenCode GPT-5 Nano (Free)', isDefault: false },
      { id: 'opencode/kimi-k2.5-free', displayName: 'OpenCode Kimi K2.5 Free', isDefault: false },
      {
        id: 'opencode/minimax-m2.5-free',
        displayName: 'OpenCode MiniMax M2.5 Free',
        isDefault: false,
      },
    ];
  },

  getSpawnConfig(
    sessionId: string,
    workingDir: string,
    resume = false,
    modelId?: string
  ): SpawnConfig {
    // Command building delegated to @nbardy/agent-cli (shared with oompa_loompas).
    // Agent-cli handles: run subcommand, model normalization (openai/ → opencode/),
    // ses_ session guard, resume flags.
    // Project-specific: --format json (streaming output).
    // Prompt text is NOT passed here — delivered via stdin (formatInput).
    const spec = buildCommand('opencode', {
      model: modelId,
      sessionId,
      resume,
      extraArgs: ['--format', 'json'],
    });

    return {
      command: spec.argv[0],
      args: spec.argv.slice(1),
      options: {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
      stdin: spec.stdin,
      stdout: spec.stdout,
    };
  },

  getSingleShotConfig(prompt: string): SpawnConfig {
    return {
      command: 'opencode',
      args: ['run', prompt],
      options: {},
      stdin: 'close',
      stdout: 'text',
    };
  },

  parseOutput(json: unknown): ProviderEvent {
    const obj = asObject(json);
    if (!obj) {
      throw new ProviderParseError('opencode', json, 'Expected JSON object output');
    }

    const topType = normalizeType(asString(obj.type));
    const partType = normalizeType(asString(asObject(obj.part)?.type));
    const eventType = topType ?? partType;

    switch (eventType) {
      case 'step_start':
        return { type: 'message_start' };

      case 'text': {
        const text = extractAssistantText(obj);
        if (text && text.length > 0) {
          return { type: 'text_delta', text };
        }
        return { type: 'message_start' };
      }

      case 'tool_use':
      case 'tool': {
        const part = asObject(obj.part) ?? {};
        const toolName = asString(part.tool) ?? asString(obj.tool) ?? 'tool';
        const state = asObject(part.state);
        const input = asObject(state?.input) ?? {};
        const status = asString(state?.status);
        const label = buildToolDisplayName(toolName, input);
        const statusSuffix =
          status === 'failed' || status === 'error' ? ' ❌' : status === 'running' ? ' …' : '';

        return {
          type: 'tool_use',
          name: toolName,
          input,
          displayText: `${opencodeToolEmoji(toolName)} ${label}${statusSuffix}\n`,
        };
      }

      case 'step_finish': {
        const part = asObject(obj.part);
        const reason = asString(part?.reason) ?? asString(obj.reason);
        const normalizedReason = normalizeType(reason);

        // Intermediate step finish while tool calls are still in progress.
        if (normalizedReason === 'tool_calls') {
          return { type: 'message_start' };
        }

        if (
          normalizedReason === 'failed' ||
          normalizedReason === 'error' ||
          normalizedReason === 'abort' ||
          normalizedReason === 'aborted' ||
          normalizedReason === 'cancel' ||
          normalizedReason === 'cancelled' ||
          normalizedReason === 'canceled'
        ) {
          return { type: 'error', message: `OpenCode step failed (${reason ?? 'unknown'})` };
        }

        // Treat unknown/non-error finish reasons as completion.
        return { type: 'message_complete' };
      }

      case 'reasoning':
      case 'thinking':
        // Hidden by default to match existing behavior for non-user-facing reasoning.
        return { type: 'message_start' };

      case 'done':
      case 'complete':
      case 'message_complete':
      case 'response_complete':
        return { type: 'message_complete' };

      case 'error': {
        const message =
          asString(obj.message) ?? asString(asObject(obj.error)?.message) ?? 'OpenCode error';
        return { type: 'error', message };
      }

      default: {
        // Resilient fallback: if schema shifts but text exists, keep streaming.
        const fallbackText = extractAssistantText(obj);
        if (fallbackText && fallbackText.length > 0) {
          return { type: 'text_delta', text: fallbackText };
        }

        // Unknown structural event: ignore instead of crashing.
        return { type: 'message_start' };
      }
    }
  },
};

export default opencodeProvider;
