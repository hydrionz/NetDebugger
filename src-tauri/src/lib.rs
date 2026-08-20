use serde_json::json;
use std::path::PathBuf;
use tauri::{menu::Menu, tray::TrayIconBuilder, Emitter, Manager, WindowEvent};
use tauri_plugin_store::StoreExt;

mod commands;
mod db;
mod state;
mod ws;

// 从托盘/单例恢复窗口：最小化时仅 show() 无法还原，需先 unminimize
fn restore_window(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单例：只允许一个实例；再次运行则激活已存在的窗口
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                restore_window(&window);
            }
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();

            let data_dir: PathBuf = handle
                .path()
                .app_local_data_dir()
                .expect("app local data dir");
            std::fs::create_dir_all(&data_dir).expect("create data dir");

            let db_path = data_dir.join("debugger.db");
            let db_path_str = db_path.to_string_lossy().to_string();

            let db = tauri::async_runtime::block_on(async {
                db::open_db(&db_path_str)
                    .await
                    .expect("open database")
            });

            app.manage(state::AppState::new(db));

            // Set window background to match the theme so the window
            // (shown after the frontend is ready) never flashes white.
            if let Some(window) = app.get_webview_window("main") {
                let theme = app
                    .store("store.bin")
                    .ok()
                    .and_then(|s| s.get("theme"))
                    .and_then(|v| v.as_str().map(String::from));
                let dark = match theme.as_deref() {
                    Some("dark") => true,
                    Some("light") => false,
                    _ => window
                        .theme()
                        .map(|t| t == tauri::Theme::Dark)
                        .unwrap_or(false),
                };
                let (r, g, b) = if dark {
                    (0x1e, 0x1e, 0x1e)
                } else {
                    (0xf7, 0xf7, 0xf7)
                };
                let _ = window.set_background_color(Some(tauri::window::Color(r, g, b, 255)));
            }

            // Restore window size. Guard against corrupted/too-small values
            // (e.g. a minimized-window size that was accidentally persisted
            // in an earlier version) by enforcing the same minimums as the
            // window config in tauri.conf.json.
            const MIN_WIDTH: u32 = 800;
            const MIN_HEIGHT: u32 = 600;

            if let Ok(store) = app.store("store.bin") {
                if let Some(v) = store.get("window-size") {
                    if let (Some(w), Some(h)) = (
                        v.get("width").and_then(|x| x.as_u64()),
                        v.get("height").and_then(|x| x.as_u64()),
                    ) {
                        let (w, h) = (w as u32, h as u32);
                        if w >= MIN_WIDTH && h >= MIN_HEIGHT {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.set_size(tauri::Size::Physical(
                                    tauri::PhysicalSize::new(w, h),
                                ));
                            }
                        } else {
                            // Stored size is bogus (e.g. captured while the
                            // window was minimized) — drop it so it doesn't
                            // keep shrinking the window on every launch.
                            store.delete("window-size");
                            let _ = store.save();
                        }
                    }
                }
            }

            // Setup system tray icon and menu.
            if let (Some(window), Some(icon)) =
                (app.get_webview_window("main"), app.default_window_icon())
            {
                let window_for_tray = window.clone();
                let tray_menu = Menu::with_items(
                    app,
                    &[
                        &tauri::menu::MenuItem::with_id(app, "show", "显示", true, None::<&str>)?,
                        &tauri::menu::PredefinedMenuItem::separator(app)?,
                        &tauri::menu::MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
                    ],
                )?;

                TrayIconBuilder::new()
                    .icon(icon.clone())
                    .menu(&tray_menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(move |app, event| match event.id.as_ref() {
                        "show" => {
                            restore_window(&window_for_tray);
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            ..
                        } = event
                        {
                            if let Some(window) =
                                tray.app_handle().get_webview_window("main")
                            {
                                restore_window(&window);
                            }
                        }
                    })
                    .build(app)?;
            }

            // Handle window resize and close events.
            if let Some(window) = app.get_webview_window("main") {
                let store = app.store("store.bin")?;
                let store_for_resize = store.clone();
                let app_handle_for_close = app.handle().clone();

                window.on_window_event(move |event| {
                    match event {
                        WindowEvent::Resized(size) => {
                            if size.width < MIN_WIDTH || size.height < MIN_HEIGHT {
                                return;
                            }
                            store_for_resize.set(
                                "window-size",
                                json!({
                                    "width": size.width,
                                    "height": size.height,
                                }),
                            );
                            let _ = store_for_resize.save();
                        }
                        WindowEvent::CloseRequested { api, .. } => {
                            let minimize = app_handle_for_close
                                .store("store.bin")
                                .ok()
                                .and_then(|s| s.get("minimize-to-tray"))
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);

                            api.prevent_close();

                            if minimize {
                                if let Some(window) = app_handle_for_close.get_webview_window("main")
                                {
                                    let _ = window.hide();
                                }
                            } else {
                                let _ = app_handle_for_close.emit("window:close-requested", ());
                            }
                        }
                        _ => {}
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_project,
            commands::delete_project,
            commands::update_project,
            commands::list_projects,
            commands::create_session,
            commands::update_session,
            commands::delete_session,
            commands::load_messages,
            commands::clear_messages,
            commands::count_messages_by_endpoint,
            commands::delete_messages_by_endpoint,
            commands::delete_message,
            commands::start_session,
            commands::stop_session,
            commands::send_message,
            commands::subscribe_timeline,
            commands::list_clients,
            commands::update_client_name,
            commands::disconnect_client,
            commands::get_minimize_to_tray,
            commands::set_minimize_to_tray,
            commands::get_app_version,
            commands::get_theme,
            commands::set_theme,
            commands::hide_window,
            commands::exit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
