//! YouTube live chat over `liveChatMessages.streamList`: one long-lived gRPC
//! call that YouTube pushes messages down, instead of polling
//! `liveChatMessages.list` every few seconds. Both cost 5 quota units per
//! call, so a stream that stays open for minutes uses a small fraction of
//! the quota polling does. The quota is shared by everyone using the app's
//! client ID.
//!
//! The message types are a hand-written subset of Google's
//! `stream_list.proto` (field numbers must match it); protobuf skips fields
//! we don't declare, so there's no generated code or `protoc` step.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::ipc::Channel as IpcChannel;
use tokio::sync::oneshot;
use tonic::codec::ProstCodec;
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use tonic::{Code, Status};

const YOUTUBE_GRPC_ENDPOINT: &str = "https://youtube.googleapis.com";
const STREAM_LIST_PATH: &str = "/youtube.api.v3.V3DataLiveChatMessageService/StreamList";

// ---- stream_list.proto subset ----------------------------------------------

#[derive(Clone, PartialEq, prost::Message)]
pub struct LiveChatMessageListRequest {
    #[prost(string, optional, tag = "1")]
    pub live_chat_id: Option<String>,
    #[prost(string, optional, tag = "99")]
    pub page_token: Option<String>,
    #[prost(string, repeated, tag = "100")]
    pub part: Vec<String>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct LiveChatMessageListResponse {
    #[prost(string, optional, tag = "2")]
    pub offline_at: Option<String>,
    #[prost(string, optional, tag = "100602")]
    pub next_page_token: Option<String>,
    #[prost(message, repeated, tag = "1007")]
    pub items: Vec<LiveChatMessage>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct LiveChatMessage {
    #[prost(string, optional, tag = "101")]
    pub id: Option<String>,
    #[prost(message, optional, tag = "2")]
    pub snippet: Option<LiveChatMessageSnippet>,
    #[prost(message, optional, tag = "3")]
    pub author_details: Option<LiveChatMessageAuthorDetails>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct LiveChatMessageAuthorDetails {
    #[prost(string, optional, tag = "10101")]
    pub channel_id: Option<String>,
    #[prost(string, optional, tag = "103")]
    pub display_name: Option<String>,
}

/// The proto's `displayed_content` oneof is declared as separate optional
/// fields; on the wire a oneof is just its member fields.
#[derive(Clone, PartialEq, prost::Message)]
pub struct LiveChatMessageSnippet {
    #[prost(int32, optional, tag = "1")]
    pub r#type: Option<i32>,
    #[prost(string, optional, tag = "4")]
    pub published_at: Option<String>,
    #[prost(string, optional, tag = "16")]
    pub display_message: Option<String>,
    #[prost(message, optional, tag = "19")]
    pub text_message_details: Option<TextMessageDetails>,
    #[prost(message, optional, tag = "27")]
    pub super_chat_details: Option<SuperChatDetails>,
    #[prost(message, optional, tag = "28")]
    pub super_sticker_details: Option<SuperStickerDetails>,
    #[prost(message, optional, tag = "29")]
    pub new_sponsor_details: Option<NewSponsorDetails>,
    #[prost(message, optional, tag = "30")]
    pub member_milestone_chat_details: Option<MemberMilestoneChatDetails>,
    #[prost(message, optional, tag = "31")]
    pub membership_gifting_details: Option<MembershipGiftingDetails>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct TextMessageDetails {
    #[prost(string, optional, tag = "1")]
    pub message_text: Option<String>,
}

#[derive(Clone, PartialEq, prost::Message, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperChatDetails {
    #[prost(string, optional, tag = "3")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_display_string: Option<String>,
    #[prost(string, optional, tag = "4")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_comment: Option<String>,
}

#[derive(Clone, PartialEq, prost::Message, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperStickerDetails {
    #[prost(string, optional, tag = "3")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_display_string: Option<String>,
}

#[derive(Clone, PartialEq, prost::Message, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSponsorDetails {
    #[prost(string, optional, tag = "1")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_level_name: Option<String>,
    #[prost(bool, optional, tag = "2")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_upgrade: Option<bool>,
}

#[derive(Clone, PartialEq, prost::Message, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberMilestoneChatDetails {
    #[prost(uint32, optional, tag = "2")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_month: Option<u32>,
    #[prost(string, optional, tag = "3")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_comment: Option<String>,
}

#[derive(Clone, PartialEq, prost::Message, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MembershipGiftingDetails {
    #[prost(int32, optional, tag = "1")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gift_memberships_count: Option<i32>,
}

// ---- What the webview receives ---------------------------------------------
// The same JSON shape as the REST liveChatMessages.list response, so the
// frontend handles streamed and polled pages with one code path.

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatPage {
    pub items: Vec<ChatItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_page_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offline_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatItem {
    pub id: String,
    pub snippet: ChatSnippet,
    pub author_details: ChatAuthor,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSnippet {
    #[serde(rename = "type")]
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub super_chat_details: Option<SuperChatDetails>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub super_sticker_details: Option<SuperStickerDetails>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_sponsor_details: Option<NewSponsorDetails>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_milestone_chat_details: Option<MemberMilestoneChatDetails>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub membership_gifting_details: Option<MembershipGiftingDetails>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatAuthor {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
}

/// LiveChatMessageSnippet.TypeWrapper.Type, as the REST API spells it.
fn type_name(value: Option<i32>) -> &'static str {
    match value {
        Some(1) => "textMessageEvent",
        Some(2) => "tombstone",
        Some(3) => "fanFundingEvent",
        Some(4) => "chatEndedEvent",
        Some(5) => "sponsorOnlyModeStartedEvent",
        Some(6) => "sponsorOnlyModeEndedEvent",
        Some(7) => "newSponsorEvent",
        Some(10) => "userBannedEvent",
        Some(15) => "superChatEvent",
        Some(16) => "superStickerEvent",
        Some(17) => "memberMilestoneChatEvent",
        Some(18) => "membershipGiftingEvent",
        Some(19) => "giftMembershipReceivedEvent",
        Some(20) => "pollEvent",
        Some(21) => "giftEvent",
        _ => "invalidType",
    }
}

impl From<LiveChatMessageListResponse> for ChatPage {
    fn from(response: LiveChatMessageListResponse) -> Self {
        let items = response
            .items
            .into_iter()
            .filter_map(|message| {
                let snippet = message.snippet.unwrap_or_default();
                let author = message.author_details.unwrap_or_default();
                let display_message = snippet
                    .display_message
                    .or_else(|| snippet.text_message_details.and_then(|d| d.message_text));
                Some(ChatItem {
                    id: message.id?,
                    snippet: ChatSnippet {
                        kind: type_name(snippet.r#type),
                        published_at: snippet.published_at,
                        display_message,
                        super_chat_details: snippet.super_chat_details,
                        super_sticker_details: snippet.super_sticker_details,
                        new_sponsor_details: snippet.new_sponsor_details,
                        member_milestone_chat_details: snippet.member_milestone_chat_details,
                        membership_gifting_details: snippet.membership_gifting_details,
                    },
                    author_details: ChatAuthor {
                        display_name: author.display_name,
                        channel_id: author.channel_id,
                    },
                })
            })
            .collect();
        ChatPage {
            items,
            next_page_token: response.next_page_token,
            offline_at: response.offline_at,
        }
    }
}

/// A stream failure expressed like a REST error (HTTP status plus the REST
/// `reason`), so the frontend's existing error handling applies unchanged.
/// Status 0 means YouTube couldn't be reached over gRPC at all.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StreamFailure {
    pub status: u16,
    pub reason: String,
    pub message: String,
}

/// Maps gRPC status codes onto the REST reasons from the streamList docs.
fn classify_status(status: &Status) -> StreamFailure {
    let message = status.message().to_string();
    let lower = message.to_ascii_lowercase();
    let mentions_quota = lower.contains("quota");
    let (code, reason) = match status.code() {
        Code::Unauthenticated => (401, "authError"),
        Code::PermissionDenied if mentions_quota => (403, "quotaExceeded"),
        Code::PermissionDenied => (403, "forbidden"),
        Code::ResourceExhausted if mentions_quota => (403, "quotaExceeded"),
        Code::ResourceExhausted => (403, "rateLimitExceeded"),
        Code::FailedPrecondition if lower.contains("live_chat_ended") => (403, "liveChatEnded"),
        Code::FailedPrecondition if lower.contains("live_chat_disabled") => {
            (403, "liveChatDisabled")
        }
        Code::FailedPrecondition => (400, "failedPrecondition"),
        Code::NotFound => (404, "liveChatNotFound"),
        Code::InvalidArgument if lower.contains("page") && lower.contains("token") => {
            (400, "pageTokenInvalid")
        }
        Code::InvalidArgument => (400, "invalidArgument"),
        Code::Unimplemented => (501, "streamUnsupported"),
        // Includes "couldn't connect": the network, a proxy or a firewall.
        Code::Unavailable => (0, "unavailable"),
        _ => (503, "backendError"),
    };
    StreamFailure {
        status: code,
        reason: reason.to_string(),
        message,
    }
}

fn youtube_channel() -> Result<Channel, String> {
    static CHANNEL: OnceLock<Channel> = OnceLock::new();
    if let Some(channel) = CHANNEL.get() {
        return Ok(channel.clone());
    }
    let channel = Endpoint::from_static(YOUTUBE_GRPC_ENDPOINT)
        .tls_config(ClientTlsConfig::new().with_native_roots())
        .map_err(|e| format!("Could not set up TLS for YouTube: {e}"))?
        .connect_timeout(Duration::from_secs(10))
        // HTTP/2 pings notice a dead connection (Wi-Fi drop, sleeping
        // router) during a quiet chat, when no messages would reveal it.
        .http2_keep_alive_interval(Duration::from_secs(30))
        .keep_alive_timeout(Duration::from_secs(10))
        .keep_alive_while_idle(true)
        .connect_lazy();
    Ok(CHANNEL.get_or_init(|| channel).clone())
}

async fn open_stream(
    channel: Channel,
    access_token: &str,
    request: LiveChatMessageListRequest,
) -> Result<tonic::Streaming<LiveChatMessageListResponse>, StreamFailure> {
    let mut grpc = tonic::client::Grpc::new(channel);
    grpc.ready().await.map_err(|e| {
        classify_status(&Status::unavailable(format!("YouTube is unreachable: {e}")))
    })?;

    let mut request = tonic::Request::new(request);
    let bearer = format!("Bearer {access_token}").parse().map_err(|_| {
        classify_status(&Status::unauthenticated(
            "the access token is not a valid header value",
        ))
    })?;
    request.metadata_mut().insert("authorization", bearer);

    let codec: ProstCodec<LiveChatMessageListRequest, LiveChatMessageListResponse> =
        ProstCodec::default();
    let path = axum::http::uri::PathAndQuery::from_static(STREAM_LIST_PATH);
    grpc.server_streaming(request, path, codec)
        .await
        .map(tonic::Response::into_inner)
        .map_err(|status| classify_status(&status))
}

/// Streams pages until YouTube closes the stream (Ok), it fails (Err), or
/// `cancel` fires or is dropped (Ok).
async fn run_stream(
    channel: Channel,
    access_token: &str,
    live_chat_id: String,
    page_token: Option<String>,
    mut cancel: oneshot::Receiver<()>,
    mut on_page: impl FnMut(ChatPage),
) -> Result<(), StreamFailure> {
    let request = LiveChatMessageListRequest {
        live_chat_id: Some(live_chat_id),
        page_token,
        part: vec!["snippet".to_string(), "authorDetails".to_string()],
    };
    let mut stream = tokio::select! {
        opened = open_stream(channel, access_token, request) => opened?,
        _ = &mut cancel => return Ok(()),
    };
    loop {
        tokio::select! {
            message = stream.message() => match message {
                Ok(Some(response)) => on_page(ChatPage::from(response)),
                Ok(None) => return Ok(()),
                Err(status) => return Err(classify_status(&status)),
            },
            _ = &mut cancel => return Ok(()),
        }
    }
}

/// Open streams, so the webview can stop the one it started.
#[derive(Default)]
pub struct ChatStreams(Mutex<HashMap<u64, oneshot::Sender<()>>>);

impl ChatStreams {
    fn register(&self, id: u64) -> oneshot::Receiver<()> {
        let (sender, receiver) = oneshot::channel();
        if let Ok(mut map) = self.0.lock() {
            // A reused id replaces (and so cancels) the older stream.
            map.insert(id, sender);
        }
        receiver
    }

    fn finish(&self, id: u64) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(&id);
        }
    }

    fn cancel(&self, id: u64) {
        if let Some(sender) = self.0.lock().ok().and_then(|mut map| map.remove(&id)) {
            let _ = sender.send(());
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum StreamEvent {
    Page {
        page: ChatPage,
    },
    /// Always the last event. `error` is None when YouTube closed the
    /// stream normally or the webview stopped it.
    End {
        error: Option<StreamFailure>,
    },
}

/// Runs one streamList call, sending each page and then a final `End` event
/// over `on_event`. Pages and the end go through the same channel so the
/// webview sees them in order.
#[tauri::command]
pub async fn youtube_chat_stream(
    stream_id: u64,
    access_token: String,
    live_chat_id: String,
    page_token: Option<String>,
    on_event: IpcChannel<StreamEvent>,
    streams: tauri::State<'_, ChatStreams>,
) -> Result<(), String> {
    let cancel = streams.register(stream_id);
    let result = match youtube_channel() {
        Ok(channel) => {
            run_stream(
                channel,
                &access_token,
                live_chat_id,
                page_token,
                cancel,
                |page| {
                    let _ = on_event.send(StreamEvent::Page { page });
                },
            )
            .await
        }
        Err(message) => Err(StreamFailure {
            status: 0,
            reason: "unavailable".to_string(),
            message,
        }),
    };
    streams.finish(stream_id);
    on_event
        .send(StreamEvent::End {
            error: result.err(),
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn youtube_chat_stream_stop(stream_id: u64, streams: tauri::State<'_, ChatStreams>) {
    streams.cancel(stream_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::convert::Infallible;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::task::{Context, Poll};

    type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
    /// (authorization header, page token) of each request the mock received.
    type RequestLog = Arc<Mutex<Vec<(Option<String>, Option<String>)>>>;
    type PageStream = Pin<
        Box<dyn tokio_stream::Stream<Item = Result<LiveChatMessageListResponse, Status>> + Send>,
    >;

    fn text_message(id: &str, text: &str) -> LiveChatMessage {
        LiveChatMessage {
            id: Some(id.into()),
            snippet: Some(LiveChatMessageSnippet {
                r#type: Some(1),
                published_at: Some("2026-10-20T12:00:00Z".into()),
                display_message: Some(text.into()),
                ..Default::default()
            }),
            author_details: Some(LiveChatMessageAuthorDetails {
                channel_id: Some("UC1".into()),
                display_name: Some("Viewer".into()),
            }),
        }
    }

    #[test]
    fn pages_use_the_rest_json_shape() {
        let page = ChatPage::from(LiveChatMessageListResponse {
            offline_at: None,
            next_page_token: Some("next".into()),
            items: vec![
                text_message("m1", "!г привет"),
                LiveChatMessage {
                    id: Some("sc1".into()),
                    snippet: Some(LiveChatMessageSnippet {
                        r#type: Some(15),
                        super_chat_details: Some(SuperChatDetails {
                            amount_display_string: Some("$5.00".into()),
                            user_comment: Some("hi".into()),
                        }),
                        ..Default::default()
                    }),
                    author_details: None,
                },
            ],
        });
        let json = serde_json::to_value(&page).unwrap();
        assert_eq!(json["nextPageToken"], "next");
        assert_eq!(json["items"][0]["snippet"]["type"], "textMessageEvent");
        assert_eq!(json["items"][0]["snippet"]["displayMessage"], "!г привет");
        assert_eq!(json["items"][0]["authorDetails"]["displayName"], "Viewer");
        assert_eq!(json["items"][1]["snippet"]["type"], "superChatEvent");
        assert_eq!(
            json["items"][1]["snippet"]["superChatDetails"]["amountDisplayString"],
            "$5.00"
        );
    }

    #[test]
    fn decodes_bytes_with_fields_it_does_not_declare() {
        // A full message from YouTube carries fields this subset skips.
        let mut bytes = prost::Message::encode_to_vec(&LiveChatMessageListResponse {
            items: vec![text_message("m1", "hello")],
            ..Default::default()
        });
        // Append field 1004 (page_info), a message we don't model.
        bytes.extend_from_slice(&[0xE2, 0x3E, 0x02, 0x08, 0x01]);
        let decoded: LiveChatMessageListResponse =
            prost::Message::decode(bytes.as_slice()).unwrap();
        assert_eq!(decoded.items[0].id.as_deref(), Some("m1"));
    }

    #[test]
    fn grpc_errors_map_onto_rest_reasons() {
        let reason = |status: Status| classify_status(&status).reason;
        assert_eq!(reason(Status::unauthenticated("x")), "authError");
        assert_eq!(
            reason(Status::failed_precondition("LIVE_CHAT_ENDED")),
            "liveChatEnded"
        );
        assert_eq!(
            reason(Status::failed_precondition("LIVE_CHAT_DISABLED")),
            "liveChatDisabled"
        );
        assert_eq!(reason(Status::not_found("x")), "liveChatNotFound");
        assert_eq!(
            reason(Status::resource_exhausted("too fast")),
            "rateLimitExceeded"
        );
        assert_eq!(
            reason(Status::resource_exhausted("daily quota exceeded")),
            "quotaExceeded"
        );
        assert_eq!(
            reason(Status::permission_denied(
                "The caller does not have permission"
            )),
            "forbidden"
        );
        assert_eq!(reason(Status::unimplemented("x")), "streamUnsupported");
        assert_eq!(
            classify_status(&Status::unavailable("connect error")).status,
            0
        );
    }

    // ---- A minimal StreamList server to test the client against -----------

    #[derive(Clone)]
    struct MockYouTube {
        pages: Vec<LiveChatMessageListResponse>,
        finish: Option<Status>,
        /// Keep the stream open after the pages (to test cancellation).
        hold_open: bool,
        requests: RequestLog,
    }

    impl tonic::server::NamedService for MockYouTube {
        const NAME: &'static str = "youtube.api.v3.V3DataLiveChatMessageService";
    }

    struct StreamListHandler(MockYouTube);

    impl tonic::server::ServerStreamingService<LiveChatMessageListRequest> for StreamListHandler {
        type Response = LiveChatMessageListResponse;
        type ResponseStream = PageStream;
        type Future = BoxFuture<Result<tonic::Response<PageStream>, Status>>;

        fn call(&mut self, request: tonic::Request<LiveChatMessageListRequest>) -> Self::Future {
            let mock = self.0.clone();
            Box::pin(async move {
                let auth = request
                    .metadata()
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string);
                mock.requests
                    .lock()
                    .unwrap()
                    .push((auth.clone(), request.get_ref().page_token.clone()));
                if auth.as_deref() != Some("Bearer good-token") {
                    return Err(Status::unauthenticated(
                        "Request had invalid authentication credentials.",
                    ));
                }
                let mut events: Vec<Result<LiveChatMessageListResponse, Status>> =
                    mock.pages.into_iter().map(Ok).collect();
                if let Some(status) = mock.finish {
                    events.push(Err(status));
                }
                let pages = tokio_stream::iter(events);
                let stream: PageStream = if mock.hold_open {
                    Box::pin(tokio_stream::StreamExt::chain(
                        pages,
                        tokio_stream::pending(),
                    ))
                } else {
                    Box::pin(pages)
                };
                Ok(tonic::Response::new(stream))
            })
        }
    }

    impl<B> tower_service::Service<axum::http::Request<B>> for MockYouTube
    where
        B: http_body::Body + Send + 'static,
        B::Error: Into<Box<dyn std::error::Error + Send + Sync>> + Send + 'static,
    {
        type Response = axum::http::Response<tonic::body::BoxBody>;
        type Error = Infallible;
        type Future = BoxFuture<Result<Self::Response, Infallible>>;

        fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
            Poll::Ready(Ok(()))
        }

        fn call(&mut self, request: axum::http::Request<B>) -> Self::Future {
            let handler = StreamListHandler(self.clone());
            Box::pin(async move {
                let codec: ProstCodec<LiveChatMessageListResponse, LiveChatMessageListRequest> =
                    ProstCodec::default();
                Ok(tonic::server::Grpc::new(codec)
                    .server_streaming(handler, request)
                    .await)
            })
        }
    }

    async fn serve(mock: MockYouTube) -> Channel {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(
            tonic::transport::Server::builder()
                .add_service(mock)
                .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener)),
        );
        Endpoint::from_shared(format!("http://127.0.0.1:{port}"))
            .unwrap()
            .connect_lazy()
    }

    fn mock(pages: Vec<LiveChatMessageListResponse>, finish: Option<Status>) -> MockYouTube {
        MockYouTube {
            pages,
            finish,
            hold_open: false,
            requests: Arc::default(),
        }
    }

    fn page(token: &str, ids: &[&str]) -> LiveChatMessageListResponse {
        LiveChatMessageListResponse {
            next_page_token: Some(token.into()),
            items: ids.iter().map(|id| text_message(id, "hi")).collect(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn streams_pages_until_youtube_closes_the_stream() {
        let server = mock(vec![page("p1", &["a"]), page("p2", &["b", "c"])], None);
        let requests = server.requests.clone();
        let channel = serve(server).await;
        let (_keep, cancel) = oneshot::channel();

        let mut pages = Vec::new();
        let result = run_stream(
            channel,
            "good-token",
            "chat".into(),
            Some("resume".into()),
            cancel,
            |p| pages.push(p),
        )
        .await;

        assert_eq!(result, Ok(()));
        assert_eq!(
            pages.iter().map(|p| p.items.len()).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(pages[1].next_page_token.as_deref(), Some("p2"));
        assert_eq!(
            requests.lock().unwrap()[0],
            (Some("Bearer good-token".into()), Some("resume".into()))
        );
    }

    #[tokio::test]
    async fn reports_youtube_errors_with_rest_reasons() {
        let channel = serve(mock(
            vec![page("p1", &["a"])],
            Some(Status::failed_precondition("LIVE_CHAT_ENDED")),
        ))
        .await;
        let (_keep, cancel) = oneshot::channel();
        let mut pages = 0;
        let result = run_stream(channel, "good-token", "chat".into(), None, cancel, |_| {
            pages += 1
        })
        .await;
        assert_eq!(pages, 1);
        assert_eq!(result.unwrap_err().reason, "liveChatEnded");
    }

    #[tokio::test]
    async fn cancelling_ends_an_open_stream() {
        let mut server = mock(vec![page("p1", &["a"])], None);
        server.hold_open = true;
        let channel = serve(server).await;
        let streams = ChatStreams::default();
        let cancel = streams.register(7);

        let task = tokio::spawn(async move {
            run_stream(channel, "good-token", "chat".into(), None, cancel, |_| {}).await
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        streams.cancel(7);
        let result = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("stream stopped")
            .unwrap();
        assert_eq!(result, Ok(()));
    }

    /// Talks to the real YouTube endpoint with a bogus token: proves TLS,
    /// HTTP/2 and the service path are right (a wrong path would be
    /// UNIMPLEMENTED). Needs network, so it only runs on request:
    /// `cargo test --lib -- --ignored live_youtube_rejects_a_bogus_token`
    #[tokio::test]
    #[ignore]
    async fn live_youtube_rejects_a_bogus_token() {
        let (_keep, cancel) = oneshot::channel();
        let result = run_stream(
            youtube_channel().unwrap(),
            "not-a-real-token",
            "nonexistent".into(),
            None,
            cancel,
            |_| {},
        )
        .await;
        let failure = result.unwrap_err();
        assert_eq!(failure.status, 401, "{failure:?}");
    }
}
