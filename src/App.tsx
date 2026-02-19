import { useState, useCallback, useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir, readTextFile, DirEntry } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { Settings, AIConfig, AI_PROVIDERS, AIProvider } from "./components/Settings";
import { CodeEditor } from "./components/CodeEditor";
import { ToolPanel } from "./components/ToolPanel";
import { TerminalBlock } from "./components/TerminalBlock";
import QuickFileFinder from "./components/QuickFileFinder";
import { SearchPanel } from "./components/SearchPanel";
import { GitPanel } from "./components/GitPanel";
import { VoiceChat } from "./components/VoiceChat";
import { AutomationPanel } from "./components/AutomationPanel";
import { SwarmPanel } from "./components/swarm/SwarmPanel";
import { aiService } from "./services/ai";
import { opencodeClient } from "./services/ai/opencode-client";
import { workspaceService, WorkspaceContext } from "./services/workspace";
import { TerminalRef } from "./components/TerminalBlock";

type Theme = "light" | "dark";

// Terminal tab interface
interface TerminalTab {
  id: string;
  title: string;
}

// Pending AI edit for accept/decline
interface PendingEdit {
  filePath: string;
  fileName: string;
  originalContent: string;
  newContent: string;
  instruction: string;
}

interface FileNode extends DirEntry {
  path: string;
  children?: FileNode[];
  isOpen?: boolean;
  isLoading?: boolean;
}

interface OpenTab {
  id: string;
  path: string;
  name: string;
  content: string;
  isDirty: boolean;
}

function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null);
  const [shellCwd, setShellCwd] = useState<string>("~");
  const [currentDir, setCurrentDir] = useState<string>("");
  const [projectFiles, setProjectFiles] = useState<FileNode[]>([]);
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showToolPanel, setShowToolPanel] = useState(false);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
  const [showQuickFinder, setShowQuickFinder] = useState(false);
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [projectFileContents, setProjectFileContents] = useState<Record<string, string>>({});
  const [workspaceContext, setWorkspaceContext] = useState<WorkspaceContext | null>(null);
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const [showGitPanel, setShowGitPanel] = useState(false);
  const [showVoiceChat, setShowVoiceChat] = useState(false);
  const [showAutomation, setShowAutomation] = useState(false);
  const [showSwarm, setShowSwarm] = useState(false);
  const [openaiApiKey, setOpenaiApiKey] = useState<string>('');
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_isAIProcessing, setIsAIProcessing] = useState(false);
  const [configuredProviders, setConfiguredProviders] = useState<Array<{ id: string; name: string }>>([]);

  // Git changes for terminal input bar
  const [gitChanges, setGitChanges] = useState<Array<{ path: string; type: 'M' | 'A' | 'D' | '?' }>>([]);

  // Theme state - check localStorage first, then system preference
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("velix-theme");
      if (saved === "light" || saved === "dark") return saved;
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "dark";
  });

  // Tab size state - persisted to localStorage
  const [tabSize, setTabSize] = useState<number>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("velix-tab-size");
      const parsed = parseInt(saved || "", 10);
      if (parsed === 2 || parsed === 4 || parsed === 8) return parsed;
    }
    return 4;
  });

  // Handle theme change and persist to localStorage
  const handleThemeChange = useCallback((newTheme: Theme) => {
    setTheme(newTheme);
    localStorage.setItem("velix-theme", newTheme);
  }, []);

  // Handle tab size change and persist to localStorage
  const handleTabSizeChange = useCallback((size: number) => {
    setTabSize(size);
    localStorage.setItem("velix-tab-size", String(size));
  }, []);

  const terminalRefs = useRef<Map<string, TerminalRef>>(new Map());


  // Terminal tabs
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([
    { id: "terminal-1", title: "Terminal 1" }
  ]);
  const [activeTerminalId, setActiveTerminalId] = useState("terminal-1");

  // Resizable panel widths (percentages)
  const [terminalWidth, setTerminalWidth] = useState(50);
  const [isResizing, setIsResizing] = useState(false);

  // Get active tab content
  const activeTab = openTabs.find(t => t.id === activeTabId);
  const activeFile = activeTab?.path || null;

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      setTheme(e.matches ? "dark" : "light");
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // Add new terminal tab
  const addTerminalTab = useCallback(() => {
    const newId = `terminal-${Date.now()}`;
    const newTabNumber = terminalTabs.length + 1;
    setTerminalTabs(prev => [...prev, { id: newId, title: `Terminal ${newTabNumber}` }]);
    setActiveTerminalId(newId);
  }, [terminalTabs.length]);

  // Close terminal tab
  const closeTerminalTab = useCallback((tabId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (terminalTabs.length === 1) return; // Don't close last tab

    const tabIndex = terminalTabs.findIndex(t => t.id === tabId);
    setTerminalTabs(prev => prev.filter(t => t.id !== tabId));

    if (activeTerminalId === tabId) {
      // Switch to adjacent tab
      const newIndex = tabIndex > 0 ? tabIndex - 1 : 0;
      const remaining = terminalTabs.filter(t => t.id !== tabId);
      setActiveTerminalId(remaining[newIndex]?.id || remaining[0]?.id);
    }
  }, [terminalTabs, activeTerminalId]);

  // Initialize shell cwd and global keyboard shortcuts
  useEffect(() => {
    invoke<string>("get_shell_cwd").then(cwd => {
      setShellCwd(cwd);
    }).catch(() => { });

    // Load saved API keys and initialize aiService (backed by opencode engine)
    const initializeAI = async () => {
      // Step 1: Start the opencode server (velixcode engine)
      try {
        await invoke<string>("start_opencode_server");
        console.log("opencode server start requested");
      } catch (e) {
        console.warn("Could not start opencode server:", e);
      }

      // Step 2: Wait for the opencode server to be ready (up to 15s)
      const serverReady = await opencodeClient.waitUntilReady(15000, 500);
      if (!serverReady) {
        console.warn("opencode server did not become ready in time; AI features may be unavailable");
      } else {
        console.log("opencode server is ready");
      }

      // Step 3: Try to load OpenAI key for voice features
      try {
        const openaiKey = await invoke<string>("get_api_key", { provider: "chatgpt" });
        if (openaiKey) {
          setOpenaiApiKey(openaiKey);
        }
      } catch {
        // No OpenAI key saved
      }

      // Step 4: Find all configured providers and register them with opencode
      const providerOrder = ['claude', 'chatgpt', 'gemini', 'glm4', 'minimax', 'zen', 'kimi', 'deepseek', 'groq']; // Prioritize Claude first
      const orderedProviders = providerOrder.map(id => AI_PROVIDERS.find(p => p.id === id)).filter((p): p is AIProvider => p !== undefined);

      console.log('Available providers:', orderedProviders.map(p => p.id));

      const configured: Array<{ id: string; name: string }> = [];
      let firstConfigured: AIProvider | null = null;

      for (const provider of orderedProviders) {
        try {
          const key = await invoke<string>("get_api_key", { provider: provider.id });
          console.log(`Checking provider ${provider.id}:`, key ? 'Key found' : 'No key');
          if (key) {
            // Register with opencode engine (this is the new AI backend)
            await aiService.setApiKey(provider.id, key);
            configured.push({ id: provider.id, name: provider.name });

            if (!firstConfigured) {
              firstConfigured = provider;
              console.log(`Initializing with provider ${provider.id}`);
              aiService.setProvider(provider.id, provider.models[0]);
              setAiConfig({
                provider: provider.id,
                model: provider.models[0],
                apiKey: key,
              });
              console.log('AI service initialized successfully (opencode engine)');
            }
          }
        } catch (error) {
          console.error(`Error checking provider ${provider.id}:`, error);
          // No key for this provider
        }
      }

      setConfiguredProviders(configured);
    };
    initializeAI();

    const handleGlobalKeyDown = async (e: KeyboardEvent) => {
      // Cmd+P: Quick file finder
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        setShowQuickFinder(true);
      }
      // Cmd+D: New terminal tab
      if ((e.metaKey || e.ctrlKey) && e.key === "d") {
        e.preventDefault();
        addTerminalTab();
      }
      // Cmd+W: Close current terminal tab (if focused on terminal)
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        // Only handle if we have more than one terminal tab
        if (terminalTabs.length > 1) {
          e.preventDefault();
          closeTerminalTab(activeTerminalId);
        }
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [addTerminalTab, closeTerminalTab, terminalTabs.length, activeTerminalId]);

  // Handle panel resize
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);

    const startX = e.clientX;
    const startWidth = terminalWidth;
    const containerWidth = (e.target as HTMLElement).parentElement?.parentElement?.offsetWidth || window.innerWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaPercent = (deltaX / containerWidth) * 100;
      const newWidth = Math.min(Math.max(startWidth + deltaPercent, 20), 80);
      setTerminalWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [terminalWidth]);

  // Handle AI requests from the terminal with full project context
  const handleAIRequest = useCallback(async (prompt: string) => {
    if (!aiConfig?.apiKey) {
      terminalRefs.current.forEach((terminal) => {
        terminal.write('\x1b[31mAI not configured. Please add an API key in Settings.\x1b[0m\r\n');
      });
      return;
    }

    // Keep opencode client in sync with the current project directory
    if (currentDir) {
      opencodeClient.setDirectory(currentDir);
    }

    setIsAIProcessing(true);
    try {
      // Build project context using WorkspaceService
      let contextMessage = '';
      let projectContentsForAI: Record<string, string> = {};

      if (currentDir) {
        try {
          // Use workspace service for structured context
          const wsContext = workspaceContext || await workspaceService.scan(currentDir);
          if (!workspaceContext) setWorkspaceContext(wsContext);

          contextMessage = workspaceService.buildContextPrompt(
            wsContext,
            activeTab ? activeTab.path.replace(currentDir + '/', '') : undefined
          );
          projectContentsForAI = wsContext.loadedFiles;
        } catch (e) {
          console.log('WorkspaceService scan failed, falling back:', e);
          contextMessage += `Working directory: ${currentDir}\n`;
          // Fallback: try Rust backend directly
          try {
            const projectFilesMap = await invoke<Record<string, string>>('read_project_source_files', { directory: currentDir });
            if (projectFilesMap && Object.keys(projectFilesMap).length > 0) {
              contextMessage += `\n=== PROJECT SOURCE FILES ===\n`;
              for (const [filePath, content] of Object.entries(projectFilesMap)) {
                contextMessage += `\n--- ${filePath} ---\n${content.slice(0, 3000)}\n`;
              }
              projectContentsForAI = projectFilesMap;
            }
          } catch {
            if (projectFiles && projectFiles.length > 0) {
              const fileList = projectFiles.slice(0, 100).map(f => f.path).join('\n');
              contextMessage += `\nProject files (first 100):\n${fileList}\n`;
            }
          }
        }
      }

      // Add current file context if available
      if (activeTab) {
        contextMessage += `\n=== CURRENTLY OPEN FILE ===\n`;
        contextMessage += `Path: ${activeTab.path}\n`;
        contextMessage += `\`\`\`${activeTab.path.split('.').pop() || 'text'}\n${activeTab.content.slice(0, 15000)}\n\`\`\`\n`;
      }

      // Build system prompt with project context
      const systemPrompt = `You are an AI coding assistant in a developer terminal/IDE called Velix. You have access to the user's ENTIRE project workspace.

${contextMessage}

IMPORTANT INSTRUCTIONS:
1. You have access to ALL source files in the project — analyze them holistically.
2. When the user asks about code, reference actual file paths, functions, and variables from the loaded files.
3. When the user asks to modify or create files, you can edit MULTIPLE files in a single response.
4. Always use relative paths from the project root.
5. Keep explanations concise and focused on code.

FILE MODIFICATION COMMANDS (you can use multiple in one response):
To modify an existing file:
[FILE_WRITE_START]
path: relative/path/to/file.ext
content: |
  ... full updated file content here ...
[FILE_WRITE_END]

To create a new file:
[FILE_CREATE_START]
path: relative/path/to/newfile.ext
content: |
  ... file content here ...
[FILE_CREATE_END]

Working directory: ${currentDir || 'unknown'}`;

      // Make AI request with context
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: prompt }
      ];

      // Write AI thinking status
      terminalRefs.current.forEach((terminal) => {
        terminal.write('\x1b[36mAI is thinking...\x1b[0m\r\n');
      });

      // Call AI service with project contents
      const response = await aiService.chat(messages, {
        projectContents: Object.keys(projectContentsForAI).length > 0 ? projectContentsForAI : undefined,
      });

      let responseText = response.content;

      // Handle ALL file write commands (global regex for multi-file support)
      const fileWriteRegex = /\[FILE_WRITE_START\]([\s\S]*?)\[FILE_WRITE_END\]/g;
      let writeMatch;
      while ((writeMatch = fileWriteRegex.exec(responseText)) !== null) {
        const writeContent = writeMatch[1];
        const pathMatch = writeContent.match(/path:\s*(.+)/);
        const contentMatch = writeContent.match(/content:\s*\|([\s\S]*)/);

        if (pathMatch && contentMatch && currentDir) {
          const filePath = pathMatch[1].trim();
          const fileContent = contentMatch[1].trim();
          const fullPath = filePath.startsWith('/') ? filePath : `${currentDir}/${filePath}`;

          try {
            await invoke('execute_shell_command', {
              command: `cat > "${fullPath}" << 'VELIX_EOF'\n${fileContent}\nVELIX_EOF`,
              cwd: currentDir
            });
            terminalRefs.current.forEach((terminal) => {
              terminal.write(`\x1b[32m✓ File modified: ${fullPath}\x1b[0m\r\n`);
            });
          } catch (err) {
            console.error('File write error:', err);
            terminalRefs.current.forEach((terminal) => {
              terminal.write(`\x1b[31m✗ Failed to write: ${fullPath}: ${err}\x1b[0m\r\n`);
            });
          }
        }
      }

      // Handle ALL file create commands (global regex for multi-file support)
      const fileCreateRegex = /\[FILE_CREATE_START\]([\s\S]*?)\[FILE_CREATE_END\]/g;
      let createMatch;
      while ((createMatch = fileCreateRegex.exec(responseText)) !== null) {
        const createContent = createMatch[1];
        const pathMatch = createContent.match(/path:\s*(.+)/);
        const contentMatch = createContent.match(/content:\s*\|([\s\S]*)/);

        if (pathMatch && contentMatch && currentDir) {
          const filePath = pathMatch[1].trim();
          const fileContent = contentMatch[1].trim();
          const fullPath = filePath.startsWith('/') ? filePath : `${currentDir}/${filePath}`;

          try {
            // Ensure parent directory exists
            const parentDir = fullPath.substring(0, fullPath.lastIndexOf('/'));
            await invoke('execute_shell_command', {
              command: `mkdir -p "${parentDir}" && cat > "${fullPath}" << 'VELIX_EOF'\n${fileContent}\nVELIX_EOF`,
              cwd: currentDir
            });
            terminalRefs.current.forEach((terminal) => {
              terminal.write(`\x1b[32m✓ File created: ${fullPath}\x1b[0m\r\n`);
            });
          } catch (err) {
            console.error('File create error:', err);
            terminalRefs.current.forEach((terminal) => {
              terminal.write(`\x1b[31m✗ Failed to create: ${fullPath}: ${err}\x1b[0m\r\n`);
            });
          }
        }
      }

      // Refresh file tree and workspace context after modifications
      if (currentDir && (fileWriteRegex.lastIndex > 0 || fileCreateRegex.lastIndex > 0)) {
        const files = await loadDirectory(currentDir);
        setProjectFiles(files);
        workspaceService.invalidateCache();
      }

      // Strip file command blocks and markdown formatting for display
      const displayText = responseText
        .replace(/\[FILE_WRITE_START\][\s\S]*?\[FILE_WRITE_END\]/g, '')
        .replace(/\[FILE_CREATE_START\][\s\S]*?\[FILE_CREATE_END\]/g, '')
        .replace(/^#+\s*/gm, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/`(.*?)`/g, '$1')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/^\s*[-*+]\s+/gm, '• ')
        .replace(/^\s*\d+\.\s+/gm, '')
        .trim();

      // Write AI response to terminal
      terminalRefs.current.forEach((terminal) => {
        terminal.write('\r\x1b[2K\r');
        terminal.write('\x1b[32mAI:\x1b[0m ');
        terminal.write(displayText + '\r\n');
      });

      console.log("AI Response:", response.content);

    } catch (error) {
      console.error("AI request failed:", error);
      terminalRefs.current.forEach((terminal) => {
        terminal.write(`\x1b[31mAI Error: ${error instanceof Error ? error.message : 'Unknown error'}\x1b[0m\r\n`);
      });
    } finally {
      setIsAIProcessing(false);
    }
  }, [aiConfig, currentDir, activeTab, projectFiles, workspaceContext]);

  // Update file tree when project changes
  useEffect(() => {
    if (currentDir) {
      loadDirectory(currentDir)
        .then(setProjectFiles)
        .catch(err => console.error("Failed to load directory:", err));
    }
  }, [currentDir]);

  // Load git status for terminal input bar
  useEffect(() => {
    const loadGitChanges = async () => {
      if (!currentDir) {
        setGitChanges([]);
        return;
      }

      try {
        const status = await invoke<{ files: Array<{ path: string; status: string }> }>('get_git_status', {
          repoPath: currentDir,
        });

        // Convert git status to simpler format
        const changes = status.files.map(file => ({
          path: file.path,
          type: file.status.includes('M') ? 'M' as const :
            file.status.includes('A') ? 'A' as const :
              file.status.includes('D') ? 'D' as const :
                '?' as const
        }));

        setGitChanges(changes);
      } catch (err) {
        // Not a git repo or git command failed
        setGitChanges([]);
      }
    };

    loadGitChanges();
    // Refresh git status every 5 seconds
    const interval = setInterval(loadGitChanges, 5000);
    return () => clearInterval(interval);
  }, [currentDir]);

  const loadDirectory = async (path: string): Promise<FileNode[]> => {
    try {
      const entries = await readDir(path);
      return entries
        .map(e => ({ ...e, path: `${path}/${e.name}`, isOpen: false, children: undefined }))
        .sort((a, b) => {
          if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
          return a.isDirectory ? -1 : 1;
        });
    } catch (err) {
      console.error("Failed to read dir:", err);
      return [];
    }
  };

  // Load all project files and their contents for AI context
  const loadProjectFiles = useCallback(async (directory: string) => {
    if (!directory || directory === '~') return;
    try {
      // Use WorkspaceService for structured scanning
      const wsContext = await workspaceService.scan(directory);
      setWorkspaceContext(wsContext);
      setProjectFileContents(wsContext.loadedFiles);

      // Also get flat file list for quick finder
      const files = await invoke<string[]>("get_all_files", { directory });
      setAllFiles(files);

      console.log(`📁 WorkspaceService loaded ${wsContext.totalLoadedFiles}/${wsContext.totalFiles} files (${Math.round(wsContext.totalLoadedSize / 1024)}KB) for AI context`);
    } catch (err) {
      console.error("WorkspaceService scan failed, using fallback:", err);
      // Fallback to original loading method
      try {
        const files = await invoke<string[]>("get_all_files", { directory });
        setAllFiles(files);

        const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.json', '.rs', '.toml', '.md', '.py', '.go', '.java', '.c', '.cpp', '.h', '.swift', '.yaml', '.yml', '.sh', '.sql'];
        const skipDirs = ['node_modules', '.git', 'target', 'dist', 'build', '.next', '.cache', '__pycache__', '.claude'];
        const sourceFiles = files.filter(f => {
          const lower = f.toLowerCase();
          if (skipDirs.some(d => lower.includes(`/${d}/`) || lower.includes(`\\${d}\\`))) return false;
          return sourceExtensions.some(ext => lower.endsWith(ext));
        });

        const contents: Record<string, string> = {};
        let totalSize = 0;
        const maxTotalSize = 80000;
        for (const filePath of sourceFiles) {
          if (totalSize >= maxTotalSize) break;
          try {
            const content = await readTextFile(filePath);
            if (content.length > 10000) continue;
            const relativePath = filePath.replace(directory + '/', '');
            contents[relativePath] = content;
            totalSize += content.length;
          } catch {
            // Skip unreadable files
          }
        }
        setProjectFileContents(contents);
      } catch (fallbackErr) {
        console.error("Fallback loading also failed:", fallbackErr);
      }
    }
  }, []);

  // Keep opencodeClient in sync with the active project/shell directory
  useEffect(() => {
    const dir = currentDir || (shellCwd !== '~' ? shellCwd : '');
    if (dir) opencodeClient.setDirectory(dir);
  }, [currentDir, shellCwd]);

  // Auto-load project files when currentDir changes or on startup from shell cwd
  useEffect(() => {
    const dir = currentDir || shellCwd;
    if (dir && dir !== '~' && dir !== '') {
      loadProjectFiles(dir);
      if (!currentDir && shellCwd && shellCwd !== '~') {
        setCurrentDir(shellCwd);
      }
    }
  }, [currentDir, shellCwd, loadProjectFiles]);

  const handleOpenProject = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === "string") {
        setCurrentDir(selected);
        // Also cd the shell into the project
        try {
          await invoke("set_shell_cwd", { cwd: selected });
          setShellCwd(selected);
        } catch { }

        await loadProjectFiles(selected);
      }
    } catch (err) {
      console.error("Failed to open project:", err);
    }
  };

  const updateFileNode = (nodes: FileNode[], targetPath: string, updater: (node: FileNode) => FileNode): FileNode[] => {
    return nodes.map(node => {
      if (node.path === targetPath) return updater(node);
      if (node.children) return { ...node, children: updateFileNode(node.children, targetPath, updater) };
      return node;
    });
  };

  const handleFolderToggle = async (folder: FileNode) => {
    if (!folder.isDirectory) return;
    if (folder.isOpen) {
      setProjectFiles(prev => updateFileNode(prev, folder.path, n => ({ ...n, isOpen: false })));
    } else {
      if (!folder.children) {
        setProjectFiles(prev => updateFileNode(prev, folder.path, n => ({ ...n, isLoading: true })));
        const children = await loadDirectory(folder.path);
        setProjectFiles(prev => updateFileNode(prev, folder.path, n => ({ ...n, children, isOpen: true, isLoading: false })));
      } else {
        setProjectFiles(prev => updateFileNode(prev, folder.path, n => ({ ...n, isOpen: true })));
      }
    }
  };

  const handleFileClick = async (file: FileNode) => {
    if (file.isDirectory) { handleFolderToggle(file); return; }
    const existingTab = openTabs.find(t => t.path === file.path);
    if (existingTab) { setActiveTabId(existingTab.id); return; }
    try {
      const content = await readTextFile(file.path);
      const newTab: OpenTab = {
        id: Date.now().toString(),
        path: file.path,
        name: file.name,
        content,
        isDirty: false,
      };
      setOpenTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);
    } catch {
      alert("Cannot read this file (binary or permission denied)");
    }
  };

  const handleQuickFinderSelect = async (filePath: string) => {
    const fullPath = currentDir ? `${currentDir}/${filePath}` : filePath;
    const fileName = filePath.split('/').pop() || filePath;

    const existingTab = openTabs.find(t => t.path === fullPath);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      return;
    }

    try {
      const content = await readTextFile(fullPath);
      const newTab: OpenTab = {
        id: Date.now().toString(),
        path: fullPath,
        name: fileName,
        content,
        isDirty: false,
      };
      setOpenTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);
    } catch {
      alert("Cannot read this file (binary or permission denied)");
    }
  };

  const handleSearchResultClick = async (file: string, _line: number) => {
    const fullPath = currentDir ? `${currentDir}/${file}` : file;
    const fileName = file.split('/').pop() || file;

    const existingTab = openTabs.find(t => t.path === fullPath);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      // TODO: Scroll to line number
      return;
    }

    try {
      const content = await readTextFile(fullPath);
      const newTab: OpenTab = {
        id: Date.now().toString(),
        path: fullPath,
        name: fileName,
        content,
        isDirty: false,
      };
      setOpenTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);
      // TODO: Scroll to line number
    } catch {
      alert("Cannot read this file (binary or permission denied)");
    }
  };

  const handleWriteToTerminal = useCallback((data: string) => {
    const activeRef = terminalRefs.current.get(activeTerminalId);
    if (activeRef) {
      activeRef.write(data);
      activeRef.focus();
    }
  }, [activeTerminalId]);

  const handleGitFileClick = async (file: string) => {
    const fullPath = currentDir ? `${currentDir}/${file}` : file;
    const fileName = file.split('/').pop() || file;

    const existingTab = openTabs.find(t => t.path === fullPath);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      return;
    }

    try {
      const content = await readTextFile(fullPath);
      const newTab: OpenTab = {
        id: Date.now().toString(),
        path: fullPath,
        name: fileName,
        content,
        isDirty: false,
      };
      setOpenTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);
    } catch {
      alert("Cannot read this file (binary or permission denied)");
    }
  };

  const handleCloseTab = (tabId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const tab = openTabs.find(t => t.id === tabId);
    if (tab?.isDirty && !confirm(`${tab.name} has unsaved changes. Close anyway?`)) return;

    // Calculate remaining tabs before updating state to avoid race condition
    const remaining = openTabs.filter(t => t.id !== tabId);
    setOpenTabs(remaining);

    if (activeTabId === tabId) {
      setActiveTabId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
    }
  };

  const handleTabContentChange = (tabId: string, content: string) => {
    setOpenTabs(prev => prev.map(t => t.id === tabId ? { ...t, content, isDirty: true } : t));
  };

  const handleTabSaved = (tabId: string) => {
    setOpenTabs(prev => prev.map(t => t.id === tabId ? { ...t, isDirty: false } : t));
  };

  const handleAIConfigSave = useCallback(async (config: AIConfig) => {
    setAiConfig(config);
    if (config.apiKey) {
      await aiService.setApiKey(config.provider, config.apiKey);
      aiService.setProvider(config.provider, config.model);

      // Add to configuredProviders if not already present
      setConfiguredProviders(prev => {
        if (prev.find(p => p.id === config.provider)) return prev;
        const providerInfo = AI_PROVIDERS.find(p => p.id === config.provider);
        return [...prev, { id: config.provider, name: providerInfo?.name ?? config.provider }];
      });

      // If this is the OpenAI/ChatGPT provider, also update the openaiApiKey for voice features
      if (config.provider === 'chatgpt') {
        setOpenaiApiKey(config.apiKey);
      }
    }
  }, []);

  const handleModelChange = useCallback((model: string) => {
    if (aiConfig) {
      const newConfig = { ...aiConfig, model };
      setAiConfig(newConfig);
      aiService.setProvider(newConfig.provider, model);
    }
  }, [aiConfig]);

  const handleProviderChange = useCallback(async (providerId: string) => {
    const provider = AI_PROVIDERS.find(p => p.id === providerId);
    if (!provider) return;

    try {
      const key = await invoke<string>("get_api_key", { provider: providerId });
      if (key) {
        aiService.setProvider(providerId as AIProvider["id"], provider.models[0]);
        setAiConfig({
          provider: providerId as AIProvider["id"],
          model: provider.models[0],
          apiKey: key,
        });
      }
    } catch (error) {
      console.error(`Failed to switch to provider ${providerId}:`, error);
    }
  }, []);

  // Accept pending AI edit
  const handleAcceptEdit = () => {
    if (!pendingEdit) return;
    const tab = openTabs.find(t => t.path === pendingEdit.filePath);
    if (tab) {
      handleTabContentChange(tab.id, pendingEdit.newContent);
    }
    setPendingEdit(null);
  };

  // Decline pending AI edit
  const handleDeclineEdit = () => {
    setPendingEdit(null);
  };

  // File tree renderer
  const renderFileTree = (files: FileNode[], depth: number = 0): React.ReactNode => {
    return files.map(file => (
      <div key={file.path}>
        <div
          className={`tree-item ${file.isDirectory ? "folder" : "file"} ${activeFile === file.path ? "active" : ""}`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
          onClick={() => handleFileClick(file)}
        >
          <span className={`item-icon ${file.isDirectory && file.isOpen ? "open" : ""}`}>
            {file.isDirectory ? (file.isLoading ? "..." : file.isOpen ? "v" : ">") : ""}
          </span>
          <span className="item-name">{file.name}</span>
        </div>
        {file.isDirectory && file.isOpen && file.children && (
          <div className="tree-children">{renderFileTree(file.children, depth + 1)}</div>
        )}
      </div>
    ));
  };

  // Compute simple line diff for the diff view
  const computeDiff = (original: string, modified: string) => {
    const origLines = original.split("\n");
    const modLines = modified.split("\n");
    const maxLen = Math.max(origLines.length, modLines.length);
    const result: Array<{ type: "same" | "removed" | "added" | "changed"; lineNum: number; original?: string; modified?: string }> = [];

    for (let i = 0; i < maxLen; i++) {
      const orig = origLines[i];
      const mod = modLines[i];
      if (orig === undefined && mod !== undefined) {
        result.push({ type: "added", lineNum: i + 1, modified: mod });
      } else if (mod === undefined && orig !== undefined) {
        result.push({ type: "removed", lineNum: i + 1, original: orig });
      } else if (orig === mod) {
        result.push({ type: "same", lineNum: i + 1, original: orig });
      } else {
        result.push({ type: "changed", lineNum: i + 1, original: orig, modified: mod });
      }
    }
    return result;
  };

  // Voice chat requires an API key to show
  const canShowVoiceChat = showVoiceChat && !!openaiApiKey;

  // Is the right panel visible (tool panel, search panel, git panel, voice chat, automation, or swarm)
  // Only show right panel if there's actually something to display
  const hasRightPanel = showToolPanel || showSearchPanel || showGitPanel || canShowVoiceChat || showAutomation || showSwarm;

  return (
    <div className={`app ${theme}`}>
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <button className="project-btn" onClick={handleOpenProject}>
            <span className="folder-icon">+</span>
            {currentDir ? currentDir.split("/").pop() : "Open Project..."}
          </button>
        </div>
        <div className="file-tree">
          {!currentDir && <div className="empty-state">No project open</div>}
          {renderFileTree(projectFiles)}
        </div>
        <div className="sidebar-tools">
          <button
            className={`tool-btn ${showVoiceChat ? "active" : ""}`}
            onClick={() => {
              setShowVoiceChat(!showVoiceChat);
              if (!showVoiceChat) {
                setShowGitPanel(false);
                setShowSearchPanel(false);
                setShowToolPanel(false);
                setShowAutomation(false);
              }
            }}
            disabled={!openaiApiKey}
            title={!openaiApiKey ? "Voice requires OpenAI API key. Configure ChatGPT in Settings." : "Voice Chat"}
          >
            <span className="tool-icon">V</span><span>Voice</span>
          </button>
          <button
            className={`tool-btn ${showGitPanel ? "active" : ""}`}
            onClick={() => {
              setShowGitPanel(!showGitPanel);
              if (!showGitPanel) {
                setShowVoiceChat(false);
                setShowSearchPanel(false);
                setShowToolPanel(false);
                setShowAutomation(false);
              }
            }}
          >
            <span className="tool-icon">G</span><span>Git</span>
          </button>
          <button
            className={`tool-btn ${showSearchPanel ? "active" : ""}`}
            onClick={() => {
              setShowSearchPanel(!showSearchPanel);
              if (!showSearchPanel) {
                setShowVoiceChat(false);
                setShowGitPanel(false);
                setShowToolPanel(false);
                setShowAutomation(false);
              }
            }}
          >
            <span className="tool-icon">S</span><span>Search</span>
          </button>
          <button
            className={`tool-btn ${showToolPanel ? "active" : ""}`}
            onClick={() => {
              setShowToolPanel(!showToolPanel);
              if (!showToolPanel) {
                setShowVoiceChat(false);
                setShowGitPanel(false);
                setShowSearchPanel(false);
                setShowAutomation(false);
              }
            }}
          >
            <span className="tool-icon">T</span><span>Tools</span>
          </button>
          <button
            className={`tool-btn automation-btn ${showAutomation ? "active" : ""}`}
            onClick={() => {
              setShowAutomation(!showAutomation);
              if (!showAutomation) {
                setShowVoiceChat(false);
                setShowGitPanel(false);
                setShowSearchPanel(false);
                setShowToolPanel(false);
                setShowSwarm(false);
              }
            }}
            disabled={!aiConfig?.apiKey}
            title={!aiConfig?.apiKey ? "Automation requires an API key. Add one in Settings." : "Automation Claude Code - Run multiple AI agents automatically"}
          >
            <span className="tool-icon">A</span><span>Auto</span>
          </button>
          <button
            className={`tool-btn swarm-btn ${showSwarm ? "active" : ""}`}
            onClick={() => {
              setShowSwarm(!showSwarm);
              if (!showSwarm) {
                setShowVoiceChat(false);
                setShowGitPanel(false);
                setShowSearchPanel(false);
                setShowToolPanel(false);
                setShowAutomation(false);
              }
            }}
            disabled={!aiConfig?.apiKey || !currentDir}
            title={!aiConfig?.apiKey ? "Swarm requires an API key. Add one in Settings." : !currentDir ? "Swarm requires an open project. Open a project first." : "Claude Swarm - Advanced multi-agent orchestration"}
          >
            <span className="tool-icon">W</span><span>Swarm</span>
          </button>
          <button className="tool-btn" onClick={() => setShowSettings(true)}>
            <span className="tool-icon">S</span><span>Settings</span>
          </button>
        </div>
      </aside>

      {/* Main content area: terminal + optional right panel */}
      <main className="main-split">
        {/* Terminal pane */}
        <div className="terminal-pane">
          <div className="terminal-topbar">
            {/* Terminal tabs */}
            <div className="terminal-tabs">
              {terminalTabs.map(tab => (
                <div
                  key={tab.id}
                  className={`terminal-tab ${tab.id === activeTerminalId ? "active" : ""}`}
                  onClick={() => setActiveTerminalId(tab.id)}
                >
                  <span className="terminal-tab-title">{tab.title}</span>
                  {terminalTabs.length > 1 && (
                    <button
                      className="terminal-tab-close"
                      onClick={(e) => closeTerminalTab(tab.id, e)}
                    >
                      x
                    </button>
                  )}
                </div>
              ))}
              <button className="terminal-tab-add" onClick={addTerminalTab} title="New Terminal (Cmd+D)">
                +
              </button>
            </div>

            <div className="terminal-topbar-actions">
              {configuredProviders.length > 1 && aiConfig?.provider && (
                <div className="provider-selector">
                  <select
                    value={aiConfig.provider}
                    onChange={(e) => handleProviderChange(e.target.value)}
                    className="provider-select"
                  >
                    {configuredProviders.map(p => (
                      <option key={p.id} value={p.id}>{p.name.split(' ')[0]}</option>
                    ))}
                  </select>
                </div>
              )}
              {aiConfig?.provider && (
                <div className="model-selector">
                  <span className="provider-label">{aiConfig.provider}</span>
                  <select
                    value={aiConfig.model}
                    onChange={(e) => handleModelChange(e.target.value)}
                    className="model-select"
                  >
                    {AI_PROVIDERS.find(p => p.id === aiConfig.provider)?.models.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>

          <div className={`terminal-body ${terminalTabs.length > 1 ? 'split-view' : ''}`}>
            {terminalTabs.map(tab => (
              <div
                key={tab.id}
                className={`terminal-tab-content ${tab.id === activeTerminalId ? 'active' : ''}`}
                style={{ display: terminalTabs.length > 1 || tab.id === activeTerminalId ? "flex" : "none" }}
                onClick={() => setActiveTerminalId(tab.id)}
              >
                {terminalTabs.length > 1 && (
                  <div className="split-terminal-header">
                    <span>{tab.title}</span>
                    <button
                      className="split-terminal-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTerminalTab(tab.id, e);
                      }}
                    >
                      ×
                    </button>
                  </div>
                )}
                <TerminalBlock
                  ref={(el) => {
                    if (el) terminalRefs.current.set(tab.id, el);
                    else terminalRefs.current.delete(tab.id);
                  }}
                  cwd={shellCwd}
                  onCwdChange={setShellCwd}
                  theme={theme}
                  onAIRequest={handleAIRequest}
                  aiEnabled={!!aiConfig?.apiKey}
                  recentFiles={openTabs.map(tab => tab.path)}
                  gitChanges={gitChanges}
                  currentFile={activeTab ? {
                    path: activeTab.path,
                    content: activeTab.content,
                    language: activeTab.path.split('.').pop() || 'text'
                  } : undefined}
                  onFileUpdate={(path, content) => {
                    const tab = openTabs.find(t => t.path === path);
                    if (tab) {
                      handleTabContentChange(tab.id, content);
                    }
                  }}
                  projectDir={currentDir}
                  projectFileList={allFiles}
                  projectFileContents={projectFileContents}
                  workspaceContext={workspaceContext}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Right panel: tools, search, git, automation, or swarm */}
        <div className={`right-panel${hasRightPanel ? ' open' : ''}`}>
            {showToolPanel && (
              <ToolPanel
                filePath={null}
                fileContent=""
                projectDir={currentDir}
                onClose={() => setShowToolPanel(false)}
              />
            )}
            {showSearchPanel && (
              <SearchPanel
                currentDir={currentDir}
                onResultClick={async (path: string) => {
                  try {
                    const fullPath = currentDir ? `${currentDir}/${path}` : path;
                    const content = await readTextFile(fullPath);
                    const newTab = {
                      id: Date.now().toString(),
                      path: fullPath,
                      name: path.split('/').pop() || path,
                      content,
                      isDirty: false,
                    };
                    setOpenTabs(prev => [...prev, newTab]);
                    setActiveTabId(newTab.id);
                    setShowSearchPanel(false);
                  } catch {
                    alert("Cannot read this file");
                  }
                }}
              />
            )}
            {showGitPanel && (
              <GitPanel
                currentDir={currentDir}
                onFileClick={async (path: string) => {
                  try {
                    const fullPath = currentDir ? `${currentDir}/${path}` : path;
                    const content = await readTextFile(fullPath);
                    const newTab = {
                      id: Date.now().toString(),
                      path: fullPath,
                      name: path.split('/').pop() || path,
                      content,
                      isDirty: false,
                    };
                    setOpenTabs(prev => [...prev, newTab]);
                    setActiveTabId(newTab.id);
                  } catch {
                    alert("Cannot read this file");
                  }
                }}
              />
            )}
            {showAutomation && (
              <AutomationPanel
                isOpen={showAutomation}
                onClose={() => setShowAutomation(false)}
                theme={theme}
                hasApiKey={!!aiConfig?.apiKey}
                onGeneratePrompts={(goal, count) => aiService.generateAutomationPrompts(goal, count)}
                onWriteToTerminal={(data) => terminalRefs.current.forEach(t => t.write(data))}
              />
            )}
            {showSwarm && (
              <SwarmPanel
                isOpen={showSwarm}
                onClose={() => setShowSwarm(false)}
                theme={theme}
                workspacePath={currentDir}
                hasApiKey={!!aiConfig?.apiKey}
              />
            )}
        </div>
      </main>

      <Settings
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        onSave={handleAIConfigSave}
        currentConfig={aiConfig}
        theme={theme}
        onThemeChange={handleThemeChange}
        tabSize={tabSize}
        onTabSizeChange={handleTabSizeChange}
      />

      <QuickFileFinder
        isOpen={showQuickFinder}
        onClose={() => setShowQuickFinder(false)}
        files={allFiles}
        onFileSelect={handleQuickFinderSelect}
      />



    </div>
  );
}

export default App;
