import type { ClientMessage, Conversation } from '@claude-web-view/shared';
import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';
import { getConversationLastActivity } from '../utils/time';

// =============================================================================
// Primary State Atoms
//
// These are the source-of-truth atoms. All mutations go through actions.ts
// (which calls jotaiStore.set on these). Never mutate these directly in
// React components — call action functions instead.
// =============================================================================

export const conversationsAtom = atom(new Map<string, Conversation>());

// Streaming text — kept separate from conversations so Sidebar never re-renders
// at 60Hz during streaming. Flushed into conversations on stream end.
export const streamingContentAtom = atom(new Map<string, string>());

export const activeConversationIdAtom = atom<string | null>(null);
export const wsStatusAtom = atom<'connecting' | 'connected' | 'disconnected'>('connecting');
export const defaultCwdAtom = atom<string>('');

// The WebSocket send function — set by useWebSocketBridge once the socket connects.
// Stored as an atom so actions.ts can always call the current send fn without stale closures.
export const sendFnAtom = atom<{ send: (msg: ClientMessage) => void }>({ send: () => {} });

// =============================================================================
// Per-Item Derived Atoms (atomFamily)
//
// atomFamily memoizes one atom per ID. Components subscribing via
// useAtomValue(conversationAtomFamily(id)) only re-render when THAT conversation
// changes — not when unrelated conversations update. This is the Jotai equivalent
// of the Zustand per-ID selector pattern and is more principled: the dependency
// graph is explicit and tracked automatically.
// =============================================================================

// Single conversation by ID — use instead of s.conversations.get(id)
export const conversationAtomFamily = atomFamily((id: string) =>
  atom((get) => get(conversationsAtom).get(id) ?? null)
);

// Live streaming text for one conversation — use for Chat.tsx merge display
export const streamingAtomFamily = atomFamily((id: string) =>
  atom((get) => get(streamingContentAtom).get(id) ?? '')
);

// Child sessions for sub-agent panel (Chat.tsx) — scoped by parent ID
export const childConversationsAtomFamily = atomFamily((parentId: string) =>
  atom((get) => {
    const all = get(conversationsAtom);
    const children: Conversation[] = [];
    for (const conv of all.values()) {
      if (conv.parentConversationId === parentId) children.push(conv);
    }
    return children.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  })
);

// =============================================================================
// Derived Collection Atoms  (replaces derivedStore.ts entirely)
//
// Pure computed views — no subscribe(), no recompute(), no seed call.
// Jotai recomputes lazily when conversationsAtom changes. Never fires during
// streaming (streamingContentAtom changes don't affect these).
//
// ADDING A NEW VIEW: add one atom below. Components subscribe via
// useAtomValue(yourNewAtom). No other plumbing needed.
// =============================================================================

// All conversations sorted newest-first by last activity:
// last message timestamp when present, otherwise conversation creation time.
export const allConversationsAtom = atom((get) => {
  const map = get(conversationsAtom);
  return Array.from(map.values()).sort((a, b) => {
    const aTime = getConversationLastActivity(a).getTime();
    const bTime = getConversationLastActivity(b).getTime();
    return bTime - aTime;
  });
});

// Conversations filtered by current workspace (defaultCwdAtom)
export const workspaceConversationsAtom = atom((get) => {
  const all = get(allConversationsAtom);
  const cwd = get(defaultCwdAtom);
  return all.filter((c) => c.workingDirectory === cwd || c.isWorker);
});

// Stable sorted ID list — only changes on add/delete/reorder.
// Use with atomFamily for per-item subtree pruning (see CLAUDE.md).
export const allConversationIdsAtom = atom((get) => get(allConversationsAtom).map((c) => c.id));

// Total count — cheaper than subscribing to allConversationsAtom for existence checks
export const conversationCountAtom = atom((get) => get(conversationsAtom).size);
