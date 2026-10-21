use std::collections::BTreeMap;

/// OAuth client configuration embedded into the binary (read back with
/// `option_env!` in src/config.rs). Installed copies of the app have no .env
/// file, so reading these at runtime only ever worked on the developer's
/// machine. None of them is a confidential credential: Twitch's Device Code
/// Flow needs only the client ID, and Google treats the client secret of an
/// installed ("Desktop app") OAuth client as non-confidential.
const CONFIG_KEYS: &[&str] = &[
    "TWITCH_CLIENT_ID",
    "VITE_TWITCH_CLIENT_ID",
    "YOUTUBE_CLIENT_ID",
    "VITE_YOUTUBE_CLIENT_ID",
    "YOUTUBE_CLIENT_SECRET",
];

/// Later files override earlier ones; variables already set in the build
/// environment (e.g. by CI) override both.
const ENV_FILES: &[&str] = &["../.env", ".env"];

fn parse_env_file(contents: &str, values: &mut BTreeMap<String, String>) {
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim().trim_start_matches("export ").trim();
        if !CONFIG_KEYS.contains(&key) {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if !value.is_empty() {
            values.insert(key.to_string(), value.to_string());
        }
    }
}

fn main() {
    let mut values = BTreeMap::new();
    for file in ENV_FILES {
        // Only watch files that exist: Cargo reruns the script on every build
        // for a watched path that is missing.
        if let Ok(contents) = std::fs::read_to_string(file) {
            println!("cargo:rerun-if-changed={file}");
            parse_env_file(&contents, &mut values);
        }
    }

    for key in CONFIG_KEYS {
        println!("cargo:rerun-if-env-changed={key}");
        if std::env::var_os(key).is_some() {
            continue;
        }
        if let Some(value) = values.get(*key) {
            println!("cargo:rustc-env={key}={value}");
        }
    }

    tauri_build::build()
}
