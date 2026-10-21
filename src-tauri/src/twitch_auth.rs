//! Twitch login via the Device Code Grant Flow. Twitch's authorization-code
//! flow requires the client secret (it has no PKCE support), and a secret
//! shipped inside a desktop app is public. Device flow is the flow Twitch
//! provides for public clients: no secret, no redirect port, and it returns a
//! refresh token.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tokio::time::Instant;

use crate::config;
use crate::oauth::{
    emit_auth_callback, http_client, provider_error_message, refresh_token_grant, AuthCallback,
    CommandError, ProviderTokenResponse, TokenResponse,
};

const TWITCH_DEVICE_URL: &str = "https://id.twitch.tv/oauth2/device";
const TWITCH_TOKEN_URL: &str = "https://id.twitch.tv/oauth2/token";
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// chat:read for chat; the two read-only channel scopes let EventSub deliver
/// the subscription, gift and channel-point alerts.
const TWITCH_SCOPES: &str = "chat:read channel:read:subscriptions channel:read:redemptions";

const NOT_CONFIGURED: &str =
    "Twitch login isn't configured in this build (missing TWITCH_CLIENT_ID).";
const CODE_EXPIRED: &str = "The Twitch login code expired. Start the login again.";

#[derive(Debug, Clone)]
struct TwitchEndpoints {
    device_url: String,
    token_url: String,
}

impl Default for TwitchEndpoints {
    fn default() -> Self {
        Self {
            device_url: TWITCH_DEVICE_URL.to_string(),
            token_url: TWITCH_TOKEN_URL.to_string(),
        }
    }
}

/// Generation counter for the device flow: starting a new login or cancelling
/// bumps it, which makes any older polling task stop without emitting.
#[derive(Default)]
pub struct TwitchDeviceFlow {
    generation: Arc<AtomicU64>,
}

/// What the webview shows the user while the login is pending.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceCodeInfo {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, PartialEq)]
enum PollError {
    Pending,
    SlowDown,
    Transient,
    Fatal(String),
}

fn classify_poll_error(status: reqwest::StatusCode, body: &serde_json::Value) -> PollError {
    if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return PollError::Transient;
    }
    let message = provider_error_message(body);
    match message.as_str() {
        "authorization_pending" => PollError::Pending,
        "slow_down" => PollError::SlowDown,
        "access_denied" => PollError::Fatal("The Twitch login was cancelled.".to_string()),
        m if m.to_ascii_lowercase().contains("invalid device code") => {
            PollError::Fatal(CODE_EXPIRED.to_string())
        }
        m => PollError::Fatal(format!("Twitch rejected the login: {m}")),
    }
}

#[derive(Debug)]
enum DevicePoll {
    Authorized(ProviderTokenResponse),
    Failed(String),
    Superseded,
}

async fn request_device_code(
    endpoints: &TwitchEndpoints,
    client_id: &str,
) -> Result<DeviceCodeResponse, String> {
    let response = http_client()
        .post(&endpoints.device_url)
        .form(&[("client_id", client_id), ("scopes", TWITCH_SCOPES)])
        .send()
        .await
        .map_err(|e| format!("Could not reach Twitch: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let body: serde_json::Value = response.json().await.unwrap_or_default();
        return Err(format!(
            "Twitch refused to start the login ({status}): {}. Check that the app's Client Type is \"Public\" in the Twitch developer console.",
            provider_error_message(&body)
        ));
    }
    response
        .json()
        .await
        .map_err(|e| format!("Unexpected response from Twitch: {e}"))
}

async fn poll_for_token(
    endpoints: &TwitchEndpoints,
    client_id: &str,
    device: &DeviceCodeResponse,
    is_current: impl Fn() -> bool,
) -> DevicePoll {
    let deadline = Instant::now() + Duration::from_secs(device.expires_in);
    let mut interval = Duration::from_secs(device.interval.clamp(1, 30));

    loop {
        tokio::time::sleep(interval).await;
        if !is_current() {
            return DevicePoll::Superseded;
        }
        if Instant::now() >= deadline {
            return DevicePoll::Failed(CODE_EXPIRED.to_string());
        }

        let response = match http_client()
            .post(&endpoints.token_url)
            .form(&[
                ("client_id", client_id),
                ("scopes", TWITCH_SCOPES),
                ("device_code", device.device_code.as_str()),
                ("grant_type", DEVICE_GRANT_TYPE),
            ])
            .send()
            .await
        {
            Ok(response) => response,
            Err(e) => {
                // Keep polling through network blips until the code expires.
                log::warn!("Twitch device token poll failed: {e}");
                continue;
            }
        };

        let status = response.status();
        if status.is_success() {
            let parsed = response.json::<ProviderTokenResponse>().await;
            if !is_current() {
                return DevicePoll::Superseded;
            }
            return match parsed {
                Ok(tokens) => DevicePoll::Authorized(tokens),
                Err(e) => DevicePoll::Failed(format!("Unexpected token response from Twitch: {e}")),
            };
        }

        let body: serde_json::Value = response.json().await.unwrap_or_default();
        match classify_poll_error(status, &body) {
            PollError::Pending | PollError::Transient => {}
            PollError::SlowDown => interval += Duration::from_secs(5),
            PollError::Fatal(message) => return DevicePoll::Failed(message),
        }
    }
}

/// Starts a Twitch login. Returns the code to show the user; the outcome
/// arrives later as an `auth-callback` event.
#[tauri::command]
pub async fn twitch_device_start(
    app: AppHandle,
    flow: tauri::State<'_, TwitchDeviceFlow>,
) -> Result<DeviceCodeInfo, String> {
    let client_id = config::twitch_client_id().ok_or_else(|| NOT_CONFIGURED.to_string())?;
    let endpoints = TwitchEndpoints::default();
    let device = request_device_code(&endpoints, &client_id).await?;

    let generation = flow.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let counter = flow.generation.clone();
    let info = DeviceCodeInfo {
        user_code: device.user_code.clone(),
        verification_uri: device.verification_uri.clone(),
        expires_in: device.expires_in,
    };

    tauri::async_runtime::spawn(async move {
        let is_current = || counter.load(Ordering::SeqCst) == generation;
        match poll_for_token(&endpoints, &client_id, &device, is_current).await {
            DevicePoll::Authorized(tokens) => {
                emit_auth_callback(&app, AuthCallback::success("twitch", tokens))
            }
            DevicePoll::Failed(message) => {
                emit_auth_callback(&app, AuthCallback::failure("twitch", message))
            }
            DevicePoll::Superseded => {}
        }
    });

    Ok(info)
}

#[tauri::command]
pub fn twitch_device_cancel(flow: tauri::State<'_, TwitchDeviceFlow>) {
    flow.generation.fetch_add(1, Ordering::SeqCst);
}

/// Public-client refresh: no secret. Twitch refresh tokens are single-use, so
/// the caller must store the returned one.
#[tauri::command]
pub async fn twitch_refresh_token(refresh_token: String) -> Result<TokenResponse, CommandError> {
    let client_id = config::twitch_client_id()
        .ok_or_else(|| CommandError::NotConfigured(NOT_CONFIGURED.to_string()))?;
    refresh_token_grant(
        TWITCH_TOKEN_URL,
        &[
            ("client_id", client_id.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
        ],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::post, Json, Router};
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn poll_errors_are_classified() {
        let body = |m: &str| serde_json::json!({ "status": 400, "message": m });
        let bad = reqwest::StatusCode::BAD_REQUEST;
        assert_eq!(
            classify_poll_error(bad, &body("authorization_pending")),
            PollError::Pending
        );
        assert_eq!(
            classify_poll_error(bad, &body("slow_down")),
            PollError::SlowDown
        );
        assert_eq!(
            classify_poll_error(bad, &body("invalid device code")),
            PollError::Fatal(CODE_EXPIRED.to_string())
        );
        assert_eq!(
            classify_poll_error(reqwest::StatusCode::BAD_GATEWAY, &body("")),
            PollError::Transient
        );
        assert!(matches!(
            classify_poll_error(bad, &body("something else")),
            PollError::Fatal(_)
        ));
    }

    /// Mock token endpoint that answers `pending` a few times, then succeeds.
    async fn spawn_token_endpoint(pending_responses: usize) -> (String, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let router = Router::new().route(
            "/token",
            post(move || {
                let counter = counter.clone();
                async move {
                    let n = counter.fetch_add(1, Ordering::SeqCst);
                    if n < pending_responses {
                        (
                            reqwest::StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({ "status": 400, "message": "authorization_pending" })),
                        )
                    } else {
                        (
                            reqwest::StatusCode::OK,
                            Json(serde_json::json!({
                                "access_token": "access",
                                "refresh_token": "refresh",
                                "expires_in": 14400,
                                "scope": ["chat:read"],
                                "token_type": "bearer"
                            })),
                        )
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (format!("http://127.0.0.1:{port}/token"), calls)
    }

    fn device(expires_in: u64) -> DeviceCodeResponse {
        DeviceCodeResponse {
            device_code: "device".into(),
            user_code: "ABCDEFGH".into(),
            verification_uri: "https://www.twitch.tv/activate?device-code=ABCDEFGH".into(),
            expires_in,
            interval: 1,
        }
    }

    #[tokio::test]
    async fn polls_until_the_user_authorizes() {
        let (token_url, calls) = spawn_token_endpoint(1).await;
        let endpoints = TwitchEndpoints {
            device_url: String::new(),
            token_url,
        };
        match poll_for_token(&endpoints, "client", &device(60), || true).await {
            DevicePoll::Authorized(tokens) => {
                assert_eq!(tokens.access_token, "access");
                assert_eq!(tokens.refresh_token.as_deref(), Some("refresh"));
            }
            other => panic!("expected authorization, got {other:?}"),
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn gives_up_when_the_code_expires() {
        let (token_url, _) = spawn_token_endpoint(usize::MAX).await;
        let endpoints = TwitchEndpoints {
            device_url: String::new(),
            token_url,
        };
        match poll_for_token(&endpoints, "client", &device(1), || true).await {
            DevicePoll::Failed(message) => assert_eq!(message, CODE_EXPIRED),
            other => panic!("expected expiry, got {other:?}"),
        }
    }
}
