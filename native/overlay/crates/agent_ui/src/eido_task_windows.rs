use crate::{AgentPanel, ConversationView, thread_metadata_store::ThreadId};
use agent_client_protocol::schema::v1 as acp;
use gpui::{AnyWindowHandle, App, Entity, Global, WeakEntity};
use workspace::Workspace;

/// Weak registrations include loading and retained conversations. A task keeps
/// its original Project, queue and ActionLog; opening it elsewhere focuses it.
#[derive(Default)]
pub(crate) struct TaskWindows(Vec<Owner>);
impl Global for TaskWindows {}

#[derive(Clone)]
pub(crate) struct Owner {
    pub panel: WeakEntity<AgentPanel>,
    pub workspace: WeakEntity<Workspace>,
    pub window: AnyWindowHandle,
    pub conversation: WeakEntity<ConversationView>,
}

pub(crate) fn register(owner: Owner, cx: &mut App) {
    if std::env::var_os("EIDO_ROOT").is_none() && !cx.has_global::<TaskWindows>() { return; }
    if !cx.has_global::<TaskWindows>() { cx.set_global(TaskWindows::default()); }
    let registry = cx.global_mut::<TaskWindows>();
    registry.0.retain(|owner| owner.panel.upgrade().is_some() && owner.conversation.upgrade().is_some());
    registry.0.push(owner);
}

pub(crate) fn find(
    panel: &WeakEntity<AgentPanel>, thread_id: Option<ThreadId>, session_id: Option<&acp::SessionId>, cx: &App,
) -> Option<(Owner, Entity<ConversationView>)> {
    let registry = cx.try_global::<TaskWindows>()?;
    registry.0.iter().find_map(|owner| {
        // The caller handles its own active/draft/retained conversations.
        if owner.panel == *panel || owner.panel.upgrade().is_none() || owner.workspace.upgrade().is_none() { return None; }
        let view = owner.conversation.upgrade()?;
        let state = view.read(cx);
        let matches = thread_id == Some(state.thread_id) || session_id.is_some_and(|id|
            state.root_session_id.as_ref() == Some(id) || state.thread_view(id).is_some());
        matches.then(|| (owner.clone(), view))
    })
}
