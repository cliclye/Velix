# Velix

> A calm desktop workspace for working with AI coding agents: a real terminal, git and search panels, and **Swarm** — a coordinator that splits a goal across parallel Claude Code / Gemini / Codex workers and reviews the result.

Built with React 19 + TypeScript and **Tauri 2** (Rust). Warm paper-and-ink design in light and dark, one deep-teal accent, nothing in the way.

---

## What's in the box

**Terminal workspace**
- Real PTY terminals (xterm.js) with tabs, split panes (drag to rearrange) and one-click launchers for agent CLIs
- Ask / edit with an AI model from the prompt bar, with the project as context (multi-provider: Claude, OpenAI, Gemini, GLM, MiniMax, Kimi, DeepSeek, Groq, Mistral)
- Git panel (status, diffs, branches, pull/push/fetch) and project-wide search
- Voice chat (needs an OpenAI key)

**Swarm** — parallel agents with a review gate
1. You describe the goal (or start from a preset: feature, bug fix, tests, refactor, security audit, docs).
2. A **coordinator** model plans non-overlapping lanes with file ownership.
3. **Scouts** map the code, **builders** implement in parallel, **reviewers** inspect the real working tree and return `APPROVED` / `REVISE`.
4. `REVISE` sends builders back with the reviewers' feedback (up to N rounds).
5. You get a Markdown **report**: result, duration, cost, files changed (from `git status`), per-worker outcome. Past runs are kept in history.

Swarm details that matter:
- Each worker is one headless CLI process (`claude -p`, `codex exec`, `gemini -p`, …) started directly by the Rust backend — no shell, no quoting, prompt over stdin.
- Live activity per worker (tool calls, edited files) for Claude Code via `stream-json`; the others show output as they print it.
- **Stop** really stops: SIGTERM, then SIGKILL, to the worker's whole process group. Workers are also killed when Velix quits.
- A run lives outside the UI: close the Swarm tab, switch tabs, keep working — it keeps going, and the activity bar and status bar show it.
- Bounded parallelism, per-worker hard timeout (20 min, 45 in Max mode), and failed workers are reported instead of silently ignored.

**Everywhere**
- `⌘/Ctrl + K` command palette, `⌘/Ctrl + /` shortcut sheet
- Light and dark themes (follows the system until you choose)

---

## Requirements

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install) (stable) and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your OS
- For Swarm: at least one worker CLI installed and logged in (e.g. [Claude Code](https://docs.anthropic.com/claude-code)), plus an API key for the **coordinator** model in Settings

## Run

```bash
git clone https://github.com/cliclye/velix.git
cd velix
npm install
npm run tauri dev
```

```bash
npm run build          # type-check + frontend build
npm run tauri build    # desktop bundle
```

### Configure

1. Open **Settings** and add an API key for the provider you want the coordinator/chat to use.
2. Open a project folder (top-left).
3. Open **Swarm**, pick a preset or describe a goal, and launch.

Claude Code workers use their own login by default. Tick *Use my saved Anthropic key for Claude Code* under **Options** to pass your saved key instead.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘/Ctrl + K` | Command palette |
| `⌘/Ctrl + /` | Keyboard shortcuts |
| `⌘/Ctrl + ,` | Settings |
| `⌘/Ctrl + D` | Split the terminal pane |
| `⌘/Ctrl + W` | Close pane or tab |
| `⌘/Ctrl + Enter` | Launch the swarm (goal box focused) |

---

## Architecture

```
velix/
├── src/                      React + TypeScript frontend
│   ├── components/           Terminal, panels, settings, command palette
│   │   └── swarm/            Composer, board, graph, report, agent drawer
│   ├── services/
│   │   ├── ai/               Provider clients (via the Rust backend)
│   │   └── swarm/            Engine: runner, session store, coordinator, CLI adapters
│   └── App.tsx
└── src-tauri/src/
    ├── lib.rs                Tauri commands: PTY, git, search, AI proxy, settings
    └── agent.rs              Swarm worker process runner (spawn, stream, kill, timeout)
```

Swarm data flow: `SwarmSession` (store, outside React) → `SwarmRunner` (scouts → builders ⇄ reviewers) → `AgentManager` → Tauri `agent_spawn` → `agent.rs` → CLI process; `agent-event` (output / exit) flows back the same way.

## Tests

```bash
npm test               # vitest: engine, runner, session store, parsing (75 tests)
npm run test:rust      # cargo test: process runner incl. process-tree kill (13 tests)
npm run typecheck
```

The swarm tests run the real `SwarmSession`/`SwarmRunner`/`AgentManager` against a fake process transport; the Rust tests run real child processes (stdin, timeouts, SIGTERM-ignoring workers, grandchildren, multibyte output).

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite |
| Desktop | Tauri 2 (Rust) |
| Terminal | xterm.js + `portable-pty` |
| Swarm workers | Direct child processes (`std::process`) with process-group control |
| Styling | CSS custom properties; Newsreader, Inter, JetBrains Mono |

## License

See [LICENSE](LICENSE).
