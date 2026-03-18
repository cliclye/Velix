import { useState, useCallback, useEffect, useRef } from "react";
import { open, invoke } from "./platform/native";
import "./App.css";
import { Settings, AIConfig, AI_PROVIDERS, AIProvider } from "./components/Settings";
import { SetupScreen } from "./components/SetupScreen";
import { TerminalBlock, TerminalRef } from "./components/TerminalBlock";
import { SearchPanel } from "./components/SearchPanel";
import { GitPanel } from "./components/GitPanel";
import { VoiceChat } from "./components/VoiceChat";
import { SwarmPanel } from "./components/swarm/SwarmPanel";
import { aiService } from "./services/ai";
import { workspaceService, WorkspaceContext } from "./services/workspace";

type Theme = "light" | "dark";
type SetupTransitionPhase = "idle" | "closing" | "loading" | "finishing";

interface TerminalPaneState {
  id: string;
  title: string;
}

interface WorkspaceTabState {
  id: string;
  title: string;
  panes: TerminalPaneState[];
  activePaneId: string;
  shellCwd: string;
  projectDir: string;
  projectFileContents: Record<string, string>;
  workspaceContext: WorkspaceContext | null;
  gitChanges: Array<{ path: string; type: "M" | "A" | "D" | "?" }>;
  currentBranch: string;
}

const makeId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const buildPaneTitle = (index: number) => `Pane ${index}`;
const MAX_PANES_PER_TAB = 9;
const PANE_DRAG_DATA_KEY = "application/x-velix-pane";
const getPaneGridColumnCount = (paneCount: number) => (paneCount <= 1 ? 1 : paneCount <= 4 ? 2 : 3);

const renumberPanes = (panes: TerminalPaneState[]) =>
  panes.map((pane, index) => ({
    ...pane,
    title: buildPaneTitle(index + 1),
  }));

const getPathLeaf = (value: string) => {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || value;
};

function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [showSetupScreen, setShowSetupScreen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const hasSeenSetup = localStorage.getItem("velix-setup-seen") === "true";
    if (!hasSeenSetup) {
      localStorage.setItem("velix-setup-seen", "true");
      return true;
    }
    return false;
  });
  const [setupScreenPhase, setSetupScreenPhase] = useState<SetupTransitionPhase>("idle");
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null);
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const [showGitPanel, setShowGitPanel] = useState(false);
  const [showVoiceChat, setShowVoiceChat] = useState(false);
  const [showVoiceSetup, setShowVoiceSetup] = useState(false);
  const [swarmTabOpen, setSwarmTabOpen] = useState(false);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const voiceSetupRef = useRef<HTMLDivElement>(null);
  const [_isAIProcessing, setIsAIProcessing] = useState(false);
  const setupTransitionTimersRef = useRef<number[]>([]);

  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("velix-theme");
      if (saved === "light" || saved === "dark") return saved;
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "dark";
  });

  const handleThemeChange = useCallback((newTheme: Theme) => {
    setTheme(newTheme);
    localStorage.setItem("velix-theme", newTheme);
  }, []);

  const clearSetupTransitionTimers = useCallback(() => {
    setupTransitionTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    setupTransitionTimersRef.current = [];
  }, []);

  const terminalRefs = useRef<Map<string, TerminalRef>>(new Map());
  const initialWorkspaceTabIdRef = useRef(makeId("tab"));
  const initialPaneIdRef = useRef(makeId("pane"));
  const [defaultShellCwd, setDefaultShellCwd] = useState<string>("~");
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTabState[]>(() => [
    {
      id: initialWorkspaceTabIdRef.current,
      title: "Tab 1",
      panes: [{ id: initialPaneIdRef.current, title: buildPaneTitle(1) }],
      activePaneId: initialPaneIdRef.current,
      shellCwd: "~",
      projectDir: "",
      projectFileContents: {},
      workspaceContext: null,
      gitChanges: [],
      currentBranch: "",
    },
  ]);
  const [activeTerminalId, setActiveTerminalId] = useState(initialWorkspaceTabIdRef.current);
  const [lastWorkspaceTabId, setLastWorkspaceTabId] = useState(initialWorkspaceTabIdRef.current);
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);
  const [paneDropPreview, setPaneDropPreview] = useState<{ tabId: string; index: number } | null>(null);

  const activeWorkspaceTabId = workspaceTabs.some((tab) =>
    tab.id === (activeTerminalId === "swarm" ? lastWorkspaceTabId : activeTerminalId),
  )
    ? (activeTerminalId === "swarm" ? lastWorkspaceTabId : activeTerminalId)
    : (workspaceTabs[0]?.id || "");
  const activeWorkspaceTab =
    workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) || workspaceTabs[0] || null;
  const currentDir = activeWorkspaceTab?.projectDir || "";
  const workspaceContext = activeWorkspaceTab?.workspaceContext || null;
  const currentBranch = activeWorkspaceTab?.currentBranch || "";

  const updateWorkspaceTab = useCallback((tabId: string, updater: (tab: WorkspaceTabState) => WorkspaceTabState) => {
    setWorkspaceTabs((prev) =>
      prev.map((tab) => (tab.id === tabId ? updater(tab) : tab)),
    );
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      if (localStorage.getItem("velix-theme")) return;
      setTheme(e.matches ? "dark" : "light");
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => () => clearSetupTransitionTimers(), [clearSetupTransitionTimers]);

  useEffect(() => {
    if (activeTerminalId !== "swarm") {
      setLastWorkspaceTabId(activeTerminalId);
    }
  }, [activeTerminalId]);

  const addWorkspaceTab = useCallback(() => {
    const newTabId = makeId("tab");
    const newPaneId = makeId("pane");
    const nextTabNumber = workspaceTabs.length + 1;

    setWorkspaceTabs((prev) => [
      ...prev,
      {
        id: newTabId,
        title: `Tab ${nextTabNumber}`,
        panes: [{ id: newPaneId, title: buildPaneTitle(1) }],
        activePaneId: newPaneId,
        shellCwd: defaultShellCwd,
        projectDir: "",
        projectFileContents: {},
        workspaceContext: null,
        gitChanges: [],
        currentBranch: "",
      },
    ]);

    setActiveTerminalId(newTabId);
    setLastWorkspaceTabId(newTabId);
  }, [defaultShellCwd, workspaceTabs.length]);

  const addSplitPane = useCallback((targetTabId?: string) => {
    const tabId = targetTabId || activeWorkspaceTabId;
    if (!tabId) return;

    const newPaneId = makeId("pane");
    updateWorkspaceTab(tabId, (tab) => {
      if (tab.panes.length >= MAX_PANES_PER_TAB) {
        return tab;
      }

      const nextPanes = [
        ...tab.panes,
        { id: newPaneId, title: buildPaneTitle(tab.panes.length + 1) },
      ];

      return {
        ...tab,
        panes: renumberPanes(nextPanes),
        activePaneId: newPaneId,
      };
    });

    setActiveTerminalId(tabId);
    setLastWorkspaceTabId(tabId);
  }, [activeWorkspaceTabId, updateWorkspaceTab]);

  const closeSwarmTab = useCallback(() => {
    setSwarmTabOpen(false);
    setActiveTerminalId((prev) =>
      prev === "swarm" ? (workspaceTabs.some((tab) => tab.id === lastWorkspaceTabId) ? lastWorkspaceTabId : (workspaceTabs[0]?.id || "")) : prev,
    );
  }, [lastWorkspaceTabId, workspaceTabs]);

  const closeSplitPane = useCallback((tabId: string, paneId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();

    updateWorkspaceTab(tabId, (tab) => {
      if (tab.panes.length === 1) return tab;

      const paneIndex = tab.panes.findIndex((pane) => pane.id === paneId);
      const nextPanes = tab.panes.filter((pane) => pane.id !== paneId);
      const fallbackPane =
        nextPanes[Math.max(0, paneIndex - 1)] ||
        nextPanes[0];

      return {
        ...tab,
        panes: renumberPanes(nextPanes),
        activePaneId:
          tab.activePaneId === paneId || !nextPanes.some((pane) => pane.id === tab.activePaneId)
            ? fallbackPane.id
            : tab.activePaneId,
      };
    });
  }, [updateWorkspaceTab]);

  const movePaneWithinTab = useCallback((tabId: string, sourcePaneId: string, targetIndex: number) => {
    updateWorkspaceTab(tabId, (tab) => {
      const sourceIndex = tab.panes.findIndex((pane) => pane.id === sourcePaneId);
      if (sourceIndex === -1) return tab;

      const nextPanes = [...tab.panes];
      const [movedPane] = nextPanes.splice(sourceIndex, 1);
      if (!movedPane) return tab;

      let nextIndex = Math.max(0, Math.min(targetIndex, tab.panes.length));
      if (sourceIndex < nextIndex) {
        nextIndex -= 1;
      }
      nextIndex = Math.max(0, Math.min(nextIndex, nextPanes.length));

      nextPanes.splice(nextIndex, 0, movedPane);

      return {
        ...tab,
        panes: renumberPanes(nextPanes),
        activePaneId: movedPane.id,
      };
    });
  }, [updateWorkspaceTab]);

  const readDraggedPane = useCallback((event: React.DragEvent): { tabId: string; paneId: string } | null => {
    const raw = event.dataTransfer.getData(PANE_DRAG_DATA_KEY) || event.dataTransfer.getData("text/plain");
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as { tabId?: string; paneId?: string };
      return parsed.tabId && parsed.paneId
        ? { tabId: parsed.tabId, paneId: parsed.paneId }
        : null;
    } catch {
      return null;
    }
  }, []);

  const handlePaneDragStart = useCallback((tabId: string, paneId: string, event: React.DragEvent<HTMLDivElement>) => {
    const payload = JSON.stringify({ tabId, paneId });
    event.dataTransfer.setData(PANE_DRAG_DATA_KEY, payload);
    event.dataTransfer.setData("text/plain", payload);
    event.dataTransfer.effectAllowed = "move";
    setDraggingPaneId(paneId);
    setPaneDropPreview(null);
    setActiveTerminalId(tabId);
  }, []);

  const handlePaneDragEnd = useCallback(() => {
    setDraggingPaneId(null);
    setPaneDropPreview(null);
  }, []);

  const getPaneDropIndex = useCallback((
    event: React.DragEvent<HTMLDivElement>,
    tab: WorkspaceTabState,
    targetPaneId: string,
  ) => {
    const targetIndex = tab.panes.findIndex((pane) => pane.id === targetPaneId);
    if (targetIndex === -1) {
      return tab.panes.length;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const relativeX = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
    const relativeY = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
    const columns = getPaneGridColumnCount(tab.panes.length);

    if (relativeY <= 0.28) {
      return Math.max(0, targetIndex - columns);
    }

    if (relativeY >= 0.72) {
      return Math.min(tab.panes.length, targetIndex + columns);
    }

    return relativeX >= 0.5 ? targetIndex + 1 : targetIndex;
  }, []);

  const handlePanePanelDragOver = useCallback((event: React.DragEvent, tab: WorkspaceTabState) => {
    const dragged = readDraggedPane(event);
    if (!dragged || dragged.tabId !== tab.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setPaneDropPreview((current) =>
      current?.tabId === tab.id && current.index === tab.panes.length
        ? current
        : { tabId: tab.id, index: tab.panes.length },
    );
  }, [readDraggedPane]);

  const handlePaneTargetDragOver = useCallback((
    event: React.DragEvent<HTMLDivElement>,
    tab: WorkspaceTabState,
    targetPaneId: string,
  ) => {
    const dragged = readDraggedPane(event);
    if (!dragged || dragged.tabId !== tab.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const nextIndex = getPaneDropIndex(event, tab, targetPaneId);
    setPaneDropPreview((current) =>
      current?.tabId === tab.id && current.index === nextIndex
        ? current
        : { tabId: tab.id, index: nextIndex },
    );
  }, [getPaneDropIndex, readDraggedPane]);

  const handlePaneDrop = useCallback((event: React.DragEvent, tab: WorkspaceTabState) => {
    const dragged = readDraggedPane(event);
    if (!dragged || dragged.tabId !== tab.id) return;
    event.preventDefault();
    const targetIndex = paneDropPreview?.tabId === tab.id ? paneDropPreview.index : tab.panes.length;
    movePaneWithinTab(tab.id, dragged.paneId, targetIndex);
    setDraggingPaneId(null);
    setPaneDropPreview(null);
  }, [movePaneWithinTab, paneDropPreview, readDraggedPane]);

  const closeWorkspaceTab = useCallback((tabId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (workspaceTabs.length === 1) return;

    const tabIndex = workspaceTabs.findIndex((tab) => tab.id === tabId);
    const remainingTabs = workspaceTabs.filter((tab) => tab.id !== tabId);
    const fallbackTab =
      remainingTabs[Math.max(0, tabIndex - 1)] ||
      remainingTabs[0] ||
      null;

    setWorkspaceTabs(remainingTabs);

    if (activeTerminalId === tabId) {
      setActiveTerminalId(fallbackTab?.id || "");
    }
    if (lastWorkspaceTabId === tabId) {
      setLastWorkspaceTabId(fallbackTab?.id || "");
    }
  }, [activeTerminalId, lastWorkspaceTabId, workspaceTabs]);

  const closeActivePaneOrTab = useCallback(() => {
    if (activeTerminalId === "swarm") {
      closeSwarmTab();
      return;
    }

    if (!activeWorkspaceTab) return;

    if (activeWorkspaceTab.panes.length > 1) {
      closeSplitPane(activeWorkspaceTab.id, activeWorkspaceTab.activePaneId);
      return;
    }

    closeWorkspaceTab(activeWorkspaceTab.id);
  }, [activeTerminalId, activeWorkspaceTab, closeSplitPane, closeSwarmTab, closeWorkspaceTab]);

  useEffect(() => {
    invoke<string>("get_shell_cwd")
      .then((cwd) => {
        setDefaultShellCwd(cwd);
        setWorkspaceTabs((prev) =>
          prev.map((tab) =>
            tab.projectDir || tab.shellCwd !== "~"
              ? tab
              : { ...tab, shellCwd: cwd },
          ),
        );
      })
      .catch(() => {});

    const initializeAI = async () => {
      try {
        const openaiKey = await invoke<string>("get_api_key", { provider: "chatgpt" });
        if (openaiKey) {
          setOpenaiApiKey(openaiKey);
        }
      } catch {
        // No OpenAI key saved.
      }

      const providerOrder = ["claude", "chatgpt", "gemini", "glm4", "minimax", "kimi", "deepseek", "groq", "mistral"];
      const orderedProviders = providerOrder
        .map((id) => AI_PROVIDERS.find((provider) => provider.id === id))
        .filter((provider): provider is AIProvider => provider !== undefined);

      for (const provider of orderedProviders) {
        try {
          const key = await invoke<string>("get_api_key", { provider: provider.id });
          if (!key) continue;

          await aiService.setApiKey(provider.id, key);
          aiService.setProvider(provider.id, provider.models[0]);
          setAiConfig({
            provider: provider.id,
            model: provider.models[0],
            apiKey: key,
          });
          break;
        } catch (error) {
          console.error(`Error checking provider ${provider.id}:`, error);
        }
      }
    };

    initializeAI();
  }, []);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        addSplitPane();
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        closeActivePaneOrTab();
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [addSplitPane, closeActivePaneOrTab]);

  const getActivePaneRefs = useCallback(() => (
    activeWorkspaceTab?.panes
      .map((pane) => terminalRefs.current.get(pane.id))
      .filter((terminal): terminal is TerminalRef => Boolean(terminal)) || []
  ), [activeWorkspaceTab]);

  const handleAIRequest = useCallback(async (prompt: string) => {
    const targetTerminals = getActivePaneRefs();

    if (!aiConfig?.apiKey) {
      targetTerminals.forEach((terminal) => {
        terminal.write("\x1b[31mAI not configured. Please add an API key in Settings.\x1b[0m\r\n");
      });
      return;
    }

    setIsAIProcessing(true);
    try {
      let contextMessage = "";
      let projectContentsForAI: Record<string, string> = {};

      if (currentDir) {
        try {
          const wsContext = workspaceContext || await workspaceService.scan(currentDir);
          if (!workspaceContext && activeWorkspaceTab) {
            updateWorkspaceTab(activeWorkspaceTab.id, (tab) =>
              tab.projectDir !== currentDir
                ? tab
                : {
                    ...tab,
                    workspaceContext: wsContext,
                    projectFileContents: wsContext.loadedFiles,
                  },
            );
          }

          contextMessage = workspaceService.buildContextPrompt(wsContext);
          projectContentsForAI = wsContext.loadedFiles;
        } catch (error) {
          console.log("WorkspaceService scan failed, falling back:", error);
          contextMessage += `Working directory: ${currentDir}\n`;

          try {
            const projectFilesMap = await invoke<Record<string, string>>("read_project_source_files", {
              directory: currentDir,
            });
            if (projectFilesMap && Object.keys(projectFilesMap).length > 0) {
              contextMessage += "\n=== PROJECT SOURCE FILES ===\n";
              for (const [filePath, content] of Object.entries(projectFilesMap)) {
                contextMessage += `\n--- ${filePath} ---\n${content.slice(0, 3000)}\n`;
              }
              projectContentsForAI = projectFilesMap;
            }
          } catch {
            // No project files available.
          }
        }
      }

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

Working directory: ${currentDir || "unknown"}`;

      const messages = [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: prompt },
      ];

      targetTerminals.forEach((terminal) => {
        terminal.write("\x1b[36mAI is thinking...\x1b[0m\r\n");
      });

      const response = await aiService.chat(messages, {
        projectContents: Object.keys(projectContentsForAI).length > 0 ? projectContentsForAI : undefined,
      });

      const responseText = response.content;
      const fileWriteRegex = /\[FILE_WRITE_START\]([\s\S]*?)\[FILE_WRITE_END\]/g;
      let writeMatch: RegExpExecArray | null;
      while ((writeMatch = fileWriteRegex.exec(responseText)) !== null) {
        const writeContent = writeMatch[1];
        const pathMatch = writeContent.match(/path:\s*(.+)/);
        const contentMatch = writeContent.match(/content:\s*\|([\s\S]*)/);

        if (pathMatch && contentMatch && currentDir) {
          const filePath = pathMatch[1].trim();
          const fileContent = contentMatch[1].trim();
          const fullPath = filePath.startsWith("/") ? filePath : `${currentDir}/${filePath}`;

          try {
            await invoke("execute_shell_command", {
              command: `cat > "${fullPath}" << 'VELIX_EOF'\n${fileContent}\nVELIX_EOF`,
              cwd: currentDir,
            });
            targetTerminals.forEach((terminal) => {
              terminal.write(`\x1b[32m✓ File modified: ${fullPath}\x1b[0m\r\n`);
            });
          } catch (error) {
            console.error("File write error:", error);
            targetTerminals.forEach((terminal) => {
              terminal.write(`\x1b[31m✗ Failed to write: ${fullPath}: ${error}\x1b[0m\r\n`);
            });
          }
        }
      }

      const fileCreateRegex = /\[FILE_CREATE_START\]([\s\S]*?)\[FILE_CREATE_END\]/g;
      let createMatch: RegExpExecArray | null;
      while ((createMatch = fileCreateRegex.exec(responseText)) !== null) {
        const createContent = createMatch[1];
        const pathMatch = createContent.match(/path:\s*(.+)/);
        const contentMatch = createContent.match(/content:\s*\|([\s\S]*)/);

        if (pathMatch && contentMatch && currentDir) {
          const filePath = pathMatch[1].trim();
          const fileContent = contentMatch[1].trim();
          const fullPath = filePath.startsWith("/") ? filePath : `${currentDir}/${filePath}`;
          const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));

          try {
            await invoke("execute_shell_command", {
              command: `mkdir -p "${parentDir}" && cat > "${fullPath}" << 'VELIX_EOF'\n${fileContent}\nVELIX_EOF`,
              cwd: currentDir,
            });
            targetTerminals.forEach((terminal) => {
              terminal.write(`\x1b[32m✓ File created: ${fullPath}\x1b[0m\r\n`);
            });
          } catch (error) {
            console.error("File create error:", error);
            targetTerminals.forEach((terminal) => {
              terminal.write(`\x1b[31m✗ Failed to create: ${fullPath}: ${error}\x1b[0m\r\n`);
            });
          }
        }
      }

      if (currentDir && (fileWriteRegex.lastIndex > 0 || fileCreateRegex.lastIndex > 0)) {
        workspaceService.invalidateCache();
      }

      const displayText = responseText
        .replace(/\[FILE_WRITE_START\][\s\S]*?\[FILE_WRITE_END\]/g, "")
        .replace(/\[FILE_CREATE_START\][\s\S]*?\[FILE_CREATE_END\]/g, "")
        .replace(/^#+\s*/gm, "")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/`(.*?)`/g, "$1")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/^\s*[-*+]\s+/gm, "• ")
        .replace(/^\s*\d+\.\s+/gm, "")
        .trim();

      targetTerminals.forEach((terminal) => {
        terminal.write("\r\x1b[2K\r");
        terminal.write("\x1b[32mAI:\x1b[0m ");
        terminal.write(displayText + "\r\n");
      });
    } catch (error) {
      console.error("AI request failed:", error);
      targetTerminals.forEach((terminal) => {
        terminal.write(`\x1b[31mAI Error: ${error instanceof Error ? error.message : "Unknown error"}\x1b[0m\r\n`);
      });
    } finally {
      setIsAIProcessing(false);
    }
  }, [activeWorkspaceTab, aiConfig, currentDir, getActivePaneRefs, updateWorkspaceTab, workspaceContext]);

  useEffect(() => {
    if (!showVoiceSetup) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (voiceSetupRef.current && !voiceSetupRef.current.contains(e.target as Node)) {
        setShowVoiceSetup(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showVoiceSetup]);

  const loadProjectFiles = useCallback(async (directory: string) => {
    if (!directory || directory === "~") {
      return {
        workspaceContext: null,
        projectFileContents: {} as Record<string, string>,
      };
    }

    try {
      const nextWorkspaceContext = await workspaceService.scan(directory);
      return {
        workspaceContext: nextWorkspaceContext,
        projectFileContents: nextWorkspaceContext.loadedFiles,
      };
    } catch (error) {
      console.error("WorkspaceService scan failed, using fallback:", error);

      try {
        const projectFilesMap = await invoke<Record<string, string>>("read_project_source_files", {
          directory,
        });
        return {
          workspaceContext: null,
          projectFileContents: projectFilesMap || {},
        };
      } catch (fallbackError) {
        console.error("Fallback loading also failed:", fallbackError);
        return {
          workspaceContext: null,
          projectFileContents: {} as Record<string, string>,
        };
      }
    }
  }, []);

  const refreshGitStatus = useCallback(async (tabId: string, directory: string) => {
    if (!directory) {
      updateWorkspaceTab(tabId, (tab) => ({
        ...tab,
        gitChanges: [],
        currentBranch: "",
      }));
      return;
    }

    try {
      const status = await invoke<{ branch?: string; files: Array<{ path: string; status: string }> }>("get_git_status", {
        repoPath: directory,
      });

      const changes = status.files.map((file) => ({
        path: file.path,
        type: file.status.includes("M") ? "M" as const
          : file.status.includes("A") ? "A" as const
          : file.status.includes("D") ? "D" as const
          : "?" as const,
      }));

      updateWorkspaceTab(tabId, (tab) =>
        tab.projectDir !== directory
          ? tab
          : {
              ...tab,
              gitChanges: changes,
              currentBranch: status.branch || "",
            },
      );
    } catch {
      updateWorkspaceTab(tabId, (tab) => ({
        ...tab,
        gitChanges: [],
        currentBranch: "",
      }));
    }
  }, [updateWorkspaceTab]);

  useEffect(() => {
    if (!activeWorkspaceTab || !currentDir || currentDir === "~") return;
    if (activeWorkspaceTab.workspaceContext || Object.keys(activeWorkspaceTab.projectFileContents).length > 0) return;

    let cancelled = false;

    loadProjectFiles(currentDir).then((nextState) => {
      if (cancelled) return;
      updateWorkspaceTab(activeWorkspaceTab.id, (tab) =>
        tab.projectDir !== currentDir
          ? tab
          : {
              ...tab,
              workspaceContext: nextState.workspaceContext,
              projectFileContents: nextState.projectFileContents,
            },
      );
    });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceTab, currentDir, loadProjectFiles, updateWorkspaceTab]);

  useEffect(() => {
    if (!activeWorkspaceTab) return;

    void refreshGitStatus(activeWorkspaceTab.id, currentDir);
    const interval = setInterval(() => {
      void refreshGitStatus(activeWorkspaceTab.id, currentDir);
    }, 5000);

    return () => clearInterval(interval);
  }, [activeWorkspaceTab, currentDir, refreshGitStatus]);

  const handleOpenProject = useCallback(async () => {
    if (!activeWorkspaceTab) return;

    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === "string") {
        try {
          await invoke("set_shell_cwd", { cwd: selected });
        } catch {}

        const nextState = await loadProjectFiles(selected);

        updateWorkspaceTab(activeWorkspaceTab.id, (tab) => ({
          ...tab,
          title: getPathLeaf(selected),
          shellCwd: selected,
          projectDir: selected,
          workspaceContext: nextState.workspaceContext,
          projectFileContents: nextState.projectFileContents,
          gitChanges: [],
          currentBranch: "",
        }));

        await refreshGitStatus(activeWorkspaceTab.id, selected);
      }
    } catch (error) {
      console.error("Failed to open project:", error);
    }
  }, [activeWorkspaceTab, loadProjectFiles, refreshGitStatus, updateWorkspaceTab]);

  const handleAIConfigSave = useCallback(async (config: AIConfig) => {
    setAiConfig(config);
    if (!config.apiKey) return;

    await aiService.setApiKey(config.provider, config.apiKey);
    aiService.setProvider(config.provider, config.model);

    if (config.provider === "chatgpt") {
      setOpenaiApiKey(config.apiKey);
    }
  }, []);

  const runSetupExitSequence = useCallback((onComplete?: () => void) => {
    if (!showSetupScreen || setupScreenPhase !== "idle") return;

    clearSetupTransitionTimers();
    setSetupScreenPhase("closing");

    setupTransitionTimersRef.current = [
      window.setTimeout(() => {
        setSetupScreenPhase("loading");
      }, 280),
      window.setTimeout(() => {
        setSetupScreenPhase("finishing");
      }, 1680),
      window.setTimeout(() => {
        setShowSetupScreen(false);
        setSetupScreenPhase("idle");
        clearSetupTransitionTimers();
        onComplete?.();
      }, 1960),
    ];
  }, [clearSetupTransitionTimers, setupScreenPhase, showSetupScreen]);

  const dismissSetupScreen = useCallback(() => {
    runSetupExitSequence();
  }, [runSetupExitSequence]);

  const openAdvancedSettings = useCallback(() => {
    runSetupExitSequence(() => {
      setShowSettings(true);
    });
  }, [runSetupExitSequence]);

  const refreshWorkspaceAfterBranchChange = useCallback(async () => {
    if (!activeWorkspaceTab || !currentDir) return;
    workspaceService.invalidateCache();
    const nextState = await loadProjectFiles(currentDir);
    updateWorkspaceTab(activeWorkspaceTab.id, (tab) =>
      tab.projectDir !== currentDir
        ? tab
        : {
            ...tab,
            workspaceContext: nextState.workspaceContext,
            projectFileContents: nextState.projectFileContents,
          },
    );
    await refreshGitStatus(activeWorkspaceTab.id, currentDir);
  }, [activeWorkspaceTab, currentDir, loadProjectFiles, refreshGitStatus, updateWorkspaceTab]);

  const togglePanel = (panel: "search" | "git" | "voice" | "swarm" | null) => {
    setShowVoiceSetup(false);

    if (panel === null) {
      setShowSearchPanel(false);
      setShowGitPanel(false);
      setShowVoiceChat(false);
      return;
    }

    if (panel === "swarm") {
      if (!swarmTabOpen) {
        setSwarmTabOpen(true);
        setActiveTerminalId('swarm');
      } else if (activeTerminalId !== 'swarm') {
        setActiveTerminalId('swarm');
      } else {
        closeSwarmTab();
      }
      return;
    }

    setShowSearchPanel(panel === "search" ? !showSearchPanel : false);
    setShowGitPanel(panel === "git" ? !showGitPanel : false);
    setShowVoiceChat(panel === "voice" ? !showVoiceChat : false);
  };

  const canShowVoiceChat = showVoiceChat && !!openaiApiKey;
  const hasRightPanel = showSearchPanel || showGitPanel || canShowVoiceChat;
  const projectName = currentDir ? getPathLeaf(currentDir) : "No project open";
  const activeWorkspaceTitle = activeWorkspaceTab
    ? (activeWorkspaceTab.projectDir ? getPathLeaf(activeWorkspaceTab.projectDir) : activeWorkspaceTab.title)
    : "Terminal";
  const activeTerminalTitle = activeTerminalId === 'swarm'
    ? 'Swarm'
    : activeWorkspaceTitle;
  const getPaneGridStyle = (paneCount: number) => {
    if (paneCount <= 1) return undefined;
    const columns = getPaneGridColumnCount(paneCount);
    const rows = Math.ceil(paneCount / columns);
    return {
      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
      gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
    };
  };

  return (
    <div className={`app ${theme}`}>
      {/* ── Left activity sidebar ── */}
      <div className="activity-bar">
        <div className="activity-top">
          <button
            className={`activity-btn ${!hasRightPanel ? "active" : ""}`}
            title="Terminal"
            onClick={() => togglePanel(null)}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <polyline points="7 9 10 12 7 15" />
              <line x1="13" y1="15" x2="17" y2="15" />
            </svg>
          </button>

          <div className="activity-btn-wrap" ref={voiceSetupRef}>
            <button
              className={`activity-btn ${showVoiceChat ? "active" : ""} ${!openaiApiKey ? "needs-setup" : ""}`}
              onClick={() => {
                if (!openaiApiKey) {
                  setShowVoiceSetup((visible) => !visible);
                  return;
                }
                togglePanel("voice");
              }}
              title={openaiApiKey ? "Voice Chat" : "Voice Chat — setup required"}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
              {!openaiApiKey && <span className="activity-btn-badge" />}
            </button>

            {showVoiceSetup && !openaiApiKey && (
              <div className="voice-setup-popup">
                <div className="voice-setup-header">
                  <div className="voice-setup-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                      <line x1="12" y1="19" x2="12" y2="23" />
                      <line x1="8" y1="23" x2="16" y2="23" />
                    </svg>
                  </div>
                  <span className="voice-setup-title">Voice Chat</span>
                  <button className="voice-setup-close" onClick={() => setShowVoiceSetup(false)}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
                <p className="voice-setup-desc">
                  Voice Chat requires a ChatGPT API key. Configure it in Settings:
                </p>
                <ol className="voice-setup-steps">
                  <li>
                    <span className="voice-setup-step-num">1</span>
                    <span>Open <strong>Settings</strong></span>
                  </li>
                  <li>
                    <span className="voice-setup-step-num">2</span>
                    <span>Add a <strong>ChatGPT</strong> API key</span>
                  </li>
                  <li>
                    <span className="voice-setup-step-num">3</span>
                    <span>Come back here and launch <strong>Voice Chat</strong></span>
                  </li>
                </ol>
                <button
                  className="voice-setup-action-btn"
                  onClick={() => {
                    setShowSettings(true);
                    setShowVoiceSetup(false);
                  }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  Open Settings
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="activity-middle">
          <button
            className={`activity-btn ${showGitPanel ? "active" : ""}`}
            onClick={() => togglePanel("git")}
            title="Git"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          </button>

          <button
            className={`activity-btn ${showSearchPanel ? "active" : ""}`}
            onClick={() => togglePanel("search")}
            title="Search"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>

          <button
            className={`activity-btn ${activeTerminalId === 'swarm' ? "active" : ""}`}
            onClick={() => togglePanel("swarm")}
            disabled={!currentDir}
            title={!currentDir ? "Swarm requires an open project." : "Swarm Mode — coordinator, scout, builders, and reviewer"}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="5" r="2.5" />
              <circle cx="5" cy="19" r="2.5" />
              <circle cx="19" cy="19" r="2.5" />
              <line x1="12" y1="7.5" x2="12" y2="12" />
              <line x1="12" y1="12" x2="5" y2="16.5" />
              <line x1="12" y1="12" x2="19" y2="16.5" />
            </svg>
          </button>
        </div>

        <div className="activity-bottom">
          <button className="activity-btn" onClick={() => setShowSettings(true)} title="Settings">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>

      <main className="main-split">
        <div className="terminal-pane">
          <div className="terminal-area">
            <div className="terminal-topbar">
              <div className="workspace-strip">
                <button
                  className="workspace-open-btn"
                  onClick={handleOpenProject}
                  title={currentDir ? "Change Project Folder" : "Open Project Folder"}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  <span>{currentDir ? "Change Folder" : "Open Folder"}</span>
                </button>

                <div className="workspace-bar">
                  <span className="workspace-label">Workspace</span>
                  <div className="workspace-summary">
                    <span className="workspace-name">{projectName}</span>
                    <span className="workspace-path">
                      {currentDir || "Choose a folder to load search, git, and workspace context."}
                    </span>
                  </div>
                </div>

                {currentBranch && (
                  <div className="workspace-branch-chip" title={`Current branch: ${currentBranch}`}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="6" y1="3" x2="6" y2="15" />
                      <circle cx="18" cy="6" r="3" />
                      <circle cx="6" cy="18" r="3" />
                      <path d="M18 9a9 9 0 0 1-9 9" />
                    </svg>
                    <span>{currentBranch}</span>
                  </div>
                )}
              </div>

              <div className="terminal-tab-row">
                <div className="terminal-tabs">
                  {workspaceTabs.map((tab) => {
                    const tabLabel = tab.projectDir ? getPathLeaf(tab.projectDir) : tab.title;
                    return (
                      <div
                        key={tab.id}
                        className={`terminal-tab ${tab.id === activeTerminalId ? "active" : ""}`}
                        onClick={() => setActiveTerminalId(tab.id)}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="terminal-tab-icon">
                          <polyline points="4 17 10 11 4 5" />
                          <line x1="12" y1="19" x2="20" y2="19" />
                        </svg>
                        <span className="terminal-tab-title">{tabLabel}</span>
                        {workspaceTabs.length > 1 && (
                          <button className="terminal-tab-close" onClick={(e) => closeWorkspaceTab(tab.id, e)}>
                            ×
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {swarmTabOpen && (
                    <div
                      className={`terminal-tab terminal-tab-swarm${activeTerminalId === 'swarm' ? ' active' : ''}`}
                      onClick={() => setActiveTerminalId('swarm')}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="terminal-tab-icon">
                        <circle cx="12" cy="5" r="2.5" />
                        <circle cx="5" cy="19" r="2.5" />
                        <circle cx="19" cy="19" r="2.5" />
                        <line x1="12" y1="7.5" x2="12" y2="12" />
                        <line x1="12" y1="12" x2="5" y2="16.5" />
                        <line x1="12" y1="12" x2="19" y2="16.5" />
                      </svg>
                      <span className="terminal-tab-title">Swarm</span>
                      <button className="terminal-tab-close" onClick={(e) => { e.stopPropagation(); closeSwarmTab(); }}>×</button>
                    </div>
                  )}
                  <button className="terminal-tab-add" onClick={addWorkspaceTab} title="New Tab">
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            <div className="terminal-body">
              {swarmTabOpen && (
                <div
                  className={`terminal-tab-panel terminal-tab-panel-swarm${activeTerminalId === "swarm" ? " active" : ""}`}
                  style={{ display: activeTerminalId === "swarm" ? "flex" : "none" }}
                >
                  <SwarmPanel
                    isOpen={true}
                    onClose={closeSwarmTab}
                    theme={theme}
                    workspacePath={currentDir}
                    hasApiKey={!!aiConfig?.apiKey}
                  />
                </div>
              )}

              {workspaceTabs.map((tab) => (
                (() => {
                  const previewIndex =
                    paneDropPreview?.tabId === tab.id
                      ? Math.max(0, Math.min(paneDropPreview.index, tab.panes.length))
                      : null;
                  const renderedPaneCount = tab.panes.length + (previewIndex !== null ? 1 : 0);
                  const panelStyle =
                    tab.id === activeTerminalId
                      ? getPaneGridStyle(renderedPaneCount)
                      : { display: "none" };
                  const renderItems: Array<
                    | { type: "pane"; pane: TerminalPaneState }
                    | { type: "preview"; key: string }
                  > = tab.panes.map((pane) => ({ type: "pane", pane }));

                  if (previewIndex !== null) {
                    renderItems.splice(previewIndex, 0, {
                      type: "preview",
                      key: `${tab.id}-preview-${previewIndex}`,
                    });
                  }

                  return (
                    <div
                      key={tab.id}
                      className={`terminal-tab-panel${tab.panes.length > 1 ? " split-view" : ""}${tab.id === activeTerminalId ? " active" : ""}`}
                      style={panelStyle}
                      onDragOver={(e) => handlePanePanelDragOver(e, tab)}
                      onDrop={(e) => handlePaneDrop(e, tab)}
                    >
                      {renderItems.map((item) => {
                        if (item.type === "preview") {
                          return (
                            <div
                              key={item.key}
                              className="terminal-pane-drop-preview"
                              aria-hidden="true"
                              onDragOver={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              onDrop={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handlePaneDrop(e, tab);
                              }}
                            />
                          );
                        }

                        const pane = item.pane;
                        const isActivePane = pane.id === tab.activePaneId;

                        return (
                          <div
                            key={pane.id}
                            className={`terminal-tab-content ${isActivePane ? "active" : ""}${draggingPaneId === pane.id ? " dragging" : ""}`}
                            onClick={() => {
                              setActiveTerminalId(tab.id);
                              updateWorkspaceTab(tab.id, (currentTab) => ({
                                ...currentTab,
                                activePaneId: pane.id,
                              }));
                            }}
                            onDragOver={(e) => {
                              e.stopPropagation();
                              handlePaneTargetDragOver(e, tab, pane.id);
                            }}
                            onDrop={(e) => {
                              e.stopPropagation();
                              handlePaneDrop(e, tab);
                            }}
                          >
                            {tab.panes.length > 1 && (
                              <div
                                className="split-terminal-header draggable"
                                draggable
                                onDragStart={(e) => handlePaneDragStart(tab.id, pane.id, e)}
                                onDragEnd={handlePaneDragEnd}
                              >
                                <span className="split-terminal-title">{pane.title}</span>
                                <div className="split-terminal-actions">
                                  <span className="split-terminal-drag">⋮⋮</span>
                                  <button
                                    className="split-terminal-close"
                                    onClick={(e) => closeSplitPane(tab.id, pane.id, e)}
                                  >
                                    ×
                                  </button>
                                </div>
                              </div>
                            )}
                            <TerminalBlock
                              ref={(element) => {
                                if (element) {
                                  terminalRefs.current.set(pane.id, element);
                                } else {
                                  terminalRefs.current.delete(pane.id);
                                }
                              }}
                              cwd={tab.shellCwd || defaultShellCwd}
                              theme={theme}
                              onAIRequest={handleAIRequest}
                              aiEnabled={!!aiConfig?.apiKey}
                              gitChanges={tab.gitChanges}
                              onOpenGitPanel={() => togglePanel("git")}
                              projectDir={tab.projectDir}
                              projectFileContents={tab.projectFileContents}
                              workspaceContext={tab.workspaceContext}
                            />
                          </div>
                        );
                      })}
                    </div>
                  );
                })()
              ))}
            </div>
          </div>
        </div>

        <div className={`right-panel${hasRightPanel ? " open" : ""}`}>
          {showSearchPanel && <SearchPanel currentDir={currentDir} />}
          {showGitPanel && (
            <GitPanel
              currentDir={currentDir}
              onBranchChange={refreshWorkspaceAfterBranchChange}
            />
          )}
          {canShowVoiceChat && (
            <VoiceChat
              apiKey={openaiApiKey}
              onClose={() => setShowVoiceChat(false)}
            />
          )}
        </div>
      </main>

      <div className="status-bar">
        <div className="status-left">
          {currentDir ? (
            <>
              {currentBranch && (
                <>
                  <span className="status-item status-branch">
                    <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="6" y1="3" x2="6" y2="15" />
                      <circle cx="18" cy="6" r="3" />
                      <circle cx="6" cy="18" r="3" />
                      <path d="M18 9a9 9 0 0 1-9 9" />
                    </svg>
                    <span>{currentBranch}</span>
                  </span>
                  <span className="status-sep" />
                </>
              )}
              <span className="status-item">{projectName}</span>
            </>
          ) : (
            <span className="status-item status-muted">No project open</span>
          )}
        </div>

        <div className="status-right">
          <span className="status-item">{activeTerminalTitle}</span>
          <button
            className="status-item status-theme-btn"
            onClick={() => handleThemeChange(theme === "dark" ? "light" : "dark")}
            title="Toggle Theme"
          >
            {theme === "dark" ? "☀" : "◗"}
          </button>
          <span className="status-item status-brand">Velix</span>
        </div>
      </div>

      <Settings
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        onSave={handleAIConfigSave}
        currentConfig={aiConfig}
        theme={theme}
        onThemeChange={handleThemeChange}
      />

      <SetupScreen
        isOpen={showSetupScreen}
        phase={setupScreenPhase}
        theme={theme}
        currentConfig={aiConfig}
        onThemeChange={handleThemeChange}
        onSave={handleAIConfigSave}
        onClose={dismissSetupScreen}
        onOpenAdvancedSettings={openAdvancedSettings}
      />
    </div>
  );
}

export default App;
