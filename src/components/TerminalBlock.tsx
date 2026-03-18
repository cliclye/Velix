import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  invoke,
  listen,
  type UnlistenFn,
  writeTextFile,
  readTextFile,
  remove,
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "../platform/native";
import { DiffPanel } from "./DiffPanel";
import type { FileDiff, PendingFileChange } from "./DiffPanel";
import { computeLineDiff } from "../utils/diff";
import "@xterm/xterm/css/xterm.css";
import "./TerminalBlock.css";
import { aiService } from "../services/ai/AIService";
import { ChatMessage, PROVIDERS } from "../services/ai/types";
import { workspaceService, WorkspaceContext } from "../services/workspace";
import { AIChat, AIChatMessage } from "./AIChat";

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
  // Open the git changes panel from terminal controls
  onOpenGitPanel?: () => void;
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

const EDIT_MODE_STORAGE_KEY = "velix-edit-mode";

// Local command suggestion engine — returns full predicted command or empty string
function getLocalCommandSuggestion(input: string, npmScripts: string[]): string {
  const lower = input.toLowerCase();
  if (!input.trim()) return '';

  // npm suggestions driven by package.json scripts
  if (lower === 'npm') {
    const preferred =
      npmScripts.find((s) => s.includes('tauri') || s.includes('electron') || s === 'dev') ||
      npmScripts[0];
    return preferred ? `npm run ${preferred}` : 'npm run dev';
  }
  if (lower.startsWith('npm run ')) {
    const partial = lower.slice('npm run '.length);
    const match = npmScripts.find(s => s.toLowerCase().startsWith(partial) && s.toLowerCase() !== partial);
    if (match) return `npm run ${match}`;
    const common = [
      'dev',
      'build',
      'start',
      'test',
      'tauri',
      'tauri dev',
      'electron',
      'dev:electron',
      'lint',
      'preview',
    ];
    const cm = common.find(s => s.startsWith(partial) && s !== partial);
    if (cm) return `npm run ${cm}`;
  }
  if (lower.startsWith('npm r') && !lower.startsWith('npm run')) {
    const partial = lower.slice('npm '.length);
    if ('run'.startsWith(partial)) {
      const preferred =
        npmScripts.find((s) => s.includes('tauri') || s.includes('electron') || s === 'dev') ||
        npmScripts[0];
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
    // AI CLI tools
    'claude', 'gemini', 'aider', 'codex',
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

function isLikelyEditRequest(input: string): boolean {
  const text = input.trim().toLowerCase();
  if (!text) return false;

  // Explicitly read-only requests should not be blocked.
  if (/\b(explain|analyze|review|summarize|describe|what is|show|read|list)\b/.test(text) &&
    !/\b(edit|modify|change|write|create|delete|rename|refactor|fix|implement|add)\b/.test(text)) {
    return false;
  }

  return (
    /\b(edit|modify|change|rewrite|refactor|fix|implement|create|add|remove|delete|rename|update|generate)\b/.test(text) ||
    /\b(write to|apply patch|change code|update file|new file|save file)\b/.test(text) ||
    /\b(npm install|pnpm add|yarn add|cargo add|pip install|go get|bundle add)\b/.test(text)
  );
}

function formatElapsed(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const READ_ONLY_TOOLS_WHEN_EDIT_OFF: Record<string, boolean> = {
  '*': false,
  invalid: true,
  question: true,
  read: true,
  glob: true,
  grep: true,
  webfetch: true,
  websearch: true,
  codesearch: true,
  skill: true,
  todoread: true,
};

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
  onOpenGitPanel,
}, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string>("");
  const unlistenOutputRef = useRef<UnlistenFn | null>(null);
  const unlistenExitRef = useRef<UnlistenFn | null>(null);
  const promptKickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isClaudeCodeRunningRef = useRef<boolean>(false);

  const [inputValue, setInputValue] = useState("");
  const [inputMode, setInputMode] = useState<"terminal" | "ai">("terminal");
  const [isListening, setIsListening] = useState(false);
  const [hideInputCard, setHideInputCard] = useState(false);
  const [isAIProcessing, setIsAIProcessing] = useState(false);
  const [aiStartedAt, setAiStartedAt] = useState<number | null>(null);
  const [aiElapsedSec, setAiElapsedSec] = useState(0);
  const [isAIStopping, setIsAIStopping] = useState(false);
  const [aiConversation, setAiConversation] = useState<ChatMessage[]>([]);
  const [aiChatMessages, setAiChatMessages] = useState<AIChatMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState<string>("");
  const [commandSuggestion, setCommandSuggestion] = useState<string>("");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [currentAIConfig, setCurrentAIConfig] = useState(() => aiService.getConfig());
  const [reviewFileChanges, setReviewFileChanges] = useState<FileDiff[]>([]);
  const [showReviewPanel, setShowReviewPanel] = useState(false);
  const [editModeEnabled, setEditModeEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(EDIT_MODE_STORAGE_KEY) === "on";
  });
  const [pendingEditApproval, setPendingEditApproval] = useState<FileDiff[] | null>(null);
  const [blockedEditPrompt, setBlockedEditPrompt] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const suggestionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestionRequestId = useRef<number>(0);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const aiAbortControllerRef = useRef<AbortController | null>(null);
  const aiStopRequestedRef = useRef(false);

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

  useEffect(() => {
    if (!isAIProcessing || aiStartedAt === null) return;
    setAiElapsedSec(Math.max(0, Math.floor((Date.now() - aiStartedAt) / 1000)));
    const timer = setInterval(() => {
      setAiElapsedSec(Math.max(0, Math.floor((Date.now() - aiStartedAt) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [isAIProcessing, aiStartedAt]);

  // Generate a unique session ID
  const generateSessionId = () => {
    return `pty-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  };

  // Create PTY session
  const createPtySession = useCallback(async (rows: number, cols: number) => {
    const sessionId = generateSessionId();
    sessionIdRef.current = sessionId;

    if (promptKickTimerRef.current) {
      clearTimeout(promptKickTimerRef.current);
      promptKickTimerRef.current = null;
    }

    try {
      await invoke("pty_create", {
        sessionId,
        rows,
        cols,
        cwd: cwd || undefined,
      });

      // Normalize the startup screen to one clean prompt line after shell boot.
      promptKickTimerRef.current = setTimeout(() => {
        if (sessionIdRef.current !== sessionId) return;
        void invoke("pty_write", {
          sessionId,
          data: "clear\r",
        }).catch(() => {});
      }, 380);
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

    // Theme configuration — neutral grayscale palette aligned to the app shell
    const darkTheme = {
      background: "#0f1012",
      foreground: "#f3f4f6",
      cursor: "#f2f2f3",
      cursorAccent: "#0f1012",
      selectionBackground: "rgba(255, 255, 255, 0.14)",
      selectionForeground: "#ffffff",
      black: "#17181b",
      red: "#8e919a",
      green: "#cfd1d7",
      yellow: "#b8bac1",
      blue: "#f2f2f3",
      magenta: "#d6d7dc",
      cyan: "#b8bac1",
      white: "#cfd1d7",
      brightBlack: "#676a73",
      brightRed: "#d6d7dc",
      brightGreen: "#ffffff",
      brightYellow: "#e5e7eb",
      brightBlue: "#ffffff",
      brightMagenta: "#e5e7eb",
      brightCyan: "#d6d7dc",
      brightWhite: "#ffffff",
    };

    const lightTheme = {
      background: "#f5f5f7",
      foreground: "#101114",
      cursor: "#111111",
      cursorAccent: "#f5f5f7",
      selectionBackground: "rgba(17, 17, 17, 0.14)",
      selectionForeground: "#050506",
      black: "#101114",
      red: "#3a3c42",
      green: "#2d2e34",
      yellow: "#4d4f58",
      blue: "#111111",
      magenta: "#696b74",
      cyan: "#545660",
      white: "#6c6f78",
      brightBlack: "#91939c",
      brightRed: "#545660",
      brightGreen: "#111111",
      brightYellow: "#2d2e34",
      brightBlue: "#050506",
      brightMagenta: "#3a3c42",
      brightCyan: "#2d2e34",
      brightWhite: "#050506",
    };

    // Create terminal instance
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', 'Monaco', monospace",
      letterSpacing: 0,
      lineHeight: 1.6,
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
              isClaudeCodeRunningRef.current = true;
              setHideInputCard(true);
              // Auto-focus the xterm terminal so the user can type directly
              // (e.g. answer yes/no prompts in Claude Code)
              setTimeout(() => term.focus(), 50);
            }
          }

          // Show input card again when Claude Code explicitly says goodbye (/exit command)
          if (isClaudeCodeRunningRef.current && /goodbye|Goodbye/i.test(data)) {
            isClaudeCodeRunningRef.current = false;
            setTimeout(() => setHideInputCard(false), 300);
          }
        }
      });

      // Listen for PTY exit
      unlistenExitRef.current = await listen<PtyExit>("pty-exit", (event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          if (promptKickTimerRef.current) {
            clearTimeout(promptKickTimerRef.current);
            promptKickTimerRef.current = null;
          }
          term.writeln("\r\n\x1b[90m[Process exited]\x1b[0m");
          // Reset Claude Code state so input card is always visible after session restart
          isClaudeCodeRunningRef.current = false;
          setHideInputCard(false);
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

    // Debounced fit helper — avoids calling fit() on every resize frame
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedFit = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (fitAddonRef.current) fitAddonRef.current.fit();
        resizeTimer = null;
      }, 60);
    };

    // Handle window resize
    const handleWindowResize = () => debouncedFit();
    window.addEventListener("resize", handleWindowResize);

    // Observe container size changes
    const resizeObserver = new ResizeObserver(() => debouncedFit());
    resizeObserver.observe(containerRef.current);

    // Cleanup
    return () => {
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      window.removeEventListener("resize", handleWindowResize);
      resizeObserver.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);

      if (unlistenOutputRef.current) {
        unlistenOutputRef.current();
      }
      if (unlistenExitRef.current) {
        unlistenExitRef.current();
      }

      if (promptKickTimerRef.current) {
        clearTimeout(promptKickTimerRef.current);
        promptKickTimerRef.current = null;
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

  const applyFileDiffs = useCallback(async (fileDiffs: FileDiff[]) => {
    if (fileDiffs.length === 0) return [] as FileDiff[];

    const term = termRef.current;
    let successCount = 0;
    const appliedDiffs: FileDiff[] = [];
    for (const fileDiff of fileDiffs) {
      try {
        await writeTextFile(fileDiff.change.filePath, fileDiff.change.newContent);
        onFileUpdate?.(fileDiff.change.filePath, fileDiff.change.newContent);
        successCount++;
        appliedDiffs.push(fileDiff);
      } catch (err) {
        term?.writeln(`\x1b[31m  ✗ Failed: ${fileDiff.change.displayPath}: ${err}\x1b[0m`);
      }
    }

    if (successCount > 0) {
      workspaceService.invalidateCache();
      term?.writeln('');
      term?.writeln(
        `\x1b[38;5;82m✓ Auto-applied ${successCount} file change${successCount !== 1 ? 's' : ''}.\x1b[0m`,
      );
      term?.writeln('\x1b[38;5;245mUse "Review files" to inspect and revert.\x1b[0m');
    }
    return appliedDiffs;
  }, [onFileUpdate]);

  const revertFileDiff = useCallback(async (fileDiff: FileDiff) => {
    if (fileDiff.change.originalContent === null) {
      await remove(fileDiff.change.filePath);
      return;
    }
    await writeTextFile(fileDiff.change.filePath, fileDiff.change.originalContent);
    onFileUpdate?.(fileDiff.change.filePath, fileDiff.change.originalContent);
  }, [onFileUpdate]);

  const handleStopAIResponse = useCallback(async () => {
    if (!isAIProcessing || isAIStopping) return;
    aiStopRequestedRef.current = true;
    setIsAIStopping(true);
    aiAbortControllerRef.current?.abort();
    try {
      await aiService.abortCurrentResponse();
    } catch {
      // Best effort stop signal; local abort already stopped streaming.
    } finally {
      setIsAIStopping(false);
    }
  }, [isAIProcessing, isAIStopping]);

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

    // Add user message to chat panel
    setAiChatMessages(prev => [
      ...prev,
      { id: `user-${Date.now()}`, role: 'user', content: prompt },
    ]);

    if (!editModeEnabled && isLikelyEditRequest(prompt)) {
      setBlockedEditPrompt(prompt);
      setAiChatMessages(prev => [
        ...prev,
        {
          id: `edit-blocked-${Date.now()}`,
          role: 'assistant',
          content: `Edit Mode is **OFF**, so I paused this request before making code changes.\n\nEnable Edit Mode to continue this request.`,
        },
      ]);
      term.writeln('');
      term.writeln('\x1b[38;5;220m⚠ Edit Mode is OFF. This request likely requires file changes.\x1b[0m');
      term.writeln('\x1b[38;5;245mEnable Edit Mode to continue.\x1b[0m');

      // Best-effort native notification
      (async () => {
        try {
          let granted = await isPermissionGranted();
          if (!granted) granted = (await requestPermission()) === 'granted';
          if (granted) {
            await sendNotification({
              title: 'Edit Mode Required',
              body: 'Turn on Edit Mode to let AI make file changes.',
            });
          }
        } catch {
          // Optional notification only.
        }
      })();
      return;
    }

    // Check if AI is configured
    if (!aiEnabled) {
      setAiChatMessages(prev => [
        ...prev,
        { id: `error-${Date.now()}`, role: 'assistant', content: '**No API key configured.** Open Settings and add a Claude / OpenAI / etc. key to enable AI.' },
      ]);
      return;
    }

    setIsAIProcessing(true);
    setIsAIStopping(false);
    setAiStartedAt(Date.now());
    setAiElapsedSec(0);
    aiStopRequestedRef.current = false;
    const requestAbortController = new AbortController();
    aiAbortControllerRef.current = requestAbortController;

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

    let assistantMsgId = '';
    let accumulated = '';
    let isFirstChunk = true;
    let typingInterval: ReturnType<typeof setInterval> | null = null;
    let streamRafId: number | null = null;

    try {
      // ── Create a streaming placeholder for the assistant ──────────────────
      assistantMsgId = `assistant-${Date.now()}`;
      setAiChatMessages(prev => [
        ...prev,
        { id: assistantMsgId, role: 'assistant', content: '', streaming: true },
      ]);
      setStreamingContent('');

      // ── Animated status indicator in xterm (subtle, only during loading) ──
      const statusPhases: string[] = [];
      if (hasWorkspaceCtx && wsContext) {
        statusPhases.push(`📁 Reading ${wsContext.totalLoadedFiles} files...`);
        statusPhases.push(`🔍 Analyzing ${projectName}...`);
        if (currentFile) {
          const fname = currentFile.path.split('/').pop() || currentFile.path;
          statusPhases.push(`📄 Looking at ${fname}...`);
        }
      } else if (hasProjectContents) {
        statusPhases.push(`📁 Reading project files...`);
        statusPhases.push(`🔍 Analyzing codebase...`);
      }
      statusPhases.push('💭 Thinking...', '✍️  Generating...', '🧠 Reasoning...');

      let phaseIdx = 0;
      let dotCount = 0;
      const spinners = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let spinnerIdx = 0;
      const dim = '\x1b[38;5;245m', reset = '\x1b[0m';
      term.write(`${dim}${spinners[0]} ${statusPhases[0]}${reset}`);
      typingInterval = setInterval(() => {
        spinnerIdx = (spinnerIdx + 1) % spinners.length;
        dotCount++;
        if (dotCount % 16 === 0) phaseIdx = (phaseIdx + 1) % statusPhases.length;
        term.write(`\r${dim}${spinners[spinnerIdx]} ${statusPhases[phaseIdx]}${reset}\x1b[K`);
      }, 120);

      // ── Stream AI response into chat state ───────────────────────────────
      const toolPermissions = editModeEnabled
        ? undefined
        : READ_ONLY_TOOLS_WHEN_EDIT_OFF;

      const response = await aiService.chat(messages, {
        stream: true,
        projectContents: hasProjectContents ? effectiveProjectContents : undefined,
        tools: toolPermissions,
        signal: requestAbortController.signal,
        onStream: (chunk: string) => {
          if (isFirstChunk) {
            if (typingInterval) clearInterval(typingInterval);
            term.write(`\r\x1b[K`); // wipe the spinner line
            isFirstChunk = false;
          }
          accumulated += chunk;
          // Batch state updates via rAF to avoid a re-render per chunk
          if (streamRafId !== null) cancelAnimationFrame(streamRafId);
          streamRafId = requestAnimationFrame(() => {
            setStreamingContent(accumulated);
            streamRafId = null;
          });
        }
      });

      // Clear spinner if no streaming happened
      if (isFirstChunk) {
        if (typingInterval) clearInterval(typingInterval);
        term.write(`\r\x1b[K`);
      }
      // Flush any pending batched streaming update
      if (streamRafId !== null) {
        cancelAnimationFrame(streamRafId);
        streamRafId = null;
        setStreamingContent(accumulated);
      }

      const content = accumulated || response.content;

      // ── Finalise the assistant chat bubble ───────────────────────────────
      setAiChatMessages(prev =>
        prev.map(m => m.id === assistantMsgId
          ? { ...m, content, streaming: false }
          : m
        )
      );
      setStreamingContent('');

      // ── Parse file changes (FILE: … ``` blocks) for the diff panel ───────
      const fileChangeRegex = /FILE:\s*(.+?)\s*\n```\w*\n([\s\S]*?)```/g;
      let fileMatch;
      const pendingChanges: PendingFileChange[] = [];
      while ((fileMatch = fileChangeRegex.exec(content)) !== null) {
        const displayPath = fileMatch[1].trim();
        const newContent = fileMatch[2];
        const fullPath = displayPath.startsWith('/')
          ? displayPath
          : `${projectDir || cwd}/${displayPath}`;
        let originalContent: string | null = null;
        try { originalContent = await readTextFile(fullPath); } catch { /* new file */ }
        pendingChanges.push({ filePath: fullPath, displayPath, originalContent, newContent });
      }
      if (pendingChanges.length > 0) {
        const fileDiffs: FileDiff[] = pendingChanges.map(change => {
          const { hunks, addedCount, removedCount } = computeLineDiff(
            change.originalContent ?? '', change.newContent,
          );
          return { change, hunks, addedCount, removedCount, isNewFile: change.originalContent === null };
        });
        if (editModeEnabled) {
          const appliedDiffs = await applyFileDiffs(fileDiffs);
          setReviewFileChanges(appliedDiffs);
          setShowReviewPanel(false);
        } else {
          setPendingEditApproval(fileDiffs);
          term.writeln('');
          term.writeln(
            `\x1b[38;5;220m⚠ Edit permission required: AI wants to change ${fileDiffs.length} file${fileDiffs.length !== 1 ? 's' : ''}.\x1b[0m`,
          );
          term.writeln(
            '\x1b[38;5;245mUse "Allow Once", "Enable Edit Mode + Allow", or "Deny" in the approval card.\x1b[0m',
          );
        }
      }

      // ── Parse suggested commands from content ($ cmd) ────────────────────
      const pendingCommands: string[] = [];
      for (const line of content.split('\n')) {
        if (line.trim().startsWith('$ ')) pendingCommands.push(line.trim().substring(2));
      }
      if (pendingCommands.length > 0) {
        (window as unknown as { __velixPendingCommands?: string[] }).__velixPendingCommands = pendingCommands;
      }

      // ── Update conversation history for multi-turn context ────────────────
      setAiConversation(prev => [
        ...prev.slice(-9),
        newUserMessage,
        { role: 'assistant', content }
      ]);

    } catch (error) {
      console.error('AI Request Error:', error);
      // Electron IPC serializes errors across context boundaries, which can break instanceof.
      // Extract the message from whatever shape the error arrives in.
      const errorMessage = (() => {
        if (error instanceof Error) return error.message;
        if (error && typeof error === 'object') {
          const msg = (error as Record<string, unknown>).message;
          if (typeof msg === 'string' && msg) return msg;
        }
        if (typeof error === 'string' && error) return error;
        return 'Failed to get AI response';
      })();
      if (typingInterval) {
        clearInterval(typingInterval);
        term.write(`\r\x1b[K`);
      }

      const isAbortError =
        aiStopRequestedRef.current ||
        (error instanceof DOMException && error.name === 'AbortError') ||
        /aborted|aborterror|request was aborted|signal is aborted/i.test(errorMessage);

      if (isAbortError) {
        const stoppedContent = accumulated
          ? `${accumulated}\n\n_Stopped by user._`
          : '_Stopped by user._';
        setAiChatMessages(prev => prev.map(m =>
          m.id === assistantMsgId
            ? { ...m, content: stoppedContent, streaming: false }
            : m
        ));
        setStreamingContent('');
        term.writeln('');
        term.writeln('\x1b[38;5;245m⏹ AI response stopped.\x1b[0m');
        return;
      }

      const isPermissionBlocked =
        !editModeEnabled &&
        /(specific tool call|rejected permission|rule which prevents|prevents you from using)/i.test(errorMessage);

      if (isPermissionBlocked) {
        setBlockedEditPrompt(prompt);
        setAiChatMessages(prev => [
          ...prev.filter(m => !m.streaming),
          {
            id: `edit-blocked-permission-${Date.now()}`,
            role: 'assistant',
            content: `I hit an edit permission block because Edit Mode is **OFF**.\n\nEnable Edit Mode and retry to continue this coding request.`,
            streaming: false,
          }
        ]);
        setStreamingContent('');
        return;
      }

      // Show error as an assistant message in the chat panel
      setAiChatMessages(prev => [
        ...prev.filter(m => !m.streaming), // remove defunct streaming bubble
        {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: `**Error:** ${errorMessage}\n\nThis might be a network issue. Check your internet connection and API key in Settings.`,
          streaming: false,
        }
      ]);
      setStreamingContent('');
    } finally {
      setIsAIProcessing(false);
      setIsAIStopping(false);
      setAiStartedAt(null);
      setAiElapsedSec(0);
      aiAbortControllerRef.current = null;
      aiStopRequestedRef.current = false;
    }
  }, [aiEnabled, cwd, aiConversation, currentFile, projectDir, projectFileList, projectFileContents, wsContext, editModeEnabled, applyFileDiffs]);

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

  // ── Diff review handlers ──────────────────────────────────────────────────

  const handleOpenReviewPanel = useCallback(() => {
    if (reviewFileChanges.length === 0) return;
    setShowReviewPanel(true);
  }, [reviewFileChanges.length]);

  const handleCloseReviewPanel = useCallback(() => {
    setShowReviewPanel(false);
  }, []);

  const handleKeepAllChanges = useCallback(() => {
    setReviewFileChanges([]);
    setShowReviewPanel(false);
  }, []);

  const handleRevertAllChanges = useCallback(async () => {
    const term = termRef.current;
    let revertedCount = 0;
    for (const fileDiff of reviewFileChanges) {
      try {
        await revertFileDiff(fileDiff);
        revertedCount++;
      } catch (err) {
        term?.writeln(`\x1b[31m  ✗ Failed to revert: ${fileDiff.change.displayPath}: ${err}\x1b[0m`);
      }
    }
    if (revertedCount > 0) {
      workspaceService.invalidateCache();
      term?.writeln('');
      term?.writeln(
        `\x1b[38;5;220m↺ Reverted ${revertedCount} file change${revertedCount !== 1 ? 's' : ''}.\x1b[0m`,
      );
    }
    setReviewFileChanges([]);
    setShowReviewPanel(false);
  }, [reviewFileChanges, revertFileDiff]);

  const handleRevertFile = useCallback(async (filePath: string) => {
    const fileDiff = reviewFileChanges.find(d => d.change.filePath === filePath);
    if (!fileDiff) return;
    const term = termRef.current;
    try {
      await revertFileDiff(fileDiff);
      term?.writeln(`\x1b[38;5;220m  ↺ Reverted: ${fileDiff.change.displayPath}\x1b[0m`);
      const remaining = reviewFileChanges.filter(d => d.change.filePath !== filePath);
      if (remaining.length === 0) {
        workspaceService.invalidateCache();
        setShowReviewPanel(false);
      }
      setReviewFileChanges(remaining);
    } catch (err) {
      term?.writeln(`\x1b[31m  ✗ Failed to revert: ${fileDiff.change.displayPath}: ${err}\x1b[0m`);
    }
  }, [reviewFileChanges, revertFileDiff]);

  const setEditMode = useCallback((enabled: boolean) => {
    setEditModeEnabled(enabled);
    if (typeof window !== "undefined") {
      localStorage.setItem(EDIT_MODE_STORAGE_KEY, enabled ? "on" : "off");
    }
    if (enabled) {
      setBlockedEditPrompt(null);
    }
    // Reset opencode session so permission rules from previous mode don't linger.
    aiService.setProvider(currentAIConfig.provider, currentAIConfig.model);
    termRef.current?.writeln(
      enabled
        ? '\x1b[38;5;82m[Edit Mode ON] AI can propose edits without pre-approval.\x1b[0m'
        : '\x1b[38;5;245m[Edit Mode OFF] AI must ask before proposing edits.\x1b[0m',
    );
  }, [currentAIConfig.model, currentAIConfig.provider]);

  const toggleEditMode = useCallback(() => {
    setEditMode(!editModeEnabled);
  }, [editModeEnabled, setEditMode]);

  const handleApproveEditsOnce = useCallback(async () => {
    if (!pendingEditApproval || pendingEditApproval.length === 0) return;
    const appliedDiffs = await applyFileDiffs(pendingEditApproval);
    setReviewFileChanges(appliedDiffs);
    setShowReviewPanel(false);
    setPendingEditApproval(null);
    termRef.current?.writeln(
      `\x1b[38;5;82m✓ Edit approved and auto-applied (${pendingEditApproval.length} file${pendingEditApproval.length !== 1 ? 's' : ''}).\x1b[0m`,
    );
  }, [pendingEditApproval, applyFileDiffs]);

  const handleApproveAndEnableEditMode = useCallback(async () => {
    if (!pendingEditApproval || pendingEditApproval.length === 0) return;
    setEditMode(true);
    const appliedDiffs = await applyFileDiffs(pendingEditApproval);
    setReviewFileChanges(appliedDiffs);
    setShowReviewPanel(false);
    setPendingEditApproval(null);
    termRef.current?.writeln(
      `\x1b[38;5;82m✓ Edit approved and auto-applied (${pendingEditApproval.length} file${pendingEditApproval.length !== 1 ? 's' : ''}).\x1b[0m`,
    );
  }, [pendingEditApproval, setEditMode, applyFileDiffs]);

  const handleDenyEditProposal = useCallback(() => {
    if (!pendingEditApproval || pendingEditApproval.length === 0) return;
    termRef.current?.writeln(
      `\x1b[38;5;245m✗ Edit request denied (${pendingEditApproval.length} file${pendingEditApproval.length !== 1 ? 's' : ''}).\x1b[0m`,
    );
    setPendingEditApproval(null);
  }, [pendingEditApproval]);

  const handleEnableEditAndContinue = useCallback(() => {
    if (!blockedEditPrompt || isAIProcessing) return;
    const promptToRetry = blockedEditPrompt;
    setBlockedEditPrompt(null);
    setEditMode(true);
    setTimeout(() => {
      handleAIInTerminal(promptToRetry);
    }, 0);
  }, [blockedEditPrompt, isAIProcessing, setEditMode, handleAIInTerminal]);

  // Terminal / git summary chips
  const modifiedCount = gitChanges.filter(change => change.type === 'M').length;
  const addedCount = gitChanges.filter(change => change.type === 'A').length;
  const deletedCount = gitChanges.filter(change => change.type === 'D').length;
  const untrackedCount = gitChanges.filter(change => change.type === '?').length;
  const totalChanges = gitChanges.length;
  const gitDetailParts = [
    modifiedCount > 0 ? `${modifiedCount} modified` : '',
    addedCount > 0 ? `${addedCount} added` : '',
    deletedCount > 0 ? `${deletedCount} deleted` : '',
    untrackedCount > 0 ? `${untrackedCount} untracked` : '',
  ].filter(Boolean);
  const approvalAdded = (pendingEditApproval ?? []).reduce((sum, diff) => sum + diff.addedCount, 0);
  const approvalRemoved = (pendingEditApproval ?? []).reduce((sum, diff) => sum + diff.removedCount, 0);
  const terminalSummary = totalChanges > 0
    ? gitDetailParts.join(' · ') || `${totalChanges} pending changes`
    : 'Working tree clean';
  const aiSummary = editModeEnabled ? 'Edit mode on' : 'Edit mode off · approval required';
  const inputPlaceholder = isAIProcessing
    ? 'Waiting for AI response...'
    : inputMode === 'ai'
      ? currentFile
        ? `Ask about ${currentFile.path.split('/').pop()} or the wider codebase...`
        : 'Ask AI about the project, architecture, bugs, or commands...'
      : 'Run a shell command...';
  const submitLabel = isAIProcessing
    ? (isAIStopping ? 'Stopping…' : 'Stop')
    : inputMode === 'ai'
      ? 'Ask'
      : 'Run';

  return (
    <div className={`terminal-wrapper ${theme}`}>
      {/* AI Diff Review Panel — opened on demand to inspect/revert auto-applied changes */}
      {showReviewPanel && reviewFileChanges.length > 0 && (
        <DiffPanel
          fileDiffs={reviewFileChanges}
          onRevertAll={handleRevertAllChanges}
          onRevertFile={handleRevertFile}
          onKeepAll={handleKeepAllChanges}
          onClose={handleCloseReviewPanel}
          theme={theme}
        />
      )}

      {/* Edit permission gate (Claude-style) when Edit Mode is OFF */}
      {pendingEditApproval && pendingEditApproval.length > 0 && (
        <div className={`edit-approval-overlay ${theme}`}>
          <div className={`edit-approval-card ${theme}`}>
            <div className="edit-approval-header">
              <span className="edit-approval-title">AI wants to edit files</span>
              <span className="edit-approval-count">
                {pendingEditApproval.length} file{pendingEditApproval.length !== 1 ? 's' : ''}
              </span>
            </div>
            <p className="edit-approval-text">
              Edit Mode is currently off. Approve this edit proposal before changes can be reviewed/applied.
            </p>
            <div className="edit-approval-stats">
              {approvalAdded > 0 && <span className="edit-approval-added">+{approvalAdded}</span>}
              {approvalRemoved > 0 && <span className="edit-approval-removed">−{approvalRemoved}</span>}
            </div>
            <div className="edit-approval-files">
              {pendingEditApproval.map((fd) => (
                <div key={fd.change.filePath} className="edit-approval-file-row">
                  <span className="edit-approval-file-path">{fd.change.displayPath}</span>
                  <span className="edit-approval-file-meta">
                    {fd.isNewFile ? 'NEW' : ''}
                    {fd.addedCount > 0 ? ` +${fd.addedCount}` : ''}
                    {fd.removedCount > 0 ? ` −${fd.removedCount}` : ''}
                  </span>
                </div>
              ))}
            </div>
            <div className="edit-approval-actions">
              <button className="edit-approval-btn allow-once" onClick={handleApproveEditsOnce}>
                Allow Once
              </button>
              <button className="edit-approval-btn enable-mode" onClick={handleApproveAndEnableEditMode}>
                Enable Edit Mode + Allow
              </button>
              <button className="edit-approval-btn deny" onClick={handleDenyEditProposal}>
                Deny
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Simple header at top */}
      <div className="simple-header">
        <span className="simple-header-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </span>
        <div className="simple-header-path">
          <span className="simple-header-path-segment">~</span>
          <span className="simple-header-sep">/</span>
          <span className="simple-header-path-segment active">
            {cwd?.split('/').pop() || 'terminal'}
          </span>
        </div>
        <span className="simple-header-badge">sh</span>
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

      {/* AI Chat Panel — shown when there are AI messages */}
      {aiChatMessages.length > 0 && (
        <AIChat
          messages={aiChatMessages}
          streamingContent={streamingContent}
          theme={theme}
        />
      )}

      {blockedEditPrompt && !editModeEnabled && !isAIProcessing && (
        <div className={`edit-mode-notice ${theme}`}>
          <span className="edit-mode-notice-text">
            This request needs file edits. Turn on Edit Mode to continue.
          </span>
          <div className="edit-mode-notice-actions">
            <button className="edit-mode-notice-btn enable" onClick={handleEnableEditAndContinue}>
              Enable Edit Mode + Continue
            </button>
            <button className="edit-mode-notice-btn dismiss" onClick={() => setBlockedEditPrompt(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {!hideInputCard && (
        <div className={`terminal-input-card compact ${inputMode === 'ai' ? 'ai-mode' : ''} ${isAIProcessing ? 'ai-processing' : ''}`}>
          {isAIProcessing && (
            <div className="ai-loading-bar">
              <div className="ai-loading-bar-fill" />
            </div>
          )}

          <form className="terminal-input-form" onSubmit={handleInputSubmit}>
            <button
              type="button"
              className={`terminal-mode-pill ${inputMode === 'ai' ? 'ai' : 'terminal'}`}
              onClick={() => setInputMode((prev) => prev === 'ai' ? 'terminal' : 'ai')}
              title="Toggle between terminal and AI mode"
            >
              {isAIProcessing ? `AI ${formatElapsed(aiElapsedSec)}` : inputMode === 'ai' ? 'AI' : 'SH'}
            </button>

            <div className="terminal-input-main">
              <input
                type="text"
                className="card-main-input compact"
                placeholder={inputPlaceholder}
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
                      setInputValue(commandSuggestion);
                      setCommandSuggestion('');
                    } else {
                      setInputMode((prev) => prev === 'ai' ? 'terminal' : 'ai');
                    }
                  } else if (e.key === 'Escape') {
                    setCommandSuggestion('');
                  } else if (e.key === 'ArrowRight' && commandSuggestion && inputMode === 'terminal') {
                    const atEnd = (inputRef.current?.selectionStart ?? inputValue.length) === inputValue.length;
                    if (atEnd) {
                      e.preventDefault();
                      setInputValue(commandSuggestion);
                      setCommandSuggestion('');
                    } else {
                      e.preventDefault();
                      termRef.current?.focus();
                    }
                  } else if ((e.ctrlKey || e.metaKey) && e.key === 't') {
                    e.preventDefault();
                    setInputMode('terminal');
                    setCommandSuggestion('');
                  } else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                    e.preventDefault();
                    setInputMode('ai');
                    setCommandSuggestion('');
                  } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft'].includes(e.key)) {
                    e.preventDefault();
                    termRef.current?.focus();
                  }
                }}
              />
            </div>

            {inputMode === 'terminal' && (
              <button
                type="button"
                className={`terminal-mini-chip terminal-git-chip git ${totalChanges > 0 ? 'dirty' : 'clean'}`}
                onClick={() => onOpenGitPanel?.()}
                title="Open Git changes"
              >
                {totalChanges > 0 ? `${totalChanges} changes` : 'Clean'}
              </button>
            )}

            <button
              type="button"
              className={`icon-btn-tiny ${isListening ? 'listening' : ''}`}
              onClick={toggleVoiceInput}
              title="Voice input"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            </button>

            <button
              type="button"
              className={`edit-mode-btn compact ${editModeEnabled ? 'on' : 'off'}`}
              onClick={toggleEditMode}
              title={editModeEnabled ? 'Edit Mode ON' : 'Edit Mode OFF'}
            >
              <span>{editModeEnabled ? 'Edit ON' : 'Edit OFF'}</span>
            </button>

            {reviewFileChanges.length > 0 && (
              <button
                type="button"
                className="review-files-btn compact"
                onClick={handleOpenReviewPanel}
                title="Review AI-applied file changes"
              >
                <span>Review {reviewFileChanges.length}</span>
              </button>
            )}

            <div className="model-picker-wrap" ref={modelPickerRef}>
              <button
                type="button"
                className={`model-picker-btn compact ${showModelPicker ? 'open' : ''}`}
                onClick={() => setShowModelPicker((visible) => !visible)}
                title="Change AI model"
              >
                <span className="model-picker-label">
                  {currentAIConfig.model || 'No model'}
                </span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`chevron ${showModelPicker ? 'up' : ''}`}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {showModelPicker && (
                <div className="model-picker-dropdown">
                  {PROVIDERS.map((provider) => {
                    const isConfigured = aiService.isProviderReady(provider.id);
                    return (
                      <div key={provider.id} className="model-picker-group">
                        <div className="model-picker-group-label">{provider.name}</div>
                        {provider.models.map((model) => {
                          const isActive = currentAIConfig.provider === provider.id && currentAIConfig.model === model;
                          return (
                            <button
                              key={model}
                              type="button"
                              className={`model-picker-item ${isActive ? 'active' : ''} ${!isConfigured ? 'unconfigured' : ''}`}
                              disabled={!isConfigured}
                              onClick={() => {
                                if (!isConfigured) return;
                                aiService.setProvider(provider.id, model);
                                setCurrentAIConfig({ provider: provider.id, model });
                                setShowModelPicker(false);
                              }}
                            >
                              <span className="model-picker-item-name">{model}{isConfigured ? '' : ' - Setup Required'}</span>
                              {isActive && (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <button
              type={isAIProcessing ? 'button' : 'submit'}
              className="terminal-submit-btn"
              onClick={isAIProcessing ? handleStopAIResponse : undefined}
              disabled={isAIStopping}
            >
              {submitLabel}
            </button>
          </form>

          {commandSuggestion && inputMode === 'terminal' && !isAIProcessing && (
            <div
              className="command-suggestion-row compact"
              onClick={() => {
                setInputValue(commandSuggestion);
                setCommandSuggestion('');
                inputRef.current?.focus();
              }}
            >
              <span className="suggestion-preview">{commandSuggestion}</span>
              <div className="suggestion-controls">
                <kbd className="suggestion-kbd">Tab</kbd>
                <span className="suggestion-accept-label">accept</span>
              </div>
            </div>
          )}

          <div className="terminal-compact-status">
            <span>{inputMode === 'ai' ? aiSummary : terminalSummary}</span>
            <span>{inputMode === 'ai' ? 'Ctrl+A AI · Ctrl+T shell' : 'Tab toggles AI · Enter runs'}</span>
          </div>
        </div>
      )}
    </div>
  );
});
