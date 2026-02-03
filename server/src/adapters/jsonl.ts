/**
 * JSONL Adapter
 *
 * Reads Claude Code's JSONL session files and converts them to our Conversation type.
 * Claude Code stores sessions at ~/.claude/projects/{encoded-path}/*.jsonl
 *
 * Key functions:
 * - loadAllConversations() - Load all sessions from all project directories
 * - parseJsonlFile() - Parse a single JSONL file
 * - extractMessagesFromEntries() - Convert JSONL entries to Message[]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import type {
  Message,
  Conversation,
  Provider,
  SubAgent,
  JsonlEntry,
  JsonlSession,
  JsonlUserEntry,
  JsonlAssistantEntry,
  JsonlTextBlock,
  JsonlToolUseBlock,
} from '@claude-web-view/shared';
import {
  isJsonlUserEntry,
  isJsonlAssistantEntry,
  isJsonlTextBlock,
  isJsonlToolUseBlock,
} from '@claude-web-view/shared';

// =============================================================================
// Constants
// =============================================================================

/** Default location of Claude Code projects directory */
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** Directory for Codex conversation persistence (our own format) */
const CODEX_PERSISTENCE_DIR = path.join(os.homedir(), '.claude-web-view', 'codex');

// =============================================================================
// Directory Scanning
// =============================================================================

/**
 * Get all project directories in the Claude projects folder
 */
export async function getProjectDirectories(
  projectsDir: string = CLAUDE_PROJECTS_DIR
): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => path.join(projectsDir, entry.name));
  } catch (error: unknown) {
    const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') {
      console.warn(`Projects directory not found, skipping: ${projectsDir}`);
    } else {
      console.warn(`Failed to read projects directory: ${projectsDir} (${error instanceof Error ? error.message : error})`);
    }
    return [];
  }
}

/**
 * Find all JSONL session files in a project directory
 */
export async function scanSessionDirectory(projectPath: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(projectPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => path.join(projectPath, entry.name));
  } catch (error: unknown) {
    console.warn(`Failed to scan project directory: ${projectPath} (${error instanceof Error ? error.message : error})`);
    return [];
  }
}

/**
 * Decode a project directory name back to the original path
 * Claude Code encodes paths by replacing '/' with '-'
 * e.g., "-Users-nick-project" -> "/Users/nick/project"
 */
export function decodeProjectPath(encodedName: string): string {
  // The encoded name starts with '-' and replaces '/' with '-'
  // e.g., "-Users-nick-project" -> "/Users/nick/project"
  if (encodedName.startsWith('-')) {
    return encodedName.replace(/-/g, '/');
  }
  return encodedName;
}

// =============================================================================
// JSONL File Parsing
// =============================================================================

/**
 * Parse a JSONL file into a JsonlSession object
 * Uses streaming to handle large files efficiently
 */
export async function parseJsonlFile(filePath: string): Promise<JsonlSession> {
  const entries: JsonlEntry[] = [];
  let workingDirectory = '';
  let model = 'unknown';
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
      const entry = JSON.parse(line) as JsonlEntry;
      entries.push(entry);

      // Extract metadata from entries
      if (isJsonlUserEntry(entry) || isJsonlAssistantEntry(entry)) {
        // Get working directory from first entry with cwd
        if (!workingDirectory && 'cwd' in entry && entry.cwd) {
          workingDirectory = entry.cwd;
        }

        // Get model from first assistant message
        if (isJsonlAssistantEntry(entry) && (!model || model === 'unknown')) {
          if (entry.message?.model) {
            model = entry.message.model;
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
      }
    } catch {
      skippedLines++;
    }
  }

  if (skippedLines > 0) {
    console.warn(`Skipped ${skippedLines} malformed line${skippedLines > 1 ? 's' : ''} in ${filePath}`);
  }

  // Extract session ID from filename
  const sessionId = path.basename(filePath, '.jsonl');

  // Fallback for working directory: decode from parent directory name
  if (!workingDirectory) {
    const projectDirName = path.basename(path.dirname(filePath));
    workingDirectory = decodeProjectPath(projectDirName);
  }

  return {
    sessionId,
    filePath,
    workingDirectory,
    model,
    createdAt: createdAt ?? new Date(),
    modifiedAt: modifiedAt ?? new Date(),
    entries,
  };
}

// =============================================================================
// Message Extraction
// =============================================================================

/**
 * Extract text content from a user entry
 */
function extractUserContent(entry: JsonlUserEntry): string {
  const content = entry.message.content;

  // Plain text message
  if (typeof content === 'string') {
    return content;
  }

  // Array of content blocks (usually tool results)
  if (Array.isArray(content)) {
    const textParts: string[] = [];

    for (const block of content) {
      if ('type' in block && block.type === 'tool_result' && 'content' in block) {
        // Include a short indicator for tool results
        const toolContent = block.content as string;
        if (toolContent.length > 200) {
          textParts.push(`[Tool result: ${toolContent.substring(0, 200)}...]`);
        } else {
          textParts.push(`[Tool result: ${toolContent}]`);
        }
      }
    }

    return textParts.join('\n') || '[Tool interaction]';
  }

  return '';
}

/**
 * Extract text content from an assistant entry
 */
function extractAssistantContent(entry: JsonlAssistantEntry): string {
  const content = entry.message.content;
  const textParts: string[] = [];

  for (const block of content) {
    if (isJsonlTextBlock(block)) {
      textParts.push((block as JsonlTextBlock).text);
    } else if (isJsonlToolUseBlock(block)) {
      const toolBlock = block as JsonlToolUseBlock;
      textParts.push(`[Tool: ${toolBlock.name}]`);
    }
    // Skip thinking blocks - internal reasoning
  }

  return textParts.join('\n') || '';
}

/**
 * Extract messages from JSONL entries
 * Filters to only user and assistant messages, extracts text content
 */
export function extractMessagesFromEntries(entries: JsonlEntry[]): Message[] {
  const messages: Message[] = [];

  for (const entry of entries) {
    if (isJsonlUserEntry(entry)) {
      const content = extractUserContent(entry);
      // Skip tool result messages that are just internal tool communication
      if (content && !content.startsWith('[Tool result:')) {
        messages.push({
          role: 'user',
          content,
          timestamp: new Date(entry.timestamp),
        });
      }
    } else if (isJsonlAssistantEntry(entry)) {
      const content = extractAssistantContent(entry);
      if (content) {
        messages.push({
          role: 'assistant',
          content,
          timestamp: new Date(entry.timestamp),
        });
      }
    }
  }

  // Deduplicate consecutive messages with same role and content
  // (Claude Code writes multiple entries per response)
  const deduped: Message[] = [];
  for (const msg of messages) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.role === msg.role && prev.content === msg.content) {
      // Skip duplicate
      continue;
    }
    deduped.push(msg);
  }

  return deduped;
}

// =============================================================================
// Sub-Agent Extraction
// =============================================================================

/**
 * Extract sub-agent history from JSONL entries by detecting Task tool uses.
 *
 * This reconstructs historical sub-agent invocations from completed sessions.
 * Sub-agents are detected when an assistant entry contains a tool_use block
 * with name === 'Task'.
 *
 * Limitations:
 * - All sub-agents are marked as 'completed' (we don't have failure data)
 * - Token counts are set to 0 (not available in JSONL)
 * - Tool use counts are estimates
 * - Timestamps use the entry timestamp (approximation)
 */
export function extractSubAgentsFromEntries(entries: JsonlEntry[]): SubAgent[] {
  const subAgents: SubAgent[] = [];
  let currentSubAgent: SubAgent | null = null;

  for (const entry of entries) {
    // Only process assistant entries that contain tool uses
    if (!isJsonlAssistantEntry(entry)) {
      continue;
    }

    const content = entry.message.content;
    const timestamp = new Date(entry.timestamp);

    // Scan all content blocks in this assistant message
    for (const block of content) {
      if (isJsonlToolUseBlock(block)) {
        const toolBlock = block as JsonlToolUseBlock;

        // Check if this is a Task tool (sub-agent spawn)
        if (toolBlock.name === 'Task') {
          // Complete the previous sub-agent if one is active
          if (currentSubAgent) {
            currentSubAgent.status = 'completed';
            currentSubAgent.completedAt = timestamp;
            subAgents.push(currentSubAgent);
          }

          // Extract description and subagent_type from input
          const input = toolBlock.input as Record<string, unknown>;
          const description = (input.description as string) || 'Sub-agent task';
          const subagentType = input.subagent_type as string | undefined;

          // Create new sub-agent
          currentSubAgent = {
            id: toolBlock.id,
            description: subagentType ? `[${subagentType}] ${description}` : description,
            status: 'running',
            toolUses: 0,
            tokens: 0,
            currentAction: undefined,
            startedAt: timestamp,
            completedAt: undefined,
          };
        } else if (currentSubAgent) {
          // Regular tool use within an active sub-agent
          currentSubAgent.toolUses += 1;
          currentSubAgent.currentAction = toolBlock.name;
        }
      }
    }
  }

  // Handle case where last sub-agent never got completed
  if (currentSubAgent) {
    currentSubAgent.status = 'completed';
    currentSubAgent.completedAt = currentSubAgent.startedAt;
    subAgents.push(currentSubAgent);
  }

  return subAgents;
}

// =============================================================================
// Conversion to Conversation
// =============================================================================

/**
 * Infer provider from model name
 */
export function inferProviderFromModel(model: string): Provider {
  if (model.includes('codex') || model.includes('gpt')) {
    return 'codex';
  }
  return 'claude';
}

/**
 * Convert a parsed JSONL session to our Conversation type
 */
export function jsonlSessionToConversation(session: JsonlSession): Conversation {
  return {
    id: session.sessionId,
    messages: extractMessagesFromEntries(session.entries),
    isRunning: false,
    isReady: false,
    createdAt: session.createdAt,
    workingDirectory: session.workingDirectory,
    loopConfig: null,
    provider: inferProviderFromModel(session.model),
    subAgents: extractSubAgentsFromEntries(session.entries),
  };
}

// =============================================================================
// Main Loading Function
// =============================================================================

/**
 * Result of loading conversations, includes mtime index for subsequent polling.
 */
export interface LoadResult {
  conversations: Map<string, Conversation>;
  mtimes: Map<string, number>; // filepath → mtime ms
}

/**
 * Result of polling for changes since last check.
 */
export interface PollResult {
  updated: Map<string, Conversation>; // changed or new conversations
  mtimes: Map<string, number>;        // full updated mtime index
}

/**
 * Load all conversations from both Claude Code's JSONL files and Codex persistence files.
 *
 * Scans:
 * 1. ~/.claude/projects/* (Claude Code sessions)
 * 2. ~/.claude-web-view/codex/* (Codex sessions we persist)
 *
 * Returns conversations + mtime index for subsequent polling.
 */
export async function loadAllConversations(
  claudeProjectsDir: string = CLAUDE_PROJECTS_DIR,
  codexPersistenceDir: string = CODEX_PERSISTENCE_DIR
): Promise<LoadResult> {
  const conversations = new Map<string, Conversation>();
  const mtimes = new Map<string, number>();

  // Load Claude conversations
  console.log('Loading Claude conversations...');
  const claudeDirs = await getProjectDirectories(claudeProjectsDir);
  console.log(`Found ${claudeDirs.length} Claude project directories`);

  for (const projectDir of claudeDirs) {
    const jsonlFiles = await scanSessionDirectory(projectDir);

    for (const filePath of jsonlFiles) {
      try {
        const stat = await fs.promises.stat(filePath);
        mtimes.set(filePath, stat.mtimeMs);

        const session = await parseJsonlFile(filePath);
        if (session.entries.length === 0) continue;

        const conversation = jsonlSessionToConversation(session);
        if (conversation.messages.length === 0) continue;

        conversations.set(conversation.id, conversation);
      } catch (error: unknown) {
        console.warn(`Failed to parse Claude session: ${path.basename(filePath)} (${error instanceof Error ? error.message : error})`);
      }
    }
  }

  // Load Codex conversations (using same JSONL parser)
  console.log('Loading Codex conversations...');
  const codexDirs = await getProjectDirectories(codexPersistenceDir);
  console.log(`Found ${codexDirs.length} Codex project directories`);

  for (const projectDir of codexDirs) {
    const jsonlFiles = await scanSessionDirectory(projectDir);

    for (const filePath of jsonlFiles) {
      try {
        const stat = await fs.promises.stat(filePath);
        mtimes.set(filePath, stat.mtimeMs);

        const session = await parseJsonlFile(filePath);
        if (session.entries.length === 0) continue;

        // Convert to conversation and force provider to 'codex'
        const conversation = jsonlSessionToConversation(session);
        if (conversation.messages.length === 0) continue;

        // Override provider detection - anything from codex dir is codex
        conversation.provider = 'codex';

        conversations.set(conversation.id, conversation);
      } catch (error: unknown) {
        console.warn(`Failed to parse Codex session: ${path.basename(filePath)} (${error instanceof Error ? error.message : error})`);
      }
    }
  }

  console.log(`Loaded ${conversations.size} total conversations (Claude + Codex)`);
  return { conversations, mtimes };
}

// =============================================================================
// File Polling — detect external changes to JSONL files
//
// Compares file mtimes against a previous index. Only re-parses files that
// changed. Skips conversations that are actively running (in-memory state
// is authoritative for those).
//
// NOTE: No dir-level mtime gate. Directory mtime only changes when files are
// added/removed, NOT when existing files are modified. Since we need to detect
// external writes to existing JSONL files, we must stat each file directly.
// Individual stat calls are cheap (microseconds).
// =============================================================================

/**
 * Poll for changes to JSONL files since the last check.
 *
 * @param prevMtimes - Previous mtime index (filepath → mtime ms)
 * @param activeIds - Conversation IDs currently running (skip these)
 * @returns Changed conversations + updated mtime index
 */
export async function pollForChanges(
  prevMtimes: Map<string, number>,
  activeIds: Set<string>,
  claudeProjectsDir: string = CLAUDE_PROJECTS_DIR,
  codexPersistenceDir: string = CODEX_PERSISTENCE_DIR
): Promise<PollResult> {
  const updated = new Map<string, Conversation>();
  const mtimes = new Map(prevMtimes);

  async function scanSource(projectsDir: string, forceProvider?: 'codex') {
    const dirs = await getProjectDirectories(projectsDir);

    for (const projectDir of dirs) {
      const jsonlFiles = await scanSessionDirectory(projectDir);

      for (const filePath of jsonlFiles) {
        try {
          const stat = await fs.promises.stat(filePath);
          const prevMtime = prevMtimes.get(filePath);

          // Skip if file mtime unchanged
          if (prevMtime !== undefined && stat.mtimeMs <= prevMtime) {
            continue;
          }

          // File is new or changed — re-parse
          mtimes.set(filePath, stat.mtimeMs);

          const sessionId = path.basename(filePath, '.jsonl');

          // Skip if this conversation is actively running
          if (activeIds.has(sessionId)) {
            continue;
          }

          const session = await parseJsonlFile(filePath);
          if (session.entries.length === 0) continue;

          const conversation = jsonlSessionToConversation(session);
          if (conversation.messages.length === 0) continue;

          if (forceProvider) {
            conversation.provider = forceProvider;
          }

          updated.set(conversation.id, conversation);
        } catch (error: unknown) {
          console.warn(`[Poll] Failed to parse: ${path.basename(filePath)} (${error instanceof Error ? error.message : error})`);
        }
      }

      // Also check for new files that weren't in the previous index
      // (already handled above — new files have no prevMtime entry)
    }
  }

  await scanSource(claudeProjectsDir);
  await scanSource(codexPersistenceDir, 'codex');

  return { updated, mtimes };
}

/**
 * Load conversations for a specific working directory only
 */
export async function loadConversationsForDirectory(
  workingDirectory: string,
  projectsDir: string = CLAUDE_PROJECTS_DIR
): Promise<Map<string, Conversation>> {
  // Encode the path to match Claude Code's directory naming
  const encodedPath = workingDirectory.replace(/\//g, '-');
  const projectDir = path.join(projectsDir, encodedPath);

  const conversations = new Map<string, Conversation>();

  if (!fs.existsSync(projectDir)) {
    return conversations;
  }

  const jsonlFiles = await scanSessionDirectory(projectDir);

  for (const filePath of jsonlFiles) {
    try {
      const session = await parseJsonlFile(filePath);
      if (session.entries.length === 0) continue;

      const conversation = jsonlSessionToConversation(session);
      if (conversation.messages.length === 0) continue;

      conversations.set(conversation.id, conversation);
    } catch (error: unknown) {
      console.warn(`Failed to parse session: ${path.basename(filePath)} (${error instanceof Error ? error.message : error})`);
    }
  }

  return conversations;
}
