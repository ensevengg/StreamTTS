use tauri::{Emitter, Manager};

mod config;
mod oauth;
mod secrets;
mod twitch_auth;
mod youtube_stream;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        .manage(oauth::OAuthStates::default())
        .manage(twitch_auth::TwitchDeviceFlow::default())
        .manage(youtube_stream::ChatStreams::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let handle = app.handle().clone();
            let states = app.state::<oauth::OAuthStates>().inner().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = oauth::start_callback_server(handle.clone(), states).await {
                    log::error!("OAuth callback server error: {e}");
                    let _ = handle.emit("oauth-server-error", e.to_string());
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            oauth::youtube_auth_start,
            oauth::youtube_refresh_token,
            twitch_auth::twitch_device_start,
            twitch_auth::twitch_device_cancel,
            twitch_auth::twitch_refresh_token,
            youtube_stream::youtube_chat_stream,
            youtube_stream::youtube_chat_stream_stop,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
