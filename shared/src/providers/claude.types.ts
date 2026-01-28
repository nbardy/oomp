/**
 * Claude CLI Input/Output Type Definitions
 *
 * Strict type definitions for Claude CLI with --output-format=stream-json
 * These types define the contract between Claude CLI stdout/stdin and our application.
 *
 * IMPORTANT: These types are strict - no `any`, no fallbacks.
 * Unknown types will throw errors at parse time.
 */

// =============================================================================
// Claude CLI Output Types (stdout from `claude --output-format=stream-json`)
// =============================================================================

/**
 * Content block types that can appear in assistant messages
 */
export interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

export interface ClaudeToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock;

/**
 * System init message - sent at the start of a session
 * Format: {"type":"system","subtype":"init",...}
 */
export interface ClaudeSystemInitOutput {
  type: 'system';
  subtype: 'init';
  session_id: string;
  tools: ClaudeToolDefinition[];
  mcp_servers: ClaudeMcpServer[];
  model: string;
  cwd: string;
  allowed_tools?: string[];
}

export interface ClaudeToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ClaudeMcpServer {
  name: string;
  status: 'connected' | 'disconnected' | 'error';
}

/**
 * Assistant message - contains the AI response content
 * Format: {"type":"assistant","message":{"content":[...],...}}
 */
export interface ClaudeAssistantOutput {
  type: 'assistant';
  message: {
    id: string;
    type: 'message';
    role: 'assistant';
    content: ClaudeContentBlock[];
    model: string;
    stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
    stop_sequence: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

/**
 * Result message - indicates success or error at the end of a response
 * Format: {"type":"result","subtype":"success"|"error",...}
 */
export interface ClaudeResultSuccessOutput {
  type: 'result';
  subtype: 'success';
  result: string;
  is_error: false;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  session_id: string;
  cost_usd?: number;
  total_cost_usd?: number;
}

export interface ClaudeResultErrorOutput {
  type: 'result';
  subtype: 'error';
  error: string;
  is_error: true;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  session_id: string;
}

export type ClaudeResultOutput =
  | ClaudeResultSuccessOutput
  | ClaudeResultErrorOutput;

/**
 * User message echo - confirms what was sent
 * Format: {"type":"user","message":{"content":[...],...}}
 */
export interface ClaudeUserOutput {
  type: 'user';
  message: {
    role: 'user';
    content: ClaudeContentBlock[];
  };
}

/**
 * Discriminated union of all Claude CLI output types
 */
export type ClaudeCliOutput =
  | ClaudeSystemInitOutput
  | ClaudeAssistantOutput
  | ClaudeResultOutput
  | ClaudeUserOutput;

// =============================================================================
// Claude CLI Input Types (stdin to Claude CLI)
// =============================================================================

/**
 * Input to Claude CLI - plain text string followed by newline
 * The CLI expects raw text input on stdin, not JSON.
 */
export interface ClaudeCliInput {
  /** The user message text to send to Claude */
  text: string;
}

// =============================================================================
// Unified Internal Event Types
// =============================================================================

/**
 * Internal event types for processing Claude CLI output
 * These are the events we emit after parsing CLI output
 */
export interface ClaudeEventMessageStart {
  type: 'message_start';
  sessionId: string;
  model: string;
}

export interface ClaudeEventTextDelta {
  type: 'text_delta';
  text: string;
}

export interface ClaudeEventMessageComplete {
  type: 'message_complete';
  content: ClaudeContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
}

export interface ClaudeEventToolUse {
  type: 'tool_use';
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ClaudeEventError {
  type: 'error';
  error: string;
  isCliError: boolean;
}

/**
 * Discriminated union of all internal Claude events
 */
export type ClaudeEvent =
  | ClaudeEventMessageStart
  | ClaudeEventTextDelta
  | ClaudeEventMessageComplete
  | ClaudeEventToolUse
  | ClaudeEventError;

// =============================================================================
// Type Guard Functions
// =============================================================================

/**
 * Type guard for ClaudeSystemInitOutput
 */
export function isClaudeSystemInitOutput(
  output: unknown
): output is ClaudeSystemInitOutput {
  if (typeof output !== 'object' || output === null) return false;
  const obj = output as Record<string, unknown>;
  return obj.type === 'system' && obj.subtype === 'init';
}

/**
 * Type guard for ClaudeAssistantOutput
 */
export function isClaudeAssistantOutput(
  output: unknown
): output is ClaudeAssistantOutput {
  if (typeof output !== 'object' || output === null) return false;
  const obj = output as Record<string, unknown>;
  return (
    obj.type === 'assistant' &&
    typeof obj.message === 'object' &&
    obj.message !== null
  );
}

/**
 * Type guard for ClaudeResultSuccessOutput
 */
export function isClaudeResultSuccessOutput(
  output: unknown
): output is ClaudeResultSuccessOutput {
  if (typeof output !== 'object' || output === null) return false;
  const obj = output as Record<string, unknown>;
  return (
    obj.type === 'result' &&
    obj.subtype === 'success' &&
    obj.is_error === false
  );
}

/**
 * Type guard for ClaudeResultErrorOutput
 */
export function isClaudeResultErrorOutput(
  output: unknown
): output is ClaudeResultErrorOutput {
  if (typeof output !== 'object' || output === null) return false;
  const obj = output as Record<string, unknown>;
  return (
    obj.type === 'result' &&
    obj.subtype === 'error' &&
    obj.is_error === true
  );
}

/**
 * Type guard for ClaudeResultOutput (success or error)
 */
export function isClaudeResultOutput(
  output: unknown
): output is ClaudeResultOutput {
  return (
    isClaudeResultSuccessOutput(output) || isClaudeResultErrorOutput(output)
  );
}

/**
 * Type guard for ClaudeUserOutput
 */
export function isClaudeUserOutput(
  output: unknown
): output is ClaudeUserOutput {
  if (typeof output !== 'object' || output === null) return false;
  const obj = output as Record<string, unknown>;
  return (
    obj.type === 'user' &&
    typeof obj.message === 'object' &&
    obj.message !== null
  );
}

/**
 * Type guard for ClaudeTextBlock
 */
export function isClaudeTextBlock(
  block: unknown
): block is ClaudeTextBlock {
  if (typeof block !== 'object' || block === null) return false;
  const obj = block as Record<string, unknown>;
  return obj.type === 'text' && typeof obj.text === 'string';
}

/**
 * Type guard for ClaudeToolUseBlock
 */
export function isClaudeToolUseBlock(
  block: unknown
): block is ClaudeToolUseBlock {
  if (typeof block !== 'object' || block === null) return false;
  const obj = block as Record<string, unknown>;
  return (
    obj.type === 'tool_use' &&
    typeof obj.id === 'string' &&
    typeof obj.name === 'string'
  );
}

/**
 * Type guard for ClaudeToolResultBlock
 */
export function isClaudeToolResultBlock(
  block: unknown
): block is ClaudeToolResultBlock {
  if (typeof block !== 'object' || block === null) return false;
  const obj = block as Record<string, unknown>;
  return (
    obj.type === 'tool_result' &&
    typeof obj.tool_use_id === 'string'
  );
}

// =============================================================================
// Parser Function
// =============================================================================

/**
 * Error thrown when parsing encounters an unknown type
 */
export class ClaudeParseError extends Error {
  constructor(
    message: string,
    public readonly rawData: unknown
  ) {
    super(message);
    this.name = 'ClaudeParseError';
  }
}

/**
 * Parse a JSON line from Claude CLI stdout into a typed output.
 * Throws ClaudeParseError if the type is unknown or invalid.
 *
 * @param jsonLine - A single JSON line from Claude CLI stdout
 * @returns Parsed and typed ClaudeCliOutput
 * @throws ClaudeParseError if the JSON is invalid or type is unknown
 */
export function parseClaudeCliOutput(jsonLine: string): ClaudeCliOutput {
  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonLine);
  } catch (e) {
    throw new ClaudeParseError(
      `Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}`,
      jsonLine
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ClaudeParseError(
      'Expected JSON object, got: ' + typeof parsed,
      parsed
    );
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.type !== 'string') {
    throw new ClaudeParseError(
      'Missing or invalid "type" field in Claude CLI output',
      parsed
    );
  }

  // Use type guards to validate and narrow the type
  if (isClaudeSystemInitOutput(parsed)) {
    return parsed;
  }

  if (isClaudeAssistantOutput(parsed)) {
    return parsed;
  }

  if (isClaudeResultSuccessOutput(parsed)) {
    return parsed;
  }

  if (isClaudeResultErrorOutput(parsed)) {
    return parsed;
  }

  if (isClaudeUserOutput(parsed)) {
    return parsed;
  }

  // Unknown type - throw error with details
  throw new ClaudeParseError(
    `Unknown Claude CLI output type: "${obj.type}"${
      obj.subtype ? ` (subtype: "${obj.subtype}")` : ''
    }`,
    parsed
  );
}

/**
 * Parse multiple JSON lines from Claude CLI stdout.
 * Each line should be a complete JSON object.
 *
 * @param output - Multi-line string from Claude CLI stdout
 * @returns Array of parsed outputs
 * @throws ClaudeParseError if any line fails to parse
 */
export function parseClaudeCliOutputStream(output: string): ClaudeCliOutput[] {
  const lines = output.split('\n').filter((line) => line.trim().length > 0);
  return lines.map(parseClaudeCliOutput);
}

/**
 * Create a CLI input string from text.
 * Ensures the input is properly formatted for stdin.
 *
 * @param text - The user message text
 * @returns Formatted string ready to write to CLI stdin
 */
export function formatClaudeCliInput(text: string): string {
  // Claude CLI expects plain text followed by newline
  return text + '\n';
}

/**
 * Extract all text content from Claude content blocks
 *
 * @param blocks - Array of content blocks from assistant message
 * @returns Concatenated text from all text blocks
 */
export function extractTextFromContentBlocks(
  blocks: ClaudeContentBlock[]
): string {
  return blocks
    .filter(isClaudeTextBlock)
    .map((block) => block.text)
    .join('');
}

/**
 * Extract all tool use blocks from Claude content blocks
 *
 * @param blocks - Array of content blocks from assistant message
 * @returns Array of tool use blocks
 */
export function extractToolUseFromContentBlocks(
  blocks: ClaudeContentBlock[]
): ClaudeToolUseBlock[] {
  return blocks.filter(isClaudeToolUseBlock);
}
