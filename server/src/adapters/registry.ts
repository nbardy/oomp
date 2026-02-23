/**
 * DiskAdapter Registry
 *
 * Four thin DiskAdapter implementations that wrap the existing parsing functions
 * in jsonl.ts. Each adapter maps its provider-specific session type to ParsedSession.
 *
 * Adding a new provider (e.g. Grok) = one new adapter object appended to diskAdapters.
 * Zero changes to loader.ts or any other file.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DiskAdapter, ParsedSession } from './disk-adapter';
import {
  CLAUDE_PROJECTS_DIR,
  CODEX_SESSIONS_DIR,
  OPENCODE_MESSAGE_DIR,
  OPENCODE_PART_DIR,
  GEMINI_SESSIONS_DIR,
  getProjectDirectories,
  scanSessionDirectory,
  getCodexSessionDirectories,
  getOpenCodeSessionDirectories,
  getOpenCodeSessionMetadataIndex,
  getOpenCodeSessionMtime,
  getGeminiSessionFiles,
  parseJsonlFile,
  parseCodexJsonlFile,
  parseOpenCodeSessionDirectory,
  parseGeminiSessionFile,
  extractMessagesFromEntries,
  extractMessagesFromCodexEntries,
  extractSubAgentsFromEntries,
  inferProviderFromModel,
} from './jsonl';

// =============================================================================
// Claude adapter
//
// Reads ~/.claude/projects/{encoded-path}/*.jsonl
// Provider is inferred from the model name (most sessions are 'claude', but
// some may be 'codex' or 'gemini' depending on model).
// =============================================================================

const claudeAdapter: DiskAdapter = {
  provider: 'claude',

  async discoverFiles(): Promise<string[]> {
    const projectDirs = await getProjectDirectories(CLAUDE_PROJECTS_DIR);
    const fileLists = await Promise.all(projectDirs.map((dir) => scanSessionDirectory(dir)));
    return fileLists.flat();
  },

  async parseFile(filePath: string): Promise<ParsedSession | null> {
    const session = await parseJsonlFile(filePath);
    if (session.entries.length === 0) return null;

    const messages = extractMessagesFromEntries(session.entries);
    const subAgents = extractSubAgentsFromEntries(session.entries);
    const provider = inferProviderFromModel(session.model);

    return {
      sessionId: session.sessionId,
      filePath: session.filePath,
      workingDirectory: session.workingDirectory,
      provider,
      model: session.model,
      createdAt: session.createdAt,
      modifiedAt: session.modifiedAt,
      messages,
      subAgents,
      parentSessionId: null,
    };
  },
};

// =============================================================================
// Codex adapter
//
// Reads ~/.codex/sessions/YYYY/MM/DD/*.jsonl
// Provider is always 'codex'. Extracts parentSessionId for thread nesting.
// =============================================================================

const codexAdapter: DiskAdapter = {
  provider: 'codex',

  async discoverFiles(): Promise<string[]> {
    const dayDirs = await getCodexSessionDirectories(CODEX_SESSIONS_DIR);
    const fileLists = await Promise.all(dayDirs.map((dir) => scanSessionDirectory(dir)));
    return fileLists.flat();
  },

  async parseFile(filePath: string): Promise<ParsedSession | null> {
    const session = await parseCodexJsonlFile(filePath);
    if (session.entries.length === 0) return null;

    const messages = extractMessagesFromCodexEntries(session.entries);

    return {
      sessionId: session.sessionId,
      filePath: session.filePath,
      workingDirectory: session.workingDirectory,
      provider: 'codex',
      model: session.model,
      createdAt: session.createdAt,
      modifiedAt: session.modifiedAt,
      messages,
      subAgents: [],
      parentSessionId: session.parentSessionId,
    };
  },
};

// =============================================================================
// OpenCode adapter
//
// Reads ~/.local/share/opencode/storage/message/{session-id}/ directories.
// Each "file" is actually a session directory containing message JSON files.
// The session metadata index (session ID → metadata path) is built lazily on
// first discoverFiles() call and reused across all subsequent parseFile() calls
// within that discovery cycle.
//
// NOTE: The adapter object holds a mutable `_sessionIndex` field so that the
// index is computed once per discovery cycle, not once per parseFile() call.
// This is safe because loader.ts calls discoverFiles() before any parseFile().
// =============================================================================

const opencodeAdapter: DiskAdapter & { _sessionIndex: Map<string, string> | null } = {
  provider: 'opencode',
  _sessionIndex: null,

  async discoverFiles(): Promise<string[]> {
    // Rebuild the session metadata index on each discovery pass so that new
    // sessions added between polls are picked up.
    this._sessionIndex = await getOpenCodeSessionMetadataIndex();
    const sessionDirs = await getOpenCodeSessionDirectories(OPENCODE_MESSAGE_DIR);
    return sessionDirs;
  },

  async parseFile(dirPath: string): Promise<ParsedSession | null> {
    // Use the index built during discoverFiles(); fall back to empty map if
    // parseFile() is somehow called without a prior discoverFiles().
    const sessionIndex = this._sessionIndex ?? new Map<string, string>();
    const session = await parseOpenCodeSessionDirectory(dirPath, OPENCODE_PART_DIR, sessionIndex);
    if (session.messages.length === 0) return null;

    return {
      sessionId: session.sessionId,
      filePath: session.filePath,
      workingDirectory: session.workingDirectory,
      provider: 'opencode',
      model: session.model,
      createdAt: session.createdAt,
      modifiedAt: session.modifiedAt,
      messages: session.messages,
      subAgents: [],
      parentSessionId: null,
    };
  },
};

// =============================================================================
// Gemini adapter
//
// Reads ~/.gemini/tmp/{project}/chats/session-*.json files.
// Provider is always 'gemini'.
// =============================================================================

const geminiAdapter: DiskAdapter = {
  provider: 'gemini',

  async discoverFiles(): Promise<string[]> {
    return getGeminiSessionFiles(GEMINI_SESSIONS_DIR);
  },

  async parseFile(filePath: string): Promise<ParsedSession | null> {
    const session = await parseGeminiSessionFile(filePath);
    if (session.messages.length === 0) return null;

    return {
      sessionId: session.sessionId,
      filePath: session.filePath,
      workingDirectory: session.workingDirectory,
      provider: 'gemini',
      model: session.model,
      createdAt: session.createdAt,
      modifiedAt: session.modifiedAt,
      messages: [...session.messages],
      subAgents: [],
      parentSessionId: null,
    };
  },
};

// =============================================================================
// Registry — ordered list of all adapters
//
// To add a new provider (e.g. Grok): implement DiskAdapter, append here.
// The load/poll loop in loader.ts iterates this list with no other changes.
// =============================================================================

export const diskAdapters: DiskAdapter[] = [
  claudeAdapter,
  codexAdapter,
  opencodeAdapter,
  geminiAdapter,
];

// =============================================================================
// Re-export per-adapter helpers needed by loader.ts for polling
// (mtime computation for OpenCode sessions, session ID extraction for Codex)
// =============================================================================

export { getOpenCodeSessionMtime, OPENCODE_PART_DIR, getOpenCodeSessionMetadataIndex };

// Export adapter type for tests / extension points
export type { DiskAdapter };
