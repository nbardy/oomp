/**
 * Provider abstraction for CLI tools (Claude, Codex, etc.)
 *
 * DESIGN PRINCIPLE: One clean path, no fallbacks, fail eagerly.
 *
 * Each provider implements:
 * - getSpawnConfig(sessionId, workingDir) - returns { command, args, options }
 * - formatInput(content) - formats a user message for the CLI's stdin
 * - parseOutput(json) - parses CLI stdout JSON and returns unified events
 *
 * Unified event types returned by parseOutput:
 * - { type: 'message_start' } - new assistant message starting
 * - { type: 'text_delta', text: '...' } - streaming text chunk
 * - { type: 'message_complete' } - message finished
 * - { type: 'tool_use', name: '...', input: {...} } - tool invocation
 * - { type: 'error', message: '...' } - error occurred
 *
 * If parseOutput encounters an unknown type, it MUST throw ProviderParseError.
 * No fallbacks. No nulls. Fail eagerly.
 */

import type { Provider as ProviderName } from '@claude-web-view/shared';
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
 * Spawn configuration returned by a provider
 */
export interface SpawnConfig {
  command: string;
  args: string[];
  options: SpawnOptionsWithoutStdio;
}

/**
 * Unified event types emitted by parseOutput.
 * All providers normalize their output to these types.
 *
 * Note: Sub-agent tracking (Task tool) is handled at the server level
 * by detecting tool_use events with name === 'Task'. The server broadcasts
 * subagent_start/update/complete WebSocket messages directly.
 */
export type ProviderEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'message_complete' }
  | { type: 'tool_use'; name: string; input: Record<string, unknown>; displayText?: string }
  | { type: 'error'; message: string };

/**
 * Provider interface that all CLI providers must implement.
 *
 * IMPORTANT: parseOutput must always return a ProviderEvent or throw.
 * No nulls. No fallbacks. Unknown types throw ProviderParseError.
 */
export interface Provider {
  name: ProviderName;

  /**
   * Get spawn configuration for this provider's CLI
   * @param sessionId - Session ID for conversation continuity
   * @param workingDir - Working directory for the process
   * @param resume - True if resuming an existing session (use --resume instead of --session-id)
   */
  getSpawnConfig(sessionId: string, workingDir: string, resume?: boolean): SpawnConfig;

  /**
   * Format user input for this provider's CLI stdin
   * @param content - User message content
   * @returns Formatted string to write to stdin
   */
  formatInput(content: string): string;

  /**
   * Parse CLI JSON output into unified events.
   * @param json - Parsed JSON from stdout
   * @returns Unified event - NEVER null
   * @throws ProviderParseError on unknown message types
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
