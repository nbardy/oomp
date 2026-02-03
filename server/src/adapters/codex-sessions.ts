/**
 * Codex Native Session Adapter
 *
 * Reads Codex CLI's native session files from ~/.codex/sessions/
 * and converts them to our Conversation type.
 *
 * Codex stores sessions at:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-{timestamp}-{uuid}.jsonl
 *
 * Each file contains:
 *   - session_meta: Session ID, cwd, model, cli_version
 *   - response_item: Messages (user/assistant/developer), tool calls, tool results
 *   - event_msg: User prompts (user_message), agent summaries (agent_message)
 *   - turn_context: Per-turn config (cwd, model, effort)
 *
 * The session UUID for `codex exec resume <id>` is in session_meta.payload.id.
 *
 * DESIGN: One clean path, no fallbacks. Unknown entry types are skipped
 * (Codex may add new types) but the core types must parse correctly.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import type {
  Message,
  Conversation,
  CodexSessionEntry,
  CodexParsedSession,
} from '@claude-web-view/shared';
import {
  isCodexSessionMeta,
  isCodexResponseMessage,
  isCodexFunctionCall,
  isCodexUserMessageEvent,
  isCodexAgentMessageEvent,
} from '@claude-web-view/shared';

// =============================================================================
// Constants
// =============================================================================

/** Default location of Codex sessions directory */
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

// =============================================================================
// Directory Scanning
// =============================================================================

/**
 * Recursively find all JSONL files under the Codex sessions directory.
 * Codex organizes by date: sessions/YYYY/MM/DD/*.jsonl
 */
async function findCodexSessionFiles(
  sessionsDir: string = CODEX_SESSIONS_DIR
): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(fullPath);
        }
      }
    } catch (error: unknown) {
      const code = error instanceof Error && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code === 'ENOENT') {
        // Directory doesn't exist — no sessions yet
      } else {
        console.warn(`[codex-sessions] Failed to scan directory: ${dir} (${error instanceof Error ? error.message : error})`);
      }
    }
  }

  await walk(sessionsDir);
  return files;
}

// =============================================================================
// JSONL File Parsing
// =============================================================================

/**
 * Parse a Codex native session JSONL file.
 * Uses streaming to handle large files efficiently.
 */
export async function parseCodexSessionFile(filePath: string): Promise<CodexParsedSession> {
  const entries: CodexSessionEntry[] = [];
  let sessionId = '';
  let workingDirectory = '';
  let model = 'unknown';
  let cliVersion = '';
  let createdAt: Date | null = null;
  let modifiedAt: Date | null = null;

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let skippedLines = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line) as CodexSessionEntry;
      entries.push(entry);

      // Extract session metadata from first session_meta entry
      if (isCodexSessionMeta(entry)) {
        sessionId = entry.payload.id;
        workingDirectory = entry.payload.cwd;
        cliVersion = entry.payload.cli_version;
        if (entry.payload.model_provider) {
          model = entry.payload.model_provider;
        }
      }

      // Extract model from turn_context if available (more specific than model_provider)
      if (entry.type === 'turn_context') {
        const payload = entry.payload as { model?: string };
        if (payload.model) {
          model = payload.model;
        }
      }

      // Track timestamps
      if (entry.timestamp) {
        const timestamp = new Date(entry.timestamp);
        if (!createdAt || timestamp < createdAt) {
          createdAt = timestamp;
        }
        if (!modifiedAt || timestamp > modifiedAt) {
          modifiedAt = timestamp;
        }
      }
    } catch {
      skippedLines++;
    }
  }

  if (skippedLines > 0) {
    console.warn(`[codex-sessions] Skipped ${skippedLines} malformed line${skippedLines > 1 ? 's' : ''} in ${filePath}`);
  }

  // If no session_meta found, extract UUID from filename as fallback
  // Filename format: rollout-{timestamp}-{uuid}.jsonl
  if (!sessionId) {
    const basename = path.basename(filePath, '.jsonl');
    const uuidMatch = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if (uuidMatch) {
      sessionId = uuidMatch[1];
    } else {
      sessionId = basename;
    }
  }

  return {
    sessionId,
    filePath,
    workingDirectory: workingDirectory || process.cwd(),
    model,
    cliVersion,
    createdAt: createdAt ?? new Date(),
    modifiedAt: modifiedAt ?? new Date(),
    entries,
  };
}

// =============================================================================
// Message Extraction
// =============================================================================

/**
 * Extract messages from Codex native session entries.
 *
 * Message sources (in order of priority):
 * - event_msg/user_message: User prompt text (clean, preferred)
 * - event_msg/agent_message: Agent summary text (clean, preferred)
 * - response_item/message with role=user: User input (may include system framing)
 * - response_item/function_call: Tool invocations (shown as [Tool: ...])
 *
 * We prefer event_msg types because they contain the clean user/agent text
 * without system framing or tool result noise.
 */
export function extractMessagesFromCodexEntries(entries: CodexSessionEntry[]): Message[] {
  const messages: Message[] = [];

  for (const entry of entries) {
    // User prompts — clean text from event_msg/user_message
    if (isCodexUserMessageEvent(entry)) {
      messages.push({
        role: 'user',
        content: entry.payload.message,
        timestamp: new Date(entry.timestamp),
      });
      continue;
    }

    // Agent final messages — clean text from event_msg/agent_message
    if (isCodexAgentMessageEvent(entry)) {
      messages.push({
        role: 'assistant',
        content: entry.payload.message,
        timestamp: new Date(entry.timestamp),
      });
      continue;
    }

    // Tool calls — show as inline annotations
    if (isCodexFunctionCall(entry)) {
      const name = entry.payload.name;
      let displayText = `[Tool: ${name}]`;

      // For exec_command, show the command
      if (name === 'exec_command') {
        try {
          const args = JSON.parse(entry.payload.arguments) as { cmd?: string };
          if (args.cmd) {
            displayText = `[Running: ${args.cmd}]`;
          }
        } catch {
          // Use default displayText
        }
      }

      // Append tool use to last assistant message if one exists
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.content += `\n${displayText}`;
      }
      continue;
    }

    // response_item messages — fallback if no event_msg was emitted
    // Only use assistant messages here (user_message events are preferred for user)
    if (isCodexResponseMessage(entry) && entry.payload.role === 'assistant') {
      const textParts: string[] = [];
      for (const block of entry.payload.content) {
        if (block.type === 'output_text' && block.text) {
          textParts.push(block.text);
        }
      }
      if (textParts.length > 0) {
        messages.push({
          role: 'assistant',
          content: textParts.join('\n'),
          timestamp: new Date(entry.timestamp),
        });
      }
      continue;
    }
  }

  // Deduplicate consecutive messages with same role and content
  const deduped: Message[] = [];
  for (const msg of messages) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.role === msg.role && prev.content === msg.content) {
      continue;
    }
    deduped.push(msg);
  }

  return deduped;
}

// =============================================================================
// Conversion to Conversation
// =============================================================================

/**
 * Convert a parsed Codex session to our Conversation type.
 */
export function codexSessionToConversation(session: CodexParsedSession): Conversation {
  return {
    id: session.sessionId,
    messages: extractMessagesFromCodexEntries(session.entries),
    isRunning: false,
    isReady: false,
    createdAt: session.createdAt,
    workingDirectory: session.workingDirectory,
    loopConfig: null,
    provider: 'codex',
    subAgents: [],
  };
}

// =============================================================================
// Loading Functions
// =============================================================================

export interface CodexLoadResult {
  conversations: Map<string, Conversation>;
  mtimes: Map<string, number>;
}

export interface CodexPollResult {
  updated: Map<string, Conversation>;
  mtimes: Map<string, number>;
}

/**
 * Load all Codex conversations from native session files.
 *
 * Scans ~/.codex/sessions/ recursively for JSONL files.
 * Returns conversations keyed by session UUID + mtime index for polling.
 */
export async function loadCodexSessions(
  sessionsDir: string = CODEX_SESSIONS_DIR
): Promise<CodexLoadResult> {
  const conversations = new Map<string, Conversation>();
  const mtimes = new Map<string, number>();

  const files = await findCodexSessionFiles(sessionsDir);
  console.log(`[codex-sessions] Found ${files.length} session files`);

  for (const filePath of files) {
    try {
      const stat = await fs.promises.stat(filePath);
      mtimes.set(filePath, stat.mtimeMs);

      const session = await parseCodexSessionFile(filePath);
      if (session.entries.length === 0) continue;

      const conversation = codexSessionToConversation(session);
      if (conversation.messages.length === 0) continue;

      conversations.set(conversation.id, conversation);
    } catch (error: unknown) {
      console.warn(`[codex-sessions] Failed to parse: ${path.basename(filePath)} (${error instanceof Error ? error.message : error})`);
    }
  }

  console.log(`[codex-sessions] Loaded ${conversations.size} conversations`);
  return { conversations, mtimes };
}

/**
 * Poll for changes to Codex session files since last check.
 *
 * @param prevMtimes - Previous mtime index (filepath → mtime ms)
 * @param activeIds - Conversation IDs currently running (skip these)
 */
export async function pollCodexSessions(
  prevMtimes: Map<string, number>,
  activeIds: Set<string>,
  sessionsDir: string = CODEX_SESSIONS_DIR
): Promise<CodexPollResult> {
  const updated = new Map<string, Conversation>();
  const mtimes = new Map(prevMtimes);

  const files = await findCodexSessionFiles(sessionsDir);

  for (const filePath of files) {
    try {
      const stat = await fs.promises.stat(filePath);
      const prevMtime = prevMtimes.get(filePath);

      // Skip if file mtime unchanged
      if (prevMtime !== undefined && stat.mtimeMs <= prevMtime) {
        continue;
      }

      mtimes.set(filePath, stat.mtimeMs);

      const session = await parseCodexSessionFile(filePath);
      if (session.entries.length === 0) continue;

      // Skip if this conversation is actively running
      if (activeIds.has(session.sessionId)) {
        continue;
      }

      const conversation = codexSessionToConversation(session);
      if (conversation.messages.length === 0) continue;

      updated.set(conversation.id, conversation);
    } catch (error: unknown) {
      console.warn(`[codex-sessions] Failed to parse during poll: ${path.basename(filePath)} (${error instanceof Error ? error.message : error})`);
    }
  }

  return { updated, mtimes };
}
