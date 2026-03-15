mod commands;
mod models;
mod store;

use commands::{connections::*, script::*};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            // Script commands
            is_portable,
            check_worker,
            ensure_scripts_ready,
            empty_messages,
            move_messages,
            search_messages,
            stop_current_operation,
            peek_messages,
            get_downloaded_files,
            load_downloaded_file,
            list_entities,
            get_entity_counts,
            write_json_file,
            send_message,
            create_queue,
            create_topic,
            create_subscription,
            delete_queue,
            delete_topic,
            delete_subscription,
            // Connection commands
            load_connections,
            save_connection,
            delete_connection,
            set_active_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
