/**
 * Provider abstraction for CLI tools (Claude, Codex, etc.)
 *
 * DESIGN PRINCIPLE: One clean path, no fallbacks, fail eagerly.
 *
 * Two usage modes:
 *
 * 1. CONVERSATION MODE (stateful, streaming)
 *    - getSpawnConfig() → spawn process → write stdin → close stdin → parse streaming stdout
 *    - parseOutput() normalizes each JSON line into a ProviderEvent
 *    - Session continuity via sessionId + resume flag
 *    - Used by: Conversation.spawnForMessage() in server.ts
 *
 * 2. SINGLE-SHOT MODE (stateless, collect-all)
 *    - getSingleShotConfig(prompt) → spawn process → collect all stdout → parse as text
 *    - No session, no streaming. One prompt in, one text response out.
 *    - Used by: utility endpoints (palette generation, etc.)
 *
 * Unified event types returned by parseOutput (conversation mode only):
 * - { type: 'message_start' } - new message / structural no-op
 * - { type: 'text_delta', text } - streaming text chunk
 * - { type: 'message_complete' } - message finished
 * - { type: 'tool_use', name, input, displayText? } - tool invocation
 * - { type: 'error', message } - error occurred
 *
 * If parseOutput encounters an unknown type, it MUST throw ProviderParseError.
 * No fallbacks. No nulls. Fail eagerly.
 */

import type { Provider as ProviderName, ModelInfo } from '@claude-web-view/shared';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import claudeProvider from './claude';
import codexProvider from './codex';

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error thrown when parseOutput encounters an unknown message type.
 * One clean path - unknown types are errors, not silent failures.
 */
export class ProviderParseError extends Error {
  constructor(
    public readonly provider: string,
    public readonly rawData: unknown,
    message: string
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderParseError';
  }
}

// =============================================================================
// Provider Types
// =============================================================================

/**
 * Spawn configuration returned by a provider.
 * Used by both conversation mode (getSpawnConfig) and single-shot mode (getSingleShotConfig).
 */
export interface SpawnConfig {
  command: string;
  args: string[];
  options: SpawnOptionsWithoutStdio;
}

/**
 * Unified event types emitted by parseOutput (conversation mode).
 * All providers normalize their CLI-specific output to these types.
 *
 * - message_start: New message beginning, or a structural no-op (e.g. stream_event
 *   with no content). Safe to ignore — the server only acts on text_delta,
 *   tool_use, and message_complete.
 *
 * - text_delta: A chunk of streaming text. Server appends to current assistant
 *   message and broadcasts to WebSocket clients.
 *
 * - message_complete: The response is done. Server dequeues the sent message,
 *   persists if needed, and processes the next queued message.
 *
 * - tool_use: The agent invoked a tool. Server tracks sub-agents if name === 'Task'.
 *   displayText is shown inline in the chat (e.g. "[Using tool: Read]").
 *
 * - error: Something went wrong. Server throws.
 */
export type ProviderEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'message_complete' }
  | { type: 'tool_use'; name: string; input: Record<string, unknown>; displayText?: string }
  | { type: 'error'; message: string };

/**
 * Provider interface that all CLI agent wrappers must implement.
 *
 * CONTRACT:
 * - parseOutput() MUST return a ProviderEvent or throw ProviderParseError. Never null.
 * - getSpawnConfig() returns the spawn config for CONVERSATION mode (streaming JSON, per-message).
 * - getSingleShotConfig() returns the spawn config for SINGLE-SHOT mode (one prompt, text output).
 * - formatInput() formats a user message string for the CLI's stdin.
 *
 * ADDING A NEW PROVIDER:
 * 1. Create server/src/providers/{name}.ts implementing this interface
 * 2. Add to ProviderSchema in shared/src/index.ts: z.enum([..., '{name}'])
 * 3. Register in the providers record below
 * 4. Add persistence adapter if the agent doesn't self-persist (see codex-persistence.ts)
 *
 * See docs/agent_client_spec.md for the full specification.
 */
export interface Provider {
  /** Provider identifier — must match a value in the ProviderSchema enum */
  name: ProviderName;

  /**
   * List available models for this provider.
   * Used by GET /api/models to populate the client's model dropdown.
   * Exactly one model MUST have isDefault: true.
   */
  listModels(): ModelInfo[];

  /**
   * Convert a model identifier into CLI args to splice into getSpawnConfig().
   * Returns an array of strings to spread into the args array.
   *
   * Examples:
   *   Claude 'opus'        → ['--model', 'opus']
   *   Codex 'gpt-5.2-high' → ['-m', 'gpt-5.2', '-c', 'model_reasoning_effort=high']
   *
   * If modelId is undefined, returns [] (CLI uses its built-in default).
   */
  modelToParams(modelId?: string): string[];

  /**
   * CONVERSATION MODE: Get spawn config for a multi-turn session.
   *
   * The server spawns one process per message. Each process:
   * 1. Receives user input on stdin (formatted by formatInput())
   * 2. Emits streaming JSON on stdout (parsed by parseOutput())
   * 3. Exits when the response is complete
   *
   * @param sessionId - Unique session ID for conversation continuity.
   *   Claude uses this for --session-id/--resume. Codex ignores it (stateless).
   *   See: Conversation.claudeSessionId in server.ts (should be renamed to sessionId).
   *
   * @param workingDir - Working directory for the CLI process.
   *   Passed as cwd in spawn options and/or as a CLI flag.
   *
   * @param resume - True if this is NOT the first message in the session.
   *   Claude: first turn uses --session-id, subsequent use --resume.
   *   Codex: ignores this (each message is independent).
   *
   * @param modelId - Provider-specific model identifier from listModels().
   *   Decomposed into CLI flags by modelToParams().
   */
  getSpawnConfig(sessionId: string, workingDir: string, resume?: boolean, modelId?: string): SpawnConfig;

  /**
   * SINGLE-SHOT MODE: Get spawn config for a one-off prompt.
   *
   * No session, no streaming JSON. The prompt is passed as a CLI argument,
   * stdout is collected as plain text, and the process exits.
   *
   * Used for utility tasks: palette generation, summarization, etc.
   *
   * @param prompt - The full prompt text to send to the agent.
   *
   * Callers collect stdout after process close and parse the text result themselves.
   * There is no parseOutput() call — single-shot output is plain text, not JSON.
   *
   * Claude: `claude -p "<prompt>" --output-format text`
   * Codex: `codex -q "<prompt>"` (quiet mode, text output)
   */
  getSingleShotConfig(prompt: string): SpawnConfig;

  /**
   * Format user input for this provider's CLI stdin (conversation mode only).
   *
   * The server writes this to the spawned process's stdin, then closes stdin
   * to signal that input is complete.
   *
   * @param content - Raw user message text
   * @returns Formatted string to write to stdin (typically content + '\n')
   */
  formatInput(content: string): string;

  /**
   * Parse one line of CLI JSON output into a unified ProviderEvent (conversation mode only).
   *
   * Called for each complete line of stdout from the conversation-mode process.
   * The server buffers stdout by newline before calling this — each call receives
   * one parsed JSON object.
   *
   * MUST return a ProviderEvent or throw ProviderParseError.
   * Unknown message types MUST throw — they indicate a protocol change.
   * Never return null. Never silently ignore unknown types.
   *
   * @param json - Parsed JSON object from one line of stdout
   * @throws ProviderParseError on unknown/invalid message types
   */
  parseOutput(json: unknown): ProviderEvent;
}

// =============================================================================
// Provider Registry
// =============================================================================

const providers: Record<ProviderName, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
};

/**
 * Get a provider by name
 * @param name - Provider name ('claude' or 'codex')
 * @throws Error if provider not found
 */
export function getProvider(name: ProviderName): Provider {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown provider: ${name}. Available: ${Object.keys(providers).join(', ')}`);
  }
  return provider;
}

export { providers };
