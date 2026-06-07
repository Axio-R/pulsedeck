use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::net::TcpStream;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const VERSION: &str = "0.2.7-rust";
const DEFAULT_SING_BOX_VERSION: &str = "1.11.15";

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

#[derive(Clone, Debug, Default)]
struct AgentCommand {
    id: String,
    kind: String,
    payload_json: String,
    node_json: String,
}

#[derive(Clone, Debug, Default)]
struct NodeProtocol {
    id: String,
    kind: String,
    name: String,
    port: u16,
    listen: String,
    enabled: bool,
    variant: String,
    transport: String,
    security: String,
    settings_json: String,
}

#[derive(Clone, Debug, Default)]
struct RenderedConfig {
    config_path: String,
    work_dir: String,
    protocol_count: usize,
    reported_links: Vec<String>,
}

#[derive(Clone, Debug, Default)]
struct ApplyOutcome {
    binary_path: String,
    version: String,
    config_path: String,
    restarted: bool,
    message: String,
}

#[derive(Clone, Debug, Default)]
struct RuntimeManifest {
    version: String,
    target: String,
    available: bool,
    size_bytes: u64,
    sha256: String,
    download_url: String,
}

#[derive(Clone, Debug, Default)]
struct PublicGeo {
    ip: String,
    region: String,
    country_code: String,
    city: String,
    source: String,
    cached_at: u64,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let Some(command) = env::args().nth(1) else {
        return menu();
    };
    match command.as_str() {
        "daemon" | "run" => run_daemon(),
        "once" | "probe" => {
            let config = load_config()?;
            let state = run_once(&config)?;
            println!("{}", state_to_json(&state));
            Ok(())
        }
        "status" | "s" | "active" => status(),
        "info" | "i" => info(),
        "menu" | "m" => menu(),
        "logs" | "log" | "l" => {
            let lines = env::args()
                .nth(2)
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(120);
            print_logs(lines)
        }
        "doctor" | "check" | "d" => doctor(),
        "install" | "install-service" | "repair-service" | "service-install" => install_service_command(),
        "service" | "service-status" | "service-state" => service_status(),
        "stop" => stop_agent_service(),
        "uninstall" | "remove" | "delete" => {
            let assume_yes = env::args().any(|arg| arg == "--yes" || arg == "-y");
            uninstall_agent(assume_yes)
        }
        "update-check" | "check-update" => update_check(),
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
        "help" | "-h" | "--help" => {
            println!("用法：pk [status|info|menu|once|logs|doctor|install-service|service-status|stop|restart|update-check|update|uninstall|config|version]");
            println!("直接运行 `pk` 会打开交互菜单。");
            Ok(())
        }
        _ => menu(),
    }
}

fn run_daemon() -> Result<(), String> {
    let config = load_config()?;
    log_line(&config, &format!("PulseDeck Rust Agent {VERSION} 启动"));
    let mut control_started = false;
    loop {
        match run_once(&config) {
            Ok(state) => {
                if !control_started && !state.agent_id.is_empty() && !state.token.is_empty() {
                    let control_config = config.clone();
                    thread::spawn(move || control_loop(control_config));
                    control_started = true;
                }
            }
            Err(error) => {
                log_line(&config, &format!("探测周期失败：{error}"));
            }
        }
        thread::sleep(Duration::from_millis(config.interval_ms.max(5_000)));
    }
}

fn control_loop(config: Config) {
    loop {
        if let Err(error) = control_stream_once(&config) {
            log_line(&config, &format!("控制通道断开：{error}"));
        }
        thread::sleep(Duration::from_secs(5));
    }
}

fn control_stream_once(config: &Config) -> Result<(), String> {
    let state = load_state(&config.state_file);
    if state.agent_id.is_empty() || state.token.is_empty() {
        return Err("Agent 尚未完成注册".to_string());
    }
    let endpoint = format!(
        "/api/v1/agents/{}/control/stream?token={}",
        url_component(&state.agent_id),
        url_component(&state.token)
    );
    let (host, port, path) = parse_http_ws_target(config, &endpoint)?;
    let mut stream = TcpStream::connect((host.as_str(), port)).map_err(|error| format!("无法连接控制通道：{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| format!("无法设置控制通道读取超时：{error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| format!("无法设置控制通道写入超时：{error}"))?;
    let key = websocket_key();
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer {}\r\n\r\n",
        state.token
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("控制通道握手发送失败：{error}"))?;
    let response = read_http_upgrade_response(&mut stream)?;
    if !response.starts_with("HTTP/1.1 101") && !response.starts_with("HTTP/1.0 101") {
        return Err("控制通道握手被面板拒绝".to_string());
    }
    log_line(config, "控制通道已连接");
    ws_send_json(
        &mut stream,
        &format!(
            "{{\"type\":\"hello\",\"version\":\"{}\",\"platform\":\"{}\",\"arch\":\"{}\",\"installDir\":\"{}\",\"serviceMode\":\"{}\",\"addresses\":{}}}",
            json_escape(VERSION),
            json_escape(os_name()),
            json_escape(arch_name()),
            json_escape(&config.agent_home),
            json_escape(&config.service_mode),
            collect_addresses_json()
        ),
    )?;

    loop {
        match ws_read_text(&mut stream)? {
            Some(text) => {
                if let Some(agent_command) = parse_control_command(&text) {
                    run_control_command(config, &state, &mut stream, &agent_command)?;
                }
            }
            None => {
                ws_send_json(
                    &mut stream,
                    &format!(
                        "{{\"type\":\"heartbeat\",\"version\":\"{}\",\"platform\":\"{}\",\"arch\":\"{}\",\"serviceMode\":\"{}\"}}",
                        json_escape(VERSION),
                        json_escape(os_name()),
                        json_escape(arch_name()),
                        json_escape(&config.service_mode)
                    ),
                )?;
            }
        }
    }
}

fn run_control_command(config: &Config, state: &State, stream: &mut TcpStream, agent_command: &AgentCommand) -> Result<(), String> {
    ws_send_json(
        stream,
        &format!(
            "{{\"type\":\"command.event\",\"commandId\":\"{}\",\"stream\":\"state\",\"message\":\"{}\",\"payload\":{{\"status\":\"running\",\"transport\":\"websocket\"}}}}",
            json_escape(&agent_command.id),
            json_escape(&format!("开始执行 {}", agent_command.kind))
        ),
    )?;
    let (status, result) = execute_agent_command(config, state, agent_command);
    let event_message = if status == "failed" {
        result_message(&result).unwrap_or_else(|| "命令执行失败".to_string())
    } else {
        "命令已完成，正在通过控制通道上报结果".to_string()
    };
    ws_send_json(
        stream,
        &format!(
            "{{\"type\":\"command.event\",\"commandId\":\"{}\",\"stream\":\"{}\",\"message\":\"{}\",\"payload\":{{\"status\":\"{}\",\"transport\":\"websocket\"}}}}",
            json_escape(&agent_command.id),
            if status == "failed" { "stderr" } else { "stdout" },
            json_escape(&event_message),
            json_escape(&status)
        ),
    )?;
    ws_send_json(
        stream,
        &format!(
            "{{\"type\":\"command.result\",\"commandId\":\"{}\",\"status\":\"{}\",\"result\":{{\"finishedAt\":\"{}\",\"data\":{}}}}}",
            json_escape(&agent_command.id),
            json_escape(&status),
            json_escape(&now_string()),
            result
        ),
    )
}

fn run_once(config: &Config) -> Result<State, String> {
    let mut state = load_state(&config.state_file);
    if state.agent_id.is_empty() || state.token.is_empty() {
        state = enroll(config, state)?;
    }

    let addresses = collect_addresses_json();
    let metrics = collect_metrics_json();
    let diagnostics = collect_diagnostics_json(config);

    post_json(
        config,
        &format!("/api/v1/agents/{}/heartbeat", url_component(&state.agent_id)),
        &state.token,
        &format!(
            "{{\"version\":\"{}\",\"platform\":\"{}\",\"arch\":\"{}\",\"installDir\":\"{}\",\"serviceMode\":\"{}\",\"addresses\":{}}}",
            json_escape(VERSION),
            json_escape(os_name()),
            json_escape(arch_name()),
            json_escape(&config.agent_home),
            json_escape(&config.service_mode),
            &addresses
        ),
    )?;

    post_json(
        config,
        &format!("/api/v1/agents/{}/metrics", url_component(&state.agent_id)),
        &state.token,
        &format!("{{\"metrics\":{metrics},\"addresses\":{},\"reportedLinks\":[]}}", &addresses),
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
    log_line(config, "探测周期完成");
    Ok(state)
}

fn enroll(config: &Config, mut state: State) -> Result<State, String> {
    let addresses = collect_addresses_json();
    let body = format!(
        "{{\"version\":\"{}\",\"platform\":\"{}\",\"arch\":\"{}\",\"installDir\":\"{}\",\"serviceMode\":\"{}\",\"addresses\":{}}}",
        json_escape(VERSION),
        json_escape(os_name()),
        json_escape(arch_name()),
        json_escape(&config.agent_home),
        json_escape(&config.service_mode),
        &addresses
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
        return Err("面板注册响应缺少 agentId/token".to_string());
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
    for agent_command in parse_command_items(&response) {
        let _ = post_command_event(
            config,
            state,
            &agent_command,
            "state",
            "state",
            &format!("开始执行 {}", agent_command.kind),
            "{}",
        );
        let (status, result) = execute_agent_command(config, state, &agent_command);
        let event_message = if status == "failed" {
            result_message(&result).unwrap_or_else(|| "命令执行失败".to_string())
        } else {
            "命令已完成，正在上报结果".to_string()
        };
        let _ = post_command_event(
            config,
            state,
            &agent_command,
            if status == "failed" { "error" } else { "progress" },
            if status == "failed" { "stderr" } else { "stdout" },
            &event_message,
            &format!("{{\"status\":\"{}\"}}", json_escape(&status)),
        );
        post_json(
            config,
            &format!(
                "/api/v1/agents/{}/commands/{}/result",
                url_component(&state.agent_id),
                url_component(&agent_command.id)
            ),
            &state.token,
            &format!(
                "{{\"status\":\"{}\",\"result\":{{\"finishedAt\":\"{}\",\"data\":{}}}}}",
                json_escape(&status),
                json_escape(&now_string()),
                result
            ),
        )?;
    }
    Ok(())
}

fn execute_agent_command(config: &Config, state: &State, agent_command: &AgentCommand) -> (String, String) {
    let outcome = match agent_command.kind.as_str() {
        "diagnostics" => Ok(collect_diagnostics_json(config)),
        "metrics" | "probe" => Ok(collect_metrics_json()),
        "restart" => restart().map(|_| "{\"message\":\"Agent 已请求重启\"}".to_string()),
        "reset-links" | "protocol-add" | "protocol-delete" => render_and_apply_sing_box(config, state, agent_command),
        "sing-box-install" => install_or_update_sing_box(config, agent_command, false),
        "sing-box-reinstall" => install_or_update_sing_box(config, agent_command, true),
        "sing-box-render" => render_sing_box_result(config, state, agent_command),
        "sing-box-apply" => render_and_apply_sing_box(config, state, agent_command),
        "sing-box-restart" => restart_sing_box_result(config),
        _ => Ok(format!("{{\"message\":\"未知命令 {}\"}}", json_escape(&agent_command.kind))),
    };

    match outcome {
        Ok(result) => ("succeeded".to_string(), result),
        Err(error) => (
            "failed".to_string(),
            format!(
                "{{\"message\":\"{}\",\"agentVersion\":\"{}\",\"commandType\":\"{}\"}}",
                json_escape(&error),
                json_escape(VERSION),
                json_escape(&agent_command.kind)
            ),
        ),
    }
}

fn result_message(result_json: &str) -> Option<String> {
    let message = json_get_string(result_json, "message")?;
    let trimmed = message.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
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

fn collect_addresses_json() -> String {
    let mut rows = Vec::new();
    let output = Command::new("ip")
        .args(["-o", "addr", "show", "scope", "global"])
        .output();
    if let Ok(output) = output {
        if output.status.success() {
            let raw = String::from_utf8_lossy(&output.stdout);
            for line in raw.lines() {
                let cols: Vec<&str> = line.split_whitespace().collect();
                if cols.len() < 4 {
                    continue;
                }
                let iface = cols.get(1).copied().unwrap_or("").trim_end_matches(':');
                let family = match cols.get(2).copied().unwrap_or("") {
                    "inet" => "ipv4",
                    "inet6" => "ipv6",
                    _ => continue,
                };
                let cidr = cols.get(3).copied().unwrap_or("");
                let address = cidr.split('/').next().unwrap_or("");
                if address.is_empty() || iface.is_empty() {
                    continue;
                }
                rows.push(format!(
                    "{{\"interface\":\"{}\",\"family\":\"{}\",\"address\":\"{}\",\"cidr\":\"{}\"}}",
                    json_escape(iface),
                    json_escape(family),
                    json_escape(address),
                    json_escape(cidr)
                ));
            }
        }
    }

    if rows.is_empty() {
        let output = Command::new("hostname").arg("-I").output();
        if let Ok(output) = output {
            if output.status.success() {
                let raw = String::from_utf8_lossy(&output.stdout);
                rows.extend(raw.split_whitespace().filter(|address| !address.is_empty()).map(|address| {
                    let family = if address.contains(':') { "ipv6" } else { "ipv4" };
                    format!(
                        "{{\"interface\":\"hostname\",\"family\":\"{}\",\"address\":\"{}\",\"cidr\":\"\"}}",
                        family,
                        json_escape(address)
                    )
                }));
            }
        }
    }

    for geo in public_geos() {
        if !geo.ip.trim().is_empty() && !rows.iter().any(|row| row.contains(&format!("\"address\":\"{}\"", json_escape(&geo.ip)))) {
            rows.push(public_geo_address_json(&geo));
        }
    }

    if rows.is_empty() {
        "[]".to_string()
    } else {
        format!("[{}]", rows.join(","))
    }
}

fn public_geos() -> Vec<PublicGeo> {
    if env::var("PULSEDECK_PUBLIC_GEO")
        .map(|value| matches!(value.as_str(), "0" | "false" | "off" | "disabled"))
        .unwrap_or(false)
    {
        return Vec::new();
    }
    let mut rows = Vec::new();
    for family in ["4", "6"] {
        if let Some(cached) = read_public_geo_cache_for(family) {
            rows.push(cached);
            continue;
        }
        if let Some(geo) = fetch_public_geo_family(family) {
            write_public_geo_cache_for(family, &geo);
            rows.push(geo);
        }
    }
    if rows.is_empty() {
        if let Some(geo) = public_geo() {
            rows.push(geo);
        }
    }
    let mut unique = Vec::new();
    for row in rows {
        if !unique.iter().any(|item: &PublicGeo| item.ip == row.ip) {
            unique.push(row);
        }
    }
    unique
}

fn public_geo() -> Option<PublicGeo> {
    if env::var("PULSEDECK_PUBLIC_GEO")
        .map(|value| matches!(value.as_str(), "0" | "false" | "off" | "disabled"))
        .unwrap_or(false)
    {
        return None;
    }
    if let Some(cached) = read_public_geo_cache() {
        return Some(cached);
    }
    let geo = fetch_public_geo()?;
    write_public_geo_cache(&geo);
    Some(geo)
}

fn read_public_geo_cache_for(family: &str) -> Option<PublicGeo> {
    let raw = fs::read_to_string(public_geo_cache_file_for(family)).ok()?;
    let cached_at = json_get_number(&raw, "cachedAt").unwrap_or(0);
    let now = unix_seconds();
    if cached_at == 0 || now.saturating_sub(cached_at) > 21_600 {
        return None;
    }
    let geo = PublicGeo {
        ip: json_get_string(&raw, "ip").unwrap_or_default(),
        region: json_get_string(&raw, "region").unwrap_or_default(),
        country_code: json_get_string(&raw, "countryCode").unwrap_or_default(),
        city: json_get_string(&raw, "city").unwrap_or_default(),
        source: json_get_string(&raw, "source").unwrap_or_else(|| format!("agent-public-ipv{family}")),
        cached_at,
    };
    if geo.ip.trim().is_empty() {
        None
    } else {
        Some(geo)
    }
}

fn read_public_geo_cache() -> Option<PublicGeo> {
    let raw = fs::read_to_string(public_geo_cache_file()).ok()?;
    let cached_at = json_get_number(&raw, "cachedAt").unwrap_or(0);
    let now = unix_seconds();
    if cached_at == 0 || now.saturating_sub(cached_at) > 21_600 {
        return None;
    }
    let geo = PublicGeo {
        ip: json_get_string(&raw, "ip").unwrap_or_default(),
        region: json_get_string(&raw, "region").unwrap_or_default(),
        country_code: json_get_string(&raw, "countryCode").unwrap_or_default(),
        city: json_get_string(&raw, "city").unwrap_or_default(),
        source: json_get_string(&raw, "source").unwrap_or_else(|| "agent-public-lookup".to_string()),
        cached_at,
    };
    if geo.ip.trim().is_empty() {
        None
    } else {
        Some(geo)
    }
}

fn fetch_public_geo() -> Option<PublicGeo> {
    fetch_public_geo_with_args(&[], "agent-public-lookup")
}

fn fetch_public_geo_family(family: &str) -> Option<PublicGeo> {
    match family {
        "4" => fetch_public_geo_with_args(&["-4"], "agent-public-ipv4"),
        "6" => fetch_public_geo_with_args(&["-6"], "agent-public-ipv6"),
        _ => None,
    }
}

fn fetch_public_geo_with_args(extra_args: &[&str], source: &str) -> Option<PublicGeo> {
    if !command_exists("curl") {
        return None;
    }
    let mut command = Command::new("curl");
    command.args(["-fsS", "--max-time", "2"]);
    command.args(extra_args);
    let output = command
        .arg("https://ipapi.co/json/")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let ip = json_get_string(&raw, "ip").unwrap_or_default();
    if ip.trim().is_empty() {
        return None;
    }
    Some(PublicGeo {
        ip,
        region: json_get_string(&raw, "region")
            .or_else(|| json_get_string(&raw, "country_name"))
            .unwrap_or_default(),
        country_code: json_get_string(&raw, "country_code")
            .or_else(|| json_get_string(&raw, "countryCode"))
            .or_else(|| json_get_string(&raw, "country"))
            .unwrap_or_default(),
        city: json_get_string(&raw, "city").unwrap_or_default(),
        source: source.to_string(),
        cached_at: unix_seconds(),
    })
}

fn write_public_geo_cache(geo: &PublicGeo) {
    let file = public_geo_cache_file();
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        file,
        format!(
            "{{\"ip\":\"{}\",\"region\":\"{}\",\"countryCode\":\"{}\",\"city\":\"{}\",\"source\":\"{}\",\"cachedAt\":{}}}\n",
            json_escape(&geo.ip),
            json_escape(&geo.region),
            json_escape(&geo.country_code),
            json_escape(&geo.city),
            json_escape(&geo.source),
            geo.cached_at
        ),
    );
}

fn write_public_geo_cache_for(family: &str, geo: &PublicGeo) {
    let file = public_geo_cache_file_for(family);
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        file,
        format!(
            "{{\"ip\":\"{}\",\"region\":\"{}\",\"countryCode\":\"{}\",\"city\":\"{}\",\"source\":\"{}\",\"cachedAt\":{}}}\n",
            json_escape(&geo.ip),
            json_escape(&geo.region),
            json_escape(&geo.country_code),
            json_escape(&geo.city),
            json_escape(&geo.source),
            geo.cached_at
        ),
    );
}

fn public_geo_cache_file() -> PathBuf {
    public_geo_cache_base_file("public-geo.json")
}

fn public_geo_cache_file_for(family: &str) -> PathBuf {
    public_geo_cache_base_file(&format!("public-geo-ipv{family}.json"))
}

fn public_geo_cache_base_file(name: &str) -> PathBuf {
    if let Ok(home) = env::var("PULSEDECK_AGENT_HOME") {
        if !home.trim().is_empty() {
            return Path::new(&home).join("state").join(name);
        }
    }
    let config_path = find_config_path();
    let raw = fs::read_to_string(&config_path).unwrap_or_default();
    let agent_home = json_get_string(&raw, "agentHome").unwrap_or_else(|| parent_parent(&config_path));
    Path::new(&agent_home).join("state").join(name)
}

fn public_geo_address_json(geo: &PublicGeo) -> String {
    let family = if geo.ip.contains(':') { "ipv6" } else { "ipv4" };
    let interface = if family == "ipv4" {
        "public-lookup-ipv4"
    } else {
        "public-lookup-ipv6"
    };
    format!(
        "{{\"interface\":\"{}\",\"family\":\"{}\",\"address\":\"{}\",\"cidr\":\"\",\"region\":\"{}\",\"countryCode\":\"{}\",\"city\":\"{}\",\"source\":\"{}\"}}",
        json_escape(interface),
        family,
        json_escape(&geo.ip),
        json_escape(&geo.region),
        json_escape(&geo.country_code),
        json_escape(&geo.city),
        json_escape(&geo.source)
    )
}

fn collect_metrics_json() -> String {
    let meminfo = fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let loadavg = fs::read_to_string("/proc/loadavg").unwrap_or_default();
    let uptime = fs::read_to_string("/proc/uptime").unwrap_or_default();
    let netdev = fs::read_to_string("/proc/net/dev").unwrap_or_default();
    let addresses = collect_addresses_json();
    let (mem_total, mem_available) = parse_meminfo(&meminfo);
    let mem_used = mem_total.saturating_sub(mem_available);
    let mem_usage = if mem_total > 0 {
        (mem_used as f64 / mem_total as f64 * 1000.0).round() / 10.0
    } else {
        0.0
    };
    let (load_one, load_five, load_fifteen) = parse_loadavg(&loadavg);
    let cpu_usage = cpu_usage_percent_json();
    let uptime_seconds = uptime
        .split_whitespace()
        .next()
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    format!(
        "{{\"collectedAt\":\"{}\",\"platform\":\"{}\",\"arch\":\"{}\",\"release\":\"{}\",\"hostname\":\"{}\",\"uptimeSeconds\":{},\"cpu\":{{\"cores\":{},\"load\":{{\"one\":{},\"five\":{},\"fifteen\":{}}},\"usagePercent\":{}}},\"memory\":{{\"totalBytes\":{},\"availableBytes\":{},\"usedBytes\":{},\"usagePercent\":{}}},\"network\":{{\"interfaces\":{},\"addresses\":{}}},\"collector\":{{\"runtime\":\"rust\",\"version\":\"{}\"}}}}",
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
        cpu_usage,
        mem_total,
        mem_available,
        mem_used,
        mem_usage,
        parse_netdev_json(&netdev),
        addresses,
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
        check_json("sing-box-present", find_sing_box_binary().is_some(), &find_sing_box_binary().unwrap_or_default()),
        check_json("sing-box-workdir-writable", fs::create_dir_all(sing_box_work_dir(config)).is_ok(), ""),
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
    println!("配置文件：{}", config.config_path);
    println!("状态文件：{}", config.state_file);
    println!("面板地址：{}", empty_dash(&config.base_url));
    println!("安装 ID：{}", mask(&config.install_id));
    println!("Agent ID：{}", mask(&state.agent_id));
    println!("节点名称：{}", empty_dash(&state.node_name));
    println!("服务模式：{}", empty_dash(&config.service_mode));
    println!("最后上报：{}", display_seen_at(&state.last_seen_at));
    println!("采集器：Rust 原生采集已启用，远程控制已启用");
    Ok(())
}

fn info() -> Result<(), String> {
    let config = load_config()?;
    let state = load_state(&config.state_file);
    println!("PulseDeck Rust Agent 信息");
    println!("版本：{VERSION}");
    println!("平台：{}/{}", os_name(), arch_name());
    println!("目标包：{}", agent_target());
    println!("程序路径：{}", env::current_exe().map(|path| path.to_string_lossy().to_string()).unwrap_or_else(|_| "-".to_string()));
    println!("配置文件：{}", config.config_path);
    println!("Agent 目录：{}", config.agent_home);
    println!("状态文件：{}", config.state_file);
    println!("日志文件：{}", config.log_file);
    println!("面板地址：{}", empty_dash(&config.base_url));
    println!("安装 ID：{}", mask(&config.install_id));
    println!("Agent ID：{}", mask(&state.agent_id));
    println!("节点名称：{}", empty_dash(&state.node_name));
    println!("注册时间：{}", display_seen_at(&state.enrolled_at));
    println!("最后上报：{}", display_seen_at(&state.last_seen_at));
    println!("配置服务模式：{}", empty_dash(&config.service_mode));
    println!("服务状态：{}", service_status_summary());
    println!("sing-box 程序：{}", find_sing_box_binary().unwrap_or_else(|| "-".to_string()));
    println!("sing-box 版本：{}", sing_box_version().unwrap_or_else(|| "-".to_string()));
    Ok(())
}

fn doctor() -> Result<(), String> {
    let config = load_config()?;
    println!("PulseDeck Rust Agent 诊断 ({VERSION})");
    println!("平台：{}/{}", os_name(), arch_name());
    println!("配置文件：{}", config.config_path);
    println!("状态文件：{}", config.state_file);
    println!("{}", collect_diagnostics_json(&config));
    Ok(())
}

fn print_logs(lines: usize) -> Result<(), String> {
    let config = load_config()?;
    let raw = fs::read_to_string(&config.log_file).unwrap_or_default();
    if raw.is_empty() {
        println!("暂无日志文件：{}", config.log_file);
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
        println!("已通过 systemd 请求重启 Agent");
        return Ok(());
    }
    if command_exists("rc-service") {
        let _ = Command::new("rc-service").args(["pulsedeck-agent", "restart"]).status();
        println!("已通过 OpenRC 请求重启 Agent");
        return Ok(());
    }
    println!("未找到支持的服务管理器。请停止当前 Agent 进程后运行：pk daemon");
    Ok(())
}

fn install_service_command() -> Result<(), String> {
    let config = load_config()?;
    let mode = install_agent_service(&config)?;
    set_config_service_mode(&config, &mode)?;
    println!("Agent 服务已通过 {mode} 安装或修复");
    println!("服务状态：{}", service_status_summary());
    Ok(())
}

fn install_agent_service(config: &Config) -> Result<String, String> {
    let exe = env::current_exe().map_err(|error| format!("cannot resolve current executable: {error}"))?;
    let exe_path = exe.to_string_lossy().to_string();
    if is_root() && command_exists("systemctl") && Path::new("/run/systemd/system").is_dir() {
        let unit = format!(
            "[Unit]\nDescription=PulseDeck Rust Agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironment=PULSEDECK_AGENT_CONFIG={}\nExecStart={} daemon\nRestart=always\nRestartSec=8\n\n[Install]\nWantedBy=multi-user.target\n",
            config.config_path,
            exe_path
        );
        fs::write("/etc/systemd/system/pulsedeck-agent.service", unit)
            .map_err(|error| format!("cannot write systemd unit: {error}"))?;
        let _ = Command::new("systemctl").arg("daemon-reload").status();
        let status = Command::new("systemctl")
            .args(["enable", "--now", "pulsedeck-agent.service"])
            .status()
            .map_err(|error| format!("cannot run systemctl: {error}"))?;
        if status.success() {
            return Ok("systemd".to_string());
        }
    }

    if is_root() && command_exists("rc-service") && Path::new("/etc/init.d").is_dir() {
        let script = format!(
            "#!/sbin/openrc-run\nname=\"PulseDeck Rust Agent\"\ncommand=\"{}\"\ncommand_args=\"daemon\"\ncommand_background=true\npidfile=\"/run/pulsedeck-agent.pid\"\nexport PULSEDECK_AGENT_CONFIG=\"{}\"\n",
            exe_path,
            config.config_path
        );
        fs::write("/etc/init.d/pulsedeck-agent", script).map_err(|error| format!("cannot write OpenRC script: {error}"))?;
        make_executable(Path::new("/etc/init.d/pulsedeck-agent"))?;
        let _ = Command::new("rc-update").args(["add", "pulsedeck-agent", "default"]).status();
        let status = Command::new("rc-service")
            .args(["pulsedeck-agent", "restart"])
            .status()
            .map_err(|error| format!("cannot run rc-service: {error}"))?;
        if status.success() {
            return Ok("openrc".to_string());
        }
    }

    if command_exists("crontab") {
        install_cron_boot(config, &exe_path)?;
        start_agent_process(config, &exe_path)?;
        return Ok("cron-manual".to_string());
    }

    start_agent_process(config, &exe_path)?;
    Ok("manual".to_string())
}

fn service_status() -> Result<(), String> {
    println!("{}", service_status_summary());
    Ok(())
}

fn service_status_summary() -> String {
    if command_exists("systemctl") {
        if let Ok(output) = Command::new("systemctl").args(["is-active", "pulsedeck-agent.service"]).output() {
            let state = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !state.is_empty() {
                return format!("systemd:{state}");
            }
        }
    }
    if command_exists("rc-service") {
        if let Ok(output) = Command::new("rc-service").args(["pulsedeck-agent", "status"]).output() {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let text = if stdout.is_empty() { stderr } else { stdout };
            if !text.is_empty() {
                return format!("openrc:{text}");
            }
        }
    }
    if command_exists("crontab") {
        if let Ok(output) = Command::new("crontab").arg("-l").output() {
            let raw = String::from_utf8_lossy(&output.stdout);
            if raw.lines().any(|line| line.contains("pulsedeck-agent") && line.contains("daemon")) {
                return "cron:installed".to_string();
            }
        }
    }
    if command_exists("pgrep") {
        if Command::new("pgrep")
            .args(["-f", "pulsedeck-agent daemon"])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return "process:running".to_string();
        }
    }
    "not-running".to_string()
}

fn stop_agent_service() -> Result<(), String> {
    let mut stopped = false;
    if command_exists("systemctl") {
        stopped |= Command::new("systemctl")
            .args(["stop", "pulsedeck-agent.service"])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }
    if command_exists("rc-service") {
        stopped |= Command::new("rc-service")
            .args(["pulsedeck-agent", "stop"])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }
    if !stopped && command_exists("pkill") {
        stopped |= Command::new("pkill")
            .args(["-f", "pulsedeck-agent daemon"])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }
    if stopped {
        println!("已请求停止 Agent");
    } else {
        println!("没有停止任何正在运行的 PulseDeck Agent 服务");
    }
    Ok(())
}

fn update_check() -> Result<(), String> {
    let config = load_config()?;
    let target = agent_target();
    println!("本地版本：{VERSION}");
    println!("目标包：{target}");

    match fetch_runtime_manifest(&config, &target) {
        Ok(manifest) if manifest.available => {
            println!("面板运行时版本：{}", blank_dash(&manifest.version));
            println!("下载地址：{}", runtime_download_url(&config, &target, Some(&manifest)));
            println!("文件大小：{} bytes", manifest.size_bytes);
            println!("SHA-256：{}", blank_dash(&manifest.sha256));
            if manifest.version == VERSION {
                println!("状态：本地 Agent 已是面板发布版本");
            } else {
                println!("状态：发现可更新版本");
            }
        }
        Ok(manifest) => {
            println!("面板运行时版本：{}", blank_dash(&manifest.version));
            println!("下载地址：{}", runtime_download_url(&config, &target, Some(&manifest)));
            println!("状态：当前目标包还未发布");
        }
        Err(error) => {
            let url = runtime_download_url(&config, &target, None);
            let tmp_dir = Path::new(&config.agent_home).join("tmp");
            fs::create_dir_all(&tmp_dir).map_err(|error| format!("cannot create temp dir: {error}"))?;
            let tmp = tmp_dir.join(format!("pulsedeck-agent-update-check.{}", std::process::id()));
            download_to(&url, &tmp.to_string_lossy())?;
            let size = fs::metadata(&tmp).map(|meta| meta.len()).unwrap_or(0);
            let _ = fs::remove_file(&tmp);
            println!("运行时清单不可用：{error}");
            println!("下载地址：{url}");
            println!("最新运行时可下载：{size} bytes");
        }
    }
    println!("运行 `pk update` 可替换本地 Agent 程序");
    Ok(())
}

fn uninstall_agent(assume_yes: bool) -> Result<(), String> {
    let config = load_config()?;
    println!("PulseDeck Agent 卸载");
    println!("配置文件：{}", config.config_path);
    println!("Agent 目录：{}", config.agent_home);
    println!("服务文件：如存在将清理 systemd/OpenRC/cron 配置");
    println!("快捷命令：PK, pk, RK, rk");
    if !assume_yes {
        print!("输入 uninstall 确认卸载：");
        let _ = io::stdout().flush();
        let mut answer = String::new();
        io::stdin()
            .read_line(&mut answer)
            .map_err(|error| format!("cannot read confirmation: {error}"))?;
        if answer.trim() != "uninstall" {
            println!("已取消卸载");
            return Ok(());
        }
    }

    remove_agent_service_files();
    for name in ["PK", "pk", "RK", "rk"] {
        remove_shortcut(name, &config);
    }
    let _ = fs::remove_file(&config.config_path);
    let _ = fs::remove_file(&config.state_file);
    let _ = fs::remove_file(&config.log_file);
    let _ = fs::remove_file(protocols_state_file(&config));
    if safe_agent_home(&config.agent_home) {
        let _ = fs::remove_dir_all(&config.agent_home);
        println!("已删除 Agent 目录 {}", config.agent_home);
    } else {
        println!("自定义 Agent 目录已保留：{}", config.agent_home);
    }
    println!("PulseDeck Agent 卸载完成");
    Ok(())
}

fn update_self() -> Result<(), String> {
    let config = load_config()?;
    let current = env::current_exe().map_err(|error| format!("cannot resolve current executable: {error}"))?;
    let target = agent_target();
    let manifest = fetch_runtime_manifest(&config, &target).ok();
    let url = runtime_download_url(&config, &target, manifest.as_ref());
    let next = format!("{}.next", current.to_string_lossy());
    let backup = format!("{}.bak", current.to_string_lossy());
    download_to(&url, &next)?;
    if let Some(manifest) = manifest.as_ref() {
        if let Err(error) = verify_file_sha256(Path::new(&next), &manifest.sha256) {
            let _ = fs::remove_file(&next);
            return Err(error);
        }
    }
    make_executable(Path::new(&next))?;
    let _ = fs::copy(&current, &backup);
    fs::rename(&next, &current).map_err(|error| format!("cannot replace Agent binary: {error}"))?;
    println!("Agent 程序已更新，备份：{backup}");
    if let Some(manifest) = manifest.as_ref() {
        println!("更新后运行时版本：{}", blank_dash(&manifest.version));
    }
    Ok(())
}

fn menu() -> Result<(), String> {
    println!("PulseDeck Rust Agent");
    println!("1. 安装或修复 Agent 服务");
    println!("2. 删除/卸载 Agent");
    println!("3. 检测 Agent 更新");
    println!("4. 立即更新 Agent");
    println!("5. 查看 Agent 信息");
    println!("6. 查看服务状态");
    println!("7. 停止 Agent");
    println!("8. 立即上报一次");
    println!("9. 查看日志");
    println!("10. 运行诊断");
    println!("11. 重启 Agent");
    println!("12. 查看配置路径");
    println!("0. 退出");
    print!("请选择操作 [0-12]：");
    let _ = io::stdout().flush();
    let mut answer = String::new();
    io::stdin()
        .read_line(&mut answer)
        .map_err(|error| format!("cannot read selection: {error}"))?;
    match answer.trim() {
        "1" => install_service_command(),
        "2" => uninstall_agent(false),
        "3" => update_check(),
        "4" => update_self(),
        "5" => info(),
        "6" => service_status(),
        "7" => stop_agent_service(),
        "8" => {
            let config = load_config()?;
            println!("{}", state_to_json(&run_once(&config)?));
            Ok(())
        }
        "9" => print_logs(120),
        "10" => doctor(),
        "11" => restart(),
        "12" => {
            println!("{}", load_config()?.config_path);
            Ok(())
        }
        "0" => Ok(()),
        _ => status(),
    }
}

fn install_cron_boot(config: &Config, exe_path: &str) -> Result<(), String> {
    let output = Command::new("crontab").arg("-l").output();
    let mut lines = Vec::new();
    if let Ok(output) = output {
        let raw = String::from_utf8_lossy(&output.stdout);
        lines.extend(
            raw.lines()
                .filter(|line| !line.contains("pulsedeck-agent"))
                .map(|line| line.to_string()),
        );
    }
    lines.push(format!(
        "@reboot PULSEDECK_AGENT_CONFIG={} {} daemon >/dev/null 2>&1",
        sh_quote(&config.config_path),
        sh_quote(exe_path)
    ));
    let body = format!("{}\n", lines.join("\n"));
    let mut child = Command::new("crontab")
        .arg("-")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| format!("cannot run crontab: {error}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(body.as_bytes())
            .map_err(|error| format!("cannot write crontab: {error}"))?;
    }
    let status = child.wait().map_err(|error| format!("cannot wait for crontab: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("cannot install Agent @reboot crontab".to_string())
    }
}

fn start_agent_process(config: &Config, exe_path: &str) -> Result<(), String> {
    Command::new(exe_path)
        .arg("daemon")
        .env("PULSEDECK_AGENT_CONFIG", &config.config_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("cannot start Agent daemon: {error}"))
}

fn remove_agent_service_files() {
    if command_exists("systemctl") {
        let _ = Command::new("systemctl").args(["disable", "--now", "pulsedeck-agent.service"]).status();
        let _ = fs::remove_file("/etc/systemd/system/pulsedeck-agent.service");
        let _ = Command::new("systemctl").arg("daemon-reload").status();
    }
    if command_exists("rc-service") {
        let _ = Command::new("rc-service").args(["pulsedeck-agent", "stop"]).status();
    }
    if command_exists("rc-update") {
        let _ = Command::new("rc-update").args(["del", "pulsedeck-agent", "default"]).status();
    }
    let _ = fs::remove_file("/etc/init.d/pulsedeck-agent");
    remove_cron_boot();
}

fn remove_cron_boot() {
    if !command_exists("crontab") {
        return;
    }
    let Ok(output) = Command::new("crontab").arg("-l").output() else {
        return;
    };
    let raw = String::from_utf8_lossy(&output.stdout);
    let kept = raw
        .lines()
        .filter(|line| !line.contains("pulsedeck-agent"))
        .map(|line| line.to_string())
        .collect::<Vec<String>>();
    let body = format!("{}\n", kept.join("\n"));
    if let Ok(mut child) = Command::new("crontab").arg("-").stdin(Stdio::piped()).spawn() {
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = stdin.write_all(body.as_bytes());
        }
        let _ = child.wait();
    }
}

fn remove_shortcut(name: &str, config: &Config) {
    for path in [
        PathBuf::from("/usr/local/bin").join(name),
        Path::new(&config.agent_home).join("bin").join(name),
    ] {
        let raw = fs::read_to_string(&path).unwrap_or_default();
        if raw.contains("PULSEDECK_AGENT_CONFIG") && raw.contains("pulsedeck-agent") {
            let _ = fs::remove_file(path);
        }
    }
}

fn safe_agent_home(path: &str) -> bool {
    let path = Path::new(path);
    if path == Path::new("/var/lib/pulsedeck") || path == Path::new("/opt/pulsedeck") {
        return true;
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name == ".pulsedeck" || name == "pulsedeck")
        .unwrap_or(false)
}

fn set_config_service_mode(config: &Config, service_mode: &str) -> Result<(), String> {
    let raw = fs::read_to_string(&config.config_path).map_err(|error| format!("cannot read config: {error}"))?;
    let next = json_replace_or_insert_string(&raw, "serviceMode", service_mode);
    atomic_write(&config.config_path, &next)
}

fn json_replace_or_insert_string(raw: &str, key: &str, value: &str) -> String {
    let needle = format!("\"{key}\"");
    if let Some(start) = raw.find(&needle) {
        let after_key = &raw[start + needle.len()..];
        if let Some(colon) = after_key.find(':') {
            let value_start = start + needle.len() + colon + 1;
            let whitespace = raw[value_start..]
                .chars()
                .take_while(|ch| ch.is_whitespace())
                .map(|ch| ch.len_utf8())
                .sum::<usize>();
            let string_start = value_start + whitespace;
            if raw[string_start..].starts_with('"') {
                let mut escaped = false;
                for (offset, ch) in raw[string_start + 1..].char_indices() {
                    if escaped {
                        escaped = false;
                    } else if ch == '\\' {
                        escaped = true;
                    } else if ch == '"' {
                        let string_end = string_start + 1 + offset + 1;
                        return format!("{}\"{}\"{}", &raw[..string_start], json_escape(value), &raw[string_end..]);
                    }
                }
            }
        }
    }
    if let Some(end) = raw.rfind('}') {
        let prefix = raw[..end].trim_end();
        let comma = if prefix.ends_with('{') { "" } else { "," };
        return format!("{}{}\n  \"{}\": \"{}\"\n{}", prefix, comma, key, json_escape(value), &raw[end..]);
    }
    format!("{{\"{}\":\"{}\"}}\n", key, json_escape(value))
}

fn sh_quote(input: &str) -> String {
    format!("'{}'", input.replace('\'', "'\"'\"'"))
}

fn is_root() -> bool {
    Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim() == "0")
        .unwrap_or(false)
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

fn post_command_event(config: &Config, state: &State, agent_command: &AgentCommand, kind: &str, stream: &str, message: &str, payload_json: &str) -> Result<String, String> {
    post_json(
        config,
        &format!(
            "/api/v1/agents/{}/commands/{}/events",
            url_component(&state.agent_id),
            url_component(&agent_command.id)
        ),
        &state.token,
        &format!(
            "{{\"type\":\"{}\",\"stream\":\"{}\",\"message\":\"{}\",\"payload\":{}}}",
            json_escape(kind),
            json_escape(stream),
            json_escape(message),
            if payload_json.trim_start().starts_with('{') {
                payload_json
            } else {
                "{}"
            }
        ),
    )
}

fn parse_http_ws_target(config: &Config, endpoint: &str) -> Result<(String, u16, String), String> {
    let base = config.base_url.trim_end_matches('/');
    let rest = base
        .strip_prefix("http://")
        .ok_or_else(|| "当前轻量控制通道仅支持 http 面板地址，已保留 HTTP 轮询兜底".to_string())?;
    let (authority, base_path) = rest.split_once('/').unwrap_or((rest, ""));
    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']').ok_or_else(|| "无效 IPv6 面板地址".to_string())?;
        let host = authority[1..end].to_string();
        let port = authority[end + 1..]
            .strip_prefix(':')
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(80);
        (host, port)
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        (host.to_string(), port.parse::<u16>().unwrap_or(80))
    } else {
        (authority.to_string(), 80)
    };
    if host.trim().is_empty() {
        return Err("面板地址缺少主机名".to_string());
    }
    let prefix = if base_path.trim().is_empty() {
        String::new()
    } else {
        format!("/{}", base_path.trim_matches('/'))
    };
    Ok((host, port, format!("{prefix}{endpoint}")))
}

fn websocket_key() -> String {
    let seed = format!("pulsedeck-agent:{}:{}", std::process::id(), unix_seconds());
    let mut bytes = [0u8; 16];
    for (index, byte) in seed.bytes().enumerate() {
        bytes[index % 16] ^= byte.rotate_left((index % 8) as u32);
    }
    base64_encode(&bytes)
}

fn read_http_upgrade_response(stream: &mut TcpStream) -> Result<String, String> {
    let mut buffer = Vec::new();
    let mut byte = [0u8; 1];
    while buffer.len() < 8192 {
        stream
            .read_exact(&mut byte)
            .map_err(|error| format!("读取控制通道握手失败：{error}"))?;
        buffer.push(byte[0]);
        if buffer.ends_with(b"\r\n\r\n") {
            return String::from_utf8(buffer).map_err(|error| format!("控制通道握手不是 UTF-8：{error}"));
        }
    }
    Err("控制通道握手响应过大".to_string())
}

fn ws_send_json(stream: &mut TcpStream, body: &str) -> Result<(), String> {
    let payload = body.as_bytes();
    let mut frame = Vec::new();
    frame.push(0x81);
    if payload.len() < 126 {
        frame.push(0x80 | payload.len() as u8);
    } else if payload.len() <= 0xffff {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        frame.push(0x80 | 127);
        frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    let mask = [
        (unix_seconds() & 0xff) as u8,
        ((std::process::id() as u64 >> 8) & 0xff) as u8,
        0x42,
        0x24,
    ];
    frame.extend_from_slice(&mask);
    for (index, byte) in payload.iter().enumerate() {
        frame.push(*byte ^ mask[index % 4]);
    }
    stream.write_all(&frame).map_err(|error| format!("控制通道写入失败：{error}"))
}

fn ws_read_text(stream: &mut TcpStream) -> Result<Option<String>, String> {
    let mut header = [0u8; 2];
    if let Err(error) = stream.read_exact(&mut header) {
        if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) {
            return Ok(None);
        }
        return Err(format!("控制通道读取失败：{error}"));
    }
    let opcode = header[0] & 0x0f;
    let masked = (header[1] & 0x80) != 0;
    let mut length = (header[1] & 0x7f) as u64;
    if length == 126 {
        let mut extended = [0u8; 2];
        stream
            .read_exact(&mut extended)
            .map_err(|error| format!("控制通道读取扩展长度失败：{error}"))?;
        length = u16::from_be_bytes(extended) as u64;
    } else if length == 127 {
        let mut extended = [0u8; 8];
        stream
            .read_exact(&mut extended)
            .map_err(|error| format!("控制通道读取扩展长度失败：{error}"))?;
        length = u64::from_be_bytes(extended);
    }
    if length > 4 * 1024 * 1024 {
        return Err("控制通道帧过大".to_string());
    }
    let mut mask = [0u8; 4];
    if masked {
        stream
            .read_exact(&mut mask)
            .map_err(|error| format!("控制通道读取掩码失败：{error}"))?;
    }
    let mut payload = vec![0u8; length as usize];
    stream
        .read_exact(&mut payload)
        .map_err(|error| format!("控制通道读取负载失败：{error}"))?;
    if masked {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % 4];
        }
    }
    match opcode {
        0x1 => String::from_utf8(payload)
            .map(Some)
            .map_err(|error| format!("控制通道文本不是 UTF-8：{error}")),
        0x8 => Err("控制通道被面板关闭".to_string()),
        0x9 => {
            ws_send_json(stream, "{\"type\":\"pong\"}")?;
            Ok(None)
        }
        _ => Ok(None),
    }
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

fn fetch_runtime_manifest(config: &Config, target: &str) -> Result<RuntimeManifest, String> {
    let raw = get_json(
        config,
        &format!("/api/v1/agents/runtime/manifest/{}", url_component(target)),
        "",
    )?;
    let manifest = RuntimeManifest {
        version: json_get_string(&raw, "version").unwrap_or_default(),
        target: json_get_string(&raw, "target").unwrap_or_else(|| target.to_string()),
        available: json_get_bool(&raw, "available").unwrap_or(false),
        size_bytes: json_get_number(&raw, "sizeBytes").unwrap_or(0),
        sha256: json_get_string(&raw, "sha256").unwrap_or_default(),
        download_url: json_get_string(&raw, "downloadUrl").unwrap_or_default(),
    };
    if manifest.target != target {
        return Err(format!("runtime manifest target mismatch: {}", manifest.target));
    }
    Ok(manifest)
}

fn runtime_download_url(config: &Config, target: &str, manifest: Option<&RuntimeManifest>) -> String {
    if let Some(manifest) = manifest {
        if !manifest.download_url.trim().is_empty() {
            return manifest.download_url.clone();
        }
    }
    format!("{}/api/v1/agents/runtime/{}", config.base_url.trim_end_matches('/'), target)
}

fn verify_file_sha256(file: &Path, expected: &str) -> Result<(), String> {
    if expected.trim().is_empty() {
        return Ok(());
    }
    let actual = file_sha256(file)?;
    if actual.eq_ignore_ascii_case(expected.trim()) {
        println!("运行时 SHA-256 校验通过：{actual}");
        Ok(())
    } else {
        Err(format!("运行时 SHA-256 不匹配：期望 {}，实际 {actual}", expected.trim()))
    }
}

fn blank_dash(input: &str) -> &str {
    if input.trim().is_empty() {
        "-"
    } else {
        input
    }
}

fn select_sing_box_download_url(agent_command: &AgentCommand) -> Result<String, String> {
    if let Some(download_url) = json_get_string(&agent_command.payload_json, "downloadUrl") {
        if !download_url.trim().is_empty() {
            return Ok(download_url);
        }
    }
    if let Ok(download_url) = env::var("PULSEDECK_SING_BOX_DOWNLOAD_URL") {
        if !download_url.trim().is_empty() {
            return Ok(download_url);
        }
    }

    let version = json_get_string(&agent_command.payload_json, "version")
        .or_else(|| env::var("PULSEDECK_SING_BOX_VERSION").ok())
        .unwrap_or_else(|| DEFAULT_SING_BOX_VERSION.to_string())
        .trim_start_matches('v')
        .to_string();
    if version.is_empty() {
        return Ok(String::new());
    }
    let target = json_get_string(&agent_command.payload_json, "target")
        .or_else(|| env::var("PULSEDECK_SING_BOX_TARGET").ok())
        .unwrap_or_else(|| env::consts::ARCH.to_string());
    let arch = sing_box_release_arch(target.trim())?;
    let release_base = json_get_string(&agent_command.payload_json, "releaseBaseUrl")
        .or_else(|| env::var("PULSEDECK_SING_BOX_RELEASE_BASE").ok())
        .unwrap_or_else(|| "https://github.com/SagerNet/sing-box/releases/download".to_string())
        .trim_end_matches('/')
        .to_string();
    Ok(format!(
        "{release_base}/v{version}/sing-box-{version}-linux-{arch}.tar.gz"
    ))
}

fn sing_box_release_arch(target: &str) -> Result<&'static str, String> {
    match target {
        "x86_64" | "amd64" | "linux-x64" | "linux-amd64" => Ok("amd64"),
        "aarch64" | "arm64" | "linux-arm64" => Ok("arm64"),
        "arm" | "armv7" | "armv7l" | "linux-armv7l" | "linux-armv7" => Ok("armv7"),
        "i386" | "i686" | "386" | "linux-386" => Ok("386"),
        other => Err(format!("unsupported sing-box release target: {other}")),
    }
}

fn verify_download_checksum(agent_command: &AgentCommand, file: &Path) -> Result<(), String> {
    let expected = json_get_string(&agent_command.payload_json, "sha256")
        .or_else(|| json_get_string(&agent_command.payload_json, "checksum"))
        .or_else(|| env::var("PULSEDECK_SING_BOX_SHA256").ok())
        .unwrap_or_default();
    let expected = expected.split_whitespace().next().unwrap_or("").trim().to_ascii_lowercase();
    if expected.is_empty() {
        return Ok(());
    }
    let actual = file_sha256(file)?;
    if actual == expected {
        Ok(())
    } else {
        Err(format!("sing-box checksum mismatch: expected {expected}, got {actual}"))
    }
}

fn file_sha256(file: &Path) -> Result<String, String> {
    let output = if command_exists("sha256sum") {
        Command::new("sha256sum")
            .arg(file)
            .output()
            .map_err(|error| format!("cannot run sha256sum: {error}"))?
    } else if command_exists("shasum") {
        Command::new("shasum")
            .args(["-a", "256"])
            .arg(file)
            .output()
            .map_err(|error| format!("cannot run shasum: {error}"))?
    } else {
        return Err("sha256 verification requested but sha256sum/shasum was not found".to_string());
    };
    if !output.status.success() {
        return Err("sha256 command failed".to_string());
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    Ok(raw.split_whitespace().next().unwrap_or("").to_ascii_lowercase())
}

fn extract_sing_box_archive(archive: &Path, target: &Path) -> Result<(), String> {
    let tmp_dir = archive
        .parent()
        .unwrap_or_else(|| Path::new("/tmp"))
        .join(format!("sing-box.extract.{}.{}", std::process::id(), now_string()));
    fs::create_dir_all(&tmp_dir).map_err(|error| format!("cannot create extract dir: {error}"))?;
    let archive_arg = archive.to_string_lossy().to_string();
    let tmp_arg = tmp_dir.to_string_lossy().to_string();
    let status = Command::new("tar")
        .args(["-xzf", &archive_arg, "-C", &tmp_arg])
        .status()
        .map_err(|error| format!("cannot run tar: {error}"))?;
    if !status.success() {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err("cannot extract sing-box release archive".to_string());
    }
    let binary = find_named_file(&tmp_dir, "sing-box").ok_or_else(|| "sing-box binary not found in release archive".to_string())?;
    fs::copy(&binary, target).map_err(|error| format!("cannot copy sing-box binary from archive: {error}"))?;
    let _ = fs::remove_dir_all(&tmp_dir);
    Ok(())
}

fn find_named_file(dir: &Path, name: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.file_name().and_then(|item| item.to_str()) == Some(name) {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_named_file(&path, name) {
                return Some(found);
            }
        }
    }
    None
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

fn render_sing_box_result(config: &Config, state: &State, agent_command: &AgentCommand) -> Result<String, String> {
    let rendered = render_sing_box_config(config, state, agent_command, false)?;
    Ok(format!(
        "{{\"message\":\"sing-box 配置已渲染\",\"agentVersion\":\"{}\",\"singBox\":{{\"installed\":{},\"version\":\"{}\",\"binaryPath\":\"{}\",\"configPath\":\"{}\",\"workDir\":\"{}\",\"status\":\"rendered\",\"lastRenderAt\":\"{}\"}},\"protocolCount\":{},\"previewLinks\":{}}}",
        json_escape(VERSION),
        if find_sing_box_binary().is_some() { "true" } else { "false" },
        json_escape(&sing_box_version().unwrap_or_default()),
        json_escape(&find_sing_box_binary().unwrap_or_default()),
        json_escape(&rendered.config_path),
        json_escape(&rendered.work_dir),
        json_escape(&now_string()),
        rendered.protocol_count,
        string_array_json(&rendered.reported_links)
    ))
}

fn render_and_apply_sing_box(config: &Config, state: &State, agent_command: &AgentCommand) -> Result<String, String> {
    if find_sing_box_binary().is_none() {
        return Err("未找到 sing-box 可执行文件；请先下发 sing-box 安装命令或手动安装".to_string());
    }
    let rendered = render_sing_box_config(config, state, agent_command, true)?;
    let applied = apply_sing_box_config(&rendered.config_path)?;
    Ok(format!(
        "{{\"message\":\"{}\",\"agentVersion\":\"{}\",\"reportedLinks\":{},\"singBox\":{{\"installed\":true,\"version\":\"{}\",\"binaryPath\":\"{}\",\"configPath\":\"{}\",\"workDir\":\"{}\",\"serviceMode\":\"{}\",\"status\":\"applied\",\"message\":\"{}\",\"lastRenderAt\":\"{}\",\"lastApplyAt\":\"{}\",\"lastRestartAt\":{},\"updatedAt\":\"{}\"}},\"protocolCount\":{},\"applied\":true,\"serviceRestarted\":{}}}",
        json_escape(&applied.message),
        json_escape(VERSION),
        string_array_json(&rendered.reported_links),
        json_escape(&applied.version),
        json_escape(&applied.binary_path),
        json_escape(&applied.config_path),
        json_escape(&rendered.work_dir),
        json_escape(&config.service_mode),
        json_escape(&applied.message),
        json_escape(&now_string()),
        json_escape(&now_string()),
        if applied.restarted {
            format!("\"{}\"", json_escape(&now_string()))
        } else {
            "null".to_string()
        },
        json_escape(&now_string()),
        rendered.protocol_count,
        if applied.restarted { "true" } else { "false" }
    ))
}

fn restart_sing_box_result(config: &Config) -> Result<String, String> {
    let binary = find_sing_box_binary().ok_or_else(|| "未找到 sing-box 可执行文件".to_string())?;
    let version = sing_box_version().unwrap_or_default();
    let restart = restart_sing_box_service();
    Ok(format!(
        "{{\"message\":\"{}\",\"agentVersion\":\"{}\",\"singBox\":{{\"installed\":true,\"version\":\"{}\",\"binaryPath\":\"{}\",\"serviceMode\":\"{}\",\"status\":\"{}\",\"message\":\"{}\",\"lastRestartAt\":{},\"updatedAt\":\"{}\"}},\"serviceRestarted\":{}}}",
        json_escape(&restart.1),
        json_escape(VERSION),
        json_escape(&version),
        json_escape(&binary),
        json_escape(&config.service_mode),
        if restart.0 { "restarted" } else { "restart-skipped" },
        json_escape(&restart.1),
        if restart.0 {
            format!("\"{}\"", json_escape(&now_string()))
        } else {
            "null".to_string()
        },
        json_escape(&now_string()),
        if restart.0 { "true" } else { "false" }
    ))
}

fn install_or_update_sing_box(config: &Config, agent_command: &AgentCommand, reinstall: bool) -> Result<String, String> {
    if !reinstall {
        if let Some(binary) = find_sing_box_binary() {
            return Ok(sing_box_install_result(config, &binary, "sing-box 已安装"));
        }
    }

    let download_url = select_sing_box_download_url(agent_command)?;
    if download_url.is_empty() {
        return Err("未找到 sing-box 可执行文件，且无法生成默认下载地址；请提供 payload.downloadUrl 或检查系统架构".to_string());
    }

    let bin_dir = Path::new(&config.agent_home).join("bin");
    fs::create_dir_all(&bin_dir).map_err(|error| format!("cannot create sing-box bin dir: {error}"))?;
    let target = bin_dir.join("sing-box");
    let next = bin_dir.join("sing-box.next");
    let archive_download = download_url.ends_with(".tar.gz") || download_url.ends_with(".tgz");
    let download_target = if archive_download {
        bin_dir.join("sing-box.download.tar.gz")
    } else {
        next.clone()
    };
    download_to(&download_url, &download_target.to_string_lossy())?;
    verify_download_checksum(agent_command, &download_target)?;
    if archive_download {
        extract_sing_box_archive(&download_target, &next)?;
        let _ = fs::remove_file(&download_target);
    }
    make_executable(&next)?;
    if target.is_file() {
        let backup = bin_dir.join(format!("sing-box.{}.bak", now_string()));
        let _ = fs::copy(&target, backup);
    }
    fs::rename(&next, &target).map_err(|error| format!("cannot install sing-box binary: {error}"))?;
    verify_sing_box_binary(&target)?;
    let service = ensure_sing_box_service(config, &target);
    let message = format!("sing-box 程序已安装；{}", service.1);
    Ok(sing_box_install_result(config, &target.to_string_lossy(), &message))
}

fn verify_sing_box_binary(binary: &Path) -> Result<(), String> {
    let output = Command::new(binary)
        .arg("version")
        .output()
        .map_err(|error| format!("sing-box 已下载但无法运行：{error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("sing-box 已下载但版本检查失败：{stderr}"))
    }
}

fn ensure_sing_box_service(config: &Config, binary: &Path) -> (bool, String) {
    let config_path = default_sing_box_apply_config_path(config);
    if command_exists("systemctl") || config.service_mode == "systemd" {
        let service = format!(
            "[Unit]\nDescription=sing-box service managed by PulseDeck\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart={} run -c {}\nRestart=on-failure\nRestartSec=5s\nLimitNOFILE=1048576\n\n[Install]\nWantedBy=multi-user.target\n",
            binary.display(),
            config_path
        );
        let path = Path::new("/etc/systemd/system/sing-box.service");
        if fs::write(path, service).is_ok() {
            let _ = Command::new("systemctl").arg("daemon-reload").status();
            let enabled = Command::new("systemctl")
                .args(["enable", "sing-box.service"])
                .status()
                .map(|status| status.success())
                .unwrap_or(false);
            return (enabled, if enabled { "systemd 服务已启用".to_string() } else { "systemd 服务文件已写入，启用失败".to_string() });
        }
        return (false, "无法写入 systemd 服务文件".to_string());
    }
    if command_exists("rc-service") || config.service_mode == "openrc" {
        let script = format!(
            "#!/sbin/openrc-run\nname=\"sing-box\"\ndescription=\"sing-box service managed by PulseDeck\"\ncommand=\"{}\"\ncommand_args=\"run -c {}\"\ncommand_background=true\npidfile=\"/run/sing-box.pid\"\ndepend() {{\n  need net\n}}\n",
            binary.display(),
            config_path
        );
        let path = Path::new("/etc/init.d/sing-box");
        if fs::write(path, script).is_ok() && make_executable(path).is_ok() {
            let enabled = Command::new("rc-update")
                .args(["add", "sing-box", "default"])
                .status()
                .map(|status| status.success())
                .unwrap_or(false);
            return (enabled, if enabled { "OpenRC 服务已启用".to_string() } else { "OpenRC 服务脚本已写入，启用失败".to_string() });
        }
        return (false, "无法写入 OpenRC 服务脚本".to_string());
    }
    (false, "未检测到可配置的服务管理器".to_string())
}

fn default_sing_box_apply_config_path(config: &Config) -> String {
    let system_config = PathBuf::from("/etc/sing-box/config.json");
    if ensure_parent(&system_config).is_ok() {
        system_config.to_string_lossy().to_string()
    } else {
        sing_box_work_dir(config).join("config.json").to_string_lossy().to_string()
    }
}

fn sing_box_install_result(config: &Config, binary: &str, message: &str) -> String {
    format!(
        "{{\"message\":\"{}\",\"agentVersion\":\"{}\",\"singBox\":{{\"installed\":true,\"version\":\"{}\",\"binaryPath\":\"{}\",\"workDir\":\"{}\",\"serviceMode\":\"{}\",\"status\":\"installed\",\"message\":\"{}\",\"updatedAt\":\"{}\"}}}}",
        json_escape(message),
        json_escape(VERSION),
        json_escape(&sing_box_version().unwrap_or_default()),
        json_escape(binary),
        json_escape(&sing_box_work_dir(config).to_string_lossy()),
        json_escape(&config.service_mode),
        json_escape(message),
        json_escape(&now_string())
    )
}

fn render_sing_box_config(config: &Config, state: &State, agent_command: &AgentCommand, apply_target: bool) -> Result<RenderedConfig, String> {
    let work_dir = sing_box_work_dir(config);
    fs::create_dir_all(&work_dir).map_err(|error| format!("cannot create sing-box work dir: {error}"))?;
    let protocols = command_protocols(config, agent_command)?;
    let enabled: Vec<NodeProtocol> = protocols.into_iter().filter(|protocol| protocol.enabled).collect();
    let secret = command_link_secret(state, agent_command);
    let node_name = json_get_string(&agent_command.node_json, "name").unwrap_or_else(|| state.node_name.clone());
    let host = command_public_host(agent_command).unwrap_or_else(|| "127.0.0.1".to_string());
    let config_json = sing_box_config_json(&enabled, &secret)?;
    let config_path = select_sing_box_config_path(config, agent_command, apply_target);
    if apply_target {
        atomic_write_checked_sing_box(&config_path, &config_json)?;
    } else {
        atomic_write(&config_path, &config_json)?;
    }
    save_protocols_state(config, &enabled)?;
    let reported_links = enabled
        .iter()
        .map(|protocol| protocol_link(protocol, &host, &secret, &node_name))
        .collect::<Vec<String>>();
    Ok(RenderedConfig {
        config_path,
        work_dir: work_dir.to_string_lossy().to_string(),
        protocol_count: enabled.len(),
        reported_links,
    })
}

fn command_protocols(config: &Config, agent_command: &AgentCommand) -> Result<Vec<NodeProtocol>, String> {
    let node_protocols = json_get_value(&agent_command.node_json, "protocols").unwrap_or_default();
    if node_protocols.trim_start().starts_with('[') {
        let parsed = parse_protocols(&node_protocols);
        if !parsed.is_empty() || ["protocol-delete", "sing-box-render", "sing-box-apply", "reset-links"].contains(&agent_command.kind.as_str()) {
            return Ok(parsed);
        }
    }

    if let Some(protocol_json) = json_get_value(&agent_command.payload_json, "protocol") {
        if protocol_json.trim_start().starts_with('{') {
            return Ok(vec![parse_protocol(&protocol_json)]);
        }
    }

    Ok(load_protocols_state(config))
}

fn parse_protocols(raw: &str) -> Vec<NodeProtocol> {
    json_array_objects(raw).into_iter().map(|item| parse_protocol(&item)).collect()
}

fn parse_protocol(raw: &str) -> NodeProtocol {
    let kind = json_get_string(raw, "type").unwrap_or_else(|| "vless".to_string());
    let port = normalize_port(json_get_number(raw, "port"), default_protocol_port(&kind));
    NodeProtocol {
        id: json_get_string(raw, "id").unwrap_or_else(|| format!("protocol-{}", now_string())),
        name: json_get_string(raw, "name").unwrap_or_else(|| protocol_display_name(&kind).to_string()),
        port,
        listen: json_get_string(raw, "listen").unwrap_or_else(|| "0.0.0.0".to_string()),
        enabled: json_get_bool(raw, "enabled").unwrap_or(true),
        variant: json_get_string(raw, "variant").unwrap_or_default(),
        transport: json_get_string(raw, "transport").unwrap_or_default(),
        security: json_get_string(raw, "security").unwrap_or_default(),
        settings_json: json_get_value(raw, "settings").unwrap_or_else(|| "{}".to_string()),
        kind,
    }
}

fn sing_box_config_json(protocols: &[NodeProtocol], secret: &str) -> Result<String, String> {
    let mut inbounds = Vec::new();
    for protocol in protocols {
        inbounds.push(protocol_inbound_json(protocol, secret)?);
    }
    Ok(format!(
        "{{\n  \"log\": {{ \"level\": \"info\", \"timestamp\": true }},\n  \"inbounds\": [\n{}\n  ],\n  \"outbounds\": [{{ \"type\": \"direct\", \"tag\": \"direct\" }}]\n}}\n",
        inbounds
            .into_iter()
            .map(|item| indent_json(&item, 4))
            .collect::<Vec<String>>()
            .join(",\n")
    ))
}

fn protocol_inbound_json(protocol: &NodeProtocol, secret: &str) -> Result<String, String> {
    let tag = format!("pd-{}-{}", protocol.kind, protocol.id);
    let listen = if protocol.listen.is_empty() { "0.0.0.0" } else { &protocol.listen };
    let password = protocol_password(protocol, secret);
    let uuid = protocol_uuid(protocol, secret);
    let transport = protocol_transport_json(protocol);
    let tls = protocol_tls_json(protocol, secret)?;
    let common = format!(
        "\"type\":\"{}\",\"tag\":\"{}\",\"listen\":\"{}\",\"listen_port\":{}",
        json_escape(&protocol.kind),
        json_escape(&tag),
        json_escape(listen),
        protocol.port
    );
    let body = match protocol.kind.as_str() {
        "shadowsocks" => {
            let method = json_get_string(&protocol.settings_json, "method")
                .or_else(|| (!protocol.variant.is_empty()).then(|| protocol.variant.clone()))
                .unwrap_or_else(|| "2022-blake3-aes-128-gcm".to_string());
            format!("{common},\"method\":\"{}\",\"password\":\"{}\"", json_escape(&method), json_escape(&password))
        }
        "vmess" => format!("{common},\"users\":[{{\"uuid\":\"{}\",\"alterId\":0}}]{}{}", json_escape(&uuid), transport, tls),
        "vless" => format!("{common},\"users\":[{{\"uuid\":\"{}\",\"flow\":\"{}\"}}]{}{}", json_escape(&uuid), json_escape(&json_get_string(&protocol.settings_json, "flow").unwrap_or_default()), transport, tls),
        "trojan" => format!("{common},\"users\":[{{\"password\":\"{}\"}}]{}{}", json_escape(&password), transport, tls),
        "hysteria2" => {
            let mut fields = vec![
                common,
                format!("\"users\":[{{\"password\":\"{}\"}}]", json_escape(&password)),
            ];
            if let Some(obfs_password) = protocol_setting(protocol, &["obfsPassword", "obfs_password"]) {
                let obfs_type = protocol_setting(protocol, &["obfs", "obfsType"]).unwrap_or_else(|| "salamander".to_string());
                fields.push(format!(
                    "\"obfs\":{{\"type\":\"{}\",\"password\":\"{}\"}}",
                    json_escape(&obfs_type),
                    json_escape(&obfs_password)
                ));
            }
            if let Some(masquerade) = protocol_setting(protocol, &["masquerade"]) {
                fields.push(format!("\"masquerade\":\"{}\"", json_escape(&masquerade)));
            }
            fields.join(",") + &tls
        }
        "tuic" => {
            let mut fields = vec![
                common,
                format!("\"users\":[{{\"uuid\":\"{}\",\"password\":\"{}\"}}]", json_escape(&uuid), json_escape(&password)),
                format!(
                    "\"congestion_control\":\"{}\"",
                    json_escape(&protocol_setting(protocol, &["congestionControl", "congestion_control"]).unwrap_or_else(|| "bbr".to_string()))
                ),
            ];
            if let Some(zero_rtt) = json_get_bool(&protocol.settings_json, "zeroRtt") {
                fields.push(format!("\"zero_rtt_handshake\":{}", if zero_rtt { "true" } else { "false" }));
            }
            fields.join(",") + &tls
        }
        "anytls" => format!("{common},\"users\":[{{\"password\":\"{}\"}}]{}", json_escape(&password), tls),
        other => return Err(format!("unsupported protocol type: {other}")),
    };
    Ok(format!("{{{body}}}"))
}

fn protocol_transport_json(protocol: &NodeProtocol) -> String {
    let transport = protocol_transport_type(protocol);
    if transport.is_empty() {
        return String::new();
    }
    if transport == "grpc" {
        let service_name = protocol_setting(protocol, &["serviceName", "service_name"]).unwrap_or_else(|| "pulsedeck".to_string());
        return format!(
            ",\"transport\":{{\"type\":\"grpc\",\"service_name\":\"{}\"}}",
            json_escape(&service_name)
        );
    }
    if transport == "ws" {
        let path = protocol_setting(protocol, &["path", "wsPath"]).unwrap_or_else(|| "/".to_string());
        let mut fields = vec![
            "\"type\":\"ws\"".to_string(),
            format!("\"path\":\"{}\"", json_escape(&path)),
        ];
        if let Some(host) = protocol_setting(protocol, &["host", "wsHost"]) {
            fields.push(format!("\"headers\":{{\"Host\":\"{}\"}}", json_escape(&host)));
        }
        if let Some(max_early_data) = json_get_number(&protocol.settings_json, "maxEarlyData") {
            fields.push(format!("\"max_early_data\":{max_early_data}"));
        }
        return format!(",\"transport\":{{{}}}", fields.join(","));
    }
    format!(",\"transport\":{{\"type\":\"{}\"}}", json_escape(&transport))
}

fn protocol_tls_json(protocol: &NodeProtocol, secret: &str) -> Result<String, String> {
    let security = protocol_security(protocol);
    if security.is_empty() {
        return Ok(String::new());
    }
    let server_name = protocol_server_name(protocol);
    let certificate_path = protocol_setting(protocol, &["certificatePath", "certPath"]).unwrap_or_default();
    let key_path = protocol_setting(protocol, &["keyPath", "privateKeyPath"]).unwrap_or_default();
    let mut fields = vec!["\"enabled\":true".to_string()];
    if !server_name.is_empty() {
        fields.push(format!("\"server_name\":\"{}\"", json_escape(&server_name)));
    }
    if let Some(alpn) = protocol_alpn(protocol) {
        fields.push(format!("\"alpn\":{}", csv_array_json(&alpn)));
    }
    if let Some(min_version) = protocol_setting(protocol, &["minVersion", "min_version"]) {
        fields.push(format!("\"min_version\":\"{}\"", json_escape(&min_version)));
    }
    if let Some(max_version) = protocol_setting(protocol, &["maxVersion", "max_version"]) {
        fields.push(format!("\"max_version\":\"{}\"", json_escape(&max_version)));
    }
    if security == "reality" {
        let private_key = protocol_setting(protocol, &["privateKey", "private_key", "realityPrivateKey"]).ok_or_else(|| {
            format!("{} reality requires settings.privateKey generated by `sing-box generate reality-keypair`", protocol_display_name(&protocol.kind))
        })?;
        let handshake_server = protocol_setting(protocol, &["handshakeServer", "handshake", "dest", "serverName"])
            .unwrap_or_else(|| "www.cloudflare.com".to_string());
        let handshake_port = json_get_number(&protocol.settings_json, "handshakePort")
            .or_else(|| json_get_number(&protocol.settings_json, "serverPort"))
            .unwrap_or(443);
        let short_id = protocol_reality_short_id(protocol, secret);
        fields.push(format!(
            "\"reality\":{{\"enabled\":true,\"handshake\":{{\"server\":\"{}\",\"server_port\":{}}},\"private_key\":\"{}\",\"short_id\":[\"{}\"]}}",
            json_escape(&handshake_server),
            handshake_port,
            json_escape(&private_key),
            json_escape(&short_id)
        ));
        return Ok(format!(",\"tls\":{{{}}}", fields.join(",")));
    }
    if !certificate_path.is_empty() && !key_path.is_empty() {
        fields.push(format!("\"certificate_path\":\"{}\"", json_escape(&certificate_path)));
        fields.push(format!("\"key_path\":\"{}\"", json_escape(&key_path)));
    } else {
        return Err(format!(
            "{} {} requires settings.certificatePath and settings.keyPath for TLS",
            protocol_display_name(&protocol.kind),
            if protocol.variant.is_empty() { protocol.security.as_str() } else { protocol.variant.as_str() }
        ));
    }
    Ok(format!(",\"tls\":{{{}}}", fields.join(",")))
}

fn apply_sing_box_config(config_path: &str) -> Result<ApplyOutcome, String> {
    let binary = find_sing_box_binary().ok_or_else(|| "未找到 sing-box 可执行文件；请先下发 sing-box 安装命令或手动安装".to_string())?;
    let version = sing_box_version().unwrap_or_default();
    let check = Command::new(&binary)
        .args(["check", "-c", config_path])
        .output()
        .map_err(|error| format!("cannot run sing-box check: {error}"))?;
    if !check.status.success() {
        let stderr = String::from_utf8_lossy(&check.stderr);
        let stdout = String::from_utf8_lossy(&check.stdout);
        return Err(format!("sing-box 配置检查失败：{}{}", stdout, stderr));
    }
    let restart = restart_sing_box_service();
    Ok(ApplyOutcome {
        binary_path: binary,
        version,
        config_path: config_path.to_string(),
        restarted: restart.0,
        message: restart.1,
    })
}

fn restart_sing_box_service() -> (bool, String) {
    if command_exists("systemctl") {
        if Command::new("systemctl").args(["restart", "sing-box.service"]).status().map(|status| status.success()).unwrap_or(false) {
            return (true, "sing-box 已通过 systemd 重启".to_string());
        }
    }
    if command_exists("rc-service") {
        if Command::new("rc-service").args(["sing-box", "restart"]).status().map(|status| status.success()).unwrap_or(false) {
            return (true, "sing-box 已通过 OpenRC 重启".to_string());
        }
    }
    if command_exists("service") {
        if Command::new("service").args(["sing-box", "restart"]).status().map(|status| status.success()).unwrap_or(false) {
            return (true, "sing-box 已通过 service 重启".to_string());
        }
    }
    (false, "sing-box 配置已通过检查；未能通过已知服务管理器完成重启".to_string())
}

fn select_sing_box_config_path(config: &Config, agent_command: &AgentCommand, apply_target: bool) -> String {
    if let Some(path) = json_get_string(&agent_command.payload_json, "configPath") {
        if !path.trim().is_empty() {
            return path;
        }
    }
    if let Ok(path) = env::var("PULSEDECK_SING_BOX_CONFIG") {
        if !path.trim().is_empty() {
            return path;
        }
    }
    if apply_target {
        let system_config = PathBuf::from("/etc/sing-box/config.json");
        if ensure_parent(&system_config).is_ok() {
            return system_config.to_string_lossy().to_string();
        }
    }
    sing_box_work_dir(config).join("config.json").to_string_lossy().to_string()
}

fn sing_box_work_dir(config: &Config) -> PathBuf {
    Path::new(&config.agent_home).join("sing-box")
}

fn protocols_state_file(config: &Config) -> PathBuf {
    Path::new(&config.state_file)
        .parent()
        .unwrap_or_else(|| Path::new(&config.agent_home))
        .join("sing-box-protocols.json")
}

fn save_protocols_state(config: &Config, protocols: &[NodeProtocol]) -> Result<(), String> {
    let body = format!(
        "[{}]",
        protocols
            .iter()
            .map(protocol_state_json)
            .collect::<Vec<String>>()
            .join(",")
    );
    atomic_write(&protocols_state_file(config).to_string_lossy(), &body)
}

fn load_protocols_state(config: &Config) -> Vec<NodeProtocol> {
    let raw = fs::read_to_string(protocols_state_file(config)).unwrap_or_default();
    parse_protocols(&raw)
}

fn protocol_state_json(protocol: &NodeProtocol) -> String {
    format!(
        "{{\"id\":\"{}\",\"type\":\"{}\",\"name\":\"{}\",\"port\":{},\"listen\":\"{}\",\"enabled\":{},\"variant\":\"{}\",\"transport\":\"{}\",\"security\":\"{}\",\"settings\":{}}}",
        json_escape(&protocol.id),
        json_escape(&protocol.kind),
        json_escape(&protocol.name),
        protocol.port,
        json_escape(&protocol.listen),
        if protocol.enabled { "true" } else { "false" },
        json_escape(&protocol.variant),
        json_escape(&protocol.transport),
        json_escape(&protocol.security),
        if protocol.settings_json.trim_start().starts_with('{') {
            protocol.settings_json.clone()
        } else {
            "{}".to_string()
        }
    )
}

fn protocol_link(protocol: &NodeProtocol, host: &str, secret: &str, node_name: &str) -> String {
    let label = url_component(&format!("{}-{}-{}", node_name, protocol_display_name(&protocol.kind), protocol.port));
    let host_part = link_host(host);
    let password = protocol_password(protocol, secret);
    let uuid = protocol_uuid(protocol, secret);
    let transport = protocol_transport_type(protocol);
    let security = protocol_security(protocol);
    let server_name = protocol_server_name(protocol);
    let alpn = protocol_alpn(protocol).unwrap_or_default();
    match protocol.kind.as_str() {
        "shadowsocks" => {
            let method = json_get_string(&protocol.settings_json, "method")
                .or_else(|| (!protocol.variant.is_empty()).then(|| protocol.variant.clone()))
                .unwrap_or_else(|| "2022-blake3-aes-128-gcm".to_string());
            let userinfo = base64_encode(format!("{method}:{password}").as_bytes());
            format!("ss://{}@{}:{}#{}", userinfo, host_part, protocol.port, label)
        }
        "vmess" => {
            let path = protocol_setting(protocol, &["path", "wsPath"]).unwrap_or_else(|| if transport == "ws" { "/".to_string() } else { String::new() });
            let host_header = protocol_setting(protocol, &["host", "wsHost"]).unwrap_or_default();
            let body = format!(
                "{{\"v\":\"2\",\"ps\":\"{}\",\"add\":\"{}\",\"port\":\"{}\",\"id\":\"{}\",\"aid\":\"0\",\"net\":\"{}\",\"type\":\"none\",\"host\":\"{}\",\"path\":\"{}\",\"tls\":\"{}\",\"sni\":\"{}\",\"alpn\":\"{}\"}}",
                json_escape(&format!("{} {}", node_name, protocol.name)),
                json_escape(host),
                protocol.port,
                json_escape(&uuid),
                json_escape(if transport.is_empty() { "tcp" } else { &transport }),
                json_escape(&host_header),
                json_escape(&path),
                json_escape(if security == "reality" { "tls" } else { &security }),
                json_escape(&server_name),
                json_escape(&alpn)
            );
            format!("vmess://{}", base64_encode(body.as_bytes()))
        }
        "vless" => {
            let mut params = vec![
                ("encryption", "none".to_string()),
                ("security", security.clone()),
                ("sni", server_name.clone()),
                ("alpn", alpn.clone()),
                ("type", if transport.is_empty() { "tcp".to_string() } else { transport.clone() }),
                ("path", protocol_setting(protocol, &["path", "wsPath"]).unwrap_or_default()),
                ("host", protocol_setting(protocol, &["host", "wsHost"]).unwrap_or_default()),
                ("serviceName", protocol_setting(protocol, &["serviceName", "service_name"]).unwrap_or_default()),
                ("flow", protocol_setting(protocol, &["flow"]).unwrap_or_default()),
            ];
            if security == "reality" {
                params.push(("fp", protocol_setting(protocol, &["fingerprint", "fp"]).unwrap_or_else(|| "chrome".to_string())));
                params.push(("pbk", protocol_setting(protocol, &["publicKey", "realityPublicKey", "pbk"]).unwrap_or_default()));
                params.push(("sid", protocol_reality_short_id(protocol, secret)));
            }
            format!("vless://{}@{}:{}{}#{}", uuid, host_part, protocol.port, link_query(params), label)
        }
        "trojan" => {
            let query = link_query(vec![
                ("security", if security.is_empty() { "tls".to_string() } else { security.clone() }),
                ("sni", server_name.clone()),
                ("alpn", alpn.clone()),
                ("type", transport.clone()),
                ("path", protocol_setting(protocol, &["path", "wsPath"]).unwrap_or_default()),
                ("host", protocol_setting(protocol, &["host", "wsHost"]).unwrap_or_default()),
                ("serviceName", protocol_setting(protocol, &["serviceName", "service_name"]).unwrap_or_default()),
            ]);
            format!("trojan://{}@{}:{}{}#{}", url_component(&password), host_part, protocol.port, query, label)
        }
        "hysteria2" => {
            let query = link_query(vec![
                ("sni", server_name.clone()),
                ("alpn", alpn.clone()),
                ("obfs", protocol_setting(protocol, &["obfs", "obfsType"]).unwrap_or_default()),
                ("obfs-password", protocol_setting(protocol, &["obfsPassword", "obfs_password"]).unwrap_or_default()),
            ]);
            format!("hysteria2://{}@{}:{}{}#{}", url_component(&password), host_part, protocol.port, query, label)
        }
        "tuic" => {
            let query = link_query(vec![
                ("sni", server_name.clone()),
                ("alpn", alpn.clone()),
                ("congestion_control", protocol_setting(protocol, &["congestionControl", "congestion_control"]).unwrap_or_else(|| "bbr".to_string())),
            ]);
            format!("tuic://{}:{}@{}:{}{}#{}", uuid, url_component(&password), host_part, protocol.port, query, label)
        }
        "anytls" => {
            let query = link_query(vec![
                ("sni", server_name.clone()),
                ("alpn", alpn.clone()),
                ("security", if security.is_empty() { "tls".to_string() } else { security.clone() }),
            ]);
            format!("anytls://{}@{}:{}{}#{}", url_component(&password), host_part, protocol.port, query, label)
        }
        _ => format!("{}://{}:{}", protocol.kind, host_part, protocol.port),
    }
}

fn command_link_secret(state: &State, agent_command: &AgentCommand) -> String {
    json_get_string(&agent_command.payload_json, "linkSecret")
        .or_else(|| json_get_string(&agent_command.node_json, "linkSecret"))
        .unwrap_or_else(|| {
            if state.agent_id.is_empty() {
                "pulsedeck".to_string()
            } else {
                state.agent_id.clone()
            }
        })
}

fn command_public_host(agent_command: &AgentCommand) -> Option<String> {
    let network = json_get_value(&agent_command.node_json, "network").unwrap_or_default();
    json_get_string(&network, "primaryIpv4")
        .or_else(|| json_get_string(&network, "primaryIpv6"))
        .or_else(|| first_address(&agent_command.node_json))
}

fn first_address(node_json: &str) -> Option<String> {
    let addresses = json_get_value(node_json, "addresses")?;
    for item in json_array_objects(&addresses) {
        if let Some(address) = json_get_string(&item, "address") {
            if !address.is_empty() {
                return Some(address);
            }
        }
    }
    None
}

fn parse_command_items(raw: &str) -> Vec<AgentCommand> {
    json_array_field_objects(raw, "items")
        .into_iter()
        .filter_map(|object| parse_command_object(&object))
        .collect()
}

fn parse_control_command(raw: &str) -> Option<AgentCommand> {
    if json_get_string(raw, "type").unwrap_or_default() != "command" {
        return None;
    }
    let object = json_get_value(raw, "command")?;
    parse_command_object(&object)
}

fn parse_command_object(object: &str) -> Option<AgentCommand> {
    let id = json_get_string(object, "id").unwrap_or_default();
    if id.is_empty() {
        return None;
    }
    Some(AgentCommand {
        id,
        kind: json_get_string(object, "type").unwrap_or_else(|| "probe".to_string()),
        payload_json: json_get_value(object, "payload").unwrap_or_else(|| "{}".to_string()),
        node_json: json_get_value(object, "node").unwrap_or_else(|| "{}".to_string()),
    })
}

fn json_array_field_objects(raw: &str, key: &str) -> Vec<String> {
    let Some(value) = json_get_value(raw, key) else {
        return Vec::new();
    };
    json_array_objects(&value)
}

fn json_array_objects(raw: &str) -> Vec<String> {
    let mut objects = Vec::new();
    let mut in_string = false;
    let mut escaped = false;
    let mut depth = 0usize;
    let mut start = None;
    for (index, ch) in raw.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == '{' {
            if depth == 0 {
                start = Some(index);
            }
            depth += 1;
            continue;
        }
        if ch == '}' && depth > 0 {
            depth -= 1;
            if depth == 0 {
                if let Some(start_index) = start {
                    objects.push(raw[start_index..=index].to_string());
                }
                start = None;
            }
        }
    }
    objects
}

fn json_get_value(raw: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let start = raw.find(&needle)?;
    let after_key = &raw[start + needle.len()..];
    let colon = after_key.find(':')?;
    let rest = after_key[colon + 1..].trim_start();
    let mut chars = rest.char_indices();
    let (_, first) = chars.next()?;
    if first == '"' {
        let mut escaped = false;
        for (index, ch) in chars {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == '"' {
                return Some(rest[..=index].to_string());
            }
        }
        return None;
    }
    if first == '{' || first == '[' {
        let open = first;
        let close = if first == '{' { '}' } else { ']' };
        let mut depth = 1usize;
        let mut in_string = false;
        let mut escaped = false;
        for (index, ch) in chars {
            if in_string {
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    in_string = false;
                }
                continue;
            }
            if ch == '"' {
                in_string = true;
                continue;
            }
            if ch == open {
                depth += 1;
            } else if ch == close {
                depth -= 1;
                if depth == 0 {
                    return Some(rest[..=index].to_string());
                }
            }
        }
        return None;
    }
    let end = rest
        .find(|ch: char| ch == ',' || ch == '}' || ch == ']')
        .unwrap_or(rest.len());
    Some(rest[..end].trim().to_string())
}

fn json_get_bool(raw: &str, key: &str) -> Option<bool> {
    match json_get_value(raw, key)?.as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn find_sing_box_binary() -> Option<String> {
    if let Ok(path) = env::var("PULSEDECK_SING_BOX_BIN") {
        if Path::new(&path).is_file() {
            return Some(path);
        }
    }
    if let Some(path) = installed_sing_box_path() {
        return Some(path);
    }
    if let Some(path) = find_command_path("sing-box") {
        return Some(path);
    }
    for path in ["/usr/local/bin/sing-box", "/usr/bin/sing-box", "/opt/sing-box/sing-box"] {
        if Path::new(path).is_file() {
            return Some(path.to_string());
        }
    }
    None
}

fn installed_sing_box_path() -> Option<String> {
    if let Ok(home) = env::var("PULSEDECK_AGENT_HOME") {
        let path = Path::new(&home).join("bin/sing-box");
        if path.is_file() {
            return Some(path.to_string_lossy().to_string());
        }
    }
    let config_path = find_config_path();
    let raw = fs::read_to_string(&config_path).unwrap_or_default();
    let agent_home = json_get_string(&raw, "agentHome").unwrap_or_else(|| parent_parent(&config_path));
    let path = Path::new(&agent_home).join("bin/sing-box");
    if path.is_file() {
        Some(path.to_string_lossy().to_string())
    } else {
        None
    }
}

fn find_command_path(name: &str) -> Option<String> {
    env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .map(|dir| Path::new(dir).join(name))
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().to_string())
}

fn sing_box_version() -> Option<String> {
    let binary = find_sing_box_binary()?;
    let output = Command::new(binary).arg("version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    Some(raw.lines().next().unwrap_or("").trim().to_string())
}

fn atomic_write(file: &str, content: &str) -> Result<(), String> {
    let target = Path::new(file);
    ensure_parent(target)?;
    let tmp = format!("{}.{}.tmp", file, std::process::id());
    fs::write(&tmp, content).map_err(|error| format!("cannot write {file}: {error}"))?;
    if target.is_file() {
        let backup = format!("{}.{}.bak", file, now_string());
        let _ = fs::copy(target, backup);
    }
    fs::rename(&tmp, target).map_err(|error| format!("cannot replace {file}: {error}"))?;
    Ok(())
}

fn atomic_write_checked_sing_box(file: &str, content: &str) -> Result<(), String> {
    let binary = find_sing_box_binary().ok_or_else(|| "sing-box binary was not found".to_string())?;
    let check_file = format!("{}.{}.check", file, std::process::id());
    let target = Path::new(file);
    ensure_parent(target)?;
    fs::write(&check_file, content).map_err(|error| format!("cannot write sing-box check config: {error}"))?;
    let output = Command::new(&binary)
        .args(["check", "-c", &check_file])
        .output()
        .map_err(|error| format!("cannot run sing-box check: {error}"))?;
    let _ = fs::remove_file(&check_file);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!("sing-box 配置写入前检查失败：{}{}", stdout, stderr));
    }
    atomic_write(file, content)
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("cannot create dir {}: {error}", parent.display()))?;
    }
    Ok(())
}

fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("cannot read permissions for {}: {error}", path.display()))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).map_err(|error| format!("cannot chmod {}: {error}", path.display()))?;
    }
    Ok(())
}

fn protocol_setting(protocol: &NodeProtocol, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = json_get_string(&protocol.settings_json, key) {
            let trimmed = value.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

fn protocol_transport_type(protocol: &NodeProtocol) -> String {
    if !protocol.transport.trim().is_empty() {
        return protocol.transport.trim().to_string();
    }
    if ["ws", "grpc", "http", "httpupgrade"].contains(&protocol.variant.as_str()) {
        return protocol.variant.clone();
    }
    protocol_setting(protocol, &["transport", "network"]).unwrap_or_default()
}

fn protocol_security(protocol: &NodeProtocol) -> String {
    let raw = if !protocol.security.trim().is_empty() {
        protocol.security.trim().to_string()
    } else if ["tls", "reality", "ech"].contains(&protocol.variant.as_str()) {
        protocol.variant.clone()
    } else if ["hysteria2", "tuic", "anytls"].contains(&protocol.kind.as_str()) {
        "tls".to_string()
    } else {
        protocol_setting(protocol, &["security"]).unwrap_or_default()
    };
    match raw.as_str() {
        "none" | "plain" | "off" => String::new(),
        "reality" => "reality".to_string(),
        "ech" | "tls" => "tls".to_string(),
        other => other.to_string(),
    }
}

fn protocol_server_name(protocol: &NodeProtocol) -> String {
    protocol_setting(protocol, &["serverName", "sni", "host", "wsHost"]).unwrap_or_default()
}

fn protocol_alpn(protocol: &NodeProtocol) -> Option<String> {
    if let Some(alpn) = protocol_setting(protocol, &["alpn"]) {
        return Some(alpn);
    }
    if ["hysteria2", "tuic"].contains(&protocol.kind.as_str()) {
        return Some("h3".to_string());
    }
    if protocol_transport_type(protocol) == "grpc" {
        return Some("h2".to_string());
    }
    None
}

fn protocol_reality_short_id(protocol: &NodeProtocol, secret: &str) -> String {
    protocol_setting(protocol, &["shortId", "short_id", "sid"]).unwrap_or_else(|| {
        pseudo_uuid(&format!("{}:{}:reality-short-id", secret, protocol.id))
            .chars()
            .filter(|ch| ch.is_ascii_hexdigit())
            .take(8)
            .collect()
    })
}

fn csv_array_json(input: &str) -> String {
    let values = input
        .split(',')
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect::<Vec<String>>();
    string_array_json(&values)
}

fn link_query(params: Vec<(&str, String)>) -> String {
    let pairs = params
        .into_iter()
        .filter(|(_, value)| !value.trim().is_empty())
        .map(|(key, value)| format!("{key}={}", url_component(&value)))
        .collect::<Vec<String>>();
    if pairs.is_empty() {
        String::new()
    } else {
        format!("?{}", pairs.join("&"))
    }
}

fn protocol_display_name(kind: &str) -> &'static str {
    match kind {
        "vmess" => "VMess",
        "vless" => "VLESS",
        "trojan" => "Trojan",
        "shadowsocks" => "Shadowsocks",
        "hysteria2" => "Hysteria2",
        "tuic" => "Tuic",
        "anytls" => "AnyTLS",
        _ => "Proxy",
    }
}

fn default_protocol_port(kind: &str) -> u16 {
    match kind {
        "vmess" => 10001,
        "shadowsocks" => 8388,
        _ => 443,
    }
}

fn normalize_port(value: Option<u64>, fallback: u16) -> u16 {
    match value {
        Some(port) if (1..=65535).contains(&port) => port as u16,
        _ => fallback,
    }
}

fn protocol_password(protocol: &NodeProtocol, secret: &str) -> String {
    json_get_string(&protocol.settings_json, "password").unwrap_or_else(|| {
        let seed = format!("{}:{}:{}", secret, protocol.id, protocol.kind);
        format!("pd-{}", base64_url_no_pad(seed.as_bytes()))
    })
}

fn protocol_uuid(protocol: &NodeProtocol, secret: &str) -> String {
    if let Some(uuid) = json_get_string(&protocol.settings_json, "uuid") {
        if !uuid.is_empty() {
            return uuid;
        }
    }
    pseudo_uuid(&format!("{}:{}:{}", secret, protocol.id, protocol.kind))
}

fn pseudo_uuid(seed: &str) -> String {
    let mut bytes = [0u8; 16];
    let mut hash = 0xcbf29ce484222325u64;
    for byte in seed.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    for (index, byte) in bytes.iter_mut().enumerate() {
        hash ^= (index as u64).wrapping_mul(0x9e3779b97f4a7c15);
        hash = hash.rotate_left(13).wrapping_mul(0xff51afd7ed558ccd);
        *byte = (hash >> ((index % 8) * 8)) as u8;
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn link_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn indent_json(raw: &str, spaces: usize) -> String {
    let prefix = " ".repeat(spaces);
    raw.lines()
        .map(|line| format!("{prefix}{line}"))
        .collect::<Vec<String>>()
        .join("\n")
}

fn string_array_json(values: &[String]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(|value| format!("\"{}\"", json_escape(value)))
            .collect::<Vec<String>>()
            .join(",")
    )
}

fn base64_url_no_pad(input: &[u8]) -> String {
    base64_with_alphabet(input, b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", false)
}

fn base64_encode(input: &[u8]) -> String {
    base64_with_alphabet(input, b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", true)
}

fn base64_with_alphabet(input: &[u8], alphabet: &[u8; 64], padding: bool) -> String {
    let mut output = String::new();
    let mut index = 0usize;
    while index < input.len() {
        let b0 = input[index];
        let b1 = if index + 1 < input.len() { input[index + 1] } else { 0 };
        let b2 = if index + 2 < input.len() { input[index + 2] } else { 0 };
        let triple = ((b0 as u32) << 16) | ((b1 as u32) << 8) | b2 as u32;
        output.push(alphabet[((triple >> 18) & 0x3f) as usize] as char);
        output.push(alphabet[((triple >> 12) & 0x3f) as usize] as char);
        if index + 1 < input.len() {
            output.push(alphabet[((triple >> 6) & 0x3f) as usize] as char);
        } else if padding {
            output.push('=');
        }
        if index + 2 < input.len() {
            output.push(alphabet[(triple & 0x3f) as usize] as char);
        } else if padding {
            output.push('=');
        }
        index += 3;
    }
    output
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
    format!("{}", unix_seconds())
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_secs()
}

fn now_beijing_string() -> String {
    format_unix_beijing(&now_string()).unwrap_or_else(now_string)
}

fn format_unix_beijing(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let at_value = format!("@{trimmed}");
    for args in [
        vec!["-d", at_value.as_str(), "+%Y.%m.%d %H:%M:%S"],
        vec!["-r", trimmed, "+%Y.%m.%d %H:%M:%S"],
    ] {
        let output = Command::new("date").env("TZ", "Asia/Shanghai").args(args).output().ok()?;
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

fn log_line(config: &Config, line: &str) {
    if let Some(parent) = Path::new(&config.log_file).parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&config.log_file) {
        let _ = writeln!(file, "{} {}", now_beijing_string(), line);
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

fn cpu_usage_percent_json() -> String {
    let Some(first) = read_cpu_totals() else {
        return "null".to_string();
    };
    thread::sleep(Duration::from_millis(120));
    let Some(second) = read_cpu_totals() else {
        return "null".to_string();
    };
    let total_delta = second.0.saturating_sub(first.0);
    let idle_delta = second.1.saturating_sub(first.1);
    if total_delta == 0 || idle_delta > total_delta {
        return "null".to_string();
    }
    let busy = total_delta - idle_delta;
    let usage = (busy as f64 / total_delta as f64 * 1000.0).round() / 10.0;
    format!("{usage:.1}")
}

fn read_cpu_totals() -> Option<(u64, u64)> {
    let raw = fs::read_to_string("/proc/stat").ok()?;
    let line = raw.lines().find(|line| line.starts_with("cpu "))?;
    let values: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|part| part.parse::<u64>().ok())
        .collect();
    if values.len() < 4 {
        return None;
    }
    let idle = values.get(3).copied().unwrap_or(0) + values.get(4).copied().unwrap_or(0);
    let total = values.iter().copied().sum();
    Some((total, idle))
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

fn display_seen_at(value: &str) -> String {
    if value.trim().is_empty() {
        return "-".to_string();
    }
    if value.chars().all(|ch| ch.is_ascii_digit()) {
        return format_unix_beijing(value).unwrap_or_else(|| format!("{value} unix"));
    }
    value.to_string()
}

#[allow(dead_code)]
fn read_all(path: &str) -> String {
    let mut buf = String::new();
    if let Ok(mut file) = fs::File::open(path) {
        let _ = file.read_to_string(&mut buf);
    }
    buf
}
