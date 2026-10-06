use std::collections::HashMap;
use db::kvp::KeyValueStore;
use futures::{FutureExt as _, future::Shared};
use gpui::{App, AppContext as _, Global, Task};

pub(crate) type Save = Shared<Task<Result<(), String>>>;

#[derive(Default)]
struct Pending(HashMap<(String, String), (String, Save)>);
impl Global for Pending {}

/// Preserve the latest snapshot across view/window lifetimes, including while
/// its database write is pending. This is a cache of the existing KVP record.
pub(crate) fn read(namespace: &str, key: &str, cx: &App) -> anyhow::Result<Option<String>> {
    if let Some((payload, _)) = cx.try_global::<Pending>().and_then(|p| p.0.get(&(namespace.into(), key.into()))) {
        return Ok(Some(payload.clone()));
    }
    KeyValueStore::global(cx).scoped(namespace).read(key)
}

pub(crate) fn flush(namespace: &str, key: &str, cx: &App) -> Save {
    cx.try_global::<Pending>().and_then(|p| p.0.get(&(namespace.into(), key.into())))
        .map(|(_, task)| task.clone()).unwrap_or_else(|| Task::ready(Ok(())).shared())
}

pub(crate) fn write(namespace: &str, key: String, payload: String, cx: &mut App) -> Save {
    if !cx.has_global::<Pending>() { cx.set_global(Pending::default()); }
    let previous = flush(namespace, &key, cx);
    let db = KeyValueStore::global(cx);
    let namespace = namespace.to_string();
    let task = cx.background_spawn({
        let key = key.clone(); let payload = payload.clone(); let namespace = namespace.clone();
        async move {
            let _ = previous.await;
            db.scoped(&namespace).write(key, payload).await.map_err(|error| error.to_string())
        }
    }).shared();
    cx.global_mut::<Pending>().0.insert((namespace, key), (payload, task.clone()));
    task
}

#[cfg(test)]
mod tests {
    use super::*;
    #[gpui::test]
    async fn test_eido_task_handoff_reads_pending_state_and_serializes_old_and_new_writers(cx: &mut gpui::TestAppContext) {
        crate::conversation_view::tests::init_test(cx);
        cx.update(|cx| {
            // No executor dispatch between releasing one view and opening another.
            let _ = write("handoff", "task".into(), "old pending write".into(), cx);
            assert_eq!(read("handoff", "task", cx).unwrap().as_deref(), Some("old pending write"));
            let _ = write("handoff", "task".into(), "new owner snapshot".into(), cx);
            assert_eq!(read("handoff", "task", cx).unwrap().as_deref(), Some("new owner snapshot"));
        });
        let task = cx.read(|cx| flush("handoff", "task", cx));
        task.await.unwrap();
        cx.read(|cx| assert_eq!(KeyValueStore::global(cx).scoped("handoff").read("task").unwrap().as_deref(), Some("new owner snapshot")));
    }
}
