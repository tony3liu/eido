use acp_thread::{AcpThread, AgentThreadEntry, ToolCallStatus};
use agent_client_protocol::schema::v1 as acp;
use chrono::{DateTime, Utc};
use gpui::SharedString;
use serde::Deserialize;
use std::{
    collections::{BTreeMap, VecDeque},
    path::{Path, PathBuf},
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Evidence {
    version: u8,
    pub run_id: String,
    pub captured_at: String,
    cwd: PathBuf,
    files: Vec<Input>,
    dependencies: Dependencies,
    freshness: Freshness,
    project: Option<ProjectResult>,
    #[serde(default)]
    observation: bool,
    #[serde(default)]
    cancelled: bool,
    tool_succeeded: Option<bool>,
    error: Option<String>,
}
#[derive(Clone, Deserialize)]
struct Input {
    path: PathBuf,
}
#[derive(Clone, Deserialize)]
struct Dependencies {
    paths: Vec<PathBuf>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Freshness {
    state: String,
    checked_at: String,
}
#[derive(Clone, Deserialize)]
struct ProjectResult {
    stage: String,
    checks: Vec<Check>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Check {
    exit_code: Option<i64>,
    finished_at: Option<String>,
    #[serde(default)]
    timed_out: bool,
}

pub(crate) struct Row {
    pub evidence: Evidence,
    pub session_id: acp::SessionId,
    pub tool_call_id: acp::ToolCallId,
    pub source: SharedString,
    pub status: String,
}

fn timestamp(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.timestamp_millis())
}

impl Evidence {
    fn applies_to(&self, path: &Path) -> bool {
        let Ok(path) = path.strip_prefix(&self.cwd) else {
            return false;
        };
        self.files.iter().any(|file| file.path == path)
            || self
                .dependencies
                .paths
                .iter()
                .any(|root| path.starts_with(root))
    }

    fn outcome(&self, status: &ToolCallStatus) -> String {
        if self.cancelled || matches!(status, ToolCallStatus::Canceled) {
            return "Verification cancelled".into();
        }
        if matches!(status, ToolCallStatus::Pending | ToolCallStatus::InProgress) {
            return "Verification running".into();
        }
        if matches!(status, ToolCallStatus::Rejected) {
            return "Verification not run".into();
        }
        if self.error.is_some() {
            return "Verification could not finish".into();
        }
        if self.observation && self.tool_succeeded != Some(true) {
            return "Browser observation failed".into();
        }
        if let Some(project) = &self.project {
            let passed = project
                .checks
                .iter()
                .filter(|c| c.exit_code == Some(0) && c.finished_at.is_some() && !c.timed_out)
                .count();
            let failed = project
                .checks
                .iter()
                .filter(|c| c.finished_at.is_some() && (c.exit_code != Some(0) || c.timed_out))
                .count();
            if failed > 0 {
                return format!(
                    "{passed} {} passed · {failed} failed",
                    if passed == 1 { "check" } else { "checks" }
                );
            }
            if project.checks.iter().any(|c| c.finished_at.is_none()) {
                return format!("{passed} checks passed · Run incomplete");
            }
            if project.stage == "failed" || matches!(status, ToolCallStatus::Failed) {
                return "Verification failed".into();
            }
            if passed > 0 {
                return format!(
                    "{passed} {} passed{}",
                    if passed == 1 { "check" } else { "checks" },
                    if self.observation {
                        " · Browser observed"
                    } else {
                        ""
                    }
                );
            }
        }
        if self.observation {
            return if self.tool_succeeded == Some(true) {
                "Browser observed · No acceptance verdict"
            } else {
                "Browser observation failed"
            }
            .into();
        }
        if matches!(status, ToolCallStatus::Failed) {
            return "Verification failed".into();
        }
        "Preview captured · No checks run".into()
    }
}

/// Derived from pi's persisted tool-result details, never model prose or a second history store.
pub(crate) fn rows<'a>(threads: impl IntoIterator<Item = &'a AcpThread>) -> Vec<Row> {
    let mut rows: BTreeMap<(String, String), Row> = BTreeMap::new();
    for thread in threads {
        for entry in thread.entries() {
            let AgentThreadEntry::ToolCall(tool) = entry else {
                continue;
            };
            let Some(name) = tool.tool_name.as_deref() else {
                continue;
            };
            if name != "preview"
                && !matches!(
                    name,
                    "mcp__eido_browser__browser_open" | "mcp__eido_browser__browser_snapshot"
                )
            {
                continue;
            }
            let Some(value) = tool
                .raw_output
                .as_ref()
                .and_then(|v| v.get("eidoVerification"))
            else {
                continue;
            };
            let Ok(evidence) = Evidence::deserialize(value) else {
                continue;
            };
            if evidence.version != 1
                || evidence.run_id.len() > 128
                || !evidence.cwd.is_absolute()
                || evidence.files.len() > 512
                || evidence.dependencies.paths.len() > 16
            {
                continue;
            }
            let status = evidence.outcome(&tool.status);
            let key = (thread.session_id().to_string(), evidence.run_id.clone());
            if rows.get(&key).is_some_and(|row| {
                row.evidence.freshness.checked_at > evidence.freshness.checked_at
            }) {
                continue;
            }
            rows.insert(
                key,
                Row {
                    evidence,
                    session_id: thread.session_id().clone(),
                    tool_call_id: tool.id.clone(),
                    source: thread.title().unwrap_or_else(|| "Main agent".into()),
                    status,
                },
            );
        }
    }
    let mut rows = rows.into_values().collect::<Vec<_>>();
    rows.sort_by(|a, b| b.evidence.captured_at.cmp(&a.evidence.captured_at));
    rows
}

pub(crate) struct State {
    opened_at: i64,
    changes: VecDeque<(i64, Option<PathBuf>)>,
    overflow_at: i64,
    pub expanded: bool,
}
impl Default for State {
    fn default() -> Self {
        Self {
            opened_at: Utc::now().timestamp_millis(),
            changes: VecDeque::new(),
            overflow_at: 0,
            expanded: false,
        }
    }
}
impl State {
    pub fn changed(&mut self, path: Option<PathBuf>) {
        self.record_change(Utc::now().timestamp_millis(), path);
    }
    fn record_change(&mut self, time: i64, path: Option<PathBuf>) {
        self.changes.push_back((time, path));
        if self.changes.len() > 256 {
            self.overflow_at = self.changes.pop_front().unwrap().0;
        }
    }
    pub fn freshness(&self, evidence: &Evidence) -> &'static str {
        if evidence.freshness.state == "stale" {
            return "Inputs changed";
        }
        if evidence.freshness.state != "current" {
            return "Inputs unavailable";
        }
        let Some(checked_at) = timestamp(&evidence.freshness.checked_at) else {
            return "Inputs not rechecked";
        };
        if self.overflow_at >= checked_at
            || self.changes.iter().any(|(time, path)| {
                *time >= checked_at && path.as_ref().is_none_or(|path| evidence.applies_to(path))
            })
        {
            return "Inputs changed";
        }
        // Replayed records cannot establish what happened while Eido was closed.
        if checked_at <= self.opened_at {
            return "Inputs not rechecked";
        }
        "Captured inputs current"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn evidence() -> Evidence {
        serde_json::from_value(serde_json::json!({"version":1,"runId":"run","capturedAt":"2026-10-06T00:00:00Z","cwd":"/work",
            "files":[{"path":"index.html"}],"dependencies":{"paths":["node_modules"]},
            "freshness":{"state":"current","checkedAt":"2026-10-06T00:00:01Z"},
            "project":{"stage":"completed","checks":[{"exitCode":0,"finishedAt":"2026-10-06T00:00:01Z"}]}})).unwrap()
    }
    #[test]
    fn test_eido_verification_invalidates_edits_dependencies_and_restored_results() {
        let evidence = evidence();
        let checked = timestamp(&evidence.freshness.checked_at).unwrap();
        let mut state = State {
            opened_at: checked - 1000,
            ..Default::default()
        };
        assert_eq!(state.freshness(&evidence), "Captured inputs current");
        state.record_change(checked + 1, Some("/work/.local/log".into()));
        assert_eq!(state.freshness(&evidence), "Captured inputs current");
        state.record_change(checked + 2, Some("/work/node_modules/pkg/new.js".into()));
        assert_eq!(state.freshness(&evidence), "Inputs changed");
        state.changes.clear();
        state.record_change(checked + 3, None);
        assert_eq!(state.freshness(&evidence), "Inputs changed");
        state.changes.clear();
        state.opened_at = checked + 4;
        assert_eq!(state.freshness(&evidence), "Inputs not rechecked");
        state.opened_at = checked - 1000;
        for i in 0..257 {
            state.record_change(checked + i, Some("/elsewhere".into()));
        }
        assert_eq!(state.freshness(&evidence), "Inputs changed");
    }
    #[test]
    fn test_eido_verification_does_not_equate_observation_or_partial_checks_with_acceptance() {
        let mut evidence = evidence();
        assert_eq!(
            evidence.outcome(&ToolCallStatus::Completed),
            "1 check passed"
        );
        evidence.project.as_mut().unwrap().checks.push(Check {
            exit_code: Some(1),
            finished_at: Some("done".into()),
            timed_out: false,
        });
        assert_eq!(
            evidence.outcome(&ToolCallStatus::Completed),
            "1 check passed · 1 failed"
        );
        assert_eq!(
            evidence.outcome(&ToolCallStatus::Canceled),
            "Verification cancelled"
        );
        evidence.project = None;
        evidence.observation = true;
        evidence.tool_succeeded = Some(true);
        assert_eq!(
            evidence.outcome(&ToolCallStatus::Completed),
            "Browser observed · No acceptance verdict"
        );
    }
}
