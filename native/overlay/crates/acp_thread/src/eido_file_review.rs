use super::{AcpThread, allowed_path, canonical_editor_path, visible_path};
use agent_client_protocol::schema::v1 as acp;
use anyhow::{Context as _, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use db::kvp::KeyValueStore;
use gpui::{App, AppContext as _, AsyncApp, Context, Entity, Task, WeakEntity};
use action_log::ActionLog;
use language::Buffer;
use std::collections::HashMap;
use project::{Project, Fs};
use serde::{Deserialize, Serialize};
use std::{path::{Path, PathBuf}, sync::Arc};
use util::path_list::PathList;
use uuid::Uuid;

const NAMESPACE: &str = "eido_file_operations_v1";
const MAX_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EidoFileProposal {
    pub path: PathBuf,
    pub run_id: String,
    pub tool_call_id: String,
    pub expected_disk: Option<String>,
    pub expected_buffer: Option<String>,
    /// None proposes deletion; Some contains base64-encoded output bytes.
    pub output: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EidoFileSnapshot {
    pub content: String,
    pub disk: Option<String>,
    pub buffer: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum FileReviewDecision { Pending, Applying, Accepted, Rejected, Restoring, Restored, Unknown, KeptCurrent }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum FileOperationIntent { Accept, Restore }

#[derive(Default)]
struct FileReviewRegistry {
    journals: Vec<WeakEntity<EidoFileReviews>>,
    logs: Vec<WeakEntity<ActionLog>>,
}
impl gpui::Global for FileReviewRegistry {}

pub(crate) fn register_file_review_log(log: &Entity<ActionLog>, cx: &mut App) {
    let registry = cx.default_global::<FileReviewRegistry>();
    registry.logs.retain(|log| log.upgrade().is_some());
    registry.logs.push(log.downgrade());
}

pub(crate) fn file_operation_blocks_path(path: &Path, cx: &App) -> bool {
    cx.try_global::<FileReviewRegistry>().is_some_and(|registry| registry.journals.iter()
        .filter_map(WeakEntity::upgrade).any(|journal| {
            let journal = journal.read(cx);
            journal.records.iter().any(|record| record.pending() && record.proposal.path == path)
        }))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EidoFileReview {
    pub id: String,
    pub proposal: EidoFileProposal,
    pub source_session: String,
    pub source_title: String,
    pub decision: FileReviewDecision,
    pub changed_at: String,
    pub backup_path: Option<PathBuf>,
    pub staging_path: Option<PathBuf>,
    pub error: Option<String>,
    #[serde(default)]
    pub original_mode: Option<u32>,
    #[serde(default)]
    pub intent: Option<FileOperationIntent>,
    /// Retain interrupted operation paths when a recovery starts a new transaction.
    #[serde(default)]
    pub recovery_paths: Vec<PathBuf>,
}

impl EidoFileReview {
    pub fn pending(&self) -> bool { matches!(self.decision, FileReviewDecision::Pending | FileReviewDecision::Applying | FileReviewDecision::Restoring | FileReviewDecision::Unknown) }
    pub fn label(&self) -> &'static str {
        match self.decision {
            FileReviewDecision::Pending => if self.proposal.output.is_none() { "Delete file" } else { "File replacement" },
            FileReviewDecision::Applying => "Applying file change",
            FileReviewDecision::Accepted => "File change accepted",
            FileReviewDecision::Rejected => "File change rejected",
            FileReviewDecision::Restoring => "Restoring original file",
            FileReviewDecision::Restored => "Original file restored",
            FileReviewDecision::Unknown => "Interrupted file change · review required",
            FileReviewDecision::KeptCurrent => "Current file kept",
        }
    }

    pub fn markdown(&self) -> String {
        let before = decode(self.proposal.expected_disk.as_deref()).ok().flatten();
        let after = decode(self.proposal.output.as_deref()).ok().flatten();
        fn describe(value: &Option<Vec<u8>>) -> String {
            let Some(bytes) = value else { return "File absent".into(); };
            let preview = bytes.iter().take(64).map(|byte| format!("{byte:02x}")).collect::<Vec<_>>().join(" ");
            format!("{} bytes\n\n```text\n{preview}{}\n```", bytes.len(), if bytes.len() > 64 { " …" } else { "" })
        }
        format!("# {}\n\nPath: `{}`\n\nSource: {} · {}\n\nRun: `{}`\n\nDecision: {:?}\n\n## Original disk contents\n\n{}\n\n## Proposed result\n\n{}\n\n{}{}",
            self.label(), self.proposal.path.display(), self.source_title, self.source_session, self.proposal.run_id,
            self.decision, describe(&before), describe(&after),
            self.proposal.expected_buffer.as_ref().map(|text| format!("## Captured editor contents\n\n```text\n{text}\n```\n\n")).unwrap_or_default(),
            format!("{}\n\nRecovery files: {}", self.error.as_deref().unwrap_or(""),
                self.recovery_paths.iter().chain(self.backup_path.iter()).chain(self.staging_path.iter())
                    .map(|path| format!("`{}`", path.display())).collect::<Vec<_>>().join(", ")) )
    }
}

/// One durable operation journal per root task, shared by its child sessions.
/// An interrupted operation is exposed for review, never replayed at startup.
pub struct EidoFileReviews {
    project: Entity<Project>,
    roots: Vec<PathBuf>,
    key: String,
    records: Vec<EidoFileReview>,
    busy: bool,
    storage_error: Option<String>,
    retained_buffers: HashMap<PathBuf, Entity<Buffer>>,
}

impl EidoFileReviews {
    pub fn open(project: Entity<Project>, roots: Option<&PathList>, session: &acp::SessionId, cx: &mut App) -> Entity<Self> {
        let roots = roots.map(|roots| roots.ordered_paths().cloned().collect::<Vec<_>>()).unwrap_or_default();
        let key = serde_json::to_string(&(session.to_string(), &roots)).expect("Serializable file review key");
        let saved = if std::env::var_os("EIDO_ROOT").is_some() || cfg!(test) {
            KeyValueStore::global(cx).scoped(NAMESPACE).read(&key)
                .and_then(|raw| raw.map(|raw| serde_json::from_str::<Vec<EidoFileReview>>(&raw).map_err(Into::into)).transpose())
        } else { Ok(None) };
        let (mut records, storage_error) = match saved { Ok(saved) => (saved.unwrap_or_default(), None), Err(error) => (vec![], Some(format!("File reviews could not be loaded: {error}. The saved record was preserved."))) };
        for record in &mut records {
            if matches!(record.decision, FileReviewDecision::Applying | FileReviewDecision::Restoring) {
                record.intent = Some(if record.decision == FileReviewDecision::Restoring {FileOperationIntent::Restore} else {FileOperationIntent::Accept});
                record.decision = FileReviewDecision::Unknown;
                record.error = Some("Eido stopped during this file operation. Inspect the file, then restore the original or keep the current contents.".into());
            }
        }
        let journal = cx.new(|_| Self {project, roots, key, records, busy: false, storage_error, retained_buffers: HashMap::new()});
        let registry = cx.default_global::<FileReviewRegistry>();
        registry.journals.retain(|journal| journal.upgrade().is_some());
        registry.journals.push(journal.downgrade());
        journal
    }

    pub fn records(&self) -> &[EidoFileReview] { &self.records }
    pub fn pending_count(&self) -> usize { self.records.iter().filter(|record| record.pending()).count() }
    pub fn busy(&self) -> bool { self.busy || self.storage_error.is_some() }
    pub fn storage_error(&self) -> Option<&str> { self.storage_error.as_deref() }

    pub fn propose(&mut self, proposal: EidoFileProposal, source_session: String, source_title: String, cx: &mut Context<Self>) -> Task<Result<String>> {
        if self.busy() { return Task::ready(Err(anyhow::anyhow!("File reviews are busy or unavailable"))); }
        self.busy = true;
        let project = self.project.clone(); let roots = self.roots.clone();
        cx.spawn(async move |this, cx| {
            let result = async {
                let before = decode(proposal.expected_disk.as_deref())?;
                let after = decode(proposal.output.as_deref())?;
                ensure!(before != after || proposal.expected_buffer.is_some(), "File operation has no change");
                ensure!(before.is_some() || after.is_some(), "This file has no disk version. Review or discard its unsaved buffer before deleting it.");
                let fs = validate_path(&project, &roots, &proposal.path, cx).await?;
                ensure!(disk_bytes(fs.as_ref(), &proposal.path).await? == before, "File changed on disk while the command ran. Its output was preserved.");
                validate_buffer(&project, &proposal.path, proposal.expected_buffer.as_deref(), proposal.expected_disk.as_deref(), false, cx)?;
                ensure!(!cx.update(|cx| file_operation_blocks_path(&proposal.path, cx)), "This file already has a pending operation in a task");
                let retained = project.read_with(cx, |project, cx| project.project_path_for_absolute_path(&proposal.path, cx)
                    .and_then(|path| project.get_open_buffer(&path, cx)));
                let id = Uuid::new_v4().to_string();
                this.update(cx, |this, cx| {
                    ensure!(!this.records.iter().any(|record| record.pending() && record.proposal.path == proposal.path), "This file already has a pending operation");
                    if let Some(buffer) = retained {this.retained_buffers.insert(proposal.path.clone(), buffer);}
                this.records.push(EidoFileReview {id: id.clone(), proposal, source_session, source_title,
                        decision: FileReviewDecision::Pending, changed_at: chrono::Utc::now().to_rfc3339(), backup_path: None, staging_path: None, error: None, original_mode: None, intent: None, recovery_paths: Vec::new()});
                    cx.notify(); anyhow::Ok(())
                })??;
                persist(&this, cx).await?;
                Ok(id)
            }.await;
            this.update(cx, |this, cx| {this.busy = false; cx.notify();})?;
            result
        })
    }

    /// Accepted/unknown operations can explicitly restore their original bytes.
    /// Rejected records remain available as evidence but never mutate files.
    pub fn decide(&mut self, id: String, action: &str, cx: &mut Context<Self>) -> Task<Result<()>> {
        if self.busy() { return Task::ready(Err(anyhow::anyhow!("File reviews are busy or unavailable"))); }
        let Some(record) = self.records.iter().find(|record| record.id == id).cloned() else { return Task::ready(Err(anyhow::anyhow!("File review is unavailable"))); };
        let restore = action == "restore";
        let reject = action == "reject";
        if !(reject && matches!(record.decision, FileReviewDecision::Pending | FileReviewDecision::Unknown)
            || restore && matches!(record.decision, FileReviewDecision::Accepted | FileReviewDecision::Unknown)
            || action == "accept" && record.decision == FileReviewDecision::Pending) {
            return Task::ready(Err(anyhow::anyhow!("This review decision is no longer available")));
        }
        self.busy = true;
        let project = self.project.clone(); let roots = self.roots.clone();
        cx.spawn(async move |this, cx| {
            let result = async {
                if reject {
                    update_record(&this, &id, if record.decision == FileReviewDecision::Unknown {FileReviewDecision::KeptCurrent} else {FileReviewDecision::Rejected}, None, cx)?;
                    persist(&this, cx).await?;
                    return Ok(());
                }
                let fs = validate_path(&project, &roots, &record.proposal.path, cx).await?;
                let before = decode(record.proposal.expected_disk.as_deref())?;
                let after = decode(record.proposal.output.as_deref())?;
                let interrupted_expected = if record.intent == Some(FileOperationIntent::Restore) {after.clone()} else {before.clone()};
                let (expected, output) = if restore { (after, before) } else { (before, after) };
                validate_text_reviews(&record.proposal.path, cx)?;
                let current = disk_bytes(fs.as_ref(), &record.proposal.path).await?;
                if restore && record.decision == FileReviewDecision::Unknown && current == output {
                    validate_buffer(&project, &record.proposal.path, record.proposal.expected_buffer.as_deref(), record.proposal.expected_disk.as_deref(), false, cx)?;
                    update_record(&this, &id, FileReviewDecision::Restored, None, cx)?;
                    persist(&this, cx).await?;
                    return Ok(());
                }
                // A crash may occur after moving the original but before installing
                // the output. Restore into that gap only with our verified backup.
                let gap = restore && record.decision == FileReviewDecision::Unknown && current.is_none()
                    && match &record.backup_path {Some(path) => disk_bytes(fs.as_ref(), path).await? == interrupted_expected, None => false};
                ensure!(current == expected || gap, "File has newer disk contents. Keep the current file or reconcile it manually; no contents were overwritten.");
                let expected = if gap {None} else {expected};
                validate_buffer(&project, &record.proposal.path, record.proposal.expected_buffer.as_deref(), record.proposal.expected_disk.as_deref(), !restore && output.is_some(), cx)?;
                let parent = record.proposal.path.parent().context("File has no parent directory")?;
                fs.create_dir(parent).await?;
                let token = Uuid::new_v4();
                let backup = parent.join(format!(".eido-review-{token}.original"));
                let staged = parent.join(format!(".eido-review-{token}.pending"));
                let original_mode = if restore {record.original_mode} else {read_mode(fs.as_ref(), &record.proposal.path)};
                this.update(cx, |this, cx| {
                    let record = this.records.iter_mut().find(|record| record.id == id).context("File review disappeared")?;
                    record.decision = if restore {FileReviewDecision::Restoring} else {FileReviewDecision::Applying};
                    record.intent = Some(if restore {FileOperationIntent::Restore} else {FileOperationIntent::Accept});
                    record.recovery_paths.extend(record.backup_path.take());
                    record.recovery_paths.extend(record.staging_path.take());
                    record.backup_path = expected.as_ref().map(|_| backup.clone());
                    record.staging_path = output.as_ref().map(|_| staged.clone());
                    if !restore {record.original_mode = original_mode;}
                    record.error = None; record.changed_at = chrono::Utc::now().to_rfc3339(); cx.notify(); anyhow::Ok(())
                })??;
                // Persist intent and complete recovery bytes before touching source files.
                persist(&this, cx).await?;
                if let Some(bytes) = &output {
                    if expected.is_some() {fs.copy_file(&record.proposal.path, &staged, Default::default()).await?;}
                    else {fs.create_file(&staged, Default::default()).await?;}
                    fs.write(&staged, bytes).await?;
                    prepare_staged_file(fs.as_ref(), &staged, original_mode)?;
                }
                validate_buffer(&project, &record.proposal.path, record.proposal.expected_buffer.as_deref(), record.proposal.expected_disk.as_deref(), !restore && output.is_some(), cx)?;
                if expected.is_some() {
                    fs.rename(&record.proposal.path, &backup, Default::default()).await?;
                    if disk_bytes(fs.as_ref(), &backup).await? != expected {
                        // A concurrent writer won the race. Restore only into an absent
                        // destination; otherwise preserve its bytes beside the file.
                        let _ = fs.rename(&backup, &record.proposal.path, Default::default()).await;
                        anyhow::bail!("File changed during acceptance. Its concurrent contents were preserved; inspect the interrupted operation.");
                    }
                }
                if output.is_some() { fs.rename(&staged, &record.proposal.path, Default::default()).await?; }
                // No overwrite rename: a concurrently created destination is preserved.
                update_record(&this, &id, if restore {FileReviewDecision::Restored} else {FileReviewDecision::Accepted}, None, cx)?;
                persist(&this, cx).await?;
                // The durable journal retains the original bytes for restoration.
                // Only remove the temporary original after the accepted record is
                // saved, and only while it still contains the expected bytes.
                if expected.is_some() && disk_bytes(fs.as_ref(), &backup).await? == expected {
                    if let Err(error) = fs.remove_file(&backup, Default::default()).await {
                        update_record(&this, &id, if restore {FileReviewDecision::Restored} else {FileReviewDecision::Accepted},
                            Some(format!("File operation completed. Recovery backup remains at {} because cleanup failed: {error}", backup.display())), cx)?;
                        persist(&this, cx).await?;
                    }
                }
                Ok(())
            }.await;
            if let Err(error) = &result {
                this.update(cx, |this, cx| {
                    if let Some(record) = this.records.iter_mut().find(|record| record.id == id) {
                        if matches!(record.decision, FileReviewDecision::Applying | FileReviewDecision::Restoring) {record.decision = FileReviewDecision::Unknown;}
                        record.error = Some(error.to_string());
                    }
                    cx.notify();
                })?;
                let _ = persist(&this, cx).await;
            }
            this.update(cx, |this, cx| {this.busy = false; cx.notify();})?;
            result
        })
    }
}

fn read_mode(fs: &dyn Fs, path: &Path) -> Option<u32> {
    if fs.is_fake() {return None;}
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::metadata(path).ok().map(|metadata| metadata.permissions().mode())
    }
    #[cfg(not(unix))] {None}
}

fn prepare_staged_file(fs: &dyn Fs, path: &Path, mode: Option<u32>) -> Result<()> {
    if fs.is_fake() {return Ok(());}
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode.unwrap_or(0o644)))?;
    }
    std::fs::File::open(path)?.sync_all()?;
    Ok(())
}

fn decode(value: Option<&str>) -> Result<Option<Vec<u8>>> {
    value.map(|value| {
        ensure!(value.len() <= (MAX_BYTES + 2) / 3 * 4, "File review exceeds 1 MiB");
        let bytes = STANDARD.decode(value)?;
        ensure!(bytes.len() <= MAX_BYTES, "File review exceeds 1 MiB");
        Ok(bytes)
    }).transpose()
}

async fn disk_bytes(fs: &dyn Fs, path: &Path) -> Result<Option<Vec<u8>>> {
    let Some(metadata) = fs.metadata(path).await? else {return Ok(None);};
    ensure!(!metadata.is_dir && !metadata.is_symlink && !metadata.is_fifo && metadata.len <= MAX_BYTES as u64, "File type or size is not supported for review");
    Ok(Some(fs.load_bytes(path).await?))
}

async fn validate_path(project: &Entity<Project>, roots: &[PathBuf], path: &Path, cx: &mut AsyncApp) -> Result<Arc<dyn Fs>> {
    ensure!(path.is_absolute(), "File path must be absolute");
    let fs = project.read_with(cx, |project, _| project.fs().clone());
    let canonical = canonical_editor_path(fs.as_ref(), path).await?;
    let mut valid = false;
    for root in roots {
        if allowed_path(&fs.canonicalize(root).await?, &canonical) && allowed_path(root, path)
            && project.read_with(cx, |project, cx| visible_path(project, root, path, cx)) {valid = true; break;}
    }
    ensure!(valid, "File is outside the task workspace or in private storage");
    ensure!(canonical == path, "File operations require a canonical path without symbolic links");
    Ok(fs)
}

fn validate_text_reviews(path: &Path, cx: &mut AsyncApp) -> Result<()> {
    cx.update(|cx| {
        if let Some(registry) = cx.try_global::<FileReviewRegistry>() {
            for log in &registry.logs {
                if let Some(log) = log.upgrade() {
                    ensure!(!log.read(cx).has_pending_review_for_path(path, cx),
                        "This file has pending text edits in a task. Review those edits before applying a file operation.");
                }
            }
        }
        Ok(())
    })
}

fn validate_buffer(project: &Entity<Project>, path: &Path, expected: Option<&str>, disk: Option<&str>, replacing: bool, cx: &mut AsyncApp) -> Result<()> {
    project.read_with(cx, |project, cx| {
        let absolute = path;
        let path = project.project_path_for_absolute_path(path, cx).context("File is outside the loaded workspace")?;
        let buffer = project.get_open_buffer(&path, cx).or_else(|| {
            // Deleted files leave the path index while their unsaved tab stays alive.
            project.buffer_store().read(cx).buffers().find(|buffer| buffer.read(cx).file()
                .and_then(|file| file.as_local()).is_some_and(|file| file.abs_path(cx) == project.absolute_path(&path, cx).unwrap_or_default()))
        }).or_else(|| cx.try_global::<FileReviewRegistry>().and_then(|registry| registry.journals.iter()
            .filter_map(WeakEntity::upgrade).find_map(|journal| journal.read(cx).retained_buffers.get(absolute).cloned())));
        if let Some(buffer) = buffer {
            let buffer = buffer.read(cx);
            ensure!(!buffer.has_conflict(), "Resolve the editor's disk conflict before reviewing this operation");
            if let Some(expected) = expected {ensure!(buffer.text() == expected, "Editor contents changed since capture. Current edits were preserved.");}
            else {ensure!(!buffer.is_dirty(), "This file has unsaved editor contents. Current edits were preserved.");}
            ensure!(!replacing || !buffer.is_dirty(), "Save or reconcile unsaved editor contents before replacing this file with binary data");
        } else if expected.is_some() {
            let disk = decode(disk)?;
            ensure!(disk.as_deref() == expected.map(str::as_bytes),
                "The captured unsaved editor buffer is no longer open. Reopen it and recover the captured draft from Review before applying this operation.");
        }
        Ok(())
    })
}

fn update_record(this: &gpui::WeakEntity<EidoFileReviews>, id: &str, decision: FileReviewDecision, error: Option<String>, cx: &mut AsyncApp) -> Result<()> {
    this.update(cx, |this, cx| {
        let record = this.records.iter_mut().find(|record| record.id == id).context("File review disappeared")?;
        record.decision = decision; record.error = error; record.changed_at = chrono::Utc::now().to_rfc3339(); cx.notify(); Ok(())
    })?
}

async fn persist(this: &gpui::WeakEntity<EidoFileReviews>, cx: &mut AsyncApp) -> Result<()> {
    let (db, key, payload) = this.read_with(cx, |this, cx| {
        Ok::<_, anyhow::Error>((KeyValueStore::global(cx), this.key.clone(), serde_json::to_string(&this.records)?))
    })??;
    if let Err(error) = db.scoped(NAMESPACE).write(key, payload).await {
        this.update(cx, |this, cx| {this.storage_error = Some(format!("File review could not be saved: {error}. No further file operations are allowed until recovery.")); cx.notify();})?;
        return Err(error);
    }
    Ok(())
}

impl AcpThread {
    pub fn observe_file_bytes(&self, path: PathBuf, cx: &mut Context<Self>) -> Task<Result<EidoFileSnapshot>> {
        let project = self.project().clone();
        let roots = self.work_dirs().map(|dirs| dirs.ordered_paths().cloned().collect::<Vec<_>>()).unwrap_or_default();
        cx.spawn(async move |this, cx| {
            let fs = validate_path(&project, &roots, &path, cx).await?;
            let disk = disk_bytes(fs.as_ref(), &path).await?;
            let is_text = disk.as_ref().is_none_or(|bytes| !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok());
            let buffer = if is_text {
                Some(this.update(cx, |thread, cx| thread.observe_text_file(path.clone(), cx))?.await?)
            } else {
                validate_buffer(&project, &path, None, None, false, cx)?;
                None
            };
            // Reading/loading a buffer can yield to a write. Pair its contents
            // with the exact disk bytes that remain at the capture boundary.
            ensure!(disk_bytes(fs.as_ref(), &path).await? == disk, "File changed while capturing command inputs");
            let bytes = buffer.as_ref().map(|text| text.as_bytes()).or(disk.as_deref()).context("File is unavailable")?;
            ensure!(bytes.len() <= MAX_BYTES, "Command input exceeds 1 MiB");
            Ok(EidoFileSnapshot {content: STANDARD.encode(bytes), disk: disk.as_ref().map(|bytes| STANDARD.encode(bytes)), buffer})
        })
    }

    pub fn propose_file_operation(&self, proposal: EidoFileProposal, cx: &mut Context<Self>) -> Task<Result<String>> {
        if self.review_is_unavailable() {return Task::ready(Err(anyhow::anyhow!("Resolve pending review recovery before proposing a file operation")));}
        let session = self.session_id().to_string(); let title = self.title().unwrap_or_else(|| "Main agent".into()).to_string();
        self.file_reviews().update(cx, |reviews, cx| reviews.propose(proposal, session, title, cx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fs::FakeFs;
    use gpui::TestAppContext;
    use settings::SettingsStore;

    async fn setup(cx: &mut TestAppContext) -> (Arc<FakeFs>, Entity<Project>, Entity<EidoFileReviews>) {
        cx.update(|cx| {
            let store = SettingsStore::test(cx);
            cx.set_global(store);
            cx.set_global(db::AppDatabase::test_new());
        });
        let fs = FakeFs::new(cx.executor());
        fs.insert_tree("/files", serde_json::json!({"original.txt":"disk text", "asset.bin":"original bytes"})).await;
        let project = Project::test(fs.clone(), [Path::new("/files")], cx).await;
        let journal = cx.update(|cx| EidoFileReviews::open(project.clone(), Some(&PathList::new(&[Path::new("/files")])), &acp::SessionId::new("test"), cx));
        (fs, project, journal)
    }

    fn proposal(path: &str, before: Option<&[u8]>, after: Option<&[u8]>, buffer: Option<&str>) -> EidoFileProposal {
        EidoFileProposal {path: path.into(), expected_disk: before.map(|bytes| STANDARD.encode(bytes)), output: after.map(|bytes| STANDARD.encode(bytes)),
            expected_buffer: buffer.map(str::to_string), run_id: "run".into(), tool_call_id: "shell".into()}
    }

    async fn submit(journal: &Entity<EidoFileReviews>, proposal: EidoFileProposal, cx: &mut TestAppContext) -> Result<String> {
        journal.update(cx, |journal, cx| journal.propose(proposal, "child".into(), "Worker".into(), cx)).await
    }

    #[gpui::test]
    async fn test_eido_file_operations_binary_accept_reject_restore_and_durable_record(cx: &mut TestAppContext) {
        let (fs, _, journal) = setup(cx).await;
        let id = submit(&journal, proposal("/files/new.bin", None, Some(&[0, 255, 1]), None), cx).await.unwrap();
        assert!(fs.read_file_sync("/files/new.bin").is_err());
        let payload = cx.read(|cx| KeyValueStore::global(cx).scoped(NAMESPACE).read(&journal.read(cx).key).unwrap().unwrap());
        let saved: Vec<EidoFileReview> = serde_json::from_str(&payload).unwrap();
        assert_eq!(saved[0].source_session, "child");
        assert_eq!(saved[0].decision, FileReviewDecision::Pending);
        journal.update(cx, |journal, cx| journal.decide(id.clone(), "reject", cx)).await.unwrap();
        assert!(fs.read_file_sync("/files/new.bin").is_err());
        let id = submit(&journal, proposal("/files/new.bin", None, Some(&[0, 255, 1]), None), cx).await.unwrap();
        journal.update(cx, |journal, cx| journal.decide(id.clone(), "accept", cx)).await.unwrap();
        assert_eq!(fs.read_file_sync("/files/new.bin").unwrap(), [0, 255, 1]);
        journal.update(cx, |journal, cx| journal.decide(id, "restore", cx)).await.unwrap();
        assert!(fs.read_file_sync("/files/new.bin").is_err());
        let id = submit(&journal, proposal("/files/asset.bin", Some(b"original bytes"), Some(&[0, 4]), None), cx).await.unwrap();
        journal.update(cx, |journal, cx| journal.decide(id.clone(), "accept", cx)).await.unwrap();
        assert_eq!(fs.read_file_sync("/files/asset.bin").unwrap(), [0, 4]);
        journal.update(cx, |journal, cx| journal.decide(id, "restore", cx)).await.unwrap();
        assert_eq!(fs.read_file_sync("/files/asset.bin").unwrap(), b"original bytes");
        assert_eq!(journal.read_with(cx, |journal, _| journal.pending_count()), 0);
    }

    #[gpui::test]
    async fn test_eido_file_operations_delete_preserves_unsaved_buffer_and_reject(cx: &mut TestAppContext) {
        let (fs, project, journal) = setup(cx).await;
        let buffer = project.update(cx, |project, cx| project.open_buffer(project.project_path_for_absolute_path(Path::new("/files/original.txt"), cx).unwrap(), cx)).await.unwrap();
        buffer.update(cx, |buffer, cx| buffer.edit([(0..buffer.len(), "manual unsaved")], None, cx));
        let id = submit(&journal, proposal("/files/original.txt", Some(b"disk text"), None, Some("manual unsaved")), cx).await.unwrap();
        journal.update(cx, |journal, cx| journal.decide(id, "reject", cx)).await.unwrap();
        assert_eq!(fs.read_file_sync("/files/original.txt").unwrap(), b"disk text");
        assert_eq!(buffer.read_with(cx, |buffer, _| buffer.text()), "manual unsaved");
        let id = submit(&journal, proposal("/files/original.txt", Some(b"disk text"), None, Some("manual unsaved")), cx).await.unwrap();
        journal.update(cx, |journal, cx| journal.decide(id.clone(), "accept", cx)).await.unwrap();
        assert!(fs.read_file_sync("/files/original.txt").is_err());
        assert_eq!(buffer.read_with(cx, |buffer, _| buffer.text()), "manual unsaved");
        journal.update(cx, |journal, cx| journal.decide(id, "restore", cx)).await.unwrap();
        assert_eq!(fs.read_file_sync("/files/original.txt").unwrap(), b"disk text");
        assert_eq!(buffer.read_with(cx, |buffer, _| buffer.text()), "manual unsaved");
    }

    #[gpui::test]
    async fn test_eido_file_operations_preserve_concurrent_disk_and_editor_changes(cx: &mut TestAppContext) {
        let (fs, project, journal) = setup(cx).await;
        let id = submit(&journal, proposal("/files/asset.bin", Some(b"original bytes"), Some(&[0, 4]), None), cx).await.unwrap();
        fs.write(Path::new("/files/asset.bin"), b"external edit").await.unwrap();
        assert!(journal.update(cx, |journal, cx| journal.decide(id.clone(), "accept", cx)).await.is_err());
        assert_eq!(fs.read_file_sync("/files/asset.bin").unwrap(), b"external edit");
        journal.update(cx, |journal, cx| journal.decide(id, "reject", cx)).await.unwrap();
        let buffer = project.update(cx, |project, cx| project.open_buffer(project.project_path_for_absolute_path(Path::new("/files/original.txt"), cx).unwrap(), cx)).await.unwrap();
        let id = submit(&journal, proposal("/files/original.txt", Some(b"disk text"), None, Some("disk text")), cx).await.unwrap();
        buffer.update(cx, |buffer, cx| buffer.edit([(0..0, "later manual ")], None, cx));
        assert!(journal.update(cx, |journal, cx| journal.decide(id, "accept", cx)).await.is_err());
        assert_eq!(fs.read_file_sync("/files/original.txt").unwrap(), b"disk text");
        assert_eq!(buffer.read_with(cx, |buffer, _| buffer.text()), "later manual disk text");
        assert!(submit(&journal, proposal("/files/.local/private", None, Some(&[0]), None), cx).await.is_err());
        assert!(submit(&journal, proposal("/files/../outside", None, Some(&[0]), None), cx).await.is_err());
    }

    #[gpui::test]
    async fn test_eido_file_operations_interrupted_gap_restores_without_replay(cx: &mut TestAppContext) {
        let (fs, _, journal) = setup(cx).await;
        let id = submit(&journal, proposal("/files/asset.bin", Some(b"original bytes"), Some(&[0, 4]), None), cx).await.unwrap();
        let backup = PathBuf::from("/files/.eido-review-interrupted.original");
        fs.rename(Path::new("/files/asset.bin"), &backup, Default::default()).await.unwrap();
        journal.update(cx, |journal, _| {
            let record = journal.records.iter_mut().find(|record| record.id == id).unwrap();
            record.decision = FileReviewDecision::Unknown; record.backup_path = Some(backup);
        });
        assert!(fs.read_file_sync("/files/asset.bin").is_err());
        journal.update(cx, |journal, cx| journal.decide(id.clone(), "restore", cx)).await.unwrap();
        assert_eq!(fs.read_file_sync("/files/asset.bin").unwrap(), b"original bytes");
        assert!(journal.update(cx, |journal, cx| journal.decide(id, "accept", cx)).await.is_err());
    }
    fn reopen(project: &Entity<Project>, cx: &mut TestAppContext) -> Entity<EidoFileReviews> {
        cx.update(|cx| EidoFileReviews::open(project.clone(), Some(&PathList::new(&[Path::new("/files")])), &acp::SessionId::new("test"), cx))
    }

    #[gpui::test]
    async fn test_eido_file_operations_reopen_preserves_decisions_without_replay(cx: &mut TestAppContext) {
        let (fs, project, journal) = setup(cx).await;
        let pending = submit(&journal, proposal("/files/pending.bin", None, Some(&[0, 1]), None), cx).await.unwrap();
        let rejected = submit(&journal, proposal("/files/rejected.bin", None, Some(&[0, 2]), None), cx).await.unwrap();
        journal.update(cx, |journal, cx| journal.decide(rejected, "reject", cx)).await.unwrap();
        let accepted = submit(&journal, proposal("/files/accepted.bin", None, Some(&[0, 3]), None), cx).await.unwrap();
        journal.update(cx, |journal, cx| journal.decide(accepted, "accept", cx)).await.unwrap();
        drop(journal);
        let journal = reopen(&project, cx);
        assert_eq!(journal.read_with(cx, |journal, _| journal.records.iter().map(|r| r.decision.clone()).collect::<Vec<_>>()),
            vec![FileReviewDecision::Pending, FileReviewDecision::Rejected, FileReviewDecision::Accepted]);
        assert!(fs.read_file_sync("/files/pending.bin").is_err());
        assert!(fs.read_file_sync("/files/rejected.bin").is_err());
        assert_eq!(fs.read_file_sync("/files/accepted.bin").unwrap(), [0, 3]);
        journal.update(cx, |journal, cx| journal.decide(pending, "reject", cx)).await.unwrap();
    }

    #[gpui::test]
    async fn test_eido_file_operations_reopen_interrupted_restore_gap(cx: &mut TestAppContext) {
        let (fs, project, journal) = setup(cx).await;
        let id = submit(&journal, proposal("/files/asset.bin", Some(b"original bytes"), Some(&[0, 4]), None), cx).await.unwrap();
        journal.update(cx, |journal, cx| journal.decide(id.clone(), "accept", cx)).await.unwrap();
        let backup = PathBuf::from("/files/.eido-review-restore-interrupted.original");
        fs.rename(Path::new("/files/asset.bin"), &backup, Default::default()).await.unwrap();
        let (key, payload) = journal.update(cx, |journal, _| {
            let record = journal.records.iter_mut().find(|record| record.id == id).unwrap();
            record.decision = FileReviewDecision::Restoring;
            record.intent = Some(FileOperationIntent::Restore);
            record.backup_path = Some(backup.clone());
            (journal.key.clone(), serde_json::to_string(&journal.records).unwrap())
        });
        let db = cx.read(KeyValueStore::global);
        db.scoped(NAMESPACE).write(key, payload).await.unwrap();
        drop(journal);
        let journal = reopen(&project, cx);
        assert_eq!(journal.read_with(cx, |journal, _| journal.records[0].decision.clone()), FileReviewDecision::Unknown);
        assert!(fs.read_file_sync("/files/asset.bin").is_err(), "Loading the journal never replays a write");
        journal.update(cx, |journal, cx| journal.decide(id, "restore", cx)).await.unwrap();
        assert_eq!(fs.read_file_sync("/files/asset.bin").unwrap(), b"original bytes");
        assert!(journal.read_with(cx, |journal, _| journal.records[0].recovery_paths.contains(&backup)));
        assert_eq!(fs.load_bytes(&backup).await.unwrap(), [0, 4]);
    }

    #[gpui::test]
    async fn test_eido_file_operations_cross_task_and_text_review_protection(cx: &mut TestAppContext) {
        let (fs, project, first) = setup(cx).await;
        let second = cx.update(|cx| EidoFileReviews::open(project.clone(), Some(&PathList::new(&[Path::new("/files")])), &acp::SessionId::new("second"), cx));
        let id = submit(&first, proposal("/files/asset.bin", Some(b"original bytes"), Some(&[0, 5]), None), cx).await.unwrap();
        assert!(submit(&second, proposal("/files/asset.bin", Some(b"original bytes"), None, None), cx).await.is_err());
        first.update(cx, |journal, cx| journal.decide(id, "reject", cx)).await.unwrap();
        let buffer = project.update(cx, |project, cx| project.open_buffer(project.project_path_for_absolute_path(Path::new("/files/original.txt"), cx).unwrap(), cx)).await.unwrap();
        let log = cx.new(|_| ActionLog::new(project.clone()));
        cx.update(|cx| register_file_review_log(&log, cx));
        log.update(cx, |log, cx| {log.set_save_on_review(false, cx); log.buffer_read(buffer.clone(), cx);});
        buffer.update(cx, |buffer, cx| buffer.edit([(0..0, "agent ")], None, cx));
        log.update(cx, |log, cx| log.buffer_edited(buffer.clone(), cx));
        let id = submit(&second, proposal("/files/original.txt", Some(b"disk text"), None, Some("agent disk text")), cx).await.unwrap();
        assert!(second.update(cx, |journal, cx| journal.decide(id.clone(), "accept", cx)).await.is_err());
        assert_eq!(fs.read_file_sync("/files/original.txt").unwrap(), b"disk text");
        log.update(cx, |log, cx| log.keep_all_edits(None, cx));
        cx.run_until_parked();
        second.update(cx, |journal, cx| journal.decide(id, "accept", cx)).await.unwrap();
        assert_eq!(buffer.read_with(cx, |buffer, _| buffer.text()), "agent disk text");
    }

}
