# Velix

**Velix** is an AI-powered desktop IDE and development environment built with React and TypeScript, with both **Tauri** and **Electron** desktop runtimes. It combines a fully-featured code editor, integrated terminal, and advanced AI capabilities into a single, native application designed to supercharge your development workflow.

## Features

### Core IDE Features
- **Native Desktop Application** — Run with either Tauri (Rust backend) or Electron (Node backend) across macOS, Windows, and Linux
- **Integrated Terminal** — Full PTY terminal emulator with support for multiple tabs, split views, and persistent shell sessions
- **File Explorer** — Browse, open, and manage project files with a tree-view sidebar
- **Code Editor** — Syntax-highlighted editor with configurable tab sizes and theme support
- **Quick File Finder** — Instantly jump to any file in your project with `Cmd/Ctrl+P`
- **Global Search** — Search across all files in your workspace
- **Theme Support** — Light and dark modes with system preference detection

### AI-Powered Development
- **Multi-Provider AI Support** — Seamlessly switch between Claude, ChatGPT (OpenAI), Gemini (Google), and GLM4
- **Full Workspace Context** — AI understands your entire project structure and codebase for intelligent, context-aware responses
- **Inline Code Assistance** — Ask AI questions directly from the terminal; it can read, create, and modify files across your project
- **Voice Chat** — Hands-free voice interaction with AI (requires OpenAI API key)
- **OpenCode Integration** — Powered by the [OpenCode](https://opencode.ai) engine, an open-source AI coding agent

### Advanced AI Orchestration
- **Automation Panel** — Run multiple AI agents automatically to accomplish complex, multi-step tasks
- **Claude Swarm** — Advanced multi-agent orchestration system with:
  - Task complexity analysis
  - Automatic agent spawning and coordination
  - Approval queues for human-in-the-loop control
  - Safety controls (safe mode, dry run)
  - Per-agent terminals for monitoring

### Git Integration
- **Git Panel** — View changed files, stage changes, and manage your repository
- **Status Indicators** — See modified, added, and deleted files at a glance
- **Terminal Git Context** — AI understands your current git state for smarter suggestions

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (for Tauri runtime)
- An API key from one of the supported AI providers (Claude, OpenAI, Gemini, or GLM4)

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/velix.git
cd velix

# Install dependencies
npm install

# Run in development mode (Tauri)
npm run tauri dev

# Run in development mode (Electron)
npm run dev:electron

# Build frontend for production
npm run build

# Run desktop shell with built frontend (Electron)
npm run electron

# Build desktop app bundle (Tauri)
npm run tauri build
```

### Configuration

1. Launch Velix and click **Settings** in the sidebar
2. Add your API key(s) for the AI provider(s) you want to use
3. Select your preferred AI model
4. Open a project folder to begin coding with AI assistance

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + P` | Quick file finder |
| `Cmd/Ctrl + D` | New terminal tab |
| `Cmd/Ctrl + W` | Close current terminal tab |

## Architecture

```
velix/
├── src/                 # React frontend
│   ├── components/      # UI components
│   ├── services/        # AI, workspace, audio services
│   └── App.tsx          # Main application
├── electron/            # Electron main/preload runtime bridge
├── src-tauri/           # Rust backend (Tauri)
└── velixcode/           # OpenCode AI engine integration
```

## Technology Stack

- **Frontend**: React 19, TypeScript, Vite
- **Desktop Runtime**: Tauri 2 (Rust) and Electron (Node.js)
- **Terminal**: xterm.js
- **AI Engine**: OpenCode
- **Styling**: CSS with theme variables

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Credits

Velix is powered by [**OpenCode**](https://opencode.ai), an open-source AI coding agent developed by [Anomaly](https://github.com/anomalyco/opencode). OpenCode provides the core AI engine that enables Velix's intelligent code assistance, multi-provider support, and agent orchestration capabilities.

We are grateful to the OpenCode team for building such a powerful and flexible AI coding foundation.

## License

See [LICENSE](LICENSE) for details.
