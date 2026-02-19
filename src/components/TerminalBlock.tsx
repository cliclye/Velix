import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import "@xterm/xterm/css/xterm.css";
import "./TerminalBlock.css";
import { aiService } from "../services/ai/AIService";
import { ChatMessage, PROVIDERS } from "../services/ai/types";
import { workspaceService, WorkspaceContext } from "../services/workspace";

// Web Speech API type declarations
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: ((this: SpeechRecognition, ev: Event) => any) | null;
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => any) | null;
  onerror: ((this: SpeechRecognition, ev: Event) => any) | null;
  onend: ((this: SpeechRecognition, ev: Event) => any) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

interface TerminalBlockProps {
  cwd?: string;
  onCwdChange?: (cwd: string) => void;
  theme?: "light" | "dark";
  onAIRequest?: (prompt: string) => void;
  aiEnabled?: boolean;
  recentFiles?: string[];
  gitChanges?: Array<{ path: string; type: 'M' | 'A' | 'D' | '?' }>;
  // File context - the currently open/active file
  currentFile?: {
    path: string;
    content: string;
    language: string;
  };
  onFileUpdate?: (path: string, content: string) => void;
  // Project context - available even without an open file
  projectDir?: string;
  projectFileList?: string[];
  projectFileContents?: Record<string, string>;
  // Structured workspace context from WorkspaceService
  workspaceContext?: WorkspaceContext | null;
}

export interface TerminalRef {
  write: (data: string) => void;
  focus: () => void;
}

interface PtyOutput {
  session_id: string;
  data: string;
}

interface PtyExit {
  session_id: string;
  exit_code: number | null;
}

// Local command suggestion engine — returns full predicted command or empty string
function getLocalCommandSuggestion(input: string, npmScripts: string[]): string {
  const lower = input.toLowerCase();
  if (!input.trim()) return '';

  // npm suggestions driven by package.json scripts
  if (lower === 'npm') {
    const preferred = npmScripts.find(s => s.includes('tauri') || s === 'dev') || npmScripts[0];
    return preferred ? `npm run ${preferred}` : 'npm run dev';
  }
  if (lower.startsWith('npm run ')) {
    const partial = lower.slice('npm run '.length);
    const match = npmScripts.find(s => s.toLowerCase().startsWith(partial) && s.toLowerCase() !== partial);
    if (match) return `npm run ${match}`;
    const common = ['dev', 'build', 'start', 'test', 'tauri', 'tauri dev', 'lint', 'preview'];
    const cm = common.find(s => s.startsWith(partial) && s !== partial);
    if (cm) return `npm run ${cm}`;
  }
  if (lower.startsWith('npm r') && !lower.startsWith('npm run')) {
    const partial = lower.slice('npm '.length);
    if ('run'.startsWith(partial)) {
      const preferred = npmScripts.find(s => s.includes('tauri') || s === 'dev') || npmScripts[0];
      if (preferred) return `npm run ${preferred}`;
    }
  }
  if (lower === 'npm i') return 'npm install';
  if (lower === 'npm in') return 'npm install';
  if (lower === 'npm ins') return 'npm install';
  if (lower === 'npm inst') return 'npm install';

  // git suggestions
  const gitMap: Record<string, string> = {
    'git': 'git status',
    'git s': 'git status', 'git st': 'git status', 'git sta': 'git status',
    'git stat': 'git status', 'git statu': 'git status',
    'git c': 'git commit -m ""', 'git co': 'git commit -m ""', 'git com': 'git commit -m ""',
    'git comm': 'git commit -m ""', 'git commi': 'git commit -m ""', 'git commit': 'git commit -m ""',
    'git p': 'git push', 'git pu': 'git push', 'git pus': 'git push',
    'git pul': 'git pull', 'git pull': 'git pull',
    'git a': 'git add .', 'git ad': 'git add .', 'git add': 'git add .',
    'git l': 'git log --oneline', 'git lo': 'git log --oneline', 'git log': 'git log --oneline',
    'git b': 'git branch', 'git br': 'git branch', 'git bra': 'git branch',
    'git bran': 'git branch', 'git branc': 'git branch',
    'git ch': 'git checkout', 'git che': 'git checkout', 'git chec': 'git checkout',
    'git d': 'git diff', 'git di': 'git diff', 'git dif': 'git diff',
    'git f': 'git fetch', 'git fe': 'git fetch', 'git fet': 'git fetch',
    'git cl': 'git clone', 'git clo': 'git clone', 'git clon': 'git clone',
    'git m': 'git merge', 'git me': 'git merge',
    'git r': 'git reset HEAD~1', 're': 'git rebase',
  };
  if (gitMap[lower]) return gitMap[lower];

  // cargo suggestions
  const cargoMap: Record<string, string> = {
    'cargo': 'cargo build',
    'cargo b': 'cargo build', 'cargo bu': 'cargo build', 'cargo bui': 'cargo build', 'cargo buil': 'cargo build',
    'cargo r': 'cargo run', 'cargo ru': 'cargo run',
    'cargo t': 'cargo test', 'cargo te': 'cargo test', 'cargo tes': 'cargo test',
    'cargo c': 'cargo check', 'cargo ch': 'cargo check', 'cargo che': 'cargo check', 'cargo chec': 'cargo check',
    'cargo cl': 'cargo clean', 'cargo cle': 'cargo clean', 'cargo clea': 'cargo clean',
  };
  if (cargoMap[lower]) return cargoMap[lower];

  // yarn / pnpm
  if (lower === 'yarn') return 'yarn dev';
  if (lower === 'pnpm') return 'pnpm dev';

  // ls
  if (lower === 'ls') return 'ls -la';
  if (lower === 'ls -') return 'ls -la';
  if (lower === 'ls -l') return 'ls -la';

  return '';
}

// Detect if input is an AI request (starts with natural language patterns)
function isAIRequest(input: string): boolean {
  const trimmed = input.trim().toLowerCase();

  // Empty or very short inputs are terminal commands
  if (trimmed.length < 3) return false;

  // Strong AI indicators - these should definitely go to AI
  const strongAIPatterns = [
    // Questions
    /^(can you|could you|will you|would you|please|help me|how (do|can|to|would|should)|what is|what are|what's|whats|explain|describe|tell me|show me|why|where|when|who|which)/i,
    // Requests for help/creation
    /^(create|make|build|write|generate|fix|add|remove|update|change|modify|improve|optimize|refactor|debug|solve|implement|design|develop|code|program)/i,
    // Personal expressions
    /^(i want|i need|i'd like|i have|i'm trying|im trying|let's|lets|can we|could we)/i,
    // Question marks
    /\?$/,
    // Conversational patterns
    /^(hey|hello|hi|thanks|thank you|sorry|excuse me)/i,
  ];

  // Definite terminal commands - these should NEVER go to AI
  const terminalCommands = [
    // Basic shell commands
    'ls', 'cd', 'pwd', 'cat', 'echo', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'grep', 'find',
    // File operations
    'chmod', 'chown', 'chgrp', 'ln', 'stat', 'file', 'wc', 'head', 'tail', 'sort', 'uniq',
    // System commands
    'ps', 'top', 'htop', 'kill', 'killall', 'jobs', 'bg', 'fg', 'nohup', 'screen', 'tmux',
    // Network
    'ping', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'netstat', 'lsof',
    // Package managers
    'npm', 'yarn', 'pnpm', 'pip', 'pip3', 'apt', 'apt-get', 'brew', 'cargo', 'go',
    // Git commands
    'git', 'gitk', 'gitg',
    // Editors
    'vim', 'vi', 'nano', 'emacs', 'code', 'subl', 'atom',
    // System admin
    'sudo', 'su', 'passwd', 'chmod', 'chown', 'systemctl', 'service', 'journalctl',
    // Development tools
    'node', 'python', 'python3', 'java', 'javac', 'gcc', 'clang', 'make', 'cmake', 'cargo',
    // Utilities
    'man', 'which', 'whereis', 'who', 'w', 'id', 'date', 'uptime', 'df', 'du', 'free',
    // Shell built-ins
    'exit', 'clear', 'history', 'alias', 'export', 'source', 'cd', 'pwd', 'echo',
  ];

  // Path patterns - definitely terminal
  const pathPatterns = [
    /^\.\//,  // ./something
    /^\//,    // /absolute/path
    /^~/,     // ~/path
    /^\.\.$/, // ..
    /^[a-zA-Z]:/, // Windows drive letter
  ];

  // File extensions - likely terminal commands
  const fileExtensions = [
    /\.(js|ts|jsx|tsx|py|java|cpp|c|h|go|rs|rb|php|sh|bash|zsh|fish|html|css|scss|less|json|xml|yaml|yml|toml|ini|conf|log|txt|md|sql|dockerfile|makefile|cmake)$/i,
  ];

  // First check for strong AI patterns
  for (const pattern of strongAIPatterns) {
    if (pattern.test(trimmed)) return true;
  }

  // Check for definite terminal commands
  const firstWord = trimmed.split(/\s+/)[0];
  if (terminalCommands.includes(firstWord)) return false;

  // Check for path patterns
  for (const pattern of pathPatterns) {
    if (pattern.test(trimmed)) return false;
  }

  // Check for file operations with extensions
  for (const pattern of fileExtensions) {
    if (pattern.test(trimmed)) return false;
  }

  // Check if it looks like a command with flags (e.g., "npm install", "git commit")
  if (/^[a-z][a-z0-9]*\s+-[a-z]/i.test(trimmed)) return false;

  // Check if it contains programming keywords mixed with natural language
  const programmingKeywords = ['function', 'class', 'method', 'variable', 'array', 'object', 'string', 'number', 'boolean', 'loop', 'if', 'else', 'for', 'while', 'switch', 'case', 'try', 'catch', 'error', 'bug', 'issue', 'problem', 'solution'];
  const hasProgrammingKeyword = programmingKeywords.some(keyword => trimmed.includes(keyword));

  // Natural language indicators
  const naturalLanguageIndicators = [
    // Multiple words (likely natural language)
    trimmed.split(/\s+/).length >= 4,
    // Contains articles, prepositions, pronouns
    /^(the|a|an|this|that|these|those|my|your|our|their|its|i|we|you|he|she|it|they)\s/i.test(trimmed),
    // Conversational tone
    /(please|can you|could you|help|thanks|thank you|sorry|excuse me)/i.test(trimmed),
    // Programming context with natural language
    hasProgrammingKeyword && trimmed.split(/\s+/).length >= 3,
  ];

  // If any natural language indicators are true, treat as AI
  if (naturalLanguageIndicators.some(indicator => indicator)) return true;

  // Default to terminal for ambiguous cases
  return false;
}

export const TerminalBlock = forwardRef<TerminalRef, TerminalBlockProps>(({
  cwd,
  theme = "dark",
  onAIRequest: _onAIRequest,
  aiEnabled = false,
  recentFiles: _recentFiles = [],
  gitChanges = [],
  currentFile,
  onFileUpdate,
  projectDir,
  projectFileList = [],
  projectFileContents = {},
  workspaceContext: wsContext = null,
}, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string>("");
  const unlistenOutputRef = useRef<UnlistenFn | null>(null);
  const unlistenExitRef = useRef<UnlistenFn | null>(null);

  const [inputValue, setInputValue] = useState("");
  const [inputMode, setInputMode] = useState<"terminal" | "ai">("terminal");
  const [isListening, setIsListening] = useState(false);
  const [hideInputCard, setHideInputCard] = useState(false);
  const [isAIProcessing, setIsAIProcessing] = useState(false);
  const [aiConversation, setAiConversation] = useState<ChatMessage[]>([]);
  const [commandSuggestion, setCommandSuggestion] = useState<string>("");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [currentAIConfig, setCurrentAIConfig] = useState(() => aiService.getConfig());
  const inputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const suggestionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestionRequestId = useRef<number>(0);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  // Close model picker when clicking outside
  useEffect(() => {
    if (!showModelPicker) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showModelPicker]);

  // Generate a unique session ID
  const generateSessionId = () => {
    return `pty-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  };

  // Create PTY session
  const createPtySession = useCallback(async (rows: number, cols: number) => {
    const sessionId = generateSessionId();
    sessionIdRef.current = sessionId;

    try {
      await invoke("pty_create", {
        sessionId,
        rows,
        cols,
        cwd: cwd || undefined,
      });
      return sessionId;
    } catch (error) {
      console.error("Failed to create PTY session:", error);
      throw error;
    }
  }, [cwd]);

  // Write to PTY
  const writeToPty = useCallback(async (data: string) => {
    if (!sessionIdRef.current) return;

    try {
      await invoke("pty_write", {
        sessionId: sessionIdRef.current,
        data,
      });
    } catch (error) {
      console.error("Failed to write to PTY:", error);
    }
  }, []);

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    write: (data: string) => {
      writeToPty(data);
    },
    focus: () => {
      termRef.current?.focus();
    }
  }));

  // Resize PTY
  const resizePty = useCallback(async (rows: number, cols: number) => {
    if (!sessionIdRef.current) return;

    try {
      await invoke("pty_resize", {
        sessionId: sessionIdRef.current,
        rows,
        cols,
      });
    } catch (error) {
      console.error("Failed to resize PTY:", error);
    }
  }, []);

  // Kill PTY session
  const killPtySession = useCallback(async () => {
    if (!sessionIdRef.current) return;

    try {
      await invoke("pty_kill", {
        sessionId: sessionIdRef.current,
      });
    } catch (error) {
      // Session might already be dead
      console.log("PTY session cleanup:", error);
    }
    sessionIdRef.current = "";
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    // Theme configurations
    const darkTheme = {
      background: "#0d1117",
      foreground: "#c9d1d9",
      cursor: "#58a6ff",
      cursorAccent: "#0d1117",
      selectionBackground: "#264f78",
      selectionForeground: "#ffffff",
      black: "#484f58",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
    };

    const lightTheme = {
      background: "#ffffff",
      foreground: "#24292f",
      cursor: "#0969da",
      cursorAccent: "#ffffff",
      selectionBackground: "#0969da33",
      selectionForeground: "#24292f",
      black: "#24292f",
      red: "#cf222e",
      green: "#116329",
      yellow: "#4d2d00",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#1a7f37",
      brightYellow: "#633c01",
      brightBlue: "#218bff",
      brightMagenta: "#a475f9",
      brightCyan: "#3192aa",
      brightWhite: "#8c959f",
    };

    // Create terminal instance
    const term = new Terminal({
      cursorBlink: false,  // No cursor in output area - only in input box
      cursorStyle: "bar",
      fontSize: 13,
      fontFamily: "'SF Mono', 'JetBrains Mono', 'Menlo', 'Monaco', monospace",
      letterSpacing: 0,
      lineHeight: 1.5,
      allowProposedApi: true,
      scrollback: 10000,
      theme: theme === "light" ? lightTheme : darkTheme,
    });

    // Create and load fit addon
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    // Open terminal in container
    term.open(containerRef.current);
    termRef.current = term;

    // Fit terminal to container
    setTimeout(() => {
      fitAddon.fit();
    }, 0);

    // Setup event listeners and PTY session
    const setup = async () => {
      // Listen for PTY output
      unlistenOutputRef.current = await listen<PtyOutput>("pty-output", (event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          const data = event.payload.data;
          term.write(data);

          // Detect if Claude Code is running
          if (data.includes('claude') || data.includes('Claude') || data.includes('anthropic')) {
            // Check for common Claude Code patterns
            if (data.includes('claude-code') ||
              data.includes('Claude Code') ||
              data.includes('How can I help you') ||
              data.includes('I can help with')) {
              setHideInputCard(true);
            }
          }

          // Show input card again when Claude Code exits
          if (data.includes('exit') || data.includes('quit') || data.includes('bye')) {
            setTimeout(() => setHideInputCard(false), 500);
          }
        }
      });

      // Listen for PTY exit
      unlistenExitRef.current = await listen<PtyExit>("pty-exit", (event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          term.writeln("\r\n\x1b[90m[Process exited]\x1b[0m");
          // Optionally restart the shell
          setTimeout(async () => {
            try {
              await createPtySession(term.rows, term.cols);
            } catch (error) {
              term.writeln("\x1b[31mFailed to restart shell\x1b[0m");
            }
          }, 500);
        }
      });

      // Create PTY session
      try {
        await createPtySession(term.rows, term.cols);
      } catch (error) {
        term.writeln(`\x1b[31mFailed to create terminal session: ${error}\x1b[0m`);
      }
    };

    setup();

    // Handle user input - send to PTY
    const onDataDisposable = term.onData((data) => {
      writeToPty(data);
    });

    // Handle terminal resize
    const onResizeDisposable = term.onResize(({ rows, cols }) => {
      resizePty(rows, cols);
    });

    // Handle window resize
    const handleWindowResize = () => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
      }
    };
    window.addEventListener("resize", handleWindowResize);

    // Observe container size changes
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
      }
    });
    resizeObserver.observe(containerRef.current);

    // Cleanup
    return () => {
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      window.removeEventListener("resize", handleWindowResize);
      resizeObserver.disconnect();

      if (unlistenOutputRef.current) {
        unlistenOutputRef.current();
      }
      if (unlistenExitRef.current) {
        unlistenExitRef.current();
      }

      killPtySession();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [createPtySession, writeToPty, resizePty, killPtySession, theme]);

  // Read npm scripts from workspace context or project file contents
  const getNpmScripts = useCallback((): string[] => {
    const pkgContent =
      wsContext?.loadedFiles?.['package.json'] ||
      projectFileContents?.['package.json'];
    if (pkgContent) {
      try {
        const pkg = JSON.parse(pkgContent);
        return Object.keys(pkg.scripts || {});
      } catch {
        return [];
      }
    }
    return [];
  }, [wsContext, projectFileContents]);

  // Fetch an AI-powered command suggestion (fallback when no local match)
  const fetchAISuggestion = useCallback(async (input: string, requestId: number) => {
    if (!aiEnabled || !aiService.isProviderReady()) return;
    try {
      const npmScripts = getNpmScripts();
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: `You are a terminal command autocomplete engine. Complete the given partial shell command.
Return ONLY the completed command, nothing else. No explanation, no $ prefix, no markdown.
${npmScripts.length > 0 ? `Available npm scripts: ${npmScripts.join(', ')}.` : ''}`,
        },
        { role: 'user', content: input },
      ];
      const response = await aiService.chat(messages, { maxTokens: 60 });
      // Discard stale results
      if (requestId !== suggestionRequestId.current) return;
      const suggestion = response.content
        .trim()
        .replace(/^[$>]\s*/, '')
        .split('\n')[0]
        .trim();
      if (suggestion && suggestion.toLowerCase().startsWith(input.toLowerCase()) && suggestion !== input) {
        setCommandSuggestion(suggestion);
      }
    } catch {
      // Suggestions are best-effort — ignore errors silently
    }
  }, [aiEnabled, getNpmScripts]);

  // Handle input change and detect mode
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setInputValue(value);

    // Always detect mode visually, regardless of aiEnabled
    if (value.trim()) {
      const isAI = isAIRequest(value);
      setInputMode(isAI ? "ai" : "terminal");

      // Debug logging to help users understand the classification
      console.log(`Input: "${value}" -> ${isAI ? "AI" : "Terminal"} mode`);

      if (!isAI) {
        // Drop stale suggestion if the user typed past it
        if (commandSuggestion && !commandSuggestion.toLowerCase().startsWith(value.toLowerCase())) {
          setCommandSuggestion('');
        }

        // Try local suggestions first (instant, no API call)
        const npmScripts = getNpmScripts();
        const localSuggestion = getLocalCommandSuggestion(value, npmScripts);
        if (localSuggestion) {
          setCommandSuggestion(localSuggestion);
          if (suggestionTimerRef.current) clearTimeout(suggestionTimerRef.current);
          return;
        }

        // No local match — clear and debounce an AI call
        setCommandSuggestion('');
        if (suggestionTimerRef.current) clearTimeout(suggestionTimerRef.current);
        if (aiEnabled && aiService.isProviderReady() && value.trim().length > 2) {
          const reqId = ++suggestionRequestId.current;
          suggestionTimerRef.current = setTimeout(() => {
            fetchAISuggestion(value.trim(), reqId);
          }, 800);
        }
      } else {
        // AI mode — no command suggestions
        setCommandSuggestion('');
        if (suggestionTimerRef.current) clearTimeout(suggestionTimerRef.current);
      }
    } else {
      setInputMode("terminal");
      setCommandSuggestion('');
      if (suggestionTimerRef.current) clearTimeout(suggestionTimerRef.current);
    }
  };

  // Handle AI request and display response in terminal
  const handleAIInTerminal = useCallback(async (prompt: string) => {
    if (!termRef.current) return;

    const term = termRef.current;

    // Determine what context is available — prefer WorkspaceContext if present
    const hasWorkspaceCtx = wsContext !== null && wsContext.totalLoadedFiles > 0;
    const projectContentKeys = hasWorkspaceCtx
      ? Object.keys(wsContext.loadedFiles)
      : Object.keys(projectFileContents);
    const hasProjectContents = projectContentKeys.length > 0;
    const projectName = projectDir?.split('/').pop() || 'project';
    const fileCount = hasWorkspaceCtx ? wsContext.totalLoadedFiles : projectContentKeys.length;
    const totalFileCount = hasWorkspaceCtx ? wsContext.totalFiles : projectFileList.length;

    // Show user prompt in terminal with context indicator
    const contextLabel = hasProjectContents
      ? ` [📁 ${projectName} · ${fileCount}/${totalFileCount} files]`
      : '';
    term.writeln(`\r\n\x1b[38;5;141m┌─ You${contextLabel} ─────────────────────────────\x1b[0m`);
    term.writeln(`\x1b[38;5;141m│\x1b[0m ${prompt}`);
    if (hasProjectContents) {
      term.writeln(`\x1b[38;5;141m│\x1b[0m \x1b[38;5;245m(AI has full project: ${fileCount} files loaded, ${totalFileCount} total in workspace)\x1b[0m`);
    } else {
      term.writeln(`\x1b[38;5;141m│\x1b[0m \x1b[38;5;245m(No project loaded. Open a project folder first.)\x1b[0m`);
    }
    term.writeln(`\x1b[38;5;141m└───────────────────────────────────────────────────\x1b[0m`);
    term.writeln("");

    // Check if AI is configured
    if (!aiEnabled || !aiService.isProviderReady()) {
      term.writeln(`\x1b[33m[AI not configured. Go to Settings to add your API key. Current provider: ${aiService.getConfig().provider}]\x1b[0m\r\n`);
      return;
    }

    setIsAIProcessing(true);

    // Build system message with full project context
    let systemContent: string;
    let effectiveProjectContents: Record<string, string>;

    if (hasWorkspaceCtx) {
      // Use structured workspace context from WorkspaceService
      const activeRelPath = currentFile
        ? currentFile.path.replace((projectDir || '') + '/', '')
        : undefined;
      const wsContextPrompt = workspaceService.buildContextPrompt(wsContext, activeRelPath);
      effectiveProjectContents = wsContext.loadedFiles;

      console.log('📁 WorkspaceService context:', projectName, `(${wsContext.totalLoadedFiles}/${wsContext.totalFiles} files, ${Math.round(wsContext.totalLoadedSize / 1024)}KB)`);

      systemContent = `You are an AI coding assistant in a terminal/IDE called Velix. You have access to the user's ENTIRE project workspace.

${wsContextPrompt}

${currentFile ? `\n=== CURRENTLY OPEN FILE ===\nPath: ${currentFile.path}\n\`\`\`${currentFile.language}\n${currentFile.content}\n\`\`\`\n` : ''}

IMPORTANT RULES:
- You can see the full project file tree and all loaded source files above.
- When the user says "optimize this code" or "fix this", analyze the entire project holistically.
- When you make changes, output EACH changed file like this:

FILE: relative/path/to/file.ext
\`\`\`language
...full updated file content...
\`\`\`

- You can edit MULTIPLE files in a single response.
- Only output files you actually changed.
- Be specific. Reference actual functions, variables, imports from the code.
- Keep explanations brief. Focus on the code changes.
- When suggesting terminal commands, prefix with $ like: $ npm install lodash`;
    } else if (hasProjectContents) {
      // Fallback: use raw projectFileContents
      let projectSnapshot = '';
      for (const [filePath, content] of Object.entries(projectFileContents)) {
        const ext = filePath.split('.').pop() || 'text';
        projectSnapshot += `\n--- FILE: ${filePath} ---\n\`\`\`${ext}\n${content}\n\`\`\`\n`;
      }
      effectiveProjectContents = projectFileContents;

      console.log('📁 Fallback project context:', projectName, `(${projectContentKeys.length} files, ${Math.round(projectSnapshot.length / 1024)}KB)`);

      systemContent = `You are an AI coding assistant in a terminal/IDE called Velix. You have access to the user's ENTIRE project.

Project: ${projectDir || cwd}

FULL PROJECT SOURCE CODE:
${projectSnapshot}

IMPORTANT RULES:
- When the user says "optimize this code" or "fix this", analyze the entire project.
- When you make changes, output EACH changed file like this:

FILE: path/to/file.ext
\`\`\`language
...full updated file content...
\`\`\`

- Only output files you actually changed.
- Be specific. Reference actual functions, variables, imports from the code.
- Keep explanations brief. Focus on the code changes.
- When suggesting terminal commands, prefix with $ like: $ npm install lodash`;
    } else {
      effectiveProjectContents = {};
      systemContent = `You are an AI coding assistant in a terminal/IDE called Velix.
Current working directory: ${cwd || "unknown"}
No project is loaded. Tell the user to open a project folder so you can see their code.`;
    }

    const systemMessage: ChatMessage = { role: "system", content: systemContent };

    const newUserMessage: ChatMessage = { role: "user", content: prompt };
    const messages: ChatMessage[] = [
      systemMessage,
      ...aiConversation.slice(-10), // Keep last 10 messages for context
      newUserMessage
    ];

    console.log('🤖 Sending to AI:', {
      prompt,
      hasFileContext: !!(currentFile && currentFile.content),
      messageCount: messages.length,
      systemMessageLength: systemMessage.content.length
    });

    try {
      term.writeln(`\x1b[38;5;39m┌─ AI ──────────────────────────────────────────────\x1b[0m`);
      term.write(`\x1b[38;5;39m│\x1b[0m `);

      // Show typing indicator
      const typingInterval = setInterval(() => {
        term.write('.');
      }, 200);

      // Collect streaming response
      let streamedContent = '';
      let isFirstChunk = true;
      let currentLineBuffer = '';

      const response = await aiService.chat(messages, {
        stream: true,
        projectContents: hasProjectContents ? effectiveProjectContents : undefined,
        onStream: (chunk: string) => {
          // Clear typing indicator on first chunk
          if (isFirstChunk) {
            clearInterval(typingInterval);
            // Clear the typing dots
            term.write('\r\x1b[K');
            term.write(`\x1b[38;5;39m│\x1b[0m `);
            isFirstChunk = false;
          }

          // Process chunk character by character
          for (const char of chunk) {
            streamedContent += char;

            if (char === '\n') {
              // Handle newline - write current line and start new one with prefix
              term.write('\r\n');
              term.write(`\x1b[38;5;39m│\x1b[0m `);
              currentLineBuffer = '';
            } else {
              // Write character and add to line buffer
              term.write(char);
              currentLineBuffer += char;
            }
          }
        }
      });

      // Clear typing indicator if still showing
      if (isFirstChunk) {
        clearInterval(typingInterval);
        term.write('\r\x1b[K');
        term.write(`\x1b[38;5;39m│\x1b[0m `);
      }

      const content = streamedContent || response.content;

      // If streaming was used, content is already written, just parse for commands/code blocks
      // Otherwise, parse and display the response
      const lines = content.split('\n');
      let pendingCommands: string[] = [];
      let codeBlocks: Array<{ language: string; content: string }> = [];
      let currentCodeBlock: string[] = [];
      let inCodeBlock = false;
      let codeBlockLanguage = '';

      // If content was not streamed, we need to write it now
      if (!streamedContent) {
        let isFirstLine = true;
        for (const line of lines) {
          // Check if this is a command suggestion
          if (line.trim().startsWith('$ ')) {
            const cmd = line.trim().substring(2);
            pendingCommands.push(cmd);
            if (isFirstLine) {
              term.writeln(`\x1b[38;5;220m${line}\x1b[0m`);
              isFirstLine = false;
            } else {
              term.writeln(`\x1b[38;5;39m│\x1b[0m \x1b[38;5;220m${line}\x1b[0m`);
            }
          } else if (line.startsWith('```')) {
            // Code block marker
            if (!inCodeBlock) {
              // Starting code block
              inCodeBlock = true;
              codeBlockLanguage = line.substring(3).trim();
              currentCodeBlock = [];
            } else {
              // Ending code block
              inCodeBlock = false;
              const fullCodeBlock = currentCodeBlock.join('\n');
              codeBlocks.push({
                language: codeBlockLanguage,
                content: fullCodeBlock
              });
              currentCodeBlock = [];
            }

            if (isFirstLine) {
              term.writeln(`\x1b[38;5;245m${line}\x1b[0m`);
              isFirstLine = false;
            } else {
              term.writeln(`\x1b[38;5;39m│\x1b[0m \x1b[38;5;245m${line}\x1b[0m`);
            }
          } else if (inCodeBlock) {
            // Inside code block
            currentCodeBlock.push(line);
            if (isFirstLine) {
              term.writeln(line);
              isFirstLine = false;
            } else {
              term.writeln(`\x1b[38;5;39m│\x1b[0m ${line}`);
            }
          } else {
            // Regular text
            if (isFirstLine) {
              term.writeln(line);
              isFirstLine = false;
            } else {
              term.writeln(`\x1b[38;5;39m│\x1b[0m ${line}`);
            }
          }
        }
      } else {
        // Content was streamed, just parse for commands and code blocks
        for (const line of lines) {
          if (line.trim().startsWith('$ ')) {
            const cmd = line.trim().substring(2);
            pendingCommands.push(cmd);
          } else if (line.startsWith('```')) {
            if (!inCodeBlock) {
              inCodeBlock = true;
              codeBlockLanguage = line.substring(3).trim();
              currentCodeBlock = [];
            } else {
              inCodeBlock = false;
              const fullCodeBlock = currentCodeBlock.join('\n');
              codeBlocks.push({
                language: codeBlockLanguage,
                content: fullCodeBlock
              });
              currentCodeBlock = [];
            }
          } else if (inCodeBlock) {
            currentCodeBlock.push(line);
          }
        }
      }

      term.writeln(`\x1b[38;5;39m└───────────────────────────────────────────────────\x1b[0m`);

      // If there are pending commands, offer to execute them
      if (pendingCommands.length > 0) {
        term.writeln("");
        term.writeln(`\x1b[38;5;220m> Suggested command${pendingCommands.length > 1 ? 's' : ''}:\x1b[0m`);
        pendingCommands.forEach((cmd, i) => {
          term.writeln(`   \x1b[38;5;39m[${i + 1}]\x1b[0m $ ${cmd}`);
        });
        term.writeln(`\x1b[38;5;245m   Type the number to execute, or press Enter to skip\x1b[0m`);
        (window as unknown as { __velixPendingCommands?: string[] }).__velixPendingCommands = pendingCommands;
      }

      // Auto-apply file changes: parse "FILE: path" + code block patterns
      const fileChangeRegex = /FILE:\s*(.+?)\s*\n```\w*\n([\s\S]*?)```/g;
      let fileMatch;
      const appliedFiles: string[] = [];

      while ((fileMatch = fileChangeRegex.exec(content)) !== null) {
        const filePath = fileMatch[1].trim();
        const fileContent = fileMatch[2];

        // Resolve full path
        const fullPath = filePath.startsWith('/')
          ? filePath
          : `${projectDir || cwd}/${filePath}`;

        try {
          await writeTextFile(fullPath, fileContent);
          appliedFiles.push(filePath);
          term.writeln(`\x1b[38;5;82m  ✓ Updated: ${filePath}\x1b[0m`);
        } catch (err) {
          term.writeln(`\x1b[31m  ✗ Failed to write ${filePath}: ${err}\x1b[0m`);
        }
      }

      if (appliedFiles.length > 0) {
        term.writeln("");
        term.writeln(`\x1b[38;5;82m✓ Applied changes to ${appliedFiles.length} file${appliedFiles.length > 1 ? 's' : ''}\x1b[0m`);
        // Invalidate workspace cache so next AI request sees updated files
        workspaceService.invalidateCache();
      }

      term.writeln("");

      // Update conversation history
      setAiConversation(prev => [
        ...prev.slice(-9),
        newUserMessage,
        { role: "assistant", content }
      ]);

    } catch (error) {
      console.error('AI Request Error:', error);
      console.error('Error details:', {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        aiEnabled,
        providerReady: aiService.isProviderReady(),
        config: aiService.getConfig()
      });
      
      // Always show detailed error info
      const errorMessage = error instanceof Error ? error.message : 'Failed to get AI response';
      const errorDetails = error instanceof Error ? error.stack : JSON.stringify(error);
      
      term.writeln(`\x1b[31mAI Error: ${errorMessage}\x1b[0m`);
      term.writeln(`\x1b[90mDetails: ${errorDetails?.substring(0, 200)}...\x1b[0m`);
      
      // If it's a network/connection error, provide more helpful info
      if (errorMessage.includes('connection failed') || errorMessage.includes('CORS') || errorMessage.includes('Load failed')) {
        term.writeln(`\x1b[33mThis might be a network issue. Check your internet connection and API key validity.\x1b[0m`);
      }
      
      // If it's about provider not being ready
      if (errorMessage.includes('not initialized') || errorMessage.includes('API key')) {
        term.writeln(`\x1b[33mPlease configure your API key in Settings.\x1b[0m`);
      }
      
      // Show current config for debugging
      try {
        const config = aiService.getConfig();
        term.writeln(`\x1b[90mCurrent provider: ${config.provider} | Ready: ${aiService.isProviderReady()}\x1b[0m`);
      } catch (e) {
        term.writeln(`\x1b[90mCould not get AI config\x1b[0m`);
      }
      
      term.writeln(`\x1b[38;5;39m└───────────────────────────────────────────────────\x1b[0m\r\n`);
    } finally {
      setIsAIProcessing(false);
    }
  }, [aiEnabled, cwd, aiConversation, currentFile, onFileUpdate, projectDir, projectFileList, projectFileContents, wsContext]);

  // Handle input submission
  const handleInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCommandSuggestion('');

    if (!inputValue.trim()) return;
    if (isAIProcessing) return; // Don't allow new input while processing

    const trimmedInput = inputValue.trim();

    // Check if user is selecting a pending command
    const pendingCommands = (window as unknown as { __velixPendingCommands?: string[] }).__velixPendingCommands;
    const pendingCodeBlocks = (window as unknown as { __velixPendingCodeBlocks?: Array<{ language: string; content: string }> }).__velixPendingCodeBlocks;
    
    if (pendingCommands && /^[1-9]$/.test(trimmedInput)) {
      const cmdIndex = parseInt(trimmedInput) - 1;
      if (cmdIndex < pendingCommands.length) {
        // Execute the selected command
        writeToPty(pendingCommands[cmdIndex] + "\r");
        delete (window as unknown as { __velixPendingCommands?: string[] }).__velixPendingCommands;
        setInputValue("");
        setInputMode("terminal");
        return;
      }
    }

    // Check if user is selecting a code block to apply
    if (pendingCodeBlocks && /^[1-9]$/.test(trimmedInput) && currentFile && onFileUpdate) {
      const blockIndex = parseInt(trimmedInput) - 1;
      if (blockIndex < pendingCodeBlocks.length) {
        // Apply the selected code block
        const selectedBlock = pendingCodeBlocks[blockIndex];
        onFileUpdate(currentFile.path, selectedBlock.content);
        
        // Show confirmation in terminal
        if (termRef.current) {
          termRef.current.writeln(`\r\n\x1b[38;5;208m✅ Applied changes to ${currentFile.path}\x1b[0m\r\n`);
        }
        
        delete (window as unknown as { __velixPendingCodeBlocks?: Array<{ language: string; content: string }> }).__velixPendingCodeBlocks;
        setInputValue("");
        setInputMode("terminal");
        return;
      }
    }

    // Clear pending items if user types something else
    delete (window as unknown as { __velixPendingCommands?: string[] }).__velixPendingCommands;
    delete (window as unknown as { __velixPendingCodeBlocks?: Array<{ language: string; content: string }> }).__velixPendingCodeBlocks;

    if (inputMode === "ai") {
      handleAIInTerminal(inputValue);
    } else {
      // Send to terminal
      writeToPty(inputValue + "\r");
    }

    setInputValue("");
    setInputMode("terminal");
  };

  // Handle key events in the terminal area
  const handleTerminalClick = () => {
    // Focus the terminal for direct interaction
    if (termRef.current) {
      termRef.current.focus();
    }
  };

  // Handle voice input
  const toggleVoiceInput = () => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      alert('Voice recognition is not supported in your browser. Please use Chrome or Edge.');
      return;
    }

    if (isListening) {
      // Stop listening
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      setIsListening(false);
    } else {
      // Start listening
      const SpeechRecognitionConstructor = window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognition = new SpeechRecognitionConstructor();

      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        const transcript = event.results[0][0].transcript;
        setInputValue(transcript);
        // Auto-detect mode
        if (transcript.trim()) {
          setInputMode(isAIRequest(transcript) ? "ai" : "terminal");
        }
      };

      recognition.onerror = (event: Event) => {
        console.error('Speech recognition error:', event);
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
    }
  };

  // Calculate git stats
  const addedLines = gitChanges.reduce((sum, change) => sum + (change.type === 'A' ? 1 : 0), 0);
  const modifiedFiles = gitChanges.filter(change => change.type === 'M').length;
  const totalAdded = modifiedFiles * 100 + addedLines * 50; // Simulated
  const totalRemoved = modifiedFiles * 50; // Simulated

  return (
    <div className={`terminal-wrapper ${theme}`}>
      {/* Simple header at top */}
      <div className="simple-header">
        <span>~/{cwd?.split('/').pop() || 'Vexilo/Velix'}</span>
      </div>

      {/* Terminal output area */}
      <div
        className="terminal-scroll-area"
        onClick={handleTerminalClick}
      >
        <div
          className="terminal-container"
          ref={containerRef}
        />
      </div>

      {/* Bottom Input Card */}
      {!hideInputCard && (
        <div className={`terminal-input-card ${inputMode === 'ai' ? 'ai-mode' : ''} ${isAIProcessing ? 'ai-processing' : ''}`}>
          {/* Card Header Row 1 - Icon + Badges */}
          <div className="card-header-row">
            {inputMode === 'ai' && !isAIProcessing && (
              <div className="ai-mode-indicator">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 1v4m0 14v4M4.22 4.22l2.83 2.83m9.9 9.9l2.83 2.83M1 12h4m14 0h4M4.22 19.78l2.83-2.83m9.9-9.9l2.83-2.83" />
                </svg>
                <span>AI Mode</span>
              </div>
            )}
            {isAIProcessing && (
              <div className="ai-processing-indicator">
                <span>AI thinking</span>
                <div className="ai-processing-dots">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            )}
            {inputMode !== 'ai' && !isAIProcessing && (
              <>
                <div className="version-badge">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                  </svg>
                  <span>v24.12.0</span>
                </div>
                <div className="path-badge">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  <span>~/{cwd?.split('/').pop() || 'Vexilo/Velix'}</span>
                </div>
              </>
            )}
          </div>

          {/* Card Header Row 2 - Git Stats or AI hints */}
          {inputMode === 'ai' ? (
            <div className="card-git-row" style={{ justifyContent: 'space-between' }}>
              <span style={{ opacity: 0.7, fontSize: '11px' }}>
                {currentFile
                  ? `📄 AI can see ${currentFile.path.split('/').pop()} - try "optimize this code" or "explain this function"`
                  : "Ask questions, get help with code, or say 'run npm install' to execute commands"
                }
              </span>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <span style={{ opacity: 0.5, fontSize: '10px' }}>
                  Ctrl+T: Terminal | Ctrl+A: AI | Tab: Toggle
                </span>
                {aiConversation.length > 0 && (
                  <button
                    type="button"
                    className="icon-btn-tiny"
                    onClick={() => setAiConversation([])}
                    title="Clear AI conversation history"
                    style={{ width: 'auto', padding: '2px 8px', fontSize: '10px' }}
                  >
                    Clear history
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="card-git-row">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
              <span className="branch-name">master</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className="file-count">{gitChanges.length} ·</span>
              <span className="stat-added">+{totalAdded}</span>
              <span className="stat-removed">-{totalRemoved}</span>
            </div>
          )}

          {/* Main Input Field */}
          <input
            type="text"
            className="card-main-input"
            placeholder={
              inputMode === 'ai'
                ? (currentFile
                    ? `Ask about ${currentFile.path.split('/').pop()} or any code question...`
                    : "Ask AI anything... e.g. How do I fix this error?")
                : "Type a command or ask AI anything..."
            }
            ref={inputRef}
            value={inputValue}
            onChange={handleInputChange}
            disabled={isAIProcessing}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleInputSubmit(e);
              } else if (e.key === 'Tab') {
                e.preventDefault();
                if (commandSuggestion && inputMode === 'terminal') {
                  // Accept the suggestion
                  setInputValue(commandSuggestion);
                  setCommandSuggestion('');
                } else {
                  // Toggle AI mode
                  setInputMode(prev => prev === 'ai' ? 'terminal' : 'ai');
                }
              } else if (e.key === 'Escape') {
                // Dismiss suggestion
                setCommandSuggestion('');
              } else if (e.key === 'ArrowRight' && commandSuggestion && inputMode === 'terminal') {
                const atEnd = (inputRef.current?.selectionStart ?? inputValue.length) === inputValue.length;
                if (atEnd) {
                  // Accept suggestion with right arrow at end of input
                  e.preventDefault();
                  setInputValue(commandSuggestion);
                  setCommandSuggestion('');
                } else {
                  e.preventDefault();
                  termRef.current?.focus();
                }
              } else if ((e.ctrlKey || e.metaKey) && e.key === 't') {
                // Ctrl+T to force terminal mode
                e.preventDefault();
                setInputMode('terminal');
                setCommandSuggestion('');
              } else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                // Ctrl+A to force AI mode
                e.preventDefault();
                setInputMode('ai');
                setCommandSuggestion('');
              } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft'].includes(e.key)) {
                // Don't handle arrow keys in input - let terminal handle them
                e.preventDefault();
                termRef.current?.focus();
              }
            }}
            onFocus={() => {
              // When input is focused, make sure we're not blocking terminal input
              if (termRef.current) {
                // Don't steal focus if user is trying to use terminal
              }
            }}
          />

          {/* AI command suggestion row */}
          {commandSuggestion && inputMode === 'terminal' && !isAIProcessing && (
            <div className="command-suggestion-row" onClick={() => {
              setInputValue(commandSuggestion);
              setCommandSuggestion('');
              inputRef.current?.focus();
            }}>
              <span className="suggestion-preview">{commandSuggestion}</span>
              <div className="suggestion-controls">
                <kbd className="suggestion-kbd">Tab</kbd>
                <span className="suggestion-accept-label">to accept</span>
              </div>
            </div>
          )}

          {/* Bottom Icon Bar */}
          <form className="card-bottom-bar" onSubmit={handleInputSubmit}>
            <button
              type="button"
              className={`icon-btn-tiny ${inputMode === 'terminal' ? 'active' : ''}`}
              onClick={() => setInputMode('terminal')}
              title="Force Terminal mode (run commands) - Press Ctrl+T"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            </button>
            <button
              type="button"
              className={`icon-btn-tiny ai-toggle ${inputMode === 'ai' ? 'active' : ''}`}
              onClick={() => setInputMode(inputMode === 'ai' ? 'terminal' : 'ai')}
              title="Force AI mode (ask questions, get help) - Press Ctrl+A or Tab to toggle"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 1v4m0 14v4M4.22 4.22l2.83 2.83m9.9 9.9l2.83 2.83M1 12h4m14 0h4M4.22 19.78l2.83-2.83m9.9-9.9l2.83-2.83" />
              </svg>
            </button>
            <button
              type="button"
              className={`icon-btn-tiny ${isListening ? 'listening' : ''}`}
              onClick={toggleVoiceInput}
              title="Voice"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            </button>

            {/* Model picker */}
            <div className="model-picker-wrap" ref={modelPickerRef}>
              <button
                type="button"
                className={`model-picker-btn ${showModelPicker ? 'open' : ''}`}
                onClick={() => setShowModelPicker(v => !v)}
                title="Change AI model"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 1v4m0 14v4M4.22 4.22l2.83 2.83m9.9 9.9l2.83 2.83M1 12h4m14 0h4M4.22 19.78l2.83-2.83m9.9-9.9l2.83-2.83" />
                </svg>
                <span className="model-picker-label">
                  {currentAIConfig.model || 'No model'}
                </span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`chevron ${showModelPicker ? 'up' : ''}`}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {showModelPicker && (
                <div className="model-picker-dropdown">
                  {PROVIDERS.map(provider => (
                    <div key={provider.id} className="model-picker-group">
                      <div className="model-picker-group-label">{provider.name}</div>
                      {provider.models.map(model => {
                        const isActive = currentAIConfig.provider === provider.id && currentAIConfig.model === model;
                        return (
                          <button
                            key={model}
                            type="button"
                            className={`model-picker-item ${isActive ? 'active' : ''}`}
                            onClick={() => {
                              aiService.setProvider(provider.id, model);
                              setCurrentAIConfig({ provider: provider.id, model });
                              setShowModelPicker(false);
                            }}
                          >
                            <span className="model-picker-item-name">{model}</span>
                            {isActive && (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </form>
        </div>
      )}
    </div>
  );
});
