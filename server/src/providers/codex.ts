/**
 * Codex CLI Provider
 *
 * DESIGN: One clean path, no fallbacks, fail eagerly.
 *
 * Handles spawning and parsing Codex CLI (exec --json mode)
 *
 * SESSION MANAGEMENT:
 * - First message: `codex exec --json -C <workingDir> -` (stdin prompt)
 * - Subsequent messages: `codex exec resume <sessionId> --json -` (stdin prompt)
 * - Codex self-persists sessions to ~/.codex/sessions/YYYY/MM/DD/*.jsonl
 * - Session IDs (thread_id) are UUIDs emitted in the thread.started event
 *
 * KNOWN OUTPUT TYPES from Codex CLI (--json mode):
 * - {"type":"thread.started","thread_id":"..."} - Session created, thread_id for resume
 * - {"type":"turn.started"} - Model turn beginning
 * - {"type":"item.started","item":{"type":"command_execution","command":"...","status":"in_progress"}} - Command starting
 * - {"type":"item.completed","item":{"type":"reasoning","text":"..."}} - Internal reasoning (hidden)
 * - {"type":"item.completed","item":{"type":"agent_message","text":"..."}} - Response text
 * - {"type":"item.completed","item":{"type":"command_execution","command":"...","aggregated_output":"...","exit_code":0}} - Command result
 * - {"type":"item.completed","item":{"type":"file_change","changes":[...]}} - File modification
 * - {"type":"turn.completed","usage":{...}} - Turn done
 *
 * Any other type throws ProviderParseError.
 */

import type { ModelInfo } from '@claude-web-view/shared';
import { ProviderParseError, type Provider, type SpawnConfig, type ProviderEvent } from './index';

// =============================================================================
// Codex CLI JSON Output Types - STRICT, NO CATCH-ALL
//
// Derived from real `codex exec --json` output. These are the actual types
// emitted by the Codex CLI, not aspirational types.
// =============================================================================

interface CodexThreadStarted {
  type: 'thread.started';
  thread_id: string;
}

interface CodexTurnStarted {
  type: 'turn.started';
}

interface CodexItemStarted {
  type: 'item.started';
  item: {
    id: string;
    type: string;
    command?: string;
    status?: string;
  };
}

interface CodexItemCompletedReasoning {
  type: 'item.completed';
  item: {
    id: string;
    type: 'reasoning';
    text: string;
  };
}

interface CodexItemCompletedMessage {
  type: 'item.completed';
  item: {
    id: string;
    type: 'agent_message';
    text: string;
  };
}

interface CodexItemCompletedCommand {
  type: 'item.completed';
  item: {
    id: string;
    type: 'command_execution';
    command: string;
    aggregated_output: string;
    exit_code: number;
    status: string;
  };
}

interface CodexItemCompletedFileChange {
  type: 'item.completed';
  item: {
    id: string;
    type: 'file_change';
    changes: Array<{ path: string; kind: string }>;
    status: string;
  };
}

interface CodexTurnCompleted {
  type: 'turn.completed';
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  };
}

// The top-level type discriminant
type CodexTopLevelType = 'thread.started' | 'turn.started' | 'item.started' | 'item.completed' | 'turn.completed';

// Type guard for top-level message types
function isCodexOutput(data: unknown): data is { type: CodexTopLevelType } {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as { type?: unknown };
  return (
    obj.type === 'thread.started' ||
    obj.type === 'turn.started' ||
    obj.type === 'item.started' ||
    obj.type === 'item.completed' ||
    obj.type === 'turn.completed'
  );
}

// =============================================================================
// Provider Implementation
// =============================================================================

// Known effort levels for composite model ID decomposition.
// Composite format: "{model}-{effort}" e.g. "gpt-5.2-high"
// Matched as suffixes to avoid ambiguity with model names containing hyphens.
const CODEX_EFFORT_LEVELS = ['medium', 'high', 'xhigh'] as const;

const codexProvider: Provider = {
  name: 'codex',

  listModels(): ModelInfo[] {
    return [
      { id: 'gpt-5.2-high', displayName: 'GPT-5.2 (High Effort)', isDefault: true },
      { id: 'gpt-5.2-medium', displayName: 'GPT-5.2 (Medium Effort)', isDefault: false },
      { id: 'gpt-5.2-xhigh', displayName: 'GPT-5.2 (Extra High Effort)', isDefault: false },
    ];
  },

  modelToParams(modelId?: string): string[] {
    if (!modelId) return [];

    // Decompose composite ID: "gpt-5.2-high" → model="gpt-5.2", effort="high"
    // Split on the LAST segment matching a known effort level.
    for (const effort of CODEX_EFFORT_LEVELS) {
      if (modelId.endsWith(`-${effort}`)) {
        const model = modelId.slice(0, -(effort.length + 1));
        return ['-m', model, '-c', `model_reasoning_effort=${effort}`];
      }
    }

    throw new Error(`Invalid Codex model identifier: ${modelId}. Expected format: "model-effort" (e.g. gpt-5.2-high)`);
  },

  getSpawnConfig(sessionId: string, workingDir: string, resume = false, modelId?: string): SpawnConfig {
    // Codex exec reads prompt from stdin when `-` is passed as the prompt argument.
    // First message: `codex exec --json -C <workingDir> -`
    // Subsequent: `codex exec resume <sessionId> --json -`
    //
    // The `-` tells Codex to read the prompt from stdin (matching the server's
    // pattern of writing to stdin then closing it).
    const args: string[] = [];

    if (resume) {
      args.push('exec', 'resume', sessionId, '--json');
    } else {
      args.push('exec', '--json', '-C', workingDir);
    }

    // Model/effort selection — splice in CLI flags for selected model
    args.push(...this.modelToParams(modelId));

    // MAX PERMISSIONS MODE (enabled by default):
    // Bypass all approval prompts and sandbox restrictions.
    // Set CODEX_MAX_PERMISSIONS=false to disable.
    // WARNING: Only use in trusted/sandboxed environments!
    const maxPermissions = process.env.CODEX_MAX_PERMISSIONS !== 'false';
    if (maxPermissions) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
      console.log('[codex] MAX PERMISSIONS MODE enabled');
    }

    // `-` as positional prompt arg tells Codex to read from stdin
    args.push('-');

    return {
      command: 'codex',
      args,
      options: {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    };
  },

  getSingleShotConfig(prompt: string): SpawnConfig {
    // Single-shot: pass prompt as positional argument, no --json, collect text output.
    // Codex has no `-q` flag. Plain `codex exec <prompt>` outputs text to stdout.
    return {
      command: 'codex',
      args: ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt],
      options: {},
    };
  },

  formatInput(content: string): string {
    return `${content}\n`;
  },

  /**
   * Parse Codex CLI --json output into unified ProviderEvents.
   *
   * Real protocol (from `codex exec --json`):
   *   thread.started  → message_start (also captures thread_id for resume)
   *   turn.started    → message_start (no-op)
   *   item.started    → tool_use (command starting, shown inline)
   *   item.completed  → text_delta (agent_message), tool_use (command/file_change),
   *                     or message_start (reasoning — hidden from user)
   *   turn.completed  → message_complete
   *
   * @throws ProviderParseError on unknown message types — no fallbacks.
   */
  parseOutput(json: unknown): ProviderEvent {
    if (!isCodexOutput(json)) {
      throw new ProviderParseError(
        'codex',
        json,
        `Unknown message type: ${JSON.stringify(json)}`
      );
    }

    switch (json.type) {
      case 'thread.started': {
        // Session created — thread_id is used for `codex exec resume <id>`
        const msg = json as CodexThreadStarted;
        console.log(`[codex] Thread started: ${msg.thread_id}`);
        return { type: 'message_start' };
      }

      case 'turn.started':
        return { type: 'message_start' };

      case 'item.started': {
        // Command execution beginning — show it inline
        const msg = json as CodexItemStarted;
        if (msg.item.type === 'command_execution' && msg.item.command) {
          return {
            type: 'tool_use',
            name: 'shell',
            input: { command: msg.item.command },
            displayText: `\n[Running: ${msg.item.command}]\n`,
          };
        }
        // Other item.started types — no-op
        return { type: 'message_start' };
      }

      case 'item.completed': {
        const msg = json as { type: 'item.completed'; item: { type: string; [k: string]: unknown } };
        const itemType = msg.item.type;

        switch (itemType) {
          case 'agent_message': {
            // The actual response text
            const agentMsg = json as CodexItemCompletedMessage;
            return { type: 'text_delta', text: agentMsg.item.text };
          }

          case 'reasoning':
            // Internal reasoning — don't show to user
            return { type: 'message_start' };

          case 'command_execution': {
            // Command completed — show output inline
            const cmdMsg = json as CodexItemCompletedCommand;
            const output = cmdMsg.item.aggregated_output;
            if (output) {
              return { type: 'text_delta', text: `\n\`\`\`\n${output}\`\`\`\n` };
            }
            return { type: 'message_start' };
          }

          case 'file_change': {
            // File modification — show what changed
            const fileMsg = json as CodexItemCompletedFileChange;
            const descriptions = fileMsg.item.changes.map(
              (c) => `[${c.kind}: ${c.path}]`
            );
            return {
              type: 'tool_use',
              name: 'file_change',
              input: { changes: fileMsg.item.changes },
              displayText: `\n${descriptions.join('\n')}\n`,
            };
          }

          default:
            throw new ProviderParseError(
              'codex',
              json,
              `Unknown item.completed type: ${itemType}`
            );
        }
      }

      case 'turn.completed':
        return { type: 'message_complete' };

      default: {
        // Should be unreachable due to isCodexOutput guard
        throw new ProviderParseError(
          'codex',
          json,
          `Unhandled message type: ${(json as { type: string }).type}`
        );
      }
    }
  },
};

export default codexProvider;
