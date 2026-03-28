use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write as IoWrite};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

/// Cached list of directories to search for CLI binaries.
/// Built once by spawning login shells; subsequent calls read from here.
static SEARCH_DIRS_CACHE: OnceLock<Vec<String>> = OnceLock::new();

/// Per-binary result cache: command name → absolute path.
static CLI_PATH_CACHE: OnceLock<Mutex<HashMap<String, Result<String, ()>>>> = OnceLock::new();

fn cli_path_cache() -> &'static Mutex<HashMap<String, Result<String, ()>>> {
    CLI_PATH_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Build (and cache) the ordered list of directories to scan for binaries.
fn get_search_dirs() -> Vec<String> {
    SEARCH_DIRS_CACHE
        .get_or_init(|| {
            let home = dirs_or_home();
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

            let login_path = Command::new(&shell)
                .args(["-l", "-c", "echo $PATH"])
                .env("HOME", &home)
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            let interactive_path = Command::new(&shell)
                .args(["-i", "-l", "-c", "echo $PATH"])
                .env("HOME", &home)
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            let mut dirs: Vec<String> = Vec::new();
            for raw in [login_path, interactive_path].into_iter().flatten() {
                for dir in raw.split(':') {
                    let d = dir.trim().to_string();
                    if !d.is_empty() && !dirs.contains(&d) {
                        dirs.push(d);
                    }
                }
            }

            let extra_dirs = vec![
                "/opt/homebrew/bin".to_string(),
                "/usr/local/bin".to_string(),
                "/usr/bin".to_string(),
                format!("{}/.npm-global/bin", home),
                format!("{}/.yarn/bin", home),
                format!("{}/.cargo/bin", home),
                format!("{}/.bun/bin", home),
            ];
            for d in extra_dirs {
                if !dirs.contains(&d) {
                    dirs.push(d);
                }
            }

            let nvm_versions_dir = format!("{}/.nvm/versions/node", home);
            if let Ok(entries) = std::fs::read_dir(&nvm_versions_dir) {
                let mut versions: Vec<String> = entries
                    .flatten()
                    .filter(|e| e.path().is_dir())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect();
                versions.sort_by(|a, b| {
                    let parse = |s: &str| -> Vec<u64> {
                        s.trim_start_matches('v')
                            .split('.')
                            .filter_map(|p| p.parse().ok())
                            .collect()
                    };
                    parse(b).cmp(&parse(a))
                });
                for version in &versions {
                    let bin = format!("{}/{}/bin", nvm_versions_dir, version);
                    if !dirs.contains(&bin) {
                        dirs.push(bin);
                    }
                }
            }

            dirs
        })
        .clone()
}

const SETTINGS_FILENAME: &str = "settings.json";

#[derive(Serialize, serde::Deserialize, Default)]
struct AppSettings {
    api_keys: HashMap<String, String>,
}

// PTY session management
struct PtySession {
    pair: PtyPair,
    writer: Box<dyn IoWrite + Send>,
}

// Simple in-memory storage for API keys and shell state
struct AppState {
    settings: Mutex<AppSettings>,
    shell_cwd: Mutex<String>,
    pty_sessions: Mutex<HashMap<String, Arc<Mutex<PtySession>>>>,
    app_dir: Mutex<Option<PathBuf>>,
    /// Handle to the Velix AI engine child process
    velix_engine_process: Mutex<Option<Child>>,
}

impl AppState {
    fn new(app: &AppHandle) -> Self {
        let app_dir = app.path().app_config_dir().ok();
        let mut settings = AppSettings::default();

        if let Some(dir) = &app_dir {
            if let Ok(_) = fs::create_dir_all(dir) {
                let settings_path = dir.join(SETTINGS_FILENAME);
                if settings_path.exists() {
                    if let Ok(content) = fs::read_to_string(&settings_path) {
                        if let Ok(loaded) = serde_json::from_str(&content) {
                            settings = loaded;
                        }
                    }
                }
            }
        }

        Self {
            settings: Mutex::new(settings),
            shell_cwd: Mutex::new(dirs_or_home()),
            pty_sessions: Mutex::new(HashMap::new()),
            app_dir: Mutex::new(app_dir),
            velix_engine_process: Mutex::new(None),
        }
    }

    fn save_settings(&self) -> Result<(), String> {
        let settings = self.settings.lock().map_err(|e| e.to_string())?;
        let app_dir = self.app_dir.lock().map_err(|e| e.to_string())?;

        if let Some(dir) = &*app_dir {
            let settings_path = dir.join(SETTINGS_FILENAME);
            let content = serde_json::to_string_pretty(&*settings).map_err(|e| e.to_string())?;
            fs::write(settings_path, content).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommit {
    hash: String,
    message: String,
    author: String,
    date: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorStats {
    name: String,
    commits: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEvolution {
    total_file_commits: usize,
    authors: Vec<AuthorStats>,
    timeline: Vec<GitCommit>,
    lines_added_total: usize,
    lines_removed_total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContributorStats {
    name: String,
    email: String,
    commits: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitRemoteInfo {
    remote_url: Option<String>,
    github_repo: Option<String>,
    github_url: Option<String>,
    contributors: Vec<ContributorStats>,
    total_commits: usize,
    first_commit_date: Option<String>,
    branches: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    cwd: String,
}

#[derive(Clone, Serialize)]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct TerminalExit {
    session_id: String,
    exit_code: Option<i32>,
}

// ==================== PTY Terminal Commands ====================

#[tauri::command]
fn pty_create(
    session_id: String,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let pty_system = native_pty_system();

    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Get the shell path - use user's default shell or fallback to zsh
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    // Get the full PATH from the user's login shell so tools installed via
    // nvm, homebrew, cargo, etc. are available in the PTY terminal.
    let full_path = std::process::Command::new(&shell)
        .args(["-l", "-c", "echo $PATH"])
        .env("HOME", dirs_or_home())
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());

    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l"); // Login shell to load user's profile

    // Set working directory (frontend may pass "~" until the project path is applied)
    let working_dir = resolve_pty_cwd(cwd);
    cmd.cwd(&working_dir);

    cmd.env("PATH", &full_path);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("HOME", dirs_or_home());

    // Inject API keys from settings into the PTY environment
    if let Ok(settings) = state.settings.lock() {
        if let Some(claude_key) = settings.api_keys.get("claude") {
            cmd.env("ANTHROPIC_API_KEY", claude_key);
        }
        if let Some(openai_key) = settings.api_keys.get("chatgpt") {
            cmd.env("OPENAI_API_KEY", openai_key);
        }
        if let Some(gemini_key) = settings.api_keys.get("gemini") {
            cmd.env("GEMINI_API_KEY", gemini_key);
            cmd.env("GOOGLE_API_KEY", gemini_key);
        }
        if let Some(deepseek_key) = settings.api_keys.get("deepseek") {
            cmd.env("DEEPSEEK_API_KEY", deepseek_key);
        }
    }

    // Spawn the shell in the PTY
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    // Get reader for output
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {}", e))?;

    // Get writer for input
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take writer: {}", e))?;

    // Store the session
    let session = Arc::new(Mutex::new(PtySession { pair, writer }));

    {
        let mut sessions = state.pty_sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(session_id.clone(), session);
    }

    // Spawn thread to read output and emit events
    let app_handle = app.clone();
    let sid = session_id.clone();
    thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    // EOF - process exited
                    break;
                }
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let _ = app_handle.emit(
                        "pty-output",
                        TerminalOutput {
                            session_id: sid.clone(),
                            data,
                        },
                    );
                }
                Err(e) => {
                    eprintln!("PTY read error: {}", e);
                    break;
                }
            }
        }

        // Wait for child to exit and get exit code
        let exit_code = child
            .wait()
            .ok()
            .and_then(|s| if s.success() { Some(0) } else { Some(1) });

        let _ = app_handle.emit(
            "pty-exit",
            TerminalExit {
                session_id: sid,
                exit_code,
            },
        );
    });

    Ok(())
}

#[tauri::command]
fn pty_write(session_id: String, data: String, state: State<'_, AppState>) -> Result<(), String> {
    let sessions = state.pty_sessions.lock().map_err(|e| e.to_string())?;

    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("PTY session not found: {}", session_id))?;

    let mut session_guard = session.lock().map_err(|e| e.to_string())?;
    session_guard
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to PTY: {}", e))?;
    session_guard
        .writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY: {}", e))?;

    Ok(())
}

#[tauri::command]
fn pty_resize(
    session_id: String,
    rows: u16,
    cols: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sessions = state.pty_sessions.lock().map_err(|e| e.to_string())?;

    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("PTY session not found: {}", session_id))?;

    let session_guard = session.lock().map_err(|e| e.to_string())?;
    session_guard
        .pair
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {}", e))?;

    Ok(())
}

#[tauri::command]
fn pty_kill(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut sessions = state.pty_sessions.lock().map_err(|e| e.to_string())?;

    if sessions.remove(&session_id).is_some() {
        Ok(())
    } else {
        Err(format!("PTY session not found: {}", session_id))
    }
}

// ==================== Legacy Shell Commands (for compatibility) ====================

#[tauri::command]
fn execute_shell_command(
    command: &str,
    cwd: Option<&str>,
    state: State<'_, AppState>,
) -> Result<ShellResult, String> {
    // Determine working directory
    let working_dir = if let Some(dir) = cwd {
        if !dir.is_empty() {
            dir.to_string()
        } else {
            state.shell_cwd.lock().map_err(|e| e.to_string())?.clone()
        }
    } else {
        state.shell_cwd.lock().map_err(|e| e.to_string())?.clone()
    };

    let working_path = Path::new(&working_dir);
    if !working_path.exists() {
        return Err(format!("Directory does not exist: {}", working_dir));
    }

    // Handle `cd` specially: update the tracked cwd
    let trimmed = command.trim();
    if trimmed == "cd" || trimmed.starts_with("cd ") {
        let target = if trimmed == "cd" {
            dirs_or_home()
        } else {
            let arg = trimmed[3..].trim();
            let arg = arg.trim_matches('"').trim_matches('\'');
            if arg == "~" {
                dirs_or_home()
            } else if arg == "-" {
                // Just go to home for simplicity
                dirs_or_home()
            } else if arg.starts_with('/') {
                arg.to_string()
            } else if arg.starts_with("~/") {
                let home = dirs_or_home();
                format!("{}/{}", home, &arg[2..])
            } else {
                format!("{}/{}", working_dir, arg)
            }
        };

        // Canonicalize the path
        let resolved = match std::fs::canonicalize(&target) {
            Ok(p) => p.to_string_lossy().to_string(),
            Err(e) => {
                return Ok(ShellResult {
                    stdout: String::new(),
                    stderr: format!("cd: {}: {}", target, e),
                    exit_code: 1,
                    cwd: working_dir,
                });
            }
        };

        if !Path::new(&resolved).is_dir() {
            return Ok(ShellResult {
                stdout: String::new(),
                stderr: format!("cd: not a directory: {}", resolved),
                exit_code: 1,
                cwd: working_dir,
            });
        }

        *state.shell_cwd.lock().map_err(|e| e.to_string())? = resolved.clone();
        return Ok(ShellResult {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 0,
            cwd: resolved,
        });
    }

    // Resolve the full PATH from the user's login shell so tools installed via
    // nvm, homebrew, etc. are visible — matches how pty_create sets up workers.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let full_path = Command::new(&shell)
        .args(["-l", "-c", "echo $PATH"])
        .env("HOME", dirs_or_home())
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());

    // Execute via the user's shell
    let output = Command::new(&shell)
        .args(&["-c", command])
        .current_dir(&working_dir)
        .env("HOME", dirs_or_home())
        .env("TERM", "xterm-256color")
        .env("LANG", "en_US.UTF-8")
        .env("PATH", &full_path)
        .output()
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    let exit_code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(ShellResult {
        stdout,
        stderr,
        exit_code,
        cwd: working_dir,
    })
}

/// Locate a CLI binary using the user's full login-shell PATH, then fall back
/// to well-known installation directories (nvm, homebrew, npm-global, cargo).
/// Results are cached so repeated calls (e.g. reopening the Swarm panel) are instant.
#[tauri::command]
fn check_cli_available(command: String) -> Result<String, String> {
    // Fast path: return cached result if available.
    if let Ok(cache) = cli_path_cache().lock() {
        if let Some(cached) = cache.get(&command) {
            return cached
                .clone()
                .map_err(|_| format!("{} not found in login-shell PATH or common install locations", command));
        }
    }

    // Slow path (first call only): get ordered search dirs, then scan.
    let dirs = get_search_dirs();
    let mut found: Option<String> = None;

    'outer: for dir in &dirs {
        let candidate = Path::new(dir).join(&command);
        if candidate.is_file() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&candidate) {
                    if meta.permissions().mode() & 0o111 != 0 {
                        found = Some(candidate.to_string_lossy().to_string());
                        break 'outer;
                    }
                }
            }
            #[cfg(not(unix))]
            {
                found = Some(candidate.to_string_lossy().to_string());
                break 'outer;
            }
        }
    }

    // Store result in cache (both hits and misses).
    if let Ok(mut cache) = cli_path_cache().lock() {
        cache.insert(command.clone(), found.clone().ok_or(()));
    }

    found.ok_or_else(|| format!("{} not found in login-shell PATH or common install locations", command))
}

#[tauri::command]
fn get_shell_cwd(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.shell_cwd.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
fn set_shell_cwd(cwd: &str, state: State<'_, AppState>) -> Result<(), String> {
    let path = Path::new(cwd);
    if !path.exists() || !path.is_dir() {
        return Err(format!("Not a valid directory: {}", cwd));
    }
    *state.shell_cwd.lock().map_err(|e| e.to_string())? = cwd.to_string();
    Ok(())
}

fn dirs_or_home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}

/// Expand `~` / `~/...` for PTY cwd; the shell API may send `"~"` before the real path is known.
fn resolve_pty_cwd(cwd: Option<String>) -> String {
    let home = dirs_or_home();
    let raw = cwd.unwrap_or_else(|| home.clone());
    if raw == "~" {
        return home;
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        let h = home.trim_end_matches('/');
        if rest.is_empty() {
            return h.to_string();
        }
        return format!("{}/{}", h, rest);
    }
    raw
}

/// Read all source files from a project directory. Returns relative_path -> content.
#[tauri::command]
fn read_project_source_files(
    directory: String,
) -> Result<std::collections::HashMap<String, String>, String> {
    use std::fs;

    let dir_path = std::path::Path::new(&directory);
    if !dir_path.exists() || !dir_path.is_dir() {
        return Err(format!("Not a valid directory: {}", directory));
    }

    // Check if this looks like a project (has common project files)
    let project_indicators = [
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
    let is_project = project_indicators.iter().any(|f| dir_path.join(f).exists());
    if !is_project {
        return Err(
            "Directory does not appear to be a project (no package.json, Cargo.toml, etc.)"
                .to_string(),
        );
    }

    let source_extensions = [
        "ts", "tsx", "js", "jsx", "css", "html", "json", "rs", "toml", "py", "go", "java", "c",
        "cpp", "h", "swift", "yaml", "yml", "sh", "sql", "md",
    ];
    let skip_dirs = [
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
    ];

    let mut contents = std::collections::HashMap::new();
    let mut total_size: usize = 0;
    let max_total_size: usize = 80_000;

    fn walk_dir(
        dir: &std::path::Path,
        root: &std::path::Path,
        contents: &mut std::collections::HashMap<String, String>,
        total_size: &mut usize,
        max_total_size: usize,
        source_extensions: &[&str],
        skip_dirs: &[&str],
    ) {
        if *total_size >= max_total_size {
            return;
        }

        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            if *total_size >= max_total_size {
                break;
            }

            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            if path.is_dir() {
                if skip_dirs.contains(&name.as_str()) || name.starts_with('.') {
                    continue;
                }
                walk_dir(
                    &path,
                    root,
                    contents,
                    total_size,
                    max_total_size,
                    source_extensions,
                    skip_dirs,
                );
            } else if path.is_file() {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if !source_extensions.contains(&ext) {
                    continue;
                }

                if let Ok(content) = fs::read_to_string(&path) {
                    if content.len() > 10_000 {
                        continue;
                    } // Skip large files
                    let relative = path
                        .strip_prefix(root)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| name);
                    *total_size += content.len();
                    contents.insert(relative, content);
                }
            }
        }
    }

    walk_dir(
        dir_path,
        dir_path,
        &mut contents,
        &mut total_size,
        max_total_size,
        &source_extensions,
        &skip_dirs,
    );

    Ok(contents)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn save_api_key(provider: &str, key: &str, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings
            .api_keys
            .insert(provider.to_string(), key.to_string());
    }
    state.save_settings()?;
    Ok(())
}

#[tauri::command]
fn get_api_key(provider: &str, state: State<'_, AppState>) -> Result<String, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings
        .api_keys
        .get(provider)
        .cloned()
        .ok_or_else(|| format!("No API key found for provider: {}", provider))
}

#[tauri::command]
fn get_git_history(file_path: &str) -> Result<Vec<GitCommit>, String> {
    let path = Path::new(file_path);
    let parent = path.parent().unwrap_or(path);
    let file_name = path.file_name().unwrap_or_default().to_string_lossy();

    let output = Command::new("git")
        .args(&[
            "log",
            "--pretty=format:%h|%s|%an|%ad",
            "--date=short",
            "-n",
            "50",
            "--",
            &file_name,
        ])
        .current_dir(parent)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Ok(Vec::new()); // Return empty logic if not a git repo or error
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut commits = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() >= 4 {
            commits.push(GitCommit {
                hash: parts[0].to_string(),
                message: parts[1].to_string(),
                author: parts[2].to_string(),
                date: parts[3].to_string(),
            });
        }
    }

    Ok(commits)
}

#[tauri::command]
fn get_file_evolution(file_path: &str) -> Result<FileEvolution, String> {
    let path = Path::new(file_path);
    let parent = path.parent().unwrap_or(path);
    let file_name = path.file_name().unwrap_or_default().to_string_lossy();

    // Get commit count
    let count_output = Command::new("git")
        .args(&["rev-list", "--count", "HEAD", "--", &*file_name])
        .current_dir(parent)
        .output()
        .map_err(|e| e.to_string())?;

    let total_commits = String::from_utf8_lossy(&count_output.stdout)
        .trim()
        .parse::<usize>()
        .unwrap_or(0);

    // Get authors stats
    let authors_output = Command::new("git")
        .args(&["shortlog", "-sn", "--", &*file_name])
        .current_dir(parent)
        .output()
        .map_err(|e| e.to_string())?;

    let authors_stdout = String::from_utf8_lossy(&authors_output.stdout);
    let mut authors = Vec::new();
    for line in authors_stdout.lines().take(5) {
        let parts: Vec<&str> = line.trim().split_whitespace().collect();
        if let Some(count_str) = parts.first() {
            if let Ok(count) = count_str.parse::<usize>() {
                let name = parts[1..].join(" ");
                authors.push(AuthorStats {
                    name,
                    commits: count,
                });
            }
        }
    }

    // Get timeline (reuse get_git_history logic roughly)
    let timeline = get_git_history(file_path)?;

    // Rough lines added/removed (using numstat)
    let stats_output = Command::new("git")
        .args(&["log", "--numstat", "--pretty=format:", "--", &*file_name])
        .current_dir(parent)
        .output()
        .map_err(|e| e.to_string())?;

    let stats_stdout = String::from_utf8_lossy(&stats_output.stdout);
    let mut added = 0;
    let mut removed = 0;

    for line in stats_stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 {
            added += parts[0].parse::<usize>().unwrap_or(0);
            removed += parts[1].parse::<usize>().unwrap_or(0);
        }
    }

    Ok(FileEvolution {
        total_file_commits: total_commits,
        authors,
        timeline,
        lines_added_total: added,
        lines_removed_total: removed,
    })
}

#[tauri::command]
fn find_repo_root(file_path: &str) -> Result<String, String> {
    let path = Path::new(file_path);
    let parent = if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(path)
    };

    let output = Command::new("git")
        .args(&["rev-parse", "--show-toplevel"])
        .current_dir(parent)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err("Not a git repository".to_string())
    }
}

#[tauri::command]
fn get_git_remote_info(repo_path: &str) -> Result<GitRemoteInfo, String> {
    let path = Path::new(repo_path);

    // Remote URL
    let url_output = Command::new("git")
        .args(&["remote", "get-url", "origin"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    let remote_url = if url_output.status.success() {
        Some(
            String::from_utf8_lossy(&url_output.stdout)
                .trim()
                .to_string(),
        )
    } else {
        None
    };

    let mut github_repo = None;
    let mut github_url = None;

    if let Some(url) = &remote_url {
        if url.contains("github.com") {
            let clean_url = url.trim().replace(".git", "");
            if let Some(idx) = clean_url.find("github.com") {
                let repo_part = &clean_url[idx + 11..]; // skip github.com/ or github.com:
                let repo_part = repo_part.trim_start_matches(|c| c == '/' || c == ':');
                github_repo = Some(repo_part.to_string());
                github_url = Some(format!("https://github.com/{}", repo_part));
            }
        }
    }

    // Contributors
    let contrib_output = Command::new("git")
        .args(&["shortlog", "-sne", "--all"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    let contrib_stdout = String::from_utf8_lossy(&contrib_output.stdout);
    let mut contributors = Vec::new();

    for line in contrib_stdout.lines().take(10) {
        // Format:     34	Name <email@example.com>
        let parts: Vec<&str> = line.trim().split_whitespace().collect();
        if let Some(count_str) = parts.first() {
            if let Ok(count) = count_str.parse::<usize>() {
                let rest = parts[1..].join(" ");
                if let Some(start_email) = rest.find('<') {
                    if let Some(end_email) = rest.find('>') {
                        let name = rest[..start_email].trim().to_string();
                        let email = rest[start_email + 1..end_email].to_string();
                        contributors.push(ContributorStats {
                            name,
                            email,
                            commits: count,
                        });
                    }
                }
            }
        }
    }

    // Total commits
    let count_output = Command::new("git")
        .args(&["rev-list", "--count", "--all"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    let total_commits = String::from_utf8_lossy(&count_output.stdout)
        .trim()
        .parse::<usize>()
        .unwrap_or(0);

    // First commit date
    let first_commit_output = Command::new("git")
        .args(&[
            "log",
            "--reverse",
            "--format=%ad",
            "--date=short",
            "-n",
            "1",
        ])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    let first_commit_date = if first_commit_output.status.success() {
        Some(
            String::from_utf8_lossy(&first_commit_output.stdout)
                .trim()
                .to_string(),
        )
    } else {
        None
    };

    Ok(GitRemoteInfo {
        remote_url,
        github_repo,
        github_url,
        contributors,
        total_commits,
        first_commit_date,
        branches: Vec::new(), // Skip branches for now to save time
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMatch {
    file: String,
    line: usize,
    column: usize,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitFileStatus {
    path: String,
    status: String,
    staged: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatusResult {
    branch: String,
    files: Vec<GitFileStatus>,
    ahead: usize,
    behind: usize,
}

// Get all files in a directory recursively
fn walk_directory(dir: &Path, base_path: &Path, files: &mut Vec<String>) -> std::io::Result<()> {
    if dir.is_dir() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();

            // Skip common ignore patterns
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.')
                    || name == "node_modules"
                    || name == "target"
                    || name == "dist"
                    || name == "build"
                    || name == "__pycache__"
                {
                    continue;
                }
            }

            if path.is_dir() {
                walk_directory(&path, base_path, files)?;
            } else {
                if let Ok(relative) = path.strip_prefix(base_path) {
                    if let Some(path_str) = relative.to_str() {
                        files.push(path_str.to_string());
                    }
                }
            }
        }
    }
    Ok(())
}

// Search files for a pattern
fn search_in_directory(
    dir: &Path,
    base_path: &Path,
    pattern: &str,
    case_sensitive: bool,
    matches: &mut Vec<SearchMatch>,
    max_results: usize,
) -> std::io::Result<()> {
    if matches.len() >= max_results {
        return Ok(());
    }

    if dir.is_dir() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();

            // Skip common ignore patterns
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.')
                    || name == "node_modules"
                    || name == "target"
                    || name == "dist"
                    || name == "build"
                    || name == "__pycache__"
                {
                    continue;
                }
            }

            if path.is_dir() {
                search_in_directory(
                    &path,
                    base_path,
                    pattern,
                    case_sensitive,
                    matches,
                    max_results,
                )?;
            } else {
                // Try to read as text file
                if let Ok(content) = fs::read_to_string(&path) {
                    let search_pattern = if case_sensitive {
                        pattern.to_string()
                    } else {
                        pattern.to_lowercase()
                    };

                    for (line_num, line) in content.lines().enumerate() {
                        let search_line = if case_sensitive {
                            line.to_string()
                        } else {
                            line.to_lowercase()
                        };

                        if let Some(col) = search_line.find(&search_pattern) {
                            if let Ok(relative) = path.strip_prefix(base_path) {
                                if let Some(file_str) = relative.to_str() {
                                    matches.push(SearchMatch {
                                        file: file_str.to_string(),
                                        line: line_num + 1,
                                        column: col + 1,
                                        text: line.to_string(),
                                    });

                                    if matches.len() >= max_results {
                                        return Ok(());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn get_all_files(directory: String) -> Result<Vec<String>, String> {
    let base_path = PathBuf::from(&directory);
    let mut files = Vec::new();

    walk_directory(&base_path, &base_path, &mut files).map_err(|e| e.to_string())?;

    Ok(files)
}

#[tauri::command]
fn search_in_files(
    directory: String,
    pattern: String,
    case_sensitive: Option<bool>,
    max_results: Option<usize>,
) -> Result<Vec<SearchMatch>, String> {
    let base_path = PathBuf::from(&directory);
    let mut matches = Vec::new();
    let case_sensitive = case_sensitive.unwrap_or(false);
    let max_results = max_results.unwrap_or(500);

    search_in_directory(
        &base_path,
        &base_path,
        &pattern,
        case_sensitive,
        &mut matches,
        max_results,
    )
    .map_err(|e| e.to_string())?;

    Ok(matches)
}

#[tauri::command]
fn get_git_status(repo_path: &str) -> Result<GitStatusResult, String> {
    let path = Path::new(repo_path);

    // Get current branch
    let branch_output = Command::new("git")
        .args(&["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    let branch = if branch_output.status.success() {
        String::from_utf8_lossy(&branch_output.stdout)
            .trim()
            .to_string()
    } else {
        "unknown".to_string()
    };

    // Get ahead/behind counts
    let ahead_behind_output = Command::new("git")
        .args(&["rev-list", "--left-right", "--count", "HEAD...@{u}"])
        .current_dir(path)
        .output();

    let (ahead, behind) = if let Ok(output) = ahead_behind_output {
        if output.status.success() {
            let counts = String::from_utf8_lossy(&output.stdout);
            let parts: Vec<&str> = counts.trim().split_whitespace().collect();
            (
                parts.get(0).and_then(|s| s.parse().ok()).unwrap_or(0),
                parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0),
            )
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    };

    // Get file status
    let status_output = Command::new("git")
        .args(&["status", "--porcelain=v1"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    let mut files = Vec::new();
    if status_output.status.success() {
        let status_str = String::from_utf8_lossy(&status_output.stdout);
        for line in status_str.lines() {
            if line.len() < 4 {
                continue;
            }

            let index_status = line.chars().nth(0).unwrap_or(' ');
            let worktree_status = line.chars().nth(1).unwrap_or(' ');
            let file_path = line[3..].to_string();

            let (status, staged) = match (index_status, worktree_status) {
                ('M', ' ') => ("modified".to_string(), true),
                ('M', 'M') => ("modified".to_string(), false),
                (' ', 'M') => ("modified".to_string(), false),
                ('A', ' ') => ("added".to_string(), true),
                ('A', 'M') => ("added".to_string(), false),
                ('D', ' ') => ("deleted".to_string(), true),
                (' ', 'D') => ("deleted".to_string(), false),
                ('R', ' ') => ("renamed".to_string(), true),
                ('?', '?') => ("untracked".to_string(), false),
                _ => ("unknown".to_string(), false),
            };

            files.push(GitFileStatus {
                path: file_path,
                status,
                staged,
            });
        }
    }

    Ok(GitStatusResult {
        branch,
        files,
        ahead,
        behind,
    })
}

#[tauri::command]
fn get_git_diff(repo_path: &str, file_path: &str, staged: bool) -> Result<String, String> {
    let path = Path::new(repo_path);

    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.push(file_path);

    let output = Command::new("git")
        .args(&args)
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitBranchList {
    current: String,
    local: Vec<String>,
    remote: Vec<String>,
}

#[tauri::command]
fn git_list_branches(repo_path: &str) -> Result<GitBranchList, String> {
    let path = Path::new(repo_path);

    // Get current branch
    let current_output = Command::new("git")
        .args(&["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    let current = if current_output.status.success() {
        String::from_utf8_lossy(&current_output.stdout)
            .trim()
            .to_string()
    } else {
        "HEAD".to_string()
    };

    // Get all branches
    let branch_output = Command::new("git")
        .args(&["branch", "-a", "--no-color"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    let mut local = Vec::new();
    let mut remote = Vec::new();

    if branch_output.status.success() {
        let stdout = String::from_utf8_lossy(&branch_output.stdout);
        for line in stdout.lines() {
            let name = line.trim().trim_start_matches("* ").to_string();
            if name.is_empty() || name.contains("HEAD ->") {
                continue;
            }
            if name.starts_with("remotes/") {
                // Strip "remotes/origin/" prefix for display
                let short = name
                    .strip_prefix("remotes/origin/")
                    .unwrap_or(&name)
                    .to_string();
                if !short.is_empty() && !remote.contains(&short) {
                    remote.push(short);
                }
            } else {
                local.push(name);
            }
        }
    }

    Ok(GitBranchList {
        current,
        local,
        remote,
    })
}

#[tauri::command]
fn git_checkout_branch(repo_path: &str, branch: &str) -> Result<String, String> {
    let path = Path::new(repo_path);

    let output = Command::new("git")
        .args(&["checkout", branch])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Ok(if msg.is_empty() {
            format!("Switched to branch '{}'", branch)
        } else {
            msg
        })
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
fn git_create_branch(repo_path: &str, branch: &str) -> Result<String, String> {
    let path = Path::new(repo_path);

    let output = Command::new("git")
        .args(&["checkout", "-b", branch])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(format!("Created and switched to branch '{}'", branch))
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
fn git_pull(repo_path: &str) -> Result<String, String> {
    let path = Path::new(repo_path);

    let output = Command::new("git")
        .args(&["pull"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
fn git_push(repo_path: &str) -> Result<String, String> {
    let path = Path::new(repo_path);

    // First try regular push
    let output = Command::new("git")
        .args(&["push"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Ok(if msg.is_empty() {
            "Push successful".to_string()
        } else {
            msg
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // If no upstream, try setting upstream
        if stderr.contains("no upstream") || stderr.contains("has no upstream") {
            let branch_output = Command::new("git")
                .args(&["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(path)
                .output()
                .map_err(|e| e.to_string())?;

            let branch = String::from_utf8_lossy(&branch_output.stdout)
                .trim()
                .to_string();

            let push_output = Command::new("git")
                .args(&["push", "-u", "origin", &branch])
                .current_dir(path)
                .output()
                .map_err(|e| e.to_string())?;

            if push_output.status.success() {
                Ok(format!("Pushed and set upstream to origin/{}", branch))
            } else {
                Err(String::from_utf8_lossy(&push_output.stderr)
                    .trim()
                    .to_string())
            }
        } else {
            Err(stderr)
        }
    }
}

#[tauri::command]
fn git_fetch(repo_path: &str) -> Result<String, String> {
    let path = Path::new(repo_path);

    let output = Command::new("git")
        .args(&["fetch", "--all"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Ok(if msg.is_empty() {
            "Fetch complete".to_string()
        } else {
            msg
        })
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
fn git_init(repo_path: &str) -> Result<String, String> {
    let path = Path::new(repo_path);

    if !path.exists() || !path.is_dir() {
        return Err(format!("Not a valid directory: {}", repo_path));
    }

    let output = Command::new("git")
        .args(&["init"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
fn git_add_remote(repo_path: &str, name: &str, url: &str) -> Result<String, String> {
    let path = Path::new(repo_path);

    let output = Command::new("git")
        .args(&["remote", "add", name, url])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(format!("Remote '{}' added: {}", name, url))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // If remote already exists, try updating it instead
        if stderr.contains("already exists") {
            let update_output = Command::new("git")
                .args(&["remote", "set-url", name, url])
                .current_dir(path)
                .output()
                .map_err(|e| e.to_string())?;

            if update_output.status.success() {
                Ok(format!("Remote '{}' updated: {}", name, url))
            } else {
                Err(String::from_utf8_lossy(&update_output.stderr)
                    .trim()
                    .to_string())
            }
        } else {
            Err(stderr)
        }
    }
}

#[tauri::command]
async fn ask_claude(prompt: String, state: tauri::State<'_, AppState>) -> Result<String, String> {
    // Claude API integration - using current claude-sonnet-4-6 model
    // Get API key from stored settings
    let api_key = {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings.api_keys.get("claude").cloned().ok_or_else(|| {
            "No Claude API key found. Please configure it in Settings.".to_string()
        })?
    };

    let client = reqwest::Client::new();

    // Try to parse context from the prompt JSON
    let request_body = if let Ok(context_data) = serde_json::from_str::<serde_json::Value>(&prompt)
    {
        let user_prompt = context_data
            .get("prompt")
            .and_then(|p| p.as_str())
            .unwrap_or(&prompt);

        if let Some(project_files) = context_data
            .get("project_files")
            .and_then(|v| v.as_object())
        {
            // Full project context
            // Cap per-file content and total snapshot to keep prompt tokens low.
            const FILE_CHAR_LIMIT: usize = 1500;
            const SNAPSHOT_CHAR_LIMIT: usize = 12000;
            let mut project_snapshot = String::new();
            for (file_path, content_val) in project_files {
                if project_snapshot.len() >= SNAPSHOT_CHAR_LIMIT { break; }
                if let Some(content) = content_val.as_str() {
                    let ext = file_path.rsplit('.').next().unwrap_or("text");
                    let truncated = if content.len() > FILE_CHAR_LIMIT {
                        &content[..FILE_CHAR_LIMIT]
                    } else {
                        content
                    };
                    project_snapshot.push_str(&format!(
                        "\n--- FILE: {} ---\n```{}\n{}\n```\n",
                        file_path, ext, truncated
                    ));
                }
            }

            let system_message = format!(
                "You are an AI coding assistant in a terminal/IDE called Velix. You have access to the user's ENTIRE project.\n\n\
                FULL PROJECT SOURCE CODE:\n{}\n\n\
                RULES:\n\
                - When the user says 'optimize this' or 'fix this', analyze the entire project.\n\
                - When you make changes, output EACH changed file like this:\n\n\
                FILE: path/to/file.ext\n```language\n...full updated file content...\n```\n\n\
                - Only output files you actually changed.\n\
                - Be specific. Reference actual code.\n\
                - Keep explanations brief.",
                project_snapshot
            );

            serde_json::json!({
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 2048,
                "system": system_message,
                "messages": [{"role": "user", "content": user_prompt}]
            })
        } else if let Some(file_context) = context_data.get("file_context") {
            let fp = file_context
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let fl = file_context
                .get("language")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let fc = file_context
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let system_message = format!(
                "You are an AI coding assistant. File: {}\n\n```{}\n{}\n```\n\nBe specific. Reference actual code.",
                fp, fl, fc
            );

            serde_json::json!({
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 1024,
                "system": system_message,
                "messages": [{"role": "user", "content": user_prompt}]
            })
        } else {
            serde_json::json!({
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": user_prompt}]
            })
        }
    } else {
        serde_json::json!({
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": &prompt}]
        })
    };

    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Failed to send request to Claude: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Claude API error {}: {}", status, error_text));
    }

    let response_json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Claude response: {}", e))?;

    let content = response_json
        .get("content")
        .and_then(|arr| arr.as_array())
        .and_then(|arr| arr.first())
        .and_then(|obj| obj.get("text"))
        .and_then(|text| text.as_str())
        .unwrap_or("No response from Claude");

    Ok(content.to_string())
}

// ==================== Generic AI Chat Command ====================

#[derive(serde::Deserialize)]
struct AiChatMessage {
    role: String,
    content: String,
}

/// Provider-agnostic AI chat command. Mirrors the Electron `aiChat` handler.
#[tauri::command]
async fn ai_chat(
    provider: String,
    model: String,
    api_key: String,
    messages: Vec<AiChatMessage>,
    system: Option<String>,
    max_tokens: Option<u32>,
) -> Result<String, String> {
    let max = max_tokens.unwrap_or(4096);
    let client = reqwest::Client::new();

    if provider == "claude" {
        let msgs: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| serde_json::json!({"role": m.role, "content": m.content}))
            .collect();
        let mut body = serde_json::json!({
            "model": model,
            "max_tokens": max,
            "messages": msgs,
        });
        if let Some(sys) = system {
            body["system"] = serde_json::Value::String(sys);
        }
        let response = client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Anthropic request failed: {}", e))?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(format!("Anthropic API error ({}): {}", status, text));
        }
        let data: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Anthropic response: {}", e))?;
        return Ok(data["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_string());
    }

    if provider == "gemini" {
        let gemini_msgs: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| {
                serde_json::json!({
                    "role": if m.role == "assistant" { "model" } else { "user" },
                    "parts": [{"text": m.content}]
                })
            })
            .collect();
        let mut body = serde_json::json!({"contents": gemini_msgs});
        if let Some(sys) = system {
            body["systemInstruction"] = serde_json::json!({"parts": [{"text": sys}]});
        }
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        );
        let response = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Google request failed: {}", e))?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(format!("Google API error ({}): {}", status, text));
        }
        let data: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Google response: {}", e))?;
        return Ok(data["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_string());
    }

    // OpenAI-compatible providers
    let base_url = match provider.as_str() {
        "chatgpt" => "https://api.openai.com/v1",
        "deepseek" => "https://api.deepseek.com/v1",
        "groq" => "https://api.groq.com/openai/v1",
        "mistral" => "https://api.mistral.ai/v1",
        "minimax" => "https://api.minimax.chat/v1",
        "kimi" => "https://api.moonshot.cn/v1",
        "glm4" => "https://open.bigmodel.cn/api/paas/v4",
        _ => return Err(format!("Unsupported AI provider: {}", provider)),
    };

    let mut chat_msgs: Vec<serde_json::Value> = Vec::new();
    if let Some(sys) = system {
        chat_msgs.push(serde_json::json!({"role": "system", "content": sys}));
    }
    for m in &messages {
        chat_msgs.push(serde_json::json!({"role": m.role, "content": m.content}));
    }
    let body = serde_json::json!({
        "model": model,
        "messages": chat_msgs,
        "max_tokens": max,
    });
    let response = client
        .post(format!("{}/chat/completions", base_url))
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("{} request failed: {}", provider, e))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("{} API error ({}): {}", provider, status, text));
    }
    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse {} response: {}", provider, e))?;
    Ok(data["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string())
}

// ==================== Velix Engine Management ====================

/// Try to locate the `bun` executable in common paths.
fn find_bun() -> Option<String> {
    // Try PATH first
    if let Ok(output) = Command::new("which").arg("bun").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    // Common macOS / Linux locations
    let candidates = ["/usr/local/bin/bun", "/opt/homebrew/bin/bun"];
    let home = std::env::var("HOME").unwrap_or_default();
    let home_bun = format!("{}/.bun/bin/bun", home);
    let mut all: Vec<&str> = candidates.to_vec();
    all.push(home_bun.as_str());
    for path in all {
        if Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    None
}

/// Try to find the velixcode/packages/engine directory.
/// In dev mode, searches relative to cwd. In production, falls back to the
/// app's resource directory (where the bundled velixcode is placed).
fn find_velix_engine_dir(app: &AppHandle) -> Option<PathBuf> {
    // Dev: cwd is the Velix project root
    if let Ok(cwd) = std::env::current_dir() {
        let candidate = cwd.join("velixcode/packages/engine");
        if candidate.exists() {
            return Some(candidate);
        }
        // Running from src-tauri/
        if let Some(parent) = cwd.parent() {
            let candidate2 = parent.join("velixcode/packages/engine");
            if candidate2.exists() {
                return Some(candidate2);
            }
        }
    }
    // Production: look next to the app binary (resource dir)
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("velixcode/packages/engine");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Start the Velix AI engine as a child process.
/// The server listens on http://localhost:4096.
#[tauri::command]
async fn start_velix_engine(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Check if already running
    {
        let proc = state.velix_engine_process.lock().map_err(|e| e.to_string())?;
        if proc.is_some() {
            return Ok("http://localhost:4096".to_string());
        }
    }

    let bun = find_bun().ok_or_else(|| {
        "bun runtime not found. Please install bun (https://bun.sh) to use the AI engine."
            .to_string()
    })?;

    let engine_dir = find_velix_engine_dir(&app).ok_or_else(|| {
        "velixcode/packages/engine directory not found. Make sure velixcode is in the Velix project root.".to_string()
    })?;

    let entry_point = engine_dir.join("src/index.ts");
    if !entry_point.exists() {
        return Err(format!(
            "Velix engine entry point not found at: {}",
            entry_point.display()
        ));
    }

    let child = Command::new(&bun)
        .arg("run")
        .arg("--conditions=browser")
        .arg(entry_point.to_str().unwrap_or("src/index.ts"))
        .arg("serve")
        .arg("--port")
        .arg("4096")
        .current_dir(&engine_dir)
        .env("VELIX_ENGINE_PORT", "4096")
        // Pipe stdout/stderr so they don't clutter the terminal
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start Velix engine: {}", e))?;

    {
        let mut proc = state.velix_engine_process.lock().map_err(|e| e.to_string())?;
        *proc = Some(child);
    }

    Ok("http://localhost:4096".to_string())
}

/// Stop the Velix AI engine if it is running.
#[tauri::command]
async fn stop_velix_engine(state: State<'_, AppState>) -> Result<(), String> {
    let mut proc = state.velix_engine_process.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = proc.take() {
        let _ = child.kill();
    }
    Ok(())
}

/// Get the URL of the Velix AI engine.
#[tauri::command]
fn get_velix_engine_url() -> String {
    "http://localhost:4096".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state = AppState::new(app.handle());
            app.manage(state);
            Ok(())
        })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            save_api_key,
            get_api_key,
            execute_shell_command,
            check_cli_available,
            get_shell_cwd,
            set_shell_cwd,
            get_git_history,
            get_file_evolution,
            find_repo_root,
            get_git_remote_info,
            get_all_files,
            search_in_files,
            get_git_status,
            get_git_diff,
            git_list_branches,
            git_checkout_branch,
            git_create_branch,
            git_pull,
            git_push,
            git_fetch,
            git_init,
            git_add_remote,
            pty_create,
            pty_write,
            pty_resize,
            pty_kill,
            ask_claude,
            ai_chat,
            read_project_source_files,
            start_velix_engine,
            stop_velix_engine,
            get_velix_engine_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
