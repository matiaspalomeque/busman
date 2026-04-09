mod commands;
mod crypto;
pub mod error;
mod models;
mod store;

use commands::{connections::*, entities::*, files::*, operations::*};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
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
            republish_subscription_dlq,
            search_messages,
            stop_current_operation,
            peek_messages,
            get_downloaded_files,
            load_downloaded_file,
            test_connection,
            list_entities,
            get_queue_count,
            get_subscription_count,
            get_topic_subscription_counts,
            list_subscription_rules,
            get_queue_properties,
            get_topic_properties,
            get_subscription_properties,
            write_json_file,
            send_message,
            create_queue,
            create_topic,
            create_subscription,
            create_subscription_rule,
            delete_queue,
            delete_topic,
            delete_subscription,
            update_subscription_rule,
            delete_subscription_rule,
            // Connection commands
            load_connections,
            save_connection,
            delete_connection,
            set_active_connection,
            export_connections,
            import_connections,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
