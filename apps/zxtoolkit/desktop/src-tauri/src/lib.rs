use tauri::{
    Emitter,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, PhysicalPosition, Position, WindowEvent,
};
use std::{fs, path::{Path, PathBuf}, time::{Duration, SystemTime, UNIX_EPOCH}};

const KEYCHAIN_SERVICE: &str = "dev.zxlab.zxtoolkit.device";

#[tauri::command]
async fn keychain_set(device_id: String, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &device_id).map_err(|_| "无法连接 macOS 钥匙串".to_string())?;
        entry.set_password(&token).map_err(|_| "无法保存设备凭证到 macOS 钥匙串".to_string())
    })
    .await
    .map_err(|_| "保存设备凭证失败".to_string())?
}

#[tauri::command]
async fn keychain_get(device_id: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &device_id).map_err(|_| "无法连接 macOS 钥匙串".to_string())?;
        match entry.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("无法读取 macOS 钥匙串中的设备凭证".to_string()),
        }
    })
    .await
    .map_err(|_| "读取设备凭证失败".to_string())?
}

#[tauri::command]
async fn keychain_delete(device_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &device_id).map_err(|_| "无法连接 macOS 钥匙串".to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("无法从 macOS 钥匙串删除设备凭证".to_string()),
        }
    })
    .await
    .map_err(|_| "删除设备凭证失败".to_string())?
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn read_screenshot_file(app: tauri::AppHandle, path: String) -> Result<Vec<u8>, String> {
    let desktop = app.path().desktop_dir().map_err(|_| "无法定位桌面目录".to_string())?;
    let candidate = PathBuf::from(path);
    if !is_screenshot_path(&candidate) || candidate.parent() != Some(desktop.as_path()) {
        return Err("只能读取刚刚生成的桌面截图".to_string());
    }
    fs::read(candidate).map_err(|_| "无法读取截图文件".to_string())
}

#[tauri::command]
fn save_received_file(app: tauri::AppHandle, file_name: String, bytes: Vec<u8>) -> Result<String, String> {
    if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 {
        return Err("文件为空或超过 20 MB".to_string());
    }
    let downloads = app.path().download_dir().map_err(|_| "无法定位下载目录".to_string())?;
    let safe_name = safe_file_name(&file_name);
    let target = unique_download_path(&downloads, &safe_name);
    fs::write(&target, bytes).map_err(|_| "无法将文件保存到下载目录".to_string())?;
    Ok(target.to_string_lossy().to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![keychain_set, keychain_get, keychain_delete, quit_app, show_main_window, read_screenshot_file, save_received_file])
        .setup(|app| {
            // One-time migration from the pre-zxtoolkit bundle identifier. This keeps
            // existing device tokens and default targets without exposing them to JS.
            if let (Ok(home), Ok(current)) = (app.path().home_dir(), app.path().app_config_dir()) {
                let legacy = home.join("Library/Application Support/com.zxlab.zxdrop/zxdrop-device.json");
                let target = current.join("zxtoolkit-device.json");
                if legacy.exists() && !target.exists() {
                    let _ = std::fs::create_dir_all(&current);
                    let _ = std::fs::copy(legacy, target);
                }
            }

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let quit = MenuItem::with_id(app, "quit", "退出 zxtoolkit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit])?;
            // Menu bar template images use alpha as the system-rendered mask. The regular
            // app icon has an opaque rounded background, so using it here becomes a solid
            // square. Keep the tray glyph transparent and separate from the app artwork.
            let icon = tauri::include_image!("icons/tray-template.png");

            TrayIconBuilder::with_id("zxtoolkit-tray")
                .tooltip("zxtoolkit")
                .icon(icon)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                                return;
                            }

                            let scale = window.scale_factor().unwrap_or(1.0);
                            let window_size = window.outer_size().unwrap_or_default();
                            let tray_position = rect.position.to_physical::<i32>(scale);
                            let tray_size = rect.size.to_physical::<u32>(scale);
                            let x = tray_position.x + tray_size.width as i32 - window_size.width as i32;
                            let y = tray_position.y + tray_size.height as i32 + 6;
                            let _ = window.set_position(Position::Physical(PhysicalPosition::new(x, y)));
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            start_screenshot_watcher(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(false) => {
                let _ = window.hide();
            }
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("failed to run zxtoolkit");
}

fn start_screenshot_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let Ok(desktop) = app.path().desktop_dir() else { return };
        let mut latest = SystemTime::now();
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            let Some((path, modified)) = newest_screenshot(&desktop, latest) else { continue };
            latest = modified;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit("screenshot-created", path.to_string_lossy().to_string());
        }
    });
}

fn newest_screenshot(desktop: &Path, after: SystemTime) -> Option<(PathBuf, SystemTime)> {
    fs::read_dir(desktop).ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if !is_screenshot_path(&path) { return None; }
            let modified = entry.metadata().ok()?.modified().ok()?;
            (modified > after).then_some((path, modified))
        })
        .max_by_key(|(_, modified)| *modified)
}

fn is_screenshot_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else { return false };
    let lower = name.to_lowercase();
    path.extension().and_then(|value| value.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
        && (lower.starts_with("screen shot") || lower.starts_with("screenshot") || name.starts_with("截屏"))
}

fn safe_file_name(value: &str) -> String {
    let cleaned: String = value.chars()
        .map(|character| if matches!(character, '/' | '\\' | '\0' | '\r' | '\n') { '_' } else { character })
        .take(180)
        .collect();
    if cleaned.trim_matches('.').is_empty() { "zxtoolkit-file".to_string() } else { cleaned }
}

fn unique_download_path(downloads: &Path, file_name: &str) -> PathBuf {
    let direct = downloads.join(file_name);
    if !direct.exists() { return direct; }
    let source = Path::new(file_name);
    let stem = source.file_stem().and_then(|value| value.to_str()).unwrap_or("zxtoolkit-file");
    let extension = source.extension().and_then(|value| value.to_str());
    let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let renamed = match extension {
        Some(ext) => format!("{stem}-{suffix}.{ext}"),
        None => format!("{stem}-{suffix}")
    };
    downloads.join(renamed)
}
