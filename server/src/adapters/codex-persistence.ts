/**
 * Codex Conversation Persistence
 *
 * Writes Codex conversation messages to JSONL files for persistence across server restarts.
 *
 * WHY SEPARATE FROM CLAUDE: Codex CLI doesn't support session resumption like Claude Code does.
 * Claude Code writes its own JSONL files that can be resumed with --resume. Codex doesn't, so
 * we maintain our own persistence layer to enable conversation history across restarts.
 *
 * Storage Location: ~/.claude-web-view/codex/{encoded-cwd}/{session-id}.jsonl
 * Format: Newline-delimited JSON, one entry per message
 *
 * Entry Format:
 * {"type":"user","timestamp":"2026-01-28T...","message":{"role":"user","content":"..."}}
 * {"type":"assistant","timestamp":"2026-01-28T...","message":{"role":"assistant","content":"..."}}
 *
 * CRITICAL: Persistence failures are logged but don't throw - they should never break active conversations.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Message } from '@claude-web-view/shared';

// =============================================================================
// Constants
// =============================================================================

/** Base directory for Codex conversation persistence */
export const CODEX_PERSISTENCE_DIR = path.join(os.homedir(), '.claude-web-view', 'codex');

// =============================================================================
// Path Encoding (matching Claude Code's convention)
// =============================================================================

/**
 * Encode a working directory path for use as a directory name.
 * Matches Claude Code's encoding: replace '/' with '-'
 *
 * Examples:
 *   /Users/nick/project -> -Users-nick-project
 *   /home/user/code -> -home-user-code
 */
export function encodeWorkingDirectory(workingDir: string): string {
  // Normalize path first (resolve .., remove trailing slashes)
  const normalized = path.resolve(workingDir);
  // Replace all slashes with dashes
  return normalized.replace(/\//g, '-');
}

/**
 * Get the persistence directory for a specific working directory.
 * Creates directory structure if it doesn't exist.
 *
 * @param workingDir - The working directory path
 * @returns Absolute path to the project's persistence directory
 */
export function getProjectDirectory(workingDir: string): string {
  const encoded = encodeWorkingDirectory(workingDir);
  return path.join(CODEX_PERSISTENCE_DIR, encoded);
}

/**
 * Get the full path to a session's JSONL file.
 *
 * @param sessionId - UUID for the conversation session
 * @param workingDir - The working directory path
 * @returns Absolute path to the session's JSONL file
 */
export function getSessionFilePath(sessionId: string, workingDir: string): string {
  const projectDir = getProjectDirectory(workingDir);
  return path.join(projectDir, `${sessionId}.jsonl`);
}

// =============================================================================
// JSONL Entry Formatting
// =============================================================================

/**
 * JSONL entry structure for Codex messages.
 * Uses same structure as Claude Code for compatibility with our loader.
 */
interface CodexJsonlEntry {
  type: 'user' | 'assistant' | 'system';
  timestamp: string;
  cwd?: string;
  message: {
    role: 'user' | 'assistant' | 'system';
    content: string | Array<{ type: string; text: string }>;
  };
}

/**
 * Format a message as a JSONL entry (single line of JSON).
 * Uses same format as Claude Code's JSONL for compatibility.
 *
 * @param message - The message to format
 * @param workingDir - The working directory (optional, for cwd field)
 * @returns Single-line JSON string with newline
 */
function formatMessageAsJsonl(message: Message, workingDir?: string): string {
  const entry: CodexJsonlEntry = {
    type: message.role,
    timestamp: message.timestamp.toISOString(),
    message: {
      role: message.role,
      // For assistant messages, wrap in content array like Claude Code does
      content: message.role === 'assistant'
        ? [{ type: 'text', text: message.content }]
        : message.content,
    },
  };

  // Add cwd for first entry or user messages
  if (workingDir) {
    entry.cwd = workingDir;
  }

  return JSON.stringify(entry) + '\n';
}

// =============================================================================
// Persistence Functions
// =============================================================================

/**
 * Ensure the project directory exists, creating it if necessary.
 *
 * @param projectDir - Path to the project directory
 */
async function ensureDirectoryExists(projectDir: string): Promise<void> {
  try {
    await fs.promises.mkdir(projectDir, { recursive: true });
  } catch (error) {
    // Log but don't throw - we'll catch the write error below
    console.error(`[codex-persistence] Failed to create directory ${projectDir}:`, error);
  }
}

/**
 * Write a single message to the session's JSONL file.
 * Uses append mode to add to existing file or create new one.
 *
 * CRITICAL: This function catches and logs all errors - it never throws.
 * Persistence failures should not break active conversations.
 *
 * @param sessionId - UUID for the conversation session
 * @param workingDir - The working directory path
 * @param message - The message to persist
 */
export async function writeCodexMessage(
  sessionId: string,
  workingDir: string,
  message: Message
): Promise<void> {
  try {
    // Get paths
    const projectDir = getProjectDirectory(workingDir);
    const filePath = getSessionFilePath(sessionId, workingDir);

    // Ensure directory exists
    await ensureDirectoryExists(projectDir);

    // Format message as JSONL (include cwd for context)
    const jsonlLine = formatMessageAsJsonl(message, workingDir);

    // Append to file (creates if doesn't exist)
    await fs.promises.appendFile(filePath, jsonlLine, 'utf-8');

    console.log(`[codex-persistence] Wrote ${message.role} message to ${path.basename(filePath)}`);
  } catch (error) {
    // Log error but don't throw - persistence failures shouldn't break conversations
    console.error(
      `[codex-persistence] Failed to write message for session ${sessionId}:`,
      error
    );
  }
}

/**
 * Write multiple messages to the session's JSONL file in bulk.
 * Useful for initializing a new session file with existing messages.
 *
 * @param sessionId - UUID for the conversation session
 * @param workingDir - The working directory path
 * @param messages - Array of messages to persist
 */
export async function writeCodexMessages(
  sessionId: string,
  workingDir: string,
  messages: Message[]
): Promise<void> {
  try {
    // Get paths
    const projectDir = getProjectDirectory(workingDir);
    const filePath = getSessionFilePath(sessionId, workingDir);

    // Ensure directory exists
    await ensureDirectoryExists(projectDir);

    // Format all messages as JSONL
    const jsonlLines = messages.map((msg, i) =>
      formatMessageAsJsonl(msg, i === 0 ? workingDir : undefined)
    ).join('');

    // Write to file (creates or overwrites)
    await fs.promises.writeFile(filePath, jsonlLines, 'utf-8');

    console.log(
      `[codex-persistence] Wrote ${messages.length} messages to ${path.basename(filePath)}`
    );
  } catch (error) {
    // Log error but don't throw
    console.error(
      `[codex-persistence] Failed to write messages for session ${sessionId}:`,
      error
    );
  }
}

/**
 * Check if a session file exists.
 *
 * @param sessionId - UUID for the conversation session
 * @param workingDir - The working directory path
 * @returns True if the session file exists
 */
export async function sessionFileExists(
  sessionId: string,
  workingDir: string
): Promise<boolean> {
  try {
    const filePath = getSessionFilePath(sessionId, workingDir);
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
