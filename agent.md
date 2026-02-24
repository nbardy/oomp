# Agent Architecture Notes (Canonical)

## What to read first

- This file is the canonical architecture reference for this repo’s agent behavior.
- `CLAUDE.md` is a symlink to this file.
- `AGENTS.md` contains execution/runner instructions and should be treated separately.

## Architecture in one page

### 1) Provider abstraction is the integration seam

All provider-specific CLI details are expressed through a shared contract, split into:

- **Build-time contract** in `agent-cli-tool`
  - Harnesses: `agent-cli-tool/src/harnesses/*`
  - Shared builder: `agent-cli-tool/src/build.ts`
  - Types: `agent-cli-tool/src/types.ts`
- **Server provider runtime** in `claude-web-view`
  - Provider interface + registry: `server/src/providers/index.ts`
  - Provider implementations: `server/src/providers/{claude,codex,opencode,gemini}.ts`
  - Shared provider IDs: `shared/src/index.ts`

### 2) Registry-first persistence

Persisted sessions are loaded through adapter registry:

- `server/src/adapters/registry.ts`
- `server/src/adapters/disk-adapter.ts`
- `server/src/adapters/loader.ts`

No provider-specific loading branches in the generic poll loop.
Adding a provider means adding:
- a harness,
- a server provider,
- a disk adapter (if persisted artifacts are needed).

### 3) Conversation lifecycle and state authority

The authoritative in-memory model remains `Conversation` in:

- `server/src/server.ts`

Flow is:
1. New conversation is created by client action.
2. Server validates + spawns provider process.
3. Chunk + message events are streamed into message buffer/state.
4. On completion/close, queue/status/message boundaries are reconciled and broadcast.

`server` state remains authoritative while the CLI process is active. File-poller updates are merge-on-change and skip active in-memory IDs.

### 4) Client state frequency budget

Streaming is separated from structural state:

- Structural state: `conversationsAtom`, `allConversationsAtom`, IDs, etc.
- High-frequency stream text: dedicated stream buffers / streaming atoms.

Goal: keep sidebar/search/gallery re-renders out of 60Hz text-chunk churn.

Relevant files:
- `client/src/atoms/conversations.ts`
- `client/src/atoms/actions.ts`
- `client/src/atoms/store.ts`

### 5) Path and model correctness invariants

- Working directory paths should be absolute/normalized consistently before persistence and reconcile.
- Provider models and IDs should flow through shared schema/types and not be manually inferred from UI behavior.

### 6) Gemini behavior (important edge case)

- Uses stream-json in stream mode.
- Resume semantics are harness-driven (`--resume latest` style), independent of per-message internal `sessionId`.
- Command construction and parse behavior must stay contract-clean.

## Decision record

- Keep provider registration and command construction declarative.
- Keep command construction in shared harness/builder layer; keep process lifecycle centralized in server.
- Keep parsing and UI projection explicit and normalized.

## Known tradeoffs still on deck

- Filesystem polling remains the external-session recovery path.
- Polling is necessary for now because not all providers expose first-class event streams for all lifecycle events.
- Event/query paths (`/api/search`, `/api/usage`) should keep consuming normalized, registry-derived models/keys.

## Practical next plan (recommended)

### Immediate (no new architecture)
1. Keep `agent-cli-tool` command contracts as the canonical suite boundary.
2. Add one cross-provider loader fixture test for startup+poll behavior.
3. Add one websocket regression test around create/reconcile path normalization + visibility.

### Next
4. Add one `/api/search` and one `/api/usage` behavior test validating provider keys map from registry.
5. Tighten any remaining bespoke translation branches around provider-specific model/id extraction.

### Then
6. Remove or collapse duplicate normalization/canonicalization helpers once all callers flow through shared paths.
7. Revisit polling cadence and change detection only after coverage on contract/filer merge paths is stable.

## Test strategy: useful vs overkill

Not pointless. But keep scope tight:

- **High value / low cost**
  - Contract tests for builder + provider command specs (in `agent-cli-tool`).
  - Loader/poller integration fixture test.
  - WS init + creation reconcile behavior test.

- **Likely overkill today**
  - Exhaustive per-provider UI behavior tests that duplicate command+loader+WS coverage.
  - Mock-heavy provider tests (you lose signal for file system + command invocation reality).

If you need exactly three tests now:
1. `agent-cli-tool` build contract regression (Gemini + Codex resume + stream flags)
2. `loadAllConversations/pollForChanges` fixture test
3. `test/api.test.js` create/reconcile path normalization test

## Integration Test Focus (Lean, No Mock-heavy Coverage)

Prioritize behavior at module boundaries where real complexity lives:

### 1) Runtime creation and visibility
- Hit `POST /api/conversations`, `POST /api/queue-message`, then poll `/api/conversations/:id` and the WS status stream.
- Verify path normalization and sidebar visibility invariants without stubbing process output.
- This protects the “new convo should appear in sidebar / exist in state” regression path.

### 2) Unified registry loading + recovery
- Write temporary fixture chat artifacts for all registered providers under fake home dirs.
- Invoke adapter registry loader and verify:
  - provider ids resolve from schema
  - conversation metadata normalizes consistently
  - active in-memory conversations are not overwritten by poller hydration.

### 3) Gemini command + protocol alignment
- Run a provider integration test against a real `gemini` binary in test mode (or a known deterministic harness command).
- Assert:
  - command is built with stream-json args from shared harness
  - provider parser emits assistant message deltas + completion event
  - no prompt/stdin contract mismatch.

What to avoid for now:
- Don’t add exhaustive UI snapshot suites for every provider/edge case.
- Don’t add tiny unit tests for pure mapping functions where one end-to-end flow test already validates the same behavior.
