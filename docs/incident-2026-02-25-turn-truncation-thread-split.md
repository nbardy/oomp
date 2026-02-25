# Incident Analysis: Truncated Turns, Split Threads, and Multi-UUID Identity Drift

Date: 2026-02-25 (CST)
Repository: `claude-web-view`
Audience: incoming engineering agent / incident owner

## 1) Executive Summary

Users are seeing three overlapping failure modes:

1. Turns truncate after an interim assistant update (for example: "I’ll do X") with no final completion message.
2. A single user action can appear as two conversations in the sidebar (split thread behavior).
3. Multiple IDs appear for what users perceive as one thread (provider session IDs vs local conversation UUIDs).

This is not one bug. It is a systems issue spanning runtime lifecycle, identity modeling, and ingestion boundaries.

Highest-confidence root causes:

1. Identity drift between UI `conversation.id` and provider `sessionId`, plus client-side `init` merge behavior that keeps stale local conversations alive after reconnect/restart.
2. Global ingestion of all persisted sessions (`~/.codex/sessions`, `~/.claude/projects`, etc.) into one shared list, which can surface unrelated/externally-running sessions and make them look like split threads.
3. Mid-turn process interruption/restart paths (partly mitigated already by recent server fixes), which can still present as abrupt completion in UI.

## 2) User-Reported Symptoms (Mapped)

Observed from screenshots and chat transcript:

1. "Assistant says it will do work, then no follow-up."  
Mapped to: turns ending without terminal completion semantics visible in UI.

2. "Tool use stream appears, then collapses, busy indicator dies."  
Mapped to: process lifecycle ending without coherent terminal UX signal for imported/external sessions.

3. "One message shows up as two conversations."  
Mapped to: conversation identity split, stale local conversation records, and/or imported external session in same working directory.

4. "Multiple UUID prefixes (`019c93d3`, `d97e2064`) for what feels like one thread."  
Mapped to: provider-native session ID vs client-generated UUID and missing explicit cross-ID reconciliation in the client state model.

## 3) Concrete Forensics

### 3.1 Session ID Evidence

IDs reported by user and verified:

1. `019c930b` -> present in `~/.codex/sessions/2026/02/25/...` (multiple files).
2. `019c9368` -> present in `~/.codex/sessions/2026/02/25/...` (multiple files).
3. `019c93b9` -> present in `~/.codex/sessions/2026/02/25/...` (single file).
4. `019c93d3` -> present in `~/.codex/sessions/2026/02/25/...` (single file).
5. `d97e2064` -> not found in persisted sources searched (`~/.codex/sessions`, `~/.claude-web-view`, `~/.agent-viewer`).

Interpretation:

- `019c...` looks like provider session identity persisted by Codex.
- `d97e2064` very likely matches a client-generated optimistic `crypto.randomUUID()` prefix and was transient/in-memory.

### 3.2 Terminal Event Completeness in JSONL

A subset of session files ends with reasoning/tool activity and no terminal `task_complete` in the tail.

Examples:

1. `rollout-...019c93d3-...jsonl` ends on reasoning-related entries, no `task_complete` in file.
2. `rollout-...019c930b-...8408...jsonl` ends mid-analysis tail (reasoning/tool context), no terminal completion marker.
3. `rollout-...019c93b9-...jsonl` has prior `task_complete` events in file history but tail still shows mid-turn style events.

Interpretation:

- At least some sessions end from the app’s perspective without a clean semantic completion boundary in persisted artifacts.
- This matches user-reported "stops after interim update" behavior profile.

### 3.3 Live Server Snapshot Evidence

WS `init` inspection returned:

1. Total conversations >500 (for example 556, 558, 563 during checks).
2. Conversations loaded across many unrelated working directories.
3. `019c93d3` present under `/Users/nicholasbardy/git/oompa_loompas` with 3 messages.
4. `d97e2064` absent.

Interpretation:

- The app is aggregating global persisted sessions, not isolated to one project/repo context.
- Users can see sessions that were launched elsewhere and interpret them as thread splits.

### 3.4 Runtime Process Topology

Multiple server dev watchers were simultaneously running (`tsx watch src/server.ts` from separate terminals), while one child process owned port 3000.

Interpretation:

- This increases restart/interruption risk and complicates incident interpretation.
- Not necessarily the sole cause, but an amplifying factor.

## 4) Architecture Findings (Code-Level)

### 4.1 Identity Model Is Split But Not Explicit in Shared Schema

Current state:

1. Conversation runtime has both `id` and `sessionId` server-side ([server/src/server.ts](/Users/nicholasbardy/git/claude-web-view/server/src/server.ts):294-296).
2. Shared `ConversationSchema` exposes `id` only, not `sessionId` ([shared/src/index.ts](/Users/nicholasbardy/git/claude-web-view/shared/src/index.ts):292-336).
3. `toJSON()` serializes `id` but not `sessionId` ([server/src/server.ts](/Users/nicholasbardy/git/claude-web-view/server/src/server.ts):1077-1098).

Impact:

- Client cannot reason about aliasing between UI conversation identity and provider session identity.
- Debugging and reconciliation are opaque in UI state.

### 4.2 Disk Hydration Re-Keys by Provider Session ID

Disk path conversion sets `id = session.sessionId` ([server/src/adapters/disk-adapter.ts](/Users/nicholasbardy/git/claude-web-view/server/src/adapters/disk-adapter.ts):86-109).

`hydrateConversation()` then uses that `id` as canonical conversation id ([server/src/server.ts](/Users/nicholasbardy/git/claude-web-view/server/src/server.ts):3701-3719).

Impact:

- After restart/hydration, canonical IDs can shift to provider session IDs.
- If client was previously tracking a local UUID conversation id, this can manifest as a second thread.

### 4.3 Client `init` Handler Merges Instead of Reconciles

`init` currently does `new Map(existing)` then overlays server conversations ([client/src/atoms/actions.ts](/Users/nicholasbardy/git/claude-web-view/client/src/atoms/actions.ts):309-314).

It does not remove stale existing keys that are absent from server snapshot.

Impact:

- Stale local conversations survive reconnect/server-restart windows.
- This directly enables split-thread artifacts (`old UUID` + `reloaded provider session ID`).

### 4.4 Global Ingestion Scope

Adapters ingest from global stores:

1. Codex: `~/.codex/sessions/YYYY/MM/DD/*.jsonl` ([server/src/adapters/registry.ts](/Users/nicholasbardy/git/claude-web-view/server/src/adapters/registry.ts):72-79).
2. Loader discovers/parses all adapters ([server/src/adapters/loader.ts](/Users/nicholasbardy/git/claude-web-view/server/src/adapters/loader.ts):42-89, 179-292).
3. Startup hydration and ongoing poll import these into runtime conversation map ([server/src/server.ts](/Users/nicholasbardy/git/claude-web-view/server/src/server.ts):3730-3785, 3895-4041).

Impact:

- External sessions can appear as if generated by the current UI interaction.

### 4.5 Parent/Child Thread Visibility Is Best-Effort

Top-level filtering hides children only if parent ID is present in the current set ([client/src/components/Sidebar.tsx](/Users/nicholasbardy/git/claude-web-view/client/src/components/Sidebar.tsx):117-123).

Impact:

- If parent linkage is unresolved or parent id identity differs, child threads appear as top-level rows (another split-thread presentation).

### 4.6 Startup Load Limit Behavior

`loadExistingConversations()` hardcodes `const limit = 500` ([server/src/server.ts](/Users/nicholasbardy/git/claude-web-view/server/src/server.ts):3734), even though env knobs exist (`CWV_STARTUP_INITIAL_LOAD_LIMIT` etc., [server/src/server.ts](/Users/nicholasbardy/git/claude-web-view/server/src/server.ts):118-121).

Impact:

- Partial hydration windows become longer and can worsen reconciliation edge cases.

## 5) Recent Stabilization Work Already Landed

Committed in this repo:

1. `59c6330` `fix: prevent mid-turn truncation on server hot-reload`
2. `9f851d0` `fix: add turn watchdogs for stalled provider runs`

Relevant runtime knobs now present:

1. `CWV_TURN_IDLE_TIMEOUT_MS` ([server/src/server.ts](/Users/nicholasbardy/git/claude-web-view/server/src/server.ts):127)
2. `CWV_TURN_MAX_RUNTIME_MS` ([server/src/server.ts](/Users/nicholasbardy/git/claude-web-view/server/src/server.ts):128)
3. `CWV_TURN_TIMEOUT_KILL_GRACE_MS` ([server/src/server.ts](/Users/nicholasbardy/git/claude-web-view/server/src/server.ts):129)

Hot-reload SIGTERM drain behavior lives in signal handler block ([server/src/server.ts](/Users/nicholasbardy/git/claude-web-view/server/src/server.ts):3541-3642).

Validation previously run and passing:

1. `pnpm --filter @claude-web-view/server typecheck`
2. `pnpm test`

## 6) Ranked Root-Cause Hypotheses

### High Confidence

1. Identity drift + stale `init` merge causes duplicate/split conversations after reconnect/restart.
2. Global ingestion scope causes unrelated external sessions to appear as local thread splits.

### Medium-High Confidence

1. Process lifecycle interruptions (hot reload / restarts / competing dev watchers) still contribute to truncation under certain timing.
2. External session import path cannot surface semantic completion reasons, so abrupt stop looks like silent failure.

### Medium Confidence

1. Parent-child linking can fail transiently when IDs are unresolved, producing extra top-level rows.
2. Partial hydration (limit window) can exacerbate race windows and delayed reconciliation.

## 7) Why `019c93d3` + `d97e2064` Is a Key Clue

This pair is consistent with one logical conversation surfacing under two identities:

1. Provider-native persisted session (`019c93d3...`) imported from disk.
2. Client-local UUID (`d97e2064...`) that was transient/stale and not persisted.

That pattern aligns with current architecture:

1. client-generated IDs at creation ([client/src/atoms/actions.ts](/Users/nicholasbardy/git/claude-web-view/client/src/atoms/actions.ts):175)
2. disk hydration keyed by provider session ID ([server/src/adapters/disk-adapter.ts](/Users/nicholasbardy/git/claude-web-view/server/src/adapters/disk-adapter.ts):93)
3. `init` merge retaining stale local map entries ([client/src/atoms/actions.ts](/Users/nicholasbardy/git/claude-web-view/client/src/atoms/actions.ts):309-314)

## 8) System Redesign Direction (Recommended)

### Identity Contract

1. Introduce explicit dual identity in shared schema: `conversationId` (UI-stable) and `sessionId` (provider-stable).
2. Never overload `id` for both semantics.
3. Emit explicit mapping/reconciliation events (`session_bound`, `conversation_rekeyed` or equivalent).

### Client Reconciliation

1. Replace merge-only `init` behavior with epoch/snapshot reconciliation.
2. Keep optimistic/pending stubs in a separate structure from server-authoritative map.
3. Prune stale non-authoritative entries deterministically on reconnect.

### Ingestion Scope

1. Add configurable visibility scope modes:
   - current workspace only
   - selected folders
   - global
2. Default to scoped mode in primary UX to reduce “phantom split” perception.

### Completion Semantics

1. Persist explicit completion status per turn (success/error/killed/timeout) in runtime-visible metadata.
2. For externally imported sessions, mark status as `unknown_external` unless terminal marker is observed.

### Operational Guardrails

1. Detect and warn when multiple dev server watchers are running against same workspace.
2. Add diagnostics endpoint exposing runtime identity aliases and active process map for incident triage.

## 9) Immediate Tactical Fixes (Low-Risk, High ROI)

1. Fix client `init` reconciliation to prune stale conversations not present in authoritative snapshot unless explicitly pending/optimistic.
2. Expose `sessionId` in server `toJSON()` and shared schema for observability.
3. Remove hardcoded startup `limit = 500`; honor `CWV_STARTUP_INITIAL_LOAD_LIMIT`.
4. Add debug logging/event for identity transitions (`conversationId` <-> `sessionId`) so split-thread incidents are auditable.

## 10) Repro Scenarios for Incoming Agent

### Repro A: Identity Split on Restart

1. Create new conversation (client UUID).
2. Send message to start Codex turn, capture provider session id.
3. Restart server during/after turn.
4. Reconnect client.
5. Observe whether old UUID + provider ID both appear.

### Repro B: External Session Ingestion Confusion

1. Run external `codex exec` in another repo/folder.
2. Keep web UI open in current repo.
3. Observe new conversation rows injected from external writes.
4. Confirm user-perceived split/confusion.

### Repro C: Mid-Turn Termination UX

1. Start long-running turn with tool calls.
2. Trigger server restart or process interruption.
3. Verify whether user receives explicit terminal reason vs silent stop.

## 11) Linked Package Risk Note (`@nbardy/agent-cli`)

This server uses a local linked package ([server/package.json](/Users/nicholasbardy/git/claude-web-view/server/package.json):13):

- `"@nbardy/agent-cli": "link:../../agent-cli-tool"`

Observed at investigation time:

1. linked repo has local modifications in `src/build.ts`, `src/harnesses/codex.ts`, `src/run.ts`, `src/types.ts`, `test/run.test.ts`.
2. Dist files are present and recent, but local dirty state means runtime behavior can diverge across machines/runs.

This is not a proven root cause for this incident, but it is a material reproducibility risk.

## 12) Final Assessment

This incident is a multi-factor systems bug, not a single parser defect.

Primary fix target should be identity and reconciliation architecture (conversation vs session identity, authoritative snapshot semantics). Runtime interruption handling has been improved already, but user trust issues will persist until split-thread and multi-UUID ambiguity are resolved at the model-contract level.

