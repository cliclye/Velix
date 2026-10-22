use std::path::Path;
use std::process::Command;

/// User home directory (cross-platform).
pub fn home_dir() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| {
            #[cfg(windows)]
            {
                std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".to_string())
            }
            #[cfg(not(windows))]
            {
                std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
            }
        })
}

/// Default interactive shell for PTY and one-off commands.
pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        if let Ok(ps) = which_on_path("powershell.exe") {
            return ps;
        }
        std::env::var("COMSPEC").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

/// PATH entries from the environment, in search order.
pub fn system_path_entries() -> Vec<String> {
    #[cfg(windows)]
    {
        let raw = std::env::var("PATH").unwrap_or_default();
        split_path_list(&raw)
    }
    #[cfg(not(windows))]
    {
        let shell = default_shell();
        let home = home_dir();
        let login_path = Command::new(&shell)
            .args(["-l", "-c", "echo $PATH"])
            .env("HOME", &home)
            .stdin(std::process::Stdio::null())
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| last_non_empty_line(&s));

        let interactive_path = Command::new(&shell)
            .args(["-i", "-l", "-c", "echo $PATH"])
            .env("HOME", &home)
            .stdin(std::process::Stdio::null())
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| last_non_empty_line(&s));

        let mut dirs: Vec<String> = Vec::new();
        for raw in [login_path, interactive_path].into_iter().flatten() {
            for dir in split_path_list(&raw) {
                push_unique(&mut dirs, dir);
            }
        }
        if dirs.is_empty() {
            dirs = split_path_list(&std::env::var("PATH").unwrap_or_default());
        }
        dirs
    }
}

/// Ordered directories to scan for CLI binaries.
pub fn cli_search_dirs() -> Vec<String> {
    let home = home_dir();
    let mut dirs = system_path_entries();

    #[cfg(windows)]
    {
        let extra = [
            format!("{}\\AppData\\Local\\Programs\\VelixCLI", home),
            format!("{}\\AppData\\Roaming\\npm", home),
            format!("{}\\.cargo\\bin", home),
            format!("{}\\.bun\\bin", home),
            format!("{}\\scoop\\shims", home),
            "C:\\Program Files\\Git\\cmd".to_string(),
            "C:\\Program Files\\nodejs".to_string(),
        ];
        for d in extra {
            push_unique(&mut dirs, d);
        }
    }

    #[cfg(not(windows))]
    {
        let extra = vec![
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".to_string(),
            "/usr/bin".to_string(),
            format!("{}/.npm-global/bin", home),
            format!("{}/.yarn/bin", home),
            format!("{}/.cargo/bin", home),
            format!("{}/.bun/bin", home),
        ];
        for d in extra {
            push_unique(&mut dirs, d);
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
                push_unique(&mut dirs, bin);
            }
        }
    }

    dirs
}

/// Resolve `cd` target relative to current working directory.
pub fn resolve_cd_target(arg: &str, working_dir: &str) -> String {
    let home = home_dir();
    let trimmed = arg.trim_matches('"').trim_matches('\'');

    if trimmed.is_empty() || trimmed == "~" {
        return home;
    }
    if trimmed == "-" {
        return home;
    }

    let path = Path::new(trimmed);
    if path.is_absolute() {
        return trimmed.to_string();
    }

    if let Some(rest) = trimmed.strip_prefix("~/") {
        let h = home.trim_end_matches(['/', '\\']);
        if rest.is_empty() {
            return h.to_string();
        }
        return Path::new(h).join(rest).to_string_lossy().to_string();
    }

    Path::new(working_dir)
        .join(trimmed)
        .to_string_lossy()
        .to_string()
}

/// Locate `bun` for the Velix engine.
pub fn find_bun() -> Option<String> {
    #[cfg(windows)]
    {
        if let Ok(output) = Command::new("where").arg("bun").output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !path.is_empty() {
                    return Some(path);
                }
            }
        }
        let home = home_dir();
        let candidates = [
            format!("{}\\.bun\\bin\\bun.exe", home),
            "C:\\Program Files\\nodejs\\bun.cmd".to_string(),
        ];
        for path in candidates {
            if Path::new(&path).exists() {
                return Some(path);
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        if let Ok(output) = Command::new("which").arg("bun").output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Some(path);
                }
            }
        }
        let home = home_dir();
        let candidates = [
            "/usr/local/bin/bun".to_string(),
            "/opt/homebrew/bin/bun".to_string(),
            format!("{}/.bun/bin/bun", home),
        ];
        for path in candidates {
            if Path::new(&path).exists() {
                return Some(path);
            }
        }
        None
    }
}

pub fn configure_pty_shell(cmd: &mut portable_pty::CommandBuilder) {
    #[cfg(not(windows))]
    {
        cmd.arg("-l");
    }
}

pub fn pty_env(cmd: &mut portable_pty::CommandBuilder, full_path: &str) {
    let home = home_dir();
    cmd.env("PATH", full_path);
    cmd.env("HOME", &home);
    #[cfg(windows)]
    {
        cmd.env("USERPROFILE", &home);
        cmd.env("TERM", "xterm-256color");
    }
    #[cfg(not(windows))]
    {
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("LANG", "en_US.UTF-8");
    }
}

/// rc files may print banners; the PATH we asked for is always the last non-empty line.
fn last_non_empty_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .last()
        .map(|l| l.to_string())
}

fn split_path_list(raw: &str) -> Vec<String> {
    #[cfg(windows)]
    let sep = ';';
    #[cfg(not(windows))]
    let sep = ':';

    raw.split(sep)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn push_unique(dirs: &mut Vec<String>, dir: String) {
    if !dirs.contains(&dir) {
        dirs.push(dir);
    }
}

#[cfg(windows)]
fn which_on_path(name: &str) -> Result<String, ()> {
    Command::new("where")
        .arg(name)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
        .filter(|s| !s.is_empty())
        .ok_or(())
}

#[cfg(not(windows))]
fn which_on_path(_name: &str) -> Result<String, ()> {
    Err(())
}

/// Executable name for a CLI command on this OS.
pub fn cli_executable_name(command: &str) -> String {
    #[cfg(windows)]
    {
        if command.ends_with(".exe") {
            command.to_string()
        } else {
            format!("{}.exe", command)
        }
    }
    #[cfg(not(windows))]
    {
        command.to_string()
    }
}

pub fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            return meta.permissions().mode() & 0o111 != 0;
        }
        false
    }
    #[cfg(not(unix))]
    {
        true
    }
}
