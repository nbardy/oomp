# Agent Client Spec

How CLI agents (Claude, Codex, future) are wrapped and consumed by the server.

## Two Usage Modes

Every agent supports two distinct invocation patterns:

### 1. Conversation Mode (stateful, streaming)

Multi-turn sessions. The server spawns a process per message, parses streaming JSON from stdout, and broadcasts events to WebSocket clients.

**Lifecycle:**
```
spawn(command, args) → write stdin → close stdin → read stdout lines → parse JSON → emit ProviderEvent → process closes
```

**Key properties:**
- Session continuity via provider-specific mechanisms (Claude: `--session-id`/`--resume`, Codex: `exec resume <thread_id>`)
- Streaming output: each stdout line is a JSON object parsed into a `ProviderEvent`
- stdout may split JSON across multiple `data` events — must buffer by newline
- Process exits after each message; a new process is spawned for the next message

**Implemented in:** `Conversation.spawnForMessage()` in `server/src/server.ts`

### 2. Single-Shot Mode (stateless, collect-all)

One prompt in, one response out. No session. Stdout is collected in full, then parsed as a single result.

**Lifecycle:**
```
Claude: spawn('claude', ['-p', prompt, '--output-format', 'text']) → collect stdout → parse
Codex:  spawn('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt]) → collect stdout → parse
```

**Key properties:**
- No session ID, no resume
- Plain text output, not streaming JSON
- Stdout collected as a single string, parsed after process exits
- Used for utility tasks (palette generation, summarization, etc.)

**Implemented in:** `Provider.getSingleShotConfig()` and `POST /api/generate-palette`

## The Provider Interface

Defined in `server/src/providers/index.ts`

```typescript
interface Provider {
  name: ProviderName;                                      // 'claude' | 'codex'
  listModels(): ModelInfo[];                               // Available models for dropdown
  modelToParams(modelId?): string[];                       // Model ID → CLI flags
  getSpawnConfig(sessionId, workingDir, resume?, modelId?): SpawnConfig;
  getSingleShotConfig(prompt): SpawnConfig;                // One-off prompt mode
  formatInput(content): string;
  parseOutput(json): ProviderEvent;                        // MUST return or throw. Never null.
}
```

### SpawnConfig

```typescript
interface SpawnConfig {
  command: string;                             // CLI binary name
  args: string[];                              // CLI arguments
  options: SpawnOptionsWithoutStdio;           // Node spawn options (cwd, env, etc.)
}
```

### ProviderEvent (unified output)

All providers normalize their CLI-specific output into these five event types:

```typescript
type ProviderEvent =
  | { type: 'message_start' }                           // New message beginning (or no-op structural event)
  | { type: 'text_delta'; text: string }                // Streaming text chunk
  | { type: 'message_complete' }                        // Message finished, process will exit
  | { type: 'tool_use'; name: string; input: Record<string, unknown>; displayText?: string }
  | { type: 'error'; message: string }
```

### Contract

1. `parseOutput(json)` MUST return a `ProviderEvent` or throw `ProviderParseError`. No nulls. No fallbacks.
2. Unknown message types throw immediately — they indicate a protocol change we need to handle.
3. `message_start` doubles as a no-op. Structural events that carry no content return `message_start`.
4. `message_complete` signals the server to dequeue the next message and broadcast completion.

## Model Selection

Each provider exposes models via `listModels()` and converts model IDs to CLI flags via `modelToParams()`.

### Claude
```
listModels() → [sonnet (default), opus, haiku]
modelToParams('opus') → ['--model', 'opus']
```

### Codex
```
listModels() → [gpt-5.2-high (default), gpt-5.2-medium, gpt-5.2-xhigh]
modelToParams('gpt-5.2-high') → ['-m', 'gpt-5.2', '-c', 'model_reasoning_effort=high']
```

Codex uses composite model IDs that encode both model name and reasoning effort level. The `modelToParams()` method decomposes them by matching known effort suffixes (`medium`, `high`, `xhigh`).

## How the Server Consumes Providers

### Conversation Flow (server/src/server.ts)

```
1. Conversation created with provider name ('claude' | 'codex') and optional model
2. constructor() calls getProvider(name) to get Provider instance
3. User sends message → queueMessage() → _processQueue() → sendMessage()
4. sendMessage() calls spawnForMessage(content):
   a. provider.getSpawnConfig(sessionId, workingDir, resume, model)
   b. spawn(config.command, config.args, config.options)
   c. stdout.on('data') → buffer by newline → JSON.parse each line
   d. For Codex: intercept thread.started to capture thread_id as sessionId
   e. handleOutput(json) → provider.parseOutput(json) → ProviderEvent
   f. stdin.write(content + '\n') → stdin.end()
5. handleOutput(json):
   a. provider.parseOutput(json) → ProviderEvent
   b. Switch on event.type:
      - message_start: no-op (or create assistant message if needed)
      - text_delta: append to current assistant message, broadcast chunk
      - tool_use: track sub-agents if name === 'Task', broadcast tool info
      - message_complete: broadcast completion, dequeue, persist
      - error: throw
6. process.on('close'): set isRunning = false, broadcast status
```

## Session Management

### Claude
- First message: `--session-id <uuid>` creates a new session
- Subsequent messages: `--resume <uuid>` continues the session
- Tracked by `_hasStartedSession` boolean on Conversation
- `resetProcess()` generates a new session ID for fresh context (used in loop mode)

### Codex
- First message: `codex exec --json -C <workingDir> -` (reads prompt from stdin)
- Codex CLI emits `{"type":"thread.started","thread_id":"<uuid>"}` — the server captures this UUID
- Subsequent messages: `codex exec resume <thread_id> --json -` (reads prompt from stdin)
- The `-` positional argument tells Codex to read the prompt from stdin
- Codex self-persists sessions to `~/.codex/sessions/YYYY/MM/DD/*.jsonl`

## Stdout Parsing

Both providers emit one JSON object per line on stdout.

**Buffering** (`server/src/server.ts`):
- Node `data` events can split a JSON line across multiple chunks
- `_stdoutBuffer` accumulates raw output
- Split by `\n`, process complete lines, keep incomplete tail in buffer
- Each complete line: `JSON.parse()` → `provider.parseOutput()` → `handleOutput()`

**Claude's streaming protocol** (`--output-format stream-json --include-partial-messages`):
- `system` (init) → message_start
- `stream_event` with `content_block_delta` + `text_delta` → text_delta (the actual content)
- `stream_event` with `content_block_start` + `tool_use` → tool_use
- `stream_event` with other event types → message_start (no-op)
- `assistant` (full message after streaming) → message_start (IGNORED — content already arrived via stream_event)
- `result` → message_complete

**Codex's protocol** (`exec --json`):
- `thread.started` → message_start (server also captures thread_id for resume)
- `turn.started` → message_start (no-op)
- `item.started` (command_execution) → tool_use (shows command inline)
- `item.completed` (agent_message) → text_delta (full response text in one event)
- `item.completed` (reasoning) → message_start (hidden from user)
- `item.completed` (command_execution) → text_delta (command output in code block)
- `item.completed` (file_change) → tool_use (shows file paths)
- `turn.completed` → message_complete

## Persistence

### Claude Code
- Self-persists to `~/.claude/projects/{encoded-path}/{session-id}.jsonl`
- Our server reads these on startup and polls for changes (5s interval)
- We never write to Claude's files

### Codex
- Self-persists to `~/.codex/sessions/YYYY/MM/DD/*.jsonl`
- We also write to `~/.claude-web-view/codex/{encoded-path}/{session-id}.jsonl`
- Adapter: `server/src/adapters/codex-persistence.ts`
- Persistence failures logged but never throw

### Loading
- `server/src/adapters/jsonl.ts` loads both Claude and Codex sessions
- `inferProviderFromModel(model)` determines which provider a JSONL session belongs to
- Polling detects external changes (user ran `claude` in terminal)

## Permissions

Each provider has a "max permissions" mode enabled by default:

| Provider | Env Var | Flags |
|----------|---------|-------|
| Claude | `CLAUDE_MAX_PERMISSIONS` (default: true) | `--dangerously-skip-permissions --permission-mode bypassPermissions --tools default --add-dir <workingDir>` |
| Codex | `CODEX_MAX_PERMISSIONS` (default: true) | `--dangerously-bypass-approvals-and-sandbox` |

Set `CLAUDE_MAX_PERMISSIONS=false` or `CODEX_MAX_PERMISSIONS=false` to disable.

## Adding a New Provider

1. **Create `server/src/providers/{name}.ts`** implementing `Provider`
   - Define CLI output types as a discriminated union
   - Implement `listModels()`, `modelToParams()`, `getSpawnConfig()`, `getSingleShotConfig()`, `formatInput()`, `parseOutput()`
   - Throw `ProviderParseError` on unknown types

2. **Register in `server/src/providers/index.ts`**
   - Import and add to `providers` record

3. **Add to schemas in `shared/src/index.ts`**
   - Extend `ProviderSchema` with the new name
   - Add model schema (e.g. `NewProviderModelSchema`) to `ModelIdSchema` union

4. **Persistence** (if the agent doesn't self-persist):
   - Create adapter in `server/src/adapters/`
   - Add loading path to `jsonl.ts`

5. **Session ID capture** (if the agent generates its own session IDs):
   - Add interception in the stdout parsing loop in `spawnForMessage()` (like Codex's thread_id capture)
