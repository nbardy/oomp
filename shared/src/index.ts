/**
 * Shared Zod schemas and TypeScript types for Claude Multi-Chat
 * Used by both client and server for type-safe WebSocket communication
 *
 * Pattern: Define Zod schema, then infer TypeScript type from it.
 * This gives us runtime validation + compile-time types from a single source.
 */

import { z } from 'zod';

// =============================================================================
// Provider-Specific Types (re-exported)
// =============================================================================

// Claude CLI types - strict type definitions for Claude CLI stream-json protocol
export {
  // Content block types
  type ClaudeTextBlock,
  type ClaudeToolUseBlock,
  type ClaudeToolResultBlock,
  type ClaudeContentBlock,
  // Output types from CLI stdout
  type ClaudeSystemInitOutput,
  type ClaudeToolDefinition,
  type ClaudeMcpServer,
  type ClaudeAssistantOutput,
  type ClaudeResultSuccessOutput,
  type ClaudeResultErrorOutput,
  type ClaudeResultOutput,
  type ClaudeUserOutput,
  type ClaudeCliOutput,
  // Input types to CLI stdin
  type ClaudeCliInput,
  // Unified internal event types
  type ClaudeEventMessageStart,
  type ClaudeEventTextDelta,
  type ClaudeEventMessageComplete,
  type ClaudeEventToolUse,
  type ClaudeEventError,
  type ClaudeEvent,
  // Type guards
  isClaudeSystemInitOutput,
  isClaudeAssistantOutput,
  isClaudeResultSuccessOutput,
  isClaudeResultErrorOutput,
  isClaudeResultOutput,
  isClaudeUserOutput,
  isClaudeTextBlock,
  isClaudeToolUseBlock,
  isClaudeToolResultBlock,
  // Parser functions and error class
  ClaudeParseError,
  parseClaudeCliOutput,
  parseClaudeCliOutputStream,
  formatClaudeCliInput,
  // Utility functions
  extractTextFromContentBlocks,
  extractToolUseFromContentBlocks,
} from './providers/claude.types';

// Codex CLI types - strict type definitions for Codex CLI JSON protocol
export {
  // Output schemas and types
  CodexStartOutputSchema,
  CodexMessageOutputSchema,
  CodexToolCallOutputSchema,
  CodexToolResultOutputSchema,
  CodexEndOutputSchema,
  CodexDoneOutputSchema,
  CodexOutputSchema,
  type CodexStartOutput,
  type CodexMessageOutput,
  type CodexToolCallOutput,
  type CodexToolResultOutput,
  type CodexEndOutput,
  type CodexDoneOutput,
  type CodexOutput,
  // Input schemas and types
  CodexInputSchema,
  type CodexInput,
  // Unified event schemas and types (normalized to match Claude's structure)
  UnifiedMessageStartEventSchema,
  UnifiedTextDeltaEventSchema,
  UnifiedMessageCompleteEventSchema,
  UnifiedToolUseEventSchema,
  UnifiedToolResultEventSchema,
  UnifiedErrorEventSchema,
  UnifiedCodexEventSchema,
  type UnifiedMessageStartEvent,
  type UnifiedTextDeltaEvent,
  type UnifiedMessageCompleteEvent,
  type UnifiedToolUseEvent,
  type UnifiedToolResultEvent,
  type UnifiedErrorEvent,
  type UnifiedCodexEvent,
  // Type guards
  isCodexStartOutput,
  isCodexMessageOutput,
  isCodexToolCallOutput,
  isCodexToolResultOutput,
  isCodexEndOutput,
  isCodexDoneOutput,
  isCodexTerminationOutput,
  // Parser functions and error class
  CodexParseError,
  parseCodexOutput,
  codexOutputToUnifiedEvent,
  parseCodexOutputToUnifiedEvent,
  formatCodexInput,
} from './providers/codex.types';

// =============================================================================
// Core Data Structures
// =============================================================================

// Provider enum for multi-CLI support (Claude, Codex, OpenCode, etc.)
export const ProviderSchema = z.enum(['claude', 'codex', 'opencode']);
export type Provider = z.infer<typeof ProviderSchema>;

// =============================================================================
// Model Identifiers — per-provider model choices
//
// Each provider defines a union of "model identifiers" that the UI presents
// as a dropdown. These are opaque strings on the client side.
// The server's Provider.modelToParams() decomposes them into CLI flags.
//
// Claude: aliases passed to `claude --model <alias>`
// Codex: composite strings encoding model + effort level
//   e.g. "gpt-5.3-codex-high" → `-m gpt-5.3-codex -c reasoning.effort=high`
// OpenCode: path-style identifiers passed to `opencode run -m <id>`
//   e.g. "opencode/big-pickle" or "opencode/gpt-5-nano"
// We require at least one "/" segment to avoid collisions with Claude/Codex IDs.
// =============================================================================

export const ClaudeModelSchema = z.enum(['opus', 'sonnet', 'haiku']);
export type ClaudeModel = z.infer<typeof ClaudeModelSchema>;

export const CodexModelSchema = z.enum([
  'gpt-5.3-codex-medium', 'gpt-5.3-codex-high', 'gpt-5.3-codex-xhigh',
  'gpt-5.3-codex-spark',
  'gpt-5.3-codex-spark-medium', 'gpt-5.3-codex-spark-high', 'gpt-5.3-codex-spark-xhigh',
]);
export type CodexModel = z.infer<typeof CodexModelSchema>;

export type OpenCodeModel = `${string}/${string}`;

// "provider/model" path-style ID (allows additional segments like "openrouter/openai/gpt-5").
// Allowed chars keep to typical provider/model slugs and version suffixes.
const OPENCODE_MODEL_ID_REGEX = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._:+-]*)+$/i;

export const OpenCodeModelSchema = z.custom<OpenCodeModel>(
  (value): value is OpenCodeModel => typeof value === 'string' && OPENCODE_MODEL_ID_REGEX.test(value),
  {
    message: "Invalid OpenCode model identifier. Expected 'provider/model' format (e.g. 'opencode/big-pickle').",
  }
);

export const ModelIdSchema = z.union([ClaudeModelSchema, CodexModelSchema, OpenCodeModelSchema]);
export type ModelId = z.infer<typeof ModelIdSchema>;

/** Display metadata returned by Provider.listModels() for the model dropdown */
export const ModelInfoSchema = z.object({
  id: ModelIdSchema,
  displayName: z.string(),
  isDefault: z.boolean(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  timestamp: z.coerce.date(),
  isLoopMarker: z.boolean().optional(),
  loopIteration: z.number().int().positive().optional(),   // Which iteration (1-based) this msg belongs to
  loopTotal: z.number().int().positive().optional(),        // Total iterations in the loop run
});

export type Message = z.infer<typeof MessageSchema>;

export const LoopConfigSchema = z.object({
  totalIterations: z.number().int().positive(),
  currentIteration: z.number().int().nonnegative(),
  loopsRemaining: z.number().int().nonnegative(),
  clearContext: z.boolean(),
  prompt: z.string(),
  isLooping: z.boolean(),
});

export type LoopConfig = z.infer<typeof LoopConfigSchema>;

// =============================================================================
// Sub-Agent Types (for Task tool detection)
// =============================================================================

export const SubAgentStatusSchema = z.enum(['pending', 'running', 'completed', 'error']);
export type SubAgentStatus = z.infer<typeof SubAgentStatusSchema>;

export const SubAgentSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: SubAgentStatusSchema,
  toolUses: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  currentAction: z.string().optional(),  // e.g., "Write: client/src/App.css"
  startedAt: z.coerce.date(),
  completedAt: z.coerce.date().optional(),
});

export type SubAgent = z.infer<typeof SubAgentSchema>;

// Queue types (shared between server state and client display).
// Queue is for real messages only — loop state is read from loopConfig.
export const QueuedMessageSchema = z.object({
  id: z.string(),
  content: z.string(),
  queuedAt: z.coerce.date(),
  status: z.enum(['pending', 'sending']),
});

export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

// CONVERSATION STATE MODEL
// ========================
// Two server-authoritative flags + one client-only flag:
//
//   isRunning   (server-authoritative via 'status' broadcasts)
//     Process is alive. true on spawn, false on close.
//     Drives: spawn guard, queue processing, sidebar/gallery indicators.
//
//   isStreaming  (server-authoritative via 'status' broadcasts)
//     Assistant is actively producing content. true on first text_delta,
//     false on message_complete or process close (whichever comes first).
//     Drives: typing dots, pulse animation, scroll behavior.
//     INVARIANT: !isRunning → !isStreaming (enforced in close handler).
//     A dead process cannot produce content.
//
//   confirmed   (client-only, from 'conversation_created')
//     Server has acknowledged this conversation. false only in the
//     optimistic stub between createConversation() and server confirmation.
//     Drives: input gating ("Waiting for claude...").
//
// Broadcast sequence on normal completion:
//   1. message_complete  → server sets isStreaming=false, broadcasts status
//   2. process close     → server sets isRunning=false, broadcasts status
//   3. queue_updated     → client mirrors updated queue
//   4. processQueue()    → server spawns next message if queued
//
// MESSAGE AUTHORITY MODEL
// =======================
// Claude conversations: JSONL is authoritative (Claude CLI writes its own file).
//   The server relays streaming content but the poller's JSONL-parsed messages
//   are the canonical version. conversations_updated correctly replaces client state.
//
// Codex conversations: Server memory is authoritative while a turn is active.
//   The server builds messages from streaming stdout, while Codex CLI also
//   self-persists native session files under ~/.codex/sessions.
//   The poller skips active session IDs and rehydrates idle/reloaded sessions
//   from persisted files.
export const ConversationSchema = z.object({
  id: z.string().uuid(),
  messages: z.array(MessageSchema),
  isRunning: z.boolean(),
  // Server-authoritative: assistant is actively producing content.
  // true on first text_delta, false on message_complete or process close.
  // INVARIANT: !isRunning → !isStreaming (dead process can't stream).
  isStreaming: z.boolean().default(false),
  // Server has confirmed this conversation exists. Only false in the client's
  // optimistic stub (between createConversation and conversation_created).
  // Server always sends true — it only serializes conversations it owns.
  confirmed: z.boolean().default(true),
  createdAt: z.coerce.date(),
  workingDirectory: z.string(),
  loopConfig: LoopConfigSchema.nullable().optional(),
  provider: ProviderSchema.default('claude'),
  model: ModelIdSchema.optional(),  // Provider-specific model identifier (undefined = provider default)
  subAgents: z.array(SubAgentSchema).default([]),  // Active/recent sub-agents
  queue: z.array(QueuedMessageSchema).default([]),  // Server-owned message queue
  // Oompa worker detection: true if first user message started with "[oompa]".
  // Workers are hidden from main Gallery/Sidebar and shown in a dedicated Workers section.
  // Tag format: [oompa], [oompa:<swarmId>], or [oompa:<swarmId>:<workerId>]
  isWorker: z.boolean().default(false),
  // Swarm grouping: all workers from the same oompa swarm run share a swarmId.
  // Parsed from [oompa:<swarmId>:...] tag on first user message.
  swarmId: z.string().nullish(),
  // Worker identity within a swarm (e.g., "w0", "claude-0").
  // Parsed from [oompa:...:<workerId>] tag on first user message.
  workerId: z.string().nullish(),
  // Worker role within the swarm — inferred from first user message content.
  // "work" = normal task execution, "review" = code review (contains diff + VERDICT),
  // "fix" = fixing reviewer feedback (starts with "The reviewer found issues").
  // Null for non-workers or when role can't be determined.
  workerRole: z.enum(['work', 'review', 'fix']).nullish(),
  // Optional parent conversation id for provider-native spawned sub-agent threads
  // (e.g., Codex thread_spawn parent_thread_id).
  // When present, UI can render this conversation nested under its parent.
  parentConversationId: z.string().nullish(),
  // The actual model name from the CLI (e.g., "claude-sonnet-4-5-20250929").
  // More specific than `provider` which is just "claude", "codex", or "opencode".
  modelName: z.string().nullish(),
});

export type Conversation = z.infer<typeof ConversationSchema>;

// =============================================================================
// Client → Server Messages
// =============================================================================

export const NewConversationMessageSchema = z.object({
  type: z.literal('new_conversation'),
  id: z.string().uuid().optional(), // Client-generated UUID for optimistic insert
  workingDirectory: z.string().optional(),
  provider: ProviderSchema.optional(), // Defaults to 'claude' when not specified
  model: ModelIdSchema.optional(),     // Provider-specific model (undefined = provider default)
});

export type NewConversationMessage = z.infer<typeof NewConversationMessageSchema>;

export const SendMessageMessageSchema = z.object({
  type: z.literal('send_message'),
  conversationId: z.string().uuid(),
  content: z.string().min(1),
});

export type SendMessageMessage = z.infer<typeof SendMessageMessageSchema>;

export const StopConversationMessageSchema = z.object({
  type: z.literal('stop_conversation'),
  conversationId: z.string().uuid(),
});

export type StopConversationMessage = z.infer<typeof StopConversationMessageSchema>;

export const DeleteConversationMessageSchema = z.object({
  type: z.literal('delete_conversation'),
  conversationId: z.string().uuid(),
});

export type DeleteConversationMessage = z.infer<typeof DeleteConversationMessageSchema>;

// Loop Messages (Client → Server)
export const StartLoopMessageSchema = z.object({
  type: z.literal('start_loop'),
  conversationId: z.string().uuid(),
  prompt: z.string().min(1),
  iterations: z.enum(['5', '10', '20']),
  clearContext: z.boolean(),
});

export type StartLoopMessage = z.infer<typeof StartLoopMessageSchema>;

export const CancelLoopMessageSchema = z.object({
  type: z.literal('cancel_loop'),
  conversationId: z.string().uuid(),
});

export type CancelLoopMessage = z.infer<typeof CancelLoopMessageSchema>;

export const SetModelMessageSchema = z.object({
  type: z.literal('set_model'),
  conversationId: z.string().uuid(),
  model: ModelIdSchema.optional(),
});

export type SetModelMessage = z.infer<typeof SetModelMessageSchema>;

// Queue Messages (Client → Server)
export const QueueMessageSchema = z.object({
  type: z.literal('queue_message'),
  conversationId: z.string().uuid(),
  content: z.string().min(1),
});

export type QueueMessage = z.infer<typeof QueueMessageSchema>;

export const CancelQueuedMessageSchema = z.object({
  type: z.literal('cancel_queued_message'),
  conversationId: z.string().uuid(),
  messageId: z.string(),
});

export type CancelQueuedMessage = z.infer<typeof CancelQueuedMessageSchema>;

export const ClearQueueMessageSchema = z.object({
  type: z.literal('clear_queue'),
  conversationId: z.string().uuid(),
});

export type ClearQueueMessage = z.infer<typeof ClearQueueMessageSchema>;

export const ClientMessageSchema = z.discriminatedUnion('type', [
  NewConversationMessageSchema,
  SendMessageMessageSchema,
  StopConversationMessageSchema,
  DeleteConversationMessageSchema,
  StartLoopMessageSchema,
  CancelLoopMessageSchema,
  SetModelMessageSchema,
  QueueMessageSchema,
  CancelQueuedMessageSchema,
  ClearQueueMessageSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// =============================================================================
// Server → Client Messages
// =============================================================================

export const InitMessageSchema = z.object({
  type: z.literal('init'),
  conversations: z.array(ConversationSchema),
  defaultCwd: z.string(),
  /** True if server is still loading conversations from disk. Client should wait for conversations_updated. */
  loading: z.boolean().optional(),
});

export type InitMessage = z.infer<typeof InitMessageSchema>;

export const ConversationCreatedMessageSchema = z.object({
  type: z.literal('conversation_created'),
  conversation: ConversationSchema,
});

export type ConversationCreatedMessage = z.infer<typeof ConversationCreatedMessageSchema>;

export const ConversationDeletedMessageSchema = z.object({
  type: z.literal('conversation_deleted'),
  conversationId: z.string().uuid(),
});

export type ConversationDeletedMessage = z.infer<typeof ConversationDeletedMessageSchema>;

export const MessageMessageSchema = z.object({
  type: z.literal('message'),
  conversationId: z.string().uuid(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
});

export type MessageMessage = z.infer<typeof MessageMessageSchema>;

export const ChunkMessageSchema = z.object({
  type: z.literal('chunk'),
  conversationId: z.string().uuid(),
  text: z.string(),
});

export type ChunkMessage = z.infer<typeof ChunkMessageSchema>;

export const MessageCompleteMessageSchema = z.object({
  type: z.literal('message_complete'),
  conversationId: z.string().uuid(),
});

export type MessageCompleteMessage = z.infer<typeof MessageCompleteMessageSchema>;

export const StatusMessageSchema = z.object({
  type: z.literal('status'),
  conversationId: z.string().uuid(),
  isRunning: z.boolean(),
  isStreaming: z.boolean(),
});

export type StatusMessage = z.infer<typeof StatusMessageSchema>;

export const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});

export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

// Loop Messages (Server → Client)
export const LoopIterationStartMessageSchema = z.object({
  type: z.literal('loop_iteration_start'),
  conversationId: z.string().uuid(),
  currentIteration: z.number(),
  totalIterations: z.number(),
});

export type LoopIterationStartMessage = z.infer<typeof LoopIterationStartMessageSchema>;

export const LoopIterationEndMessageSchema = z.object({
  type: z.literal('loop_iteration_end'),
  conversationId: z.string().uuid(),
  currentIteration: z.number(),
  totalIterations: z.number(),
  loopsRemaining: z.number(),
});

export type LoopIterationEndMessage = z.infer<typeof LoopIterationEndMessageSchema>;

export const LoopCompleteMessageSchema = z.object({
  type: z.literal('loop_complete'),
  conversationId: z.string().uuid(),
  totalIterations: z.number(),
});

export type LoopCompleteMessage = z.infer<typeof LoopCompleteMessageSchema>;

// Sub-Agent Messages (Server -> Client)
export const SubAgentStartMessageSchema = z.object({
  type: z.literal('subagent_start'),
  conversationId: z.string().uuid(),
  subAgent: SubAgentSchema,
});

export type SubAgentStartMessage = z.infer<typeof SubAgentStartMessageSchema>;

export const SubAgentUpdateMessageSchema = z.object({
  type: z.literal('subagent_update'),
  conversationId: z.string().uuid(),
  subAgentId: z.string(),
  toolUses: z.number().int().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
  currentAction: z.string().optional(),
  status: SubAgentStatusSchema.optional(),
});

export type SubAgentUpdateMessage = z.infer<typeof SubAgentUpdateMessageSchema>;

export const SubAgentCompleteMessageSchema = z.object({
  type: z.literal('subagent_complete'),
  conversationId: z.string().uuid(),
  subAgentId: z.string(),
  status: z.enum(['completed', 'error']),
  completedAt: z.coerce.date(),
});

export type SubAgentCompleteMessage = z.infer<typeof SubAgentCompleteMessageSchema>;

// Queue update broadcast (Server → Client)
export const QueueUpdatedMessageSchema = z.object({
  type: z.literal('queue_updated'),
  conversationId: z.string().uuid(),
  queue: z.array(QueuedMessageSchema),
});

export type QueueUpdatedMessage = z.infer<typeof QueueUpdatedMessageSchema>;

// File polling: server detected external changes to JSONL files
export const ConversationsUpdatedMessageSchema = z.object({
  type: z.literal('conversations_updated'),
  conversations: z.array(ConversationSchema),
});

export type ConversationsUpdatedMessage = z.infer<typeof ConversationsUpdatedMessageSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  InitMessageSchema,
  ConversationCreatedMessageSchema,
  ConversationDeletedMessageSchema,
  MessageMessageSchema,
  ChunkMessageSchema,
  MessageCompleteMessageSchema,
  StatusMessageSchema,
  ErrorMessageSchema,
  LoopIterationStartMessageSchema,
  LoopIterationEndMessageSchema,
  LoopCompleteMessageSchema,
  SubAgentStartMessageSchema,
  SubAgentUpdateMessageSchema,
  SubAgentCompleteMessageSchema,
  ConversationsUpdatedMessageSchema,
  QueueUpdatedMessageSchema,
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Parse and validate a client message. Throws ZodError if invalid.
 */
export function parseClientMessage(data: unknown): ClientMessage {
  return ClientMessageSchema.parse(data);
}

/**
 * Safely parse a client message. Returns success/error result.
 */
export function safeParseClientMessage(data: unknown) {
  return ClientMessageSchema.safeParse(data);
}

/**
 * Parse and validate a server message. Throws ZodError if invalid.
 */
export function parseServerMessage(data: unknown): ServerMessage {
  return ServerMessageSchema.parse(data);
}

/**
 * Safely parse a server message. Returns success/error result.
 */
export function safeParseServerMessage(data: unknown) {
  return ServerMessageSchema.safeParse(data);
}

// =============================================================================
// Type Guards (for backwards compatibility)
// =============================================================================

export function isClientMessage(msg: unknown): msg is ClientMessage {
  return ClientMessageSchema.safeParse(msg).success;
}

export function isServerMessage(msg: unknown): msg is ServerMessage {
  return ServerMessageSchema.safeParse(msg).success;
}

// =============================================================================
// JSONL Adapter Types (for persistence layer)
// =============================================================================

export {
  // Content block types
  JsonlTextBlockSchema,
  JsonlThinkingBlockSchema,
  JsonlToolUseBlockSchema,
  JsonlToolResultBlockSchema,
  JsonlContentBlockSchema,
  type JsonlTextBlock,
  type JsonlThinkingBlock,
  type JsonlToolUseBlock,
  type JsonlToolResultBlock,
  type JsonlContentBlock,
  // Entry types
  JsonlUserEntrySchema,
  JsonlAssistantEntrySchema,
  JsonlProgressEntrySchema,
  JsonlSystemEntrySchema,
  JsonlFileHistorySnapshotEntrySchema,
  JsonlQueueOperationEntrySchema,
  JsonlEntrySchema,
  type JsonlUserEntry,
  type JsonlAssistantEntry,
  type JsonlProgressEntry,
  type JsonlSystemEntry,
  type JsonlFileHistorySnapshotEntry,
  type JsonlQueueOperationEntry,
  type JsonlEntry,
  type JsonlSession,
  // Type guards
  isJsonlUserEntry,
  isJsonlAssistantEntry,
  isJsonlTextBlock,
  isJsonlThinkingBlock,
  isJsonlToolUseBlock,
  isJsonlToolResultBlock,
} from './adapters/jsonl.types';

// Codex Native Session Types (for reading ~/.codex/sessions/)
export {
  // Schemas
  CodexSessionMetaSchema,
  CodexResponseMessageSchema,
  CodexFunctionCallSchema,
  CodexFunctionCallOutputSchema,
  CodexUserMessageEventSchema,
  CodexAgentMessageEventSchema,
  CodexTurnContextSchema,
  CodexSessionEntrySchema,
  // Types
  type CodexSessionMeta,
  type CodexResponseMessage,
  type CodexFunctionCall,
  type CodexFunctionCallOutput,
  type CodexUserMessageEvent,
  type CodexAgentMessageEvent,
  type CodexTurnContext,
  type CodexSessionEntry,
  type CodexParsedSession,
  // Type guards
  isCodexSessionMeta,
  isCodexResponseMessage,
  isCodexFunctionCall,
  isCodexFunctionCallOutput,
  isCodexUserMessageEvent,
  isCodexAgentMessageEvent,
} from './adapters/codex-session.types';
