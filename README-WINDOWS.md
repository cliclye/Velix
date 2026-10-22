# Velix for Windows

Native Windows build of [Velix](https://github.com/cliclye/Velix) — the AI-powered desktop IDE with terminal, editor, git, Swarm agents, Agent Loop, and Command Palette.

## Download

Pre-built installers are published on the [Releases](https://github.com/cliclye/velixWin/releases) page:

- **Velix_x64-setup.exe** — recommended NSIS installer
- **Velix_x64_en-US.msi** — MSI installer (optional)

Or download from [vexilo.xyz](https://vexilo.xyz/#download).

## Requirements

- Windows 10 or 11 (64-bit)
- [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (included on Windows 11; installer bundles bootstrapper if needed)
- An API key from at least one supported AI provider

## Features

Same as the macOS version:

- Full PTY terminal with tabs and split panes
- Syntax-highlighted editor and quick file finder (`Ctrl+P`)
- Git panel with diff approval
- Swarm Mode — parallel AI agents
- Agent Loop — autonomous plan/act/observe/reflect
- MAX Mode — maximum-effort agent directives
- Command Palette — `Ctrl+K`
- 9 AI providers with local API key storage

## Build from source

```powershell
git clone https://github.com/cliclye/velixWin.git
cd velixWin
npm install
npm run tauri build
```

Install [Rust](https://rustup.rs/), [Node.js 18+](https://nodejs.org/), and Visual Studio Build Tools with the **Desktop development with C++** workload.

Output: `src-tauri\target\release\bundle\nsis\Velix_*_x64-setup.exe`

## CI

Pushes to `main` and version tags trigger `.github/workflows/build-windows.yml` on `windows-latest`.

## License

See [LICENSE](LICENSE).
