# Claude CLI: Multi-Turn Conversation Pattern

## The Winning Pattern

`-p` + `--resume` + `--output-format stream-json`

## Why This Works

- One process per turn → trivial reliability
- Process exit = turn complete (no ambiguity)
- `--resume <sid>` = deterministic context continuation
- Streaming JSON output for real-time UI

## Commands

**First turn (creates session):**
```bash
claude -p --verbose --output-format stream-json --session-id "$SESSION_ID" "Your prompt"
```

**Subsequent turns (resumes session):**
```bash
claude -p --verbose --output-format stream-json --resume "$SESSION_ID" "Follow-up"
```

## Common Mistake

Using `--session-id` for ALL messages fails with "Session ID is already in use".

You MUST switch to `--resume` after the first turn.

## Split IDs Pattern

Keep separate IDs for UI conversation vs Claude CLI session:

- `conversation.id` - persists across context resets, used for UI
- `claudeSessionId` - can be regenerated for fresh context

This allows resetting Claude context while keeping the conversation trace in the UI.

## Turn Completion Detection

1. Process exit (always works, simplest)
2. Final `{"type":"result",...}` object in stream-json output

## Alternatives (More Complex)

Only use if you actually need these features:

- `--input-format stream-json` - long-lived process, multiple messages over stdin
- `--include-partial-messages` - streaming token-by-token chunks
- `-c/--continue` - resumes most recent session in directory (brittle for automation, can surprise you)

## Safety Rails for Agentic Loops

- `--max-turns` - limit agentic turns
- `--max-budget-usd` - cap spend
- `--allowed-tools` - restrict tool access

## Implementation in This Project

See `server/src/providers/claude.ts`:
- `getSpawnConfig()` returns `-p`, `--verbose`, `--output-format stream-json`
- First turn: `--session-id`
- Subsequent turns: `--resume`

See `server/src/server.ts`:
- `Conversation.claudeSessionId` - separate from `conversation.id`
- `_hasStartedSession` flag tracks whether to use `--resume`
- `resetProcess()` generates new `claudeSessionId` for fresh context
