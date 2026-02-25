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
import type { DiskAdapter, LoadProgressCallback, LoadResult, PollResult } from './disk-adapter';
import { sessionToConversation } from './disk-adapter';
import { extractCodexSessionIdFromFilename } from './jsonl';
import { diskAdapters } from './registry';
import { OPENCODE_PART_DIR, getOpenCodeSessionMtime } from './registry';

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
        console.warn(
          `[discover] ${adapter.provider}: discoverFiles() failed: ${err instanceof Error ? err.message : err}`
        );
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
 * Does not accumulate results — each item is GC-eligible after its callback completes.
 *
 * Shared mutable state in `fn` (batchBuffer, counters) is safe because JS is
 * single-threaded: mutations between awaits run atomically.
 */
async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await fn(items[index]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
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
 * Files are sorted by mtime descending (most recent first). With CONCURRENCY > 1,
 * batch completion order is approximately but not strictly mtime-ordered — a slow-to-parse
 * recent file may land in a later batch than faster older files. This is fine because
 * the UI re-sorts by timestamp on every render (Gallery by createdAt, Sidebar by last message).
 *
 * @param onProgress - Optional callback invoked with batches of parsed conversations
 * @returns conversations + mtime index for subsequent polling
 */
export async function loadAllConversations(
  options: {
    onProgress?: LoadProgressCallback;
    limit?: number;
    offset?: number;
    concurrency?: number;
    batchSize?: number;
  } = {}
): Promise<LoadResult> {
  const {
    onProgress,
    limit,
    offset = 0,
    concurrency = 10,
    batchSize = 50,
  } = options;

  const normalizedConcurrency =
    Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 10;
  const normalizedBatchSize =
    Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : 50;
  const normalizedOffset =
    Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const normalizedLimit =
    typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : undefined;

  // Phase 1: Discover all files (sorted by mtime descending)
  const discoverStart = performance.now();
  console.log('Discovering persisted conversation files...');
  const files = await discoverAll(diskAdapters);
  const discoverTimeMs = performance.now() - discoverStart;

  const startIndex = Math.min(normalizedOffset, files.length);
  const endIndex = normalizedLimit ? Math.min(startIndex + normalizedLimit, files.length) : files.length;
  const filesToParse = files.slice(startIndex, endIndex);

  console.log(
    `Discovered ${files.length} persisted conversation sources in ${discoverTimeMs.toFixed(0)}ms (sorted by mtime), parsing ${filesToParse.length} with concurrency=${normalizedConcurrency}...`
  );

  // Phase 2: Parse files in parallel with batched progress callbacks.
  // When onProgress is provided, the caller handles placement (e.g. into the server's
  // conversations Map), so we skip building a redundant conversations Map here —
  // avoids doubling peak memory by holding two copies of every parsed conversation.
  const conversations = onProgress ? null : new Map<string, Conversation>();
  const mtimes = new Map<string, number>();

  // Add ALL discovered files to the mtimes map immediately, so file watcher tracks them
  // even if they are older and skipped during the initial parsing phase.
  for (const file of files) {
    if (file.mtimeMs > 0) {
      mtimes.set(file.filePath, file.mtimeMs);
    }
  }

  // Running accumulators for parse timing — avoids allocating a 1500-element array
  // just to compute summary stats that are immediately discarded after logging.
  let parseTimeMin = Number.POSITIVE_INFINITY,
    parseTimeMax = 0,
    parseTimeSum = 0,
    parseTimeCount = 0;
  let batchBuffer: Conversation[] = [];
  let filesProcessed = 0;
  let conversationCount = 0;

  const parseStart = performance.now();

  await forEachWithConcurrency(filesToParse, normalizedConcurrency, async (file) => {
    const result = await parseOneFile(file);

    const t = result.parseTimeMs;
    if (t < parseTimeMin) parseTimeMin = t;
    if (t > parseTimeMax) parseTimeMax = t;
    parseTimeSum += t;
    parseTimeCount++;

    if (result.conversation) {
      conversations?.set(result.conversation.id, result.conversation);
      batchBuffer.push(result.conversation);
      conversationCount++;
    }

    filesProcessed++;

    if (onProgress && batchBuffer.length >= normalizedBatchSize) {
      onProgress(batchBuffer, { loaded: filesProcessed, total: filesToParse.length });
      batchBuffer = [];
    }
  });

  // Emit any remaining conversations in the final batch
  if (onProgress && batchBuffer.length > 0) {
    onProgress(batchBuffer, { loaded: filesProcessed, total: filesToParse.length });
  }

  const parseTimeMs = performance.now() - parseStart;

  // Log timing summary
  if (parseTimeCount > 0) {
    const avg = parseTimeSum / parseTimeCount;
    console.log(
      `Parse timing (${parseTimeCount} files): min=${parseTimeMin.toFixed(1)}ms, avg=${avg.toFixed(1)}ms, max=${parseTimeMax.toFixed(1)}ms`
    );
  }

  const totalTimeMs = discoverTimeMs + parseTimeMs;
  console.log(
    `Loaded ${conversationCount} conversations from ${filesToParse.length} files in ${totalTimeMs.toFixed(0)}ms (discover: ${discoverTimeMs.toFixed(0)}ms, parse: ${parseTimeMs.toFixed(0)}ms)`
  );

  return { conversations: conversations ?? new Map(), mtimes };
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
  // Start fresh — only populate with currently-discovered files.
  // Any path absent from this poll's discovery is deleted on disk and falls out naturally,
  // preventing the map from accumulating dead paths forever.
  const mtimes = new Map<string, number>();

  for (const adapter of diskAdapters) {
    let paths: string[];
    try {
      paths = await adapter.discoverFiles();
    } catch (err) {
      console.warn(
        `[poll] ${adapter.provider}: discoverFiles() failed: ${err instanceof Error ? err.message : err}`
      );
      continue;
    }

    // For OpenCode, discoverFiles() already rebuilt the session metadata index
    // (stored on opencodeAdapter._sessionIndex). Reuse it instead of re-fetching.
    const openCodeSessionIndex: Map<string, string> | null =
      adapter.provider === 'opencode'
        ? ((adapter as typeof adapter & { _sessionIndex: Map<string, string> | null })
            ._sessionIndex ?? null)
        : null;

    for (const filePath of paths) {
      try {
        // Compute current mtime — for OpenCode sessions (directories) use
        // the composite mtime that covers message files + part subdirs.
        let currentMtime: number;
        if (adapter.provider === 'opencode') {
          const sessionId = path.basename(filePath);
          const metadataPath = openCodeSessionIndex?.get(sessionId);
          currentMtime = await getOpenCodeSessionMtime(filePath, OPENCODE_PART_DIR, metadataPath);
          if (currentMtime <= 0) continue;
        } else {
          const stat = await fs.promises.stat(filePath);
          currentMtime = stat.mtimeMs;
        }

        // Always record the current mtime for every discovered file.
        // This is how deleted files get pruned: if a file isn't discovered, it's never set.
        mtimes.set(filePath, currentMtime);

        const prevMtime = prevMtimes.get(filePath);

        // Skip if file mtime unchanged
        if (prevMtime !== undefined && currentMtime <= prevMtime) {
          continue;
        }

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
