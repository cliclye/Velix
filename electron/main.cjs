const { app, BrowserWindow, dialog, ipcMain, net, Notification } = require("electron");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

let nodePty = null;
try {
  nodePty = require("node-pty");
} catch {
  // Optional at startup; we fail with a clear error when PTY commands are used.
}

const SETTINGS_FILENAME = "settings.json";

const WALK_SKIP_NAMES = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "__pycache__",
]);

const PROJECT_SOURCE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "css",
  "html",
  "json",
  "rs",
  "toml",
  "py",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "swift",
  "yaml",
  "yml",
  "sh",
  "sql",
  "md",
]);

const PROJECT_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  ".next",
  ".cache",
  "__pycache__",
  ".claude",
  "coverage",
  ".turbo",
]);

const PROJECT_INDICATORS = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Makefile",
  "CMakeLists.txt",
  ".git",
  "requirements.txt",
];

const READ_PROJECT_MAX_TOTAL_SIZE = 80_000;
const READ_PROJECT_MAX_FILE_SIZE = 10_000;

let mainWindow = null;
let shellCwd = os.homedir();

/** @type {{ api_keys: Record<string, string> }} */
let settingsCache = { api_keys: {} };

/** @type {Map<string, import("node-pty").IPty>} */
const ptySessions = new Map();

const ensureDirectoryExists = (value) => {
  try {
    return fs.existsSync(value) && fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
};

if (!ensureDirectoryExists(shellCwd)) {
  shellCwd = process.cwd();
}

const toPosixPath = (value) => value.split(path.sep).join("/");

const resolveUserPath = (inputPath) => {
  if (!inputPath || inputPath === "~") return os.homedir();
  let resolvedInput = inputPath;
  if (resolvedInput.startsWith("~/")) {
    resolvedInput = path.join(os.homedir(), resolvedInput.slice(2));
  }
  if (!path.isAbsolute(resolvedInput)) {
    return path.resolve(shellCwd, resolvedInput);
  }
  return resolvedInput;
};

const getSettingsPath = () => path.join(app.getPath("userData"), SETTINGS_FILENAME);

const loadSettings = () => {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) {
      settingsCache = { api_keys: {} };
      return;
    }
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.api_keys) {
      settingsCache = { api_keys: { ...parsed.api_keys } };
      return;
    }
    settingsCache = { api_keys: {} };
  } catch {
    settingsCache = { api_keys: {} };
  }
};

const saveSettings = async () => {
  const settingsPath = getSettingsPath();
  await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsPromises.writeFile(settingsPath, JSON.stringify(settingsCache, null, 2), "utf8");
};

const buildShellEnv = () => {
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: process.env.LANG || "en_US.UTF-8",
    HOME: process.env.HOME || os.homedir(),
  };

  const keys = settingsCache.api_keys || {};
  if (keys.claude) env.ANTHROPIC_API_KEY = keys.claude;
  if (keys.chatgpt) env.OPENAI_API_KEY = keys.chatgpt;
  if (keys.gemini) {
    env.GEMINI_API_KEY = keys.gemini;
    env.GOOGLE_API_KEY = keys.gemini;
  }
  if (keys.deepseek) env.DEEPSEEK_API_KEY = keys.deepseek;

  return env;
};

const runProcess = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === "number" ? code : -1,
      });
    });
  });

const runGit = async (args, cwd, allowFailure = false) => {
  try {
    const result = await runProcess("git", args, { cwd });
    if (!allowFailure && result.exitCode !== 0) {
      throw new Error(result.stderr || `git ${args.join(" ")} failed`);
    }
    return result;
  } catch (error) {
    if (allowFailure) {
      return {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      };
    }
    throw error;
  }
};

const emitEvent = (eventName, payload) => {
  const channel = `velix:event:${eventName}`;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
};

const ensureNodePty = () => {
  if (!nodePty) {
    throw new Error(
      'Missing dependency "node-pty". Install it with: npm install node-pty',
    );
  }
};

const requireExistingDirectory = (directoryPath, messagePrefix = "Not a valid directory") => {
  const resolved = resolveUserPath(directoryPath);
  if (!ensureDirectoryExists(resolved)) {
    throw new Error(`${messagePrefix}: ${directoryPath}`);
  }
  return resolved;
};

const parseCdTarget = (arg, currentDir) => {
  if (!arg || arg === "~" || arg === "-") return os.homedir();
  const stripped = arg.trim().replace(/^["']|["']$/g, "");
  if (stripped.startsWith("~/")) {
    return path.join(os.homedir(), stripped.slice(2));
  }
  if (path.isAbsolute(stripped)) return stripped;
  return path.resolve(currentDir, stripped);
};

const parseShellSpec = (rawValue) => {
  const value = String(rawValue || "").trim();
  if (!value) return null;

  const match = value.match(
    /^"([^"]+)"(?:\s+(.*))?$|^'([^']+)'(?:\s+(.*))?$|^(\S+)(?:\s+(.*))?$/,
  );
  if (!match) return null;

  const command = (match[1] || match[3] || match[5] || "").trim();
  const rawArgs = (match[2] || match[4] || match[6] || "").trim();
  if (!command) return null;

  return {
    command,
    args: rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : [],
  };
};

const isExecutableFile = (targetPath) => {
  try {
    fs.accessSync(targetPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveExistingDirectory = (...candidates) => {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (ensureDirectoryExists(candidate)) return candidate;
  }
  throw new Error("Unable to find a valid working directory for terminal session");
};

const buildPtyShellAttempts = () => {
  if (process.platform === "win32") {
    return [
      { command: process.env.COMSPEC || "powershell.exe", args: [] },
      { command: "powershell.exe", args: [] },
      { command: "cmd.exe", args: [] },
    ];
  }

  const attempts = [];
  const seen = new Set();
  const addAttempt = (command, args = []) => {
    const normalizedCommand = String(command || "").trim();
    if (!normalizedCommand) return;

    if (path.isAbsolute(normalizedCommand) && !isExecutableFile(normalizedCommand)) {
      return;
    }

    const normalizedArgs = Array.isArray(args)
      ? args.map((arg) => String(arg).trim()).filter(Boolean)
      : [];
    const key = `${normalizedCommand}\u0000${normalizedArgs.join("\u0000")}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({ command: normalizedCommand, args: normalizedArgs });
  };

  const envShell = parseShellSpec(process.env.SHELL);
  if (envShell) {
    // Try exactly what SHELL specifies first.
    addAttempt(envShell.command, envShell.args);
    if (envShell.args.length === 0) {
      addAttempt(envShell.command, ["-l"]);
    }
    addAttempt(envShell.command, []);
  }

  addAttempt("/bin/zsh", ["-l"]);
  addAttempt("/bin/zsh", []);
  addAttempt("/bin/bash", ["-l"]);
  addAttempt("/bin/bash", []);
  addAttempt("/bin/sh", []);

  return attempts;
};

const getShellForNonPtyCommands = () => {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }

  const envShell = parseShellSpec(process.env.SHELL);
  if (envShell?.command) {
    if (!path.isAbsolute(envShell.command) || isExecutableFile(envShell.command)) {
      return envShell.command;
    }
  }

  for (const candidate of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (isExecutableFile(candidate)) return candidate;
  }

  return "/bin/sh";
};

const ptyCreate = async ({ sessionId, rows, cols, cwd }) => {
  ensureNodePty();
  if (!sessionId) throw new Error("sessionId is required");

  if (ptySessions.has(sessionId)) {
    try {
      ptySessions.get(sessionId).kill();
    } catch {
      // ignore stale sessions
    }
    ptySessions.delete(sessionId);
  }

  const workingDir = cwd ? resolveUserPath(cwd) : shellCwd;
  const spawnCwd = resolveExistingDirectory(workingDir, shellCwd, os.homedir(), process.cwd());
  const env = buildShellEnv();

  const shellAttempts = buildPtyShellAttempts();
  let ptyProcess = null;
  let lastError = null;

  for (const attempt of shellAttempts) {
    try {
      ptyProcess = nodePty.spawn(attempt.command, attempt.args, {
        name: "xterm-256color",
        cols: Number(cols) || 80,
        rows: Number(rows) || 24,
        cwd: spawnCwd,
        env,
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!ptyProcess) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Unable to start terminal shell (${reason}). Check your SHELL environment variable.`,
    );
  }

  ptyProcess.onData((data) => {
    emitEvent("pty-output", {
      session_id: sessionId,
      data: String(data),
    });
  });

  ptyProcess.onExit((event) => {
    emitEvent("pty-exit", {
      session_id: sessionId,
      exit_code: typeof event.exitCode === "number" ? event.exitCode : null,
    });
    ptySessions.delete(sessionId);
  });

  ptySessions.set(sessionId, ptyProcess);
};

const ptyWrite = async ({ sessionId, data }) => {
  const session = ptySessions.get(sessionId);
  if (!session) throw new Error(`PTY session not found: ${sessionId}`);
  session.write(String(data ?? ""));
};

const ptyResize = async ({ sessionId, rows, cols }) => {
  const session = ptySessions.get(sessionId);
  if (!session) throw new Error(`PTY session not found: ${sessionId}`);
  session.resize(Number(cols) || 80, Number(rows) || 24);
};

const ptyKill = async ({ sessionId }) => {
  const session = ptySessions.get(sessionId);
  if (!session) throw new Error(`PTY session not found: ${sessionId}`);
  try {
    session.kill();
  } finally {
    ptySessions.delete(sessionId);
  }
};

const executeShellCommand = async ({ command, cwd }) => {
  const workingDir = cwd && String(cwd).length > 0 ? resolveUserPath(cwd) : shellCwd;
  if (!ensureDirectoryExists(workingDir)) {
    throw new Error(`Directory does not exist: ${workingDir}`);
  }

  const trimmed = String(command || "").trim();
  if (trimmed === "cd" || trimmed.startsWith("cd ")) {
    const targetArg = trimmed === "cd" ? "~" : trimmed.slice(3).trim();
    const targetPath = parseCdTarget(targetArg, workingDir);
    let resolved;
    try {
      resolved = fs.realpathSync(targetPath);
    } catch (error) {
      return {
        stdout: "",
        stderr: `cd: ${targetPath}: ${error instanceof Error ? error.message : String(error)}`,
        exit_code: 1,
        cwd: workingDir,
      };
    }

    if (!ensureDirectoryExists(resolved)) {
      return {
        stdout: "",
        stderr: `cd: not a directory: ${resolved}`,
        exit_code: 1,
        cwd: workingDir,
      };
    }

    shellCwd = resolved;
    return {
      stdout: "",
      stderr: "",
      exit_code: 0,
      cwd: resolved,
    };
  }

  const shell = getShellForNonPtyCommands();
  const shellArgs =
    process.platform === "win32"
      ? ["-NoProfile", "-Command", String(command || "")]
      : ["-c", String(command || "")];

  const result = await runProcess(shell, shellArgs, {
    cwd: workingDir,
    env: buildShellEnv(),
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exitCode,
    cwd: workingDir,
  };
};

const readProjectSourceFiles = async ({ directory }) => {
  const projectDir = requireExistingDirectory(directory);

  const isProject = PROJECT_INDICATORS.some((item) =>
    fs.existsSync(path.join(projectDir, item)),
  );
  if (!isProject) {
    throw new Error(
      "Directory does not appear to be a project (no package.json, Cargo.toml, etc.)",
    );
  }

  const contents = {};
  let totalSize = 0;

  const walk = async (currentDir) => {
    if (totalSize >= READ_PROJECT_MAX_TOTAL_SIZE) return;
    const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (totalSize >= READ_PROJECT_MAX_TOTAL_SIZE) break;

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (PROJECT_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (!PROJECT_SOURCE_EXTENSIONS.has(ext)) continue;

      try {
        const raw = await fsPromises.readFile(fullPath, "utf8");
        if (raw.length > READ_PROJECT_MAX_FILE_SIZE) continue;
        totalSize += raw.length;
        const relativePath = toPosixPath(path.relative(projectDir, fullPath));
        contents[relativePath] = raw;
      } catch {
        // Skip unreadable files.
      }
    }
  };

  await walk(projectDir);
  return contents;
};

const getAllFiles = async ({ directory }) => {
  const basePath = requireExistingDirectory(directory);
  const files = [];

  const walk = async (currentDir) => {
    const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || WALK_SKIP_NAMES.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(toPosixPath(path.relative(basePath, fullPath)));
      }
    }
  };

  await walk(basePath);
  return files;
};

const searchInFiles = async ({ directory, pattern, caseSensitive, maxResults }) => {
  const basePath = requireExistingDirectory(directory);
  const matches = [];
  const target = String(pattern ?? "");
  const targetForComparison = caseSensitive ? target : target.toLowerCase();
  const max = Number(maxResults) || 500;

  const walk = async (currentDir) => {
    if (matches.length >= max) return;
    const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (matches.length >= max) break;
      if (entry.name.startsWith(".") || WALK_SKIP_NAMES.has(entry.name)) continue;

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const content = await fsPromises.readFile(fullPath, "utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && matches.length < max; i += 1) {
          const line = lines[i];
          const haystack = caseSensitive ? line : line.toLowerCase();
          const idx = haystack.indexOf(targetForComparison);
          if (idx >= 0) {
            matches.push({
              file: toPosixPath(path.relative(basePath, fullPath)),
              line: i + 1,
              column: idx + 1,
              text: line,
            });
          }
        }
      } catch {
        // Skip unreadable/binary files.
      }
    }
  };

  await walk(basePath);
  return matches;
};

const getGitStatus = async ({ repoPath }) => {
  const repoDir = requireExistingDirectory(repoPath);

  const branchResult = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoDir, true);
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : "unknown";

  const aheadBehind = await runGit(
    ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
    repoDir,
    true,
  );
  let ahead = 0;
  let behind = 0;
  if (aheadBehind.exitCode === 0) {
    const parts = aheadBehind.stdout.trim().split(/\s+/);
    ahead = Number(parts[0] || 0);
    behind = Number(parts[1] || 0);
  }

  const statusResult = await runGit(["status", "--porcelain=v1"], repoDir, true);
  const files = [];

  if (statusResult.exitCode === 0) {
    for (const line of statusResult.stdout.split("\n")) {
      if (line.length < 4) continue;
      const indexStatus = line[0] || " ";
      const worktreeStatus = line[1] || " ";
      const filePath = line.slice(3);

      let status = "unknown";
      let staged = false;
      if (indexStatus === "M" && worktreeStatus === " ") {
        status = "modified";
        staged = true;
      } else if (
        (indexStatus === "M" && worktreeStatus === "M") ||
        (indexStatus === " " && worktreeStatus === "M")
      ) {
        status = "modified";
      } else if (indexStatus === "A" && worktreeStatus === " ") {
        status = "added";
        staged = true;
      } else if (indexStatus === "A" && worktreeStatus === "M") {
        status = "added";
      } else if (indexStatus === "D" && worktreeStatus === " ") {
        status = "deleted";
        staged = true;
      } else if (indexStatus === " " && worktreeStatus === "D") {
        status = "deleted";
      } else if (indexStatus === "R" && worktreeStatus === " ") {
        status = "renamed";
        staged = true;
      } else if (indexStatus === "?" && worktreeStatus === "?") {
        status = "untracked";
      }

      files.push({
        path: filePath,
        status,
        staged,
      });
    }
  }

  return { branch, files, ahead, behind };
};

const getGitDiff = async ({ repoPath, filePath, staged }) => {
  const repoDir = requireExistingDirectory(repoPath);
  const args = ["diff"];
  if (staged) args.push("--cached");
  args.push(filePath);

  const result = await runGit(args, repoDir, true);
  if (result.exitCode === 0) return result.stdout;
  throw new Error(result.stderr || "Failed to get git diff");
};

const getGitHistory = async ({ filePath }) => {
  const absolutePath = resolveUserPath(filePath);
  const parent = ensureDirectoryExists(absolutePath)
    ? absolutePath
    : path.dirname(absolutePath);
  const fileName = path.basename(absolutePath);

  const result = await runGit(
    ["log", "--pretty=format:%h|%s|%an|%ad", "--date=short", "-n", "50", "--", fileName],
    parent,
    true,
  );
  if (result.exitCode !== 0) return [];

  const commits = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("|");
    if (parts.length >= 4) {
      commits.push({
        hash: parts[0],
        message: parts[1],
        author: parts[2],
        date: parts[3],
      });
    }
  }
  return commits;
};

const getFileEvolution = async ({ filePath }) => {
  const absolutePath = resolveUserPath(filePath);
  const parent = ensureDirectoryExists(absolutePath)
    ? absolutePath
    : path.dirname(absolutePath);
  const fileName = path.basename(absolutePath);

  const countResult = await runGit(
    ["rev-list", "--count", "HEAD", "--", fileName],
    parent,
    true,
  );
  const totalFileCommits = Number(countResult.stdout.trim() || 0);

  const authorsResult = await runGit(["shortlog", "-sn", "--", fileName], parent, true);
  const authors = [];
  for (const line of authorsResult.stdout.split("\n").slice(0, 5)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const count = Number(parts[0] || 0);
    if (!count) continue;
    authors.push({
      name: parts.slice(1).join(" "),
      commits: count,
    });
  }

  const timeline = await getGitHistory({ filePath: absolutePath });

  const statsResult = await runGit(
    ["log", "--numstat", "--pretty=format:", "--", fileName],
    parent,
    true,
  );
  let linesAddedTotal = 0;
  let linesRemovedTotal = 0;
  for (const line of statsResult.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    linesAddedTotal += Number(parts[0]) || 0;
    linesRemovedTotal += Number(parts[1]) || 0;
  }

  return {
    totalFileCommits,
    authors,
    timeline,
    linesAddedTotal,
    linesRemovedTotal,
  };
};

const findRepoRoot = async ({ filePath }) => {
  const absolutePath = resolveUserPath(filePath);
  const parent = ensureDirectoryExists(absolutePath)
    ? absolutePath
    : path.dirname(absolutePath);
  const result = await runGit(["rev-parse", "--show-toplevel"], parent, true);
  if (result.exitCode === 0) return result.stdout.trim();
  throw new Error("Not a git repository");
};

const getGitRemoteInfo = async ({ repoPath }) => {
  const repoDir = requireExistingDirectory(repoPath);

  const urlResult = await runGit(["remote", "get-url", "origin"], repoDir, true);
  const remoteUrl = urlResult.exitCode === 0 ? urlResult.stdout.trim() : null;

  let githubRepo = null;
  let githubUrl = null;
  if (remoteUrl && remoteUrl.includes("github.com")) {
    const clean = remoteUrl.replace(/\.git$/, "");
    const idx = clean.indexOf("github.com");
    if (idx >= 0) {
      const repoPart = clean.slice(idx + "github.com".length).replace(/^[:/]+/, "");
      githubRepo = repoPart || null;
      githubUrl = repoPart ? `https://github.com/${repoPart}` : null;
    }
  }

  const contribResult = await runGit(["shortlog", "-sne", "--all"], repoDir, true);
  const contributors = [];
  for (const line of contribResult.stdout.split("\n").slice(0, 10)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const countMatch = trimmed.match(/^(\d+)\s+/);
    if (!countMatch) continue;
    const commits = Number(countMatch[1]);
    const rest = trimmed.slice(countMatch[0].length);
    const emailStart = rest.lastIndexOf("<");
    const emailEnd = rest.lastIndexOf(">");
    if (emailStart < 0 || emailEnd < 0 || emailEnd <= emailStart) continue;
    contributors.push({
      name: rest.slice(0, emailStart).trim(),
      email: rest.slice(emailStart + 1, emailEnd),
      commits,
    });
  }

  const countResult = await runGit(["rev-list", "--count", "--all"], repoDir, true);
  const totalCommits = Number(countResult.stdout.trim() || 0);

  const firstCommitResult = await runGit(
    ["log", "--reverse", "--format=%ad", "--date=short", "-n", "1"],
    repoDir,
    true,
  );
  const firstCommitDate =
    firstCommitResult.exitCode === 0 ? firstCommitResult.stdout.trim() || null : null;

  return {
    remoteUrl,
    githubRepo,
    githubUrl,
    contributors,
    totalCommits,
    firstCommitDate,
    branches: [],
  };
};

const aiChat = async ({ provider, model, apiKey, messages, system, maxTokens }) => {
  const max = Number(maxTokens) || 4096;

  // Anthropic / Claude
  if (provider === "claude") {
    const body = { model, max_tokens: max, messages };
    if (system) body.system = system;
    const res = await net.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": String(apiKey),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic API error (${res.status}): ${text}`);
    }
    const data = await res.json();
    return data.content?.[0]?.text ?? "";
  }

  // Google Gemini
  if (provider === "gemini") {
    const geminiMessages = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const body = { contents: geminiMessages };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const res = await net.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Google API error (${res.status}): ${text}`);
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }

  // OpenAI-compatible providers
  const openaiBaseUrls = {
    chatgpt: "https://api.openai.com/v1",
    deepseek: "https://api.deepseek.com/v1",
    groq: "https://api.groq.com/openai/v1",
    mistral: "https://api.mistral.ai/v1",
    minimax: "https://api.minimax.chat/v1",
    kimi: "https://api.moonshot.cn/v1",
    glm4: "https://open.bigmodel.cn/api/paas/v4",
  };

  const baseUrl = openaiBaseUrls[String(provider)];
  if (!baseUrl) throw new Error(`Unsupported AI provider: ${provider}`);

  const chatMessages = system
    ? [{ role: "system", content: system }, ...messages]
    : [...messages];

  const res = await net.fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages: chatMessages, max_tokens: max }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${provider} API error (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
};

const openDirectoryDialog = async () => {
  const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const result = await dialog.showOpenDialog(owner, {
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
};

const isNotificationPermissionGranted = async () => true;
const requestNotificationPermission = async () => "granted";

const sendDesktopNotification = async ({ title, body }) => {
  if (!Notification.isSupported()) return;
  new Notification({
    title: String(title || "Velix"),
    body: String(body || ""),
  }).show();
};

const handleInvoke = async (command, args = {}) => {
  switch (command) {
    case "pty_create":
      return ptyCreate({
        sessionId: args.sessionId ?? args.session_id,
        rows: args.rows,
        cols: args.cols,
        cwd: args.cwd,
      });
    case "pty_write":
      return ptyWrite({
        sessionId: args.sessionId ?? args.session_id,
        data: args.data,
      });
    case "pty_resize":
      return ptyResize({
        sessionId: args.sessionId ?? args.session_id,
        rows: args.rows,
        cols: args.cols,
      });
    case "pty_kill":
      return ptyKill({
        sessionId: args.sessionId ?? args.session_id,
      });
    case "execute_shell_command":
      return executeShellCommand({
        command: args.command,
        cwd: args.cwd,
      });
    case "get_shell_cwd":
      return shellCwd;
    case "set_shell_cwd": {
      const nextCwd = requireExistingDirectory(args.cwd);
      shellCwd = nextCwd;
      return;
    }
    case "read_project_source_files":
      return readProjectSourceFiles({ directory: args.directory });
    case "save_api_key":
      if (!args.provider) throw new Error("provider is required");
      settingsCache.api_keys[String(args.provider)] = String(args.key || "");
      await saveSettings();
      return;
    case "get_api_key": {
      const key = settingsCache.api_keys[String(args.provider || "")];
      if (!key) {
        throw new Error(`No API key found for provider: ${args.provider}`);
      }
      return key;
    }
    case "get_git_history":
      return getGitHistory({ filePath: args.filePath ?? args.file_path });
    case "get_file_evolution":
      return getFileEvolution({ filePath: args.filePath ?? args.file_path });
    case "find_repo_root":
      return findRepoRoot({ filePath: args.filePath ?? args.file_path });
    case "get_git_remote_info":
      return getGitRemoteInfo({ repoPath: args.repoPath ?? args.repo_path });
    case "get_all_files":
      return getAllFiles({ directory: args.directory });
    case "search_in_files":
      return searchInFiles({
        directory: args.directory,
        pattern: args.pattern,
        caseSensitive: Boolean(args.caseSensitive ?? args.case_sensitive ?? false),
        maxResults: Number(args.maxResults ?? args.max_results ?? 500),
      });
    case "get_git_status":
      return getGitStatus({ repoPath: args.repoPath ?? args.repo_path });
    case "get_git_diff":
      return getGitDiff({
        repoPath: args.repoPath ?? args.repo_path,
        filePath: args.filePath ?? args.file_path,
        staged: Boolean(args.staged),
      });
    case "ai_chat":
      return aiChat({
        provider: args.provider,
        model: args.model,
        apiKey: args.apiKey,
        messages: args.messages,
        system: args.system,
        maxTokens: args.maxTokens,
      });
    default:
      throw new Error(`Unknown invoke command: ${command}`);
  }
};

const loadUrlWithRetry = async (windowRef, url) => {
  let lastError = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await windowRef.loadURL(url);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError || new Error(`Failed to load ${url}`);
};

const createWindow = async () => {
  const windowRef = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow = windowRef;

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await loadUrlWithRetry(windowRef, devUrl);
  } else {
    await windowRef.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
};

const cleanup = async () => {
  for (const [sessionId, session] of ptySessions.entries()) {
    try {
      session.kill();
    } catch {
      // ignore cleanup errors
    }
    ptySessions.delete(sessionId);
  }
};

app.whenReady().then(async () => {
  loadSettings();
  await createWindow();

  ipcMain.handle("velix:invoke", async (_event, payload) => {
    const command = payload?.command;
    const args = payload?.args || {};
    return handleInvoke(command, args);
  });

  ipcMain.handle("velix:fs:readDir", async (_event, payload) => {
    const target = resolveUserPath(payload.path);
    const entries = await fsPromises.readdir(target, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymlink: entry.isSymbolicLink(),
    }));
  });

  ipcMain.handle("velix:fs:readTextFile", async (_event, payload) => {
    const target = resolveUserPath(payload.path);
    return fsPromises.readFile(target, "utf8");
  });

  ipcMain.handle("velix:fs:writeTextFile", async (_event, payload) => {
    const target = resolveUserPath(payload.path);
    await fsPromises.mkdir(path.dirname(target), { recursive: true });
    await fsPromises.writeFile(target, String(payload.contents ?? ""), "utf8");
  });

  ipcMain.handle("velix:fs:remove", async (_event, payload) => {
    const target = resolveUserPath(payload.path);
    await fsPromises.rm(target, { recursive: true, force: true });
  });

  ipcMain.handle("velix:dialog:openDirectory", async () => openDirectoryDialog());
  ipcMain.handle("velix:notify:isPermissionGranted", async () =>
    isNotificationPermissionGranted(),
  );
  ipcMain.handle("velix:notify:requestPermission", async () =>
    requestNotificationPermission(),
  );
  ipcMain.handle("velix:notify:send", async (_event, payload) =>
    sendDesktopNotification(payload),
  );

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  await cleanup();
});
