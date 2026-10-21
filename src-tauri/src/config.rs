//! OAuth client configuration. A runtime environment variable overrides the
//! value build.rs embedded at compile time, which keeps local overrides easy
//! without making installed builds depend on a .env file.

/// Treat unset, blank and copied-from-.env.example values as missing.
fn usable(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty() && !value.starts_with("your-")
}

fn resolve(runtime: Option<String>, embedded: Option<&str>) -> Option<String> {
    runtime
        .filter(|value| usable(value))
        .or_else(|| embedded.filter(|value| usable(value)).map(str::to_string))
        .map(|value| value.trim().to_string())
}

fn lookup(key: &str, embedded: Option<&'static str>) -> Option<String> {
    resolve(std::env::var(key).ok(), embedded)
}

pub fn twitch_client_id() -> Option<String> {
    lookup("TWITCH_CLIENT_ID", option_env!("TWITCH_CLIENT_ID")).or_else(|| {
        lookup(
            "VITE_TWITCH_CLIENT_ID",
            option_env!("VITE_TWITCH_CLIENT_ID"),
        )
    })
}

pub fn youtube_client_id() -> Option<String> {
    lookup("YOUTUBE_CLIENT_ID", option_env!("YOUTUBE_CLIENT_ID")).or_else(|| {
        lookup(
            "VITE_YOUTUBE_CLIENT_ID",
            option_env!("VITE_YOUTUBE_CLIENT_ID"),
        )
    })
}

pub fn youtube_client_secret() -> Option<String> {
    lookup(
        "YOUTUBE_CLIENT_SECRET",
        option_env!("YOUTUBE_CLIENT_SECRET"),
    )
}

#[cfg(test)]
mod tests {
    use super::resolve;

    #[test]
    fn runtime_value_overrides_embedded() {
        assert_eq!(
            resolve(Some("runtime".into()), Some("embedded")).as_deref(),
            Some("runtime")
        );
    }

    #[test]
    fn falls_back_to_embedded_value() {
        assert_eq!(resolve(None, Some("embedded")).as_deref(), Some("embedded"));
        assert_eq!(
            resolve(Some("  ".into()), Some("embedded")).as_deref(),
            Some("embedded")
        );
    }

    #[test]
    fn rejects_example_placeholders() {
        assert_eq!(resolve(Some("your-client-id-here".into()), None), None);
        assert_eq!(resolve(None, Some("your-twitch-client-id")), None);
    }
}
