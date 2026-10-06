use acp_thread::{EidoTurnState, EidoTurnStatus};
use gpui::App;
use serde::{Deserialize, Serialize};

const NAMESPACE: &str = "eido-task-state-v1";

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Record {
    pub turn: EidoTurnState,
    pub unread: bool,
    #[serde(default)]
    pub pending_review: usize,
}

pub fn read(session: &str, cx: &App) -> Record {
    crate::eido_session_store::read(NAMESPACE, session, cx).ok().flatten()
        .and_then(|payload| serde_json::from_str(&payload).ok()).unwrap_or_default()
}

impl Record {
    fn observe(&mut self, turn: EidoTurnState, visible: bool, pending_review: usize) {
        // Replayed messages and restoring buffers can notify before ACP sends
        // the saved outcome. The native placeholder is not a new turn.
        if turn == EidoTurnState::default() && self.turn != EidoTurnState::default() {
            return;
        }
        if self.turn != turn && !matches!(turn.status, EidoTurnStatus::Idle | EidoTurnStatus::Running) {
            self.unread = true;
        }
        self.turn = turn;
        self.pending_review = pending_review;
        if visible { self.unread = false; }
    }

    pub fn restored_status(&self) -> EidoTurnStatus {
        if self.turn.status == EidoTurnStatus::Running { EidoTurnStatus::Interrupted } else { self.turn.status }
    }
}

/// Acknowledging a visible conversation must not replace a saved outcome with
/// the default state of a thread whose history is still loading.
pub fn mark_read(session: &str, cx: &mut App) {
    let mut record = read(session, cx);
    if record.unread {
        record.unread = false;
        if let Ok(payload) = serde_json::to_string(&record) {
            let _ = crate::eido_session_store::write(NAMESPACE, session.into(), payload, cx);
        }
    }
}

pub fn observe(session: &str, turn: EidoTurnState, visible: bool, pending_review: usize, cx: &mut App) {
    let previous = read(session, cx);
    let mut next = previous.clone();
    next.observe(turn, visible, pending_review);
    if next != previous {
        if let Ok(payload) = serde_json::to_string(&next) {
            let _ = crate::eido_session_store::write(NAMESPACE, session.into(), payload, cx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[gpui::test]
    async fn test_eido_task_reloads_unread_result_and_pending_review(cx: &mut gpui::TestAppContext) {
        crate::conversation_view::tests::init_test(cx);
        let state = EidoTurnState {version: 1, id: Some("finished".into()), status: EidoTurnStatus::Completed};
        cx.update(|cx| observe("persisted-task", state.clone(), false, 2, cx));
        cx.read(|cx| crate::eido_session_store::flush(NAMESPACE, "persisted-task", cx)).await.unwrap();
        cx.update(|cx| {
            let payload = db::kvp::KeyValueStore::global(cx).scoped(NAMESPACE).read("persisted-task").unwrap().unwrap();
            let restored: Record = serde_json::from_str(&payload).unwrap();
            assert!(restored.unread);
            assert_eq!(restored.pending_review, 2);
            assert_eq!(restored.restored_status(), EidoTurnStatus::Completed);
            mark_read("persisted-task", cx);
            assert_eq!(read("persisted-task", cx).turn, state);
            assert!(!read("persisted-task", cx).unread);
            assert_eq!(read("persisted-task", cx).pending_review, 2);
        });
        cx.read(|cx| crate::eido_session_store::flush(NAMESPACE, "persisted-task", cx)).await.unwrap();
    }

    #[test]
    fn test_eido_task_outcomes_and_unread_are_independent_of_visibility() {
        let mut record = Record::default();
        let state = |id: &str, status| EidoTurnState {version: 1, id: Some(id.into()), status};
        record.observe(state("one", EidoTurnStatus::Running), false, 0);
        assert!(!record.unread);
        assert_eq!(record.restored_status(), EidoTurnStatus::Interrupted);
        record.observe(state("one", EidoTurnStatus::Failed), false, 0);
        assert!(record.unread);
        record.observe(state("one", EidoTurnStatus::Failed), true, 0);
        assert!(!record.unread);
        record.observe(EidoTurnState::default(), false, 0);
        assert_eq!(record.turn, state("one", EidoTurnStatus::Failed));
        record.observe(state("one", EidoTurnStatus::Failed), false, 0);
        assert!(!record.unread, "repaint must not make a read result unread");
        record.observe(state("two", EidoTurnStatus::Cancelled), false, 0);
        assert!(record.unread);
        record.observe(state("three", EidoTurnStatus::Completed), true, 0);
        assert!(!record.unread);
        assert_eq!(record.restored_status(), EidoTurnStatus::Completed);
    }
}
