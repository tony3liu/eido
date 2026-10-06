use std::{path::PathBuf, sync::Arc};

use acp_thread::MentionUri;
use editor::Editor;
use gpui::{
    DismissEvent, Entity, EventEmitter, FocusHandle, Focusable, Subscription, Task, WeakEntity,
};
use language::Buffer;
use rope::Point;
use serde::{Deserialize, Serialize};
use ui::prelude::*;
use workspace::{ModalView, Workspace};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureMetadata {
    version: u8,
    pub unsaved: bool,
    pub summary: bool,
}

impl CaptureMetadata {
    pub fn new(unsaved: bool, summary: bool) -> Self {
        Self {
            version: 1,
            unsaved,
            summary,
        }
    }
    pub fn from_meta(meta: Option<&agent_client_protocol::schema::v1::Meta>) -> Option<Self> {
        let value: Self = serde_json::from_value(meta?.get("eidoReference")?.clone()).ok()?;
        (value.version == 1).then_some(value)
    }
}

/// The text comes from the original mention payload, including restored drafts
/// and historical messages. Opening a reference must never reread its snapshot.
pub(crate) fn open_snapshot(
    uri: MentionUri,
    content: Arc<str>,
    capture: Option<CaptureMetadata>,
    workspace: &WeakEntity<Workspace>,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(workspace) = workspace.upgrade() else {
        return;
    };
    workspace.update(cx, |workspace, cx| {
        let project = workspace.project().clone();
        let owner = cx.weak_entity();
        workspace.toggle_modal(window, cx, move |window, cx| {
            ReferenceSnapshot::new(uri, content, capture, project, owner, window, cx)
        });
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReferenceStatus {
    Captured,
    Loading,
    Unavailable,
    Unverified,
    Current(Point),
    Moved(Point),
    Changed,
    Ambiguous,
}

impl ReferenceStatus {
    fn label(self) -> &'static str {
        match self {
            Self::Captured => "Captured context · read only",
            Self::Loading => "Checking current file…",
            Self::Unavailable => "Current file unavailable · snapshot preserved",
            Self::Unverified => "Summary snapshot · current file not compared",
            Self::Current(_) => "Matches current content",
            Self::Moved(_) => "Content found at a different location",
            Self::Changed => "Content changed · snapshot preserved",
            Self::Ambiguous => "Multiple matching locations · location not confirmed",
        }
    }

    fn point(self) -> Option<Point> {
        match self {
            Self::Current(point) | Self::Moved(point) => Some(point),
            _ => None,
        }
    }
}

fn source(uri: &MentionUri) -> Option<(PathBuf, Option<Point>)> {
    match uri {
        MentionUri::File { abs_path } => Some((abs_path.clone(), None)),
        MentionUri::Symbol {
            abs_path,
            line_range,
            ..
        } => Some((abs_path.clone(), Some(Point::new(*line_range.start(), 0)))),
        MentionUri::Selection {
            abs_path: Some(abs_path),
            line_range,
            column,
        } => Some((
            abs_path.clone(),
            Some(Point::new(*line_range.start(), column.unwrap_or(0))),
        )),
        _ => None,
    }
}

fn point_at(text: &str, offset: usize) -> Point {
    let prefix = &text[..offset];
    Point::new(
        prefix.bytes().filter(|byte| *byte == b'\n').count() as u32,
        prefix
            .rsplit_once('\n')
            .map_or(prefix.len(), |(_, line)| line.len()) as u32,
    )
}

/// Only an exact, unique match may move a historical selection. Guessing a row
/// after deletion or matching the first of several copies misattributes code.
fn compare_reference(uri: &MentionUri, captured: &str, current: &str) -> ReferenceStatus {
    let Some((_, origin)) = source(uri) else {
        return ReferenceStatus::Captured;
    };
    if origin.is_none() {
        if captured.starts_with("# File outline") || captured.starts_with("# First 1KB of ") {
            return ReferenceStatus::Unverified;
        }
        return if captured == current {
            ReferenceStatus::Current(Point::new(0, 0))
        } else {
            ReferenceStatus::Changed
        };
    }
    if captured.is_empty() {
        return ReferenceStatus::Unverified;
    }
    let Some(offset) = current.find(captured) else {
        return ReferenceStatus::Changed;
    };
    let next = offset + current[offset..].chars().next().unwrap().len_utf8();
    if current[next..].contains(captured) {
        return ReferenceStatus::Ambiguous;
    }
    let point = point_at(current, offset);
    if Some(point) == origin {
        ReferenceStatus::Current(point)
    } else {
        ReferenceStatus::Moved(point)
    }
}

pub(crate) fn reference_warning(
    uri: &MentionUri,
    captured: &str,
    current: &str,
    capture: Option<&CaptureMetadata>,
) -> Option<&'static str> {
    if capture.is_some_and(|capture| capture.summary) {
        return None;
    }
    match compare_reference(uri, captured, current) {
        ReferenceStatus::Changed => Some("Content changed · view captured snapshot"),
        ReferenceStatus::Moved(_) => Some("Content moved · view captured snapshot"),
        ReferenceStatus::Ambiguous => Some("Location is ambiguous · view captured snapshot"),
        _ => None,
    }
}

struct ReferenceSnapshot {
    uri: MentionUri,
    content: Arc<str>,
    capture: Option<CaptureMetadata>,
    editor: Entity<Editor>,
    current: Option<Entity<Buffer>>,
    status: ReferenceStatus,
    workspace: WeakEntity<Workspace>,
    _load: Option<Task<()>>,
    _observe: Option<Subscription>,
}

impl ReferenceSnapshot {
    fn new(
        uri: MentionUri,
        content: Arc<str>,
        capture: Option<CaptureMetadata>,
        project: Entity<project::Project>,
        workspace: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let buffer = cx.new(|cx| Buffer::local(content.to_string(), cx));
        let editor = cx.new(|cx| {
            let mut editor = Editor::for_buffer(buffer, None, window, cx);
            editor.set_read_only(true);
            editor
        });
        let path = source(&uri).map(|(path, _)| path);
        let status = if path.is_some() {
            ReferenceStatus::Loading
        } else {
            ReferenceStatus::Captured
        };
        let load = path.map(|path| {
            let task = project.update(cx, |project, cx| {
                project
                    .find_project_path(&path, cx)
                    .map(|path| project.open_buffer(path, cx))
            });
            cx.spawn(async move |this, cx| {
                let current = match task {
                    Some(task) => task.await.ok(),
                    None => None,
                };
                this.update(cx, |this, cx| {
                    if let Some(current) = current {
                        this._observe = Some(cx.observe(&current, |this, _, cx| this.compare(cx)));
                        this.current = Some(current);
                        this.compare(cx);
                    } else {
                        this.status = ReferenceStatus::Unavailable;
                        cx.notify();
                    }
                })
                .ok();
            })
        });
        Self {
            uri,
            content,
            capture,
            editor,
            current: None,
            status,
            workspace,
            _load: load,
            _observe: None,
        }
    }

    fn compare(&mut self, cx: &mut Context<Self>) {
        if let Some(buffer) = &self.current {
            self.status = if self.capture.as_ref().is_some_and(|capture| capture.summary) {
                ReferenceStatus::Unverified
            } else {
                compare_reference(&self.uri, &self.content, &buffer.read(cx).text())
            };
        }
        cx.notify();
    }

    fn open_current(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Recheck at action time: the user may have edited the source while the
        // modal was open. Unknown locations open the file without a guessed row.
        self.compare(cx);
        let Some((path, _)) = source(&self.uri) else {
            return;
        };
        let point = self.status.point();
        let workspace = self.workspace.clone();
        cx.emit(DismissEvent);
        window.defer(cx, move |window, cx| {
            workspace
                .update(cx, |workspace, cx| {
                    crate::open_abs_path_at_point(workspace, path, point, window, cx);
                })
                .ok();
        });
    }
}

impl EventEmitter<DismissEvent> for ReferenceSnapshot {}
impl ModalView for ReferenceSnapshot {}
impl Focusable for ReferenceSnapshot {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.editor.focus_handle(cx)
    }
}

impl Render for ReferenceSnapshot {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let status_color = match self.status {
            ReferenceStatus::Current(_) => Color::Success,
            ReferenceStatus::Moved(_) | ReferenceStatus::Changed | ReferenceStatus::Ambiguous => {
                Color::Warning
            }
            _ => Color::Muted,
        };
        v_flex()
            .key_context("ReferenceSnapshot")
            .track_focus(&self.focus_handle(cx))
            .on_action(cx.listener(|_, _: &menu::Cancel, _, cx| cx.emit(DismissEvent)))
            .w(px(760.).min(window.viewport_size().width - px(40.)))
            .bg(cx.theme().colors().editor_background)
            .border_1()
            .border_color(cx.theme().colors().border)
            .rounded_lg()
            .overflow_hidden()
            .child(
                v_flex()
                    .p_4()
                    .gap_1()
                    .child(
                        h_flex()
                            .justify_between()
                            .child(Label::new("Reference Snapshot"))
                            .child(
                                IconButton::new("close-reference", IconName::Close)
                                    .on_click(cx.listener(|_, _, _, cx| cx.emit(DismissEvent))),
                            ),
                    )
                    .child(
                        Label::new(
                            source(&self.uri)
                                .map(|(path, point)| {
                                    point.map_or_else(
                                        || path.display().to_string(),
                                        |point| {
                                            format!(
                                                "{}:{}:{}",
                                                path.display(),
                                                point.row + 1,
                                                point.column + 1
                                            )
                                        },
                                    )
                                })
                                .unwrap_or_else(|| self.uri.name()),
                        )
                        .size(LabelSize::Small),
                    )
                    .when_some(self.capture.as_ref(), |this, capture| {
                        this.child(
                            Label::new(if capture.unsaved {
                                "Captured from unsaved editor content"
                            } else {
                                "Captured from saved editor content"
                            })
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                        )
                    })
                    .child(
                        Label::new(self.status.label())
                            .size(LabelSize::Small)
                            .color(status_color),
                    ),
            )
            .child(
                div()
                    .h(px(380.).min(window.viewport_size().height * 0.5))
                    .child(self.editor.clone()),
            )
            .child(
                h_flex()
                    .p_3()
                    .gap_2()
                    .justify_end()
                    .when(self.current.is_some(), |this| {
                        this.child(
                            Button::new(
                                "open-reference-source",
                                if self.status.point().is_some() {
                                    "Go to Current Content"
                                } else {
                                    "Open Current File"
                                },
                            )
                            .on_click(
                                cx.listener(|this, _, window, cx| this.open_current(window, cx)),
                            ),
                        )
                    })
                    .child(
                        Button::new("return-reference", "Back to Conversation")
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(DismissEvent))),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    async fn test_eido_reference_snapshot_observes_unsaved_source_without_replacing_capture(
        cx: &mut gpui::TestAppContext,
    ) {
        crate::test_support::init_test(cx);
        let fs = project::FakeFs::new(cx.executor());
        fs.insert_tree(
            "/reference",
            serde_json::json!({"sample.rs":"header\n函数();\n"}),
        )
        .await;
        let project = project::Project::test(fs, [std::path::Path::new("/reference")], cx).await;
        let (workspace, cx) = cx.add_window_view(|window, cx| {
            workspace::MultiWorkspace::test_new(project.clone(), window, cx)
        });
        let owner = workspace.read_with(cx, |workspace, _| workspace.workspace().downgrade());
        let uri = MentionUri::Selection {
            abs_path: Some(PathBuf::from("/reference/sample.rs")),
            line_range: 1..=1,
            column: None,
        };
        let snapshot = workspace.update_in(cx, |_, window, cx| {
            cx.new(|cx| {
                ReferenceSnapshot::new(
                    uri,
                    Arc::from("函数();\n"),
                    None,
                    project,
                    owner,
                    window,
                    cx,
                )
            })
        });
        cx.run_until_parked();
        let current = snapshot.read_with(cx, |snapshot, cx| {
            assert_eq!(snapshot.status, ReferenceStatus::Current(Point::new(1, 0)));
            assert!(snapshot.editor.read(cx).read_only(cx));
            snapshot.current.clone().unwrap()
        });
        current.update(cx, |buffer, cx| {
            buffer.edit([(0..0, "inserted\n")], None, cx)
        });
        cx.run_until_parked();
        snapshot.read_with(cx, |snapshot, cx| {
            assert_eq!(snapshot.status, ReferenceStatus::Moved(Point::new(2, 0)));
            assert_eq!(snapshot.editor.read(cx).text(cx), "函数();\n");
        });
        current.update(cx, |buffer, cx| {
            buffer.edit([(0..buffer.len(), "changed")], None, cx)
        });
        cx.run_until_parked();
        snapshot.read_with(cx, |snapshot, cx| {
            assert_eq!(snapshot.status, ReferenceStatus::Changed);
            assert_eq!(snapshot.editor.read(cx).text(cx), "函数();\n");
        });
    }

    #[test]
    fn test_eido_reference_mapping_requires_exact_unique_content() {
        let uri = MentionUri::Selection {
            abs_path: Some(PathBuf::from("/sample.rs")),
            line_range: 1..=1,
            column: Some(0),
        };
        assert_eq!(
            compare_reference(&uri, "函数();\n", "header\n函数();\n"),
            ReferenceStatus::Current(Point::new(1, 0))
        );
        assert_eq!(
            compare_reference(&uri, "函数();\n", "inserted\nheader\n函数();\n"),
            ReferenceStatus::Moved(Point::new(2, 0))
        );
        assert_eq!(
            compare_reference(&uri, "函数();\n", "函数();\n函数();\n"),
            ReferenceStatus::Ambiguous
        );
        assert_eq!(
            compare_reference(&uri, "函数();\n", "header\nchanged();\n"),
            ReferenceStatus::Changed
        );
        assert_eq!(
            compare_reference(&uri, "", "header"),
            ReferenceStatus::Unverified
        );
        assert_eq!(
            compare_reference(&uri, "aa", "aaa"),
            ReferenceStatus::Ambiguous
        );
        assert_eq!(
            compare_reference(&uri, "函数();\n", "头部函数();\n"),
            ReferenceStatus::Moved(Point::new(0, 6))
        );
    }

    #[test]
    fn test_eido_reference_file_snapshot_keeps_whitespace_and_summary_uncertainty() {
        let uri = MentionUri::File {
            abs_path: PathBuf::from("/sample.rs"),
        };
        assert_eq!(
            compare_reference(&uri, "text ", "text "),
            ReferenceStatus::Current(Point::new(0, 0))
        );
        assert_eq!(
            compare_reference(&uri, "text ", "text\n"),
            ReferenceStatus::Changed
        );
        assert_eq!(
            compare_reference(&uri, "# File outline for sample", "body"),
            ReferenceStatus::Unverified
        );
    }
}
