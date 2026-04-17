mod commands;
mod crypto;
pub mod error;
mod models;
mod store;

use commands::{connections::*, entities::*, files::*, operations::*};
use tauri::menu::{Menu, MenuItemBuilder, HELP_SUBMENU_ID};
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                // After the window-state plugin restores the saved position, verify the
                // window is actually visible on one of the currently connected monitors.
                // If not (e.g. the user switched monitors), center it on the primary one.
                if let (Ok(monitors), Ok(position), Ok(size)) = (
                    window.available_monitors(),
                    window.outer_position(),
                    window.outer_size(),
                ) {
                    let win_right = position.x + size.width as i32;
                    let win_bottom = position.y + size.height as i32;

                    let visible = monitors.iter().any(|m: &tauri::Monitor| {
                        let mp = m.position();
                        let ms = m.size();
                        let mon_right = mp.x + ms.width as i32;
                        let mon_bottom = mp.y + ms.height as i32;
                        // Require at least 100 px of overlap in both axes
                        let overlap_x = win_right.min(mon_right) - position.x.max(mp.x);
                        let overlap_y = win_bottom.min(mon_bottom) - position.y.max(mp.y);
                        overlap_x >= 100 && overlap_y >= 100
                    });

                    if !visible {
                        let _ = window.center();
                    }
                }
            }

            let about_item = MenuItemBuilder::with_id("about", "About Busman").build(app)?;
            let menu = Menu::default(app.handle())?;
            if let Some(help) = menu.get(HELP_SUBMENU_ID) {
                if let Some(help_submenu) = help.as_submenu() {
                    help_submenu.prepend(&about_item)?;
                }
            }
            app.set_menu(menu)?;

            app.on_menu_event(|app_handle, event| {
                if event.id().as_ref() == "about" {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.emit("menu-about", ());
                    }
                }
            });

            Ok(())
        })
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
            single_message_action,
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
