/**
 * JSONL Adapter
 *
 * Reads persisted session files and converts them to our Conversation type.
 *
 * Supported sources:
 * - Claude:   ~/.claude/projects/{encoded-path}/*.jsonl
 * - Codex:    ~/.codex/sessions/YYYY/MM/DD/*.jsonl
 * - OpenCode: ~/.local/share/opencode/storage/message/{session-id}/*.json
 *             + ~/.local/share/opencode/storage/part/{message-id}/*.json
 * - Gemini:   ~/.gemini/tmp/{project}/chats/session-*.json
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import type {
  CodexSessionEntry,
  JsonlAssistantEntry,
  JsonlEntry,
  JsonlSession,
  JsonlTextBlock,
  JsonlToolUseBlock,
  JsonlUserEntry,
  Message,
  Provider,
  SubAgent,
} from '@claude-web-view/shared';
import {
  isCodexAgentMessageEvent,
  isCodexResponseMessage,
  isCodexSessionMeta,
  isCodexUserMessageEvent,
  isJsonlAssistantEntry,
  isJsonlTextBlock,
  isJsonlToolUseBlock,
  isJsonlUserEntry,
} from '@claude-web-view/shared';

/** Canonicalize a directory path: resolve `.`/`..` and strip trailing slashes
 *  so "/foo/bar/" and "/foo/bar" group as the same project. */
function normalizeDirPath(dir: string): string {
  return path.normalize(dir).replace(/\/+$/, '');
}

// =============================================================================
// Constants
// =============================================================================

/** Default location of Claude Code projects directory */
export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** Default location of Codex native sessions directory */
export const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

/** Default location of OpenCode storage directories */
const OPENCODE_STORAGE_DIR = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');
export const OPENCODE_MESSAGE_DIR = path.join(OPENCODE_STORAGE_DIR, 'message');
export const OPENCODE_PART_DIR = path.join(OPENCODE_STORAGE_DIR, 'part');
const OPENCODE_SESSION_DIR = path.join(OPENCODE_STORAGE_DIR, 'session');

/** Default location of Gemini CLI session files */
export const GEMINI_SESSIONS_DIR = path.join(os.homedir(), '.gemini', 'tmp');

/** Track directories that have already warned about ENOENT (only log once) */
const warnedDirectories = new Set<string>();

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
    const code =
      error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') {
      // Only warn once per directory to avoid log spam during polling
      if (!warnedDirectories.has(projectsDir)) {
        warnedDirectories.add(projectsDir);
        console.warn(`Projects directory not found, skipping: ${projectsDir}`);
      }
    } else {
      console.warn(
        `Failed to read projects directory: ${projectsDir} (${error instanceof Error ? error.message : error})`
      );
    }
    return [];
  }
}

/**
 * Scan a directory for files with a specific extension.
 */
async function scanDirectoryByExtension(projectPath: string, extension: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(projectPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => path.join(projectPath, entry.name));
  } catch (error: unknown) {
    const code =
      error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') {
      return [];
    }
    console.warn(
      `Failed to scan project directory: ${projectPath} (${error instanceof Error ? error.message : error})`
    );
    return [];
  }
}

/**
 * Find all JSONL session files in a project directory.
 */
export async function scanSessionDirectory(projectPath: string): Promise<string[]> {
  return scanDirectoryByExtension(projectPath, '.jsonl');
}

/**
 * Find all JSON files in a directory.
 */
async function scanJsonDirectory(projectPath: string): Promise<string[]> {
  return scanDirectoryByExtension(projectPath, '.json');
}

/**
 * List Codex day directories (~/.codex/sessions/YYYY/MM/DD).
 * We intentionally keep Claude directory handling unchanged.
 */
export async function getCodexSessionDirectories(
  sessionsDir: string = CODEX_SESSIONS_DIR
): Promise<string[]> {
  const yearDirs = await getProjectDirectories(sessionsDir);
  const monthDirsNested = await Promise.all(
    yearDirs.map((yearDir) => getProjectDirectories(yearDir))
  );
  const monthDirs = monthDirsNested.flat();
  const dayDirsNested = await Promise.all(
    monthDirs.map((monthDir) => getProjectDirectories(monthDir))
  );
  return dayDirsNested.flat();
}

/**
 * List OpenCode message session directories (~/.local/share/opencode/storage/message/ses_*).
 */
export async function getOpenCodeSessionDirectories(
  messageDir: string = OPENCODE_MESSAGE_DIR
): Promise<string[]> {
  return getProjectDirectories(messageDir);
}

/**
 * Build a lookup of OpenCode session ID -> metadata JSON path.
 * Metadata is stored in ~/.local/share/opencode/storage/session/{project-id}/{session-id}.json
 */
export async function getOpenCodeSessionMetadataIndex(
  sessionDir: string = OPENCODE_SESSION_DIR
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const projectDirs = await getProjectDirectories(sessionDir);

  for (const projectDir of projectDirs) {
    const sessionFiles = await scanJsonDirectory(projectDir);
    for (const sessionFile of sessionFiles) {
      index.set(path.basename(sessionFile, '.json'), sessionFile);
    }
  }

  return index;
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
    crlfDelay: Number.POSITIVE_INFINITY,
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
    console.warn(
      `Skipped ${skippedLines} malformed line${skippedLines > 1 ? 's' : ''} in ${filePath}`
    );
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
    workingDirectory: normalizeDirPath(workingDirectory),
    model,
    createdAt: createdAt ?? new Date(),
    modifiedAt: modifiedAt ?? new Date(),
    entries,
  };
}

export interface CodexSession {
  sessionId: string;
  filePath: string;
  workingDirectory: string;
  model: string;
  parentSessionId: string | null;
  createdAt: Date;
  modifiedAt: Date;
  entries: CodexSessionEntry[];
}

export interface OpenCodeSession {
  sessionId: string;
  filePath: string; // session directory path
  workingDirectory: string;
  model: string;
  createdAt: Date;
  modifiedAt: Date;
  messages: Message[];
}

interface OpenCodeParsedPart {
  type: string;
  text: string | null;
  tool: string | null;
  toolStatus: string | null;
  patchFiles: string[];
  order: number;
  id: string;
}

const CODEX_SESSION_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function extractCodexSessionIdFromFilename(filePath: string): string | null {
  const stem = path.basename(filePath, '.jsonl');
  const match = stem.match(CODEX_SESSION_ID_RE);
  return match ? match[1] : null;
}

/**
 * Parse a native Codex session file (~/.codex/sessions/YYYY/MM/DD/*.jsonl).
 */
export async function parseCodexJsonlFile(filePath: string): Promise<CodexSession> {
  const entries: CodexSessionEntry[] = [];
  let sessionId = '';
  let workingDirectory = '';
  let model = 'unknown';
  let parentSessionId: string | null = null;
  let createdAt: Date | null = null;
  let modifiedAt: Date | null = null;

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let skippedLines = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line) as CodexSessionEntry;
      entries.push(entry);

      const rawTimestamp = (entry as { timestamp?: string }).timestamp;
      if (rawTimestamp) {
        const timestamp = new Date(rawTimestamp);
        if (!Number.isNaN(timestamp.getTime())) {
          if (!createdAt || timestamp < createdAt) {
            createdAt = timestamp;
          }
          if (!modifiedAt || timestamp > modifiedAt) {
            modifiedAt = timestamp;
          }
        }
      }

      if (isCodexSessionMeta(entry)) {
        if (!sessionId) {
          sessionId = entry.payload.id;
        }
        if (!workingDirectory && entry.payload.cwd) {
          workingDirectory = entry.payload.cwd;
        }
        if (!parentSessionId) {
          const source = asObject((entry.payload as { source?: unknown }).source);
          const subagent = asObject(source?.subagent);
          const threadSpawn = asObject(subagent?.thread_spawn);
          const maybeParentSessionId = asString(threadSpawn?.parent_thread_id);
          if (maybeParentSessionId) {
            parentSessionId = maybeParentSessionId;
          }
        }
      } else if ((entry as { type?: string }).type === 'turn_context') {
        const payload = (entry as { payload?: { cwd?: string; model?: string } }).payload;
        if (!workingDirectory && typeof payload?.cwd === 'string') {
          workingDirectory = payload.cwd;
        }
        if (typeof payload?.model === 'string' && payload.model.length > 0) {
          model = payload.model;
        }
      }
    } catch {
      skippedLines++;
    }
  }

  if (skippedLines > 0) {
    console.warn(
      `Skipped ${skippedLines} malformed line${skippedLines > 1 ? 's' : ''} in ${filePath}`
    );
  }

  sessionId =
    sessionId || extractCodexSessionIdFromFilename(filePath) || path.basename(filePath, '.jsonl');
  workingDirectory = workingDirectory || process.cwd();

  return {
    sessionId,
    filePath,
    workingDirectory: normalizeDirPath(workingDirectory),
    model,
    parentSessionId,
    createdAt: createdAt ?? new Date(),
    modifiedAt: modifiedAt ?? new Date(),
    entries,
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function formatOpenCodeModel(providerId: string | null, modelId: string | null): string {
  if (providerId && modelId) return `${providerId}/${modelId}`;
  if (modelId) return modelId;
  if (providerId) return providerId;
  return 'unknown';
}

function decodeOpenCodeText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed);
      if (typeof decoded === 'string') {
        return decoded.trim();
      }
    } catch {
      // Keep original text when the value is not a JSON-encoded string.
    }
  }
  return text.trim();
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return asObject(JSON.parse(content));
  } catch {
    return null;
  }
}

function extractOpenCodeContent(
  role: 'user' | 'assistant',
  parts: OpenCodeParsedPart[],
  summaryTitle: string | null
): string {
  const textParts: string[] = [];
  const toolParts: string[] = [];

  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      const normalizedText = decodeOpenCodeText(part.text);
      if (normalizedText.length > 0) {
        textParts.push(normalizedText);
      }
      continue;
    }

    if (role === 'assistant' && part.type === 'tool') {
      const toolName = part.tool ?? 'tool';
      const status = part.toolStatus;
      if (status && status !== 'completed' && status !== 'done') {
        toolParts.push(`[Tool: ${toolName} (${status})]`);
      } else {
        toolParts.push(`[Tool: ${toolName}]`);
      }
      continue;
    }

    if (role === 'assistant' && part.type === 'patch') {
      const fileCount = part.patchFiles.length;
      if (fileCount > 0) {
        toolParts.push(`[Patch: ${fileCount} file${fileCount === 1 ? '' : 's'}]`);
      } else {
        toolParts.push('[Patch]');
      }
    }
  }

  const text = textParts.join('');
  if (text && toolParts.length === 0) return text;
  if (!text && toolParts.length > 0) return toolParts.join('\n');
  if (text && toolParts.length > 0) return `${text}\n${toolParts.join('\n')}`;

  if (role === 'user' && summaryTitle) {
    return summaryTitle.trim();
  }
  return '';
}

async function parseOpenCodePartFiles(
  messageId: string,
  openCodePartDir: string
): Promise<OpenCodeParsedPart[]> {
  const partDirectory = path.join(openCodePartDir, messageId);
  const partFiles = await scanJsonDirectory(partDirectory);
  const parsedParts: OpenCodeParsedPart[] = [];

  for (const partFilePath of partFiles) {
    const partData = await readJsonObject(partFilePath);
    if (!partData) continue;

    const partType = asString(partData.type);
    if (!partType) continue;

    const timeObj = asObject(partData.time);
    const order = asNumber(timeObj?.start) ?? asNumber(timeObj?.end) ?? Number.MAX_SAFE_INTEGER;

    const state = asObject(partData.state);
    const patchFiles = Array.isArray(partData.files)
      ? partData.files.filter((value): value is string => typeof value === 'string')
      : [];

    parsedParts.push({
      type: partType,
      text: asString(partData.text),
      tool: asString(partData.tool),
      toolStatus: asString(state?.status),
      patchFiles,
      order,
      id: path.basename(partFilePath, '.json'),
    });
  }

  parsedParts.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.id.localeCompare(b.id);
  });

  return parsedParts;
}

/**
 * Compute an OpenCode session mtime from message files, part directories, and
 * optional session metadata. Used for startup discovery + polling.
 */
export async function getOpenCodeSessionMtime(
  sessionDirPath: string,
  openCodePartDir: string,
  metadataPath?: string
): Promise<number> {
  let mtimeMs = 0;

  try {
    const stat = await fs.promises.stat(sessionDirPath);
    mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
  } catch {
    // Session directory may disappear mid-scan.
  }

  const messageFiles = await scanJsonDirectory(sessionDirPath);
  for (const messageFilePath of messageFiles) {
    try {
      const stat = await fs.promises.stat(messageFilePath);
      mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
    } catch {
      // Message file may disappear mid-scan.
    }

    const messageId = path.basename(messageFilePath, '.json');
    const partDirectory = path.join(openCodePartDir, messageId);
    try {
      const partDirStat = await fs.promises.stat(partDirectory);
      mtimeMs = Math.max(mtimeMs, partDirStat.mtimeMs);
    } catch {
      // Missing part directory is normal for messages without parts.
    }
  }

  if (metadataPath) {
    try {
      const metadataStat = await fs.promises.stat(metadataPath);
      mtimeMs = Math.max(mtimeMs, metadataStat.mtimeMs);
    } catch {
      // Metadata file may be removed while scanning.
    }
  }

  return mtimeMs;
}

/**
 * Parse one OpenCode session directory:
 * - message/{sessionId}/*.json for message metadata
 * - part/{messageId}/*.json for user/assistant content parts
 * - session/<project-id>/{sessionId}.json for cwd + time metadata (best-effort)
 */
export async function parseOpenCodeSessionDirectory(
  sessionDirPath: string,
  openCodePartDir: string = OPENCODE_PART_DIR,
  sessionMetadataIndex: Map<string, string> = new Map()
): Promise<OpenCodeSession> {
  const fallbackSessionId = path.basename(sessionDirPath);
  let sessionId = fallbackSessionId;
  let workingDirectory = '';
  let model = 'unknown';
  let createdAt: Date | null = null;
  let modifiedAt: Date | null = null;
  const messages: Message[] = [];

  const messageFiles = await scanJsonDirectory(sessionDirPath);

  for (const messageFilePath of messageFiles) {
    const messageData = await readJsonObject(messageFilePath);
    if (!messageData) {
      continue;
    }

    const roleRaw = asString(messageData.role);
    if (roleRaw !== 'user' && roleRaw !== 'assistant') {
      continue;
    }

    const role: 'user' | 'assistant' = roleRaw;

    const messageSessionId = asString(messageData.sessionID);
    if (messageSessionId) {
      sessionId = messageSessionId;
    }

    const messageId = asString(messageData.id) ?? path.basename(messageFilePath, '.json');
    const timeObj = asObject(messageData.time);
    const created = parseTimestamp(timeObj?.created);
    const completed = parseTimestamp(timeObj?.completed);

    let messageTimestamp = created ?? completed;
    if (!messageTimestamp) {
      try {
        const stat = await fs.promises.stat(messageFilePath);
        messageTimestamp = new Date(stat.mtimeMs);
      } catch {
        messageTimestamp = new Date();
      }
    }

    if (!createdAt || messageTimestamp < createdAt) {
      createdAt = messageTimestamp;
    }
    if (!modifiedAt || messageTimestamp > modifiedAt) {
      modifiedAt = messageTimestamp;
    }

    const pathObj = asObject(messageData.path);
    if (!workingDirectory) {
      workingDirectory = asString(pathObj?.cwd) ?? asString(pathObj?.root) ?? workingDirectory;
    }

    if (role === 'assistant') {
      const assistantProviderId = asString(messageData.providerID);
      const assistantModelId = asString(messageData.modelID);
      const assistantModel = formatOpenCodeModel(assistantProviderId, assistantModelId);
      if (model === 'unknown' && assistantModel !== 'unknown') {
        model = assistantModel;
      }
    } else if (model === 'unknown') {
      const userModelObj = asObject(messageData.model);
      const userModel = formatOpenCodeModel(
        asString(userModelObj?.providerID),
        asString(userModelObj?.modelID)
      );
      if (userModel !== 'unknown') {
        model = userModel;
      }
    }

    const summary = asObject(messageData.summary);
    const summaryTitle = asString(summary?.title);
    const parts = await parseOpenCodePartFiles(messageId, openCodePartDir);
    const content = extractOpenCodeContent(role, parts, summaryTitle).trim();
    if (!content) {
      continue;
    }

    messages.push({
      role,
      content,
      timestamp: messageTimestamp,
    });
  }

  const metadataPath =
    sessionMetadataIndex.get(sessionId) ?? sessionMetadataIndex.get(fallbackSessionId);
  if (metadataPath) {
    const metadata = await readJsonObject(metadataPath);
    if (metadata) {
      if (!workingDirectory) {
        workingDirectory = asString(metadata.directory) ?? workingDirectory;
      }
      const metadataTime = asObject(metadata.time);
      const metadataCreated = parseTimestamp(metadataTime?.created);
      const metadataUpdated = parseTimestamp(metadataTime?.updated);
      if (metadataCreated && (!createdAt || metadataCreated < createdAt)) {
        createdAt = metadataCreated;
      }
      if (metadataUpdated && (!modifiedAt || metadataUpdated > modifiedAt)) {
        modifiedAt = metadataUpdated;
      }
    }
  }

  messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return {
    sessionId,
    filePath: sessionDirPath,
    workingDirectory: normalizeDirPath(workingDirectory || process.cwd()),
    model,
    createdAt: createdAt ?? new Date(),
    modifiedAt: modifiedAt ?? new Date(),
    messages: dedupeConsecutiveMessages(messages),
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
      // AskUserQuestion: embed structured marker so client renders interactive widget.
      // See client/src/components/AskUserQuestion.tsx for the renderer.
      if (toolBlock.name === 'AskUserQuestion' && toolBlock.input) {
        textParts.push(`<!--ask_user_question:${JSON.stringify(toolBlock.input)}-->`);
      } else {
        textParts.push(`[Tool: ${toolBlock.name}]`);
      }
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

  return dedupeConsecutiveMessages(messages);
}

function dedupeConsecutiveMessages(messages: Message[]): Message[] {
  // Deduplicate consecutive messages with same role and content.
  // Both Claude and Codex can emit near-duplicate event/message rows.
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

function extractCodexContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const type = (block as { type?: string }).type;
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) {
        textParts.push(text);
      }
    }
  }

  return textParts.join('\n');
}

/**
 * Extract user/assistant messages from native Codex session entries.
 *
 * Preferred source: event_msg (user_message + agent_message) to avoid importing
 * system/developer bootstrap prompts from response_item entries.
 * Fallback: response_item payload.message entries for older traces.
 */
export function extractMessagesFromCodexEntries(entries: CodexSessionEntry[]): Message[] {
  const messages: Message[] = [];

  const hasEventMessages = entries.some(
    (entry) => isCodexUserMessageEvent(entry) || isCodexAgentMessageEvent(entry)
  );

  if (hasEventMessages) {
    for (const entry of entries) {
      if (isCodexUserMessageEvent(entry)) {
        const content = entry.payload.message;
        if (content) {
          messages.push({
            role: 'user',
            content,
            timestamp: new Date(entry.timestamp),
          });
        }
      } else if (isCodexAgentMessageEvent(entry)) {
        const content = entry.payload.message;
        if (content) {
          messages.push({
            role: 'assistant',
            content,
            timestamp: new Date(entry.timestamp),
          });
        }
      }
    }
    return dedupeConsecutiveMessages(messages);
  }

  for (const entry of entries) {
    if (!isCodexResponseMessage(entry)) {
      continue;
    }

    const role = entry.payload.role;
    if (role !== 'user' && role !== 'assistant') {
      continue;
    }

    const content = extractCodexContentText(entry.payload.content);
    if (!content) {
      continue;
    }

    messages.push({
      role,
      content,
      timestamp: new Date(entry.timestamp),
    });
  }

  return dedupeConsecutiveMessages(messages);
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
  const lower = model.toLowerCase();
  if (lower.includes('gemini')) {
    return 'gemini';
  }
  if (
    lower.includes('opencode') ||
    lower.includes('kimi-k2') ||
    lower.includes('minimax') ||
    lower.includes('trinity')
  ) {
    return 'opencode';
  }
  if (lower.includes('codex') || lower.includes('gpt')) {
    return 'codex';
  }
  return 'claude';
}

/**
 * Hidden test tag. If the first user message starts with [_HIDE_TEST_],
 * the conversation is hidden from ALL UI views (Gallery, Sidebar, SwarmDashboard).
 * Used by model probes, test-models scripts, and other validation runs that
 * create real CLI sessions but should never appear as user-visible conversations.
 * The tag is stripped from the message content.
 */
const HIDE_TEST_RE = /^\s*(?:"|')?\s*\[_HIDE_TEST_\]\s*/;

/**
 * Oompa worker tag regex. If the first user message starts with this tag,
 * the conversation is classified as a worker (hidden from main UI).
 * Accepts optional leading whitespace/quote from wrapped prompt payloads.
 *
 * Tag format:
 *   [oompa]                       → isWorker=true
 *   [oompa:<swarmId>]             → isWorker=true, swarmId set
 *   [oompa:<swarmId>:<workerId>]  → isWorker=true, swarmId + workerId set
 *
 * The tag is stripped from the message content for display.
 */
const OOMPA_RE = /^\s*(?:"|')?\s*\[oompa(?::([^:\]]+)(?::([^\]]+))?)?\]/;

/**
 * Infer worker role from the first user message content (after oompa tag stripped).
 *
 * Three roles in the oompa swarm lifecycle:
 *   "review" — reviewer session: contains a diff block + VERDICT instructions
 *   "fix"    — fix session: starts with "The reviewer found issues"
 *   "work"   — normal task execution (everything else)
 */
function inferWorkerRole(content: string): 'work' | 'review' | 'fix' {
  if (content.startsWith('The reviewer found issues')) return 'fix';
  if (content.includes('VERDICT: APPROVED') && content.includes('VERDICT: NEEDS_CHANGES'))
    return 'review';
  return 'work';
}

export interface WorkerMetadata {
  isHidden: boolean;
  isWorker: boolean;
  swarmId: string | null;
  workerId: string | null;
  workerRole: 'work' | 'review' | 'fix' | null;
}

export function extractWorkerMetadata(messages: Message[]): WorkerMetadata {
  const metadata: WorkerMetadata = {
    isHidden: false,
    isWorker: false,
    swarmId: null,
    workerId: null,
    workerRole: null,
  };

  const firstUserMsg = messages.find((message) => message.role === 'user');
  if (!firstUserMsg) {
    return metadata;
  }

  // [_HIDE_TEST_] — hidden from ALL views (probes, test-models, validation runs).
  const hideMatch = firstUserMsg.content.match(HIDE_TEST_RE);
  if (hideMatch) {
    metadata.isHidden = true;
    firstUserMsg.content = firstUserMsg.content.slice(hideMatch[0].length);
    return metadata;
  }

  const match = firstUserMsg.content.match(OOMPA_RE);
  if (!match) {
    return metadata;
  }

  metadata.isWorker = true;
  metadata.swarmId = match[1] ?? null;
  metadata.workerId = match[2] ?? null;

  // Strip the full tag and optional trailing space for clean display.
  firstUserMsg.content = firstUserMsg.content.slice(match[0].length).trimStart();
  metadata.workerRole = inferWorkerRole(firstUserMsg.content);

  return metadata;
}

// jsonlSessionToConversation, codexSessionToConversation, openCodeSessionToConversation,
// and geminiSessionToConversation have been removed.
// They are replaced by the single sessionToConversation() function in disk-adapter.ts,
// which operates on the normalized ParsedSession type produced by each DiskAdapter.
// See server/src/adapters/registry.ts for the per-provider adapters.

// =============================================================================
// Gemini Session Reading
//
// Gemini CLI persists sessions to ~/.gemini/tmp/{project}/chats/session-*.json
// Each file is a JSON object with sessionId, startTime, lastUpdated, messages[].
// Messages have type: "user" (content is [{text}]) or "gemini" (content is string).
// =============================================================================

export interface GeminiSession {
  sessionId: string;
  filePath: string;
  workingDirectory: string;
  model: string;
  createdAt: Date;
  modifiedAt: Date;
  messages: Message[];
}

/**
 * Discover all Gemini project directories that contain chat files.
 * Scans ~/.gemini/tmp/{project}/chats/ for session-{ts}-{uuid}.json files.
 * Returns paths to individual session JSON files.
 */
export async function getGeminiSessionFiles(
  sessionsDir: string = GEMINI_SESSIONS_DIR
): Promise<string[]> {
  const files: string[] = [];
  const projectDirs = await getProjectDirectories(sessionsDir);

  for (const projectDir of projectDirs) {
    const chatsDir = path.join(projectDir, 'chats');
    const sessionFiles = await scanJsonDirectory(chatsDir);
    for (const f of sessionFiles) {
      if (path.basename(f).startsWith('session-')) {
        files.push(f);
      }
    }
  }

  return files;
}

/**
 * Read the working directory for a Gemini project from its .project_root file.
 * The .project_root file sits alongside the chats/ dir and contains the absolute path.
 */
async function readGeminiProjectRoot(sessionFilePath: string): Promise<string> {
  // sessionFilePath = ~/.gemini/tmp/{project}/chats/session-*.json
  const projectDir = path.dirname(path.dirname(sessionFilePath));
  const projectRootFile = path.join(projectDir, '.project_root');
  try {
    const content = await fs.promises.readFile(projectRootFile, 'utf-8');
    return content.trim();
  } catch {
    // Fallback: return the gemini tmp dir itself (absolute).
    // Without .project_root the real project path is unknown, but returning
    // the absolute tmp dir prevents a relative-path 400 from /api/swarm-runtime.
    return projectDir;
  }
}

/**
 * Parse a Gemini session JSON file into a GeminiSession.
 *
 * Gemini session format:
 *   { sessionId, projectHash, startTime, lastUpdated, messages[] }
 *
 * Message types:
 *   user:   { type: "user",   content: [{ text: "..." }] }
 *   gemini: { type: "gemini", content: "...", toolCalls?: [...], model?: "..." }
 */
export async function parseGeminiSessionFile(filePath: string): Promise<GeminiSession> {
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  const data = JSON.parse(raw) as Record<string, unknown>;

  const sessionId = (data.sessionId as string) ?? path.basename(filePath, '.json');
  const startTime = data.startTime ? new Date(data.startTime as string) : new Date();
  const lastUpdated = data.lastUpdated ? new Date(data.lastUpdated as string) : startTime;
  const workingDirectory = await readGeminiProjectRoot(filePath);

  const rawMessages = Array.isArray(data.messages) ? data.messages : [];
  const messages: Message[] = [];
  let model = 'unknown';

  for (const msg of rawMessages) {
    const m = msg as Record<string, unknown>;
    const type = m.type as string;
    const timestamp = m.timestamp ? new Date(m.timestamp as string) : startTime;

    if (type === 'user') {
      // User content is an array of {text} blocks
      const contentBlocks = Array.isArray(m.content) ? m.content : [];
      const text = contentBlocks
        .map((b: unknown) => {
          const block = b as Record<string, unknown>;
          return (block.text as string) ?? '';
        })
        .join('')
        .trim();
      if (text) {
        messages.push({ role: 'user', content: text, timestamp });
      }
    } else if (type === 'gemini') {
      // Gemini content is a string; may also have toolCalls
      const content = (m.content as string) ?? '';

      // Extract model from first gemini message
      if (m.model && model === 'unknown') {
        model = m.model as string;
      }

      // Build display text: content + tool call summaries
      const parts: string[] = [];
      if (content) parts.push(content);

      const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      for (const tc of toolCalls) {
        const call = tc as Record<string, unknown>;
        const name = (call.name as string) ?? 'tool';
        const args = call.args as Record<string, unknown> | undefined;
        const argSummary = args?.command ?? args?.file_path ?? args?.path ?? '';
        parts.push(`[Tool: ${name}${argSummary ? ` ${argSummary}` : ''}]`);
      }

      const fullContent = parts.join('\n').trim();
      if (fullContent) {
        messages.push({ role: 'assistant', content: fullContent, timestamp });
      }
    }
  }

  return {
    sessionId,
    filePath,
    workingDirectory: normalizeDirPath(workingDirectory),
    model,
    createdAt: startTime,
    modifiedAt: lastUpdated,
    messages,
  };
}

// loadAllConversations, pollForChanges, mapWithConcurrency, discoverAllJsonlFiles,
// parseOneFile, LoadResult, PollResult, LoadProgressCallback, DiscoveredFile
// have been removed from jsonl.ts.
// They are replaced by the generic registry-driven loader in loader.ts.
// See server/src/adapters/loader.ts for the new implementation.
