/**
 * Strict type definitions for Codex CLI input and output formats.
 *
 * These types define the JSON message protocol used when communicating with
 * Codex CLI via `exec --json`. The CLI outputs newline-delimited JSON messages
 * to stdout, and accepts plain text input via stdin.
 *
 * IMPORTANT: These types are intentionally strict - no `any`, no fallbacks.
 * Unknown message types will cause parse errors, ensuring we catch protocol
 * changes immediately rather than silently dropping messages.
 *
 * Output Protocol (CLI stdout):
 *   - Each line is a complete JSON object
 *   - Messages are discriminated by the `type` field
 *   - Types: start, message, tool_call, tool_result, end, done
 *
 * Input Protocol (CLI stdin):
 *   - Plain text string followed by newline
 *   - No JSON encoding required for input
 */

import { z } from 'zod';

// =============================================================================
// Codex CLI Output Types (from CLI stdout)
// =============================================================================

/**
 * Emitted when the CLI session starts.
 * This is the first message received after launching the CLI.
 */
export const CodexStartOutputSchema = z.object({
  type: z.literal('start'),
});
export type CodexStartOutput = z.infer<typeof CodexStartOutputSchema>;

/**
 * Emitted when the assistant sends a text message.
 * The content field contains the assistant's response text.
 */
export const CodexMessageOutputSchema = z.object({
  type: z.literal('message'),
  content: z.string(),
});
export type CodexMessageOutput = z.infer<typeof CodexMessageOutputSchema>;

/**
 * Emitted when the assistant requests a tool/shell command execution.
 * The `tool` field indicates the tool type (e.g., "shell").
 * The `command` field contains the command to execute.
 */
export const CodexToolCallOutputSchema = z.object({
  type: z.literal('tool_call'),
  tool: z.string(),
  command: z.string(),
});
export type CodexToolCallOutput = z.infer<typeof CodexToolCallOutputSchema>;

/**
 * Emitted when a tool execution completes.
 * The output field contains the result of the tool execution.
 */
export const CodexToolResultOutputSchema = z.object({
  type: z.literal('tool_result'),
  output: z.string(),
});
export type CodexToolResultOutput = z.infer<typeof CodexToolResultOutputSchema>;

/**
 * Emitted when the CLI session ends (variant 1).
 * Indicates the conversation turn is complete.
 */
export const CodexEndOutputSchema = z.object({
  type: z.literal('end'),
});
export type CodexEndOutput = z.infer<typeof CodexEndOutputSchema>;

/**
 * Emitted when the CLI session ends (variant 2).
 * Alternative termination signal - semantically equivalent to 'end'.
 */
export const CodexDoneOutputSchema = z.object({
  type: z.literal('done'),
});
export type CodexDoneOutput = z.infer<typeof CodexDoneOutputSchema>;

/**
 * Discriminated union of all possible Codex CLI output message types.
 * Use type guards or switch statements on the `type` field to narrow.
 */
export const CodexOutputSchema = z.discriminatedUnion('type', [
  CodexStartOutputSchema,
  CodexMessageOutputSchema,
  CodexToolCallOutputSchema,
  CodexToolResultOutputSchema,
  CodexEndOutputSchema,
  CodexDoneOutputSchema,
]);
export type CodexOutput = z.infer<typeof CodexOutputSchema>;

// =============================================================================
// Codex CLI Input Types (to CLI stdin)
// =============================================================================

/**
 * Input message sent to Codex CLI via stdin.
 * The CLI expects plain text followed by a newline - no JSON encoding.
 */
export const CodexInputSchema = z.object({
  /** The user's message text to send to the CLI */
  text: z.string(),
});
export type CodexInput = z.infer<typeof CodexInputSchema>;

// =============================================================================
// Unified Event Types (matching Claude's event structure)
// =============================================================================

/**
 * Unified event types that normalize Codex CLI outputs to match Claude's
 * event structure. This allows the application to handle both providers
 * with a consistent interface.
 *
 * Mapping from Codex outputs to unified events:
 *   - start        -> message_start
 *   - message      -> text_delta (streaming text content)
 *   - tool_call    -> tool_use
 *   - tool_result  -> tool_result (passthrough)
 *   - end/done     -> message_complete
 *   - parse errors -> error
 */

export const UnifiedMessageStartEventSchema = z.object({
  type: z.literal('message_start'),
});
export type UnifiedMessageStartEvent = z.infer<typeof UnifiedMessageStartEventSchema>;

export const UnifiedTextDeltaEventSchema = z.object({
  type: z.literal('text_delta'),
  text: z.string(),
});
export type UnifiedTextDeltaEvent = z.infer<typeof UnifiedTextDeltaEventSchema>;

export const UnifiedMessageCompleteEventSchema = z.object({
  type: z.literal('message_complete'),
});
export type UnifiedMessageCompleteEvent = z.infer<typeof UnifiedMessageCompleteEventSchema>;

export const UnifiedToolUseEventSchema = z.object({
  type: z.literal('tool_use'),
  tool: z.string(),
  command: z.string(),
});
export type UnifiedToolUseEvent = z.infer<typeof UnifiedToolUseEventSchema>;

export const UnifiedToolResultEventSchema = z.object({
  type: z.literal('tool_result'),
  output: z.string(),
});
export type UnifiedToolResultEvent = z.infer<typeof UnifiedToolResultEventSchema>;

export const UnifiedErrorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  /** The raw data that caused the error, if available */
  rawData: z.string().optional(),
});
export type UnifiedErrorEvent = z.infer<typeof UnifiedErrorEventSchema>;

/**
 * Discriminated union of all unified event types.
 * This provides a consistent interface for handling events from any provider.
 */
export const UnifiedCodexEventSchema = z.discriminatedUnion('type', [
  UnifiedMessageStartEventSchema,
  UnifiedTextDeltaEventSchema,
  UnifiedMessageCompleteEventSchema,
  UnifiedToolUseEventSchema,
  UnifiedToolResultEventSchema,
  UnifiedErrorEventSchema,
]);
export type UnifiedCodexEvent = z.infer<typeof UnifiedCodexEventSchema>;

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard for CodexStartOutput.
 * Returns true if the output is a start message.
 */
export function isCodexStartOutput(output: CodexOutput): output is CodexStartOutput {
  return output.type === 'start';
}

/**
 * Type guard for CodexMessageOutput.
 * Returns true if the output is a message with text content.
 */
export function isCodexMessageOutput(output: CodexOutput): output is CodexMessageOutput {
  return output.type === 'message';
}

/**
 * Type guard for CodexToolCallOutput.
 * Returns true if the output is a tool call request.
 */
export function isCodexToolCallOutput(output: CodexOutput): output is CodexToolCallOutput {
  return output.type === 'tool_call';
}

/**
 * Type guard for CodexToolResultOutput.
 * Returns true if the output is a tool execution result.
 */
export function isCodexToolResultOutput(output: CodexOutput): output is CodexToolResultOutput {
  return output.type === 'tool_result';
}

/**
 * Type guard for CodexEndOutput.
 * Returns true if the output is an 'end' termination signal.
 */
export function isCodexEndOutput(output: CodexOutput): output is CodexEndOutput {
  return output.type === 'end';
}

/**
 * Type guard for CodexDoneOutput.
 * Returns true if the output is a 'done' termination signal.
 */
export function isCodexDoneOutput(output: CodexOutput): output is CodexDoneOutput {
  return output.type === 'done';
}

/**
 * Type guard for any termination output (end or done).
 * Returns true if the output signals the end of a conversation turn.
 */
export function isCodexTerminationOutput(
  output: CodexOutput
): output is CodexEndOutput | CodexDoneOutput {
  return output.type === 'end' || output.type === 'done';
}

// =============================================================================
// Parser Functions
// =============================================================================

/**
 * Error thrown when parsing fails due to unknown or invalid message types.
 * This is intentionally strict - we want to catch protocol changes early.
 */
export class CodexParseError extends Error {
  constructor(
    message: string,
    public readonly rawData: string,
    public readonly zodError?: z.ZodError
  ) {
    super(message);
    this.name = 'CodexParseError';
  }
}

/**
 * Parse a JSON string from Codex CLI stdout into a typed CodexOutput.
 *
 * @param jsonString - A single line of JSON from Codex CLI stdout
 * @returns The parsed and validated CodexOutput
 * @throws CodexParseError if the JSON is invalid or has an unknown type
 *
 * @example
 * ```typescript
 * const output = parseCodexOutput('{"type":"message","content":"Hello"}');
 * if (isCodexMessageOutput(output)) {
 *   console.log(output.content); // "Hello"
 * }
 * ```
 */
export function parseCodexOutput(jsonString: string): CodexOutput {
  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    throw new CodexParseError(
      `Invalid JSON from Codex CLI: ${e instanceof Error ? e.message : 'Unknown error'}`,
      jsonString
    );
  }

  const result = CodexOutputSchema.safeParse(parsed);

  if (!result.success) {
    // Extract the type field if present for better error messages
    const typeField =
      typeof parsed === 'object' && parsed !== null && 'type' in parsed
        ? (parsed as Record<string, unknown>).type
        : 'undefined';

    throw new CodexParseError(
      `Unknown or invalid Codex CLI output type: "${typeField}". ` +
        `Expected one of: start, message, tool_call, tool_result, end, done. ` +
        `Validation errors: ${result.error.message}`,
      jsonString,
      result.error
    );
  }

  return result.data;
}

/**
 * Convert a CodexOutput to a UnifiedCodexEvent.
 * This normalizes Codex CLI outputs to match Claude's event structure.
 *
 * @param output - The parsed Codex CLI output
 * @returns The corresponding unified event
 *
 * @example
 * ```typescript
 * const output = parseCodexOutput('{"type":"message","content":"Hello"}');
 * const event = codexOutputToUnifiedEvent(output);
 * // event is { type: 'text_delta', text: 'Hello' }
 * ```
 */
export function codexOutputToUnifiedEvent(output: CodexOutput): UnifiedCodexEvent {
  switch (output.type) {
    case 'start':
      return { type: 'message_start' };
    case 'message':
      return { type: 'text_delta', text: output.content };
    case 'tool_call':
      return { type: 'tool_use', tool: output.tool, command: output.command };
    case 'tool_result':
      return { type: 'tool_result', output: output.output };
    case 'end':
    case 'done':
      return { type: 'message_complete' };
  }
}

/**
 * Parse a JSON string and convert it directly to a UnifiedCodexEvent.
 * This is a convenience function that combines parsing and conversion.
 *
 * @param jsonString - A single line of JSON from Codex CLI stdout
 * @returns The corresponding unified event
 * @throws CodexParseError if the JSON is invalid or has an unknown type
 *
 * @example
 * ```typescript
 * const event = parseCodexOutputToUnifiedEvent('{"type":"start"}');
 * // event is { type: 'message_start' }
 * ```
 */
export function parseCodexOutputToUnifiedEvent(jsonString: string): UnifiedCodexEvent {
  const output = parseCodexOutput(jsonString);
  return codexOutputToUnifiedEvent(output);
}

/**
 * Format a CodexInput for sending to CLI stdin.
 * The CLI expects plain text followed by a newline.
 *
 * @param input - The input to format
 * @returns The formatted string ready to write to stdin
 *
 * @example
 * ```typescript
 * const formatted = formatCodexInput({ text: 'Hello, Codex!' });
 * process.stdin.write(formatted); // Writes "Hello, Codex!\n"
 * ```
 */
export function formatCodexInput(input: CodexInput): string {
  return `${input.text}\n`;
}
