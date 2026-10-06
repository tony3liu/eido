use acp_thread::AcpThread;
use action_log::{ActionLog, EditSource, ReviewCheckpoint};
use agent_client_protocol::schema::v1 as acp;
use anyhow::{Context as _, Result};
use db::kvp::KeyValueStore;
use futures::{StreamExt, channel::{mpsc, oneshot}};
use gpui::{App, AsyncApp, Context, Entity, WeakEntity};
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, collections::HashMap, path::PathBuf, rc::Rc, time::Duration};
use util::ResultExt as _;

const NAMESPACE: &str = "eido_pending_reviews_v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SavedFile {
    path: PathBuf,
    base: String,
    current: String,
    disk_mtime: Option<(u64, u32)>,
    sources: Vec<(String, String)>,
}

impl From<ReviewCheckpoint> for SavedFile {
    fn from(file: ReviewCheckpoint) -> Self {
        Self { path: file.path, base: file.base, current: file.current, disk_mtime: file.disk_mtime,
            sources: file.sources.into_iter().map(|s| (s.session_id.to_string(), s.title.to_string())).collect() }
    }
}

impl From<SavedFile> for ReviewCheckpoint {
    fn from(file: SavedFile) -> Self {
        Self { path: file.path, base: file.base, current: file.current, disk_mtime: file.disk_mtime,
            sources: file.sources.into_iter().map(|(session_id, title)| EditSource {session_id: session_id.into(), title: title.into()}).collect() }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct SavedReview {
    parent: Option<String>,
    files: Vec<SavedFile>,
    #[serde(default)]
    archived: Vec<SavedFile>,
}

type Owners = Rc<RefCell<HashMap<String, WeakEntity<AcpThread>>>>;

#[derive(Default)]
struct State {
    parent: Option<String>,
    restoring: bool,
    // An unresolved checkpoint is never replaced by a newer, unrelated review.
    conflicts: Vec<SavedFile>,
    archived: Vec<SavedFile>,
    last_payload: Option<String>,
    last_files: Vec<SavedFile>,
}

enum Write {
    Snapshot(String),
    Flush(oneshot::Sender<()>),
}

fn notify(thread: &WeakEntity<AcpThread>, message: String, cx: &mut AsyncApp) {
    thread.update(cx, |thread, cx| {
        thread.handle_session_update(acp::SessionUpdate::Notice(
            acp::Notice::new(acp::NoticeSeverity::Warning, message)), cx).log_err();
    }).log_err();
}

fn capture(log: &Entity<ActionLog>, state: &Rc<RefCell<State>>, sender: &mpsc::UnboundedSender<Write>, cx: &App) -> bool {
    let mut state = state.borrow_mut();
    if state.restoring { return false; }
    let (files, pending) = log.read(cx).review_checkpoint_parts(cx);
    let mut files: Vec<SavedFile> = files.into_iter().map(Into::into).collect();
    files.extend(state.last_files.iter().filter(|file| pending.contains(&file.path)).cloned());
    files.retain(|file| !state.conflicts.iter().any(|c| c.path == file.path));
    files.extend(state.conflicts.iter().cloned());
    state.last_files = files.clone();
    let Some(payload) = serde_json::to_string(&SavedReview { parent: state.parent.clone(), files, archived: state.archived.clone() }).log_err() else { return false; };
    if state.last_payload.as_ref() != Some(&payload) {
        if sender.unbounded_send(Write::Snapshot(payload.clone())).is_err() { return false; }
        state.last_payload = Some(payload);
    }
    pending.is_empty()
}

/// Observe every ACP session, including child sessions without an open view.
/// Storage uses the existing application database and is scoped by session + roots.
pub fn init(cx: &mut App) {
    let owners: Owners = Rc::default();
    cx.observe_new::<AcpThread>(move |thread, _, cx| {
        if std::env::var_os("EIDO_ROOT").is_none() { return; }
        let Some(roots) = thread.work_dirs() else { return; };
        let roots: Vec<_> = roots.ordered_paths().cloned().collect();
        let Ok(key) = serde_json::to_string(&(thread.session_id().to_string(), roots)) else { return; };
        if owners.borrow().get(&key).and_then(|owner| owner.upgrade()).is_some() {
            thread.set_review_write_error(Some("This task has an active review in another window. Continue there or close that task before reopening it here.".into()));
            thread.handle_session_update(acp::SessionUpdate::Notice(acp::Notice::new(
                acp::NoticeSeverity::Warning, "This task's pending review is active in another window. Review it there before editing here.")), cx).log_err();
            return;
        }
        owners.borrow_mut().insert(key.clone(), cx.weak_entity());
        attach_with_owners(thread, key, owners.clone(), cx);
    }).detach();
}

#[cfg(test)]
fn attach(thread: &mut AcpThread, key: String, cx: &mut Context<AcpThread>) {
    attach_with_owners(thread, key, Rc::default(), cx);
}

fn attach_with_owners(thread: &mut AcpThread, key: String, owners: Owners, cx: &mut Context<AcpThread>) {
    thread.set_review_write_error(Some("Pending reviews are still being restored. Retry after restoration finishes.".into()));
    let log = thread.action_log().clone();
    let state = Rc::new(RefCell::new(State { restoring: true, parent: thread.parent_session_id().map(ToString::to_string), ..State::default() }));
    let (sender, mut receiver) = mpsc::unbounded();
    let db = KeyValueStore::global(cx);
    let saved = db.scoped(NAMESPACE).read(&key)
        .and_then(|raw| raw.map(|raw| serde_json::from_str::<SavedReview>(&raw).map_err(Into::into)).transpose());
    // One writer preserves order even when review changes arrive during a DB write.
    cx.spawn({
        let key = key.clone();
        let state = state.clone();
        async move |thread, cx| {
            while let Some(message) = receiver.next().await {
                match message {
                    Write::Snapshot(payload) => {
                        if let Err(error) = db.scoped(NAMESPACE).write(key.clone(), payload).await {
                            state.borrow_mut().last_payload = None;
                            notify(&thread, format!("Pending review could not be saved: {error}. Keep this task open."), cx);
                        }
                    }
                    Write::Flush(done) => { let _ = done.send(()); }
                }
            }
        }
    }).detach();
    let subscription = cx.observe(&log, {
        let state = state.clone(); let sender = sender.clone();
        move |_, log, cx| { capture(&log, &state, &sender, cx); }
    });
    thread.retain_review_subscription(subscription);
    let resolved = cx.observe_self({
        let state = state.clone(); let sender = sender.clone(); let log = log.clone();
        move |thread, cx| {
            let mut state_mut = state.borrow_mut();
            if state_mut.restoring { return; }
            let mut changed = false;
            for file in std::mem::take(&mut state_mut.conflicts) {
                if thread.review_path_is_blocked(&file.path) { state_mut.conflicts.push(file); }
                else { state_mut.archived.push(file); changed = true; }
            }
            drop(state_mut);
            if changed { capture(&log, &state, &sender, cx); }
        }
    });
    thread.retain_review_subscription(resolved);
    let release = cx.on_release({
        let state = state.clone(); let sender = sender.clone(); let log = log.clone();
        move |_, cx| { capture(&log, &state, &sender, cx); }
    });
    thread.retain_review_subscription(release);
    // Normal quit waits for queued diff updates and the final DB transaction.
    let quit = cx.on_app_quit({
        let state = state.clone(); let sender = sender.clone(); let log = log.downgrade();
        move |_, cx| {
            let state = state.clone(); let sender = sender.clone(); let log = log.clone();
            cx.spawn(async move |_, cx| {
                for _ in 0..100 {
                    let ready = cx.update(|cx| log.upgrade().is_none_or(|log| capture(&log, &state, &sender, cx)));
                    if ready { break; }
                    cx.background_executor().timer(Duration::from_millis(10)).await;
                }
                let (done, wait) = oneshot::channel();
                if sender.unbounded_send(Write::Flush(done)).is_ok() { let _ = wait.await; }
            })
        }
    });
    thread.retain_review_subscription(quit);
    let roots = thread.work_dirs().map(|dirs| dirs.ordered_paths().cloned().collect::<Vec<_>>()).unwrap_or_default();
    cx.spawn(async move |thread, cx| {
        let review = match saved {
            Ok(files) => files.unwrap_or_default(),
            Err(error) => {
                // Leave corrupt/unknown storage intact for recovery.
                notify(&thread, format!("Pending review could not be loaded: {error}. Its saved record has been preserved."), cx);
                return;
            }
        };
        state.borrow_mut().last_files = review.files.clone();
        if review.parent.is_some() { state.borrow_mut().parent = review.parent; }
        state.borrow_mut().archived = review.archived.clone();
        for file in review.archived {
            thread.update(cx, |thread, cx| thread.add_review_copy(file.into(), true, cx)).log_err();
        }
        let parent = state.borrow().parent.clone();
        for file in review.files {
            let result = async {
                let mut candidate = Some(file.clone());
                let mut ancestor = parent.clone();
                let mut visited = std::collections::HashSet::new();
                while let (Some(parent), Some(current)) = (ancestor, candidate.as_ref()) {
                    anyhow::ensure!(visited.insert(parent.clone()), "Review ancestry contains a cycle");
                    let review = ancestor_review(&parent, &roots, &owners, cx).await?;
                    candidate = reconcile_with_ancestor(current, &review.files)?;
                    ancestor = review.parent;
                }
                if let Some(file) = candidate { restore_file(&log, file, cx).await?; }
                anyhow::Ok(())
            }.await;
            if let Err(error) = result {
                notify(&thread, format!("Pending review for {} was preserved but not applied: {error}.", file.path.display()), cx);
                thread.update(cx, |thread, cx| thread.add_review_copy(file.clone().into(), false, cx)).log_err();
                state.borrow_mut().conflicts.push(file);
            }
        }
        state.borrow_mut().restoring = false;
        thread.update(cx, |thread, _| thread.set_review_write_error(None)).log_err();
        cx.update(|cx| { capture(&log, &state, &sender, cx); });
    }).detach();
}

async fn ancestor_review(parent: &str, roots: &[PathBuf], owners: &Owners, cx: &mut AsyncApp) -> Result<SavedReview> {
    let key = serde_json::to_string(&(parent, roots))?;
    let live = owners.borrow().get(&key).cloned();
    if let Some(live) = live {
        for _ in 0..100 {
            if let Ok(Some(review)) = live.read_with(cx, |thread, cx| {
                if thread.review_is_unavailable() { return None; }
                Some(SavedReview { parent: thread.parent_session_id().map(ToString::to_string),
                    files: thread.action_log().read(cx).review_checkpoint(cx)?.into_iter().map(Into::into).collect(), archived: vec![] })
            }) { return Ok(review); }
            if live.upgrade().is_none() { break; }
            cx.background_executor().timer(Duration::from_millis(10)).await;
        }
        anyhow::ensure!(live.upgrade().is_none(), "Parent review is still loading or has unresolved changes");
    }
    let raw = cx.update(|cx| KeyValueStore::global(cx).scoped(NAMESPACE).read(&key))?
        .context("Parent review checkpoint is unavailable")?;
    Ok(serde_json::from_str(&raw)?)
}

// Ancestor reviews are authoritative: a child must not resurrect accepted/rejected work.
// Disjoint accepted hunks are absorbed into its baseline. Partly overlapping hunks
// retain their evidence for resolution rather than guessing at line ownership.
fn reconcile_with_ancestor(file: &SavedFile, ancestor: &[SavedFile]) -> Result<Option<SavedFile>> {
    let Some(parent) = ancestor.iter().find(|parent| parent.path == file.path) else { return Ok(None); };
    anyhow::ensure!(parent.current == file.current, "Parent review has newer file contents");
    let parent_edits = language::line_diff(&parent.base, &parent.current);
    let mut base = text::Rope::from(file.base.as_str());
    let current = text::Rope::from(file.current.as_str());
    let mut accepted = Vec::new();
    for (old, new) in language::line_diff(&file.base, &file.current) {
        if parent_edits.iter().any(|(_, range)| range.start <= new.start && range.end >= new.end) { continue; }
        let overlap = parent_edits.iter().any(|(_, range)| {
            if new.is_empty() || range.is_empty() { range.start == new.start }
            else { range.start < new.end && new.start < range.end }
        });
        anyhow::ensure!(!overlap, "Parent partially reviewed this hunk; the child checkpoint needs resolution");
        let start = base.point_to_offset(language::Point::new(old.start, 0).min(base.max_point()));
        let end = base.point_to_offset(language::Point::new(old.end, 0).min(base.max_point()));
        accepted.push((start..end, current.slice_rows(new).to_string()));
    }
    for (range, text) in accepted.into_iter().rev() { base.replace(range, &text); }
    let mut result = file.clone();
    result.base = base.to_string();
    Ok((result.base != result.current).then_some(result))
}

async fn restore_file(log: &Entity<ActionLog>, file: SavedFile, cx: &mut AsyncApp) -> Result<()> {
    let project = log.read_with(cx, |log, _| log.project().clone());
    let fs = project.read_with(cx, |project, _| project.fs().clone());
    let canonical = acp_thread::canonical_editor_path(fs.as_ref(), &file.path).await?;
    let roots: Vec<_> = project.read_with(cx, |project, cx| project.visible_worktrees(cx)
        .map(|worktree| worktree.read(cx).abs_path().to_path_buf()).collect());
    let mut inside = false;
    for root in roots {
        if acp_thread::allowed_path(&fs.canonicalize(&root).await?, &canonical) { inside = true; break; }
    }
    anyhow::ensure!(inside, "File now resolves outside the loaded workspace");
    let metadata = fs.metadata(&file.path).await?;
    let mtime = metadata.as_ref().and_then(|m| m.mtime.to_seconds_and_nanos_for_persistence());
    anyhow::ensure!(mtime == file.disk_mtime, "File changed on disk");
    anyhow::ensure!(metadata.is_none_or(|m| !m.is_dir && !m.is_symlink), "File type changed");
    let buffer = project.update(cx, |project, cx| {
        let path = project.project_path_for_absolute_path(&file.path, cx).context("File is outside the loaded workspace")?;
        anyhow::Ok(project.open_buffer(path, cx))
    })?.await?;
    // Loading a buffer may yield to a disk write; check again immediately before editing.
    let metadata = fs.metadata(&file.path).await?;
    let mtime = metadata.and_then(|m| m.mtime.to_seconds_and_nanos_for_persistence());
    anyhow::ensure!(mtime == file.disk_mtime, "File changed while restoring review");
    log.update(cx, |log, cx| log.restore_review_checkpoint(buffer, file.into(), cx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use acp_thread::{AgentConnection, StubAgentConnection};
    use fs::FakeFs;
    use gpui::TestAppContext;
    use project::Project;
    use std::path::Path;
    use util::path_list::PathList;

    async fn session(project: Entity<Project>, cx: &mut TestAppContext) -> Entity<AcpThread> {
        cx.update(|cx| Rc::new(StubAgentConnection::new()).new_session(project, PathList::new(&[Path::new("/reviews")]), cx))
            .await.unwrap()
    }

    fn saved(key: &str, cx: &TestAppContext) -> Vec<SavedFile> {
        cx.read(|cx| serde_json::from_str::<SavedReview>(&KeyValueStore::global(cx).scoped(NAMESPACE).read(key).unwrap().unwrap()).unwrap().files)
    }

    #[gpui::test]
    async fn test_eido_review_checkpoint_restores_unopened_files_and_sources(cx: &mut TestAppContext) {
        crate::conversation_view::tests::init_test(cx);
        let fs = FakeFs::new(cx.executor());
        fs.insert_tree("/reviews", serde_json::json!({"existing.txt":"disk\n"})).await;
        let project = Project::test(fs.clone(), [Path::new("/reviews")], cx).await;
        let thread = session(project.clone(), cx).await;
        thread.update(cx, |thread, cx| attach(thread, "recovery".into(), cx));
        cx.run_until_parked();
        let path = PathBuf::from("/reviews/new/never-opened.txt");
        thread.update(cx, |thread, cx| thread.create_text_file(path.clone(), "unsaved agent work\n".into(), cx)).await.unwrap();
        cx.run_until_parked();
        let checkpoint = saved("recovery", cx);
        assert_eq!(checkpoint.len(), 1);
        assert_eq!(checkpoint[0].base, "");
        assert_eq!(checkpoint[0].current, "unsaved agent work\n");
        assert_eq!(checkpoint[0].sources.len(), 1);
        assert!(fs.read_file_sync(&path).is_err());
        drop(thread); drop(project);
        cx.run_until_parked();
        let project = Project::test(fs.clone(), [Path::new("/reviews")], cx).await;
        let thread = session(project.clone(), cx).await;
        thread.update(cx, |thread, cx| attach(thread, "recovery".into(), cx));
        cx.run_until_parked();
        let text = thread.update(cx, |thread, cx| thread.read_text_file(path.clone(), None, None, false, cx)).await.unwrap();
        assert_eq!(text, "unsaved agent work\n");
        let log = thread.read_with(cx, |thread, _| thread.action_log().clone());
        assert_eq!(log.read_with(cx, |log, cx| log.changed_buffers(cx).count()), 1);
        assert_eq!(saved("recovery", cx)[0].sources, checkpoint[0].sources);
        log.update(cx, |log, cx| log.reject_all_edits(None, cx)).await;
        cx.run_until_parked();
        assert!(saved("recovery", cx).is_empty());
        assert!(fs.read_file_sync(&path).is_err());
        assert_eq!(thread.update(cx, |thread, cx| thread.read_text_file(path, None, None, false, cx)).await.unwrap(), "");
    }

    #[gpui::test]
    async fn test_eido_review_recovery_preserves_newer_disk_and_unsaved_content(cx: &mut TestAppContext) {
        crate::conversation_view::tests::init_test(cx);
        let fs = FakeFs::new(cx.executor());
        fs.insert_tree("/reviews", serde_json::json!({"file.txt":"disk\n", "dirty.txt":"original\n"})).await;
        let project = Project::test(fs.clone(), [Path::new("/reviews")], cx).await;
        let thread = session(project.clone(), cx).await;
        thread.update(cx, |thread, cx| attach(thread, "conflicts".into(), cx));
        cx.run_until_parked();
        for name in ["file.txt", "dirty.txt"] {
            let path = PathBuf::from(format!("/reviews/{name}"));
            thread.update(cx, |thread, cx| thread.read_text_file(path.clone(), None, None, false, cx)).await.unwrap();
            thread.update(cx, |thread, cx| thread.eido_test_write_text_file(path, "agent\n".into(), cx)).await.unwrap();
        }
        cx.run_until_parked();
        let original = saved("conflicts", cx);
        assert_eq!(original.len(), 2);
        drop(thread); drop(project);
        cx.run_until_parked();
        fs.insert_tree("/reviews", serde_json::json!({"file.txt":"new disk\n"})).await;
        let project = Project::test(fs.clone(), [Path::new("/reviews")], cx).await;
        let buffer = project.update(cx, |project, cx| {
            let path = project.project_path_for_absolute_path(Path::new("/reviews/dirty.txt"), cx).unwrap();
            project.open_buffer(path, cx)
        }).await.unwrap();
        buffer.update(cx, |buffer, cx| { buffer.edit([(0..buffer.len(), "new manual draft\n")], None, cx); });
        let thread = session(project, cx).await;
        thread.update(cx, |thread, cx| attach(thread, "conflicts".into(), cx));
        cx.run_until_parked();
        assert_eq!(buffer.read_with(cx, |buffer, _| buffer.text()), "new manual draft\n");
        assert_eq!(String::from_utf8(fs.read_file_sync("/reviews/file.txt").unwrap()).unwrap(), "new disk\n");
        assert_eq!(serde_json::to_string(&saved("conflicts", cx)).unwrap(), serde_json::to_string(&original).unwrap());
        assert_eq!(thread.read_with(cx, |thread, _| thread.notices().len()), 2);
        assert!(thread.update(cx, |thread, cx| thread.eido_test_write_text_file("/reviews/dirty.txt".into(), "overwrite".into(), cx)).await.is_err());
        thread.update(cx, |thread, cx| thread.keep_current_review(Path::new("/reviews/dirty.txt"), cx));
        cx.run_until_parked();
        let stored: SavedReview = cx.read(|cx| serde_json::from_str(&KeyValueStore::global(cx).scoped(NAMESPACE).read("conflicts").unwrap().unwrap()).unwrap());
        assert_eq!(stored.files.len(), 1);
        assert_eq!(stored.archived.len(), 1);
        assert_eq!(stored.archived[0].current, "agent\n");
        assert_eq!(buffer.read_with(cx, |buffer, _| buffer.text()), "new manual draft\n");
        assert!(!thread.read_with(cx, |thread, _| thread.review_path_is_blocked(Path::new("/reviews/dirty.txt"))));
    }
    #[gpui::test]
    async fn test_eido_review_partial_accept_and_manual_edits_survive_recovery(cx: &mut TestAppContext) {
        crate::conversation_view::tests::init_test(cx);
        let fs = FakeFs::new(cx.executor());
        fs.insert_tree("/reviews", serde_json::json!({"file.txt":"one\nmiddle\ntwo\nfar\nend\n"})).await;
        let project = Project::test(fs.clone(), [Path::new("/reviews")], cx).await;
        let thread = session(project.clone(), cx).await;
        thread.update(cx, |thread, cx| attach(thread, "partial".into(), cx));
        cx.run_until_parked();
        let path = PathBuf::from("/reviews/file.txt");
        thread.update(cx, |thread, cx| thread.read_text_file(path.clone(), None, None, false, cx)).await.unwrap();
        thread.update(cx, |thread, cx| thread.eido_test_write_text_file(path.clone(), "ONE\nmiddle\nTWO\nfar\nend\n".into(), cx)).await.unwrap();
        cx.run_until_parked();
        let buffer = project.update(cx, |project, cx| {
            let path = project.project_path_for_absolute_path(&path, cx).unwrap();
            project.open_buffer(path, cx)
        }).await.unwrap();
        buffer.update(cx, |buffer, cx| { buffer.edit([(buffer.len()..buffer.len(), "manual\n")], None, cx); });
        cx.run_until_parked();
        let log = thread.read_with(cx, |thread, _| thread.action_log().clone());
        log.update(cx, |log, cx| log.keep_edits_in_range(buffer.clone(), language::Point::new(0,0)..language::Point::new(0,3), None, cx));
        cx.run_until_parked();
        let files = saved("partial", cx);
        assert_eq!(files[0].base, "ONE\nmiddle\ntwo\nfar\nend\nmanual\n");
        drop(buffer); drop(log); drop(thread); drop(project);
        cx.run_until_parked();
        let project = Project::test(fs.clone(), [Path::new("/reviews")], cx).await;
        let thread = session(project, cx).await;
        thread.update(cx, |thread, cx| attach(thread, "partial".into(), cx));
        cx.run_until_parked();
        let log = thread.read_with(cx, |thread, _| thread.action_log().clone());
        log.update(cx, |log, cx| log.reject_all_edits(None, cx)).await;
        cx.run_until_parked();
        assert_eq!(thread.update(cx, |thread, cx| thread.read_text_file(path, None, None, false, cx)).await.unwrap(), files[0].base);
        assert!(saved("partial", cx).is_empty());
        assert_eq!(String::from_utf8(fs.read_file_sync("/reviews/file.txt").unwrap()).unwrap(), "one\nmiddle\ntwo\nfar\nend\n");
    }

    #[gpui::test]
    async fn test_eido_child_recovery_never_reintroduces_reviewed_parent_changes(cx: &mut TestAppContext) {
        crate::conversation_view::tests::init_test(cx);
        let fs = FakeFs::new(cx.executor());
        fs.insert_tree("/reviews", serde_json::json!({})).await;
        let project = Project::test(fs.clone(), [Path::new("/reviews")], cx).await;
        let db = cx.read(KeyValueStore::global);
        let parent_key = serde_json::to_string(&("parent", vec![PathBuf::from("/reviews")])).unwrap();
        db.scoped(NAMESPACE).write(parent_key, serde_json::to_string(&SavedReview::default()).unwrap()).await.unwrap();
        let file = SavedFile { path: "/reviews/rejected.txt".into(), base: "".into(), current: "rejected work".into(), disk_mtime: None, sources: vec![] };
        db.scoped(NAMESPACE).write("child".into(), serde_json::to_string(&SavedReview { parent: Some("parent".into()), files: vec![file], archived: vec![] }).unwrap()).await.unwrap();
        let thread = session(project, cx).await;
        thread.update(cx, |thread, cx| attach(thread, "child".into(), cx));
        cx.run_until_parked();
        assert!(saved("child", cx).is_empty());
        assert!(thread.read_with(cx, |thread, _| thread.review_copies().is_empty()));
        assert_eq!(thread.read_with(cx, |thread, cx| thread.action_log().read(cx).changed_buffers(cx).count()), 0);
        assert!(fs.read_file_sync("/reviews/rejected.txt").is_err());
    }

    #[test]
    fn test_eido_child_recovery_absorbs_accepted_hunks_and_preserves_pending_hunks() {
        let file = SavedFile { path: "/reviews/file".into(), base: "one\nmiddle\ntwo\n".into(),
            current: "ONE\nmiddle\nTWO\n".into(), disk_mtime: None, sources: vec![] };
        let mut parent = file.clone();
        parent.base = "ONE\nmiddle\ntwo\n".into();
        let result = reconcile_with_ancestor(&file, &[parent]).unwrap().unwrap();
        assert_eq!(result.base, "ONE\nmiddle\ntwo\n");
        let mut newer = file.clone();
        newer.current = "newer\n".into();
        assert!(reconcile_with_ancestor(&file, &[newer]).is_err());
    }

    #[gpui::test]
    async fn test_eido_conflicted_file_does_not_block_other_checkpoints(cx: &mut TestAppContext) {
        crate::conversation_view::tests::init_test(cx);
        let fs = FakeFs::new(cx.executor());
        fs.insert_tree("/reviews", serde_json::json!({"file.txt":"disk\n"})).await;
        let project = Project::test(fs.clone(), [Path::new("/reviews")], cx).await;
        let thread = session(project.clone(), cx).await;
        thread.update(cx, |thread, cx| attach(thread, "independent".into(), cx));
        cx.run_until_parked();
        thread.update(cx, |thread, cx| thread.read_text_file("/reviews/file.txt".into(), None, None, false, cx)).await.unwrap();
        thread.update(cx, |thread, cx| thread.eido_test_write_text_file("/reviews/file.txt".into(), "agent\n".into(), cx)).await.unwrap();
        cx.run_until_parked();
        let buffer = project.update(cx, |project, cx| {
            let path = project.project_path_for_absolute_path(Path::new("/reviews/file.txt"), cx).unwrap();
            project.open_buffer(path, cx)
        }).await.unwrap();
        buffer.update(cx, |buffer, _| buffer.set_conflict());
        thread.update(cx, |thread, cx| thread.create_text_file("/reviews/other.txt".into(), "independent\n".into(), cx)).await.unwrap();
        cx.run_until_parked();
        let files = saved("independent", cx);
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|file| file.current == "agent\n"));
        assert!(files.iter().any(|file| file.current == "independent\n"));
    }

}

pub(crate) fn copy_markdown(file: &ReviewCheckpoint) -> String {
    let indent = |text: &str| text.split('\n').map(|line| format!("    {line}")).collect::<Vec<_>>().join("\n");
    format!("# Saved review: {}\n\nThis copy was preserved because the live file could not be restored safely.\n\n## Baseline\n\n{}\n\n## Agent and manual changes\n\n{}\n\nContributors: {}\n",
        file.path.display(), indent(&file.base), indent(&file.current), file.sources.iter().map(|s| format!("{} ({})", s.title, s.session_id)).collect::<Vec<_>>().join(", "))
}
