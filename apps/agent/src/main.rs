use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const VERSION: &str = "0.1.0-rust";

#[derive(Clone, Debug)]
struct Config {
    base_url: String,
    install_id: String,
    agent_home: String,
    state_file: String,
    log_file: String,
    service_mode: String,
    interval_ms: u64,
    config_path: String,
}

#[derive(Clone, Debug, Default)]
struct State {
    agent_id: String,
    token: String,
    node_name: String,
    enrolled_at: String,
    last_seen_at: String,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let command = env::args().nth(1).unwrap_or_else(|| "status".to_string());
    match command.as_str() {
        "daemon" | "run" => run_daemon(),
        "once" | "probe" => {
            let config = load_config()?;
            let state = run_once(&config)?;
            println!("{}", state_to_json(&state));
            Ok(())
        }
        "status" | "s" | "active" | "info" => status(),
        "menu" | "m" => menu(),
        "logs" | "log" | "l" => {
            let lines = env::args()
                .nth(2)
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(120);
            print_logs(lines)
        }
        "doctor" | "check" | "d" => doctor(),
        "restart" | "r" => restart(),
        "update" | "u" => update_self(),
        "config" | "path" | "p" => {
            println!("{}", load_config()?.config_path);
            Ok(())
        }
        "version" | "v" => {
            println!("{VERSION}");
            Ok(())
        }
        _ => {
            println!("Usage: pk [status|menu|once|logs|doctor|restart|update|config|version]");
            Ok(())
        }
    }
}

fn run_daemon() -> Result<(), String> {
    let config = load_config()?;
    log_line(&config, &format!("PulseDeck Rust Agent {VERSION} starting"));
    loop {
        if let Err(error) = run_once(&config) {
            log_line(&config, &format!("probe cycle failed: {error}"));
        }
        thread::sleep(Duration::from_millis(config.interval_ms.max(5_000)));
    }
}

fn run_once(config: &Config) -> Result<State, String> {
    let mut state = load_state(&config.state_file);
    if state.agent_id.is_empty() || state.token.is_empty() {
        state = enroll(config, state)?;
    }

    let metrics = collect_metrics_json();
    let diagnostics = collect_diagnostics_json(config);

    post_json(
        config,
        &format!("/api/v1/agents/{}/heartbeat", url_component(&state.agent_id)),
        &state.token,
        &format!(
            "{{\"version\":\"{}\",\"platform\":\"{}\",\"arch\":\"{}\",\"installDir\":\"{}\",\"serviceMode\":\"{}\",\"addresses\":[]}}",
            json_escape(VERSION),
            json_escape(os_name()),
            json_escape(arch_name()),
            json_escape(&config.agent_home),
            json_escape(&config.service_mode)
        ),
    )?;

    post_json(
        config,
        &format!("/api/v1/agents/{}/metrics", url_component(&state.agent_id)),
        &state.token,
        &format!("{{\"metrics\":{metrics},\"addresses\":[],\"reportedLinks\":[]}}"),
    )?;

    post_json(
        config,
        &format!("/api/v1/agents/{}/diagnostics", url_component(&state.agent_id)),
        &state.token,
        &diagnostics,
    )?;

    poll_commands(config, &state)?;

    state.last_seen_at = now_string();
    save_state(&config.state_file, &state)?;
    log_line(config, "probe cycle completed");
    Ok(state)
}

fn enroll(config: &Config, mut state: State) -> Result<State, String> {
    let body = format!(
        "{{\"version\":\"{}\",\"platform\":\"{}\",\"arch\":\"{}\",\"installDir\":\"{}\",\"serviceMode\":\"{}\",\"addresses\":[]}}",
        json_escape(VERSION),
        json_escape(os_name()),
        json_escape(arch_name()),
        json_escape(&config.agent_home),
        json_escape(&config.service_mode)
    );
    let response = post_json(
        config,
        &format!("/api/v1/agents/enroll/{}", url_component(&config.install_id)),
        "",
        &body,
    )?;
    state.agent_id = json_get_string(&response, "agentId").unwrap_or_default();
    state.token = json_get_string(&response, "token").unwrap_or_default();
    state.node_name = json_get_string(&response, "name").unwrap_or_default();
    if state.agent_id.is_empty() || state.token.is_empty() {
        return Err("panel enrollment response did not include agentId/token".to_string());
    }
    if state.enrolled_at.is_empty() {
        state.enrolled_at = now_string();
    }
    save_state(&config.state_file, &state)?;
    Ok(state)
}

fn poll_commands(config: &Config, state: &State) -> Result<(), String> {
    let response = get_json(
        config,
        &format!("/api/v1/agents/{}/commands", url_component(&state.agent_id)),
        &state.token,
    )?;
    for (command_id, command_type) in parse_command_items(&response) {
        let result = match command_type.as_str() {
            "diagnostics" => collect_diagnostics_json(config),
            "metrics" | "probe" => collect_metrics_json(),
            "restart" => "{\"message\":\"restart acknowledged by Rust Agent\"}".to_string(),
            "sing-box-install" | "sing-box-reinstall" | "sing-box-render" | "sing-box-apply" | "sing-box-restart" => {
                format!(
                    "{{\"message\":\"{} is planned for the Rust Agent command runner\",\"agentVersion\":\"{}\"}}",
                    json_escape(&command_type),
                    json_escape(VERSION)
                )
            }
            _ => format!("{{\"message\":\"unknown command {}\"}}", json_escape(&command_type)),
        };
        post_json(
            config,
            &format!(
                "/api/v1/agents/{}/commands/{}/result",
                url_component(&state.agent_id),
                url_component(&command_id)
            ),
            &state.token,
            &format!(
                "{{\"status\":\"succeeded\",\"result\":{{\"finishedAt\":\"{}\",\"data\":{}}}}}",
                json_escape(&now_string()),
                result
            ),
        )?;
    }
    Ok(())
}

fn load_config() -> Result<Config, String> {
    let config_path = find_config_path();
    let raw = fs::read_to_string(&config_path).map_err(|error| format!("cannot read config {}: {error}", config_path.display()))?;
    let agent_home = json_get_string(&raw, "agentHome").unwrap_or_else(|| parent_parent(&config_path));
    let state_file = json_get_string(&raw, "stateFile").unwrap_or_else(|| format!("{agent_home}/state/agent-state.json"));
    let log_file = json_get_string(&raw, "logFile").unwrap_or_else(|| format!("{agent_home}/state/agent.log"));
    Ok(Config {
        base_url: json_get_string(&raw, "baseUrl").unwrap_or_default(),
        install_id: json_get_string(&raw, "installId").unwrap_or_default(),
        agent_home,
        state_file,
        log_file,
        service_mode: json_get_string(&raw, "serviceMode").unwrap_or_else(|| "unknown".to_string()),
        interval_ms: json_get_number(&raw, "intervalMs").unwrap_or(30_000),
        config_path: config_path.to_string_lossy().to_string(),
    })
}

fn find_config_path() -> PathBuf {
    let mut candidates = Vec::new();
    if let Ok(value) = env::var("PULSEDECK_AGENT_CONFIG") {
        if !value.is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }
    candidates.push(PathBuf::from("/etc/pulsedeck/agent.json"));
    if let Ok(home) = env::var("HOME") {
        candidates.push(PathBuf::from(home).join(".pulsedeck/etc/agent.json"));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("/etc/pulsedeck/agent.json"))
}

fn parent_parent(path: &Path) -> String {
    path.parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("/var/lib/pulsedeck"))
        .to_string_lossy()
        .to_string()
}

fn load_state(file: &str) -> State {
    let raw = fs::read_to_string(file).unwrap_or_default();
    State {
        agent_id: json_get_string(&raw, "agentId").unwrap_or_default(),
        token: json_get_string(&raw, "token").unwrap_or_default(),
        node_name: json_get_string(&raw, "nodeName").unwrap_or_default(),
        enrolled_at: json_get_string(&raw, "enrolledAt").unwrap_or_default(),
        last_seen_at: json_get_string(&raw, "lastSeenAt").unwrap_or_default(),
    }
}

fn save_state(file: &str, state: &State) -> Result<(), String> {
    let target = Path::new(file);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("cannot create state dir: {error}"))?;
    }
    let tmp = format!("{}.{}.tmp", file, std::process::id());
    fs::write(&tmp, format!("{}\n", state_to_json(state))).map_err(|error| format!("cannot write state: {error}"))?;
    fs::rename(&tmp, file).map_err(|error| format!("cannot replace state: {error}"))?;
    Ok(())
}

fn state_to_json(state: &State) -> String {
    format!(
        "{{\"agentId\":\"{}\",\"token\":\"{}\",\"nodeName\":\"{}\",\"enrolledAt\":\"{}\",\"lastSeenAt\":\"{}\"}}",
        json_escape(&state.agent_id),
        json_escape(&state.token),
        json_escape(&state.node_name),
        json_escape(&state.enrolled_at),
        json_escape(&state.last_seen_at)
    )
}

fn collect_metrics_json() -> String {
    let meminfo = fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let loadavg = fs::read_to_string("/proc/loadavg").unwrap_or_default();
    let uptime = fs::read_to_string("/proc/uptime").unwrap_or_default();
    let netdev = fs::read_to_string("/proc/net/dev").unwrap_or_default();
    let (mem_total, mem_available) = parse_meminfo(&meminfo);
    let mem_used = mem_total.saturating_sub(mem_available);
    let mem_usage = if mem_total > 0 {
        (mem_used as f64 / mem_total as f64 * 1000.0).round() / 10.0
    } else {
        0.0
    };
    let (load_one, load_five, load_fifteen) = parse_loadavg(&loadavg);
    let uptime_seconds = uptime
        .split_whitespace()
        .next()
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    format!(
        "{{\"collectedAt\":\"{}\",\"platform\":\"{}\",\"arch\":\"{}\",\"release\":\"{}\",\"hostname\":\"{}\",\"uptimeSeconds\":{},\"cpu\":{{\"cores\":{},\"load\":{{\"one\":{},\"five\":{},\"fifteen\":{}}},\"usagePercent\":null}},\"memory\":{{\"totalBytes\":{},\"availableBytes\":{},\"usedBytes\":{},\"usagePercent\":{}}},\"network\":{{\"interfaces\":{},\"addresses\":[]}},\"collector\":{{\"runtime\":\"rust\",\"version\":\"{}\"}}}}",
        json_escape(&now_string()),
        json_escape(os_name()),
        json_escape(arch_name()),
        json_escape(&kernel_release()),
        json_escape(&hostname()),
        uptime_seconds,
        cpu_count(),
        load_one,
        load_five,
        load_fifteen,
        mem_total,
        mem_available,
        mem_used,
        mem_usage,
        parse_netdev_json(&netdev),
        json_escape(VERSION)
    )
}

fn collect_diagnostics_json(config: &Config) -> String {
    let checks = vec![
        check_json("config-readable", Path::new(&config.config_path).is_file(), ""),
        check_json("state-dir-writable", writable_parent(&config.state_file), ""),
        check_json("proc-net-readable", Path::new("/proc/net/dev").is_file(), ""),
        check_json("curl-present", command_exists("curl"), ""),
        check_json("systemd-present", command_exists("systemctl"), ""),
        check_json("openrc-present", command_exists("rc-service"), ""),
        check_json("lxc-hints", lxc_hints(), ""),
    ];
    format!(
        "{{\"collectedAt\":\"{}\",\"version\":\"{}\",\"runtime\":\"rust\",\"platform\":\"{}\",\"arch\":\"{}\",\"serviceMode\":\"{}\",\"checks\":[{}]}}",
        json_escape(&now_string()),
        json_escape(VERSION),
        json_escape(os_name()),
        json_escape(arch_name()),
        json_escape(&config.service_mode),
        checks.join(",")
    )
}

fn check_json(name: &str, ok: bool, detail: &str) -> String {
    format!(
        "{{\"name\":\"{}\",\"ok\":{},\"detail\":\"{}\"}}",
        json_escape(name),
        if ok { "true" } else { "false" },
        json_escape(detail)
    )
}

fn status() -> Result<(), String> {
    let config = load_config()?;
    let state = load_state(&config.state_file);
    println!("PulseDeck Rust Agent {VERSION}");
    println!("config: {}", config.config_path);
    println!("state: {}", config.state_file);
    println!("panel: {}", empty_dash(&config.base_url));
    println!("install: {}", mask(&config.install_id));
    println!("agent: {}", mask(&state.agent_id));
    println!("node: {}", empty_dash(&state.node_name));
    println!("service: {}", empty_dash(&config.service_mode));
    println!("last seen: {}", empty_dash(&state.last_seen_at));
    println!("collector: rust-native planned, rust-control active");
    Ok(())
}

fn doctor() -> Result<(), String> {
    let config = load_config()?;
    println!("PulseDeck Rust Agent doctor ({VERSION})");
    println!("platform: {}/{}", os_name(), arch_name());
    println!("config: {}", config.config_path);
    println!("state: {}", config.state_file);
    println!("{}", collect_diagnostics_json(&config));
    Ok(())
}

fn print_logs(lines: usize) -> Result<(), String> {
    let config = load_config()?;
    let raw = fs::read_to_string(&config.log_file).unwrap_or_default();
    if raw.is_empty() {
        println!("No log file at {}", config.log_file);
        return Ok(());
    }
    let rows: Vec<&str> = raw.lines().collect();
    let start = rows.len().saturating_sub(lines);
    for row in &rows[start..] {
        println!("{row}");
    }
    Ok(())
}

fn restart() -> Result<(), String> {
    if command_exists("systemctl") {
        let _ = Command::new("systemctl").args(["restart", "pulsedeck-agent.service"]).status();
        println!("restart requested through systemd");
        return Ok(());
    }
    if command_exists("rc-service") {
        let _ = Command::new("rc-service").args(["pulsedeck-agent", "restart"]).status();
        println!("restart requested through OpenRC");
        return Ok(());
    }
    println!("No supported service manager found. Stop the current Agent process and run: pk daemon");
    Ok(())
}

fn update_self() -> Result<(), String> {
    let config = load_config()?;
    let current = env::current_exe().map_err(|error| format!("cannot resolve current executable: {error}"))?;
    let target = agent_target();
    let url = format!("{}/api/v1/agents/runtime/{}", config.base_url, target);
    let next = format!("{}.next", current.to_string_lossy());
    let backup = format!("{}.bak", current.to_string_lossy());
    download_to(&url, &next)?;
    let _ = fs::copy(&current, &backup);
    fs::rename(&next, &current).map_err(|error| format!("cannot replace Agent binary: {error}"))?;
    println!("Agent binary updated. Backup: {backup}");
    Ok(())
}

fn menu() -> Result<(), String> {
    println!("PulseDeck Rust Agent");
    println!("1. status");
    println!("2. run once");
    println!("3. logs");
    println!("4. doctor");
    println!("5. restart");
    println!("6. update");
    println!("7. config path");
    print!("Select action [1-7]: ");
    let _ = io::stdout().flush();
    let mut answer = String::new();
    io::stdin()
        .read_line(&mut answer)
        .map_err(|error| format!("cannot read selection: {error}"))?;
    match answer.trim() {
        "1" => status(),
        "2" => {
            let config = load_config()?;
            println!("{}", state_to_json(&run_once(&config)?));
            Ok(())
        }
        "3" => print_logs(120),
        "4" => doctor(),
        "5" => restart(),
        "6" => update_self(),
        "7" => {
            println!("{}", load_config()?.config_path);
            Ok(())
        }
        _ => status(),
    }
}

fn post_json(config: &Config, endpoint: &str, token: &str, body: &str) -> Result<String, String> {
    let url = absolute_url(config, endpoint);
    let mut command = Command::new("curl");
    command.args(["-fsS", "-X", "POST", "-H", "content-type: application/json"]);
    if !token.is_empty() {
        command.args(["-H", &format!("authorization: Bearer {token}")]);
    }
    command.args(["--data-binary", body, &url]);
    run_capture(command)
}

fn get_json(config: &Config, endpoint: &str, token: &str) -> Result<String, String> {
    let url = absolute_url(config, endpoint);
    let mut command = Command::new("curl");
    command.args(["-fsS"]);
    if !token.is_empty() {
        command.args(["-H", &format!("authorization: Bearer {token}")]);
    }
    command.arg(&url);
    run_capture(command)
}

fn download_to(url: &str, target: &str) -> Result<(), String> {
    let status = Command::new("curl")
        .args(["-fsSL", url, "-o", target])
        .status()
        .map_err(|error| format!("cannot run curl: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("download failed from {url}"))
    }
}

fn run_capture(mut command: Command) -> Result<String, String> {
    let output = command.output().map_err(|error| format!("cannot run curl: {error}"))?;
    if output.status.success() {
        String::from_utf8(output.stdout).map_err(|error| format!("response is not utf8: {error}"))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("request failed: {stderr}"))
    }
}

fn absolute_url(config: &Config, endpoint: &str) -> String {
    if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
        endpoint.to_string()
    } else {
        format!("{}{}", config.base_url.trim_end_matches('/'), endpoint)
    }
}

fn parse_command_items(raw: &str) -> Vec<(String, String)> {
    let mut items = Vec::new();
    for part in raw.split("\"id\"").skip(1) {
        let object = format!("{{\"id\"{part}");
        let id = json_get_string(&object, "id").unwrap_or_default();
        let kind = json_get_string(&object, "type").unwrap_or_else(|| "probe".to_string());
        if !id.is_empty() {
            items.push((id, kind));
        }
    }
    items
}

fn json_get_string(raw: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let start = raw.find(&needle)?;
    let after_key = &raw[start + needle.len()..];
    let colon = after_key.find(':')?;
    let mut rest = after_key[colon + 1..].trim_start().chars();
    if rest.next()? != '"' {
        return None;
    }
    let mut value = String::new();
    let mut escaped = false;
    for ch in rest {
        if escaped {
            value.push(match ch {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                '"' => '"',
                '\\' => '\\',
                other => other,
            });
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            return Some(value);
        }
        value.push(ch);
    }
    None
}

fn json_get_number(raw: &str, key: &str) -> Option<u64> {
    let needle = format!("\"{key}\"");
    let start = raw.find(&needle)?;
    let after_key = &raw[start + needle.len()..];
    let colon = after_key.find(':')?;
    let rest = after_key[colon + 1..].trim_start();
    let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    digits.parse::<u64>().ok()
}

fn json_escape(input: &str) -> String {
    let mut out = String::new();
    for ch in input.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

fn url_component(input: &str) -> String {
    input
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => vec![byte as char],
            other => format!("%{other:02X}").chars().collect(),
        })
        .collect()
}

fn now_string() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_secs();
    format!("{seconds}")
}

fn log_line(config: &Config, line: &str) {
    if let Some(parent) = Path::new(&config.log_file).parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&config.log_file) {
        let _ = writeln!(file, "{} {}", now_string(), line);
    }
}

fn parse_meminfo(raw: &str) -> (u64, u64) {
    let mut total = 0;
    let mut available = 0;
    for line in raw.lines() {
        if let Some(value) = line.strip_prefix("MemTotal:") {
            total = value.split_whitespace().next().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) * 1024;
        }
        if let Some(value) = line.strip_prefix("MemAvailable:") {
            available = value.split_whitespace().next().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) * 1024;
        }
    }
    (total, available)
}

fn parse_loadavg(raw: &str) -> (f64, f64, f64) {
    let mut values = raw.split_whitespace().filter_map(|value| value.parse::<f64>().ok());
    (
        values.next().unwrap_or(0.0),
        values.next().unwrap_or(0.0),
        values.next().unwrap_or(0.0),
    )
}

fn parse_netdev_json(raw: &str) -> String {
    let mut rows = Vec::new();
    for line in raw.lines().skip(2) {
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        let iface = name.trim();
        if iface.is_empty() || iface == "lo" {
            continue;
        }
        let cols: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|value| value.parse::<u64>().ok())
            .collect();
        let rx = cols.first().copied().unwrap_or(0);
        let tx = cols.get(8).copied().unwrap_or(0);
        rows.push(format!(
            "{{\"name\":\"{}\",\"rxBytes\":{},\"txBytes\":{}}}",
            json_escape(iface),
            rx,
            tx
        ));
    }
    format!("[{}]", rows.join(","))
}

fn command_exists(name: &str) -> bool {
    env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .map(|dir| Path::new(dir).join(name))
        .any(|path| path.is_file())
}

fn writable_parent(file: &str) -> bool {
    let Some(parent) = Path::new(file).parent() else {
        return false;
    };
    fs::create_dir_all(parent).is_ok()
}

fn lxc_hints() -> bool {
    fs::read_to_string("/proc/1/cgroup")
        .unwrap_or_default()
        .to_ascii_lowercase()
        .contains("lxc")
}

fn os_name() -> &'static str {
    env::consts::OS
}

fn arch_name() -> &'static str {
    env::consts::ARCH
}

fn agent_target() -> &'static str {
    match env::consts::ARCH {
        "x86_64" => "linux-x64",
        "aarch64" => "linux-arm64",
        "arm" => "linux-armv7l",
        _ => "unsupported",
    }
}

fn kernel_release() -> String {
    fs::read_to_string("/proc/sys/kernel/osrelease")
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn hostname() -> String {
    fs::read_to_string("/etc/hostname")
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn cpu_count() -> usize {
    fs::read_to_string("/proc/cpuinfo")
        .unwrap_or_default()
        .lines()
        .filter(|line| line.starts_with("processor"))
        .count()
        .max(1)
}

fn mask(value: &str) -> String {
    if value.is_empty() {
        return "-".to_string();
    }
    if value.len() <= 12 {
        return value.to_string();
    }
    format!("{}...{}", &value[..6], &value[value.len() - 4..])
}

fn empty_dash(value: &str) -> &str {
    if value.is_empty() {
        "-"
    } else {
        value
    }
}

#[allow(dead_code)]
fn read_all(path: &str) -> String {
    let mut buf = String::new();
    if let Ok(mut file) = fs::File::open(path) {
        let _ = file.read_to_string(&mut buf);
    }
    buf
}
