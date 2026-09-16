use std::collections::HashMap;
use std::sync::Arc;

use rand::RngCore;
use tauri::{Emitter, Manager};
use tokio::sync::{RwLock, broadcast};

mod alerts;
mod oauth;
mod secrets;

use oauth::{OAuthStateStore, start_oauth_server};

/// Loads a per-install secret from the app data directory, generating and
/// persisting a random one on first run. Committed or user-provided secrets
/// would be readable from a public repo or guessable; per-install random
/// secrets are not.
fn ensure_install_secret(app: &tauri::AppHandle, file_name: &str) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir unavailable: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create app data dir: {e}"))?;

    let path = dir.join(file_name);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let secret = hex::encode(bytes);
    std::fs::write(&path, &secret).map_err(|e| format!("cannot persist secret '{file_name}': {e}"))?;
    log::info!("Generated new install secret: {file_name}");
    Ok(secret)
}



#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load environment variables from .env file
    dotenv::dotenv().ok();

    let (oauth_sender, mut oauth_receiver) = broadcast::channel(32);
    let (alert_sender, mut alert_receiver) = broadcast::channel(32);

tauri::Builder::default()
        // Must be the first plugin so a second launch is redirected to the
        // existing instance instead of racing it for the loopback port.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let oauth_states: OAuthStateStore = Arc::new(RwLock::new(HashMap::new()));
            app.manage(oauth_states.clone());

            let twitch_eventsub_secret = ensure_install_secret(app.handle(), "twitch-eventsub-secret")?;
            let youtube_hub_secret = ensure_install_secret(app.handle(), "youtube-hub-secret")?;

            let oauth_sender_clone = oauth_sender.clone();
            let alert_sender_clone = alert_sender.clone();
            let app_handle_oauth = app.handle().clone();
            let app_handle_alerts = app.handle().clone();
            let app_handle_server = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_oauth_server(oauth_sender_clone, alert_sender_clone, oauth_states, twitch_eventsub_secret, youtube_hub_secret).await {
                    log::error!("OAuth server error: {}", e);
                    let _ = app_handle_server
                        .emit("oauth-server-error", e.to_string());
                }
            });

            tauri::async_runtime::spawn(async move {
                loop {
                    match oauth_receiver.recv().await {
                        Ok(callback) => {
                            log::info!("Received OAuth callback, emitting to frontend: service={}", callback.service);

                            let payload = serde_json::json!({
                                "type": format!("{}-oauth-callback", callback.service),
                                "token": callback.token,
                                "service": callback.service,
                                "error": callback.error,
                                "refresh_token": callback.refresh_token,
                                "expires_in": callback.expires_in,
                                "state": callback.state
                            });

                            app_handle_oauth.emit("auth-callback", payload)
                                .map_err(|e| log::error!("Failed to emit auth callback: {}", e))
                                .ok();
                        }
                        Err(e) => {
                            log::error!("OAuth receiver error: {}", e);
                            break;
                        }
                    }
                }
            });

            tauri::async_runtime::spawn(async move {
                loop {
                    match alert_receiver.recv().await {
                        Ok(alert) => {
                            log::info!("Received alert, emitting to frontend: platform={}, type={}", alert.platform, alert.alert_type);

                            app_handle_alerts.emit("integration-alert", alert)
                                .map_err(|e| log::error!("Failed to emit alert: {}", e))
                                .ok();
                        }
                        Err(e) => {
                            log::error!("Alert receiver error: {}", e);
                            break;
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            oauth::oauth_begin,
            oauth::oauth_redirect_uri,
            oauth::youtube_refresh_token,
            oauth::twitch_refresh_token,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
