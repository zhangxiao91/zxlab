use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, Size, State,
    WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;

const SMALL_SIZE: (f64, f64) = (148.0, 180.0);
const MEDIUM_SIZE: (f64, f64) = (176.0, 210.0);
const LARGE_SIZE: (f64, f64) = (208.0, 250.0);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetPreferences {
    #[serde(default)]
    quiet: bool,
    #[serde(default = "default_size")]
    size: String,
    #[serde(default)]
    launch_at_login: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    x: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    y: Option<i32>,
}

impl Default for PetPreferences {
    fn default() -> Self {
        Self {
            quiet: false,
            size: default_size(),
            launch_at_login: false,
            x: None,
            y: None,
        }
    }
}

struct RuntimeState {
    preferences: Mutex<PetPreferences>,
    path: PathBuf,
}

fn default_size() -> String {
    "medium".to_string()
}

fn window_size(size: &str) -> (f64, f64) {
    match size {
        "small" => SMALL_SIZE,
        "large" => LARGE_SIZE,
        _ => MEDIUM_SIZE,
    }
}

fn read_preferences(path: &Path) -> PetPreferences {
    fs::read_to_string(path)
        .ok()
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

fn write_preferences(path: &Path, preferences: &PetPreferences) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let value = serde_json::to_string_pretty(preferences).map_err(|error| error.to_string())?;
    fs::write(path, value).map_err(|error| error.to_string())
}

fn emit_preferences(app: &AppHandle, preferences: &PetPreferences) {
    let _ = app.emit("preferences-changed", preferences);
}

fn emit_error(app: &AppHandle, message: impl Into<String>) {
    let _ = app.emit("boopi-error", message.into());
}

fn persist_preferences(app: &AppHandle, update: impl FnOnce(&mut PetPreferences)) {
    let state = app.state::<RuntimeState>();
    let Ok(mut preferences) = state.preferences.lock() else {
        emit_error(app, "Boopi 无法更新本地设置。");
        return;
    };
    update(&mut preferences);
    if let Err(error) = write_preferences(&state.path, &preferences) {
        emit_error(app, format!("Boopi 无法保存本地设置：{error}"));
    }
    emit_preferences(app, &preferences);
}

fn resize_window(window: &WebviewWindow, size: &str) -> Result<(), String> {
    let (width, height) = window_size(size);
    window
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|error| error.to_string())
}

fn place_window(window: &WebviewWindow, preferences: &PetPreferences) -> Result<(), String> {
    if let (Some(x), Some(y)) = (preferences.x, preferences.y) {
        return window
            .set_position(Position::Physical(PhysicalPosition::new(x, y)))
            .map_err(|error| error.to_string());
    }

    let Some(monitor) = window.primary_monitor().map_err(|error| error.to_string())? else {
        return Ok(());
    };
    let work_area = monitor.work_area();
    let outer = window.outer_size().map_err(|error| error.to_string())?;
    let x = work_area.position.x + work_area.size.width as i32 - outer.width as i32 - 28;
    let y = work_area.position.y + work_area.size.height as i32 - outer.height as i32 - 32;
    window
        .set_position(Position::Physical(PhysicalPosition::new(x, y)))
        .map_err(|error| error.to_string())
}

fn toggle_window(window: &WebviewWindow, toggle_item: &MenuItem<tauri::Wry>) {
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        let _ = toggle_item.set_text("显示 Boopi");
    } else {
        let _ = window.show();
        let _ = toggle_item.set_text("隐藏 Boopi");
    }
}

#[tauri::command]
fn get_preferences(state: State<'_, RuntimeState>) -> Result<PetPreferences, String> {
    state
        .preferences
        .lock()
        .map(|preferences| preferences.clone())
        .map_err(|_| "Boopi 无法读取本地设置。".to_string())
}

#[tauri::command]
fn start_pet_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn save_current_position(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    let position = window.outer_position().map_err(|error| error.to_string())?;
    persist_preferences(&app, |preferences| {
        preferences.x = Some(position.x);
        preferences.y = Some(position.y);
    });
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            get_preferences,
            start_pet_drag,
            save_current_position
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let config_dir = app.path().app_config_dir()?;
            let preferences_path = config_dir.join("boopi.json");
            let mut preferences = read_preferences(&preferences_path);
            preferences.launch_at_login = app.autolaunch().is_enabled().unwrap_or(false);
            app.manage(RuntimeState {
                preferences: Mutex::new(preferences.clone()),
                path: preferences_path,
            });

            let window = app
                .get_webview_window("main")
                .ok_or_else(|| std::io::Error::other("Boopi window is missing"))?;
            resize_window(&window, &preferences.size)
                .map_err(std::io::Error::other)?;
            place_window(&window, &preferences)
                .map_err(std::io::Error::other)?;

            let toggle_item = MenuItem::with_id(
                app,
                "toggle",
                "隐藏 Boopi",
                true,
                None::<&str>,
            )?;
            let quiet_item = CheckMenuItem::with_id(
                app,
                "quiet",
                "安静模式",
                true,
                preferences.quiet,
                None::<&str>,
            )?;
            let size_small = CheckMenuItem::with_id(
                app,
                "size-small",
                "小",
                true,
                preferences.size == "small",
                None::<&str>,
            )?;
            let size_medium = CheckMenuItem::with_id(
                app,
                "size-medium",
                "中",
                true,
                preferences.size == "medium",
                None::<&str>,
            )?;
            let size_large = CheckMenuItem::with_id(
                app,
                "size-large",
                "大",
                true,
                preferences.size == "large",
                None::<&str>,
            )?;
            let size_menu = Submenu::with_items(
                app,
                "尺寸",
                true,
                &[&size_small, &size_medium, &size_large],
            )?;
            let autostart_item = CheckMenuItem::with_id(
                app,
                "autostart",
                "登录时启动",
                true,
                preferences.launch_at_login,
                None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(
                app,
                "quit",
                "退出 Boopi",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(
                app,
                &[
                    &toggle_item,
                    &quiet_item,
                    &size_menu,
                    &autostart_item,
                    &separator,
                    &quit_item,
                ],
            )?;

            let menu_toggle = toggle_item.clone();
            let menu_quiet = quiet_item.clone();
            let menu_small = size_small.clone();
            let menu_medium = size_medium.clone();
            let menu_large = size_large.clone();
            let menu_autostart = autostart_item.clone();
            let tray_toggle = toggle_item.clone();
            let icon = tauri::include_image!("icons/tray-icon.png");

            TrayIconBuilder::with_id("boopi-tray")
                .tooltip("Boopi")
                .icon(icon)
                .icon_as_template(false)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    let Some(window) = app.get_webview_window("main") else {
                        return;
                    };
                    match event.id.as_ref() {
                        "toggle" => toggle_window(&window, &menu_toggle),
                        "quiet" => {
                            let quiet = menu_quiet.is_checked().unwrap_or(false);
                            persist_preferences(app, |preferences| preferences.quiet = quiet);
                        }
                        "size-small" | "size-medium" | "size-large" => {
                            let size = event.id.as_ref().trim_start_matches("size-");
                            let _ = menu_small.set_checked(size == "small");
                            let _ = menu_medium.set_checked(size == "medium");
                            let _ = menu_large.set_checked(size == "large");
                            if let Err(error) = resize_window(&window, size) {
                                emit_error(app, format!("Boopi 无法调整尺寸：{error}"));
                                return;
                            }
                            persist_preferences(app, |preferences| {
                                preferences.size = size.to_string()
                            });
                        }
                        "autostart" => {
                            let enabled = menu_autostart.is_checked().unwrap_or(false);
                            let result = if enabled {
                                app.autolaunch().enable()
                            } else {
                                app.autolaunch().disable()
                            };
                            if let Err(error) = result {
                                let _ = menu_autostart.set_checked(!enabled);
                                emit_error(app, format!("Boopi 无法更新开机启动：{error}"));
                                return;
                            }
                            persist_preferences(app, |preferences| {
                                preferences.launch_at_login = enabled
                            });
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            toggle_window(&window, &tray_toggle);
                        }
                    }
                })
                .build(app)?;

            window.show()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Boopi");
}
