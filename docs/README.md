# Documentation Index

This directory contains design documents, feature specifications, and maintenance notes for the Claude Web View project.

---

## Core Architecture

### [`agent_client_spec.md`](./agent_client_spec.md)
**Provider Pattern for CLI Agents**

How the app integrates with multiple CLI agents (Claude, Codex) through a unified `Provider` interface. Covers conversation mode (stateful streaming) vs single-shot mode (one-off tasks).

**Key sections**:
- Provider interface definition
- Output parsing and event normalization
- Adding new providers

---

## Persistence & State

### [`persistence_design.md`](./persistence_design.md)
**JSONL File Format for Conversation History**

How conversations are persisted to `~/.claude-web-view/conversations/{id}.jsonl` files. Covers entry types (user, assistant, system, progress), content blocks (text, thinking, tool use/result), and file polling for external edits.

**Key sections**:
- JSONL entry schema
- File watching and sync
- Codex native session import

---

## Features

### [`new_badge_feature.md`](./new_badge_feature.md) ⭐ **NEW** (2026-02-02)
**"NEW" Badge for Unread Messages**

Shows a badge on sidebar conversation items when they contain unseen messages. Badge disappears when user views the conversation and scrolls to see the new messages.

**Key sections**:
- State tracking mechanism (message index in localStorage)
- IntersectionObserver for visibility detection
- Visual design (pill badge, placement, colors)
- Edge cases (empty conversations, first visit, external edits, etc.)
- Storage decision: localStorage vs DB
- Performance characteristics
- Testing scenarios

**Related files**:
- `client/src/stores/uiStore.ts` — State management
- `client/src/components/Chat.tsx` — IntersectionObserver
- `client/src/components/Sidebar.tsx` — Badge rendering
- `client/src/components/Sidebar.css` — Badge styling
- `client/src/stores/conversationStore.ts` — Sync on external changes

---

### [`ralph_loop_design.md`](./ralph_loop_design.md)
**Ralph Loop Feature (Iterative Prompts)**

Allows running the same prompt N times (5/10/20 iterations) with optional context clearing between iterations. Server-driven execution with client UI for loop countdown and progress tracking.

**Key sections**:
- Loop lifecycle (start, iteration, complete, cancel)
- Server state management
- Client queue integration
- Loop markers in message history

---

## UI & Design

### [`COLOR_DESIGN.md`](./COLOR_DESIGN.md)
**Color System and Palette Picker**

Current color palette definitions, CSS variables, and custom palette picker component. Covers dark-mode-first design, color-mix usage, and per-project color assignment.

### [`color_palette_redesign.md`](./color_palette_redesign.md)
**Color Palette Redesign Notes**

Historical notes on color system evolution and palette picker feature development.

### [`color_palette.md`](./color_palette.md)
**Original Color Palette Spec**

Earlier color system documentation (kept for reference).

---

## Maintenance

### [`MAINTENANCE.md`](./MAINTENANCE.md) 📘 **START HERE FOR NEW DEVS**
**Maintenance Guide & Common Patterns**

Comprehensive guide to codebase patterns, edge cases, and troubleshooting. Read this before making significant changes.

**Key sections**:
- State management patterns (localStorage, zustand-persist)
- React hooks rules (call order is critical)
- IntersectionObserver best practices
- Zustand store best practices (targeted selectors, race conditions)
- WebSocket message handling (chunk buffering)
- NEW badge feature quick reference
- Common pitfalls (uncontrolled textareas, provider pattern)
- When to move to a database
- Testing notes

---

## Quick Links by Task

### "I want to add a new CLI provider"
1. Read [`agent_client_spec.md`](./agent_client_spec.md)
2. See `server/src/providers/claude.ts` and `server/src/providers/codex.ts` as examples
3. Check [`MAINTENANCE.md`](./MAINTENANCE.md) section "Provider Pattern"

### "I want to add a new UI feature"
1. Read [`MAINTENANCE.md`](./MAINTENANCE.md) sections on state management and React hooks
2. Check [`new_badge_feature.md`](./new_badge_feature.md) as a reference implementation
3. If it involves visibility detection, see IntersectionObserver patterns in [`MAINTENANCE.md`](./MAINTENANCE.md)

### "I want to understand conversation persistence"
1. Read [`persistence_design.md`](./persistence_design.md) for JSONL format
2. Check `server/src/conversation.ts` for server-side implementation
3. Check `server/src/adapters/jsonl.ts` for parsing/writing

### "I want to modify the color system"
1. Read [`COLOR_DESIGN.md`](./COLOR_DESIGN.md) for current palette
2. Check `client/src/components/ColorPalettePicker.tsx` for picker component
3. CSS variables are in `client/src/index.css`

### "Something broke after I changed state management"
1. Check [`MAINTENANCE.md`](./MAINTENANCE.md) section "State Management Patterns"
2. If React error #310: See "React Hooks: Call Order is Critical"
3. If badge shows incorrectly: See "NEW Badge Feature (Quick Reference)"

### "I want to understand the NEW badge feature"
1. Read [`new_badge_feature.md`](./new_badge_feature.md) for full design
2. Check [`MAINTENANCE.md`](./MAINTENANCE.md) for troubleshooting ("If Badge Shows Incorrectly")
3. See code comments in:
   - `client/src/stores/uiStore.ts` (lines 10-16)
   - `client/src/components/Chat.tsx` (lines 138-143, 310-334)
   - `client/src/components/Sidebar.tsx` (lines 251-254)
   - `client/src/stores/conversationStore.ts` (lines 694-704)

---

## Project Rules

### [`../CLAUDE.md`](../CLAUDE.md) (Project Root)
**Project-wide coding rules and conventions**

**Key rules**:
- React Hooks: Always call hooks BEFORE early returns
- Provider Pattern: One interface, two modes
- Zustand: Targeted selectors, stable references
- Race conditions: setState closures
- Uncontrolled textareas for streaming UIs

### [`~/.claude/CLAUDE.md`](~/.claude/CLAUDE.md) (User Global)
**User's global instructions (apply to all projects)**

**Key rules**:
- Code Quality: One clean path, no fallbacks, fail eagerly
- Python Environment: Always use `uv` (not `pip`)

---

## Documentation Standards

When adding new features or fixing tricky bugs:

1. **Write a design doc** (see [`new_badge_feature.md`](./new_badge_feature.md) as template)
   - Overview and rationale
   - Architecture decisions
   - Implementation details
   - Edge cases handled
   - Testing scenarios
   - Maintenance notes

2. **Add code comments** where non-obvious
   - Top-of-file overview for complex modules
   - Inline comments for tricky logic
   - Reference the design doc: `// See docs/feature_name.md`

3. **Update [`MAINTENANCE.md`](./MAINTENANCE.md)** if you:
   - Discover a common pitfall
   - Add a new pattern that devs should follow
   - Fix a subtle bug that could recur

4. **Update this README** to link your new doc

---

## Contributing

Before making significant changes:
1. Read [`MAINTENANCE.md`](./MAINTENANCE.md) (especially if you're new)
2. Check if there's an existing design doc for the area you're modifying
3. Follow project rules in [`CLAUDE.md`](../CLAUDE.md)
4. Write tests if adding new features (currently manual testing only)
5. Update docs if you change behavior

**Good commits**:
- Include "why" in commit messages, not just "what"
- Reference design docs when implementing from them
- Use `Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>` if AI-assisted

---

## File Organization

```
docs/
├── README.md                      ← You are here
├── MAINTENANCE.md                 ← Start here for new devs
├── agent_client_spec.md           ← Provider pattern
├── persistence_design.md          ← JSONL format
├── new_badge_feature.md          ← NEW badge (2026-02-02)
├── ralph_loop_design.md          ← Loop feature
├── COLOR_DESIGN.md               ← Color system
├── color_palette_redesign.md     ← Color redesign notes
└── color_palette.md              ← Original color spec
```

---

Last updated: 2026-02-02
