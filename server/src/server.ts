import { type ChildProcess, execSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type {
  Conversation as ConversationData,
  Message,
  ModelId,
  OompaCycle,
  OompaReviewLog,
  OompaRuntimeSnapshot,
  OompaStarted,
  OompaStopped,
  OompaWorkerStatus,
  Provider as ProviderName,
  QueuedMessage,
  ServerMessage,
  SubAgent,
} from '@claude-web-view/shared';
import express, { type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { WebSocket, WebSocketServer } from 'ws';
import { loadAllConversations, pollForChanges } from './adapters/loader';
import { type Provider, ProviderParseError, getProvider, providers } from './providers';
import { isModelIdValidForProvider, modelValidationHint } from './providers/model-validation';

import multer from 'multer';

const VERBOSE = process.env.VERBOSE === '1' || process.argv.includes('--verbose');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Store active conversations
const conversations = new Map<string, Conversation>();

// Mtime index for JSONL file polling (filepath → mtime ms)
let fileMtimes = new Map<string, number>();

// Track conversations detected as running by an external process (not launched by us).
// Maps session ID → timestamp (ms) of last detected file activity.
// A session is marked running when its JSONL file changes between polls.
// Marked idle only after EXTERNAL_GRACE_MS with no file changes, to avoid
// flicker during gaps in Claude's output (thinking, API calls, tool use).
const externallyRunning = new Map<string, number>();
const EXTERNAL_GRACE_MS = 30_000; // 30s grace period before marking idle

// All sessionIds belonging to known conversations (including rotated ones from resetProcess).
// Prevents the file poller from importing an orphaned JSONL as a duplicate conversation.
const knownSessionIds = new Set<string>();

// Track initial load readiness. Resolved immediately at startup so WebSocket
// handlers can send init right away. Conversations stream in progressively
// via conversations_updated as batches are parsed from disk.
let initialLoadComplete: Promise<void>;
let resolveInitialLoad: () => void;
// Initialize the promise (resolved by startServer after loadExistingConversations)
initialLoadComplete = new Promise((resolve) => {
  resolveInitialLoad = resolve;
});

// =============================================================================
// Types for WebSocket Messages
// =============================================================================

interface ChunkData {
  type: 'chunk';
  conversationId: string;
  text: string;
}

interface MessageCompleteData {
  type: 'message_complete';
  conversationId: string;
}

interface MessageData {
  type: 'message';
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

type BroadcastData = ServerMessage | ChunkData | MessageCompleteData | MessageData;

// =============================================================================
// Helper Functions
// =============================================================================

interface SearchResult {
  conversationId: string;
  messageIndex: number;
  role: 'user' | 'assistant' | 'system';
  snippet: string;
  workingDirectory: string;
  timestampMs: number;
}

const SEARCH_SNIPPET_RADIUS = 60; // chars before/after match to show
const MIN_SEARCH_QUERY_LENGTH = 2;
const SEARCH_MAX_RESULTS = 50;
const SEARCH_HARD_RESULT_LIMIT = 200;

/**
 * Broadcast data to all connected WebSocket clients.
 * Serializes once and sends the same string to all — avoids redundant JSON.stringify
 * calls per client (matters during progressive load: 30 batches × N tabs).
 */
function broadcastToAll(data: BroadcastData): void {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-9;]*m/g, '');
}

function buildSearchSnippet(content: string, query: string): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerContent.indexOf(lowerQuery);
  if (matchIndex === -1) return content.substring(0, 120);

  const start = Math.max(0, matchIndex - SEARCH_SNIPPET_RADIUS);
  const end = Math.min(content.length, matchIndex + query.length + SEARCH_SNIPPET_RADIUS);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';
  return prefix + content.substring(start, end) + suffix;
}

function stderrSnippet(value: string, maxLength = 400): string {
  const cleaned = stripAnsi(value).replace(/\r/g, '\n').trim();
  if (!cleaned) return '';
  const tail = cleaned.slice(-1200).replace(/\s+/g, ' ').trim();
  if (!tail) return '';
  return tail.length > maxLength ? `${tail.slice(0, maxLength - 3)}...` : tail;
}

// =============================================================================
// Conversation Class
// =============================================================================

/**
 * id and sessionId start equal, but can diverge if resetProcess() is called
 * (loop engine with clearContext). sessionId is what the CLI uses for
 * --session-id/--resume and what JSONL files are named after.
 * knownSessionIds tracks all sessionIds (including rotated ones) so the
 * file poller doesn't import orphaned JSONL files as duplicates.
 */
// STATE MACHINE
// =============
// Server-side (authoritative):
//   isRunning   — process is alive (spawn → true, close → false)
//   queue[]     — server-owned FIFO (pending → sending → removed on close)
//
// Client-side (derived, NOT in this class):
//   confirmed   — server has confirmed this conversation exists
//   isStreaming  — assistant is producing content (message → true, message_complete → false)
//   isRunning    — mirrors server's isRunning via 'status' broadcasts (single source)
//
// Broadcast sequence on normal completion:
//   1. message_complete  → client stops streaming indicator
//   2. status:false      → client marks process done (from close handler)
//   3. queue_updated     → client mirrors updated queue
//   4. processQueue()    → server spawns next message if queued
//
// Kill paths (all lead to close handler):
//   stop_conversation WS → stop() → SIGTERM → close
//   delete_conversation WS → stop() + delete → close
//   resetProcess (loop) → kill → _isResetting skips close handler
//   SIGINT (Ctrl-C) → SIGKILL all children
class Conversation extends EventEmitter {
  id: string; // UI conversation ID (persists across resets)
  sessionId: string; // Provider CLI session ID (can be reset for fresh context)
  messages: Message[];
  process: ChildProcess | null;
  isRunning: boolean;
  // Server-authoritative: assistant is actively producing content.
  // INVARIANT: !isRunning → !isStreaming (enforced in close handler).
  isStreaming: boolean;
  createdAt: Date;
  workingDirectory: string;
  provider: ProviderName;
  model: ModelId | undefined; // Provider-specific model identifier (e.g. 'opus', 'gpt-5.3-codex-high')
  providerConfig: Provider | null;
  // Oompa worker detection — true if first user message started with "[oompa]".
  // Set during JSONL loading, preserved across restarts.
  isWorker: boolean;
  // Swarm grouping: shared across all workers in the same oompa run.
  swarmId: string | null;
  // Worker identity within a swarm (e.g., "w0", "claude-0").
  workerId: string | null;
  // Worker role within the swarm: "work" (task execution), "review" (code review), "fix" (fixing review feedback).
  workerRole: 'work' | 'review' | 'fix' | null;
  // Parent conversation id for provider-native spawned sub-agent threads.
  // For Codex this is resolved from thread_spawn.parent_thread_id.
  parentConversationId: string | null;
  // Full model name from CLI (e.g., "claude-sonnet-4-5-20250929") — more specific than provider.
  modelName: string | null;
  // Debug prefix for swarm conversations — prepended to first CLI message.
  // Stays on the object (never cleared) so toJSON() includes it for client rendering.
  swarmDebugPrefix: string | null;
  // Sub-agent tracking
  subAgents: SubAgent[];
  // Server-owned message queue — persists across client navigation/refresh.
  // Client mirrors this state via queue_updated broadcasts.
  queue: QueuedMessage[];
  // Track pending tool_use blocks that might be Task tools
  private _pendingTaskTools: Map<string, { id: string; startedAt: Date }>;
  // Track if we've started a CLI session (for --resume vs --session-id)
  private _hasStartedSession: boolean;
  // Buffer for incomplete JSON lines from stdout
  private _stdoutBuffer: string;
  // Buffer stderr for this process run so silent failures can be surfaced to UI.
  private _stderrBuffer: string;
  // Tracks whether we received provider JSON events for this process run.
  private _sawStdoutEventThisRun: boolean;
  // When true, close handler is a no-op — resetProcess() handles its own cleanup.
  // Prevents duplicate broadcasts and spurious dequeue during loop context resets.
  private _isResetting: boolean;
  // Start time of the current CLI process run (for duration tracking).
  private _processStartTime = 0;

  constructor(
    id: string,
    workingDirectory: string | null = null,
    provider: ProviderName = 'claude',
    /** Optional: set session ID when loading from JSONL (defaults to new UUID) */
    existingSessionId?: string,
    /** Optional: provider-specific model identifier (e.g. 'opus', 'gpt-5.3-codex-high') */
    model?: ModelId,
    /** Optional: true if this is an oompa worker conversation */
    isWorker = false,
    /** Optional: swarm ID from [oompa:<swarmId>:...] tag */
    swarmId: string | null = null,
    /** Optional: worker ID from [oompa:...:<workerId>] tag */
    workerId: string | null = null,
    /** Optional: worker role inferred from first message content */
    workerRole: 'work' | 'review' | 'fix' | null = null,
    /** Optional: parent conversation id for provider-native sub-agent sessions */
    parentConversationId: string | null = null,
    /** Optional: full model name from CLI */
    modelName: string | null = null,
    /** Optional: debug prefix for swarm conversations */
    swarmDebugPrefix: string | null = null
  ) {
    super();
    this.id = id;
    // sessionId defaults to id so JSONL filename matches Map key (no poller mismatch).
    // Only differs from id after resetProcess() rotates it for fresh CLI context.
    this.sessionId = existingSessionId ?? id;
    knownSessionIds.add(this.sessionId);
    this.messages = [];
    this.process = null;
    this.isRunning = false;
    this.isStreaming = false;
    this.createdAt = new Date();
    // Resolve to absolute path: sessions are identified by absolute path in oompa
    this.workingDirectory = path.resolve(workingDirectory || process.cwd());
    this.provider = provider;
    this.model = model;
    this.isWorker = isWorker;
    this.swarmId = swarmId;
    this.workerId = workerId;
    this.workerRole = workerRole;
    this.parentConversationId = parentConversationId;
    this.modelName = modelName;
    this.swarmDebugPrefix = swarmDebugPrefix;
    this.providerConfig = getProvider(provider);
    this.subAgents = [];
    this.queue = [];
    this._pendingTaskTools = new Map();
    // Mark session as started if loading existing (use --resume for next message)
    this._hasStartedSession = existingSessionId !== undefined;
    this._stdoutBuffer = '';
    this._stderrBuffer = '';
    this._sawStdoutEventThisRun = false;
    this._isResetting = false;
  }

  /**
   * Send a message by spawning a new CLI process.
   *
   * HYBRID SYNC STRATEGY:
   * 1. STDOUT (Live): Used for real-time UI interactivity ("typewriter" effect).
   *    CLI agents (Gemini, Codex) only write to disk after the process exits.
   *    Streaming stdout is mandatory to prevent the UI from appearing frozen.
   * 2. DISK (Persistence): Used for rehydration and history. The file poller
   *    ensures that sessions are preserved across server restarts and refreshes.
   *
   * Claude CLI requires stdin EOF to process input, so we spawn fresh for each message.
   * First message uses --session-id, subsequent messages use --resume.
   */
  private spawnForMessage(content: string): void {
    if (this.isRunning) {
      console.warn(`[${this.id}] Already processing a message, ignoring`);
      return;
    }

    const shouldResume = this._hasStartedSession;
    console.log(
      `[${this.id}] Spawning ${this.provider} (provider-session=${this.sessionId.substring(0, 8)}..., resume=${shouldResume})`
    );
    console.log(`[${this.id}] Message: "${content.substring(0, 50)}"`);

    // Reset stdout buffer for new process
    this._stdoutBuffer = '';
    this._stderrBuffer = '';
    this._sawStdoutEventThisRun = false;
    this._processStartTime = Date.now();

    // Use sessionId (not conversation id) for CLI session tracking
    const spawnConfig = this.providerConfig!.getSpawnConfig(
      this.sessionId,
      this.workingDirectory,
      shouldResume,
      this.model,
      content
    );
    // Detached: child gets own process group, survives server SIGTERM (hot-reload).
    // unref(): Node won't block exit waiting for this child.
    // Pipes work while server is alive. When server exits, pipes break:
    //   - Node.js CLIs (Claude): SIGPIPE is ignored by default → gets EPIPE on
    //     stdout writes, continues running, completes work, writes to JSONL.
    //   - Non-Node CLIs: may die from SIGPIPE. Current response would be truncated
    //     but whatever was written to JSONL is preserved.
    // In both cases, the file poller re-adopts via JSONL mtime detection on restart.
    this.process = spawn(spawnConfig.command, spawnConfig.args, {
      ...spawnConfig.options,
      detached: true,
    });
    this.process.unref();
    this.isRunning = true;
    this._hasStartedSession = true; // Mark session as started for next message
    this.broadcastStatus();

    this.process.stdout?.on('data', (data: Buffer) => {
      const rawOutput = data.toString();

      // Append to buffer - JSON may be split across multiple data events
      this._stdoutBuffer += rawOutput;

      // Split by newlines and process complete lines
      const lines = this._stdoutBuffer.split('\n');

      // Keep the last element in the buffer if it's incomplete (doesn't end with newline)
      // If buffer ends with newline, last element is empty string
      this._stdoutBuffer = lines.pop() || '';

      // Process complete lines
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this._sawStdoutEventThisRun = true;

        // Skip parsing if the provider doesn't output JSONL on stdout (e.g. Gemini).
        // Gemini reads from disk, so we can safely ignore its raw text stdout.
        if (spawnConfig.stdout !== 'jsonl') {
          continue;
        }

        try {
          const json = JSON.parse(trimmed) as unknown;
          const jsonType = (json as { type?: string }).type;
          const eventType = (json as { event?: { type?: string } }).event?.type;
          if (VERBOSE)
            console.log(
              `[${this.id}] RAW: type=${jsonType}${eventType ? `, event.type=${eventType}` : ''}`
            );

          // Codex emits thread.started with the real session ID (thread_id).
          // Capture it so subsequent messages use `codex exec resume <thread_id>`.
          if (jsonType === 'thread.started' && this.provider === 'codex') {
            const threadId = (json as { thread_id?: string }).thread_id;
            if (threadId) {
              console.log(`[${this.id}] Codex thread_id captured: ${threadId}`);
              this.sessionId = threadId;
              knownSessionIds.add(threadId);
            }
          }

          // OpenCode emits sessionID on every JSON event.
          // Capture it so subsequent messages can use `opencode run --session <id>`.
          if (this.provider === 'opencode') {
            const part = (json as { part?: unknown }).part;
            const partObj =
              typeof part === 'object' && part !== null ? (part as Record<string, unknown>) : null;
            const openCodeSessionId =
              (json as { sessionID?: unknown }).sessionID ??
              (json as { sessionId?: unknown }).sessionId ??
              (json as { session_id?: unknown }).session_id ??
              partObj?.sessionID ??
              partObj?.sessionId ??
              partObj?.session_id;
            if (typeof openCodeSessionId === 'string' && openCodeSessionId.length > 0) {
              if (this.sessionId !== openCodeSessionId) {
                console.log(`[${this.id}] OpenCode sessionID captured: ${openCodeSessionId}`);
              }
              this.sessionId = openCodeSessionId;
              knownSessionIds.add(openCodeSessionId);
            }
          }

          this.handleOutput(json);
        } catch (e) {
          if (e instanceof SyntaxError) {
            // This shouldn't happen now since we're buffering properly
            console.error(`[${this.provider}] Failed to parse JSON:`, trimmed.substring(0, 100));
          } else if (e instanceof ProviderParseError) {
            console.error(`[${this.provider}] Parse error:`, e.message);
          } else if (e instanceof Error) {
            console.error(`[${this.provider}] Error:`, e.message);
          }
        }
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      // Cap at 4KB — stderrSnippet only uses the last 1200 chars; unbounded growth
      // leaks memory for runaway processes that write megabytes to stderr.
      this._stderrBuffer = (this._stderrBuffer + chunk).slice(-4096);
      console.error(`[${this.id}] stderr:`, chunk);
    });

    // Handle spawn errors (ENOENT, EACCES, etc.) — without this handler,
    // a failed spawn leaves isRunning=true forever, blocking the queue.
    // The 'close' event still fires after 'error', so we just log here
    // and let the close handler do the state cleanup.
    this.process.on('error', (err: Error) => {
      console.error(`[${this.id}] Process spawn error: ${err.message}`);
      // Broadcast error to client so they see why the conversation died
      broadcastToAll({
        type: 'message',
        conversationId: this.id,
        role: 'system',
        content: `Process error: ${err.message}`,
      });
    });

    this.process.on('close', (code: number | null) => {
      const durationMs = Date.now() - this._processStartTime;
      console.log(`[${this.id}] Process closed with code ${code} after ${durationMs}ms`);

      // resetProcess() handles its own cleanup. If _isResetting, the kill was
      // intentional (loop context clear) and the loop engine will immediately
      // call sendMessage() and spawn the next iteration. Skip all cleanup here.
      if (this._isResetting) return;

      // Surface non-zero exit or silent zero-exit failures as system messages.
      if (code !== null && code !== 0) {
        const details = stderrSnippet(this._stderrBuffer);
        const errorMsg = details
          ? `Process exited with code ${code}: ${details}`
          : `Process exited with code ${code}`;
        console.error(`[${this.id}] ${errorMsg}`);
        this.messages.push({ role: 'system', content: errorMsg, timestamp: new Date() });
        broadcastToAll({
          type: 'message',
          conversationId: this.id,
          role: 'system',
          content: errorMsg,
        });
      } else if (code === 0 && !this._sawStdoutEventThisRun) {
        // Some providers (OpenCode) can fail with exit code 0 but write error to stderr.
        const details = stderrSnippet(this._stderrBuffer);
        if (details) {
          const content = `Provider reported an error without response output: ${details}`;
          this.messages.push({ role: 'system', content, timestamp: new Date() });
          broadcastToAll({
            type: 'message',
            conversationId: this.id,
            role: 'system',
            content,
          });
        }
      } else {
        // Successful completion - add a system message with duration
        const durationSec = (durationMs / 1000).toFixed(1);
        const successMsg = `Process completed successfully in ${durationSec}s`;
        this.messages.push({ role: 'system', content: successMsg, timestamp: new Date() });
        broadcastToAll({
          type: 'message',
          conversationId: this.id,
          role: 'system',
          content: successMsg,
        });
      }

      // INVARIANT: dead process can't stream. Clear both atomically.
      // This is the safety net for crash/kill/OOM — all paths that skip message_complete.
      this.isStreaming = false;
      this.isRunning = false;
      this.process = null;
      // Clear pending task tools — message_complete handles the normal path, but
      // kills/crashes skip it, leaving stale entries that accumulate across runs.
      this._pendingTaskTools.clear();
      this.broadcastStatus();
      // Dequeue the "sending" message (completed or crashed) and process next.
      // This is the SINGLE code path for dequeue — not split between
      // message_complete and close. Handles both success and crash.
      if (this.queue.length > 0 && this.queue[0].status === 'sending') {
        this.queue.shift();
        this.broadcastQueue();
      }
      // WS message ordering guarantees clients see status:false before the
      // next spawn's status:true. No delay needed.
      this.processQueue();
    });

    // Write message and close stdin ONLY if the provider expects it.
    // Claude expects prompt on stdin. Gemini/Codex take it via flags.
    if (spawnConfig.stdin === 'prompt') {
      console.log(`[${this.id}] Writing prompt to stdin and closing...`);
      this.process.stdin?.write(content + '\n');
      this.process.stdin?.end();
    } else {
      console.log(`[${this.id}] Closing stdin immediately (stdin mode: ${spawnConfig.stdin})`);
      this.process.stdin?.end();
    }
  }

  /**
   * Unified output handler - uses provider's parseOutput for abstraction
   * One clean path. parseOutput throws on unknown types.
   * @param json - Raw JSON from CLI stdout
   */
  handleOutput(json: unknown): void {
    if (!this.providerConfig) {
      throw new Error(`No provider config available for conversation ${this.id}`);
    }

    // parseOutput throws on unknown types - no fallbacks
    const event = this.providerConfig.parseOutput(json);

    switch (event.type) {
      case 'message_start':
        // Only create assistant message if we don't have one pending
        // The actual message creation happens when we get text content
        break;

      case 'text_delta': {
        this._sawStdoutEventThisRun = true;
        // BUG FIX: Must create assistant message BEFORE sending chunks
        // The client expects the last message to be role='assistant' when receiving chunks.
        // If we don't broadcast the assistant message first, chunks are silently ignored.
        const lastMsg = this.messages[this.messages.length - 1];
        if (!lastMsg || lastMsg.role !== 'assistant') {
          console.log(
            `[${this.id}] Creating NEW assistant message (msg #${this.messages.length + 1})`
          );
          const newMsg: Message = {
            role: 'assistant',
            content: '',
            timestamp: new Date(),
          };
          this.messages.push(newMsg);
          // Mark streaming BEFORE broadcasting the message, so the status
          // broadcast that follows carries isStreaming=true in the same tick.
          if (!this.isStreaming) {
            this.isStreaming = true;
            this.broadcastStatus();
          }
          // CRITICAL: Broadcast to client so it knows to create an assistant message
          this.broadcastMessage({
            type: 'message',
            role: 'assistant',
            content: '',
            conversationId: this.id,
          });
        }
        // Accumulate content server-side too (for debugging)
        const currentMsg = this.messages[this.messages.length - 1];
        if (currentMsg.role === 'assistant') {
          currentMsg.content += event.text;
        }
        // Now send the text chunk - client will append to the assistant message
        if (VERBOSE)
          console.log(
            `[${this.id}] chunk (${event.text.length} chars): "${event.text.substring(0, 30).replace(/\n/g, '\\n')}..."`
          );
        this.broadcastChunk({
          type: 'chunk',
          conversationId: this.id,
          text: event.text,
        });
        break;
      }

      case 'tool_use': {
        // Check if this is a Task tool (sub-agent spawn)
        if (event.name === 'Task') {
          // Extract description from input if available, otherwise use generic
          const description =
            (event.input as { description?: string }).description || 'Running sub-agent task...';
          const blockId = (event.input as { _blockId?: string })._blockId || uuidv4();

          // Create a new sub-agent
          const subAgent: SubAgent = {
            id: blockId,
            description,
            status: 'running',
            toolUses: 0,
            tokens: 0,
            currentAction: undefined,
            startedAt: new Date(),
          };

          this.subAgents.push(subAgent);
          this._pendingTaskTools.set(blockId, { id: blockId, startedAt: new Date() });

          console.log(
            `[${this.id}] Sub-agent started: ${blockId.substring(0, 8)} - "${description.substring(0, 50)}"`
          );

          // Broadcast sub-agent start
          broadcastToAll({
            type: 'subagent_start',
            conversationId: this.id,
            subAgent,
          });
        } else {
          // For non-Task tools, check if we have an active sub-agent and update its current action
          if (this.subAgents.length > 0) {
            const activeAgent = this.subAgents.find((a) => a.status === 'running');
            if (activeAgent) {
              // Format the current action based on tool name
              let actionDisplay = event.name;
              if (event.input) {
                // Extract file path if present
                const filePath =
                  (event.input as { file_path?: string; path?: string }).file_path ||
                  (event.input as { file_path?: string; path?: string }).path;
                if (filePath) {
                  // Show just the filename for brevity
                  const fileName = filePath.split('/').pop() || filePath;
                  actionDisplay = `${event.name}: ${fileName}`;
                }
              }

              activeAgent.toolUses += 1;
              activeAgent.currentAction = actionDisplay;

              // Broadcast sub-agent update
              broadcastToAll({
                type: 'subagent_update',
                conversationId: this.id,
                subAgentId: activeAgent.id,
                toolUses: activeAgent.toolUses,
                currentAction: activeAgent.currentAction,
              });
            }
          }

          // Broadcast tool usage info if displayText is provided
          if (event.displayText) {
            this.broadcastChunk({
              type: 'chunk',
              conversationId: this.id,
              text: event.displayText,
            });
          }
        }
        break;
      }

      case 'message_complete': {
        // Mark all running sub-agents as complete
        const completedAt = new Date();
        for (const agent of this.subAgents) {
          if (agent.status === 'running') {
            agent.status = 'completed';
            agent.completedAt = completedAt;
            agent.currentAction = 'Done';

            console.log(`[${this.id}] Sub-agent completed: ${agent.id.substring(0, 8)}`);

            // Broadcast sub-agent complete
            broadcastToAll({
              type: 'subagent_complete',
              conversationId: this.id,
              subAgentId: agent.id,
              status: 'completed',
              completedAt,
            });
          }
        }

        // Clear pending task tools
        this._pendingTaskTools.clear();

        // Broadcast message_complete BEFORE status(isStreaming=false).
        // Client's message_complete handler calls flushChunkBuffer() — the last
        // buffered text must be flushed before isStreaming=false triggers a re-render
        // that hides typing dots. Preserves the documented broadcast sequence.
        this.broadcastChunk({
          type: 'message_complete',
          conversationId: this.id,
        });

        this.isStreaming = false;
        this.broadcastStatus();

        break;
      }

      case 'error': {
        // Surface provider errors (usage limits, auth failures, turn errors)
        // to the client as a system message so the user sees what happened.
        console.error(`[${this.id}] Provider error: ${event.message}`);
        const errorMessage: Message = {
          role: 'system',
          content: event.message,
          timestamp: new Date(),
        };
        this.messages.push(errorMessage);
        broadcastToAll({
          type: 'message',
          conversationId: this.id,
          role: 'system',
          content: event.message,
        });
        break;
      }

      default:
        // TypeScript exhaustive check - this should never happen
        const _exhaustive: never = event;
        throw new Error(`Unhandled event type: ${JSON.stringify(_exhaustive)}`);
    }
  }

  sendMessage(content: string): void {
    console.log(`[${this.id}] sendMessage called, isRunning=${this.isRunning}`);

    if (this.isRunning) {
      console.warn(`[${this.id}] Already processing a message, ignoring`);
      return;
    }

    // Prepend swarm debug prefix on first message only.
    // UI sees clean content; CLI process gets the full context.
    let cliContent = content;
    if (this.swarmDebugPrefix !== null && this.messages.length === 0) {
      cliContent = this.swarmDebugPrefix + '\n\n' + content;
    }

    // Add user message to history (clean content for UI)
    const userMessage: Message = {
      role: 'user',
      content: content,
      timestamp: new Date(),
    };
    this.messages.push(userMessage);

    // Broadcast user message to clients (clean content)
    this.broadcastMessage({
      type: 'message',
      role: 'user',
      content: content,
      conversationId: this.id,
    });

    // Spawn CLI process with possibly-prefixed content
    this.spawnForMessage(cliContent);
  }

  stop(): void {
    if (!this.process) return;

    const proc = this.process;
    // CRITICAL: Don't set isRunning here. The 'close' handler does that.
    // This ensures atomicity: process exits → state updated → queue dequeued →
    // processQueue() spawns next. If we set state here, processQueue could fire
    // while the old process is still alive, and spawnForMessage's isRunning
    // guard would silently drop the queued message.
    proc.kill('SIGTERM');

    const killTimer = setTimeout(() => {
      if (proc.exitCode === null && !proc.killed) {
        console.warn(`[${this.id}] Process did not exit after SIGTERM, sending SIGKILL`);
        proc.kill('SIGKILL');
      }
    }, 3000);

    proc.once('close', () => clearTimeout(killTimer));
  }

  // Reset process for fresh context (used in loop with clearContext).
  // Generates new CLI session ID while keeping conversation ID for UI continuity.
  // Sets _isResetting so the close handler is a no-op — we handle cleanup here
  // because the loop engine immediately spawns the next iteration.
  resetProcess(): void {
    if (this.process) {
      this._isResetting = true;
      this.process.kill();
      this.process = null;
      this.isStreaming = false;
      this.isRunning = false;
      this.broadcastStatus();
      this._isResetting = false;
    }
    // Generate new session ID for fresh context
    const oldSessionId = this.sessionId;
    this.sessionId = uuidv4();
    knownSessionIds.add(this.sessionId);
    this._hasStartedSession = false;
    console.log(
      `[${this.id}] Reset session: ${oldSessionId.substring(0, 8)}... -> ${this.sessionId.substring(0, 8)}...`
    );
  }

  broadcastChunk(data: ChunkData | MessageCompleteData): void {
    broadcastToAll(data);
  }

  broadcastMessage(data: MessageData): void {
    broadcastToAll(data);
  }

  broadcastStatus(): void {
    broadcastToAll({
      type: 'status',
      conversationId: this.id,
      isRunning: this.isRunning,
      isStreaming: this.isStreaming,
    });
  }

  broadcastQueue(): void {
    broadcastToAll({
      type: 'queue_updated',
      conversationId: this.id,
      queue: this.queue,
    });
  }

  /**
   * Add a message to the queue. If the conversation is ready and idle,
   * process immediately. Otherwise it sits until the next status/ready change.
   */
  enqueueMessage(content: string): void {
    const msg: QueuedMessage = {
      id: crypto.randomUUID(),
      content,
      queuedAt: new Date(),
      status: 'pending',
    };
    this.queue.push(msg);
    console.log(`[${this.id}] Queued message: "${content.substring(0, 30)}"`);
    this.broadcastQueue();
    this.processQueue();
  }

  /**
   * Cancel a pending queued message by ID. Cannot cancel messages already sending.
   */
  cancelQueuedMessage(messageId: string): void {
    const idx = this.queue.findIndex((m) => m.id === messageId && m.status === 'pending');
    if (idx !== -1) {
      console.log(`[${this.id}] Cancelled queued message: ${messageId.substring(0, 8)}`);
      this.queue.splice(idx, 1);
      this.broadcastQueue();
    }
  }

  /**
   * Clear all pending messages from the queue. Messages currently sending are kept.
   */
  clearQueue(): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((m) => m.status === 'sending');
    console.log(`[${this.id}] Cleared queue: removed ${before - this.queue.length} messages`);
    this.broadcastQueue();
  }

  /**
   * Process the next queued message if the conversation is idle.
   * Called from: close handler (after process exits), enqueueMessage (new message).
   */
  processQueue(): void {
    if (this.isRunning) return;
    if (this.queue.length === 0) return;

    const next = this.queue[0];
    if (next.status === 'sending') return; // already in flight

    next.status = 'sending';
    this.broadcastQueue();
    this.sendMessage(next.content);
  }

  // Harness/provider can only be changed before the first turn has started.
  // Once a session has started, provider-specific state (session files, resume
  // IDs, and message history) is no longer safely interchangeable.
  canChangeProvider(): boolean {
    return (
      !this._hasStartedSession &&
      this.messages.length === 0 &&
      this.queue.length === 0 &&
      !this.isRunning &&
      !this.isStreaming
    );
  }

  toJSON(): ConversationData {
    return {
      id: this.id,
      messages: this.messages,
      isRunning: this.isRunning,
      isStreaming: this.isStreaming,
      confirmed: true,
      createdAt: this.createdAt,
      workingDirectory: this.workingDirectory,
      provider: this.provider,
      model: this.model,
      subAgents: this.subAgents,
      queue: this.queue,
      isWorker: this.isWorker,
      swarmId: this.swarmId,
      workerId: this.workerId,
      workerRole: this.workerRole,
      parentConversationId: this.parentConversationId,
      modelName: this.modelName,
      swarmDebugPrefix: this.swarmDebugPrefix,
    };
  }
}

// =============================================================================
// WebSocket Message Types
// =============================================================================

interface NewConversationData {
  type: 'new_conversation';
  id?: string; // Client-generated UUID for optimistic insert
  workingDirectory?: string;
  provider?: ProviderName;
  model?: ModelId; // Provider-specific model identifier (e.g. 'opus', 'gpt-5.3-codex-high')
  swarmDebugPrefix?: string; // Debug prefix prepended to first CLI message
}

interface SendMessageData {
  type: 'send_message';
  conversationId: string;
  content: string;
}

interface StopConversationData {
  type: 'stop_conversation';
  conversationId: string;
}

interface DeleteConversationData {
  type: 'delete_conversation';
  conversationId: string;
}

interface QueueMessageData {
  type: 'queue_message';
  conversationId: string;
  content: string;
}

interface CancelQueuedMessageData {
  type: 'cancel_queued_message';
  conversationId: string;
  messageId: string;
}

interface ClearQueueData {
  type: 'clear_queue';
  conversationId: string;
}

interface SetModelData {
  type: 'set_model';
  conversationId: string;
  model?: ModelId;
}

interface SetProviderData {
  type: 'set_provider';
  conversationId: string;
  provider: ProviderName;
}

type ClientMessageData =
  | NewConversationData
  | SendMessageData
  | StopConversationData
  | DeleteConversationData
  | SetProviderData
  | QueueMessageData
  | CancelQueuedMessageData
  | ClearQueueData
  | SetModelData;

// =============================================================================
// WebSocket Handler
// =============================================================================

wss.on('connection', (ws: WebSocket) => {
  console.log('New WebSocket connection');

  // Wait for initialLoadComplete (resolves immediately at startup).
  // Clients get init with whatever conversations are loaded so far — remaining
  // conversations stream in via conversations_updated as batches are parsed.
  // Late-connecting clients get more in init; early ones get progressive updates.
  (async () => {
    await initialLoadComplete;

    // Guard: client may have disconnected while we were waiting
    if (ws.readyState !== WebSocket.OPEN) return;

    // Send current state (include external running status for accurate initial render)
    ws.send(
      JSON.stringify({
        type: 'init',
        conversations: Array.from(conversations.values()).map((c) => {
          const json = c.toJSON();
          if (externallyRunning.has(c.id)) {
            json.isRunning = true;
          }
          return json;
        }),
        defaultCwd: process.cwd(),
      })
    );
  })();

  ws.on('message', (message: Buffer | string) => {
    try {
      const data = JSON.parse(message.toString()) as ClientMessageData;
      console.log(
        `[WS] Received message type: ${data.type}`,
        JSON.stringify(data).substring(0, 200)
      );

      switch (data.type) {
        case 'new_conversation': {
          // Use client-provided UUID if present (optimistic insert), otherwise generate one
          const id = data.id || uuidv4();
          // Expand ~ to home directory
          let workingDir = data.workingDirectory || process.cwd();
          if (workingDir.startsWith('~')) {
            workingDir = workingDir.replace(
              /^~/,
              process.env.HOME || process.env.USERPROFILE || ''
            );
          }
          // Resolve to absolute path and normalize: remove trailing slashes, resolve . and ..
          // so "/foo/bar/" and "/foo/bar" group as the same project
          workingDir = path.resolve(workingDir).replace(/\/+$/, '');
          const provider = data.provider || 'claude'; // Support 'claude', 'codex', or 'opencode'
          const model = data.model; // Provider-specific model (undefined = provider default)
          const swarmDebugPrefix = data.swarmDebugPrefix ?? null;

          // Validate provider against the registry — no manual list needed
          if (!(provider in providers)) {
            ws.send(
              JSON.stringify({
                type: 'error',
                message: `Invalid provider: ${provider}. Must be one of: ${Object.keys(providers).join(', ')}.`,
              })
            );
            return;
          }

          if (!isModelIdValidForProvider(provider, model)) {
            ws.send(
              JSON.stringify({
                type: 'error',
                message: `Invalid model '${model}' for provider '${provider}'. Expected ${modelValidationHint(provider)}.`,
              })
            );
            return;
          }

          // Validate directory exists and is accessible
          try {
            const stats = fs.statSync(workingDir);
            if (!stats.isDirectory()) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: 'Path is not a directory',
                })
              );
              return;
            }
          } catch (_err) {
            ws.send(
              JSON.stringify({
                type: 'error',
                message: `Directory not found: ${workingDir}`,
              })
            );
            return;
          }

          const conv = new Conversation(
            id,
            workingDir,
            provider,
            undefined,
            model,
            false,
            null,
            null,
            null,
            null,
            null,
            swarmDebugPrefix
          );
          conversations.set(id, conv);

          // No need to start - we spawn per message now

          ws.send(
            JSON.stringify({
              type: 'conversation_created',
              conversation: conv.toJSON(),
            })
          );
          break;
        }

        case 'send_message': {
          console.log(
            `[WS] send_message for ${data.conversationId}: "${data.content.substring(0, 50)}"`
          );
          const conversation = conversations.get(data.conversationId);
          if (conversation) {
            console.log(`[WS] Found conversation, calling sendMessage`);
            conversation.sendMessage(data.content);
          } else {
            console.error(`[WS] Conversation not found: ${data.conversationId}`);
            console.error(`[WS] Available conversations:`, Array.from(conversations.keys()));
          }
          break;
        }

        case 'stop_conversation': {
          const convToStop = conversations.get(data.conversationId);
          if (convToStop) {
            convToStop.stop();
          }
          break;
        }

        case 'delete_conversation': {
          const convToDelete = conversations.get(data.conversationId);
          if (convToDelete) {
            convToDelete.stop();
            conversations.delete(data.conversationId);
            // Evict session IDs so the orphan-detection guard doesn't accumulate forever
            knownSessionIds.delete(convToDelete.sessionId);
            knownSessionIds.delete(convToDelete.id);
            ws.send(
              JSON.stringify({
                type: 'conversation_deleted',
                conversationId: data.conversationId,
              })
            );
          }
          break;
        }

        case 'set_model': {
          const conv = conversations.get(data.conversationId);
          if (conv) {
            if (!isModelIdValidForProvider(conv.provider, data.model)) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: `Invalid model '${data.model}' for provider '${conv.provider}'. Expected ${modelValidationHint(conv.provider)}.`,
                })
              );
              return;
            }
            conv.model = data.model;
            console.log(
              `[WS] Model changed for ${data.conversationId}: ${data.model ?? 'default'}`
            );
            // Broadcast updated conversation
            ws.send(
              JSON.stringify({
                type: 'conversation_created',
                conversation: conv.toJSON(),
              })
            );
          }
          break;
        }

        case 'set_provider': {
          const conv = conversations.get(data.conversationId);
          if (conv) {
            if (!(data.provider in providers)) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: `Invalid provider: ${data.provider}. Must be one of: ${Object.keys(providers).join(', ')}.`,
                })
              );
              return;
            }

            if (!conv.canChangeProvider()) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: 'Harness can only be changed before the conversation starts.',
                })
              );
              return;
            }

            conv.provider = data.provider;
            conv.providerConfig = getProvider(data.provider);
            // Reset model when switching provider to avoid invalid cross-provider IDs.
            conv.model = undefined;
            conv.modelName = null;
            console.log(`[WS] Provider changed for ${data.conversationId}: ${data.provider}`);
            ws.send(
              JSON.stringify({
                type: 'conversation_created',
                conversation: conv.toJSON(),
              })
            );
          }
          break;
        }

        case 'queue_message': {
          const conv = conversations.get(data.conversationId);
          if (conv) {
            conv.enqueueMessage(data.content);
          }
          break;
        }

        case 'cancel_queued_message': {
          const conv = conversations.get(data.conversationId);
          if (conv) {
            conv.cancelQueuedMessage(data.messageId);
          }
          break;
        }

        case 'clear_queue': {
          const conv = conversations.get(data.conversationId);
          if (conv) {
            conv.clearQueue();
          }
          break;
        }
      }
    } catch (e) {
      console.error('Error handling WebSocket message:', e);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });
});

// =============================================================================
// Express Routes
// =============================================================================

// JSON body parser for API routes
app.use(express.json());

// File upload API — saves files to disk and returns absolute paths
// CLI agents (Claude, Codex) run on the same machine and can read these paths directly.
const UPLOADS_DIR = path.join(os.homedir(), '.agent-viewer', 'uploads');

const uploadStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const conversationId = req.body.conversationId as string;
    if (!conversationId) {
      cb(new Error('conversationId is required'), '');
      return;
    }
    const dir = path.join(UPLOADS_DIR, conversationId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${sanitized}`);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB per file
});

app.post('/api/upload', upload.array('files', 20), (req: Request, res: Response) => {
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    res.status(400).json({ error: 'No files provided' });
    return;
  }

  const result = files.map((f) => ({
    originalName: f.originalname,
    absolutePath: f.path,
    mimeType: f.mimetype,
    size: f.size,
  }));

  console.log(
    `[Upload] ${files.length} file(s) saved:`,
    result.map((r) => r.absolutePath)
  );
  res.json({ files: result });
});

// Settings API - stored in ~/.agent-viewer/settings.json
const SETTINGS_DIR = path.join(os.homedir(), '.agent-viewer');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

interface Settings {
  colorPalette: string;
}

const DEFAULT_SETTINGS: Settings = {
  colorPalette: 'solarized',
};

// =============================================================================
// Settings Cache — initialized once at startup, updated on POST
// =============================================================================

let settingsCache: Settings | null = null;

/**
 * Initialize settings cache from disk. Called once at startup.
 * Throws if the file exists but is malformed (fail eagerly).
 */
async function initSettingsCache(): Promise<void> {
  try {
    const data = await fs.promises.readFile(SETTINGS_FILE, 'utf-8');
    settingsCache = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
    console.log('Settings loaded from disk');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // File doesn't exist — use defaults
      settingsCache = { ...DEFAULT_SETTINGS };
      console.log('Settings file not found, using defaults');
    } else {
      throw new Error(`Failed to load settings: ${(e as Error).message}`);
    }
  }
}

/**
 * Get settings from cache. Throws if cache not initialized (programming error).
 */
function getSettings(): Settings {
  if (!settingsCache) {
    throw new Error('Settings cache not initialized — call initSettingsCache() at startup');
  }
  return settingsCache;
}

/**
 * Update settings cache and write to disk asynchronously.
 * Cache is updated immediately; disk write is fire-and-forget with error logging.
 */
function writeSettingsAsync(settings: Settings): void {
  settingsCache = settings;

  // Fire-and-forget disk write
  (async () => {
    try {
      await fs.promises.mkdir(SETTINGS_DIR, { recursive: true });
      await fs.promises.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (e) {
      console.error('Error saving settings to disk:', e);
    }
  })();
}

app.get('/api/settings', (_req: Request, res: Response) => {
  res.json(getSettings());
});

// Model list API — returns ModelInfo[] for the given provider.
// Used by the Sidebar model dropdown to show available models per provider.
app.get('/api/models', (req: Request, res: Response) => {
  const providerName = (req.query.provider as string) || 'claude';
  if (!(providerName in providers)) {
    res
      .status(400)
      .json({
        error: `Invalid provider: ${providerName}. Must be one of: ${Object.keys(providers).join(', ')}.`,
      });
    return;
  }
  const provider = getProvider(providerName as ProviderName);
  res.json(provider.listModels());
});

// Search across all messages.
// Used by SearchPalette to fetch message-level matches without loading every
// conversation into client state.
app.get('/api/search', (req: Request, res: Response) => {
  const rawQuery = req.query.q;
  const filterDirectory = (typeof req.query.filterDirectory === 'string' ? req.query.filterDirectory : '').trim();
  const rawLimit = Number(req.query.limit);

  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, SEARCH_HARD_RESULT_LIMIT)
      : SEARCH_MAX_RESULTS;

  if (typeof rawQuery !== 'string') {
    res.status(400).json({ error: 'q is required' });
    return;
  }

  const query = rawQuery.trim();
  if (query.length < MIN_SEARCH_QUERY_LENGTH) {
    res.json({ query, results: [] });
    return;
  }

  const lowerQuery = query.toLowerCase();
  const matches: SearchResult[] = [];

  for (const conversation of conversations.values()) {
    if (filterDirectory && !conversation.workingDirectory.startsWith(filterDirectory)) continue;

    for (let i = 0; i < conversation.messages.length; i++) {
      const message = conversation.messages[i];
      const content = message.content;

      if (!content.toLowerCase().includes(lowerQuery)) continue;

      matches.push({
        conversationId: conversation.id,
        messageIndex: i,
        role: message.role,
        snippet: buildSearchSnippet(content, query),
        workingDirectory: conversation.workingDirectory,
        timestampMs: new Date(message.timestamp).getTime(),
      });
    }
  }

  matches.sort((a, b) => b.timestampMs - a.timestampMs);
  const response = matches.slice(0, limit).map((match) => ({
    conversationId: match.conversationId,
    messageIndex: match.messageIndex,
    role: match.role,
    snippet: match.snippet,
    workingDirectory: match.workingDirectory,
    timestamp: new Date(match.timestampMs).toISOString(),
  }));

  res.json({ query, results: response });
});

// Path autocomplete API - returns directory listings for a given path
// Used by the PathAutocomplete component in the new conversation dialog
app.get('/api/paths', async (req: Request, res: Response) => {
  const inputPath = (req.query.path as string) || '';

  // Handle empty path - return home directory contents
  if (!inputPath) {
    try {
      const homeDir = os.homedir();
      const entries = await fs.promises.readdir(homeDir, { withFileTypes: true });
      const results = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .slice(0, 20)
        .map((entry) => ({
          name: entry.name,
          path: path.join(homeDir, entry.name),
          isDirectory: true,
        }));
      res.json(results);
    } catch {
      res.json([]);
    }
    return;
  }

  // Expand ~ to home directory
  let expandedPath = inputPath;
  if (expandedPath.startsWith('~')) {
    expandedPath = expandedPath.replace(/^~/, os.homedir());
  }

  // Normalize the path
  const normalizedPath = path.normalize(expandedPath);

  // Check if the path exists and is a directory
  try {
    const stats = await fs.promises.stat(normalizedPath);
    if (stats.isDirectory()) {
      // Path is a complete directory - list its contents
      const entries = await fs.promises.readdir(normalizedPath, { withFileTypes: true });
      const results = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .slice(0, 20)
        .map((entry) => ({
          name: entry.name,
          path: path.join(normalizedPath, entry.name),
          isDirectory: true,
        }));
      res.json(results);
      return;
    }
  } catch {
    // Path doesn't exist as-is, try parent directory with partial match
  }

  // Path might be partial - get parent directory and filter
  const parentDir = path.dirname(normalizedPath);
  const partial = path.basename(normalizedPath).toLowerCase();

  try {
    const stats = await fs.promises.stat(parentDir);
    if (stats.isDirectory()) {
      const entries = await fs.promises.readdir(parentDir, { withFileTypes: true });
      const results = entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.name.startsWith('.') &&
            entry.name.toLowerCase().startsWith(partial)
        )
        .slice(0, 20)
        .map((entry) => ({
          name: entry.name,
          path: path.join(parentDir, entry.name),
          isDirectory: true,
        }));
      res.json(results);
      return;
    }
  } catch {
    // Parent directory doesn't exist either
  }

  // Return empty array for invalid paths
  res.json([]);
});

// Validate if a path exists and is a directory (used by PathAutocomplete validation)
app.get('/api/validate-path', async (req: Request, res: Response) => {
  const inputPath = (req.query.path as string) || '';

  if (!inputPath) {
    res.json({ valid: false, error: 'Empty path' });
    return;
  }

  // Expand ~ to home directory
  let expandedPath = inputPath;
  if (expandedPath.startsWith('~')) {
    expandedPath = expandedPath.replace(/^~/, os.homedir());
  }

  const normalizedPath = path.normalize(expandedPath);

  try {
    const stats = await fs.promises.stat(normalizedPath);
    if (stats.isDirectory()) {
      res.json({ valid: true, path: normalizedPath });
    } else {
      res.json({ valid: false, error: 'Path is not a directory' });
    }
  } catch {
    res.json({ valid: false, error: 'Directory not found' });
  }
});

// Create a directory (used by PathAutocomplete's "Create folder" option)
app.post('/api/mkdir', express.json(), async (req: Request, res: Response) => {
  const dirPath = req.body?.path as string | undefined;
  if (!dirPath) {
    res.status(400).json({ error: 'Missing path' });
    return;
  }

  // Expand ~ to home directory
  let expandedPath = dirPath;
  if (expandedPath.startsWith('~')) {
    expandedPath = expandedPath.replace(/^~/, os.homedir());
  }

  const normalizedPath = path.normalize(expandedPath);

  try {
    await fs.promises.mkdir(normalizedPath, { recursive: true });
    res.json({ path: normalizedPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create directory';
    res.status(500).json({ error: message });
  }
});

// Serve local files over HTTP so the browser can display them
// (browsers block file:// links from http:// origins)
app.get('/api/files', (req: Request, res: Response) => {
  const filePath = req.query.path as string;
  if (!filePath || !filePath.startsWith('/')) {
    res.status(400).json({ error: 'Absolute path required' });
    return;
  }

  const resolved = path.resolve(filePath);
  if (resolved !== path.normalize(filePath)) {
    res.status(400).json({ error: 'Path traversal rejected' });
    return;
  }

  res.sendFile(resolved, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'File not found' });
    }
  });
});

// =============================================================================
// Swarm Dashboard APIs — git log, oompa config, and file reading for the
// /workers detail view. These are one-shot REST queries (not streaming).
//
// SECURITY: All endpoints restrict access to directories that are known to
// the server as conversation working directories. This prevents arbitrary
// filesystem access via crafted query parameters.
// =============================================================================

/** Check if a resolved path is within any known conversation directory. */
function isUnderKnownProject(resolved: string): boolean {
  for (const conv of conversations.values()) {
    if (resolved.startsWith(path.resolve(conv.workingDirectory))) return true;
  }
  return false;
}

type OompaRunDir = {
  id: string;
  path: string;
  mtimeMs: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readLatestRunDir(runsDir: string): OompaRunDir | null {
  try {
    const entries = fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const runPath = path.join(runsDir, entry.name);
        return {
          id: entry.name,
          path: runPath,
          mtimeMs: fs.statSync(runPath).mtimeMs,
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return entries[0] ?? null;
  } catch {
    return null;
  }
}

function isTerminalWorkerStatus(status: OompaWorkerStatus): boolean {
  return status === 'done' || status === 'error';
}

function normalizeStatus(rawStatus: unknown): OompaWorkerStatus {
  if (!rawStatus || typeof rawStatus !== 'string') return 'starting';
  const status = rawStatus.toLowerCase();
  if (status === 'done' || status === 'completed' || status === 'exhausted') return 'done';
  if (status === 'idle') return 'idle';
  if (status === 'error' || status === 'failed' || status === 'fatal') return 'error';
  if (
    status === 'working' ||
    status === 'running' ||
    status === 'merged' ||
    status === 'rejected' ||
    status === 'no-changes' ||
    status === 'executor-done' ||
    status === 'claimed' ||
    status === 'sync-failed' ||
    status === 'merge-failed' ||
    status === 'starting'
  ) {
    return status === 'starting' ? 'starting' : 'running';
  }
  return 'starting';
}

/**
 * Read all JSON files from a cycles/ (or iterations/) directory.
 * Returns parsed OompaCycle objects sorted by filename.
 * NOTE: Old runs may use 'iteration' instead of 'cycle' field — the OompaCycle
 * type uses 'cycle' (authoritative from schema). Callers must handle the legacy field.
 */
function readCycleFiles(dir: string): OompaCycle[] {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    return files
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as OompaCycle;
        } catch {
          return null;
        }
      })
      .filter((x): x is OompaCycle => x !== null);
  } catch {
    return [];
  }
}

/**
 * Check if a process is alive via signal 0 (doesn't kill, just tests).
 */
function isPidAlive(pidValue: string | undefined): boolean {
  if (!pidValue) return false;
  const pid = Number.parseInt(pidValue, 10);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the oompa orchestrator process is alive by reading meta files.
 * Returns true if any meta file's script_pid or bb_pid is alive.
 */
function isOompaProcessAlive(projectRoot: string): boolean {
  const logsDir = path.join(projectRoot, 'oompa', 'logs');
  try {
    const metaFiles = fs
      .readdirSync(logsDir)
      .filter((f) => /^run_.+\.meta$/.test(f))
      .map((f) => path.join(logsDir, f));

    for (const metaFile of metaFiles) {
      const content = fs.readFileSync(metaFile, 'utf-8');
      const meta: Record<string, string> = {};
      for (const line of content.split(/\r?\n/)) {
        if (!line) continue;
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      if (isPidAlive(meta.script_pid) || isPidAlive(meta.bb_pid)) {
        return true;
      }
    }
  } catch {
    // No oompa/logs directory — can't confirm liveness from PIDs
  }
  return false;
}

/**
 * Event-sourced runtime reader: scans started.json + stopped.json + cycles/
 * directory to derive swarm state. Uses PID from started.json for liveness.
 * Backward-compatible with old format (run.json + iterations/).
 */
function readLatestOompaRuntime(projectRoot: string): OompaRuntimeSnapshot {
  const runsDir = path.join(projectRoot, 'runs');
  if (!fs.existsSync(runsDir)) {
    return { available: false, run: null, reason: 'No runs directory found' };
  }

  const latestRun = readLatestRunDir(runsDir);
  if (!latestRun) {
    return { available: false, run: null, reason: 'No run directories found' };
  }

  let runCount = 0;
  try {
    runCount = fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).length;
  } catch {
    runCount = 0;
  }

  const runId = latestRun.id;

  // Read event files: started.json (new) or run.json (old backward compat)
  // Cast to OompaStarted — safeReadJson returns Record<string,unknown> but the
  // schema-generated type is authoritative. Old run.json has the same shape.
  const startedData = (safeReadJson(path.join(latestRun.path, 'started.json')) ??
    safeReadJson(path.join(latestRun.path, 'run.json')) ??
    {}) as Partial<OompaStarted>;
  const stoppedData = safeReadJson(
    path.join(latestRun.path, 'stopped.json')
  ) as OompaStopped | null;

  // Scan cycles/ (new) or iterations/ (old backward compat)
  const cyclesDir = path.join(latestRun.path, 'cycles');
  const iterationsDir = path.join(latestRun.path, 'iterations');
  const scanDir = fs.existsSync(cyclesDir)
    ? cyclesDir
    : fs.existsSync(iterationsDir)
      ? iterationsDir
      : null;

  const cycleFiles = scanDir ? readCycleFiles(scanDir) : [];

  // Worker IDs from started.json config
  const configuredWorkers: string[] = [];
  if (startedData.workers) {
    for (const w of startedData.workers) {
      if (w.id) configuredWorkers.push(w.id);
    }
  }

  // Latest cycle per worker (handles both 'cycle' and legacy 'iteration' field names)
  // NOTE: OompaCycle uses 'cycle' (schema-authoritative). Old runs may have 'iteration'
  // instead — we cast to OompaCycle but tolerate the legacy field via bracket access.
  const latestCycleByWorker = new Map<string, OompaCycle>();
  for (const cycle of cycleFiles) {
    const wid = cycle['worker-id'];
    if (!wid) continue;
    const existing = latestCycleByWorker.get(wid);
    // Legacy compat: old runs used 'iteration' field instead of 'cycle'
    // Legacy compat: old runs used 'iteration' instead of 'cycle'
    const cycleNum =
      cycle.cycle ??
      ((cycle as unknown as Record<string, unknown>)['iteration'] as number | undefined) ??
      0;
    const existingNum =
      existing?.cycle ??
      ((existing as unknown as Record<string, unknown>)?.['iteration'] as number | undefined) ??
      0;
    if (!existing || cycleNum > existingNum) {
      latestCycleByWorker.set(wid, cycle);
    }
  }

  // Union of all known worker IDs
  const workerIds = new Set<string>([...configuredWorkers, ...latestCycleByWorker.keys()]);
  const totalWorkers = Math.max(workerIds.size, configuredWorkers.length);

  // Liveness: stopped.json present = swarm finished.
  // Otherwise check PID from started.json, with isOompaProcessAlive() as fallback
  // for old runs that don't have PID in started.json.
  const swarmStopped = stoppedData !== null;
  const pid = startedData.pid;
  const pidAlive = !swarmStopped && typeof pid === 'number' && isPidAlive(String(pid));
  const fallbackAlive = !swarmStopped && !pidAlive && isOompaProcessAlive(projectRoot);
  const isLive = !swarmStopped && (pidAlive || fallbackAlive);
  const startedAtMs = Date.parse(String(startedData['started-at'] ?? ''));
  const liveNoCycleGraceMs = 60_000;

  // Build worker snapshots from cycle data
  const swarmId = startedData['swarm-id'] ?? runId;
  const configPath = startedData['config-file'] ?? null;

  const workerSnapshots = Array.from(workerIds).map((id) => {
    const cycle = latestCycleByWorker.get(id);
    let status: OompaWorkerStatus;

    if (cycle) {
      status = normalizeStatus(cycle.outcome);
    } else if (isLive) {
      // Avoid "eternal starting": once the swarm is live past a short grace period,
      // workers with no completed cycles yet should be shown as running.
      const noCycleShouldBeRunning =
        !Number.isFinite(startedAtMs) || Date.now() - startedAtMs > liveNoCycleGraceMs;
      status = noCycleShouldBeRunning ? 'running' : 'starting';
    } else {
      status = 'done';
    }

    // If swarm is not live (clean stop OR crashed without stopped.json),
    // force all non-terminal workers to done — their "running" status is stale.
    if (!isLive && status !== 'done' && status !== 'error') {
      status = 'done';
    }

    return {
      id,
      status,
      lastEvent: cycle
        ? `Cycle ${cycle.cycle ?? '?'}: ${cycle.outcome ?? 'unknown'}`
        : swarmStopped
          ? 'Worker completed'
          : isLive
            ? 'Starting'
            : 'No data',
    };
  });

  const states = workerSnapshots.sort((a, b) => a.id.localeCompare(b.id));
  const doneWorkers = states.filter((w) => isTerminalWorkerStatus(w.status)).length;
  const activeWorkers = states.filter((w) => !isTerminalWorkerStatus(w.status)).length;

  return {
    available: true,
    run: {
      runId,
      swarmId,
      isRunning: isLive && activeWorkers > 0,
      totalWorkers,
      activeWorkers,
      doneWorkers,
      configPath,
      logFile: null,
      workers: states,
      runCount,
    },
    reason: null,
  };
}

app.get('/api/git-log', (req: Request, res: Response) => {
  const dir = req.query.dir as string;
  if (!dir || !dir.startsWith('/')) {
    res.status(400).json({ error: 'Absolute directory path required' });
    return;
  }

  const resolved = path.resolve(dir);
  if (!isUnderKnownProject(resolved)) {
    res.status(403).json({ error: 'Directory not associated with any conversation' });
    return;
  }

  // Use tab delimiter — tabs never appear in commit messages, unlike |
  try {
    const raw = execSync('git log --oneline -20 --format="%H\t%s\t%aI\t%an"', {
      cwd: resolved,
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .toString()
      .trim();

    const entries = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\t');
        if (parts.length < 4) return { hash: parts[0] ?? '', message: line, date: '', author: '' };
        return { hash: parts[0], message: parts[1], date: parts[2], author: parts[3] };
      });

    res.json(entries);
  } catch {
    res.json([]);
  }
});

app.get('/api/oompa-config', (req: Request, res: Response) => {
  const dir = req.query.dir as string;
  if (!dir || !dir.startsWith('/')) {
    res.status(400).json({ error: 'Absolute directory path required' });
    return;
  }

  const resolved = path.resolve(dir);
  if (!isUnderKnownProject(resolved)) {
    res.status(403).json({ error: 'Directory not associated with any conversation' });
    return;
  }

  const configPath = path.join(resolved, 'oompa.json');
  if (!fs.existsSync(configPath)) {
    res.status(404).json({ error: 'No oompa.json found' });
    return;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    res.json(JSON.parse(content));
  } catch (e) {
    res.status(500).json({ error: `Failed to parse oompa.json: ${(e as Error).message}` });
  }
});

// =============================================================================
// Swarm Run Data API — serves structured run/review/summary JSON from
// runs/{swarm-id}/ written by oompa's agentnet.runs module.
// =============================================================================

/**
 * Synthesize a SwarmRunSummary from run.json (or started.json) worker configs + review files.
 *
 * Keep this synthesis path for compatibility with older runs or environments
 * where summary.json is missing; otherwise prefer live/final summary data from
 * runs/{swarm-id}/summary.json when available.
 * NOTE: New event-sourced runs use started.json instead of run.json.
 *
 * Verdict buckets:
 *   "approved"      → merges (iteration merged to main)
 *   "rejected"      → rejections (iteration permanently rejected)
 *   "needs-changes" → neither (iteration sent back for another round)
 */
async function synthesizeSummary(
  runDir: string,
  swarmId: string,
  run: OompaStarted
): Promise<Record<string, unknown>> {
  // Read cycle files — these are the primary source of truth for worker progress
  const cyclesDir = path.join(runDir, 'cycles');
  const iterationsDir = path.join(runDir, 'iterations');
  let cycleFileDir: string | null = null;
  try {
    await fs.promises.access(cyclesDir);
    cycleFileDir = cyclesDir;
  } catch {
    try {
      await fs.promises.access(iterationsDir);
      cycleFileDir = iterationsDir;
    } catch {
      // No cycle data at all
    }
  }

  // OompaCycle is the schema-authoritative type. Old runs may use 'iteration' instead of 'cycle'.
  const cyclesByWorker = new Map<string, OompaCycle[]>();

  if (cycleFileDir) {
    const cycleFileNames = (await fs.promises.readdir(cycleFileDir)).filter((f) =>
      f.endsWith('.json')
    );
    await Promise.all(
      cycleFileNames.map(async (cf) => {
        try {
          const content = await fs.promises.readFile(path.join(cycleFileDir!, cf), 'utf-8');
          const cycle = JSON.parse(content) as OompaCycle;
          const wid = cycle['worker-id'];
          if (!wid) return;
          if (!cyclesByWorker.has(wid)) cyclesByWorker.set(wid, []);
          cyclesByWorker.get(wid)!.push(cycle);
        } catch {
          // Skip malformed cycle files
        }
      })
    );
  }

  // Read review files
  const reviewsDir = path.join(runDir, 'reviews');
  let reviewFileNames: string[] = [];
  try {
    reviewFileNames = (await fs.promises.readdir(reviewsDir)).filter((f) => f.endsWith('.json'));
  } catch {
    // No reviews directory
  }

  const reviewsByWorker = new Map<string, OompaReviewLog[]>();

  await Promise.all(
    reviewFileNames.map(async (rf) => {
      try {
        const content = await fs.promises.readFile(path.join(reviewsDir, rf), 'utf-8');
        const review = JSON.parse(content) as OompaReviewLog;
        const wid = review['worker-id'];
        if (!wid) return;
        if (!reviewsByWorker.has(wid)) reviewsByWorker.set(wid, []);
        reviewsByWorker.get(wid)!.push(review);
      } catch {
        // Skip malformed review files
      }
    })
  );

  // Check liveness: stopped.json present = done, else check PID
  const stoppedFile = path.join(runDir, 'stopped.json');
  let isStopped = false;
  try {
    await fs.promises.access(stoppedFile);
    isStopped = true;
  } catch {
    // No stopped.json — check PID
  }

  let isLive = false;
  if (!isStopped) {
    const pid = run.pid;
    if (typeof pid === 'number') {
      isLive = isPidAlive(String(pid));
    }
  }
  const startedAtMs = Date.parse(String(run['started-at'] ?? ''));
  const liveNoCycleGraceMs = 60_000;

  const workers = (run.workers ?? []).map((w) => {
    const wid = w.id;
    const workerCycles = cyclesByWorker.get(wid) ?? [];
    const workerReviews = reviewsByWorker.get(wid) ?? [];

    // Count outcomes from cycle data
    let merges = 0;
    let rejections = 0;
    let errors = 0;
    let latestOutcome: OompaCycle['outcome'] | null = null;
    let latestCycleNum = 0;

    for (const c of workerCycles) {
      const num = c.cycle ?? 0;
      if (num > latestCycleNum) {
        latestCycleNum = num;
        latestOutcome = c.outcome;
      }
      if (c.outcome === 'merged') merges++;
      else if (c.outcome === 'rejected') rejections++;
      else if (c.outcome === 'error' || c.outcome === 'sync-failed' || c.outcome === 'merge-failed')
        errors++;
    }

    // Derive status from what we actually know — never fabricate
    let status: string;
    if (workerCycles.length === 0 && !isLive) {
      status = 'unknown'; // No data and not running — don't pretend we know
    } else if (workerCycles.length === 0 && isLive) {
      const noCycleShouldBeRunning =
        !Number.isFinite(startedAtMs) || Date.now() - startedAtMs > liveNoCycleGraceMs;
      status = noCycleShouldBeRunning ? 'running' : 'starting';
    } else if (latestOutcome === 'done' || latestOutcome === 'executor-done') {
      status = 'completed';
    } else if (latestOutcome === 'error') {
      status = 'error';
    } else if (isLive) {
      status = 'running';
    } else if (isStopped) {
      status = 'completed';
    } else {
      status = 'unknown'; // Not running, no stopped.json, ambiguous — say so
    }

    // needs-changes from reviews
    let needsChanges = 0;
    // OompaReviewLog uses 'cycle' (schema-authoritative), keyed per-cycle for last verdict
    const cycleVerdicts = new Map<number, OompaReviewLog['verdict']>();
    for (const r of workerReviews) {
      cycleVerdicts.set(r.cycle, r.verdict);
    }
    for (const verdict of cycleVerdicts.values()) {
      if (verdict === 'needs-changes') needsChanges++;
    }

    return {
      id: wid,
      harness: w.harness ?? 'default',
      model: w.model ?? 'unknown',
      status,
      completed: latestCycleNum,
      iterations: w.iterations ?? 0,
      merges,
      rejections,
      'needs-changes': needsChanges,
      errors,
      'review-rounds-total': workerReviews.length,
    };
  });

  // Timestamps: only report what we actually have
  let latestTimestamp = '';
  for (const cycles of cyclesByWorker.values()) {
    for (const c of cycles) {
      if (c.timestamp && c.timestamp > latestTimestamp) {
        latestTimestamp = c.timestamp;
      }
    }
  }
  for (const reviews of reviewsByWorker.values()) {
    for (const r of reviews) {
      if (r.timestamp && r.timestamp > latestTimestamp) {
        latestTimestamp = r.timestamp;
      }
    }
  }

  return {
    'swarm-id': swarmId,
    // Don't fabricate finished-at from started-at — null means "we don't know"
    'finished-at': isStopped ? latestTimestamp || null : isLive ? null : latestTimestamp || null,
    'total-workers': workers.length,
    'total-completed': workers.filter((w) => w.status === 'completed').length,
    'total-iterations': workers.reduce((s, w) => s + w.iterations, 0),
    'status-counts': {},
    workers,
  };
}

app.get('/api/swarm-runs', async (req: Request, res: Response) => {
  const dir = req.query.dir as string;
  if (!dir || !dir.startsWith('/')) {
    res.status(400).json({ error: 'Absolute directory path required' });
    return;
  }

  const resolved = path.resolve(dir);
  if (!isUnderKnownProject(resolved)) {
    res.status(403).json({ error: 'Directory not associated with any conversation' });
    return;
  }

  const runsDir = path.join(resolved, 'runs');
  try {
    await fs.promises.access(runsDir);
  } catch {
    res.json({ runs: [] });
    return;
  }

  const entries = await fs.promises.readdir(runsDir, { withFileTypes: true });
  const runs = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const runDir = path.join(runsDir, e.name);
        const startedFile = path.join(runDir, 'started.json');
        const runFile = path.join(runDir, 'run.json'); // backward compat
        const summaryFile = path.join(runDir, 'summary.json');

        let run: OompaStarted | null = null;
        let summary = null;

        // New format: started.json; old format: run.json (same shape = OompaStarted)
        try {
          run = JSON.parse(await fs.promises.readFile(startedFile, 'utf-8')) as OompaStarted;
        } catch {
          try {
            run = JSON.parse(await fs.promises.readFile(runFile, 'utf-8')) as OompaStarted;
          } catch {
            // No started.json or run.json — skip
          }
        }
        try {
          summary = JSON.parse(await fs.promises.readFile(summaryFile, 'utf-8'));
        } catch {
          // No summary.json — synthesize below
        }

        if (!summary && run) {
          summary = await synthesizeSummary(runDir, e.name, run);
        }

        return { swarmId: e.name, run, summary };
      })
  );

  runs.sort((a, b) => {
    const aTime = a.run?.['started-at'] ?? '';
    const bTime = b.run?.['started-at'] ?? '';
    return bTime.localeCompare(aTime);
  });

  res.json({ runs });
});

app.get('/api/swarm-runtime', (req: Request, res: Response) => {
  const dir = req.query.dir as string;
  if (!dir || !dir.startsWith('/')) {
    res.status(400).json({ error: 'Absolute directory path required' });
    return;
  }

  const resolved = path.resolve(dir);
  if (!isUnderKnownProject(resolved)) {
    res.status(403).json({ error: 'Directory not associated with any conversation' });
    return;
  }

  const snapshot = readLatestOompaRuntime(resolved);
  res.json(snapshot);
});

/**
 * Send stop (SIGTERM) or kill (SIGKILL) signal to a running oompa swarm.
 * - 'stop': graceful — workers finish current cycle then exit
 * - 'kill': immediate — SIGKILL bypasses shutdown hooks, so we write stopped.json
 */
app.post('/api/swarm-signal', (req: Request, res: Response) => {
  const { dir, signal, swarmId } = req.body as {
    dir?: string;
    signal?: 'stop' | 'kill';
    swarmId?: string;
  };

  if (!dir || !dir.startsWith('/')) {
    res.status(400).json({ ok: false, message: 'Absolute directory path required' });
    return;
  }
  if (signal !== 'stop' && signal !== 'kill') {
    res.status(400).json({ ok: false, message: 'signal must be "stop" or "kill"' });
    return;
  }

  const resolved = path.resolve(dir);
  if (!isUnderKnownProject(resolved)) {
    res.status(403).json({ ok: false, message: 'Directory not associated with any conversation' });
    return;
  }

  // Find the run directory
  const runsDir = path.join(resolved, 'runs');
  let runDir: string;
  if (swarmId) {
    // Prevent path traversal — swarmId must not escape runsDir
    const candidate = path.resolve(runsDir, swarmId);
    if (!candidate.startsWith(runsDir + path.sep)) {
      res.status(400).json({ ok: false, message: 'Invalid swarmId' });
      return;
    }
    runDir = candidate;
  } else {
    const latest = readLatestRunDir(runsDir);
    if (!latest) {
      res.status(404).json({ ok: false, message: 'No runs found' });
      return;
    }
    runDir = latest.path;
  }

  // Check if already stopped
  const stoppedPath = path.join(runDir, 'stopped.json');
  if (fs.existsSync(stoppedPath)) {
    res.json({ ok: false, message: 'Swarm already stopped' });
    return;
  }

  // Read PID from started.json
  const startedData = safeReadJson(path.join(runDir, 'started.json')) as Record<
    string,
    unknown
  > | null;
  const pid = startedData?.pid as number | undefined;
  if (!pid || !Number.isFinite(pid) || pid <= 0) {
    res.json({ ok: false, message: 'No valid PID found in started.json' });
    return;
  }

  // Check if PID is alive
  if (!isPidAlive(String(pid))) {
    // Stale PID — write stopped.json to clean up
    const stoppedEvent = {
      'swarm-id': startedData?.['swarm-id'] ?? 'unknown',
      'stopped-at': new Date().toISOString(),
      reason: 'interrupted',
      error: 'Process was not running (stale PID)',
    };
    fs.writeFileSync(stoppedPath, JSON.stringify(stoppedEvent, null, 2));
    res.json({ ok: true, message: 'Swarm was not running (stale PID). Marked as stopped.' });
    return;
  }

  // Send the signal
  try {
    if (signal === 'stop') {
      process.kill(pid, 'SIGTERM');
      res.json({
        ok: true,
        message: `SIGTERM sent to PID ${pid}. Workers will finish current cycle.`,
      });
    } else {
      process.kill(pid, 'SIGKILL');
      // SIGKILL bypasses shutdown hooks — write stopped.json ourselves
      const stoppedEvent = {
        'swarm-id': startedData?.['swarm-id'] ?? 'unknown',
        'stopped-at': new Date().toISOString(),
        reason: 'interrupted',
      };
      fs.writeFileSync(stoppedPath, JSON.stringify(stoppedEvent, null, 2));
      res.json({ ok: true, message: `SIGKILL sent to PID ${pid}. Swarm terminated.` });
    }
  } catch (err) {
    res.status(500).json({ ok: false, message: `Failed to send signal: ${err}` });
  }
});

app.get('/api/swarm-reviews', (req: Request, res: Response) => {
  const dir = req.query.dir as string;
  const swarmId = req.query.swarmId as string;
  if (!dir || !dir.startsWith('/') || !swarmId) {
    res.status(400).json({ error: 'dir (absolute path) and swarmId required' });
    return;
  }

  const resolved = path.resolve(dir);
  if (!isUnderKnownProject(resolved)) {
    res.status(403).json({ error: 'Directory not associated with any conversation' });
    return;
  }

  const reviewsDir = path.join(resolved, 'runs', swarmId, 'reviews');
  if (!fs.existsSync(reviewsDir)) {
    res.json({ reviews: [] });
    return;
  }

  const files = fs
    .readdirSync(reviewsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const reviews: OompaReviewLog[] = files.map((f) => {
    const content = fs.readFileSync(path.join(reviewsDir, f), 'utf-8');
    return JSON.parse(content) as OompaReviewLog;
  });

  res.json({ reviews });
});

app.get('/api/read-file', (req: Request, res: Response) => {
  const filePath = req.query.path as string;
  if (!filePath || !filePath.startsWith('/')) {
    res.status(400).json({ error: 'Absolute path required' });
    return;
  }

  const resolved = path.resolve(filePath);
  if (!isUnderKnownProject(resolved)) {
    res.status(403).json({ error: 'Path not under any known project directory' });
    return;
  }

  if (!fs.existsSync(resolved)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  res.json({ content });
});

app.post('/api/settings', (req: Request, res: Response) => {
  const settings = { ...getSettings(), ...req.body };
  writeSettingsAsync(settings);
  res.json(settings);
});

// =============================================================================
// Custom Palette API — AI-generated color palettes stored as plain .json files
// Palettes are saved in ~/.agent-viewer/palettes/palette_{N}.json
// Each file stores a Palette16 (14 color keys + name + description).
//
// Palette16 keys: base03, base02, base01, base00, base0, base1,
//                 yellow, orange, red, magenta, violet, blue, cyan, green
// =============================================================================

const PALETTES_DIR = path.join(os.homedir(), '.agent-viewer', 'palettes');

/** The 14 color keys that make up a Palette16 (excluding 'name') */
const PALETTE16_KEYS = [
  'base03',
  'base02',
  'base01',
  'base00',
  'base0',
  'base1',
  'yellow',
  'orange',
  'red',
  'magenta',
  'violet',
  'blue',
  'cyan',
  'green',
] as const;

/** Shape stored on disk — Palette16 values plus description for provenance */
interface StoredPalette {
  name: string;
  description: string;
  base03: string;
  base02: string;
  base01: string;
  base00: string;
  base0: string;
  base1: string;
  yellow: string;
  orange: string;
  red: string;
  magenta: string;
  violet: string;
  blue: string;
  cyan: string;
  green: string;
}

// =============================================================================
// Palette Cache — initialized once at startup, updated on generate
// =============================================================================

/** In-memory cache of custom palettes (keyed by "custom_N") */
let paletteCache: Record<string, Record<string, string>> = {};
/** Next available palette number (incremented after each generation) */
let nextPaletteNumber = 1;

/**
 * Initialize palette cache from disk. Called once at startup.
 * Reads all palette_N.json files and builds the cache.
 */
async function initPaletteCache(): Promise<void> {
  paletteCache = {};
  nextPaletteNumber = 1;

  try {
    const entries = await fs.promises.readdir(PALETTES_DIR, { withFileTypes: true });

    // Parse all palette files in parallel
    const parsePromises = entries
      .filter((entry) => entry.isFile() && /^palette_\d+\.json$/.test(entry.name))
      .map(async (entry) => {
        const match = entry.name.match(/^palette_(\d+)\.json$/);
        if (!match) return null;

        const n = Number.parseInt(match[1], 10);
        const filePath = path.join(PALETTES_DIR, entry.name);

        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const stored = JSON.parse(content) as StoredPalette;
          const palette: Record<string, string> = { name: stored.name };
          for (const key of PALETTE16_KEYS) {
            palette[key] = stored[key];
          }
          return { key: `custom_${n}`, palette, n };
        } catch (e) {
          console.error(`Failed to parse palette file ${entry.name}:`, e);
          return null;
        }
      });

    const results = await Promise.all(parsePromises);

    for (const result of results) {
      if (result) {
        paletteCache[result.key] = result.palette;
        if (result.n >= nextPaletteNumber) {
          nextPaletteNumber = result.n + 1;
        }
      }
    }

    console.log(
      `Palette cache initialized: ${Object.keys(paletteCache).length} palettes, next number: ${nextPaletteNumber}`
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Directory doesn't exist — no palettes yet
      console.log('Palettes directory not found, starting with empty cache');
    } else {
      throw new Error(`Failed to initialize palette cache: ${(e as Error).message}`);
    }
  }
}

// GET /api/custom-palettes — returns Record<string, Palette16> of saved custom palettes
// Each entry has { name, base03, base02, ..., green } matching the Palette16 interface.
// Reads from in-memory cache (zero I/O).
app.get('/api/custom-palettes', (_req: Request, res: Response) => {
  res.json(paletteCache);
});

// POST /api/generate-palette — spawn an agent in single-shot mode to generate a palette
// Uses provider.getSingleShotConfig() so any provider (claude, codex) can be used.
// Query param ?provider=codex to use a different agent (defaults to 'claude').
app.post('/api/generate-palette', (req: Request, res: Response) => {
  const { description } = req.body as { description?: string };
  if (!description || typeof description !== 'string' || description.trim().length === 0) {
    res.status(400).json({ error: 'description is required' });
    return;
  }

  // Allow choosing which agent generates the palette (default: claude)
  const providerName = (req.query.provider as string) || 'claude';
  const provider = getProvider(providerName as ProviderName);

  // 4 example palettes from our library so the AI understands the color system
  const examplePalettes = `
Here are 4 example palettes from our library for reference:

Solarized Dark:
{"name":"Solarized Dark","base03":"#002b36","base02":"#073642","base01":"#586e75","base00":"#657b83","base0":"#839496","base1":"#93a1a1","yellow":"#b58900","orange":"#cb4b16","red":"#dc322f","magenta":"#d33682","violet":"#6c71c4","blue":"#268bd2","cyan":"#2aa198","green":"#859900"}

Nord:
{"name":"Nord","base03":"#2e3440","base02":"#3b4252","base01":"#4c566a","base00":"#d8dee9","base0":"#e5e9f0","base1":"#eceff4","yellow":"#ebcb8b","orange":"#d08770","red":"#bf616a","magenta":"#b48ead","violet":"#5e81ac","blue":"#81a1c1","cyan":"#88c0d0","green":"#a3be8c"}

Tokyo Night:
{"name":"Tokyo Night","base03":"#1a1b26","base02":"#24283b","base01":"#414868","base00":"#565f89","base0":"#a9b1d6","base1":"#c0caf5","yellow":"#e0af68","orange":"#ff9e64","red":"#f7768e","magenta":"#bb9af7","violet":"#7aa2f7","blue":"#7dcfff","cyan":"#7dcfff","green":"#9ece6a"}

Catppuccin Mocha:
{"name":"Catppuccin Mocha","base03":"#1e1e2e","base02":"#313244","base01":"#45475a","base00":"#6c7086","base0":"#cdd6f4","base1":"#bac2de","yellow":"#f9e2af","orange":"#fab387","red":"#f38ba8","magenta":"#cba6f7","violet":"#89b4fa","blue":"#89dceb","cyan":"#94e2d5","green":"#a6e3a1"}`;

  const prompt = `Design a 16-token color palette for a dark-themed code editor UI based on this description: "${description.trim()}"
${examplePalettes}

You MUST respond with ONLY a JSON object (no markdown, no explanation) with exactly these 15 keys:
{
  "name": "Palette Name",
  "base03": "#hex",
  "base02": "#hex",
  "base01": "#hex",
  "base00": "#hex",
  "base0": "#hex",
  "base1": "#hex",
  "yellow": "#hex",
  "orange": "#hex",
  "red": "#hex",
  "magenta": "#hex",
  "violet": "#hex",
  "blue": "#hex",
  "cyan": "#hex",
  "green": "#hex"
}

Requirements:
- All values must be valid #RRGGBB hex strings.
- base03 must be the darkest (the main background). base02 slightly lighter (surface/card bg).
- base01 = muted/comment text. base00 = secondary text. base0 = primary body text. base1 = emphasis text.
- Monotonic luminance: base03 (darkest) < base02 < base01 < base00 < base0 <= base1 (lightest).
- The 8 accent colors (yellow, orange, red, magenta, violet, blue, cyan, green) should be visually distinct.
- Accent colors should have good contrast (WCAG AA, >= 4.5:1) against the base03 background.
- Prefer perceptually uniform accent lightness (all accents roughly equal perceived brightness).
- base03 should be very dark (suitable for long coding sessions).`;

  // Use cached counter instead of scanning filesystem
  const n = nextPaletteNumber;
  nextPaletteNumber++;

  // Use the provider's single-shot config instead of hardcoding spawn args
  const spawnConfig = provider.getSingleShotConfig(prompt);
  console.log(
    `[generate-palette] Spawning ${providerName}: ${spawnConfig.command} ${spawnConfig.args.map((a) => (a.length > 80 ? a.slice(0, 80) + '...' : a)).join(' ')}`
  );
  const agentProcess = spawn(spawnConfig.command, spawnConfig.args, spawnConfig.options);

  let stdout = '';
  let stderr = '';
  let responded = false;

  // Guard: only send one HTTP response per request
  const sendError = (status: number, error: string) => {
    if (responded) return;
    responded = true;
    console.error(`[generate-palette] Error: ${error}`);
    res.status(status).json({ error });
  };

  // Timeout: kill the process if it takes longer than 90 seconds
  const TIMEOUT_MS = 90_000;
  const timeout = setTimeout(() => {
    console.error(`[generate-palette] Timed out after ${TIMEOUT_MS / 1000}s — killing process`);
    agentProcess.kill('SIGTERM');
    sendError(504, `Palette generation timed out after ${TIMEOUT_MS / 1000}s`);
  }, TIMEOUT_MS);

  // Handle spawn errors (e.g. command not found, ENOENT)
  agentProcess.on('error', (err: Error) => {
    clearTimeout(timeout);
    sendError(500, `Failed to spawn ${providerName}: ${err.message}`);
  });

  agentProcess.stdout?.on('data', (data: Buffer) => {
    stdout += data.toString();
  });

  agentProcess.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  agentProcess.on('close', (code: number | null) => {
    clearTimeout(timeout);

    if (code !== 0) {
      sendError(
        500,
        `${providerName} process failed (exit code ${code})${stderr ? `: ${stderr.slice(0, 500)}` : ''}`
      );
      return;
    }

    let parsed: Record<string, string>;
    try {
      const trimmed = stdout.trim();
      // Strip markdown fences if the agent added them despite instructions
      const jsonStr = trimmed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```$/, '');
      parsed = JSON.parse(jsonStr) as Record<string, string>;
      if (!parsed.name) {
        throw new Error('Missing "name" field');
      }
      // Validate all 14 palette keys are present and are valid hex
      for (const key of PALETTE16_KEYS) {
        if (!parsed[key] || !/^#[0-9a-fA-F]{6}$/.test(parsed[key])) {
          throw new Error(`Missing or invalid hex for key "${key}": ${parsed[key]}`);
        }
      }
    } catch (parseErr) {
      console.error(`[generate-palette] Raw stdout (first 500 chars):`, stdout.substring(0, 500));
      const msg = parseErr instanceof Error ? parseErr.message : 'Unknown parse error';
      sendError(500, `Failed to parse palette from ${providerName} response: ${msg}`);
      return;
    }

    // Build StoredPalette (Palette16 + description for provenance)
    const stored: StoredPalette = {
      name: parsed.name,
      description: description.trim(),
      base03: parsed.base03,
      base02: parsed.base02,
      base01: parsed.base01,
      base00: parsed.base00,
      base0: parsed.base0,
      base1: parsed.base1,
      yellow: parsed.yellow,
      orange: parsed.orange,
      red: parsed.red,
      magenta: parsed.magenta,
      violet: parsed.violet,
      blue: parsed.blue,
      cyan: parsed.cyan,
      green: parsed.green,
    };

    // Build Palette16 shape for client and cache
    const key = `custom_${n}`;
    const palette: Record<string, string> = { name: parsed.name };
    for (const k of PALETTE16_KEYS) {
      palette[k] = parsed[k];
    }

    // Update cache immediately
    paletteCache[key] = palette;

    // Fire-and-forget disk write (error logged but doesn't fail the request)
    (async () => {
      try {
        await fs.promises.mkdir(PALETTES_DIR, { recursive: true });
        const filePath = path.join(PALETTES_DIR, `palette_${n}.json`);
        await fs.promises.writeFile(filePath, JSON.stringify(stored, null, 2));
        console.log(`[generate-palette] Saved palette to ${filePath}`);
      } catch (writeErr) {
        console.error(`[generate-palette] Failed to save palette file:`, writeErr);
      }
    })();

    // Return Palette16 shape to client
    if (responded) return; // timeout already fired
    responded = true;
    console.log(`[generate-palette] Success: "${parsed.name}" -> ${key}`);
    res.json({ key, palette });
  });
});

// =============================================================================
// GET /api/usage — Aggregate token usage from Claude + Codex + OpenCode sessions.
//
// Reads persisted files on disk, sums token counts, and computes approximate cost.
// Claude: ~/.claude/projects/**/*.jsonl → assistant entries with message.usage
// Codex:  ~/.codex/sessions/**/*.jsonl  → event_msg with payload.type=token_count
// OpenCode: ~/.local/share/opencode/storage/message/{session-id}/*.json
//
// Query params:
//   ?days=N  — only include sessions from the last N days (default: 30)
// =============================================================================

interface UsageEntry {
  sessionId: string;
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  date: string; // YYYY-MM-DD
}

// Approximate pricing per 1M tokens (as of early 2026).
// Claude: input $3, output $15, cache read $0.30, cache write $3.75
// Codex: input $2.50, output $10
function estimateCost(
  provider: ProviderName,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number
): number {
  if (provider === 'claude') {
    return (input * 3 + output * 15 + cacheRead * 0.3 + cacheWrite * 3.75) / 1_000_000;
  }
  // Codex/OpenAI and OpenCode (provider-backed model pricing can vary by backend).
  // Gemini mirrors Codex-like pricing here until token billing data is emitted per-provider.
  return (input * 2.5 + output * 10) / 1_000_000;
}

// Per-session cached usage data so we don't re-read unchanged files.
// Maps filePath → { mtimeMs, data }. Survives across requests.
const usageFileCache = new Map<
  string,
  { mtimeMs: number; data: UsageEntry & { timestampedTokens: { ts: number; tokens: number }[] } }
>();
const openCodeUsageCache = new Map<
  string,
  { mtimeMs: number; data: UsageEntry & { lastTimestampMs: number } }
>();

// Full response cache — avoids re-aggregating when nothing changed.
// Key is `days` param. Invalidated after USAGE_CACHE_TTL_MS.
interface RateLimit {
  label: string;
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number | null;
  tokenCount?: number;
}
interface UsageResponse {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSessions: number;
  days: number;
  daily: {
    date: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    sessions: number;
  }[];
  topSessions: UsageEntry[];
  rateLimits: Record<ProviderName, RateLimit[]>;
}
const usageResponseCache = new Map<number, { time: number; data: UsageResponse }>();
const USAGE_CACHE_TTL_MS = 60_000; // 60s

// Parse a single Claude JSONL file. Returns cached result if mtime unchanged.
function parseClaudeSession(
  filePath: string,
  stat: fs.Stats
): UsageEntry & { timestampedTokens: { ts: number; tokens: number }[] } {
  const cached = usageFileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;

  const sessionId = path.basename(filePath, '.jsonl');
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let model = 'unknown';
  const timestampedTokens: { ts: number; tokens: number }[] = [];

  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'assistant' && entry.message?.usage) {
        const u = entry.message.usage;
        const inTok = u.input_tokens ?? 0;
        const outTok = u.output_tokens ?? 0;
        inputTokens += inTok;
        outputTokens += outTok;
        cacheRead += u.cache_read_input_tokens ?? 0;
        cacheWrite += u.cache_creation_input_tokens ?? 0;
        if (entry.message.model && model === 'unknown') {
          model = entry.message.model;
        }
        if (entry.timestamp) {
          timestampedTokens.push({
            ts: new Date(entry.timestamp).getTime(),
            tokens: inTok + outTok,
          });
        }
      }
    } catch {
      /* skip malformed lines */
    }
  }

  const date = stat.mtime.toISOString().slice(0, 10);
  const data: UsageEntry & { timestampedTokens: { ts: number; tokens: number }[] } = {
    sessionId,
    provider: 'claude',
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    costUsd: estimateCost('claude', inputTokens, outputTokens, cacheRead, cacheWrite),
    date,
    timestampedTokens,
  };
  usageFileCache.set(filePath, { mtimeMs: stat.mtimeMs, data });
  return data;
}

function parseOpenCodeSessionUsage(
  sessionDirPath: string
): (UsageEntry & { lastTimestampMs: number }) | null {
  const messageFiles = fs.readdirSync(sessionDirPath).filter((f) => f.endsWith('.json'));
  if (messageFiles.length === 0) {
    return null;
  }

  let maxMtimeMs = 0;
  for (const file of messageFiles) {
    try {
      const stat = fs.statSync(path.join(sessionDirPath, file));
      if (stat.mtimeMs > maxMtimeMs) {
        maxMtimeMs = stat.mtimeMs;
      }
    } catch {
      // File may disappear between readdir and stat/read.
    }
  }

  const cached = openCodeUsageCache.get(sessionDirPath);
  if (cached && cached.mtimeMs === maxMtimeMs) {
    return cached.data;
  }

  const sessionId = path.basename(sessionDirPath);
  let model = 'unknown';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let lastTimestampMs = 0;
  let hasUsage = false;

  for (const file of messageFiles) {
    const filePath = path.join(sessionDirPath, file);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (parsed?.role !== 'assistant') {
        continue;
      }

      const inTok = typeof parsed?.tokens?.input === 'number' ? parsed.tokens.input : 0;
      const outTok = typeof parsed?.tokens?.output === 'number' ? parsed.tokens.output : 0;
      const cacheRead =
        typeof parsed?.tokens?.cache?.read === 'number' ? parsed.tokens.cache.read : 0;
      const cacheWrite =
        typeof parsed?.tokens?.cache?.write === 'number' ? parsed.tokens.cache.write : 0;
      const messageCost = typeof parsed?.cost === 'number' ? parsed.cost : 0;

      inputTokens += inTok;
      outputTokens += outTok;
      cacheReadTokens += cacheRead;
      cacheWriteTokens += cacheWrite;
      costUsd += messageCost;

      if (inTok + outTok + cacheRead + cacheWrite > 0 || messageCost > 0) {
        hasUsage = true;
      }

      const providerID = typeof parsed?.providerID === 'string' ? parsed.providerID : null;
      const modelID = typeof parsed?.modelID === 'string' ? parsed.modelID : null;
      if (model === 'unknown') {
        if (providerID && modelID) model = `${providerID}/${modelID}`;
        else if (modelID) model = modelID;
        else if (providerID) model = providerID;
      }

      const completedTs = typeof parsed?.time?.completed === 'number' ? parsed.time.completed : 0;
      const createdTs = typeof parsed?.time?.created === 'number' ? parsed.time.created : 0;
      const ts = Math.max(completedTs, createdTs);
      if (ts > lastTimestampMs) {
        lastTimestampMs = ts;
      }
    } catch {
      // Skip malformed/unreadable message file.
    }
  }

  if (!hasUsage) {
    return null;
  }

  if (costUsd === 0) {
    costUsd = estimateCost(
      'opencode',
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens
    );
  }

  const fallbackTs = maxMtimeMs > 0 ? maxMtimeMs : Date.now();
  const date = new Date(lastTimestampMs > 0 ? lastTimestampMs : fallbackTs)
    .toISOString()
    .slice(0, 10);

  const data: UsageEntry & { lastTimestampMs: number } = {
    sessionId,
    provider: 'opencode',
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    date,
    lastTimestampMs: lastTimestampMs > 0 ? lastTimestampMs : fallbackTs,
  };

  openCodeUsageCache.set(sessionDirPath, { mtimeMs: maxMtimeMs, data });
  return data;
}

app.get('/api/usage', async (_req: Request, res: Response) => {
  const days = Math.min(Math.max(Number.parseInt(String(_req.query.days)) || 30, 1), 365);

  // Check response cache
  const cached = usageResponseCache.get(days);
  if (cached && Date.now() - cached.time < USAGE_CACHE_TTL_MS) {
    res.json(cached.data);
    return;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffMs = cutoff.getTime();
  const now = Date.now();
  const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const entries: UsageEntry[] = [];
  let claude5hTokens = 0;
  let claudeWeeklyTokens = 0;

  // --- Claude sessions (single pass: usage entries + rate limit token counts) ---
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  try {
    const projectDirs = fs
      .readdirSync(claudeDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(claudeDir, d.name));

    for (const projDir of projectDirs) {
      const jsonlFiles = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
      for (const file of jsonlFiles) {
        const filePath = path.join(projDir, file);
        const stat = fs.statSync(filePath);
        // Skip files older than both the query window AND the 7-day rate-limit window
        if (stat.mtimeMs < cutoffMs && stat.mtimeMs < sevenDaysAgo) continue;

        const data = parseClaudeSession(filePath, stat);

        // Usage entry (for the requested days window)
        if (stat.mtimeMs >= cutoffMs && data.inputTokens + data.outputTokens > 0) {
          entries.push(data);
        }

        // Rate limit token counts (5h + 7d windows)
        for (const { ts, tokens } of data.timestampedTokens) {
          if (ts >= sevenDaysAgo) claudeWeeklyTokens += tokens;
          if (ts >= fiveHoursAgo) claude5hTokens += tokens;
        }
      }
    }
  } catch {
    /* ~/.claude/projects may not exist */
  }

  // --- Codex sessions (single pass: usage entries + rate limits from most recent) ---
  const codexDir = path.join(os.homedir(), '.codex', 'sessions');
  const rateLimits = {} as Record<ProviderName, RateLimit[]>;
  for (const provider of Object.keys(providers) as ProviderName[]) {
    rateLimits[provider] = [];
  }
  let newestCodexFile = '';
  let newestCodexMtime = 0;

  try {
    const years = fs.readdirSync(codexDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const year of years) {
      const months = fs
        .readdirSync(path.join(codexDir, year.name), { withFileTypes: true })
        .filter((d) => d.isDirectory());
      for (const month of months) {
        const dayDirs = fs
          .readdirSync(path.join(codexDir, year.name, month.name), { withFileTypes: true })
          .filter((d) => d.isDirectory());
        for (const day of dayDirs) {
          const dateStr = `${year.name}-${month.name}-${day.name}`;
          const dateMs = new Date(dateStr).getTime();
          // Skip entire day dirs that are too old for BOTH usage and rate limits
          if (dateMs < cutoffMs && dateMs < sevenDaysAgo) continue;

          const dayPath = path.join(codexDir, year.name, month.name, day.name);
          const files = fs.readdirSync(dayPath).filter((f) => f.endsWith('.jsonl'));
          for (const file of files) {
            const filePath = path.join(dayPath, file);
            const stat = fs.statSync(filePath);

            // Track most recent for rate limits
            if (stat.mtimeMs > newestCodexMtime) {
              newestCodexMtime = stat.mtimeMs;
              newestCodexFile = filePath;
            }

            // Only parse for usage if within the query window
            if (dateMs < cutoffMs) continue;

            const sessionId = file.replace('.jsonl', '');
            let inputTokens = 0;
            let outputTokens = 0;

            const content = fs.readFileSync(filePath, 'utf-8');
            for (const line of content.split('\n')) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line);
                if (
                  entry.type === 'event_msg' &&
                  entry.payload?.type === 'token_count' &&
                  entry.payload.info?.total_token_usage
                ) {
                  const u = entry.payload.info.total_token_usage;
                  inputTokens = u.input_tokens ?? 0;
                  outputTokens = u.output_tokens ?? 0;
                }
              } catch {
                /* skip malformed lines */
              }
            }

            if (inputTokens + outputTokens > 0) {
              entries.push({
                sessionId,
                provider: 'codex',
                model: 'codex',
                inputTokens,
                outputTokens,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: estimateCost('codex', inputTokens, outputTokens, 0, 0),
                date: dateStr,
              });
            }
          }
        }
      }
    }
  } catch {
    /* ~/.codex/sessions may not exist */
  }

  // --- OpenCode sessions (single pass: assistant message token usage from local storage) ---
  const openCodeMessageDir = path.join(
    os.homedir(),
    '.local',
    'share',
    'opencode',
    'storage',
    'message'
  );
  try {
    const openCodeSessionDirs = fs
      .readdirSync(openCodeMessageDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(openCodeMessageDir, d.name));

    for (const sessionDirPath of openCodeSessionDirs) {
      const usage = parseOpenCodeSessionUsage(sessionDirPath);
      if (!usage) {
        continue;
      }

      if (usage.lastTimestampMs < cutoffMs) {
        continue;
      }

      entries.push({
        sessionId: usage.sessionId,
        provider: usage.provider,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        costUsd: usage.costUsd,
        date: usage.date,
      });
    }
  } catch {
    /* ~/.local/share/opencode/storage/message may not exist */
  }

  // Extract rate limits from the most recent Codex session file
  if (newestCodexFile) {
    try {
      const content = fs.readFileSync(newestCodexFile, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'event_msg' && entry.payload?.rate_limits) {
            const r = entry.payload.rate_limits;
            if (r.primary) {
              rateLimits.codex.push({
                label: `${r.primary.window_minutes / 60}h limit`,
                usedPercent: r.primary.used_percent,
                windowMinutes: r.primary.window_minutes,
                resetsAt: r.primary.resets_at ?? null,
              });
            }
            if (r.secondary) {
              rateLimits.codex.push({
                label: 'Weekly limit',
                usedPercent: r.secondary.used_percent,
                windowMinutes: r.secondary.window_minutes,
                resetsAt: r.secondary.resets_at ?? null,
              });
            }
            break;
          }
        } catch {
          /* skip */
        }
      }
    } catch {
      /* file may have been deleted */
    }
  }

  // Claude rate limits from timestamped tokens (already computed in single pass above)
  if (claude5hTokens > 0 || claudeWeeklyTokens > 0) {
    rateLimits.claude.push({
      label: '5h window',
      usedPercent: 0,
      windowMinutes: 300,
      resetsAt: null,
      tokenCount: claude5hTokens,
    });
    rateLimits.claude.push({
      label: 'Weekly',
      usedPercent: 0,
      windowMinutes: 10080,
      resetsAt: null,
      tokenCount: claudeWeeklyTokens,
    });
  }

  // Aggregate by day
  const byDay = new Map<
    string,
    { inputTokens: number; outputTokens: number; costUsd: number; sessions: number }
  >();
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;

  for (const e of entries) {
    totalCost += e.costUsd;
    totalInput += e.inputTokens;
    totalOutput += e.outputTokens;

    const existing = byDay.get(e.date);
    if (existing) {
      existing.inputTokens += e.inputTokens;
      existing.outputTokens += e.outputTokens;
      existing.costUsd += e.costUsd;
      existing.sessions += 1;
    } else {
      byDay.set(e.date, {
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        costUsd: e.costUsd,
        sessions: 1,
      });
    }
  }

  const daily = Array.from(byDay.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, data]) => ({ date, ...data }));

  const sortedEntries = [...entries].sort((a, b) => b.costUsd - a.costUsd);
  const topSessions = sortedEntries.slice(0, 20);

  // Keep provider tabs useful even when one provider's sessions are lower-cost.
  const orderedProviders = Object.keys(providers) as ProviderName[];
  for (const provider of orderedProviders) {
    if (topSessions.some((entry) => entry.provider === provider)) {
      continue;
    }
    const providerTopSession = sortedEntries.find((entry) => entry.provider === provider);
    if (providerTopSession) {
      topSessions.push(providerTopSession);
    }
  }
  topSessions.sort((a, b) => b.costUsd - a.costUsd);

  const response: UsageResponse = {
    totalCostUsd: totalCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalSessions: entries.length,
    days,
    daily,
    topSessions,
    rateLimits,
  };

  usageResponseCache.set(days, { time: Date.now(), data: response });
  res.json(response);
});

// Serve static files from client build
const clientDist = path.join(__dirname, '../../client/dist');
app.use(express.static(clientDist));

// SPA fallback - serve index.html for all non-API routes
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// =============================================================================
// Server Lifecycle
// =============================================================================

// Signal Handlers — split behavior for intentional shutdown vs hot-reload.
//
// SIGINT (Ctrl-C): Intentional shutdown. Kill all child processes and clear PID file.
// SIGTERM (tsx watch, kill, pm2, Docker stop): Hot-reload. Leave detached children
//   alive — the restarted server re-adopts them via the file poller + PID tracker.
//
// Children are spawned with detached:true + unref(), so they survive SIGTERM naturally.
// We just need to NOT kill them on SIGTERM and let Node exit.

process.on('SIGINT', () => {
  console.log('SIGINT — killing child processes and shutting down...');
  for (const conv of conversations.values()) {
    if (conv.process) {
      conv.process.kill('SIGKILL');
    }
  }
  process.exit();
});

process.on('SIGTERM', () => {
  console.log('SIGTERM — detaching child processes for hot-reload...');
  // Don't kill children — they're detached and will keep running.
  // PID file is left intact so the restarted server can re-adopt them.
  process.exit();
});

const PORT = process.env.PORT || 3000;

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false);
        } else {
          resolve(false);
        }
      })
      .once('listening', () => {
        tester.close(() => resolve(true));
      })
      .listen(port);
  });
}

function askQuestion(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function killProcessOnPort(port: number): boolean {
  try {
    // Get the PID
    const pidCmd = `lsof -i :${port} | grep LISTEN | awk '{print $2}'`;
    const pid = execSync(pidCmd, { stdio: 'pipe' }).toString().trim();

    if (!pid) {
      process.stdout.write('port already free\n');
      return true;
    }

    execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
    process.stdout.write(`killed PID ${pid}\n`);
    return true;
  } catch (err) {
    console.error(`✗ Failed to kill process on port ${port}:`, (err as Error).message);
    return false;
  }
}

/**
 * Hydrate a server-side Conversation instance from shared ConversationData.
 * Used by both initial load (progressive batches) and file polling (new sessions).
 */
function hydrateConversation(convData: ConversationData): Conversation {
  const sessionId = convData.id;
  const conversation = new Conversation(
    sessionId,
    convData.workingDirectory,
    convData.provider,
    sessionId, // existingSessionId - marks session as started
    undefined, // model
    convData.isWorker, // oompa worker flag from JSONL detection
    convData.swarmId ?? null,
    convData.workerId ?? null,
    convData.workerRole ?? null,
    resolveParentConversationId(convData.parentConversationId ?? null),
    convData.modelName ?? null
  );
  conversation.messages = convData.messages;
  conversation.createdAt = convData.createdAt;
  conversation.subAgents = convData.subAgents;
  return conversation;
}

/**
 * Load existing conversations from persisted Claude/Codex/OpenCode files.
 * Called on server startup to hydrate the in-memory Map.
 *
 * Progressive loading: files are sorted by mtime descending (most recent first)
 * and broadcast to connected clients in batches as they're parsed. This lets the
 * UI stream in conversations instead of blocking until all 1500+ files are loaded.
 */
async function loadExistingConversations(): Promise<void> {
  console.log('Loading conversations from persisted session files...');

  try {
    const { mtimes } = await loadAllConversations((batch, progress) => {
      // Hydrate each batch into server-side Conversation instances
      const broadcastBatch: ConversationData[] = [];
      for (const convData of batch) {
        const conversation = hydrateConversation(convData);
        conversations.set(convData.id, conversation);
        broadcastBatch.push(conversation.toJSON());
      }

      // Stream batch to all connected clients (most recent conversations arrive first)
      if (broadcastBatch.length > 0) {
        broadcastToAll({
          type: 'conversations_updated',
          conversations: broadcastBatch,
        });
      }

      console.log(
        `Loaded ${progress.loaded}/${progress.total} files (${conversations.size} conversations)...`
      );
    });

    fileMtimes = mtimes;

    // Second pass: re-resolve parentConversationId now that all conversations are loaded.
    // During progressive loading, child conversations (sub-agent threads) may have been
    // hydrated before their parent, leaving parentConversationId as an unresolved raw
    // session ID. Re-resolve and broadcast corrections so clients update sub-agent hierarchy.
    const reresolvedBatch: ConversationData[] = [];
    for (const conv of conversations.values()) {
      if (conv.parentConversationId) {
        const resolved = resolveParentConversationId(conv.parentConversationId);
        if (resolved !== conv.parentConversationId) {
          conv.parentConversationId = resolved;
          reresolvedBatch.push(conv.toJSON());
        }
      }
    }
    if (reresolvedBatch.length > 0) {
      broadcastToAll({ type: 'conversations_updated', conversations: reresolvedBatch });
    }

    console.log(`Loaded ${conversations.size} conversations from persisted session files`);
  } catch (error) {
    console.error('Failed to load conversations from persisted sessions:', error);
    // Continue anyway - server can still work without historical data
  }
}

function findConversationBySessionId(sessionId: string): Conversation | undefined {
  const direct = conversations.get(sessionId);
  if (direct) {
    return direct;
  }

  for (const conversation of conversations.values()) {
    if (conversation.sessionId === sessionId) {
      return conversation;
    }
  }

  return undefined;
}

function getLastUserMessageContent(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const content = messages[i].content.trim();
      return content.length > 0 ? content : null;
    }
  }
  return null;
}

function isOpenCodeSessionLike(sessionId: string): boolean {
  return sessionId.startsWith('ses_');
}

/**
 * Reconcile OpenCode sessions when the CLI created a real `ses_*` id in local
 * storage but did not emit JSON events (so we could not capture sessionID on stdout).
 *
 * Without this, file polling imports the new `ses_*` as a duplicate conversation.
 */
function findOpenCodeBootstrapMatch(
  sessionId: string,
  convData: ConversationData
): Conversation | undefined {
  if (convData.provider !== 'opencode') return undefined;
  if (!isOpenCodeSessionLike(sessionId)) return undefined;

  const importedLastUser = getLastUserMessageContent(convData.messages);
  if (!importedLastUser) return undefined;

  const importedCreatedMs = new Date(convData.createdAt).getTime();

  for (const conv of conversations.values()) {
    if (conv.provider !== 'opencode') continue;
    if (conv.id === sessionId) continue;
    if (isOpenCodeSessionLike(conv.sessionId)) continue;
    if (conv.workingDirectory !== convData.workingDirectory) continue;

    const existingLastUser = getLastUserMessageContent(conv.messages);
    if (!existingLastUser || existingLastUser !== importedLastUser) continue;

    const existingCreatedMs = conv.createdAt.getTime();
    if (
      Number.isFinite(importedCreatedMs) &&
      Math.abs(existingCreatedMs - importedCreatedMs) > 5 * 60_000
    ) {
      continue;
    }

    return conv;
  }

  return undefined;
}

function resolveParentConversationId(parentSessionId: string | null | undefined): string | null {
  if (!parentSessionId) {
    return null;
  }
  const parentConversation = findConversationBySessionId(parentSessionId);
  return parentConversation?.id ?? parentSessionId;
}

/**
 * Poll persisted session files every 5s for external changes (e.g., user ran
 * `claude`, `codex`, or `opencode` in terminal).
 * Only re-parses files with newer mtimes. Skips running conversations (launched by us).
 * Detects externally-running sessions: if a file's mtime changed between polls and
 * we didn't cause it, an external provider process is writing to it.
 * Broadcasts `conversations_updated` and `status` changes to all connected clients.
 */
function startFilePolling(): void {
  const POLL_INTERVAL_MS = 5000;

  setInterval(async () => {
    try {
      // Collect both UI conversation IDs and provider session IDs for running conversations.
      // Codex can rotate to a thread ID, so id and sessionId are not always the same.
      const activeIds = new Set<string>();
      for (const [id, conv] of conversations) {
        if (conv.isRunning) {
          activeIds.add(id);
          activeIds.add(conv.sessionId);
        }
      }

      const { updated, mtimes } = await pollForChanges(fileMtimes, activeIds);
      fileMtimes = mtimes;

      // --- External process detection ---
      // Sessions in `updated` had their files modified this cycle.
      // If we didn't launch them (not in activeIds), an external process wrote to them.
      const now = Date.now();

      for (const sessionId of updated.keys()) {
        if (activeIds.has(sessionId)) continue;

        const existingConversation = findConversationBySessionId(sessionId);
        const conversationId = existingConversation?.id ?? sessionId;

        // File changed and we didn't cause it — refresh the "last seen" timestamp
        if (!externallyRunning.has(sessionId)) {
          // Newly detected external activity
          console.log(`[Poll] External activity detected: ${sessionId.substring(0, 8)}`);
          broadcastToAll({
            type: 'status',
            conversationId,
            isRunning: true,
            isStreaming: false, // External activity — we don't know if streaming, but safe default
          });
        }
        externallyRunning.set(sessionId, now);
      }

      // Check grace period: only mark idle after EXTERNAL_GRACE_MS with no file changes.
      // This prevents flicker during gaps in Claude's output (thinking, API calls, tool use).
      for (const [sessionId, lastSeen] of externallyRunning) {
        if (now - lastSeen >= EXTERNAL_GRACE_MS) {
          externallyRunning.delete(sessionId);
          const existingConversation = findConversationBySessionId(sessionId);
          const conversationId = existingConversation?.id ?? sessionId;
          console.log(`[Poll] External activity stopped: ${sessionId.substring(0, 8)}`);
          broadcastToAll({
            type: 'status',
            conversationId,
            isRunning: false,
            isStreaming: false,
          });
        }
      }

      if (updated.size === 0) return;

      console.log(`[Poll] ${updated.size} conversation(s) changed`);

      const changedForBroadcast: ConversationData[] = [];

      for (const [sessionId, convData] of updated) {
        let existing = findConversationBySessionId(sessionId);

        if (!existing) {
          const reconciled = findOpenCodeBootstrapMatch(sessionId, convData);
          if (reconciled) {
            const oldSessionId = reconciled.sessionId;
            reconciled.sessionId = sessionId;
            knownSessionIds.add(sessionId);
            existing = reconciled;
            console.log(
              `[Poll] Reconciled OpenCode session ${sessionId.substring(0, 8)} with conversation ${reconciled.id.substring(0, 8)} (old session ${oldSessionId.substring(0, 8)})`
            );
          }
        }

        if (existing && !existing.isRunning) {
          // Update existing conversation in-place (preserve process handles, provider config).
          // Preserve server-injected system messages (error reports, exit info) that
          // exist only in memory — disk files don't contain these. Without this,
          // the poller would nuke error messages like "usage limit" within one poll cycle.
          const trailingSystemMessages = existing.messages.filter(
            (m, i) => m.role === 'system' && i >= convData.messages.length
          );
          existing.messages =
            trailingSystemMessages.length > 0
              ? [...convData.messages, ...trailingSystemMessages]
              : convData.messages;
          existing.subAgents = convData.subAgents;
          existing.createdAt = convData.createdAt;
          existing.isWorker = convData.isWorker;
          existing.swarmId = convData.swarmId ?? null;
          existing.workerId = convData.workerId ?? null;
          existing.workerRole = convData.workerRole ?? null;
          existing.parentConversationId = resolveParentConversationId(
            convData.parentConversationId ?? null
          );
          existing.modelName = convData.modelName ?? null;
          const json = existing.toJSON();
          // Mark as running if externally active
          if (externallyRunning.has(sessionId)) {
            json.isRunning = true;
          }
          changedForBroadcast.push(json);
        } else if (!existing && !knownSessionIds.has(sessionId)) {
          // New conversation (not an orphaned JSONL from resetProcess) — create fresh instance
          const conversation = hydrateConversation(convData);
          conversations.set(sessionId, conversation);
          const json = conversation.toJSON();
          if (externallyRunning.has(sessionId)) {
            json.isRunning = true;
          }
          changedForBroadcast.push(json);
        }
      }

      if (changedForBroadcast.length > 0) {
        broadcastToAll({
          type: 'conversations_updated',
          conversations: changedForBroadcast,
        });
      }
    } catch (error) {
      console.error('[Poll] Error during file polling:', error);
    }
  }, POLL_INTERVAL_MS);
}

async function startServer(): Promise<void> {
  // Initialize caches before opening the port
  await initSettingsCache();
  await initPaletteCache();

  const portNumber = typeof PORT === 'string' ? Number.parseInt(PORT, 10) : PORT;
  let isPortAvailable = await checkPort(portNumber);

  if (!isPortAvailable) {
    console.log(`\nPort ${PORT} is already in use.`);
    const answer = await askQuestion(`Kill the process using port ${PORT}? [y/N] `);

    if (answer === 'y' || answer === 'yes') {
      process.stdout.write('Killing... ');
      const killed = killProcessOnPort(portNumber);
      if (killed) {
        // Wait a moment for port to be released
        await new Promise((resolve) => setTimeout(resolve, 500));
        isPortAvailable = await checkPort(portNumber);

        if (!isPortAvailable) {
          console.error(`\n✗ Port ${PORT} still in use. Try manually or use a different port.`);
          process.exit(1);
        }
        console.log(`✓ Done\n`);
      } else {
        process.exit(1);
      }
    } else {
      console.log('\nAlternatives:');
      console.log(
        `  1. Kill manually: lsof -i :${PORT} | grep LISTEN | awk '{print $2}' | xargs kill -9`
      );
      console.log(`  2. Use different port: PORT=3001 pnpm dev:server\n`);
      process.exit(1);
    }
  }

  // Start listening FIRST so the Vite proxy can connect immediately.
  server.listen(portNumber, () => {
    console.log(`Server running on http://localhost:${portNumber}`);
  });

  // Unblock WebSocket handlers immediately — clients get an init with whatever
  // conversations have been loaded so far (initially empty). As loadExistingConversations
  // parses files in mtime-descending order, it broadcasts batches via conversations_updated
  // so the UI streams in progressively (most recent first).
  resolveInitialLoad();
  console.log('WebSocket handlers unblocked, loading conversations progressively...');

  // Load existing conversations — broadcasts batches to connected clients as they parse.
  await loadExistingConversations();
  console.log('Initial load complete');

  // Start file polling AFTER initial load so mtimes are populated.
  // If poller starts before loadExistingConversations completes, the first poll
  // would see empty mtimes and re-broadcast all conversations.
  startFilePolling();
  console.log('File polling started (5s interval)');
}

startServer();
