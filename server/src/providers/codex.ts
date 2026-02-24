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
 *
 * Top-level event types:
 * - {"type":"thread.started","thread_id":"..."} - Session created, thread_id for resume
 * - {"type":"turn.started"} - Model turn beginning
 * - {"type":"turn.completed","usage":{...}} - Turn done
 * - {"type":"turn.failed","error":...} - Turn errored (error can be string or object)
 * - {"type":"error","message":"..."} - Account-level error (usage limits, auth failures)
 * - {"type":"item.started","item":{...}} - Item beginning (command, mcp_tool_call, etc.)
 * - {"type":"item.completed","item":{...}} - Item finished
 * - {"type":"item.updated","item":{...}} - Item mid-flight update (streaming)
 *
 * Item types (inside item.started / item.completed / item.updated):
 * - agent_message — Response text → text_delta
 * - reasoning — Internal reasoning → hidden (message_start)
 * - command_execution — Shell command → tool_use (NOT text_delta — aggregated_output can be huge)
 * - file_change — File modification → tool_use
 * - mcp_tool_call — MCP tool invocation → tool_use
 * - web_search — Web search → tool_use
 * - plan_update — Agent planning → hidden (message_start)
 *
 * Any unknown TOP-LEVEL type throws ProviderParseError.
 * The 'error' top-level type (usage limits, auth failures) returns a ProviderEvent
 * error so it surfaces to the user in the web UI.
 * Unknown ITEM types log a warning and return message_start (Codex adds new item
 * types frequently and crashing on them is worse than ignoring them).
 */

import type { ModelInfo } from '@claude-web-view/shared';
import { buildCommand } from '@nbardy/agent-cli';
import { type Provider, type ProviderEvent, ProviderParseError, type SpawnConfig } from './index';

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
// NOTE: 'error' is emitted by Codex CLI for account-level failures (usage limits,
// auth errors) BEFORE or instead of turn.failed. It's distinct from turn.failed
// which covers model-level turn errors.
type CodexTopLevelType =
  | 'thread.started'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'error'
  | 'item.started'
  | 'item.completed'
  | 'item.updated';

// Type guard for top-level message types
function isCodexOutput(data: unknown): data is { type: CodexTopLevelType } {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as { type?: unknown };
  return (
    obj.type === 'thread.started' ||
    obj.type === 'turn.started' ||
    obj.type === 'turn.completed' ||
    obj.type === 'turn.failed' ||
    obj.type === 'error' ||
    obj.type === 'item.started' ||
    obj.type === 'item.completed' ||
    obj.type === 'item.updated'
  );
}

// =============================================================================
// Command Classifier — extracts semantic action from raw shell commands
//
// Codex wraps everything in `/bin/zsh -lc "..."`. We parse through that
// wrapper to identify the inner command and classify it as a human-readable
// action with an emoji and the relevant filename.
//
// Examples:
//   /bin/zsh -lc "sed -n '1,320p' train.py"    → 📖 train.py
//   /bin/zsh -lc "cat src/index.ts"             → 📖 index.ts
//   /bin/zsh -lc "python3 run.py"               → ▶️ run.py
//   /bin/zsh -lc "sed -i '' 's/old/new/' f.ts"  → ✏️ f.ts
// =============================================================================

interface ClassifiedCommand {
  emoji: string;
  label: string; // e.g. "train.py" or "python3 run.py"
}

/**
 * Unwrap shell wrapper (e.g. `/bin/zsh -lc "..."`) and return inner command.
 */
function unwrapShell(cmd: string): string {
  // Match: /bin/{sh,bash,zsh} -lc "..." or '...'
  const match =
    cmd.match(/^\/bin\/(?:ba)?sh\s+-\w*c\s+(['"])(.*)\1$/s) ??
    cmd.match(/^\/bin\/zsh\s+-\w*c\s+(['"])(.*)\1$/s);
  if (match) return match[2];
  return cmd;
}

/**
 * Extract just the filename (basename) from a path.
 */
function basename(filepath: string): string {
  return filepath.split('/').pop() ?? filepath;
}

/**
 * Classify a raw command into a semantic action with emoji.
 */
function classifyCommand(rawCommand: string): ClassifiedCommand {
  const cmd = unwrapShell(rawCommand).trim();

  // sed -n with only 'p' (print) = read
  if (/^sed\s+-n\s/.test(cmd) && !/-i/.test(cmd)) {
    const fileMatch = cmd.match(/['"]?\s+([\w./-]+)\s*$/);
    if (fileMatch) return { emoji: '📖', label: basename(fileMatch[1]) };
  }

  // sed -i = edit
  if (/^sed\s.*-i/.test(cmd)) {
    const fileMatch = cmd.match(/([\w./-]+)\s*$/);
    if (fileMatch) return { emoji: '✏️', label: basename(fileMatch[1]) };
  }

  // cat / head / tail / less / more = read
  if (/^(?:cat|head|tail|less|more)\s/.test(cmd)) {
    const fileMatch = cmd.match(/([\w./-]+)\s*$/);
    if (fileMatch) return { emoji: '📖', label: basename(fileMatch[1]) };
  }

  // ls / find / tree = browse
  if (/^(?:ls|find|tree)\s/.test(cmd)) {
    return { emoji: '📂', label: cmd.split(/\s+/).slice(0, 3).join(' ') };
  }

  // grep / rg / ag = search
  if (/^(?:grep|rg|ag)\s/.test(cmd)) {
    return { emoji: '🔍', label: cmd.length > 40 ? cmd.substring(0, 37) + '...' : cmd };
  }

  // python / python3 / node / npm / npx / cargo / go = run
  if (/^(?:\.?\.?\/|)(?:python3?|node|npm|npx|cargo|go|ruby|perl|java)\s/.test(cmd)) {
    // Show command + first arg (usually the script)
    const parts = cmd.split(/\s+/);
    const script = parts[1] ? basename(parts[1]) : '';
    return { emoji: '▶️', label: `${basename(parts[0])} ${script}`.trim() };
  }

  // pip / uv / npm install = install
  if (/^(?:pip|uv|npm)\s+install/.test(cmd)) {
    return { emoji: '📦', label: cmd.length > 40 ? cmd.substring(0, 37) + '...' : cmd };
  }

  // git = git
  if (/^git\s/.test(cmd)) {
    return { emoji: '🔀', label: cmd.length > 40 ? cmd.substring(0, 37) + '...' : cmd };
  }

  // mkdir / cp / mv / rm = file ops
  if (/^(?:mkdir|cp|mv|rm)\s/.test(cmd)) {
    const fileMatch = cmd.match(/([\w./-]+)\s*$/);
    if (fileMatch)
      return { emoji: '📁', label: `${cmd.split(/\s+/)[0]} ${basename(fileMatch[1])}` };
  }

  // chmod / chown = permissions
  if (/^(?:chmod|chown)\s/.test(cmd)) {
    return { emoji: '🔒', label: cmd.length > 40 ? cmd.substring(0, 37) + '...' : cmd };
  }

  // Fallback: show truncated command
  return { emoji: '⚡', label: cmd.length > 50 ? cmd.substring(0, 47) + '...' : cmd };
}

// =============================================================================
// Provider Implementation
// =============================================================================

const codexProvider: Provider = {
  name: 'codex',

  listModels(): ModelInfo[] {
    return [
      { id: 'gpt-5.3-codex-high', displayName: 'GPT-5.3 Codex (High Effort)', isDefault: true },
      {
        id: 'gpt-5.3-codex-medium',
        displayName: 'GPT-5.3 Codex (Medium Effort)',
        isDefault: false,
      },
      {
        id: 'gpt-5.3-codex-xhigh',
        displayName: 'GPT-5.3 Codex (Extra High Effort)',
        isDefault: false,
      },
      {
        id: 'gpt-5.3-codex-spark',
        displayName: 'GPT-5.3 Codex Spark (Ultra-Fast)',
        isDefault: false,
      },
      {
        id: 'gpt-5.3-codex-spark-high',
        displayName: 'GPT-5.3 Codex Spark (High Effort)',
        isDefault: false,
      },
      {
        id: 'gpt-5.3-codex-spark-medium',
        displayName: 'GPT-5.3 Codex Spark (Medium Effort)',
        isDefault: false,
      },
      {
        id: 'gpt-5.3-codex-spark-xhigh',
        displayName: 'GPT-5.3 Codex Spark (Extra High Effort)',
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
    // Agent-cli handles: exec subcommand, resume <id> restructuring, -C suppression
    // on resume, model decomposition (composite IDs), bypass flags.
    //
    // Project-specific: --json (streaming output) and `-` (read prompt from stdin).
    // Prompt text is NOT passed here — delivered via stdin (formatInput).
    const maxPermissions = process.env.CODEX_MAX_PERMISSIONS !== 'false';
    if (maxPermissions) {
      console.log('[codex] MAX PERMISSIONS MODE enabled');
    }

    const spec = buildCommand('codex', {
      model: modelId,
      sessionId,
      resume,
      cwd: workingDir,
      bypassPermissions: maxPermissions,
      extraArgs: ['--json', '-'],
    });

    return {
      command: spec.argv[0],
      args: spec.argv.slice(1),
      options: {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
      stdout: spec.stdout,
    };
  },

  getSingleShotConfig(prompt: string): SpawnConfig {
    // Single-shot: pass prompt as positional argument, no --json, collect text output.
    // Codex has no `-q` flag. Plain `codex exec <prompt>` outputs text to stdout.
    return {
      command: 'codex',
      args: ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt],
      options: {},
      stdout: 'text',
    };
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
      throw new ProviderParseError('codex', json, `Unknown message type: ${JSON.stringify(json)}`);
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
        const msg = json as CodexItemStarted;
        if (msg.item.type === 'command_execution' && msg.item.command) {
          const { emoji, label } = classifyCommand(msg.item.command);
          return {
            type: 'tool_use',
            name: 'shell',
            input: { command: msg.item.command },
            displayText: `${emoji} ${label}\n`,
          };
        }
        if (msg.item.type === 'mcp_tool_call') {
          const name = (msg.item as { name?: string }).name ?? 'mcp_tool';
          return {
            type: 'tool_use',
            name,
            input: {},
            displayText: `\n[MCP: ${name}]\n`,
          };
        }
        // Other item.started types (web_search, etc.) — no-op
        return { type: 'message_start' };
      }

      case 'item.completed': {
        const msg = json as {
          type: 'item.completed';
          item: { type: string; [k: string]: unknown };
        };
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
            // Command completed — item.started already showed the action.
            // Only surface errors (non-zero exit). Success is silent.
            const cmdMsg = json as CodexItemCompletedCommand;
            const exitCode = cmdMsg.item.exit_code;
            if (exitCode !== 0) {
              const { emoji, label } = classifyCommand(cmdMsg.item.command);
              return {
                type: 'tool_use',
                name: 'shell',
                input: { command: cmdMsg.item.command, exit_code: exitCode },
                displayText: `${emoji} ${label} ❌ exit ${exitCode}\n`,
              };
            }
            // Success — no displayText, item.started already showed the action
            return {
              type: 'tool_use',
              name: 'shell',
              input: { command: cmdMsg.item.command, exit_code: 0 },
            };
          }

          case 'file_change': {
            // File modification — show emoji + filename per change
            const fileMsg = json as CodexItemCompletedFileChange;
            const descriptions = fileMsg.item.changes.map((c) => {
              const emoji = c.kind === 'create' ? '✍️' : c.kind === 'delete' ? '🗑️' : '✏️';
              return `${emoji} ${basename(c.path)}`;
            });
            return {
              type: 'tool_use',
              name: 'file_change',
              input: { changes: fileMsg.item.changes },
              displayText: `${descriptions.join('\n')}\n`,
            };
          }

          case 'mcp_tool_call': {
            // MCP tool completed — show as tool_use with summary
            const name = (msg.item as { name?: string }).name ?? 'mcp_tool';
            return {
              type: 'tool_use',
              name,
              input: {},
              displayText: `[MCP completed: ${name}]\n`,
            };
          }

          case 'web_search':
            // Web search completed — show as tool_use
            return {
              type: 'tool_use',
              name: 'web_search',
              input: {},
              displayText: `[Web search completed]\n`,
            };

          case 'plan_update':
            // Agent planning — internal, don't show to user
            return { type: 'message_start' };

          default:
            // Codex adds new item types frequently. Crashing on an unknown
            // item type is worse than ignoring it — log and continue.
            console.warn(`[codex] Unknown item.completed type: ${itemType}`);
            return { type: 'message_start' };
        }
      }

      case 'turn.completed':
        return { type: 'message_complete' };

      case 'turn.failed': {
        // Turn errored — surface to user.
        // The error field can be a string or an object (e.g. {message: "..."}).
        const rawErr = (json as { error?: unknown }).error;
        const errMsg =
          typeof rawErr === 'string'
            ? rawErr
            : typeof rawErr === 'object' && rawErr !== null && 'message' in rawErr
              ? String((rawErr as { message: unknown }).message)
              : (JSON.stringify(rawErr) ?? 'Unknown error');
        return { type: 'error', message: `Codex turn failed: ${errMsg}` };
      }

      case 'error': {
        // Account-level errors (usage limits, auth failures).
        // Emitted as a standalone top-level event, often before turn.failed.
        const msg = (json as { message?: unknown }).message;
        const errorText = typeof msg === 'string' ? msg : JSON.stringify(json);
        return { type: 'error', message: errorText };
      }

      case 'item.updated':
        // Mid-flight streaming update — no-op (we get the final in item.completed)
        return { type: 'message_start' };
    }
  },
};

export default codexProvider;
