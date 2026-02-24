/**
 * Claude CLI Provider
 *
 * DESIGN: One clean path, no fallbacks, fail eagerly.
 *
 * Handles spawning and parsing Claude CLI (--output-format=stream-json)
 *
 * KNOWN OUTPUT TYPES from Claude CLI:
 * - {"type":"system","subtype":"init",...} - Session initialized
 * - {"type":"assistant","message":{"content":[...],...}} - Response with content
 * - {"type":"result","subtype":"success|error",...} - Complete
 * - {"type":"user",...} - Echo of user message (ignored, returns message_start)
 *
 * Any other type throws ProviderParseError.
 *
 * PERMISSIONS:
 * Set CLAUDE_MAX_PERMISSIONS=true to bypass all permission prompts.
 * This adds --dangerously-skip-permissions to skip file/bash confirmations.
 * WARNING: Only use in trusted/sandboxed environments with no internet access.
 */

import type { ModelInfo } from '@claude-web-view/shared';
import { buildCommand } from '@nbardy/agent-cli';
import { type Provider, type ProviderEvent, ProviderParseError, type SpawnConfig } from './index';

// =============================================================================
// Claude CLI JSON Output Types - STRICT, NO CATCH-ALL
// =============================================================================

interface ClaudeSystemInit {
  type: 'system';
  subtype: 'init';
}

interface ClaudeTextContent {
  type: 'text';
  text: string;
}

interface ClaudeToolUseContent {
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
}

interface ClaudeToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

type ClaudeContentItem = ClaudeTextContent | ClaudeToolUseContent | ClaudeToolResultContent;

interface ClaudeAssistantMessage {
  type: 'assistant';
  message: {
    content: ClaudeContentItem[];
  };
}

interface ClaudeUserMessage {
  type: 'user';
}

interface ClaudeResult {
  type: 'result';
  subtype: 'success' | 'error';
  result?: string;
}

// Streaming events (with --include-partial-messages)
interface ClaudeStreamEvent {
  type: 'stream_event';
  event: {
    type: string;
    delta?: {
      type?: string;
      text?: string;
      stop_reason?: string;
    };
    content_block?: {
      type: string;
      text?: string;
      name?: string;
    };
  };
}

// Discriminated union - ONLY these types are valid
type ClaudeOutput =
  | ClaudeSystemInit
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeResult
  | ClaudeStreamEvent;

// Type guard for valid Claude output
function isClaudeOutput(data: unknown): data is ClaudeOutput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as { type?: unknown };
  return (
    obj.type === 'system' ||
    obj.type === 'assistant' ||
    obj.type === 'user' ||
    obj.type === 'result' ||
    obj.type === 'stream_event'
  );
}

// =============================================================================
// Tool Emoji Map — consistent display for Claude tool names
// =============================================================================

function claudeToolEmoji(toolName: string): string {
  switch (toolName) {
    case 'Read':
      return '📖';
    case 'Write':
      return '✍️';
    case 'Edit':
      return '✏️';
    case 'Bash':
      return '⚡';
    case 'Glob':
      return '📂';
    case 'Grep':
      return '🔍';
    case 'WebSearch':
      return '🌐';
    case 'WebFetch':
      return '🌐';
    case 'NotebookEdit':
      return '📓';
    default:
      return '🔧';
  }
}

// =============================================================================
// Provider Implementation
// =============================================================================

const claudeProvider: Provider = {
  name: 'claude',

  listModels(): ModelInfo[] {
    return [
      { id: 'sonnet', displayName: 'Claude Sonnet', isDefault: false },
      { id: 'opus', displayName: 'Claude Opus', isDefault: true },
      { id: 'haiku', displayName: 'Claude Haiku', isDefault: false },
    ];
  },

  getSpawnConfig(
    sessionId: string,
    workingDir: string,
    resume = false,
    modelId?: string
  ): SpawnConfig {
    // Command building delegated to @nbardy/agent-cli (shared with oompa_loompas).
    // Session management, model flags, and bypass are handled by agent-cli.
    // Project-specific streaming flags are passed via extraArgs.
    const maxPermissions = process.env.CLAUDE_MAX_PERMISSIONS !== 'false';
    if (maxPermissions) {
      console.log('[claude] MAX PERMISSIONS MODE enabled');
    }

    // Project-specific flags: streaming config + permissions mode details.
    // -p (print mode): process one message then exit.
    // Note: prompt text is NOT passed here — delivered via stdin (formatInput).
    const extraArgs = [
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
    ];
    if (maxPermissions) {
      extraArgs.push(
        '--permission-mode',
        'bypassPermissions',
        '--tools',
        'default',
        '--add-dir',
        workingDir
      );
    }

    const spec = buildCommand('claude', {
      model: modelId,
      sessionId,
      resume,
      bypassPermissions: maxPermissions,
      extraArgs,
    });

    return {
      command: spec.argv[0],
      args: spec.argv.slice(1),
      options: { cwd: workingDir },
      stdout: spec.stdout,
    };
  },

  getSingleShotConfig(prompt: string): SpawnConfig {
    // Single-shot: one prompt as CLI arg, plain text output, no session
    return {
      command: 'claude',
      args: ['-p', prompt, '--output-format', 'text'],
      options: {},
      stdout: 'text',
    };
  },

  /**
   * Parse Claude CLI JSON output into unified events.
   * @throws ProviderParseError on unknown message types - no fallbacks.
   */
  parseOutput(json: unknown): ProviderEvent {
    // Validate this is a known Claude output type
    if (!isClaudeOutput(json)) {
      throw new ProviderParseError('claude', json, `Unknown message type: ${JSON.stringify(json)}`);
    }

    switch (json.type) {
      case 'system':
        if (json.subtype === 'init') {
          return { type: 'message_start' };
        }
        throw new ProviderParseError(
          'claude',
          json,
          `Unknown system subtype: ${(json as { subtype?: string }).subtype}`
        );

      case 'user':
        // Echo of user message - treat as start of assistant response
        return { type: 'message_start' };

      case 'stream_event': {
        // Streaming events from --include-partial-messages
        const eventType = json.event?.type;

        switch (eventType) {
          case 'content_block_delta':
            // Streaming text chunk!
            if (json.event.delta?.type === 'text_delta' && json.event.delta.text) {
              return { type: 'text_delta', text: json.event.delta.text };
            }
            // Tool input delta - ignore for now
            return { type: 'message_start' }; // no-op

          case 'content_block_start':
            // Content block starting - check if it's a tool use
            if (json.event.content_block?.type === 'tool_use') {
              const name = json.event.content_block.name || 'unknown';
              const id = (json.event.content_block as { id?: string }).id || '';

              // Special handling for Task tool (sub-agent spawn) — no display text
              if (name === 'Task') {
                return { type: 'tool_use', name, input: { _blockId: id } };
              }

              // AskUserQuestion — no inline emoji text. The full widget is rendered
              // from the assistant message (see 'assistant' case below).
              if (name === 'AskUserQuestion') {
                return { type: 'tool_use', name, input: { _blockId: id } };
              }

              // Map Claude tool names to emoji + short label
              const toolEmoji = claudeToolEmoji(name);
              return {
                type: 'tool_use',
                name,
                input: { _blockId: id },
                displayText: `${toolEmoji} ${name}\n`,
              };
            }
            return { type: 'message_start' }; // no-op for text blocks

          case 'message_start':
          case 'content_block_stop':
          case 'message_delta':
          case 'message_stop':
            // These are structural events, not content - treat as no-op
            return { type: 'message_start' };

          default:
            // Unknown stream event type - log but don't crash
            console.warn(`[claude] Unknown stream_event type: ${eventType}`);
            return { type: 'message_start' };
        }
      }

      case 'assistant': {
        // Full assistant message (sent after streaming completes)
        // With --include-partial-messages, we already got the content via stream_event
        // So this is just a confirmation - don't re-emit the text (would cause duplicates!)
        //
        // EXCEPTION: AskUserQuestion tool_use blocks carry structured input (questions,
        // options) that we need to display as an interactive widget. The input arrives
        // as input_json_delta chunks during streaming (which we discard), so the only
        // place we get the complete input is here in the full assistant message.
        // We emit a special marker as text_delta that the client renders as a widget.
        const content = json.message?.content;
        const textBlock = Array.isArray(content)
          ? content.find((b: ClaudeContentItem) => b.type === 'text')
          : null;
        const textLength = (textBlock as ClaudeTextContent | null)?.text?.length ?? 0;
        console.log(
          `[claude] assistant message arrived (${textLength} chars) - checking for AskUserQuestion`
        );

        // Extract AskUserQuestion tool_use blocks and emit as structured markers
        if (Array.isArray(content)) {
          const askBlocks = content.filter(
            (b: ClaudeContentItem) => b.type === 'tool_use' && b.name === 'AskUserQuestion'
          ) as ClaudeToolUseContent[];

          if (askBlocks.length > 0) {
            // Emit the first AskUserQuestion block as a text marker.
            // The client detects this marker and renders an interactive widget.
            const input = askBlocks[0].input;
            const marker = `\n<!--ask_user_question:${JSON.stringify(input)}-->\n`;
            return { type: 'text_delta', text: marker };
          }
        }

        return { type: 'message_start' };
      }

      case 'result':
        return { type: 'message_complete' };

      default: {
        // TypeScript exhaustive check
        const _exhaustive: never = json;
        throw new ProviderParseError('claude', _exhaustive, 'Unhandled message type');
      }
    }
  },
};

export default claudeProvider;
