use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, PhysicalPosition, Position, WindowEvent,
};

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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![keychain_set, keychain_get, keychain_delete, quit_app])
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
