/**
 * Loader — generic load and poll loop driven by the DiskAdapter registry.
 *
 * No per-provider if/else chains here. Adding a new provider to the registry
 * (registry.ts) is sufficient — this file never needs to change.
 *
 * Two phases (matching original design):
 *   Phase 1 — discoverAll(): stat every file for mtime, sort by mtime desc.
 *   Phase 2 — parseFile() in parallel with bounded concurrency, emit batches.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Conversation } from '@claude-web-view/shared';
import type { DiskAdapter, LoadResult, PollResult, LoadProgressCallback } from './disk-adapter';
import { sessionToConversation } from './disk-adapter';
import { diskAdapters } from './registry';
import {
  getOpenCodeSessionMtime,
  OPENCODE_PART_DIR,
  getOpenCodeSessionMetadataIndex,
} from './registry';
import {
  extractCodexSessionIdFromFilename,
} from './jsonl';

// =============================================================================
// DiscoveredFile — adapter-tagged file entry from Phase 1
// =============================================================================

interface DiscoveredFile {
  filePath: string;
  mtimeMs: number;
  adapter: DiskAdapter;
}

// =============================================================================
// Phase 1 — discover all files across all adapters, sorted by mtime desc
// =============================================================================

/**
 * Discover all session paths from all adapters, stat each for mtime, sort by
 * mtime descending so progressive loading serves the most recent sessions first.
 *
 * OpenCode sessions are directories — their mtime is the max mtime across all
 * contained message files and part subdirectories (computed by getOpenCodeSessionMtime).
 */
async function discoverAll(adapters: DiskAdapter[]): Promise<DiscoveredFile[]> {
  const files: DiscoveredFile[] = [];

  await Promise.all(
    adapters.map(async (adapter) => {
      let paths: string[];
      try {
        paths = await adapter.discoverFiles();
      } catch (err) {
        console.warn(`[discover] ${adapter.provider}: discoverFiles() failed: ${err instanceof Error ? err.message : err}`);
        return;
      }

      const statResults = await Promise.all(
        paths.map(async (filePath) => {
          try {
            if (adapter.provider === 'opencode') {
              // OpenCode "files" are session directories — compute composite mtime.
              // getOpenCodeSessionMtime inspects message files + part dirs.
              // We don't have the session index available here, but the adapter
              // already built it during discoverFiles(), so a plain stat suffices
              // for mtime ordering; the real mtime is computed as a composite below.
              const mtimeMs = await getOpenCodeSessionMtime(filePath, OPENCODE_PART_DIR);
              if (mtimeMs <= 0) return null;
              return { filePath, mtimeMs, adapter };
            } else {
              const stat = await fs.promises.stat(filePath);
              return { filePath, mtimeMs: stat.mtimeMs, adapter };
            }
          } catch {
            // File may have been deleted between discoverFiles() and stat()
            return null;
          }
        })
      );

      for (const result of statResults) {
        if (result) files.push(result);
      }
    })
  );

  // Sort by mtime descending — most recently modified sessions first.
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

// =============================================================================
// Parallel processing helper
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

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// =============================================================================
// Phase 2 helper — parse one discovered file
// =============================================================================

interface ParsedResult {
  filePath: string;
  mtimeMs: number;
  conversation: Conversation | null;
  parseTimeMs: number;
}

async function parseOneFile(file: DiscoveredFile): Promise<ParsedResult> {
  const startTime = performance.now();
  try {
    const session = await file.adapter.parseFile(file.filePath);
    const parseTimeMs = performance.now() - startTime;

    if (!session) {
      return { filePath: file.filePath, mtimeMs: file.mtimeMs, conversation: null, parseTimeMs };
    }

    const conversation = sessionToConversation(session);

    // null = hidden test conversation ([_HIDE_TEST_]) or empty messages — drop at ingestion.
    if (!conversation || conversation.messages.length === 0) {
      return { filePath: file.filePath, mtimeMs: file.mtimeMs, conversation: null, parseTimeMs };
    }

    return { filePath: file.filePath, mtimeMs: file.mtimeMs, conversation, parseTimeMs };
  } catch (error: unknown) {
    const parseTimeMs = performance.now() - startTime;
    console.warn(
      `Failed to parse session: ${path.basename(file.filePath)} (${error instanceof Error ? error.message : error})`
    );
    return { filePath: file.filePath, mtimeMs: 0, conversation: null, parseTimeMs };
  }
}

// =============================================================================
// loadAllConversations — startup load with batched progress callbacks
// =============================================================================

/**
 * Load all conversations from all supported CLI agent session files.
 *
 * Uses the diskAdapters registry — no per-provider if/else here.
 *
 * Phase 1: Discover all file paths + stat for mtime (sorted by mtime descending)
 * Phase 2: Parse files in parallel with bounded concurrency, emitting batches progressively
 *
 * Files are sorted by mtime descending (most recent first), so the onProgress callback
 * receives the most recently used conversations first. This enables the server to
 * broadcast batches to clients incrementally instead of waiting for all files.
 *
 * @param onProgress - Optional callback invoked with batches of parsed conversations
 * @returns conversations + mtime index for subsequent polling
 */
export async function loadAllConversations(
  onProgress?: LoadProgressCallback
): Promise<LoadResult> {
  const CONCURRENCY = 10; // macOS default fd limit is 256; 10 is very safe
  const BATCH_SIZE = 50;  // Emit progress every N files

  // Phase 1: Discover all files (sorted by mtime descending)
  const discoverStart = performance.now();
  console.log('Discovering persisted conversation files...');
  const files = await discoverAll(diskAdapters);
  const discoverTimeMs = performance.now() - discoverStart;
  console.log(
    `Discovered ${files.length} persisted conversation sources in ${discoverTimeMs.toFixed(0)}ms (sorted by mtime), parsing with concurrency=${CONCURRENCY}...`
  );

  // Phase 2: Parse files in parallel with batched progress callbacks
  const conversations = new Map<string, Conversation>();
  const mtimes = new Map<string, number>();
  const parseTimes: number[] = [];
  let batchBuffer: Conversation[] = [];
  let filesProcessed = 0;

  const parseStart = performance.now();

  await mapWithConcurrency(files, CONCURRENCY, async (file) => {
    const result = await parseOneFile(file);

    parseTimes.push(result.parseTimeMs);

    if (result.mtimeMs > 0) {
      mtimes.set(result.filePath, result.mtimeMs);
    }
    if (result.conversation) {
      conversations.set(result.conversation.id, result.conversation);
      batchBuffer.push(result.conversation);
    }

    filesProcessed++;

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
    console.log(
      `Parse timing (${parseTimes.length} files): min=${min.toFixed(1)}ms, avg=${avg.toFixed(1)}ms, median=${median.toFixed(1)}ms, p95=${p95.toFixed(1)}ms, max=${max.toFixed(1)}ms`
    );
  }

  const totalTimeMs = discoverTimeMs + parseTimeMs;
  console.log(
    `Loaded ${conversations.size} conversations from ${files.length} files in ${totalTimeMs.toFixed(0)}ms (discover: ${discoverTimeMs.toFixed(0)}ms, parse: ${parseTimeMs.toFixed(0)}ms)`
  );

  return { conversations, mtimes };
}

// =============================================================================
// pollForChanges — incremental poll comparing mtimes to previous index
//
// NOTE: No dir-level mtime gate. Directory mtime only changes when files are
// added/removed, NOT when existing files are modified. Since we need to detect
// external writes to existing session files, we must stat source files directly.
// Individual stat calls are cheap (microseconds).
// =============================================================================

/**
 * Poll for changes to persisted session sources since the last check.
 *
 * Uses the diskAdapters registry — no per-provider if/else here.
 *
 * @param prevMtimes - Previous mtime index (filepath → mtime ms)
 * @param activeIds - Conversation IDs currently running (skip these)
 * @returns Changed conversations + updated mtime index
 */
export async function pollForChanges(
  prevMtimes: Map<string, number>,
  activeIds: Set<string>
): Promise<PollResult> {
  const updated = new Map<string, Conversation>();
  const mtimes = new Map(prevMtimes);

  // Rebuild the OpenCode session metadata index once per poll cycle.
  // New sessions added between polls need their metadata entry to be found.
  const openCodeSessionIndex = await getOpenCodeSessionMetadataIndex();

  for (const adapter of diskAdapters) {
    let paths: string[];
    try {
      paths = await adapter.discoverFiles();
    } catch (err) {
      console.warn(`[poll] ${adapter.provider}: discoverFiles() failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    for (const filePath of paths) {
      try {
        // Compute current mtime — for OpenCode sessions (directories) use
        // the composite mtime that covers message files + part subdirs.
        let currentMtime: number;
        if (adapter.provider === 'opencode') {
          const sessionId = path.basename(filePath);
          const metadataPath = openCodeSessionIndex.get(sessionId);
          currentMtime = await getOpenCodeSessionMtime(filePath, OPENCODE_PART_DIR, metadataPath);
          if (currentMtime <= 0) continue;
        } else {
          const stat = await fs.promises.stat(filePath);
          currentMtime = stat.mtimeMs;
        }

        const prevMtime = prevMtimes.get(filePath);

        // Skip if file mtime unchanged
        if (prevMtime !== undefined && currentMtime <= prevMtime) {
          continue;
        }

        // File is new or changed — update mtime index
        mtimes.set(filePath, currentMtime);

        // Fast skip for active sessions — in-memory state is authoritative
        // while a process is running; let the next poll pick up the final state.
        if (adapter.provider === 'claude') {
          const sessionId = path.basename(filePath, '.jsonl');
          if (activeIds.has(sessionId)) continue;
        } else if (adapter.provider === 'codex') {
          const sessionIdHint = extractCodexSessionIdFromFilename(filePath);
          if (sessionIdHint && activeIds.has(sessionIdHint)) continue;
        } else if (adapter.provider === 'opencode') {
          const sessionIdHint = path.basename(filePath);
          if (activeIds.has(sessionIdHint)) continue;
        }

        // Re-parse the changed session
        const session = await adapter.parseFile(filePath);
        if (!session) continue;

        const conversation = sessionToConversation(session);
        // null = hidden test conversation ([_HIDE_TEST_]) — dropped at ingestion.
        if (!conversation) continue;
        if (activeIds.has(conversation.id)) continue;
        if (conversation.messages.length === 0) continue;

        updated.set(conversation.id, conversation);
      } catch (error: unknown) {
        console.warn(
          `[Poll] Failed to parse ${adapter.provider} session: ${path.basename(filePath)} (${error instanceof Error ? error.message : error})`
        );
      }
    }
  }

  return { updated, mtimes };
}
