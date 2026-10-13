// Capped tray core. The webview never touches files or the network: every read goes through the
// open-source engine sidecar (same parsers/pricing/payload as the `gotcapped` CLI), every send through here.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, process::Command, sync::Mutex, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tauri::{image::Image, menu::{Menu, MenuItem, PredefinedMenuItem}, tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}, AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_positioner::{Position, WindowExt};

const ENDPOINT_BASE: &str = "https://www.gotcapped.com";
const SCAN_EVERY: Duration = Duration::from_secs(5 * 60);
// Bump when the first-run notice text changes: everyone is asked again once.
const CONSENT_VERSION: u32 = 1;
fn consented(app: &AppHandle) -> bool { fixture_home().is_some() || app.state::<AppState>().0.lock().unwrap().settings.consent_version == CONSENT_VERSION }
const SAMPLE_EVERY: Duration = Duration::from_secs(60);
const SEND_EVERY: Duration = Duration::from_secs(60 * 60);

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct Settings { consent_version: u32, consent_at: Option<u64>, opted_in: bool, paused: bool, onboarded: bool, launch_at_login: bool, show_usd: bool, last_sync: Option<u64>, last_error: Option<String>, delete_msg: Option<String> }

#[derive(Default)]
struct Inner { settings: Settings, scan: Value }
struct AppState(Mutex<Inner>);

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }
fn fixture_home() -> Option<String> { std::env::var("GC_FIXTURE_HOME").ok().filter(|s| !s.is_empty()) }
fn settings_path(app: &AppHandle) -> PathBuf { app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from(".")).join("settings.json") }
fn load_settings(app: &AppHandle) -> Settings { std::fs::read(settings_path(app)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default() }
fn save_settings(app: &AppHandle, s: &Settings) { let p = settings_path(app); if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); } let _ = std::fs::write(p, serde_json::to_vec_pretty(s).unwrap_or_default()); }

fn engine_path() -> PathBuf {
    if let Ok(p) = std::env::var("GC_ENGINE") { return PathBuf::from(p); }
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    dir.join(if cfg!(windows) { "gc-engine.exe" } else { "gc-engine" })
}

fn engine(args: &[&str]) -> Value {
    let mut c = Command::new(engine_path());
    c.args(args);
    if let Some(h) = fixture_home() { c.env("HOME", &h).env("USERPROFILE", &h).env("GOTCAPPED_NO_RPC", "1").env_remove("CLAUDE_CONFIG_DIR").env_remove("CODEX_HOME"); }
    #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
    match c.output() {
        Ok(o) => serde_json::from_slice(&o.stdout).unwrap_or_else(|_| json!({"ok": false, "error": format!("engine output unreadable: {}", String::from_utf8_lossy(&o.stderr).chars().take(300).collect::<String>())})),
        Err(e) => json!({"ok": false, "error": format!("engine not found at {}: {e}", engine_path().display())}),
    }
}

fn full_state(app: &AppHandle) -> Value {
    let st = app.state::<AppState>(); let g = st.0.lock().unwrap();
    let scan = if g.scan.is_null() { json!({"ok": false, "accounts": [], "readings": [], "skipped": [], "phase": "starting", "preview": {"readings": []}, "payload": {"readings": []}, "device": "", "engine": "", "at": now_ms()}) } else { g.scan.clone() };
    json!({ "consent": g.settings.consent_version == CONSENT_VERSION || fixture_home().is_some(), "consentVersion": CONSENT_VERSION, "scan": scan, "cursor": g.scan.get("cursor").cloned().unwrap_or(Value::Null), "settings": g.settings, "fixture": fixture_home().is_some(), "startView": std::env::var("GC_VIEW").ok() })
}

fn do_scan(app: &AppHandle) { do_scan_with(app, &["scan"]); }
// First run: accounts (instant) → current 5-hour window (seconds) → full week, each pushed to the popover as it lands.
fn do_scan_phased(app: &AppHandle) { do_scan_with(app, &["scan", "--accounts"]); do_scan_with(app, &["scan", "--quick"]); do_scan(app); }
fn do_scan_with(app: &AppHandle, args: &[&str]) {
    if !consented(app) { return; } // nothing is read before Agree
    let r = engine(args);
    { let st = app.state::<AppState>(); let mut g = st.0.lock().unwrap(); if r.get("ok").and_then(Value::as_bool).unwrap_or(false) { g.scan = r; } else { g.settings.last_error = r.get("error").and_then(Value::as_str).map(String::from); } }
    update_tray(app);
    let _ = app.emit("state", full_state(app));
}

fn do_send(app: &AppHandle) {
    let ok = { let st = app.state::<AppState>(); let g = st.0.lock().unwrap(); g.settings.opted_in && !g.settings.paused && fixture_home().is_none() };
    if !ok || !consented(app) { return; }
    let r = engine(&["send"]);
    let st = app.state::<AppState>(); let mut g = st.0.lock().unwrap();
    if r.get("ok").and_then(Value::as_bool).unwrap_or(false) { g.settings.last_sync = Some(now_ms()); g.settings.last_error = None; } else { g.settings.last_error = r.get("error").and_then(Value::as_str).map(String::from); }
    let s = g.settings.clone(); drop(g); save_settings(app, &s);
}

// Tooltip (and the optional $ title) use the most-used weekly bar; the icon itself never changes.
fn update_tray(app: &AppHandle) {
    let (tip, title) = {
        let st = app.state::<AppState>(); let g = st.0.lock().unwrap();
        let rs = g.scan.get("readings").and_then(Value::as_array).cloned().unwrap_or_default();
        let lead = rs.iter().filter(|r| r["kind"] == "weekly").max_by(|a, b| a["pct"].as_f64().partial_cmp(&b["pct"].as_f64()).unwrap_or(std::cmp::Ordering::Equal)).cloned();
        match lead {
            Some(r) => { let p = r["pct"].as_f64().unwrap_or(0.0); let usd = r["usd"].as_f64().unwrap_or(0.0);
                (format!("Capped · {} week {:.0}% · ${:.0} of API value", r["planName"].as_str().unwrap_or(""), p, usd), if g.settings.show_usd { format!("${:.0}", usd) } else { String::new() }) }
            None => ("Capped · no bar reading yet".into(), String::new()),
        }
    };
    if let Some(t) = app.tray_by_id("main") {
        // Always the same calm monochrome mark; plain text figure only when "Show $ in menu bar" is on.
        #[cfg(target_os = "macos")] { let _ = t.set_title(if title.is_empty() { None } else { Some(title.as_str()) }); }
        #[cfg(not(target_os = "macos"))] let _ = &title;
        let _ = t.set_tooltip(Some(tip));
    }
}

fn toggle_popover(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) { let _ = w.hide(); }
        else { if cfg!(target_os = "linux") || w.move_window(Position::TrayCenter).is_err() { let _ = w.move_window(Position::TopRight); } /* under the menu bar icon; top-right if no tray click seen yet */ let _ = w.show(); let _ = w.set_focus(); let _ = app.emit("state", full_state(app)); }
    }
}

// ---------- commands (the only surface the UI can call) ----------
#[tauri::command] fn get_state(app: AppHandle) -> Value { full_state(&app) }
// The popover's height fits its content (Option A spec); width stays 300pt.
#[tauri::command] fn fit_height(app: AppHandle, h: f64) { if let Some(w) = app.get_webview_window("main") { let _ = w.set_size(tauri::LogicalSize::new(300.0, h.clamp(160.0, 640.0))); } }
#[tauri::command] async fn rescan(app: AppHandle) -> Value { do_scan(&app); full_state(&app) }
#[tauri::command] async fn set_setting(app: AppHandle, state: State<'_, AppState>, key: String, value: bool) -> Result<Value, String> {
    let s = { let mut g = state.0.lock().unwrap();
        match key.as_str() { "optedIn" => g.settings.opted_in = value, "paused" => g.settings.paused = value, "onboarded" => g.settings.onboarded = value,
            "showUsd" => g.settings.show_usd = value,
            "launchAtLogin" => { g.settings.launch_at_login = value; let al = app.autolaunch(); let _ = if value { al.enable() } else { al.disable() }; }
            _ => return Err("unknown setting".into()) }
        g.settings.clone() };
    save_settings(&app, &s);
    if key == "showUsd" { update_tray(&app); }
    if (key == "optedIn" && value) || (key == "paused" && !value) { let a = app.clone(); std::thread::spawn(move || do_send(&a)); }
    Ok(full_state(&app))
}
#[tauri::command] async fn set_plan(app: AppHandle, account: String, plan: String) -> Value { engine(&["set-plan", &account, &plan]); do_scan(&app); full_state(&app) }
#[tauri::command] async fn install_hook(app: AppHandle) -> Value { let p = engine_path(); let r = engine(&["install-hook"]); let _ = p; let _ = r; do_scan(&app); full_state(&app) }
#[tauri::command] async fn import_cursor(app: AppHandle, path: Option<String>) -> Value {
    let p = match path { Some(p) => Some(p), None => { use tauri_plugin_dialog::DialogExt; app.dialog().file().add_filter("Cursor usage CSV", &["csv"]).blocking_pick_file().and_then(|f| f.into_path().ok()).map(|p| p.display().to_string()) } };
    if let Some(p) = p { engine(&["cursor", &p]); do_scan(&app); }
    full_state(&app)
}
#[tauri::command] async fn delete_my_data(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let device = { let g = state.0.lock().unwrap(); g.scan["payload"]["device"].as_str().unwrap_or("").to_string() };
    // Server first (needs the device id), then local. A failed server call is reported, never hidden.
    // Server first (the engine holds the device secret the DELETE needs), then local. A failed server call is
    // reported and local data is kept so the user can retry; never hidden.
    let server = if device.is_empty() || fixture_home().is_some() { "No device ID to delete on the server.".to_string() } else {
        let r = engine(&["delete-all"]);
        r.get("message").and_then(Value::as_str).map(String::from).unwrap_or_else(|| r.get("error").and_then(Value::as_str).unwrap_or("Server deletion failed.").to_string())
    };
    if device.is_empty() && fixture_home().is_none() { engine(&["forget"]); }
    let s = { let mut g = state.0.lock().unwrap(); g.settings = Settings { delete_msg: Some(server.clone()), ..Default::default() }; g.scan = Value::Null; g.settings.clone() };
    save_settings(&app, &s); do_scan(&app); Ok(full_state(&app))
}
#[tauri::command] fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://www.gotcapped.com") { return Err("blocked".into()); }
    use tauri_plugin_opener::OpenerExt; app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}
#[tauri::command] fn quit(app: AppHandle) { app.exit(0) }
// First-run notice. Agree stores the consent version + time locally and turns sharing on; Cancel quits, nothing read.
#[tauri::command] fn agree(app: AppHandle, state: State<'_, AppState>) -> Value {
    let s = { let mut g = state.0.lock().unwrap(); g.settings.consent_version = CONSENT_VERSION; g.settings.consent_at = Some(now_ms()); g.settings.opted_in = true; g.settings.onboarded = true; g.settings.clone() };
    save_settings(&app, &s); full_state(&app)
}

// ---------- account-switch detection (§17): watch the files account switchers rewrite ----------
fn watch_accounts(app: AppHandle) {
    use notify::{RecursiveMode, Watcher};
    let home = fixture_home().map(PathBuf::from).or_else(dirs::home_dir).unwrap_or_default();
    let codex = std::env::var("CODEX_HOME").map(PathBuf::from).unwrap_or(home.join(".codex"));
    let mut dirs_to_watch = vec![home.clone(), home.join(".claude"), home.join(".config").join("claude"), codex];
    if let Ok(c) = std::env::var("CLAUDE_CONFIG_DIR") { for d in c.split(',') { dirs_to_watch.push(PathBuf::from(d.trim())); } }
    const NAMES: [&str; 4] = [".claude.json", ".credentials.json", "auth.json", "google_accounts.json"];
    let (tx, rx) = std::sync::mpsc::channel();
    let mut w = match notify::recommended_watcher(tx) { Ok(w) => w, Err(_) => return };
    for d in &dirs_to_watch { if d.is_dir() { let _ = w.watch(d, RecursiveMode::NonRecursive); } }
    let mut last = Instant::now() - Duration::from_secs(10);
    for ev in rx {
        let Ok(ev) = ev else { continue };
        if !ev.paths.iter().any(|p| p.file_name().and_then(|n| n.to_str()).map(|n| NAMES.contains(&n)).unwrap_or(false)) { continue; }
        if last.elapsed() < Duration::from_secs(2) { continue; } // debounce writes
        last = Instant::now();
        std::thread::sleep(Duration::from_millis(400)); // let the switcher finish writing
        engine(&["sample"]); do_scan(&app); let _ = app.emit("account-switch", ());
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| toggle_popover(app)))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState(Mutex::new(Inner::default())))
        .invoke_handler(tauri::generate_handler![get_state, fit_height, rescan, set_setting, set_plan, install_hook, import_cursor, delete_my_data, open_url, quit, agree])
        .setup(|app| {
            #[cfg(target_os = "macos")] app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let h = app.handle().clone();
            let mut s = load_settings(&h);
            if fixture_home().is_some() { if let Ok(v) = std::env::var("GC_FIXTURE_ONBOARDED") { s.onboarded = v == "1"; s.opted_in = v == "1"; } }
            app.state::<AppState>().0.lock().unwrap().settings = s;
            let open = MenuItem::with_id(app, "open", "Open Capped", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)?;
            let board = MenuItem::with_id(app, "board", "Open the public board", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &refresh, &board, &PredefinedMenuItem::separator(app)?, &quit_i])?;
            TrayIconBuilder::with_id("main")
                .icon(Image::from_bytes(include_bytes!("../icons/iconTemplate@2x.png")).expect("menu bar icon")) // Ivo's Option A template icon, tinted by macOS
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("Capped")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => toggle_popover(app),
                    "refresh" => { let a = app.clone(); std::thread::spawn(move || do_scan(&a)); }
                    "board" => { use tauri_plugin_opener::OpenerExt; let _ = app.opener().open_url(ENDPOINT_BASE, None::<&str>); }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &ev);
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev { toggle_popover(tray.app_handle()); }
                })
                .build(app)?;
            if let Some(w) = app.get_webview_window("main") {
                let w2 = w.clone();
                let h2 = app.handle().clone();
                w.on_window_event(move |e| if let WindowEvent::Focused(false) = e { if std::env::var("GC_KEEP_OPEN").is_err() && consented(&h2) { let _ = w2.hide(); } });
                let need = !app.state::<AppState>().0.lock().unwrap().settings.consent_version.eq(&CONSENT_VERSION) && fixture_home().is_none();
                // Menu bar only, except the one-time Agree screen on first run (or when the notice version changes).
                if need { let _ = w.center(); let _ = w.show(); let _ = w.set_focus(); } else if std::env::var("GC_SHOW").is_ok() { let _ = w.show(); }
            }
            // Background loop: sample accounts every minute, rescan every 5 min, send hourly (only if opted in).
            let bg = h.clone();
            std::thread::spawn(move || {
                while !consented(&bg) { std::thread::sleep(Duration::from_millis(300)); }
                do_scan_phased(&bg); do_send(&bg); if fixture_home().is_none() { engine(&["crowd"]); do_scan(&bg); }
                let (mut ls, mut lsc, mut lse) = (Instant::now(), Instant::now(), Instant::now());
                loop {
                    std::thread::sleep(Duration::from_secs(5));
                    if ls.elapsed() >= SAMPLE_EVERY { engine(&["sample"]); ls = Instant::now(); }
                    if lsc.elapsed() >= SCAN_EVERY { do_scan(&bg); lsc = Instant::now(); }
                    if lse.elapsed() >= SEND_EVERY { do_send(&bg); if fixture_home().is_none() { engine(&["crowd"]); } lse = Instant::now(); }
                }
            });
            let wa = h.clone(); std::thread::spawn(move || { while !consented(&wa) { std::thread::sleep(Duration::from_millis(500)); } watch_accounts(wa) });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Capped");
}
