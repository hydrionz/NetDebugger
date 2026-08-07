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

                // Save window size on resize — but skip minimized/too-small
                // sizes so a minimize action never poisons the stored value.
                if let Some(window) = app.get_webview_window("main") {
                    let store = store.clone();
                    window.on_window_event(move |event| {
                        if let WindowEvent::Resized(size) = event {
                            if size.width < MIN_WIDTH || size.height < MIN_HEIGHT {
                                return;
                            }
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
            commands::disconnect_client,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
