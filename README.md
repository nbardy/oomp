# oomp

A cross-client layer on top of agent swarms.

![oomp](docs/screenshots/gallery.png)

## The problem

You run agents from different CLIs — Claude Code, Codex, Gemini, OpenCode. Each has its own terminal, its own session history, its own way of showing what happened. When you're running a swarm of agents across a codebase, there's no single place to see what's going on, steer the work, or review what was done.

## What oomp does

Two things:

**1. Visibility and organization across all your agents.**
See every conversation from every CLI agent, organized by project. Search across all of them. No more flipping between terminals trying to remember which agent you asked to do what.

**2. Launch and manage long-running agent swarms.**
Swarms are treated as two things at once:

- **Background jobs** — they run in a loop, autonomously, without interruption.
- **Artifacts** — they can be inspected, discussed, and steered through conversation.

Swarms continue without you. But you guide them. From the same chat interface, you can launch a swarm, check its progress, debug a failing worker, or review its output.

### Swarm Analytics

Track multi-agent swarm runs — iterations, merges, rejections, per-worker timelines.

![Swarm Analytics](docs/screenshots/swarm-analytics.png)

## Quick Start

**Prerequisites:** [pnpm](https://pnpm.io/) and at least one supported CLI agent installed and authenticated (e.g. `claude`).

```bash
pnpm install
pnpm dev
```

Opens at [http://localhost:5173](http://localhost:5173) (client) with the API server on port 3000.

### Production

```bash
pnpm build
pnpm start     # serves built client + API on port 3000
```

## Supported Agents

| Agent | Disk path read | Live spawn |
|-------|---------------|------------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `~/.claude/projects/` | Yes |
| [Codex](https://github.com/openai/codex) | `~/.codex/sessions/` | Yes |
| [OpenCode](https://github.com/opencode-ai/opencode) | `~/.local/share/opencode/` | No (read-only) |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `~/.gemini/tmp/` | Yes |

The server auto-discovers conversations from each agent's disk format. No configuration needed — if the CLI has been used, its sessions show up.

## Project Structure

```
client/     React + Vite frontend
server/     Express + WebSocket backend
shared/     Shared types (Zod schemas)
```

## License

MIT
