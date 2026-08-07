use serde_json::json;
use std::path::PathBuf;
use tauri::{Manager, WindowEvent};
use tauri_plugin_store::StoreExt;

mod commands;
mod db;
mod state;
mod ws;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
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

            // Restore window size.
            if let Ok(store) = app.store("store.bin") {
                if let Some(v) = store.get("window-size") {
                    if let (Some(w), Some(h)) = (
                        v.get("width").and_then(|x| x.as_u64()),
                        v.get("height").and_then(|x| x.as_u64()),
                    ) {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.set_size(tauri::Size::Physical(
                                tauri::PhysicalSize::new(w as u32, h as u32),
                            ));
                        }
                    }
                }

                // Save window size on resize.
                if let Some(window) = app.get_webview_window("main") {
                    let store = store.clone();
                    window.on_window_event(move |event| {
                        if let WindowEvent::Resized(size) = event {
                            store.set(
                                "window-size",
                                json!({
                                    "width": size.width,
                                    "height": size.height,
                                }),
                            );
                            let _ = store.save();
                        }
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_project,
            commands::delete_project,
            commands::list_projects,
            commands::create_session,
            commands::update_session,
            commands::delete_session,
            commands::load_messages,
            commands::clear_messages,
            commands::start_session,
            commands::stop_session,
            commands::send_message,
            commands::subscribe_timeline,
            commands::list_clients,
            commands::update_client_name,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
