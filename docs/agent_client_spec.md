# Agent Client Spec

How CLI agents (Claude, Codex, OpenCode, future) are wrapped and consumed by the server.

## Two Usage Modes

Every agent supports two distinct invocation patterns:

### 1. Conversation Mode (stateful, streaming)

Multi-turn sessions. The server spawns a process per message, parses streaming JSON from stdout, and broadcasts events to WebSocket clients.

**Lifecycle:**
```
spawn(command, args) → write stdin → close stdin → read stdout lines → parse JSON → emit ProviderEvent → process closes
```

**Key properties:**
- Session continuity via provider-specific mechanisms (Claude: `--session-id`/`--resume`, Codex: `exec resume <thread_id>`, OpenCode: `run --session <id>`)
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
OpenCode: spawn('opencode', ['run', prompt]) → collect stdout → parse
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
  name: ProviderName;                                      // 'claude' | 'codex' | 'opencode'
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
listModels() → [gpt-5.3-codex-high (default), gpt-5.3-codex-medium, gpt-5.3-codex-xhigh]
modelToParams('gpt-5.3-codex-high') → ['-m', 'gpt-5.3-codex', '-c', 'reasoning.effort=high']
```

Codex uses composite model IDs that encode both model name and reasoning effort level. The `modelToParams()` method decomposes them by matching known effort suffixes (`medium`, `high`, `xhigh`).

### OpenCode
```
listModels() → ['openai/gpt-5', 'openai/gpt-5-mini', ...]
modelToParams('openai/gpt-5') → ['-m', 'openai/gpt-5']
```

OpenCode model IDs use a path-style format (`provider/model`, optionally with additional segments such as `openrouter/openai/gpt-5`). This keeps OpenCode flexible while preventing accidental overlap with Claude/Codex IDs.

## How the Server Consumes Providers

### Conversation Flow (server/src/server.ts)

```
1. Conversation created with provider name ('claude' | 'codex' | 'opencode') and optional model
   - Server validates provider/model compatibility at creation and on `set_model`
2. constructor() calls getProvider(name) to get Provider instance
3. User sends message → queue_message (WS) → server enqueueMessage() → processQueue() → sendMessage()
4. sendMessage() calls spawnForMessage(content):
   a. provider.getSpawnConfig(sessionId, workingDir, resume, model)
   b. spawn(config.command, config.args, config.options)
   c. stdout.on('data') → buffer by newline → JSON.parse each line
   d. For providers that emit canonical session IDs (Codex/OpenCode), intercept stdout events and capture IDs for resume
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

### OpenCode
- First message: `opencode run --format json` (reads prompt from stdin)
- OpenCode emits `sessionID` on JSON events (top-level or `part`) — the server captures this for resume
- Subsequent messages: `opencode run --format json --session <sessionID> --continue`
- If no valid `sessionID` has been captured yet, server omits `--session` and starts a new one

## Stdout Parsing

All providers emit one JSON object per line on stdout in conversation JSON mode.

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

**OpenCode's protocol** (`run --format json`):
- `step_start` → message_start
- `text` → text_delta
- `tool_use` / `part.type=tool` → tool_use
- `step_finish` with `reason=tool-calls` → message_start (intermediate, not final)
- `step_finish` with final reason (e.g. `stop`) → message_complete
- Parser is defensive against schema drift and attempts safe text extraction from unknown event variants

## Persistence

### Claude Code
- Self-persists to `~/.claude/projects/{encoded-path}/{session-id}.jsonl`
- Our server reads these on startup and polls for changes (5s interval)
- We never write to Claude's files

### Codex
- Self-persists to `~/.codex/sessions/YYYY/MM/DD/*.jsonl`
- Server does not mirror-write Codex files; native Codex sessions are the source of truth
- During active turns, in-memory streaming state is authoritative; file poller skips active session IDs
- For Codex spawned sub-agent sessions, `session_meta.payload.source.subagent.thread_spawn.parent_thread_id` is mapped to `Conversation.parentConversationId` and projected into the same header sub-agent panel used by provider Task-tool sub-agents

### OpenCode
- Self-persists message metadata to `~/.local/share/opencode/storage/message/{session-id}/*.json`
- Message content is reconstructed from associated part files in `~/.local/share/opencode/storage/part/{message-id}/*.json`
- Session metadata (cwd/title/time) is read from `~/.local/share/opencode/storage/session/{project-id}/{session-id}.json` when present
- During active turns, in-memory streaming state is authoritative; file poller skips active session IDs

### Loading
- `server/src/adapters/jsonl.ts` loads Claude from `~/.claude/projects/*`, Codex from `~/.codex/sessions/YYYY/MM/DD/*`, and OpenCode from `~/.local/share/opencode/storage/message/*`
- `inferProviderFromModel(model)` is used only for Claude-format entries; native Codex/OpenCode sources are loaded as `provider=codex` / `provider=opencode`
- Polling detects external changes for all three providers (user ran `claude` / `codex` / `opencode` in terminal)

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
