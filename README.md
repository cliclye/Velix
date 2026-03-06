# Velix

> An AI-powered desktop IDE that brings multi-provider AI, a full terminal, and a code editor into one native application.

Built with React + TypeScript on the frontend, with both **Tauri** (Rust) and **Electron** (Node.js) desktop runtimes. Designed around a minimal, distraction-free workflow — warm neutrals, deep teal accents, and everything you need in a single window.

---

## Features

**Core IDE**
- Native desktop app — macOS, Windows, Linux via Tauri or Electron
- Full PTY terminal with tabs, split views, and persistent sessions
- File explorer with tree-view sidebar
- Syntax-highlighted code editor with configurable tab sizes and theme support
- Quick file finder — `Cmd/Ctrl+P` to jump anywhere instantly
- Global search across your entire workspace
- Light and dark themes with automatic system preference detection

**AI-Powered Development**
- Multi-provider support — Claude, OpenAI, Gemini, GLM4
- Full workspace context — AI reads your project structure and files
- Inline assistance from the terminal — ask, create, edit, refactor
- Voice chat for hands-free interaction (requires OpenAI API key)
- Powered by [OpenCode](https://opencode.ai), an open-source AI coding agent

**Multi-Agent Orchestration**
- Automation panel — run multiple AI agents on complex, multi-step tasks
- Claude Swarm — spawn and coordinate multiple agents automatically
  - Task complexity analysis
  - Human-in-the-loop approval queues
  - Safe mode and dry-run controls
  - Per-agent terminal views for full visibility

**Git Integration**
- Git panel — view diffs, stage changes, manage your repo
- File status indicators (modified, added, deleted)
- AI-aware git context for smarter suggestions

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Rust](https://www.rust-lang.org/tools/install) (required for Tauri runtime only)
- An API key from at least one supported AI provider

### Install

```bash
git clone https://github.com/your-username/velix.git
cd velix
npm install
```

### Run

```bash
# Tauri (Rust backend) — recommended for production use
npm run tauri dev

# Electron (Node.js backend)
npm run dev:electron
```

### Build

```bash
# Frontend only
npm run build

# Electron desktop bundle
npm run electron

# Tauri desktop bundle
npm run tauri build
```

### Configure

1. Open Velix and go to **Settings** in the sidebar
2. Add your API key(s) for the AI provider(s) you want
3. Select a model
4. Open a project folder — the AI will index it automatically

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + P` | Quick file finder |
| `Cmd/Ctrl + D` | New terminal tab |
| `Cmd/Ctrl + W` | Close current terminal tab |

---

## Architecture

```
velix/
├── src/                  # React 19 + TypeScript frontend
│   ├── components/       # UI components (editor, terminal, panels, AI chat)
│   ├── services/         # AI, workspace, audio, and git services
│   ├── styles/           # Component and global styles
│   └── App.tsx           # Root application
├── electron/             # Electron main process and preload bridge
├── src-tauri/            # Rust backend (Tauri 2)
│   └── src/              # Tauri commands and native integrations
├── public/               # Static assets
└── scripts/              # Build and dev helper scripts
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite |
| Desktop | Tauri 2 (Rust), Electron (Node.js) |
| Terminal | xterm.js + node-pty |
| AI Engine | OpenCode |
| Styling | CSS custom properties, JetBrains Mono, Inter |

---

## Development Setup

Recommended: [VS Code](https://code.visualstudio.com/) with these extensions:
- [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

---

## Credits

Velix is built on [**OpenCode**](https://opencode.ai) by [Anomaly](https://github.com/anomalyco/opencode) — an open-source AI coding agent that powers the context engine, multi-provider routing, and agent orchestration.

---

## License

See [LICENSE](LICENSE) for details.
