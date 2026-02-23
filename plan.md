# Plan: Full-Text Search Across Conversations

## What we're building
A search icon in the sidebar header (next to the "Conversations" label) that opens a command-palette-style popup. The user types a query, and we search all message content across all conversations in the current project, showing matching results with conversation context. Clicking a result navigates to that conversation.

## Performance approach: Client-side search over in-memory store
All conversations + messages are already loaded in `conversationStore.conversations` (a `Map<string, Conversation>`). No server endpoint needed. We'll:
1. Filter by the search query using `String.includes()` (case-insensitive) for instant results
2. Debounce the search by 150ms so it doesn't fire on every keystroke
3. Limit results to 50 to avoid rendering thousands of matches
4. Show a snippet of the matching text with the query highlighted

## Files to create
1. **`client/src/components/SearchPalette.tsx`** — The search popup component
2. **`client/src/components/SearchPalette.css`** — Styles (reuses PromptPalette pattern)

## Files to modify
1. **`client/src/components/Sidebar.tsx`** — Add search icon button + render SearchPalette + `Cmd+K` keyboard shortcut

## Component Design: SearchPalette

```
Props: { isOpen, onClose, onSelectConversation(id: string) }
```

**Behavior:**
- Reuses the PromptPalette overlay pattern (fixed overlay, top-center, backdrop blur)
- Input at top, results below (keyboard nav: ArrowUp/Down/Enter/Escape)
- Reads `conversations` from store via `useConversationStore`
- On each query change (debounced 150ms), iterates all conversations → all messages → finds case-insensitive matches
- Each result shows: folder name, message role badge, snippet with match highlighted, time ago
- Enter or click → calls `onSelectConversation(id)` → navigates to `/chat/{id}` → closes popup
- Groups results by conversation (shows conversation header once, then matching messages underneath)

**Result shape:**
```ts
{ conversationId: string, messageIndex: number, role: string, snippet: string, workingDirectory: string, timestamp: Date }
```

## Sidebar changes
- Add a search icon button (magnifying glass SVG) to the right side of the `.nav-section-counts` area in the Conversations header
- `Cmd+K` / `Ctrl+K` global shortcut opens the search palette (follows existing Shift+Space pattern)
- State: `const [showSearch, setShowSearch] = useState(false)`

## Implementation sequence
1. Create `SearchPalette.tsx` + `SearchPalette.css`
2. Add search button + state + keyboard shortcut to `Sidebar.tsx`
3. Wire navigation on result selection
