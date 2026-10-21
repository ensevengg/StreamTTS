//! YouTube login (authorization code + PKCE over a loopback redirect), token
//! refresh, and the shared pieces the Twitch device flow reuses.

use axum::{
    extract::State,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::RwLock;

use crate::config;

/// Preferred loopback port: it is what existing Google "Web application"
/// clients have registered. "Desktop app" clients accept any loopback port, so
/// the server falls back to a free one when another program holds 3000.
const PREFERRED_PORT: u16 = 3000;
const CALLBACK_PATH: &str = "/callback";
const OAUTH_STATE_EXPIRY_SECS: u64 = 600;

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
/// liveBroadcasts.list, liveChatMessages.list and channels.list all accept the
/// read-only scope, so StreamTTS never asks for write access to the channel.
const YOUTUBE_SCOPE: &str = "https://www.googleapis.com/auth/youtube.readonly";

const CALLBACK_PAGE: &str = include_str!("../oauth_callback.html");
const CALLBACK_PAGE_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; \
    style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; \
    form-action 'none'; frame-ancestors 'none'";

/// Port the callback server listens on; 0 until it is bound.
static CALLBACK_PORT: AtomicU16 = AtomicU16::new(0);

/// One client for every provider call, with deadlines: a token request that
/// stalls on a flaky connection must fail instead of hanging forever.
pub fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

/// RFC 7636 S256 code challenge.
fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Payload of the `auth-callback` event that completes (or fails) a login.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AuthCallback {
    pub service: &'static str,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
    pub error: Option<String>,
}

impl AuthCallback {
    pub fn success(service: &'static str, tokens: ProviderTokenResponse) -> Self {
        Self {
            service,
            access_token: Some(tokens.access_token),
            refresh_token: tokens.refresh_token,
            expires_in: tokens.expires_in,
            error: None,
        }
    }

    pub fn failure(service: &'static str, message: impl Into<String>) -> Self {
        Self {
            service,
            access_token: None,
            refresh_token: None,
            expires_in: None,
            error: Some(message.into()),
        }
    }
}

pub fn emit_auth_callback(app: &AppHandle, callback: AuthCallback) {
    if let Err(e) = app.emit("auth-callback", &callback) {
        log::error!("Failed to emit auth callback: {e}");
    }
}

/// Where the callback server delivers completed logins (the webview in the
/// app, a recorder in tests).
pub type CallbackSink = Arc<dyn Fn(AuthCallback) + Send + Sync>;

#[derive(Debug, Clone, Deserialize)]
pub struct ProviderTokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<i64>,
}

/// Tokens returned to the webview by the refresh commands.
#[derive(Debug, Clone, Serialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
}

/// Serialized rejection for the refresh commands; the frontend switches on
/// `kind` to decide between signing the user out and retrying later.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub enum CommandError {
    NotConfigured(String),
    Network(String),
    BadResponse(String),
    InvalidGrant(String),
    InvalidClient(String),
}

/// Human-readable message from a Google or Twitch error body.
pub fn provider_error_message(body: &serde_json::Value) -> String {
    body["error_description"]
        .as_str()
        .or_else(|| body["message"].as_str())
        .or_else(|| body["error"].as_str())
        .unwrap_or("unknown error")
        .to_string()
}

/// Google reports a dead refresh token as `invalid_grant`; Twitch answers 400
/// "Invalid refresh token" or 401. Either way the user has to log in again.
fn classify_refresh_failure(status: StatusCode, body: &serde_json::Value) -> CommandError {
    let error = body["error"].as_str().unwrap_or("");
    let message = provider_error_message(body);
    if error == "invalid_client" {
        CommandError::InvalidClient(message)
    } else if error == "invalid_grant"
        || status == StatusCode::UNAUTHORIZED
        || message.eq_ignore_ascii_case("invalid refresh token")
    {
        CommandError::InvalidGrant(message)
    } else {
        CommandError::BadResponse(format!(
            "Token refresh failed with status {status}: {message}"
        ))
    }
}

pub async fn refresh_token_grant(
    endpoint: &str,
    params: &[(&str, &str)],
) -> Result<TokenResponse, CommandError> {
    let response = http_client()
        .post(endpoint)
        .form(params)
        .send()
        .await
        .map_err(|e| CommandError::Network(format!("Could not reach the login provider: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        let body: serde_json::Value = response.json().await.unwrap_or_default();
        return Err(classify_refresh_failure(status, &body));
    }

    let tokens: ProviderTokenResponse = response
        .json()
        .await
        .map_err(|e| CommandError::BadResponse(format!("Unexpected refresh response: {e}")))?;
    Ok(TokenResponse {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
    })
}

#[tauri::command]
pub async fn youtube_refresh_token(refresh_token: String) -> Result<TokenResponse, CommandError> {
    let google = GoogleConfig::from_config().ok_or_else(|| {
        CommandError::NotConfigured("YouTube login isn't configured in this build.".to_string())
    })?;
    refresh_token_grant(
        &google.token_url,
        &[
            ("client_id", google.client_id.as_str()),
            ("client_secret", google.client_secret.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
        ],
    )
    .await
}

#[derive(Debug, Clone)]
struct PendingAuth {
    created_at: u64,
    code_verifier: String,
}

/// Login attempts started by `youtube_auth_start`. The callback server
/// consumes each state exactly once, so a code can't be replayed and no other
/// local process can complete a login the app didn't start.
#[derive(Clone, Default)]
pub struct OAuthStates(Arc<RwLock<HashMap<String, PendingAuth>>>);

impl OAuthStates {
    async fn register(&self, state: String, code_verifier: String) {
        let mut map = self.0.write().await;
        let now = now_secs();
        map.retain(|_, entry| now.saturating_sub(entry.created_at) < OAUTH_STATE_EXPIRY_SECS);
        map.insert(
            state,
            PendingAuth {
                created_at: now,
                code_verifier,
            },
        );
    }

    async fn consume(&self, state: &str) -> Option<PendingAuth> {
        let mut map = self.0.write().await;
        map.remove(state)
            .filter(|entry| now_secs().saturating_sub(entry.created_at) <= OAUTH_STATE_EXPIRY_SECS)
    }
}

#[derive(Debug, Clone)]
struct GoogleConfig {
    client_id: String,
    client_secret: String,
    token_url: String,
}

impl GoogleConfig {
    fn from_config() -> Option<Self> {
        Some(Self {
            client_id: config::youtube_client_id()?,
            client_secret: config::youtube_client_secret()?,
            token_url: GOOGLE_TOKEN_URL.to_string(),
        })
    }
}

fn redirect_uri(port: u16) -> String {
    format!("http://localhost:{port}{CALLBACK_PATH}")
}

fn build_youtube_auth_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    code_challenge: &str,
) -> Result<String, String> {
    reqwest::Url::parse_with_params(
        GOOGLE_AUTH_URL,
        &[
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
            ("response_type", "code"),
            ("scope", YOUTUBE_SCOPE),
            // A refresh token keeps chat working past the 1-hour access
            // token; prompt=consent makes Google issue one on every login.
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("code_challenge", code_challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
        ],
    )
    .map(|url| url.to_string())
    .map_err(|e| format!("Could not build the YouTube login URL: {e}"))
}

/// Starts a YouTube login and returns the URL to open in the browser. State
/// and PKCE verifier are generated and kept here; neither reaches the webview.
#[tauri::command]
pub async fn youtube_auth_start(states: tauri::State<'_, OAuthStates>) -> Result<String, String> {
    let port = CALLBACK_PORT.load(Ordering::Acquire);
    if port == 0 {
        return Err("The login server isn't running. Restart StreamTTS and try again.".to_string());
    }
    let google = GoogleConfig::from_config().ok_or_else(|| {
        "YouTube login isn't configured in this build (missing YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET)."
            .to_string()
    })?;

    let state = random_hex(32);
    // 64 hex characters is a valid RFC 7636 verifier (43-128 unreserved chars).
    let verifier = random_hex(32);
    let url = build_youtube_auth_url(
        &google.client_id,
        &redirect_uri(port),
        &state,
        &pkce_challenge(&verifier),
    )?;
    states.register(state, verifier).await;
    Ok(url)
}

async fn exchange_google_code(
    google: &GoogleConfig,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<ProviderTokenResponse, String> {
    let response = http_client()
        .post(&google.token_url)
        .form(&[
            ("code", code),
            ("client_id", google.client_id.as_str()),
            ("client_secret", google.client_secret.as_str()),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await
        .map_err(|e| format!("Could not reach Google: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body: serde_json::Value = response.json().await.unwrap_or_default();
        return Err(format!(
            "Google rejected the code ({status}): {}",
            provider_error_message(&body)
        ));
    }
    response
        .json()
        .await
        .map_err(|e| format!("Unexpected token response from Google: {e}"))
}

#[derive(Clone)]
struct ServerState {
    sink: CallbackSink,
    states: OAuthStates,
    port: u16,
    google: Option<GoogleConfig>,
}

/// The callback page is the only legitimate caller of the POST endpoints, and
/// browsers always send Origin on POST.
fn is_same_origin(headers: &HeaderMap, port: u16) -> bool {
    headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|origin| {
            origin == format!("http://localhost:{port}")
                || origin == format!("http://127.0.0.1:{port}")
        })
}

fn error_json(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

async fn callback_page() -> Response {
    let mut response = Html(CALLBACK_PAGE).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CALLBACK_PAGE_CSP),
    );
    response
}

#[derive(Deserialize)]
struct ExchangeRequest {
    code: String,
    state: String,
}

async fn handle_auth_exchange(
    State(server): State<ServerState>,
    headers: HeaderMap,
    Json(request): Json<ExchangeRequest>,
) -> Response {
    if !is_same_origin(&headers, server.port) {
        return StatusCode::FORBIDDEN.into_response();
    }
    // Consume the state before touching the network so a code can't be
    // replayed through this endpoint.
    let Some(pending) = server.states.consume(&request.state).await else {
        return error_json(
            StatusCode::BAD_REQUEST,
            "This login link expired or was already used. Start the login again from StreamTTS.",
        );
    };
    let Some(google) = server.google.as_ref() else {
        return error_json(
            StatusCode::SERVICE_UNAVAILABLE,
            "YouTube login isn't configured in this build.",
        );
    };

    match exchange_google_code(
        google,
        &request.code,
        &pending.code_verifier,
        &redirect_uri(server.port),
    )
    .await
    {
        Ok(tokens) => {
            (server.sink)(AuthCallback::success("youtube", tokens));
            // Tokens go to the app over IPC only; the browser page just learns
            // that the login worked.
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(message) => {
            log::error!("YouTube token exchange failed: {message}");
            const USER_MESSAGE: &str = "Token exchange failed. Please try again.";
            (server.sink)(AuthCallback::failure("youtube", USER_MESSAGE));
            error_json(StatusCode::BAD_GATEWAY, USER_MESSAGE)
        }
    }
}

#[derive(Deserialize)]
struct ErrorReport {
    state: String,
    error: String,
}

fn describe_provider_error(code: &str) -> String {
    match code {
        "access_denied" => "The YouTube login was cancelled.".to_string(),
        other => {
            let cleaned: String = other
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ' ' | '.'))
                .take(80)
                .collect();
            format!("YouTube login failed: {cleaned}")
        }
    }
}

/// Lets the callback page report a provider-side failure (for example the
/// user declining consent) so the app can reset its login UI.
async fn handle_auth_error(
    State(server): State<ServerState>,
    headers: HeaderMap,
    Json(report): Json<ErrorReport>,
) -> Response {
    if !is_same_origin(&headers, server.port) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if server.states.consume(&report.state).await.is_none() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    (server.sink)(AuthCallback::failure(
        "youtube",
        describe_provider_error(&report.error),
    ));
    StatusCode::NO_CONTENT.into_response()
}

fn callback_router(state: ServerState) -> Router {
    Router::new()
        .route(CALLBACK_PATH, get(callback_page))
        .route("/auth-exchange", post(handle_auth_exchange))
        .route("/auth-error", post(handle_auth_error))
        .with_state(state)
}

/// Binds `port` on both loopback stacks. Browsers resolve `localhost` to ::1
/// as readily as to 127.0.0.1, so a port is only safe if no other process
/// holds it on either address; otherwise the redirect carrying the
/// authorization code could reach that process instead.
async fn try_bind_loopback(port: u16) -> Option<Vec<TcpListener>> {
    let v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await.ok()?;
    let port = v4.local_addr().ok()?.port();
    match TcpListener::bind((Ipv6Addr::LOCALHOST, port)).await {
        Ok(v6) => Some(vec![v4, v6]),
        // No IPv6 loopback on this machine, so localhost can only mean 127.0.0.1.
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::AddrNotAvailable | std::io::ErrorKind::Unsupported
            ) =>
        {
            Some(vec![v4])
        }
        Err(_) => None,
    }
}

async fn bind_loopback() -> anyhow::Result<Vec<TcpListener>> {
    if let Some(listeners) = try_bind_loopback(PREFERRED_PORT).await {
        return Ok(listeners);
    }
    log::warn!(
        "Port {PREFERRED_PORT} is in use; the login callback will use a random loopback port"
    );
    for _ in 0..5 {
        if let Some(listeners) = try_bind_loopback(0).await {
            return Ok(listeners);
        }
    }
    anyhow::bail!("could not bind a loopback port for the login callback")
}

async fn serve_callback(
    sink: CallbackSink,
    states: OAuthStates,
    google: Option<GoogleConfig>,
) -> anyhow::Result<()> {
    let listeners = bind_loopback().await?;
    let port = listeners[0].local_addr()?.port();
    let router = callback_router(ServerState {
        sink,
        states,
        port,
        google,
    });

    CALLBACK_PORT.store(port, Ordering::Release);
    log::info!("OAuth callback server listening on localhost:{port}");

    let mut servers = tokio::task::JoinSet::new();
    for listener in listeners {
        let router = router.clone();
        servers.spawn(async move { axum::serve(listener, router).await });
    }
    let mut result = Ok(());
    if let Some(finished) = servers.join_next().await {
        result = match finished {
            Ok(served) => served.map_err(anyhow::Error::from),
            Err(join_error) => Err(join_error.into()),
        };
    }
    CALLBACK_PORT.store(0, Ordering::Release);
    result
}

pub async fn start_callback_server(app: AppHandle, states: OAuthStates) -> anyhow::Result<()> {
    if config::youtube_client_id().is_none() || config::youtube_client_secret().is_none() {
        log::warn!(
            "YouTube OAuth client is not configured; YouTube login is disabled in this build"
        );
    }
    let sink: CallbackSink = Arc::new(move |callback| emit_auth_callback(&app, callback));
    serve_callback(sink, states, GoogleConfig::from_config()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn pkce_challenge_matches_rfc_7636_example() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn auth_url_requests_read_only_scope_with_pkce() {
        let url =
            build_youtube_auth_url("client", "http://localhost:3000/callback", "st", "ch").unwrap();
        let parsed = reqwest::Url::parse(&url).unwrap();
        let params: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(params["scope"], YOUTUBE_SCOPE);
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(params["redirect_uri"], "http://localhost:3000/callback");
        assert!(!params.contains_key("include_granted_scopes"));
    }

    #[test]
    fn refresh_failures_are_classified_per_provider() {
        let google = serde_json::json!({ "error": "invalid_grant", "error_description": "Token has been expired or revoked." });
        assert!(matches!(
            classify_refresh_failure(StatusCode::BAD_REQUEST, &google),
            CommandError::InvalidGrant(_)
        ));

        let twitch = serde_json::json!({ "error": "Bad Request", "status": 400, "message": "Invalid refresh token" });
        assert!(matches!(
            classify_refresh_failure(StatusCode::BAD_REQUEST, &twitch),
            CommandError::InvalidGrant(_)
        ));
        assert!(matches!(
            classify_refresh_failure(StatusCode::UNAUTHORIZED, &serde_json::Value::Null),
            CommandError::InvalidGrant(_)
        ));

        // Google answers a misconfigured client with 401 invalid_client.
        let client = serde_json::json!({ "error": "invalid_client" });
        assert!(matches!(
            classify_refresh_failure(StatusCode::UNAUTHORIZED, &client),
            CommandError::InvalidClient(_)
        ));

        assert!(matches!(
            classify_refresh_failure(StatusCode::SERVICE_UNAVAILABLE, &serde_json::Value::Null),
            CommandError::BadResponse(_)
        ));
    }

    type Recorded = Arc<Mutex<Vec<AuthCallback>>>;

    async fn spawn(router: Router) -> u16 {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        port
    }

    /// Callback server wired to a mock Google token endpoint.
    async fn spawn_callback_server(google_status: StatusCode) -> (u16, OAuthStates, Recorded) {
        let mock_google = Router::new().route(
            "/token",
            post(move || async move {
                (
                    google_status,
                    Json(serde_json::json!({
                        "access_token": "ya29.access",
                        "refresh_token": "1//refresh",
                        "expires_in": 3599,
                        "token_type": "Bearer"
                    })),
                )
            }),
        );
        let google_port = spawn(mock_google).await;

        let recorded: Recorded = Arc::default();
        let sink_target = recorded.clone();
        let sink: CallbackSink =
            Arc::new(move |callback| sink_target.lock().unwrap().push(callback));
        let states = OAuthStates::default();

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let router = callback_router(ServerState {
            sink,
            states: states.clone(),
            port,
            google: Some(GoogleConfig {
                client_id: "client".into(),
                client_secret: "secret".into(),
                token_url: format!("http://127.0.0.1:{google_port}/token"),
            }),
        });
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (port, states, recorded)
    }

    async fn post_json(
        port: u16,
        path: &str,
        origin: &str,
        body: serde_json::Value,
    ) -> reqwest::Response {
        reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}{path}"))
            .header(header::ORIGIN, origin)
            .json(&body)
            .send()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn exchange_delivers_tokens_over_ipc_only() {
        let (port, states, recorded) = spawn_callback_server(StatusCode::OK).await;
        states.register("st".into(), "verifier".into()).await;

        let origin = format!("http://localhost:{port}");
        let response = post_json(
            port,
            "/auth-exchange",
            &origin,
            serde_json::json!({ "code": "c", "state": "st" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.text().await.unwrap();
        assert!(
            !body.contains("ya29.access"),
            "tokens must not be returned to the browser: {body}"
        );

        let callbacks = recorded.lock().unwrap().clone();
        assert_eq!(callbacks.len(), 1);
        assert_eq!(callbacks[0].access_token.as_deref(), Some("ya29.access"));
        assert_eq!(callbacks[0].refresh_token.as_deref(), Some("1//refresh"));

        // The state was consumed: replaying the same code is rejected.
        let replay = post_json(
            port,
            "/auth-exchange",
            &origin,
            serde_json::json!({ "code": "c", "state": "st" }),
        )
        .await;
        assert_eq!(replay.status(), StatusCode::BAD_REQUEST);
        assert_eq!(recorded.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn exchange_rejects_foreign_origins_and_unknown_states() {
        let (port, states, recorded) = spawn_callback_server(StatusCode::OK).await;
        states.register("st".into(), "verifier".into()).await;

        let foreign = post_json(
            port,
            "/auth-exchange",
            "https://evil.example",
            serde_json::json!({ "code": "c", "state": "st" }),
        )
        .await;
        assert_eq!(foreign.status(), StatusCode::FORBIDDEN);

        let origin = format!("http://localhost:{port}");
        let unknown = post_json(
            port,
            "/auth-exchange",
            &origin,
            serde_json::json!({ "code": "c", "state": "nope" }),
        )
        .await;
        assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);
        assert!(recorded.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn failed_exchange_reports_an_error_to_the_app() {
        let (port, states, recorded) = spawn_callback_server(StatusCode::BAD_REQUEST).await;
        states.register("st".into(), "verifier".into()).await;

        let origin = format!("http://localhost:{port}");
        let response = post_json(
            port,
            "/auth-exchange",
            &origin,
            serde_json::json!({ "code": "c", "state": "st" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let callbacks = recorded.lock().unwrap().clone();
        assert_eq!(callbacks.len(), 1);
        assert!(callbacks[0].access_token.is_none());
        assert!(callbacks[0].error.is_some());
    }

    #[tokio::test]
    async fn provider_errors_reset_the_login_once() {
        let (port, states, recorded) = spawn_callback_server(StatusCode::OK).await;
        states.register("st".into(), "verifier".into()).await;

        let origin = format!("http://localhost:{port}");
        let report = serde_json::json!({ "state": "st", "error": "access_denied" });
        assert_eq!(
            post_json(port, "/auth-error", &origin, report.clone())
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            post_json(port, "/auth-error", &origin, report)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );

        let callbacks = recorded.lock().unwrap().clone();
        assert_eq!(
            callbacks,
            vec![AuthCallback::failure(
                "youtube",
                "The YouTube login was cancelled."
            )]
        );
    }

    #[tokio::test]
    async fn callback_page_is_served_with_hardening_headers() {
        let (port, _, _) = spawn_callback_server(StatusCode::OK).await;
        let response = reqwest::get(format!("http://127.0.0.1:{port}/callback?code=c&state=s"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
        assert!(response
            .headers()
            .contains_key(header::CONTENT_SECURITY_POLICY));
    }

    #[tokio::test]
    async fn loopback_bind_skips_ports_held_on_either_stack() {
        let squatter = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let taken = squatter.local_addr().unwrap().port();
        assert!(try_bind_loopback(taken).await.is_none());

        let listeners = try_bind_loopback(0).await.unwrap();
        let port = listeners[0].local_addr().unwrap().port();
        assert!(listeners
            .iter()
            .all(|l| l.local_addr().unwrap().port() == port));
    }
}
