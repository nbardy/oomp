/**
 * JSONL Adapter
 *
 * Reads persisted session files and converts them to our Conversation type.
 *
 * Supported sources:
 * - Claude: ~/.claude/projects/{encoded-path}/*.jsonl
 * - Codex:  ~/.codex/sessions/YYYY/MM/DD/*.jsonl
 * - OpenCode: ~/.local/share/opencode/storage/message/{session-id}/*.json
 *             + ~/.local/share/opencode/storage/part/{message-id}/*.json
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
  CodexSessionEntry,
} from '@claude-web-view/shared';
import {
  isJsonlUserEntry,
  isJsonlAssistantEntry,
  isJsonlTextBlock,
  isJsonlToolUseBlock,
  isCodexSessionMeta,
  isCodexUserMessageEvent,
  isCodexAgentMessageEvent,
  isCodexResponseMessage,
} from '@claude-web-view/shared';

// =============================================================================
// Constants
// =============================================================================

/** Default location of Claude Code projects directory */
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** Default location of Codex native sessions directory */
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

/** Default location of OpenCode storage directories */
const OPENCODE_STORAGE_DIR = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');
const OPENCODE_MESSAGE_DIR = path.join(OPENCODE_STORAGE_DIR, 'message');
const OPENCODE_PART_DIR = path.join(OPENCODE_STORAGE_DIR, 'part');
const OPENCODE_SESSION_DIR = path.join(OPENCODE_STORAGE_DIR, 'session');

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
    const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') {
      // Only warn once per directory to avoid log spam during polling
      if (!warnedDirectories.has(projectsDir)) {
        warnedDirectories.add(projectsDir);
        console.warn(`Projects directory not found, skipping: ${projectsDir}`);
      }
    } else {
      console.warn(`Failed to read projects directory: ${projectsDir} (${error instanceof Error ? error.message : error})`);
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
    const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') {
      return [];
    }
    console.warn(`Failed to scan project directory: ${projectPath} (${error instanceof Error ? error.message : error})`);
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
  const monthDirsNested = await Promise.all(yearDirs.map((yearDir) => getProjectDirectories(yearDir)));
  const monthDirs = monthDirsNested.flat();
  const dayDirsNested = await Promise.all(monthDirs.map((monthDir) => getProjectDirectories(monthDir)));
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
async function getOpenCodeSessionMetadataIndex(
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

interface CodexSession {
  sessionId: string;
  filePath: string;
  workingDirectory: string;
  model: string;
  parentSessionId: string | null;
  createdAt: Date;
  modifiedAt: Date;
  entries: CodexSessionEntry[];
}

interface OpenCodeSession {
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

function extractCodexSessionIdFromFilename(filePath: string): string | null {
  const stem = path.basename(filePath, '.jsonl');
  const match = stem.match(CODEX_SESSION_ID_RE);
  return match ? match[1] : null;
}

/**
 * Parse a native Codex session file (~/.codex/sessions/YYYY/MM/DD/*.jsonl).
 */
async function parseCodexJsonlFile(filePath: string): Promise<CodexSession> {
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
    crlfDelay: Infinity,
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
    console.warn(`Skipped ${skippedLines} malformed line${skippedLines > 1 ? 's' : ''} in ${filePath}`);
  }

  sessionId = sessionId || extractCodexSessionIdFromFilename(filePath) || path.basename(filePath, '.jsonl');
  workingDirectory = workingDirectory || process.cwd();

  return {
    sessionId,
    filePath,
    workingDirectory,
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
    const order =
      asNumber(timeObj?.start) ??
      asNumber(timeObj?.end) ??
      Number.MAX_SAFE_INTEGER;

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
async function getOpenCodeSessionMtime(
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
async function parseOpenCodeSessionDirectory(
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
      workingDirectory =
        asString(pathObj?.cwd) ??
        asString(pathObj?.root) ??
        workingDirectory;
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

  const metadataPath = sessionMetadataIndex.get(sessionId) ?? sessionMetadataIndex.get(fallbackSessionId);
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
    workingDirectory: workingDirectory || process.cwd(),
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
function extractMessagesFromCodexEntries(entries: CodexSessionEntry[]): Message[] {
  const messages: Message[] = [];

  const hasEventMessages = entries.some((entry) =>
    isCodexUserMessageEvent(entry) || isCodexAgentMessageEvent(entry)
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
const HIDE_TEST_RE = /^\[_HIDE_TEST_\]\s*/;

/**
 * Oompa worker tag regex. If the first user message starts with this tag,
 * the conversation is classified as a worker (hidden from main UI).
 *
 * Tag format:
 *   [oompa]                       → isWorker=true
 *   [oompa:<swarmId>]             → isWorker=true, swarmId set
 *   [oompa:<swarmId>:<workerId>]  → isWorker=true, swarmId + workerId set
 *
 * The tag is stripped from the message content for display.
 */
const OOMPA_RE = /^\[oompa(?::([^:\]]+)(?::([^\]]+))?)?\]/;

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
  if (content.includes('VERDICT: APPROVED') && content.includes('VERDICT: NEEDS_CHANGES')) return 'review';
  return 'work';
}

interface WorkerMetadata {
  isHidden: boolean;
  isWorker: boolean;
  swarmId: string | null;
  workerId: string | null;
  workerRole: 'work' | 'review' | 'fix' | null;
}

function extractWorkerMetadata(messages: Message[]): WorkerMetadata {
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

/**
 * Convert a parsed JSONL session to our Conversation type.
 * Returns null for [_HIDE_TEST_] conversations (test/probe runs dropped at ingestion).
 * Detects oompa workers by checking for "[oompa...]" tag in the first user message.
 */
export function jsonlSessionToConversation(session: JsonlSession): Conversation | null {
  const messages = extractMessagesFromEntries(session.entries);
  const worker = extractWorkerMetadata(messages);
  if (worker.isHidden) return null;

  return {
    id: session.sessionId,
    messages,
    isRunning: false,
    confirmed: true,
    createdAt: session.createdAt,
    workingDirectory: session.workingDirectory,
    loopConfig: null,
    provider: inferProviderFromModel(session.model),
    subAgents: extractSubAgentsFromEntries(session.entries),
    queue: [],
    isWorker: worker.isWorker,
    swarmId: worker.swarmId,
    workerId: worker.workerId,
    workerRole: worker.workerRole,
    parentConversationId: null,
    modelName: session.model !== 'unknown' ? session.model : null,
  };
}

function codexSessionToConversation(session: CodexSession): Conversation | null {
  const messages = extractMessagesFromCodexEntries(session.entries);
  const worker = extractWorkerMetadata(messages);
  if (worker.isHidden) return null;

  return {
    id: session.sessionId,
    messages,
    isRunning: false,
    confirmed: true,
    createdAt: session.createdAt,
    workingDirectory: session.workingDirectory,
    loopConfig: null,
    provider: 'codex',
    subAgents: [],
    queue: [],
    isWorker: worker.isWorker,
    swarmId: worker.swarmId,
    workerId: worker.workerId,
    workerRole: worker.workerRole,
    parentConversationId: session.parentSessionId ?? null,
    modelName: session.model !== 'unknown' ? session.model : null,
  };
}

function openCodeSessionToConversation(session: OpenCodeSession): Conversation | null {
  const messages = [...session.messages];
  const worker = extractWorkerMetadata(messages);
  if (worker.isHidden) return null;

  return {
    id: session.sessionId,
    messages,
    isRunning: false,
    confirmed: true,
    createdAt: session.createdAt,
    workingDirectory: session.workingDirectory,
    loopConfig: null,
    provider: 'opencode',
    subAgents: [],
    queue: [],
    isWorker: worker.isWorker,
    swarmId: worker.swarmId,
    workerId: worker.workerId,
    workerRole: worker.workerRole,
    parentConversationId: null,
    modelName: session.model !== 'unknown' ? session.model : null,
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

// =============================================================================
// Parallel Processing Helper
// =============================================================================

/**
 * Process items with bounded concurrency (worker-pool pattern).
 * No external dependencies — just Promise-based throttling.
 *
 * @param items - Array of items to process
 * @param concurrency - Max concurrent operations
 * @param fn - Async function to call on each item
 * @returns Array of results in the same order as input
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  // Start `concurrency` workers
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);

  return results;
}

// =============================================================================
// File Discovery (Phase 1 — fast readdir + stat for mtime sorting)
// =============================================================================

interface DiscoveredFile {
  filePath: string;
  mtimeMs: number;
  source: 'claude' | 'codex' | 'opencode';
}

/**
 * Discover all persisted conversation sources, sorted by mtime descending.
 * Stats each source to get mtime for sorting (most recently modified first).
 * This enables progressive loading: recent conversations appear first.
 */
async function discoverAllJsonlFiles(
  claudeProjectsDir: string,
  codexSessionsDir: string,
  openCodeMessageDir: string,
  openCodePartDir: string,
  openCodeSessionIndex: Map<string, string>
): Promise<DiscoveredFile[]> {
  const files: DiscoveredFile[] = [];

  async function scanSource(dirs: string[], source: 'claude' | 'codex') {
    for (const projectDir of dirs) {
      const jsonlPaths = await scanSessionDirectory(projectDir);
      // Stat each file to get mtime (parallel within directory)
      const statPromises = jsonlPaths.map(async (filePath) => {
        try {
          const stat = await fs.promises.stat(filePath);
          return { filePath, mtimeMs: stat.mtimeMs, source };
        } catch {
          // File may have been deleted between readdir and stat
          return null;
        }
      });
      const results = await Promise.all(statPromises);
      for (const result of results) {
        if (result) files.push(result);
      }
    }
  }

  async function scanOpenCodeSource(sessionDirs: string[]) {
    for (const sessionDirPath of sessionDirs) {
      const sessionId = path.basename(sessionDirPath);
      const metadataPath = openCodeSessionIndex.get(sessionId);
      const mtimeMs = await getOpenCodeSessionMtime(sessionDirPath, openCodePartDir, metadataPath);
      if (mtimeMs > 0) {
        files.push({ filePath: sessionDirPath, mtimeMs, source: 'opencode' });
      }
    }
  }

  const [claudeDirs, codexDirs, openCodeDirs] = await Promise.all([
    getProjectDirectories(claudeProjectsDir),
    getCodexSessionDirectories(codexSessionsDir),
    getOpenCodeSessionDirectories(openCodeMessageDir),
  ]);

  await Promise.all([
    scanSource(claudeDirs, 'claude'),
    scanSource(codexDirs, 'codex'),
    scanOpenCodeSource(openCodeDirs),
  ]);

  // Sort by mtime descending (most recent first)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return files;
}

// =============================================================================
// File Parsing (Phase 2 — parallelized with concurrency limit)
// =============================================================================

interface ParsedResult {
  filePath: string;
  mtimeMs: number;
  conversation: Conversation | null;
  parseTimeMs: number;
}

/**
 * Parse a single JSONL file and return the conversation.
 * Returns null if parsing fails or produces empty messages.
 * Includes timing metrics for performance analysis.
 */
async function parseOneFile(
  file: DiscoveredFile,
  openCodePartDir: string,
  openCodeSessionIndex: Map<string, string>
): Promise<ParsedResult> {
  const startTime = performance.now();
  try {
    let conversation: Conversation | null;

    if (file.source === 'codex') {
      const session = await parseCodexJsonlFile(file.filePath);
      if (session.entries.length === 0) {
        const parseTimeMs = performance.now() - startTime;
        return { filePath: file.filePath, mtimeMs: file.mtimeMs, conversation: null, parseTimeMs };
      }
      conversation = codexSessionToConversation(session);
    } else if (file.source === 'claude') {
      const session = await parseJsonlFile(file.filePath);
      if (session.entries.length === 0) {
        const parseTimeMs = performance.now() - startTime;
        return { filePath: file.filePath, mtimeMs: file.mtimeMs, conversation: null, parseTimeMs };
      }
      conversation = jsonlSessionToConversation(session);
    } else {
      const session = await parseOpenCodeSessionDirectory(file.filePath, openCodePartDir, openCodeSessionIndex);
      if (session.messages.length === 0) {
        const parseTimeMs = performance.now() - startTime;
        return { filePath: file.filePath, mtimeMs: file.mtimeMs, conversation: null, parseTimeMs };
      }
      conversation = openCodeSessionToConversation(session);
    }

    const parseTimeMs = performance.now() - startTime;

    // null = hidden test conversation ([_HIDE_TEST_]) or empty messages — drop at ingestion.
    if (!conversation || conversation.messages.length === 0) {
      return { filePath: file.filePath, mtimeMs: file.mtimeMs, conversation: null, parseTimeMs };
    }

    return { filePath: file.filePath, mtimeMs: file.mtimeMs, conversation, parseTimeMs };
  } catch (error: unknown) {
    const parseTimeMs = performance.now() - startTime;
    console.warn(`Failed to parse session: ${path.basename(file.filePath)} (${error instanceof Error ? error.message : error})`);
    return { filePath: file.filePath, mtimeMs: 0, conversation: null, parseTimeMs };
  }
}

/**
 * Callback for progressive loading — invoked with batches of conversations.
 * Called multiple times during loading so clients receive data incrementally.
 */
export type LoadProgressCallback = (batch: Conversation[], progress: { loaded: number; total: number }) => void;

/**
 * Load all conversations from Claude Code, Codex native session files, and
 * OpenCode local storage session files.
 *
 * Scans:
 * 1. ~/.claude/projects/* (Claude Code sessions)
 * 2. ~/.codex/sessions/YYYY/MM/DD/* (Codex native sessions)
 * 3. ~/.local/share/opencode/storage/message/* (OpenCode sessions)
 *
 * Phase 1: Discover all file paths + stat for mtime (sorted by mtime descending)
 * Phase 2: Parse files in parallel with bounded concurrency, emitting batches progressively
 *
 * Files are sorted by mtime descending (most recent first), so the onProgress callback
 * receives the most recently used conversations first. This enables the server to
 * broadcast batches to clients incrementally instead of waiting for all files.
 *
 * @param claudeProjectsDir - Directory containing Claude Code project folders
 * @param codexSessionsDir - Directory containing Codex native session files
 * @param openCodeMessageDir - Directory containing OpenCode message session folders
 * @param onProgress - Optional callback invoked with batches of parsed conversations
 * @returns conversations + mtime index for subsequent polling
 */
export async function loadAllConversations(
  claudeProjectsDir: string = CLAUDE_PROJECTS_DIR,
  codexSessionsDir: string = CODEX_SESSIONS_DIR,
  openCodeMessageDirOrOnProgress?: string | LoadProgressCallback,
  maybeOnProgress?: LoadProgressCallback
): Promise<LoadResult> {
  const CONCURRENCY = 10; // macOS default fd limit is 256; 10 is very safe
  const BATCH_SIZE = 50;  // Emit progress every N files
  const openCodeMessageDir = typeof openCodeMessageDirOrOnProgress === 'string'
    ? openCodeMessageDirOrOnProgress
    : OPENCODE_MESSAGE_DIR;
  const onProgress = typeof openCodeMessageDirOrOnProgress === 'function'
    ? openCodeMessageDirOrOnProgress
    : maybeOnProgress;
  const openCodeStorageDir = path.dirname(openCodeMessageDir);
  const openCodePartDir = path.join(openCodeStorageDir, 'part');
  const openCodeSessionDir = path.join(openCodeStorageDir, 'session');
  const openCodeSessionIndex = await getOpenCodeSessionMetadataIndex(openCodeSessionDir);

  // Phase 1: Discover all files (sorted by mtime descending)
  const discoverStart = performance.now();
  console.log('Discovering persisted conversation files...');
  const files = await discoverAllJsonlFiles(
    claudeProjectsDir,
    codexSessionsDir,
    openCodeMessageDir,
    openCodePartDir,
    openCodeSessionIndex
  );
  const discoverTimeMs = performance.now() - discoverStart;
  console.log(`Discovered ${files.length} persisted conversation sources in ${discoverTimeMs.toFixed(0)}ms (sorted by mtime), parsing with concurrency=${CONCURRENCY}...`);

  // Phase 2: Parse files in parallel with batched progress callbacks
  const conversations = new Map<string, Conversation>();
  const mtimes = new Map<string, number>();
  const parseTimes: number[] = [];
  let batchBuffer: Conversation[] = [];
  let filesProcessed = 0;

  // Process files with bounded concurrency, emitting batches as we go
  const parseStart = performance.now();

  await mapWithConcurrency(files, CONCURRENCY, async (file) => {
    const result = await parseOneFile(file, openCodePartDir, openCodeSessionIndex);

    // Track timing
    parseTimes.push(result.parseTimeMs);

    // Collect results
    if (result.mtimeMs > 0) {
      mtimes.set(result.filePath, result.mtimeMs);
    }
    if (result.conversation) {
      conversations.set(result.conversation.id, result.conversation);
      batchBuffer.push(result.conversation);
    }

    filesProcessed++;

    // Emit batch when threshold reached
    if (onProgress && batchBuffer.length >= BATCH_SIZE) {
      onProgress(batchBuffer, { loaded: filesProcessed, total: files.length });
      batchBuffer = [];
    }

    return result;
  });

  // Emit any remaining conversations in the final batch
  if (onProgress && batchBuffer.length > 0) {
    onProgress(batchBuffer, { loaded: filesProcessed, total: files.length });
  }

  const parseTimeMs = performance.now() - parseStart;

  // Log timing summary
  if (parseTimes.length > 0) {
    const sorted = [...parseTimes].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const avg = parseTimes.reduce((a, b) => a + b, 0) / parseTimes.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];

    console.log(`Parse timing (${parseTimes.length} files): min=${min.toFixed(1)}ms, avg=${avg.toFixed(1)}ms, median=${median.toFixed(1)}ms, p95=${p95.toFixed(1)}ms, max=${max.toFixed(1)}ms`);
  }

  const totalTimeMs = discoverTimeMs + parseTimeMs;
  console.log(`Loaded ${conversations.size} conversations from ${files.length} files in ${totalTimeMs.toFixed(0)}ms (discover: ${discoverTimeMs.toFixed(0)}ms, parse: ${parseTimeMs.toFixed(0)}ms)`);

  return { conversations, mtimes };
}

// =============================================================================
// File Polling — detect external changes to persisted conversation sources
//
// Compares file mtimes against a previous index. Only re-parses files that
// changed. Skips conversations that are actively running (in-memory state
// is authoritative for those).
//
// NOTE: No dir-level mtime gate. Directory mtime only changes when files are
// added/removed, NOT when existing files are modified. Since we need to detect
// external writes to existing session files, we must stat source files directly.
// Individual stat calls are cheap (microseconds).
// =============================================================================

/**
 * Poll for changes to persisted session sources since the last check.
 *
 * @param prevMtimes - Previous mtime index (filepath → mtime ms)
 * @param activeIds - Conversation IDs currently running (skip these)
 * @returns Changed conversations + updated mtime index
 */
export async function pollForChanges(
  prevMtimes: Map<string, number>,
  activeIds: Set<string>,
  claudeProjectsDir: string = CLAUDE_PROJECTS_DIR,
  codexSessionsDir: string = CODEX_SESSIONS_DIR,
  openCodeMessageDir: string = OPENCODE_MESSAGE_DIR
): Promise<PollResult> {
  const updated = new Map<string, Conversation>();
  const mtimes = new Map(prevMtimes);
  const openCodeStorageDir = path.dirname(openCodeMessageDir);
  const openCodePartDir = path.join(openCodeStorageDir, 'part');
  const openCodeSessionDir = path.join(openCodeStorageDir, 'session');

  async function scanSource(dirs: string[], source: 'claude' | 'codex') {
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

          // Fast skip for active sessions.
          if (source === 'claude') {
            const sessionId = path.basename(filePath, '.jsonl');
            if (activeIds.has(sessionId)) {
              continue;
            }
          } else {
            const sessionIdHint = extractCodexSessionIdFromFilename(filePath);
            if (sessionIdHint && activeIds.has(sessionIdHint)) {
              continue;
            }
          }

          let conversation: Conversation | null;
          if (source === 'codex') {
            const session = await parseCodexJsonlFile(filePath);
            if (session.entries.length === 0) continue;
            conversation = codexSessionToConversation(session);
          } else {
            const session = await parseJsonlFile(filePath);
            if (session.entries.length === 0) continue;
            conversation = jsonlSessionToConversation(session);
          }

          // null = hidden test conversation ([_HIDE_TEST_]) — dropped at ingestion.
          if (!conversation) continue;
          if (activeIds.has(conversation.id)) continue;
          if (conversation.messages.length === 0) continue;

          updated.set(conversation.id, conversation);
        } catch (error: unknown) {
          console.warn(`[Poll] Failed to parse: ${path.basename(filePath)} (${error instanceof Error ? error.message : error})`);
        }
      }
    }
  }

  async function scanOpenCodeSource(sessionDirs: string[], sessionMetadataIndex: Map<string, string>) {
    for (const sessionDirPath of sessionDirs) {
      try {
        const sessionIdHint = path.basename(sessionDirPath);
        const metadataPath = sessionMetadataIndex.get(sessionIdHint);
        const mtimeMs = await getOpenCodeSessionMtime(sessionDirPath, openCodePartDir, metadataPath);
        if (mtimeMs <= 0) {
          continue;
        }

        const prevMtime = prevMtimes.get(sessionDirPath);
        if (prevMtime !== undefined && mtimeMs <= prevMtime) {
          continue;
        }

        mtimes.set(sessionDirPath, mtimeMs);

        if (activeIds.has(sessionIdHint)) {
          continue;
        }

        const session = await parseOpenCodeSessionDirectory(sessionDirPath, openCodePartDir, sessionMetadataIndex);
        if (session.messages.length === 0) {
          continue;
        }

        const conversation = openCodeSessionToConversation(session);
        // null = hidden test conversation ([_HIDE_TEST_]) — dropped at ingestion.
        if (!conversation) continue;
        if (activeIds.has(conversation.id)) continue;
        if (conversation.messages.length === 0) continue;

        updated.set(conversation.id, conversation);
      } catch (error: unknown) {
        console.warn(`[Poll] Failed to parse OpenCode session: ${path.basename(sessionDirPath)} (${error instanceof Error ? error.message : error})`);
      }
    }
  }

  const [claudeDirs, codexDirs, openCodeDirs, openCodeSessionIndex] = await Promise.all([
    getProjectDirectories(claudeProjectsDir),
    getCodexSessionDirectories(codexSessionsDir),
    getOpenCodeSessionDirectories(openCodeMessageDir),
    getOpenCodeSessionMetadataIndex(openCodeSessionDir),
  ]);

  await scanSource(claudeDirs, 'claude');
  await scanSource(codexDirs, 'codex');
  await scanOpenCodeSource(openCodeDirs, openCodeSessionIndex);

  return { updated, mtimes };
}
