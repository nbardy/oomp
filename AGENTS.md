# AGENTS.md — Agentic Coding Guide

Quick-reference for agents writing new code in this codebase.
Start here before touching state, components, or the server.

---

## Writing state subscriptions

**Before subscribing to any store, identify what you need:**

### Single conversation by ID → `conversationAtomFamily`
```ts
const conv = useAtomValue(conversationAtomFamily(id));
```

### A list of conversations (sorted, filtered, grouped) → `allConversationsAtom` / `derived atoms`

**Option A — simple, re-renders all items on any structural change:**
```ts
const list = useAtomValue(allConversationsAtom);
// then apply UI-state filters inline with useMemo
```

**Option B — per-item subscriptions, true subtree pruning (use for large lists):**
```ts
// Parent: only re-renders when list membership/order changes
const ids = useAtomValue(allConversationIdsAtom);
return ids.map(id => <Item key={id} id={id} />);

// Item: React.memo + per-ID selector = only re-renders when THIS conv changes
const Item = React.memo(function Item({ id }: { id: string }) {
  const conv = useAtomValue(conversationAtomFamily(id));
  ...
});
```
Why it works: `conversations.get(otherId)` returns the same reference when a different
conversation changes. React.memo sees no prop change → skips render. This is structural
sharing doing real work — no library required.

### Active streaming text → `streamingAtomFamily`
```ts
const text = useAtomValue(streamingAtomFamily(id));
// merge with conversation.messages at render time, not in the store
```

### Persisted UI state → `uiStore`
```ts
const pref = useUIStore((s) => s.yourPreference);
```

**Red flag:** if you wrote `useAtomValue(conversationsAtom)` — stop.
That subscribes to every structural event across all conversations.
Use one of the patterns above instead.

---

## Writing state mutations

### Structural update (new message, status change, queue, conversation added/deleted)
→ update `conversationsAtom.conversations`
→ `derived atoms` recomputes automatically via subscribe

### Chunk / streaming update
→ update `conversationsAtom.streamingContent` ONLY
→ never update `conversations.messages` during streaming
→ flush streamingContent → conversations in `status(isStreaming=false)` handler

### High-frequency state you're adding (>10Hz)
→ add a new `Map<string, T>` to `conversationsAtom` (like `streamingContent`)
→ never add it to `conversations` entries
→ document the flush boundary (when does it merge into `conversations`?)

---

## Adding a new collection view

All sorted/filtered lists of conversations go in `derived atoms.ts` — not in component `useMemo`.

```ts
// client/src/atoms/conversations.ts

export const yourViewAtom = atom((get) => {
  const all = get(conversationsAtom);
  // ... compute your view
});
```

Then in the component: `useAtomValue(yourViewAtom)`.

---

## Adding a new provider (CLI integration)

1. `server/src/providers/{name}.ts` implementing `Provider` interface
2. Add to `ProviderSchema` in `shared/src/index.ts`
3. Register in `providers` record in `server/src/providers/index.ts`
4. See `docs/agent_client_spec.md` for the full protocol spec

---

## React hook ordering

ALL hooks must appear before any early `return` statement.
Hooks after early returns crash React when the condition flips (null → non-null).

```ts
// BAD
function Chat() {
  const conv = useAtomValue(conversationAtomFamily(id));
  if (!conv) return <Loading />;     // early return
  const x = useMemo(...);            // crash: hook after conditional return
}

// GOOD
function Chat() {
  const conv = useAtomValue(conversationAtomFamily(id));
  const x = useMemo(() => {
    if (!conv) return null;          // guard inside memo, not a return
    return compute(conv);
  }, [conv]);
  if (!conv) return <Loading />;     // early return AFTER all hooks
}
```

---

## Performance checklist before committing

- [ ] No `useAtomValue(conversationsAtom)` in new components
- [ ] New list/sorted/filtered views added to `derived atoms.ts`, not component `useMemo`
- [ ] High-frequency updates go to `streamingContent` or a dedicated Map, not `conversations`
- [ ] Stable fallback references are module-level constants, not inline `[]` or `{}`
- [ ] No hooks after early returns

## Architecture in One Page

### 1) Provider abstraction is the integration seam

Provider-specific CLI details are expressed through a shared contract, split into:

- Build-time contract in `agent-cli-tool`
  - Harnesses: `agent-cli-tool/src/harnesses/*`
  - Shared builder: `agent-cli-tool/src/build.ts`
  - Types: `agent-cli-tool/src/types.ts`
- Server provider runtime in `server`
  - Provider interface + registry: `server/src/providers/index.ts`
  - Provider implementations: `server/src/providers/{claude,codex,opencode,gemini}.ts`
  - Shared provider IDs: `shared/src/index.ts`

### 2) Registry-first persistence

Persisted sessions are loaded through adapter registry:

- `server/src/adapters/registry.ts`
- `server/src/adapters/disk-adapter.ts`
- `server/src/adapters/loader.ts`

Adding a provider means adding:
- a harness,
- a server provider,
- a disk adapter (if persisted artifacts are needed).

### 3) Conversation lifecycle and state authority

Authoritative in-memory model is `Conversation` in:

- `server/src/server.ts`

Flow is:
1. Client creates conversation.
2. Server validates + spawns provider process.
3. Chunk + message events are streamed into buffers/state.
4. On completion/close, queue/status/message boundaries are reconciled and broadcast.

`server` state remains authoritative while the provider process is active. Poller/loader merges skip active in-memory IDs.

### 4) Client state frequency budget

Streaming is separated from structural state:

- Structural: `conversationsAtom`, `allConversationsAtom`, IDs.
- High-frequency stream text: dedicated stream buffers / streaming atoms.

Relevant files:
- `client/src/atoms/conversations.ts`
- `client/src/atoms/actions.ts`
- `client/src/atoms/store.ts`

## Test Strategy: Useful vs Overkill

### High-value, low-cost
- Contract tests for builder + provider command specs (`agent-cli-tool`).
- Adapter loader/poller integration fixture test.
- WS init + create/reconcile behavior test around path normalization and visibility.

### Likely overkill now
- Per-provider exhaustive UI suites that duplicate loader + WS + provider contract coverage.
- Mock-heavy provider unit tests where real process/fs integration is the real risk.

If you want exactly three tests:
1. `agent-cli-tool` command contract regression (Gemini + Codex resume + stream flags)
2. `loadAllConversations/pollForChanges` fixture test
3. `test/api.test.js` create/reconcile path normalization test

## Integration Test Focus (Lean, No Mock-heavy Coverage)

1. Runtime creation and visibility
- `POST /api/conversations` + `POST /api/queue-message` + poll `/api/conversations/:id` + WS status.
- Validate path normalization and sidebar visibility invariants.

2. Registry loading + recovery
- Write temporary fixtures for all registered providers under fake home dirs.
- Invoke registry loader and validate:
  - provider ids resolve from schema
  - metadata normalizes consistently
  - active in-memory convos are not overwritten

3. Gemini command + protocol alignment
- Validate command/parse behavior against real or deterministic Gemini harness path.
- Assert stream-json args, message delta events, and completion event flow.
