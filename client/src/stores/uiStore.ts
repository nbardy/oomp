import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// =============================================================================
// UI Store — Single source of truth for all client-local persistent state.
//
// Every localStorage key lives here (or is documented here if it must stay
// external). Adding a new persisted value = add it to UIState + initialise it.
//
// Migration: If the shape changes, bump the `version` and add a `migrate`
// function to the persist config below.
//
// NEW Badge Feature (2026-02-02):
// lastSeenMessageIndex tracks the last message index the user has viewed in
// each conversation. When lastSeenIndex < messages.length - 1, a "NEW" badge
// appears in the sidebar. IntersectionObserver in Chat.tsx detects when the
// last message becomes visible and calls markMessagesSeen to update this state.
// See docs/new_badge_feature.md for full design rationale.
// =============================================================================

// ---------------------------------------------------------------------------
// External Keys (cannot live in Zustand — documented here for discoverability)
//
// draft:{conversationId}   — Written from uncontrolled textarea via refs in
//                            Chat.tsx. Must bypass React render cycle.
// pendingConversations     — Read/written inside actions.ts during
//                            WebSocket init (non-React context).
// ---------------------------------------------------------------------------
export const DRAFT_KEY_PREFIX = 'draft:';
export const PENDING_CONVERSATIONS_KEY = 'pendingConversations';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface UIState {
  // Active conversation — restored on page load
  activeConversationId: string | null;

  // Last working directory used in New Conversation dialog
  lastWorkingDirectory: string | null;

  // Gallery UI
  galleryExpandedProjects: string[]; // Stored as array, used as Set at call sites
  galleryCollapsedProjects: string[];
  showTempSessions: boolean;
  showDoneConversations: boolean;

  // Conversations marked "done" — hidden from sidebar, toggleable in gallery
  doneConversations: string[];

  // Oompa worker overrides — workers promoted to main view by user action
  promotedWorkers: string[];
  showWorkerConversations: boolean;

  // Seen message tracking — conversationId -> last seen message index
  lastSeenMessageIndex: Record<string, number>;

  // Sidebar view mode — 'grouped' groups recent (48h) by folder, 'list' is flat chronological
  sidebarViewMode: 'grouped' | 'list';

  // Actions
  setActiveConversationId: (id: string | null) => void;
  setLastWorkingDirectory: (dir: string) => void;

  toggleGalleryExpanded: (dir: string) => void;
  toggleGalleryCollapsed: (dir: string) => void;
  setShowTempSessions: (show: boolean) => void;
  setShowDoneConversations: (show: boolean) => void;

  markDone: (conversationId: string) => void;
  unmarkDone: (conversationId: string) => void;
  isDone: (conversationId: string) => boolean;

  promoteWorker: (conversationId: string) => void;
  demoteToWorker: (conversationId: string) => void;
  setShowWorkerConversations: (show: boolean) => void;

  markMessagesSeen: (conversationId: string, messageIndex: number) => void;
  hasUnseenMessages: (conversationId: string, totalMessages: number) => boolean;

  setSidebarViewMode: (mode: 'grouped' | 'list') => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      // State
      activeConversationId: null,
      lastWorkingDirectory: null,
      galleryExpandedProjects: [],
      galleryCollapsedProjects: [],
      showTempSessions: false,
      showDoneConversations: false,
      doneConversations: [],
      promotedWorkers: [],
      showWorkerConversations: false,
      lastSeenMessageIndex: {},
      sidebarViewMode: 'grouped',

      // Actions
      setActiveConversationId: (id) => set({ activeConversationId: id }),

      setLastWorkingDirectory: (dir) => set({ lastWorkingDirectory: dir }),

      toggleGalleryExpanded: (dir) =>
        set((s) => {
          const current = new Set(s.galleryExpandedProjects);
          if (current.has(dir)) {
            current.delete(dir);
          } else {
            current.add(dir);
          }
          return { galleryExpandedProjects: Array.from(current) };
        }),

      toggleGalleryCollapsed: (dir) =>
        set((s) => {
          const current = new Set(s.galleryCollapsedProjects);
          if (current.has(dir)) {
            current.delete(dir);
          } else {
            current.add(dir);
          }
          return { galleryCollapsedProjects: Array.from(current) };
        }),

      setShowTempSessions: (show) => set({ showTempSessions: show }),

      setShowDoneConversations: (show) => set({ showDoneConversations: show }),

      markDone: (conversationId) =>
        set((s) => {
          if (s.doneConversations.includes(conversationId)) return s;
          return { doneConversations: [...s.doneConversations, conversationId] };
        }),

      unmarkDone: (conversationId) =>
        set((s) => ({
          doneConversations: s.doneConversations.filter((id) => id !== conversationId),
        })),

      isDone: (conversationId) => get().doneConversations.includes(conversationId),

      promoteWorker: (conversationId) =>
        set((s) => {
          if (s.promotedWorkers.includes(conversationId)) return s;
          return { promotedWorkers: [...s.promotedWorkers, conversationId] };
        }),

      demoteToWorker: (conversationId) =>
        set((s) => ({
          promotedWorkers: s.promotedWorkers.filter((id) => id !== conversationId),
        })),

      setShowWorkerConversations: (show) => set({ showWorkerConversations: show }),

      markMessagesSeen: (conversationId, messageIndex) =>
        set((s) => ({
          lastSeenMessageIndex: {
            ...s.lastSeenMessageIndex,
            [conversationId]: messageIndex,
          },
        })),

      setSidebarViewMode: (mode) => set({ sidebarViewMode: mode }),

      hasUnseenMessages: (conversationId, totalMessages) => {
        if (totalMessages === 0) return false;
        const lastSeen = get().lastSeenMessageIndex[conversationId];
        if (lastSeen === undefined) return false;
        return lastSeen < totalMessages - 1;
      },
    }),
    {
      name: 'claude-web-view-ui',
      version: 4,
      // Persist only state, not actions
      partialize: (state) => ({
        activeConversationId: state.activeConversationId,
        lastWorkingDirectory: state.lastWorkingDirectory,
        galleryExpandedProjects: state.galleryExpandedProjects,
        galleryCollapsedProjects: state.galleryCollapsedProjects,
        showTempSessions: state.showTempSessions,
        showDoneConversations: state.showDoneConversations,
        doneConversations: state.doneConversations,
        promotedWorkers: state.promotedWorkers,
        showWorkerConversations: state.showWorkerConversations,
        lastSeenMessageIndex: state.lastSeenMessageIndex,
        sidebarViewMode: state.sidebarViewMode,
      }),
      migrate: (persistedState: any, version: number) => {
        if (version === 1) {
          return {
            ...persistedState,
            lastSeenMessageIndex: {},
            promotedWorkers: [],
            showWorkerConversations: false,
            sidebarViewMode: 'grouped',
          };
        }
        if (version === 2) {
          return {
            ...persistedState,
            promotedWorkers: [],
            showWorkerConversations: false,
            sidebarViewMode: 'grouped',
          };
        }
        if (version === 3) {
          return {
            ...persistedState,
            sidebarViewMode: 'grouped',
          };
        }
        return persistedState;
      },
    }
  )
);
