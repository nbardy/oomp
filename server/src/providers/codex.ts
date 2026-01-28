/**
 * Codex CLI Provider
 *
 * DESIGN: One clean path, no fallbacks, fail eagerly.
 *
 * Handles spawning and parsing Codex CLI (exec --json mode)
 *
 * KNOWN OUTPUT TYPES from Codex CLI:
 * - {"type":"start"} - Session starting
 * - {"type":"message","content":"..."} - Text response
 * - {"type":"tool_call","tool":"shell","command":"..."} - Tool invocation
 * - {"type":"tool_result","output":"..."} - Tool output
 * - {"type":"end"} - Complete
 * - {"type":"done"} - Complete (alternate)
 *
 * Any other type throws ProviderParseError.
 */

import { ProviderParseError, type Provider, type SpawnConfig, type ProviderEvent } from './index';

// =============================================================================
// Codex CLI JSON Output Types - STRICT, NO CATCH-ALL
// =============================================================================

interface CodexStart {
  type: 'start';
}

interface CodexMessage {
  type: 'message';
  content: string;
}

interface CodexToolCall {
  type: 'tool_call';
  tool: string;
  command?: string;
}

interface CodexToolResult {
  type: 'tool_result';
  output: string;
}

interface CodexEnd {
  type: 'end';
}

interface CodexDone {
  type: 'done';
}

// Discriminated union - ONLY these types are valid
type CodexOutput =
  | CodexStart
  | CodexMessage
  | CodexToolCall
  | CodexToolResult
  | CodexEnd
  | CodexDone;

// Type guard for valid Codex output
function isCodexOutput(data: unknown): data is CodexOutput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as { type?: unknown };
  return (
    obj.type === 'start' ||
    obj.type === 'message' ||
    obj.type === 'tool_call' ||
    obj.type === 'tool_result' ||
    obj.type === 'end' ||
    obj.type === 'done'
  );
}

// =============================================================================
// Provider Implementation
// =============================================================================

const codexProvider: Provider = {
  name: 'codex',

  getSpawnConfig(_sessionId: string, workingDir: string, _resume = false): SpawnConfig {
    // Codex doesn't use session IDs or resume - each message is independent
    const args = ['exec', '--json', '-C', workingDir];

    // MAX PERMISSIONS MODE (enabled by default):
    // Bypass all approval prompts and sandbox restrictions.
    // Set CODEX_MAX_PERMISSIONS=false to disable.
    // WARNING: Only use in trusted/sandboxed environments!
    const maxPermissions = process.env.CODEX_MAX_PERMISSIONS !== 'false';
    if (maxPermissions) {
      args.push(
        '--dangerously-bypass-approvals-and-sandbox',
        '-a', 'never',  // Never ask for approval
        '-s', 'danger-full-access'  // Full system access
      );
      console.log('[codex] MAX PERMISSIONS MODE enabled');
    }

    return {
      command: 'codex',
      args,
      options: {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    };
  },

  formatInput(content: string): string {
    return `${content}\n`;
  },

  /**
   * Parse Codex CLI JSON output into unified events.
   * @throws ProviderParseError on unknown message types - no fallbacks.
   */
  parseOutput(json: unknown): ProviderEvent {
    // Validate this is a known Codex output type
    if (!isCodexOutput(json)) {
      throw new ProviderParseError(
        'codex',
        json,
        `Unknown message type: ${JSON.stringify(json)}`
      );
    }

    switch (json.type) {
      case 'start':
        return { type: 'message_start' };

      case 'message':
        return { type: 'text_delta', text: json.content };

      case 'tool_call': {
        const toolInfo = json.tool === 'shell' ? `Running: ${json.command}` : `Tool: ${json.tool}`;
        return {
          type: 'tool_use',
          name: json.tool,
          input: json.tool === 'shell' ? { command: json.command } : {},
          displayText: `\n[${toolInfo}]\n`,
        };
      }

      case 'tool_result':
        return { type: 'text_delta', text: json.output };

      case 'end':
      case 'done':
        return { type: 'message_complete' };

      default: {
        // TypeScript exhaustive check
        const _exhaustive: never = json;
        throw new ProviderParseError(
          'codex',
          _exhaustive,
          'Unhandled message type'
        );
      }
    }
  },
};

export default codexProvider;
