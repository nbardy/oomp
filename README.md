# oomp

A hackable client for agentic programming.

Auto-reloads and lets you edit your own programming environment with agents as you code. Wishing your agent tool had a feature you need? Just open a conversation on `~/git/oomp` and ask for it.

Just like Vim and Emacs ruled the old engineering flow with their open-source extension ecosystems, oomp provides that same hackable baseline for the agent era.

![oomp](docs/screenshots/gallery.png)

## What it does

A conversational UI for both individual agent chats and launching agent swarms. Built on top of [oompa](https://github.com/nbardy/oompa) (an open-source swarm library) and a shared CLI interface. Provides a modern web-based UI to get away from the slowness and feature-poor setup of TUIs.

No more flipping between many CLIs trying to remember which one you did which work in. Cross-model, cross-client — one place for everything.

**Features:**
- Inline hover previews for image paths and videos
- Multiple color palettes
- Cross-agent folder-based organization
- Cross-agent search

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
