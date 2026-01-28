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
import type {
  Provider as ProviderName,
  Message,
  LoopConfig,
  Conversation as ConversationData,
  ServerMessage,
  SubAgent,
} from '@claude-web-view/shared';
import { getProvider, ProviderParseError, type Provider, type ProviderEvent } from './providers';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Store active conversations
const conversations = new Map<string, Conversation>();

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

class Conversation {
  id: string;                    // UI conversation ID (persists across resets)
  claudeSessionId: string;       // Claude CLI session ID (can be reset for fresh context)
  messages: Message[];
  process: ChildProcess | null;
  isRunning: boolean;
  isReady: boolean;              // True when CLI process is ready to receive messages
  createdAt: Date;
  workingDirectory: string;
  loopConfig: LoopConfig | null;
  provider: ProviderName;
  providerConfig: Provider | null;
  // Sub-agent tracking
  subAgents: SubAgent[];
  // Track pending tool_use blocks that might be Task tools
  private _pendingTaskTools: Map<string, { id: string; startedAt: Date }>;
  // Store last event for loop detection
  private _lastEvent: ProviderEvent | null;
  // Track if we've started a CLI session (for --resume vs --session-id)
  private _hasStartedSession: boolean;

  constructor(id: string, workingDirectory: string | null = null, provider: ProviderName = 'claude') {
    this.id = id;
    this.claudeSessionId = uuidv4(); // Separate session ID for Claude CLI
    this.messages = [];
    this.process = null;
    this.isRunning = false;
    this.isReady = true; // Ready immediately - we spawn process per message
    this.createdAt = new Date();
    this.workingDirectory = workingDirectory || process.cwd();
    this.loopConfig = null;
    this.provider = provider;
    this.providerConfig = getProvider(provider);
    this.subAgents = [];
    this._pendingTaskTools = new Map();
    this._lastEvent = null;
    this._hasStartedSession = false;
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
    console.log(`[${this.id}] Spawning ${this.provider} (claude-session=${this.claudeSessionId.substring(0, 8)}..., resume=${shouldResume})`);
    console.log(`[${this.id}] Message: "${content.substring(0, 50)}"`);

    // Use claudeSessionId (not conversation id) for CLI session tracking
    const spawnConfig = this.providerConfig!.getSpawnConfig(this.claudeSessionId, this.workingDirectory, shouldResume);
    this.process = spawn(spawnConfig.command, spawnConfig.args, spawnConfig.options);
    this.isRunning = true;
    this._hasStartedSession = true; // Mark session as started for next message
    this.broadcastStatus();

    this.process.stdout?.on('data', (data: Buffer) => {
      const rawOutput = data.toString();
      console.log(`[${this.id}] stdout (${rawOutput.length} bytes):`, rawOutput.substring(0, 200));

      const lines = rawOutput
        .split('\n')
        .filter((line) => line.trim());

      lines.forEach((line) => {
        try {
          const json = JSON.parse(line) as unknown;
          const jsonType = (json as { type?: string }).type;
          const eventType = (json as { event?: { type?: string } }).event?.type;
          console.log(`[${this.id}] RAW: type=${jsonType}${eventType ? `, event.type=${eventType}` : ''}`);
          this.handleOutput(json);
        } catch (e) {
          if (e instanceof SyntaxError) {
            console.error(`[${this.provider}] Failed to parse JSON:`, line.substring(0, 100));
          } else if (e instanceof ProviderParseError) {
            console.error(`[${this.provider}] Parse error:`, e.message);
          } else if (e instanceof Error) {
            console.error(`[${this.provider}] Error:`, e.message);
          }
        }
      });
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

  // Legacy start() - no longer used, kept for compatibility
  start(): void {
    // No-op: we now spawn per message
    console.log(`[${this.id}] start() called - no-op, we spawn per message`);
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
          this.messages.push({
            role: 'assistant',
            content: '',
            timestamp: new Date(),
          });
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
        // Store for loop detection
        this._lastEvent = event;
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

  sendMessage(content: string): void {
    console.log(`[${this.id}] sendMessage called, isRunning=${this.isRunning}`);

    if (this.isRunning) {
      console.warn(`[${this.id}] Already processing a message, ignoring`);
      return;
    }

    // Add user message to history
    this.messages.push({
      role: 'user',
      content: content,
      timestamp: new Date(),
    });

    // Broadcast user message to clients
    this.broadcastMessage({
      type: 'message',
      role: 'user',
      content: content,
      conversationId: this.id,
    });

    // Spawn CLI process to handle this message
    this.spawnForMessage(content);
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.isRunning = false;
      this.isReady = false;
    }
  }

  // Reset process for fresh context (used in loop with clearContext)
  // Generates new Claude session ID while keeping conversation ID for UI continuity
  resetProcess(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.isRunning = false;
      this.isReady = false;
    }
    // Generate new Claude session ID for fresh context
    const oldSessionId = this.claudeSessionId;
    this.claudeSessionId = uuidv4();
    this._hasStartedSession = false;
    console.log(`[${this.id}] Reset Claude session: ${oldSessionId.substring(0, 8)}... -> ${this.claudeSessionId.substring(0, 8)}...`);
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
      subAgents: this.subAgents,
    };
  }
}

// =============================================================================
// Loop Execution
// =============================================================================

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

    // Send loop start separator
    broadcastToAll({
      type: 'loop_iteration_start',
      conversationId: conv.id,
      currentIteration: i,
      totalIterations,
    });

    // Add separator to messages
    const startMarker: Message = {
      role: 'system',
      content: `=== Loop ${i}/${totalIterations} Start ===`,
      timestamp: new Date(),
      isLoopMarker: true,
    };
    conv.messages.push(startMarker);

    // Broadcast the separator as a message
    broadcastToAll({
      type: 'message',
      conversationId: conv.id,
      role: 'system',
      content: startMarker.content,
    });

    // Send the prompt and wait for completion
    await sendAndWaitForComplete(conv, prompt);

    // Add end separator
    const endMarker: Message = {
      role: 'system',
      content: `=== Loop ${i}/${totalIterations} End ===`,
      timestamp: new Date(),
      isLoopMarker: true,
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

  // Loop complete
  const wasLooping = conv.loopConfig?.isLooping;
  conv.loopConfig = null;

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
 * Send a message and wait for completion.
 * Uses the unified event system - listens for message_complete event.
 * One clean path, no fallbacks.
 */
function sendAndWaitForComplete(conv: Conversation, prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const originalHandler = conv.handleOutput.bind(conv);

    conv.handleOutput = (json: unknown): void => {
      originalHandler(json);
      // Check if the last event was message_complete
      // _lastEvent is set in handleOutput when message_complete is received
      if (conv['_lastEvent']?.type === 'message_complete') {
        // Restore original handler
        conv.handleOutput = originalHandler;
        // Reset the last event
        conv['_lastEvent'] = null;
        // Small delay before next iteration
        setTimeout(resolve, 500);
      }
    };

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
  workingDirectory?: string;
  provider?: ProviderName;
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

  // Send current state
  ws.send(
    JSON.stringify({
      type: 'init',
      conversations: Array.from(conversations.values()).map((c) => c.toJSON()),
      defaultCwd: process.cwd(),
    })
  );

  ws.on('message', (message: Buffer | string) => {
    try {
      const data = JSON.parse(message.toString()) as ClientMessageData;
      console.log(`[WS] Received message type: ${data.type}`, JSON.stringify(data).substring(0, 200));

      switch (data.type) {
        case 'new_conversation': {
          const id = uuidv4();
          // Expand ~ to home directory
          let workingDir = data.workingDirectory || process.cwd();
          if (workingDir.startsWith('~')) {
            workingDir = workingDir.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '');
          }
          const provider = data.provider || 'claude'; // Support 'claude' or 'codex'

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

          const conv = new Conversation(id, workingDir, provider);
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

app.post('/api/settings', (req: Request, res: Response) => {
  const settings = { ...loadSettings(), ...req.body };
  saveSettings(settings);
  res.json(settings);
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

  server.listen(portNumber, () => {
    console.log(`Server running on http://localhost:${portNumber}`);
  });
}

startServer();
