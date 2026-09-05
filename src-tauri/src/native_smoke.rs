//! Opt-in packaged-app bootstrap check. No application windows, saved connections,
//! broker operations or update downloads are opened by this entrypoint.

fn credential_round_trip() -> Result<(), String> {
    let account = uuid::Uuid::new_v4().to_string();
    let entry = keyring::Entry::new("com.busman.smoke", &account).map_err(|e| e.to_string())?;
    let value = uuid::Uuid::new_v4().to_string();
    entry.set_password(&value).map_err(|e| e.to_string())?;
    let read = entry.get_password().map_err(|e| e.to_string());
    let cleanup = entry.delete_credential().map_err(|e| e.to_string());
    cleanup?;
    if read? != value {
        return Err("Credential round trip did not preserve the test value".into());
    }
    Ok(())
}

pub fn run(report: std::path::PathBuf, mut context: tauri::Context<tauri::Wry>) {
    context.config_mut().app.windows.clear();
    // Sidecar extraction on Windows and runtime metadata use an isolated app directory.
    context.config_mut().identifier = "com.busman.smoke".into();
    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            let report = report.clone();
            tauri::async_runtime::spawn(async move {
                let mut checks = serde_json::Map::new();
                checks.insert("nativeStartup".into(), serde_json::json!(true));
                let worker = crate::commands::operations::ensure_scripts_ready(handle.clone()).await;
                checks.insert("workerHandshake".into(), serde_json::json!(worker.is_ok()));
                let credentials = tauri::async_runtime::spawn_blocking(credential_round_trip).await;
                let credentials_ok = matches!(credentials, Ok(Ok(())));
                checks.insert("secureStoreRoundTrip".into(), serde_json::json!(credentials_ok));
                let updater = handle.config().plugins.0.get("updater");
                let updater_valid = updater.is_some_and(|value| {
                    value["pubkey"].as_str().is_some_and(|key| !key.is_empty())
                        && value["endpoints"].as_array().is_some_and(|urls| !urls.is_empty() && urls.iter().all(|url| url.as_str().is_some_and(|url| url.starts_with("https://"))))
                });
                checks.insert("updaterConfiguration".into(), serde_json::json!(updater_valid));
                let success = worker.is_ok() && credentials_ok && updater_valid;
                let output = serde_json::json!({ "version": 1, "platform": std::env::consts::OS, "appVersion": handle.package_info().version.to_string(), "checks": checks,
                    "limitations": ["No rendered webview check", "No broker access", "No installer or update download/install check"] });
                let written = std::fs::write(report, serde_json::to_vec_pretty(&output).unwrap_or_default()).is_ok();
                handle.exit(if success && written { 0 } else { 1 });
            });
            Ok(())
        })
        .run(context)
        .expect("native smoke runtime failed");
}
