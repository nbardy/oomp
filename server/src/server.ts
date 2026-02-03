import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn, ChildProcess, execSync } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import type {
  Provider as ProviderName,
  ModelId,
  Message,
  LoopConfig,
  Conversation as ConversationData,
  ServerMessage,
  SubAgent,
} from '@claude-web-view/shared';
import { getProvider, ProviderParseError, type Provider, type ProviderEvent } from './providers';
import { loadAllConversations, pollForChanges } from './adapters/jsonl';
import { loadCodexSessions, pollCodexSessions } from './adapters/codex-sessions';
import { writeCodexMessage } from './adapters/codex-persistence';
import multer from 'multer';

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

interface ReadyData {
  type: 'ready';
  conversationId: string;
  isReady: boolean;
}

type BroadcastData = ServerMessage | ChunkData | MessageCompleteData | MessageData | ReadyData;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Broadcast data to all connected WebSocket clients
 */
function broadcastToAll(data: BroadcastData): void {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
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
class Conversation extends EventEmitter {
  id: string;                    // UI conversation ID (persists across resets)
  sessionId: string;             // Provider CLI session ID (can be reset for fresh context)
  messages: Message[];
  process: ChildProcess | null;
  isRunning: boolean;
  isReady: boolean;              // True when CLI process is ready to receive messages
  createdAt: Date;
  workingDirectory: string;
  loopConfig: LoopConfig | null;
  provider: ProviderName;
  model: ModelId | undefined;     // Provider-specific model identifier (e.g. 'opus', 'gpt-5.2-high')
  providerConfig: Provider | null;
  // Sub-agent tracking
  subAgents: SubAgent[];
  // Track pending tool_use blocks that might be Task tools
  private _pendingTaskTools: Map<string, { id: string; startedAt: Date }>;
  // Track if we've started a CLI session (for --resume vs --session-id)
  private _hasStartedSession: boolean;
  // Buffer for incomplete JSON lines from stdout
  private _stdoutBuffer: string;
  // Loop iteration tracking — set by runLoop(), read by handleOutput() to tag messages
  _currentLoopIteration: number | null;
  _currentLoopTotal: number | null;

  constructor(
    id: string,
    workingDirectory: string | null = null,
    provider: ProviderName = 'claude',
    /** Optional: set session ID when loading from JSONL (defaults to new UUID) */
    existingSessionId?: string,
    /** Optional: provider-specific model identifier (e.g. 'opus', 'gpt-5.2-high') */
    model?: ModelId
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
    this.isReady = true; // Ready immediately - we spawn process per message
    this.createdAt = new Date();
    this.workingDirectory = workingDirectory || process.cwd();
    this.loopConfig = null;
    this.provider = provider;
    this.model = model;
    this.providerConfig = getProvider(provider);
    this.subAgents = [];
    this._pendingTaskTools = new Map();
    // Mark session as started if loading existing (use --resume for next message)
    this._hasStartedSession = existingSessionId !== undefined;
    this._stdoutBuffer = '';
    this._currentLoopIteration = null;
    this._currentLoopTotal = null;
  }

  /**
   * Send a message by spawning a new CLI process.
   * Claude CLI requires stdin EOF to process input, so we spawn fresh for each message.
   * First message uses --session-id, subsequent messages use --resume.
   */
  private spawnForMessage(content: string): void {
    if (this.isRunning) {
      console.warn(`[${this.id}] Already processing a message, ignoring`);
      return;
    }

    const shouldResume = this._hasStartedSession;
    console.log(`[${this.id}] Spawning ${this.provider} (claude-session=${this.sessionId.substring(0, 8)}..., resume=${shouldResume})`);
    console.log(`[${this.id}] Message: "${content.substring(0, 50)}"`);

    // Reset stdout buffer for new process
    this._stdoutBuffer = '';

    // Use sessionId (not conversation id) for CLI session tracking
    const spawnConfig = this.providerConfig!.getSpawnConfig(this.sessionId, this.workingDirectory, shouldResume, this.model);
    this.process = spawn(spawnConfig.command, spawnConfig.args, spawnConfig.options);
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

        try {
          const json = JSON.parse(trimmed) as unknown;
          const jsonType = (json as { type?: string }).type;
          const eventType = (json as { event?: { type?: string } }).event?.type;
          console.log(`[${this.id}] RAW: type=${jsonType}${eventType ? `, event.type=${eventType}` : ''}`);

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
      console.error(`[${this.id}] stderr:`, data.toString());
    });

    this.process.on('close', (code: number | null) => {
      console.log(`[${this.id}] Process closed with code ${code}`);
      this.isRunning = false;
      this.process = null;
      this.broadcastStatus();
    });

    // Write message and close stdin to trigger processing
    console.log(`[${this.id}] Writing to stdin and closing...`);
    this.process.stdin?.write(content + '\n');
    this.process.stdin?.end();
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
        // BUG FIX: Must create assistant message BEFORE sending chunks
        // The client expects the last message to be role='assistant' when receiving chunks.
        // If we don't broadcast the assistant message first, chunks are silently ignored.
        const lastMsg = this.messages[this.messages.length - 1];
        if (!lastMsg || lastMsg.role !== 'assistant') {
          console.log(`[${this.id}] Creating NEW assistant message (msg #${this.messages.length + 1})`);
          const newMsg: Message = {
            role: 'assistant',
            content: '',
            timestamp: new Date(),
          };
          // Tag with loop metadata if we're inside a loop iteration
          if (this._currentLoopIteration !== null && this._currentLoopTotal !== null) {
            newMsg.loopIteration = this._currentLoopIteration;
            newMsg.loopTotal = this._currentLoopTotal;
          }
          this.messages.push(newMsg);
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
        console.log(`[${this.id}] chunk (${event.text.length} chars): "${event.text.substring(0, 30).replace(/\n/g, '\\n')}..."`);
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
          const description = (event.input as { description?: string }).description || 'Running sub-agent task...';
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

          console.log(`[${this.id}] Sub-agent started: ${blockId.substring(0, 8)} - "${description.substring(0, 50)}"`);

          // Broadcast sub-agent start
          broadcastToAll({
            type: 'subagent_start',
            conversationId: this.id,
            subAgent,
          });
        } else {
          // For non-Task tools, check if we have an active sub-agent and update its current action
          if (this.subAgents.length > 0) {
            const activeAgent = this.subAgents.find(a => a.status === 'running');
            if (activeAgent) {
              // Format the current action based on tool name
              let actionDisplay = event.name;
              if (event.input) {
                // Extract file path if present
                const filePath = (event.input as { file_path?: string; path?: string }).file_path
                  || (event.input as { file_path?: string; path?: string }).path;
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
        // Get the last assistant message to persist it
        const lastMsg = this.messages[this.messages.length - 1];

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

        this.broadcastChunk({
          type: 'message_complete',
          conversationId: this.id,
        });

        // Persist the completed assistant message for Codex conversations
        if (lastMsg && lastMsg.role === 'assistant') {
          this.persistMessage(lastMsg).catch(err => {
            console.error(`[${this.id}] Failed to persist assistant message:`, err);
          });
        }

        // Emit for loop engine — replaces fragile monkey-patching of handleOutput.
        // See docs/ralph_loop_design.md §Bug 2.
        this.emit('iteration_complete');
        break;
      }

      case 'error':
        throw new Error(`Provider error: ${event.message}`);

      default:
        // TypeScript exhaustive check - this should never happen
        const _exhaustive: never = event;
        throw new Error(`Unhandled event type: ${JSON.stringify(_exhaustive)}`);
    }
  }

  /**
   * Persist a message to disk for Codex conversations.
   * Only persists Codex conversations (Claude Code handles its own persistence).
   * Failures are logged but don't throw - persistence shouldn't break active conversations.
   *
   * @param message - The message to persist
   */
  private async persistMessage(message: Message): Promise<void> {
    // Only persist Codex conversations
    if (this.provider !== 'codex') {
      return;
    }

    // Skip loop markers (system messages we add for UI)
    if (message.isLoopMarker) {
      return;
    }

    try {
      await writeCodexMessage(this.id, this.workingDirectory, message);
    } catch (error) {
      // writeCodexMessage already catches and logs errors, but just in case
      console.error(`[${this.id}] Unexpected error in persistMessage:`, error);
    }
  }

  sendMessage(content: string): void {
    console.log(`[${this.id}] sendMessage called, isRunning=${this.isRunning}`);

    if (this.isRunning) {
      console.warn(`[${this.id}] Already processing a message, ignoring`);
      return;
    }

    // Add user message to history
    const userMessage: Message = {
      role: 'user',
      content: content,
      timestamp: new Date(),
    };
    this.messages.push(userMessage);

    // Broadcast user message to clients
    this.broadcastMessage({
      type: 'message',
      role: 'user',
      content: content,
      conversationId: this.id,
    });

    // Persist user message for Codex conversations (async, non-blocking)
    this.persistMessage(userMessage).catch(err => {
      console.error(`[${this.id}] Failed to persist user message:`, err);
    });

    // Spawn CLI process to handle this message
    this.spawnForMessage(content);
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.isRunning = false;
      // Mark ready so queued messages (e.g. interrupt-and-send) can process.
      // Same reasoning as resetProcess(): we spawn a fresh process per message,
      // so a stopped conversation is conceptually "ready" for the next one.
      this.isReady = true;
      this.broadcastStatus();
      this.broadcastReady();
    }
  }

  // Reset process for fresh context (used in loop with clearContext).
  // Generates new CLI session ID while keeping conversation ID for UI continuity.
  // IMPORTANT: Do NOT set isReady = false here. We spawn a fresh process per
  // message (spawnForMessage), so the conversation is always conceptually "ready."
  // Setting isReady = false broadcasts a false "not ready" state to the client,
  // which breaks the loop engine. See docs/ralph_loop_design.md §Bug 1.
  resetProcess(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.isRunning = false;
    }
    // Generate new session ID for fresh context
    const oldSessionId = this.sessionId;
    this.sessionId = uuidv4();
    knownSessionIds.add(this.sessionId);
    this._hasStartedSession = false;
    console.log(`[${this.id}] Reset session: ${oldSessionId.substring(0, 8)}... -> ${this.sessionId.substring(0, 8)}...`);
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
    });
  }

  broadcastReady(): void {
    broadcastToAll({
      type: 'ready',
      conversationId: this.id,
      isReady: this.isReady,
    });
  }

  toJSON(): ConversationData {
    return {
      id: this.id,
      messages: this.messages,
      isRunning: this.isRunning,
      isReady: this.isReady,
      createdAt: this.createdAt,
      workingDirectory: this.workingDirectory,
      loopConfig: this.loopConfig,
      provider: this.provider,
      model: this.model,
      subAgents: this.subAgents,
    };
  }
}

// =============================================================================
// Loop Execution
// =============================================================================

// RALPH LOOP ENGINE: Executes the same prompt N times in sequence.
// Each iteration spawns a new CLI process via sendMessage().
// When clearContext=true, resetProcess() generates a new session ID.
// All messages stay in conversation.messages[] — iterations are separated
// by isLoopMarker messages and tagged with loopIteration metadata.
// Loop iterations do NOT appear as separate conversations in the sidebar.
// See docs/ralph_loop_design.md for full architecture.
async function runLoop(
  conv: Conversation,
  prompt: string,
  iterations: string | number,
  clearContext: boolean
): Promise<void> {
  const totalIterations = typeof iterations === 'string' ? Number.parseInt(iterations, 10) : iterations;

  conv.loopConfig = {
    totalIterations,
    currentIteration: 0,
    loopsRemaining: totalIterations,
    clearContext,
    prompt,
    isLooping: true,
  };

  console.log(
    `Starting loop for conversation ${conv.id}: ${totalIterations} iterations, clearContext=${clearContext}`
  );

  // Broadcast initial loop state
  broadcastToAll({
    type: 'status',
    conversationId: conv.id,
    isRunning: true,
  });

  for (let i = 1; i <= totalIterations; i++) {
    // Check if cancelled
    if (!conv.loopConfig?.isLooping) {
      console.log(`Loop cancelled at iteration ${i}`);
      break;
    }

    conv.loopConfig.currentIteration = i;
    conv.loopConfig.loopsRemaining = totalIterations - i;

    // Clear context if requested (kill process, will restart on send)
    if (clearContext && i > 1) {
      console.log(`Clearing context for iteration ${i}`);
      conv.resetProcess();
    }

    // Set loop iteration tracking — handleOutput reads these to tag messages
    conv._currentLoopIteration = i;
    conv._currentLoopTotal = totalIterations;

    // Send loop start separator
    broadcastToAll({
      type: 'loop_iteration_start',
      conversationId: conv.id,
      currentIteration: i,
      totalIterations,
    });

    // Add separator to messages (tagged with loop metadata)
    const startMarker: Message = {
      role: 'system',
      content: `=== Loop ${i}/${totalIterations} Start ===`,
      timestamp: new Date(),
      isLoopMarker: true,
      loopIteration: i,
      loopTotal: totalIterations,
    };
    conv.messages.push(startMarker);

    // Broadcast the separator as a message
    broadcastToAll({
      type: 'message',
      conversationId: conv.id,
      role: 'system',
      content: startMarker.content,
    });

    // Send the prompt and wait for completion (EventEmitter-based, with timeout)
    try {
      await sendMessageAndWait(conv, prompt);
    } catch (err) {
      console.error(`[${conv.id}] Loop iteration ${i} failed:`, (err as Error).message);
      // On timeout/error, add an error marker and continue to next iteration
      const errorMarker: Message = {
        role: 'system',
        content: `=== Loop ${i}/${totalIterations} Error: ${(err as Error).message} ===`,
        timestamp: new Date(),
        isLoopMarker: true,
        loopIteration: i,
        loopTotal: totalIterations,
      };
      conv.messages.push(errorMarker);
      broadcastToAll({
        type: 'message',
        conversationId: conv.id,
        role: 'system',
        content: errorMarker.content,
      });
    }

    // Add end separator (tagged with loop metadata)
    const endMarker: Message = {
      role: 'system',
      content: `=== Loop ${i}/${totalIterations} End ===`,
      timestamp: new Date(),
      isLoopMarker: true,
      loopIteration: i,
      loopTotal: totalIterations,
    };
    conv.messages.push(endMarker);

    broadcastToAll({
      type: 'message',
      conversationId: conv.id,
      role: 'system',
      content: endMarker.content,
    });

    // Broadcast iteration end
    broadcastToAll({
      type: 'loop_iteration_end',
      conversationId: conv.id,
      currentIteration: i,
      totalIterations,
      loopsRemaining: totalIterations - i,
    });

    console.log(`Completed loop iteration ${i}/${totalIterations}`);
  }

  // Loop complete — clear loop tracking fields
  const wasLooping = conv.loopConfig?.isLooping;
  conv.loopConfig = null;
  conv._currentLoopIteration = null;
  conv._currentLoopTotal = null;

  if (wasLooping) {
    broadcastToAll({
      type: 'loop_complete',
      conversationId: conv.id,
      totalIterations,
    });
    console.log(`Loop complete for conversation ${conv.id}`);
  }
}

/**
 * Send a message and wait for completion via EventEmitter.
 * Listens for 'iteration_complete' (emitted by handleOutput on message_complete)
 * and also for process close as a fallback. Includes a timeout to prevent
 * infinite hangs if the CLI crashes. See docs/ralph_loop_design.md §Bug 2.
 */
function sendMessageAndWait(conv: Conversation, prompt: string): Promise<void> {
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per iteration

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      conv.removeListener('iteration_complete', onComplete);
      clearTimeout(timer);
    };

    const onComplete = () => {
      cleanup();
      // Brief delay before next iteration to let broadcasts propagate
      setTimeout(resolve, 500);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Loop iteration timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    conv.on('iteration_complete', onComplete);
    conv.sendMessage(prompt);
  });
}

function cancelLoop(convId: string): void {
  const conv = conversations.get(convId);
  if (conv?.loopConfig) {
    conv.loopConfig.isLooping = false;
    console.log(`Cancelling loop for conversation ${convId}`);
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
  model?: ModelId; // Provider-specific model identifier (e.g. 'opus', 'gpt-5.2-high')
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

interface StartLoopData {
  type: 'start_loop';
  conversationId: string;
  prompt: string;
  iterations: string | number;
  clearContext: boolean;
}

interface CancelLoopData {
  type: 'cancel_loop';
  conversationId: string;
}

type ClientMessageData =
  | NewConversationData
  | SendMessageData
  | StopConversationData
  | DeleteConversationData
  | StartLoopData
  | CancelLoopData;

// =============================================================================
// WebSocket Handler
// =============================================================================

wss.on('connection', (ws: WebSocket) => {
  console.log('New WebSocket connection');

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

  ws.on('message', (message: Buffer | string) => {
    try {
      const data = JSON.parse(message.toString()) as ClientMessageData;
      console.log(`[WS] Received message type: ${data.type}`, JSON.stringify(data).substring(0, 200));

      switch (data.type) {
        case 'new_conversation': {
          // Use client-provided UUID if present (optimistic insert), otherwise generate one
          const id = data.id || uuidv4();
          // Expand ~ to home directory
          let workingDir = data.workingDirectory || process.cwd();
          if (workingDir.startsWith('~')) {
            workingDir = workingDir.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '');
          }
          const provider = data.provider || 'claude'; // Support 'claude' or 'codex'
          const model = data.model; // Provider-specific model (undefined = provider default)

          // Validate provider
          if (provider !== 'claude' && provider !== 'codex') {
            ws.send(
              JSON.stringify({
                type: 'error',
                message: `Invalid provider: ${provider}. Must be 'claude' or 'codex'.`,
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

          const conv = new Conversation(id, workingDir, provider, undefined, model);
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
          console.log(`[WS] send_message for ${data.conversationId}: "${data.content.substring(0, 50)}"`);
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
            ws.send(
              JSON.stringify({
                type: 'conversation_deleted',
                conversationId: data.conversationId,
              })
            );
          }
          break;
        }

        case 'start_loop': {
          const conv = conversations.get(data.conversationId);
          if (conv && !conv.loopConfig?.isLooping) {
            runLoop(conv, data.prompt, data.iterations, data.clearContext);
          }
          break;
        }

        case 'cancel_loop': {
          cancelLoop(data.conversationId);
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

  console.log(`[Upload] ${files.length} file(s) saved:`, result.map((r) => r.absolutePath));
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

function loadSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
    }
  } catch (e) {
    console.error('Error loading settings:', e);
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: Settings): void {
  try {
    if (!fs.existsSync(SETTINGS_DIR)) {
      fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Error saving settings:', e);
  }
}

app.get('/api/settings', (_req: Request, res: Response) => {
  res.json(loadSettings());
});

// Model list API — returns ModelInfo[] for the given provider.
// Used by the Sidebar model dropdown to show available models per provider.
app.get('/api/models', (req: Request, res: Response) => {
  const providerName = (req.query.provider as string) || 'claude';
  const provider = getProvider(providerName as ProviderName);
  res.json(provider.listModels());
});

// Path autocomplete API - returns directory listings for a given path
// Used by the PathAutocomplete component in the new conversation dialog
app.get('/api/paths', (req: Request, res: Response) => {
  const inputPath = (req.query.path as string) || '';

  // Handle empty path - return home directory contents
  if (!inputPath) {
    try {
      const homeDir = os.homedir();
      const entries = fs.readdirSync(homeDir, { withFileTypes: true });
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
    const stats = fs.statSync(normalizedPath);
    if (stats.isDirectory()) {
      // Path is a complete directory - list its contents
      const entries = fs.readdirSync(normalizedPath, { withFileTypes: true });
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
    const stats = fs.statSync(parentDir);
    if (stats.isDirectory()) {
      const entries = fs.readdirSync(parentDir, { withFileTypes: true });
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

app.post('/api/settings', (req: Request, res: Response) => {
  const settings = { ...loadSettings(), ...req.body };
  saveSettings(settings);
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
  'base03', 'base02', 'base01', 'base00', 'base0', 'base1',
  'yellow', 'orange', 'red', 'magenta', 'violet', 'blue', 'cyan', 'green',
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

function getNextPaletteNumber(): number {
  if (!fs.existsSync(PALETTES_DIR)) return 1;

  let maxN = 0;
  for (const file of fs.readdirSync(PALETTES_DIR)) {
    const match = file.match(/^palette_(\d+)\.json$/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > maxN) maxN = n;
    }
  }
  return maxN + 1;
}

// GET /api/custom-palettes — returns Record<string, Palette16> of saved custom palettes
// Each entry has { name, base03, base02, ..., green } matching the Palette16 interface.
app.get('/api/custom-palettes', (_req: Request, res: Response) => {
  const palettes: Record<string, Record<string, string>> = {};

  if (!fs.existsSync(PALETTES_DIR)) {
    res.json(palettes);
    return;
  }

  for (const file of fs.readdirSync(PALETTES_DIR)) {
    const match = file.match(/^palette_(\d+)\.json$/);
    if (!match) continue;

    try {
      const content = fs.readFileSync(path.join(PALETTES_DIR, file), 'utf-8');
      const stored = JSON.parse(content) as StoredPalette;
      // Return Palette16 shape: flat keys, no nested 'colors' object
      const palette: Record<string, string> = { name: stored.name };
      for (const key of PALETTE16_KEYS) {
        palette[key] = stored[key];
      }
      palettes[`custom_${match[1]}`] = palette;
    } catch (e) {
      console.error(`Failed to parse palette file ${file}:`, e);
    }
  }

  res.json(palettes);
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

  const n = getNextPaletteNumber();

  // Use the provider's single-shot config instead of hardcoding spawn args
  const spawnConfig = provider.getSingleShotConfig(prompt);
  console.log(`[generate-palette] Spawning ${providerName}: ${spawnConfig.command} ${spawnConfig.args.map(a => a.length > 80 ? a.slice(0, 80) + '...' : a).join(' ')}`);
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
      sendError(500, `${providerName} process failed (exit code ${code})${stderr ? `: ${stderr.slice(0, 500)}` : ''}`);
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
      base03: parsed.base03, base02: parsed.base02,
      base01: parsed.base01, base00: parsed.base00,
      base0:  parsed.base0,  base1:  parsed.base1,
      yellow: parsed.yellow, orange: parsed.orange,
      red:    parsed.red,    magenta: parsed.magenta,
      violet: parsed.violet, blue:   parsed.blue,
      cyan:   parsed.cyan,   green:  parsed.green,
    };

    try {
      if (!fs.existsSync(PALETTES_DIR)) {
        fs.mkdirSync(PALETTES_DIR, { recursive: true });
      }
      const filePath = path.join(PALETTES_DIR, `palette_${n}.json`);
      fs.writeFileSync(filePath, JSON.stringify(stored, null, 2));
      console.log(`[generate-palette] Saved palette to ${filePath}`);
    } catch (writeErr) {
      console.error(`[generate-palette] Failed to save palette file:`, writeErr);
      sendError(500, 'Failed to save palette file');
      return;
    }

    // Return Palette16 shape to client (flat keys, no nested 'colors' object)
    if (responded) return; // timeout already fired
    responded = true;
    const key = `custom_${n}`;
    const palette: Record<string, string> = { name: parsed.name };
    for (const k of PALETTE16_KEYS) {
      palette[k] = parsed[k];
    }
    console.log(`[generate-palette] Success: "${parsed.name}" -> ${key}`);
    res.json({ key, palette });
  });
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

// Cleanup on exit
process.on('SIGINT', () => {
  console.log('Shutting down...');
  conversations.forEach((conv) => conv.stop());
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
 * Load existing conversations from Claude Code's JSONL files
 * Called on server startup to hydrate the in-memory Map
 */
async function loadExistingConversations(): Promise<void> {
  console.log('Loading conversations from JSONL files...');

  try {
    const { conversations: loaded, mtimes } = await loadAllConversations();
    fileMtimes = mtimes;

    for (const [sessionId, convData] of loaded) {
      // Create a Conversation instance from the loaded data
      // Use sessionId as both id and sessionId (they're the same for loaded sessions)
      const conversation = new Conversation(
        sessionId,
        convData.workingDirectory,
        convData.provider,
        sessionId // existingSessionId - marks session as started
      );

      // Copy over the loaded data
      conversation.messages = convData.messages;
      conversation.createdAt = convData.createdAt;
      conversation.subAgents = convData.subAgents;

      conversations.set(sessionId, conversation);
    }

    console.log(`Loaded ${conversations.size} conversations from JSONL files`);
  } catch (error) {
    console.error('Failed to load conversations from JSONL:', error);
    // Continue anyway - server can still work without historical data
  }
}

/**
 * Poll JSONL files every 5s for external changes (e.g., user ran `claude` in terminal).
 * Only re-parses files with newer mtimes. Skips running conversations (launched by us).
 * Detects externally-running sessions: if a file's mtime changed between polls and
 * we didn't cause it, an external Claude process is writing to it.
 * Broadcasts `conversations_updated` and `status` changes to all connected clients.
 */
function startFilePolling(): void {
  const POLL_INTERVAL_MS = 5000;

  setInterval(async () => {
    try {
      // Collect IDs of running conversations so the poller skips their JSONL files.
      // Since id === sessionId (except after resetProcess), the Map key matches the filename.
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

        // File changed and we didn't cause it — refresh the "last seen" timestamp
        if (!externallyRunning.has(sessionId)) {
          // Newly detected external activity
          console.log(`[Poll] External activity detected: ${sessionId.substring(0, 8)}`);
          broadcastToAll({
            type: 'status',
            conversationId: sessionId,
            isRunning: true,
          });
        }
        externallyRunning.set(sessionId, now);
      }

      // Check grace period: only mark idle after EXTERNAL_GRACE_MS with no file changes.
      // This prevents flicker during gaps in Claude's output (thinking, API calls, tool use).
      for (const [sessionId, lastSeen] of externallyRunning) {
        if (now - lastSeen >= EXTERNAL_GRACE_MS) {
          externallyRunning.delete(sessionId);
          console.log(`[Poll] External activity stopped: ${sessionId.substring(0, 8)}`);
          broadcastToAll({
            type: 'status',
            conversationId: sessionId,
            isRunning: false,
          });
        }
      }

      if (updated.size === 0) return;

      console.log(`[Poll] ${updated.size} conversation(s) changed`);

      const changedForBroadcast: ConversationData[] = [];

      for (const [sessionId, convData] of updated) {
        const existing = conversations.get(sessionId);

        if (existing && !existing.isRunning) {
          // Update existing conversation in-place (preserve process handles, provider config)
          existing.messages = convData.messages;
          existing.subAgents = convData.subAgents;
          existing.createdAt = convData.createdAt;
          const json = existing.toJSON();
          // Mark as running if externally active
          if (externallyRunning.has(sessionId)) {
            json.isRunning = true;
          }
          changedForBroadcast.push(json);
        } else if (!existing && !knownSessionIds.has(sessionId)) {
          // New conversation (not an orphaned JSONL from resetProcess) — create fresh instance
          const conversation = new Conversation(
            sessionId,
            convData.workingDirectory,
            convData.provider,
            sessionId
          );
          conversation.messages = convData.messages;
          conversation.createdAt = convData.createdAt;
          conversation.subAgents = convData.subAgents;
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
  const portNumber = typeof PORT === 'string' ? parseInt(PORT, 10) : PORT;
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
      console.log(`  1. Kill manually: lsof -i :${PORT} | grep LISTEN | awk '{print $2}' | xargs kill -9`);
      console.log(`  2. Use different port: PORT=3001 pnpm dev:server\n`);
      process.exit(1);
    }
  }

  // Start listening FIRST so the Vite proxy can connect immediately.
  // Conversation loading happens after — clients get an empty init,
  // then a conversations_updated broadcast once loading finishes.
  server.listen(portNumber, () => {
    console.log(`Server running on http://localhost:${portNumber}`);
    startFilePolling();
    console.log('File polling started (5s interval)');
  });

  // Load existing conversations in the background after the port is open.
  // Any clients connected during loading get an empty conversations list,
  // then receive a conversations_updated broadcast when loading completes.
  await loadExistingConversations();

  // Broadcast all loaded conversations to any clients that connected during loading
  if (conversations.size > 0) {
    broadcastToAll({
      type: 'conversations_updated',
      conversations: Array.from(conversations.values()).map((c) => c.toJSON()),
    });
    console.log(`Broadcast ${conversations.size} loaded conversations to connected clients`);
  }
}

startServer();
