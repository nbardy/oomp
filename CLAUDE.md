# Claude Web View — Project Rules

## React Hooks: Never Call Hooks After Early Returns

**Rule:** ALL hooks (`useState`, `useEffect`, `useMemo`, `useRef`, custom hooks) MUST be called before any conditional `return` statement.

**Why:** React requires hooks to be called in the same order every render. If a component has an early return (e.g. `if (!data) return <Loading />`) and hooks are called after it, the hook count changes when `data` transitions from null to non-null. This crashes React with **Error #310** ("Rendered more hooks than during the previous render").

**This is especially common when:**
- A component reads from a store/context that starts `null` before async data arrives
- `conversation`, `user`, or similar state starts empty and populates after WebSocket/fetch
- New hooks are added to a component without checking where early returns are

**Example — BAD:**
```tsx
function Chat() {
  const data = useStore((s) => s.data);

  if (!data) return <div>Loading...</div>;  // early return

  // CRASH: these hooks only run when data is non-null
  const derived = useMemo(() => compute(data), [data]);
  const timeAgo = useTimeAgo(derived.date);

  return <div>{timeAgo}</div>;
}
```

**Example — GOOD:**
```tsx
function Chat() {
  const data = useStore((s) => s.data);

  // ALL hooks before any early return — use null-safe access
  const derived = useMemo(() => {
    if (!data) return undefined;
    return compute(data);
  }, [data]);
  const timeAgo = useTimeAgo(derived?.date);

  if (!data) return <div>Loading...</div>;

  return <div>{timeAgo}</div>;
}
```

**How to spot this during review:**
- Search for `return` statements inside component bodies that appear before the closing `return`
- If any `useMemo`, `useState`, `useEffect`, or custom `use*` hook appears after such a return, it's a bug
- The bug may not crash immediately — it only crashes when the condition flips (null → non-null or vice versa)

---

## Provider Pattern: One Interface, Two Modes

All CLI agent integrations (Claude, Codex, future agents) implement the `Provider` interface in `server/src/providers/index.ts`.

**Two usage modes:**
1. **Conversation mode** — `getSpawnConfig()` + `parseOutput()` + `formatInput()` for stateful, streaming multi-turn sessions
2. **Single-shot mode** — `getSingleShotConfig(prompt)` for one-off tasks (palette generation, summarization, etc.)

**Adding a new provider:**
1. Create `server/src/providers/{name}.ts` implementing `Provider`
2. Add to `ProviderSchema` in `shared/src/index.ts`: `z.enum([..., '{name}'])`
3. Register in the `providers` record in `server/src/providers/index.ts`
4. See `docs/agent_client_spec.md` for the full protocol specification

---

## Zustand Stores: Targeted Selectors, Stable References

**Rule:** Use targeted selectors to avoid unnecessary re-renders. Never select the entire store.

```tsx
// BAD: re-renders on ANY store change
const store = useConversationStore();

// GOOD: re-renders only when THIS conversation changes
const conversation = useConversationStore((s) => s.conversations.get(id) ?? null);
```

**Stable empty references:** Use module-level constants for fallback values to avoid triggering re-renders with new object/array references every render.

```tsx
// Module level — same reference every render
const EMPTY_QUEUE: QueuedMessage[] = [];

// In component — stable fallback
const queue = useConversationStore((s) => s.queues.get(id) ?? EMPTY_QUEUE);
```

---

## Race Conditions with setState Closures

**Rule:** After calling a state setter (`setState`, `setCustomPalettes`, etc.), the *current* closure still holds the old value. Don't look up data by key from state you just updated — pass the value directly.

```tsx
// BAD: addCustomPalette updates state, but previewPalette reads stale closure
addCustomPalette(key, palette);
previewPalette(key);  // looks up key in stale customPalettes — not found!

// GOOD: pass the palette object directly
addCustomPalette(key, palette);
applyPalette(palette);  // uses the value we already have
```

---

## Uncontrolled Textareas for Streaming UIs

When a component re-renders frequently (e.g. streaming message chunks), use uncontrolled textareas (read value from `ref.current.value`) instead of controlled (`value={state}`). A controlled textarea re-renders on every keystroke, competing with streaming re-renders and causing input lag.

Only sync a boolean (`hasInput`) to React state for button disabled states — flip it at most twice (empty↔non-empty), not on every keystroke.
