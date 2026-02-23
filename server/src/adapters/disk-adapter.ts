/**
 * DiskAdapter — shared interface for reading persisted CLI agent sessions from disk.
 *
 * Design: One DiskAdapter per CLI provider (Claude, Codex, OpenCode, Gemini, …).
 * Adding a new provider = one new file implementing DiskAdapter. Zero changes to
 * the core load/poll loop in loader.ts.
 *
 * Flow:
 *   DiskAdapter.discoverFiles() → string[]    (paths to scan)
 *   DiskAdapter.parseFile(path) → ParsedSession | null  (null = skip)
 *   sessionToConversation(ParsedSession) → Conversation | null  (null = hidden)
 */

import type { Message, Conversation, Provider, SubAgent } from '@claude-web-view/shared';
import { extractWorkerMetadata } from './jsonl';

// =============================================================================
// Normalized session output — all adapters produce this before conversion
// =============================================================================

/**
 * Normalized representation of a parsed CLI session — output of every DiskAdapter.parseFile().
 * All provider-specific types (JsonlSession, CodexSession, etc.) convert to this before
 * reaching the shared sessionToConversation() function.
 */
export interface ParsedSession {
  sessionId: string;
  filePath: string;        // path used for mtime tracking
  workingDirectory: string;
  provider: Provider;      // set by the adapter (claude may use inferProviderFromModel)
  model: string;           // 'unknown' if unavailable
  createdAt: Date;
  modifiedAt: Date;
  messages: Message[];
  subAgents?: SubAgent[];          // Claude only — extracted from JSONL entries
  parentSessionId?: string | null; // Codex only — for nested thread display
}

// =============================================================================
// DiskAdapter interface
// =============================================================================

/**
 * One implementation per CLI agent. Adding a new provider = one new file implementing this.
 * discoverFiles() returns paths to session files/dirs (whatever parseFile() expects).
 * parseFile() returns null for empty/invalid sessions (caller skips them).
 */
export interface DiskAdapter {
  provider: Provider;
  discoverFiles(): Promise<string[]>;
  parseFile(filePath: string): Promise<ParsedSession | null>;
}

// =============================================================================
// Shared result types (used by loader.ts)
// =============================================================================

export interface LoadResult {
  conversations: Map<string, Conversation>;
  mtimes: Map<string, number>; // filepath → mtime ms
}

export interface PollResult {
  updated: Map<string, Conversation>; // changed or new conversations
  mtimes: Map<string, number>;        // full updated mtime index
}

export type LoadProgressCallback = (
  batch: Conversation[],
  progress: { loaded: number; total: number }
) => void;

// =============================================================================
// Shared session → Conversation conversion
// =============================================================================

/**
 * Convert a ParsedSession to a Conversation.
 * Returns null for [_HIDE_TEST_] conversations (dropped at ingestion).
 * Detects oompa workers by checking for "[oompa...]" tag in the first user message.
 *
 * This is the single canonical conversion function replacing the four near-identical
 * jsonlSessionToConversation / codexSessionToConversation / openCodeSessionToConversation /
 * geminiSessionToConversation functions that previously existed in jsonl.ts.
 */
export function sessionToConversation(session: ParsedSession): Conversation | null {
  // extractWorkerMetadata mutates messages (strips tags from first user message)
  // so we pass the messages array directly.
  const worker = extractWorkerMetadata(session.messages);
  if (worker.isHidden) return null;

  return {
    id: session.sessionId,
    messages: session.messages,
    isRunning: false,
    isStreaming: false, // Loaded from disk — process is dead
    confirmed: true,
    createdAt: session.createdAt,
    workingDirectory: session.workingDirectory,
    provider: session.provider,
    subAgents: session.subAgents ?? [],
    queue: [],
    isWorker: worker.isWorker,
    swarmId: worker.swarmId ?? null,
    workerId: worker.workerId ?? null,
    workerRole: worker.workerRole ?? null,
    parentConversationId: session.parentSessionId ?? null,
    modelName: session.model !== 'unknown' ? session.model : null,
  };
}
