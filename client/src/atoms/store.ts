import { createStore } from 'jotai';

// =============================================================================
// Vanilla Jotai Store
//
// Exported so the WebSocket bridge (App.tsx) and mutation functions (actions.ts)
// can call store.get() / store.set() outside of React.
//
// The <Provider store={jotaiStore}> in App.tsx connects this same store to all
// React components, so useAtom/useAtomValue in components and jotaiStore.set()
// in actions always touch the same state.
// =============================================================================

export const jotaiStore = createStore();
