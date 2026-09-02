use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertPayload {
    pub platform: String,
    pub alert_type: String,
    pub user_name: String,
    pub message: String,
    pub count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchEventSubPayload {
    pub subscription: TwitchSubscription,
    pub event: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchSubscription {
    pub id: String,
    pub status: String,
    pub r#type: String,
    pub version: String,
    pub condition: serde_json::Value,
}

/// Sanitize a string for safe display - strip control chars and HTML-significant chars
fn sanitize(input: &str) -> String {
    input
        .chars()
        .filter(|c| !c.is_control() || *c == ' ')
        .map(|c| match c {
            '<' | '>' | '&' | '"' | '\'' => '_',
            _ => c,
        })
        .take(100)
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn process_twitch_event(payload: TwitchEventSubPayload) -> Option<AlertPayload> {
    let event = &payload.event;
    let r#type = &payload.subscription.r#type;

    match r#type.as_str() {
        "channel.subscribe" => {
            let user_name = sanitize(event["user_name"].as_str()?);
            if user_name.is_empty() {
                return None;
            }
            Some(AlertPayload {
                platform: "twitch".to_string(),
                alert_type: "sub".to_string(),
                user_name: user_name.clone(),
                message: format!("{} just subscribed!", user_name),
                count: None,
            })
        }
        "channel.subscription.gift" => {
            let user_name = sanitize(event["user_name"].as_str()?);
            if user_name.is_empty() {
                return None;
            }
            let total = event["total"].as_u64()? as u32;
            Some(AlertPayload {
                platform: "twitch".to_string(),
                alert_type: "gift".to_string(),
                user_name: user_name.clone(),
                message: format!("{} gifted {} subscriptions!", user_name, total),
                count: Some(total),
            })
        }
        "channel.channel_points_custom_reward_redemption.add" => {
            let user_name = sanitize(event["user_name"].as_str()?);
            if user_name.is_empty() {
                return None;
            }
            let reward_title = sanitize(event["reward"]["title"].as_str()?);
            if reward_title.is_empty() {
                return None;
            }
            Some(AlertPayload {
                platform: "twitch".to_string(),
                alert_type: "redemption".to_string(),
                user_name: user_name.clone(),
                message: format!("{} redeemed {}!", user_name, reward_title),
                count: None,
            })
        }
        _ => None,
    }
}

fn extract_channel_name(xml: &str) -> String {
    xml.lines()
        .skip_while(|l| !l.trim().starts_with("<author>"))
        .skip(1)
        .find_map(|l| {
            let trimmed = l.trim();
            if trimmed.starts_with("<name>") {
                let name = trimmed.strip_prefix("<name>")?
                    .strip_suffix("</name>")
                    .or_else(|| trimmed.strip_prefix("<name>").map(|s| s.trim_end_matches("</name>")))
                    .unwrap_or("Channel");
                Some(name.to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "Channel".to_string())
}

pub fn process_youtube_alert(xml_content: &str) -> Option<AlertPayload> {
    if xml_content.contains("<yt:videoId>") {
        let user_name = extract_channel_name(xml_content);
        return Some(AlertPayload {
            platform: "youtube".to_string(),
            alert_type: "live".to_string(),
            user_name,
            message: "A new stream or video is live!".to_string(),
            count: None,
        });
    }
    None
}
