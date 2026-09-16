use tauri::command;

const SERVICE_NAME: &str = "com.nerve.streamtts";

/// Credentials that may live in the OS keychain. The whitelist keeps the IPC
/// surface from becoming a generic keychain read/write primitive.
const ALLOWED_KEYS: &[&str] = &[
    "twitch_oauth_token",
    "youtube_oauth_tokens",
    "streamtts-settings",
];

fn entry_for(key: &str) -> Result<keyring::Entry, String> {
    if !ALLOWED_KEYS.contains(&key) {
        return Err(format!("'{key}' is not an allowed secret key"));
    }
    keyring::Entry::new(SERVICE_NAME, key).map_err(|e| format!("OS keychain unavailable: {e}"))
}

#[command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    let entry = entry_for(&key)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("failed to read '{key}' from keychain: {e}")),
    }
}

#[command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    let entry = entry_for(&key)?;
    entry
        .set_password(&value)
        .map_err(|e| format!("failed to store '{key}' in keychain: {e}"))
}

#[command]
pub fn secret_delete(key: String) -> Result<(), String> {
    let entry = entry_for(&key)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("failed to delete '{key}' from keychain: {e}")),
    }
}
