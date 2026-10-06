use agent_client_protocol::schema::v1 as acp;
use gpui::App;
use serde::{Deserialize, Serialize};
use crate::thread_metadata_store::ThreadId;

pub const NAMESPACE: &str = "eido_message_queues";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SavedMessage {
    pub delivery_id: String,
    pub content: Vec<acp::ContentBlock>,
    pub steer: bool,
    pub needs_review: bool,
}

pub fn key(thread: ThreadId, session: &acp::SessionId) -> String {
    format!("{}:{}", thread.to_key_string(), session)
}

pub fn read(key: &str, cx: &App) -> anyhow::Result<Vec<SavedMessage>> {
    let raw = crate::eido_session_store::read(NAMESPACE, key, cx)?;
    Ok(match raw { Some(raw) => serde_json::from_str(&raw)?, None => vec![] })
}
