use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EidoTurnStatus {
    #[default]
    Idle,
    Running,
    Completed,
    Cancelled,
    Failed,
    Interrupted,
}

impl EidoTurnStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Idle => "Ready",
            Self::Running => "Running",
            Self::Completed => "Run finished",
            Self::Cancelled => "Cancelled",
            Self::Failed => "Run failed",
            Self::Interrupted => "Outcome unknown",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct EidoTurnState {
    pub version: u32,
    pub id: Option<String>,
    pub status: EidoTurnStatus,
}

impl Default for EidoTurnState {
    fn default() -> Self {
        Self {version: 1, id: None, status: EidoTurnStatus::Idle}
    }
}
