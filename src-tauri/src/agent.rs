//! Swarm worker process runner.
//!
//! Each swarm worker is ONE non-interactive CLI process (`claude -p`, `codex exec`, …).
//! Earlier versions drove these through an interactive login shell inside a PTY, which
//! meant the swarm depended on the user's shell rc files, prompt rendering, TTY line
//! limits and `pty_kill` (which only dropped a map entry and never killed anything).
//!
//! This module spawns the CLI directly:
//!   * no shell, no quoting — argv is passed as-is and the prompt can go through stdin
//!   * stdout/stderr are separate pipes, streamed as `agent-output` events
//!   * the child leads its own process group, so kill/timeout takes down the whole tree
//!   * `agent-exit` is emitted exactly once, AFTER all output has been flushed, with the
//!     real exit code / signal, and flags for `timed_out` / `killed`
//!
//! The core (`AgentRunner`) is independent of Tauri so it can be unit-tested with plain
//! shell scripts; `lib.rs` wires it to Tauri events.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// How long to wait after SIGTERM before escalating to SIGKILL.
const KILL_GRACE: Duration = Duration::from_millis(2500);
/// How long to wait for the output pipes to drain after the main process exited
/// (grandchildren may keep the pipe open; we must never hang on them).
const DRAIN_TIMEOUT: Duration = Duration::from_millis(1500);
const POLL_INTERVAL: Duration = Duration::from_millis(40);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpawnRequest {
    pub run_id: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    /// Text written to the child's stdin, then stdin is closed (EOF).
    #[serde(default)]
    pub stdin: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Hard wall-clock limit. The only failsafe: headless CLIs can be silent for a long time.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AgentEvent {
    Output {
        run_id: String,
        stream: String,
        data: String,
    },
    Exit {
        run_id: String,
        exit_code: Option<i32>,
        signal: Option<i32>,
        timed_out: bool,
        killed: bool,
        duration_ms: u64,
        /// Set when the process could not be started or waited on.
        error: Option<String>,
    },
}

pub type EventSink = Arc<dyn Fn(AgentEvent) + Send + Sync + 'static>;

struct RunHandle {
    kill_requested: AtomicBool,
}

#[derive(Default)]
pub struct AgentRunner {
    runs: Mutex<HashMap<String, Arc<RunHandle>>>,
}

impl AgentRunner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn active_ids(&self) -> Vec<String> {
        self.runs
            .lock()
            .map(|r| r.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Start a worker. Returns once the process is spawned (or immediately with an error);
    /// everything else is reported through `sink`.
    pub fn spawn(
        self: &Arc<Self>,
        req: AgentSpawnRequest,
        path_env: Option<String>,
        sink: EventSink,
    ) -> Result<(), String> {
        if req.program.trim().is_empty() {
            return Err("No program given".to_string());
        }
        {
            let runs = self.runs.lock().map_err(|e| e.to_string())?;
            if runs.contains_key(&req.run_id) {
                return Err(format!("Agent run already exists: {}", req.run_id));
            }
        }

        let cwd = PathBuf::from(&req.cwd);
        if !cwd.is_dir() {
            return Err(format!("Working directory does not exist: {}", req.cwd));
        }

        let mut cmd = Command::new(&req.program);
        cmd.args(&req.args)
            .current_dir(&cwd)
            .stdin(if req.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Headless run: no colour codes or terminal tricks in captured output.
        cmd.env("NO_COLOR", "1").env("TERM", "dumb");
        if let Some(path) = &path_env {
            cmd.env("PATH", path);
        }
        for (k, v) in &req.env {
            cmd.env(k, v);
        }
        configure_process_group(&mut cmd);

        let started = Instant::now();
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start `{}`: {}", req.program, e))?;

        let handle = Arc::new(RunHandle {
            kill_requested: AtomicBool::new(false),
        });
        self.runs
            .lock()
            .map_err(|e| e.to_string())?
            .insert(req.run_id.clone(), handle.clone());

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin = child.stdin.take();

        if let (Some(mut pipe), Some(text)) = (stdin, req.stdin.clone()) {
            thread::spawn(move || {
                // Broken pipe (child exited early) is fine.
                let _ = pipe.write_all(text.as_bytes());
                let _ = pipe.flush();
                drop(pipe);
            });
        }

        let mut readers: Vec<thread::JoinHandle<()>> = Vec::new();
        if let Some(p) = stdout {
            readers.push(spawn_reader(p, req.run_id.clone(), "stdout", sink.clone()));
        }
        if let Some(p) = stderr {
            readers.push(spawn_reader(p, req.run_id.clone(), "stderr", sink.clone()));
        }

        let runner = self.clone();
        let run_id = req.run_id.clone();
        let timeout = req.timeout_ms.map(Duration::from_millis);
        thread::spawn(move || {
            let outcome = wait_for_exit(&mut child, &handle, started, timeout);

            // Flush output before announcing exit so the frontend never loses the tail.
            let drain_deadline = Instant::now() + DRAIN_TIMEOUT;
            for r in readers {
                while !r.is_finished() && Instant::now() < drain_deadline {
                    thread::sleep(Duration::from_millis(10));
                }
                if r.is_finished() {
                    let _ = r.join();
                }
            }

            if let Ok(mut runs) = runner.runs.lock() {
                runs.remove(&run_id);
            }

            sink(AgentEvent::Exit {
                run_id,
                exit_code: outcome.exit_code,
                signal: outcome.signal,
                timed_out: outcome.timed_out,
                killed: outcome.killed,
                duration_ms: started.elapsed().as_millis() as u64,
                error: outcome.error,
            });
        });

        Ok(())
    }

    /// Ask a run to stop (SIGTERM to its process group, SIGKILL after a grace period).
    /// Returns false if no such run is active (already finished is not an error for callers).
    pub fn kill(&self, run_id: &str) -> bool {
        match self.runs.lock() {
            Ok(runs) => match runs.get(run_id) {
                Some(handle) => {
                    handle.kill_requested.store(true, Ordering::SeqCst);
                    true
                }
                None => false,
            },
            Err(_) => false,
        }
    }

    pub fn kill_all(&self) {
        if let Ok(runs) = self.runs.lock() {
            for handle in runs.values() {
                handle.kill_requested.store(true, Ordering::SeqCst);
            }
        }
    }
}

struct WaitOutcome {
    exit_code: Option<i32>,
    signal: Option<i32>,
    timed_out: bool,
    killed: bool,
    error: Option<String>,
}

fn wait_for_exit(
    child: &mut Child,
    handle: &RunHandle,
    started: Instant,
    timeout: Option<Duration>,
) -> WaitOutcome {
    let mut timed_out = false;
    let mut killed = false;
    let mut term_sent_at: Option<Instant> = None;
    let mut hard_killed = false;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // The leader is gone; make sure nothing it spawned lingers.
                if timed_out || killed {
                    kill_group(child.id(), true);
                }
                return WaitOutcome {
                    exit_code: status.code(),
                    signal: exit_signal(&status),
                    timed_out,
                    killed,
                    error: None,
                };
            }
            Ok(None) => {}
            Err(e) => {
                return WaitOutcome {
                    exit_code: None,
                    signal: None,
                    timed_out,
                    killed,
                    error: Some(format!("Failed waiting for process: {}", e)),
                };
            }
        }

        if term_sent_at.is_none() {
            if handle.kill_requested.load(Ordering::SeqCst) {
                killed = true;
                kill_group(child.id(), false);
                term_sent_at = Some(Instant::now());
            } else if let Some(limit) = timeout {
                if started.elapsed() >= limit {
                    timed_out = true;
                    kill_group(child.id(), false);
                    term_sent_at = Some(Instant::now());
                }
            }
        } else if !hard_killed {
            if let Some(sent) = term_sent_at {
                if sent.elapsed() >= KILL_GRACE {
                    kill_group(child.id(), true);
                    let _ = child.kill();
                    hard_killed = true;
                }
            }
        }

        thread::sleep(POLL_INTERVAL);
    }
}

/// Read a pipe to EOF, emitting UTF-8-safe chunks.
fn spawn_reader<R: Read + Send + 'static>(
    mut pipe: R,
    run_id: String,
    stream: &'static str,
    sink: EventSink,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match pipe.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let valid_up_to = utf8_boundary(&carry);
                    if valid_up_to > 0 {
                        let rest = carry.split_off(valid_up_to);
                        let chunk = String::from_utf8_lossy(&carry).into_owned();
                        carry = rest;
                        sink(AgentEvent::Output {
                            run_id: run_id.clone(),
                            stream: stream.to_string(),
                            data: chunk,
                        });
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        if !carry.is_empty() {
            sink(AgentEvent::Output {
                run_id,
                stream: stream.to_string(),
                data: String::from_utf8_lossy(&carry).into_owned(),
            });
        }
    })
}

/// Largest prefix length that does not end in the middle of a multi-byte UTF-8 sequence.
/// Invalid bytes are kept in the prefix (they become U+FFFD via lossy decoding).
fn utf8_boundary(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(e) => {
            if e.error_len().is_none() {
                // Incomplete sequence at the very end: hold it back for the next read.
                e.valid_up_to()
            } else {
                bytes.len()
            }
        }
    }
}

#[cfg(unix)]
fn configure_process_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    // New process group led by the child → we can signal the whole tree.
    cmd.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

#[cfg(unix)]
fn kill_group(pid: u32, force: bool) {
    let sig = if force { libc::SIGKILL } else { libc::SIGTERM };
    // Negative pid = the whole process group (the child is the group leader).
    unsafe {
        libc::kill(-(pid as i32), sig);
    }
}

#[cfg(not(unix))]
fn kill_group(pid: u32, force: bool) {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T"]);
    if force {
        cmd.arg("/F");
    }
    let _ = cmd.output();
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn collect(
        runner: &Arc<AgentRunner>,
        req: AgentSpawnRequest,
    ) -> (String, String, AgentEvent) {
        let (tx, rx) = mpsc::channel::<AgentEvent>();
        let tx = Mutex::new(tx);
        let sink: EventSink = Arc::new(move |e| {
            let _ = tx.lock().unwrap().send(e);
        });
        runner.spawn(req, None, sink).expect("spawn");
        let mut out = String::new();
        let mut err = String::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(20)).expect("event") {
                AgentEvent::Output { stream, data, .. } => {
                    if stream == "stdout" {
                        out.push_str(&data)
                    } else {
                        err.push_str(&data)
                    }
                }
                exit @ AgentEvent::Exit { .. } => return (out, err, exit),
            }
        }
    }

    /// True if `pid` exists and is not a zombie (a killed orphan can linger as `Z` when
    /// PID 1 never reaps, e.g. in minimal containers).
    fn process_is_running(pid: i32) -> bool {
        let out = Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .expect("ps");
        let stat = String::from_utf8_lossy(&out.stdout).trim().to_string();
        !stat.is_empty() && !stat.starts_with('Z')
    }

    fn sh(run_id: &str, script: &str) -> AgentSpawnRequest {
        AgentSpawnRequest {
            run_id: run_id.to_string(),
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), script.to_string()],
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            stdin: None,
            env: HashMap::new(),
            timeout_ms: None,
        }
    }

    #[test]
    fn captures_stdout_stderr_and_exit_code() {
        let runner = Arc::new(AgentRunner::new());
        let (out, err, exit) = collect(&runner, sh("t1", "echo hello; echo oops 1>&2; exit 3"));
        assert_eq!(out.trim(), "hello");
        assert_eq!(err.trim(), "oops");
        match exit {
            AgentEvent::Exit { exit_code, timed_out, killed, .. } => {
                assert_eq!(exit_code, Some(3));
                assert!(!timed_out && !killed);
            }
            _ => unreachable!(),
        }
        assert!(runner.active_ids().is_empty());
    }

    #[test]
    fn feeds_prompt_through_stdin() {
        let runner = Arc::new(AgentRunner::new());
        let mut req = sh("t2", "cat");
        req.stdin = Some("prompt with 'quotes', $VARS, `ticks` and ünïcödé\n".to_string());
        let (out, _, exit) = collect(&runner, req);
        assert_eq!(out, "prompt with 'quotes', $VARS, `ticks` and ünïcödé\n");
        assert!(matches!(exit, AgentEvent::Exit { exit_code: Some(0), .. }));
    }

    #[test]
    fn large_output_is_complete_and_ordered_before_exit() {
        let runner = Arc::new(AgentRunner::new());
        let (out, _, exit) = collect(&runner, sh("t3", "i=0; while [ $i -lt 5000 ]; do echo line-$i; i=$((i+1)); done"));
        assert_eq!(out.lines().count(), 5000);
        assert!(out.ends_with("line-4999\n"));
        assert!(matches!(exit, AgentEvent::Exit { exit_code: Some(0), .. }));
    }

    #[test]
    fn timeout_kills_the_whole_process_tree() {
        let runner = Arc::new(AgentRunner::new());
        let marker = format!("/tmp/velix-agent-test-{}", std::process::id());
        let mut req = sh(
            "t4",
            &format!("sleep 30 & echo $! > {}; wait", marker),
        );
        req.timeout_ms = Some(400);
        let started = Instant::now();
        let (_, _, exit) = collect(&runner, req);
        assert!(started.elapsed() < Duration::from_secs(10), "timeout did not fire");
        match exit {
            AgentEvent::Exit { timed_out, signal, .. } => {
                assert!(timed_out);
                assert_eq!(signal, Some(libc::SIGTERM));
            }
            _ => unreachable!(),
        }
        let pid: i32 = std::fs::read_to_string(&marker).unwrap().trim().parse().unwrap();
        let _ = std::fs::remove_file(&marker);
        thread::sleep(Duration::from_millis(200));
        assert!(!process_is_running(pid), "grandchild process survived the group kill");
    }

    #[test]
    fn explicit_kill_stops_a_process_that_ignores_sigterm() {
        let runner = Arc::new(AgentRunner::new());
        let (tx, rx) = mpsc::channel::<AgentEvent>();
        let tx = Mutex::new(tx);
        let sink: EventSink = Arc::new(move |e| {
            let _ = tx.lock().unwrap().send(e);
        });
        runner
            .spawn(sh("t5", "trap '' TERM; echo ready; while true; do sleep 1; done"), None, sink)
            .unwrap();
        // Wait until the trap is installed.
        match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
            AgentEvent::Output { data, .. } => assert!(data.contains("ready")),
            other => panic!("unexpected {:?}", other),
        }
        assert!(runner.kill("t5"));
        let exit = loop {
            if let exit @ AgentEvent::Exit { .. } = rx.recv_timeout(Duration::from_secs(15)).unwrap() {
                break exit;
            }
        };
        match exit {
            AgentEvent::Exit { killed, signal, .. } => {
                assert!(killed);
                assert_eq!(signal, Some(libc::SIGKILL), "SIGTERM was ignored, so SIGKILL must land");
            }
            _ => unreachable!(),
        }
        assert!(!runner.kill("t5"), "run should be gone after exit");
    }

    #[test]
    fn env_and_cwd_are_applied() {
        let runner = Arc::new(AgentRunner::new());
        let mut req = sh("t6", "echo \"$VELIX_TEST_VAR\"; pwd -P");
        req.env.insert("VELIX_TEST_VAR".into(), "swarm".into());
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        req.cwd = dir.to_string_lossy().to_string();
        let (out, _, _) = collect(&runner, req);
        let mut lines = out.lines();
        assert_eq!(lines.next(), Some("swarm"));
        assert_eq!(lines.next(), Some(dir.to_string_lossy().as_ref()));
    }

    #[test]
    fn missing_program_and_cwd_are_reported_synchronously() {
        let runner = Arc::new(AgentRunner::new());
        let sink: EventSink = Arc::new(|_| {});
        let mut req = sh("t7", "true");
        req.program = "/definitely/not/a/real/binary".into();
        let err = runner.spawn(req, None, sink.clone()).unwrap_err();
        assert!(err.contains("Failed to start"), "{}", err);

        let mut req = sh("t8", "true");
        req.cwd = "/no/such/dir".into();
        let err = runner.spawn(req, None, sink).unwrap_err();
        assert!(err.contains("Working directory"), "{}", err);
        assert!(runner.active_ids().is_empty());
    }

    #[test]
    fn duplicate_run_ids_are_rejected() {
        let runner = Arc::new(AgentRunner::new());
        let sink: EventSink = Arc::new(|_| {});
        runner.spawn(sh("dup", "sleep 5"), None, sink.clone()).unwrap();
        let err = runner.spawn(sh("dup", "true"), None, sink).unwrap_err();
        assert!(err.contains("already exists"));
        runner.kill_all();
    }

    #[test]
    fn multibyte_output_is_never_split() {
        let runner = Arc::new(AgentRunner::new());
        // 3-byte characters, enough of them to straddle the 8 KiB read buffer.
        let (out, _, _) = collect(&runner, sh("t9", "i=0; while [ $i -lt 4000 ]; do printf '日本語'; i=$((i+1)); done"));
        assert_eq!(out.chars().count(), 12000);
        assert!(!out.contains('\u{FFFD}'));
    }

    /// The TypeScript side (AgentManager.ts `AgentRunnerEvent`) depends on this exact shape.
    #[test]
    fn events_serialize_to_the_shape_the_frontend_expects() {
        let out = serde_json::to_value(AgentEvent::Output {
            run_id: "r1".into(),
            stream: "stdout".into(),
            data: "hi".into(),
        })
        .unwrap();
        assert_eq!(
            out,
            serde_json::json!({"kind": "output", "run_id": "r1", "stream": "stdout", "data": "hi"})
        );

        let exit = serde_json::to_value(AgentEvent::Exit {
            run_id: "r1".into(),
            exit_code: Some(0),
            signal: None,
            timed_out: false,
            killed: true,
            duration_ms: 12,
            error: None,
        })
        .unwrap();
        assert_eq!(
            exit,
            serde_json::json!({
                "kind": "exit", "run_id": "r1", "exit_code": 0, "signal": null,
                "timed_out": false, "killed": true, "duration_ms": 12, "error": null
            })
        );
    }

    #[test]
    fn spawn_request_deserializes_from_the_frontend_payload() {
        let req: AgentSpawnRequest = serde_json::from_value(serde_json::json!({
            "runId": "swarm_1", "program": "claude", "args": ["-p"], "cwd": "/w",
            "stdin": "prompt", "env": {"A": "b"}, "timeoutMs": 1200000
        }))
        .unwrap();
        assert_eq!(req.run_id, "swarm_1");
        assert_eq!(req.timeout_ms, Some(1_200_000));
        assert_eq!(req.env.get("A").map(String::as_str), Some("b"));

        // Optional fields may be omitted entirely.
        let minimal: AgentSpawnRequest = serde_json::from_value(serde_json::json!({
            "runId": "r", "program": "x", "cwd": "/"
        }))
        .unwrap();
        assert!(minimal.args.is_empty() && minimal.stdin.is_none() && minimal.timeout_ms.is_none());
    }

    #[test]
    fn streams_a_stream_json_style_cli_end_to_end() {
        // A stand-in for `claude -p --output-format stream-json`: reads the prompt on stdin,
        // emits JSON lines, then the result event.
        let runner = Arc::new(AgentRunner::new());
        let script = r#"read -r prompt; printf '{"type":"assistant","message":{"content":[{"type":"text","text":"working on %s"}]}}\n' "$prompt"; printf '{"type":"result","result":"done","is_error":false}\n'"#;
        let mut req = sh("t10", script);
        req.stdin = Some("the-task\n".to_string());
        let (out, _, exit) = collect(&runner, req);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("working on the-task"));
        assert!(lines[1].contains("\"result\":\"done\""));
        assert!(matches!(exit, AgentEvent::Exit { exit_code: Some(0), .. }));
    }

    #[test]
    fn utf8_boundary_holds_back_partial_sequences() {
        let bytes = "é".as_bytes(); // 2 bytes
        assert_eq!(utf8_boundary(&bytes[..1]), 0);
        assert_eq!(utf8_boundary(bytes), 2);
        let mut mixed = b"ab".to_vec();
        mixed.push(0xE6); // first byte of a 3-byte char
        assert_eq!(utf8_boundary(&mixed), 2);
    }
}
