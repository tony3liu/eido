use anyhow::{Context as _, Result, bail};
use futures::StreamExt as _;
use gpui::{App, AppContext as _, AsyncApp, Entity, Task};
use language::{OffsetRangeExt as _, Point};
use project::{
    Project, SearchResults, WorktreeSettings,
    search::{SearchQuery, SearchResult},
};
use serde::{Deserialize, Serialize};
use settings::Settings as _;
use std::{
    collections::BTreeSet,
    path::{Component, Path, PathBuf},
};
use util::paths::PathMatcher;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EidoFileQuery {
    pub operation: String,
    pub path: PathBuf,
    pub pattern: Option<String>,
    pub glob: Option<String>,
    pub limit: Option<usize>,
    pub context: Option<u32>,
    pub ignore_case: Option<bool>,
    pub literal: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EidoFileQueryResult {
    pub output: String,
    pub truncated: bool,
}

const MAX_BYTES: usize = 50 * 1024;
const MAX_LINE: usize = 500;

pub fn allowed_path(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root).is_ok_and(|relative| {
        relative.components().all(|part| {
            !matches!(part, Component::ParentDir)
                && ![".git", ".local", ".pi"]
                    .iter()
                    .any(|name| part.as_os_str() == *name)
        })
    })
}

pub(super) fn visible_path(project: &Project, root: &Path, path: &Path, cx: &App) -> bool {
    if !allowed_path(root, path) {
        return false;
    }
    let Some(project_path) = project.project_path_for_absolute_path(path, cx) else {
        return false;
    };
    let settings = WorktreeSettings::get(Some((&project_path).into()), cx);
    if settings.is_path_excluded(&project_path.path) || settings.is_path_private(&project_path.path)
    {
        return false;
    }
    let Some(worktree) = project.worktree_for_id(project_path.worktree_id, cx) else {
        return false;
    };
    worktree
        .read(cx)
        .entry_for_path(&project_path.path)
        .is_none_or(|entry| {
            !entry.is_private
                && !entry.is_external
                && entry
                    .canonical_path
                    .as_ref()
                    .is_none_or(|canonical| allowed_path(root, canonical))
        })
}

fn append_line(result: &mut EidoFileQueryResult, line: &str) -> bool {
    if result.output.len() + line.len() + 1 > MAX_BYTES {
        result.truncated = true;
        return false;
    }
    if !result.output.is_empty() {
        result.output.push('\n');
    }
    result.output.push_str(line);
    true
}

fn finish(mut result: EidoFileQueryResult, empty: &str) -> EidoFileQueryResult {
    if result.output.is_empty() {
        result.output.push_str(empty);
    }
    if result.truncated {
        result.output.push_str("\n\n[Results truncated. Narrow the path or pattern, or increase limit (maximum 1000).]");
    }
    result
}

// Escape path characters before using them as literal components of a search glob.
fn escape_glob(path: &str) -> String {
    path.chars()
        .map(|ch| match ch {
            '*' => "[*]".into(),
            '?' => "[?]".into(),
            '[' => "[[]".into(),
            ']' => "[]]".into(),
            '{' => "[{]".into(),
            '}' => "[}]".into(),
            ch => ch.to_string(),
        })
        .collect()
}

/// Resolve new editor paths without creating directories or following dangling links.
pub async fn canonical_editor_path(fs: &dyn project::Fs, path: &Path) -> Result<PathBuf> {
    let mut ancestor = path.to_owned();
    let mut suffix = Vec::new();
    loop {
        match fs.canonicalize(&ancestor).await {
            Ok(mut canonical) => {
                for part in suffix.into_iter().rev() {
                    canonical.push(part);
                }
                return Ok(canonical);
            }
            Err(error) => {
                if fs.metadata(&ancestor).await?.is_some() {
                    return Err(error);
                }
                if fs.read_link(&ancestor).await.is_ok() {
                    bail!("Dangling symlinks are not available to file tools");
                }
                suffix.push(
                    ancestor
                        .file_name()
                        .context("Path has no existing ancestor")?
                        .to_owned(),
                );
                ancestor = ancestor
                    .parent()
                    .context("Path has no existing ancestor")?
                    .to_owned();
            }
        }
    }
}

/// Queries are observations: they never authorize a later write or record an edit.
/// Dropping this task drops the native search handle and cancels its work.
pub fn eido_file_query(
    project: Entity<Project>,
    root: PathBuf,
    args: EidoFileQuery,
    cx: &mut App,
) -> Task<Result<EidoFileQueryResult>> {
    cx.spawn(async move |cx: &mut AsyncApp| {
        if !["find", "grep", "ls"].contains(&args.operation.as_str()) {
            bail!("Unknown file query");
        }
        let limit = args
            .limit
            .unwrap_or(if args.operation == "grep" { 100 } else { 500 });
        if !(1..=1000).contains(&limit) {
            bail!("limit must be between 1 and 1000");
        }
        let context = args.context.unwrap_or(0);
        if context > 20 {
            bail!("context must be between 0 and 20");
        }
        if !args.path.is_absolute() || !allowed_path(&root, &args.path) {
            bail!("File is outside this workspace or in private storage");
        }
        let fs = project.read_with(cx, |project, _| project.fs().clone());
        let canonical_root = fs.canonicalize(&root).await?;
        let canonical = canonical_editor_path(fs.as_ref(), &args.path).await?;
        if !allowed_path(&canonical_root, &canonical) {
            bail!("File is outside this workspace or in private storage");
        }
        let metadata = fs.metadata(&args.path).await?;
        let new_paths = project.read_with(cx, |project, cx| {
            project
                .opened_buffers(cx)
                .iter()
                .filter_map(|buffer| {
                    let buffer = buffer.read(cx);
                    let file = buffer.file()?;
                    if file.disk_state() != language::DiskState::New {
                        return None;
                    }
                    let path = project.absolute_path(
                        &project::ProjectPath {
                            worktree_id: file.worktree_id(cx),
                            path: file.path().clone(),
                        },
                        cx,
                    )?;
                    visible_path(project, &root, &path, cx).then_some(path)
                })
                .collect::<Vec<_>>()
        });
        let is_new_file = new_paths.contains(&args.path);
        let is_dir = metadata
            .as_ref()
            .map(|metadata| metadata.is_dir)
            .unwrap_or_else(|| {
                !is_new_file && new_paths.iter().any(|path| path.starts_with(&args.path))
            });
        if metadata.is_none() && !is_new_file && !is_dir {
            bail!("Path not found");
        }
        if !project.read_with(cx, |project, cx| {
            visible_path(project, &root, &args.path, cx)
        }) {
            bail!("Path is excluded from file tools");
        }
        let mut result = EidoFileQueryResult {
            output: String::new(),
            truncated: false,
        };
        if args.operation == "ls" {
            if !is_dir {
                bail!("Not a directory");
            }
            let entries = if metadata.is_some() {
                project
                    .update(cx, |project, cx| {
                        project.list_directory(args.path.to_string_lossy().into_owned(), cx)
                    })
                    .await?
            } else {
                Vec::new()
            };
            let mut lines = Vec::new();
            for mut entry in entries {
                entry.path = args.path.join(entry.path);
                if !project.read_with(cx, |project, cx| {
                    visible_path(project, &root, &entry.path, cx)
                }) {
                    continue;
                }
                let Ok(canonical) = fs.canonicalize(&entry.path).await else {
                    continue;
                };
                if !allowed_path(&canonical_root, &canonical) {
                    continue;
                }
                let Some(name) = entry.path.file_name() else {
                    continue;
                };
                lines.push(format!(
                    "{}{}",
                    name.to_string_lossy(),
                    if entry.is_dir { "/" } else { "" }
                ));
            }
            for path in &new_paths {
                let Ok(relative) = path.strip_prefix(&args.path) else {
                    continue;
                };
                let mut components = relative.components();
                let Some(first) = components.next() else {
                    continue;
                };
                lines.push(format!(
                    "{}{}",
                    first.as_os_str().to_string_lossy(),
                    if components.next().is_some() { "/" } else { "" }
                ));
            }
            lines.sort_by_key(|line| line.to_lowercase());
            lines.dedup();
            result.truncated = lines.len() > limit;
            for line in lines.into_iter().take(limit) {
                if !append_line(&mut result, &line) {
                    break;
                }
            }
            return Ok(finish(result, "(empty directory)"));
        }
        if args.operation == "find" {
            if !is_dir {
                bail!("Not a directory");
            }
            let pattern = args.pattern.as_deref().context("Missing find pattern")?;
            let matcher = project.read_with(cx, |project, cx| {
                PathMatcher::new([pattern], project.path_style(cx))
            })?;
            let scans = project.read_with(cx, |project, cx| {
                project
                    .worktrees(cx)
                    .filter_map(|tree| tree.read(cx).as_local().map(|tree| tree.scan_complete()))
                    .collect::<Vec<_>>()
            });
            for scan in scans {
                scan.await;
            }
            let snapshots = project.read_with(cx, |project, cx| {
                project
                    .worktrees(cx)
                    .map(|tree| tree.read(cx).snapshot())
                    .collect::<Vec<_>>()
            });
            let search_path = args.path.clone();
            let root_path = root.clone();
            let candidates = cx
                .background_spawn(async move {
                    let mut paths = new_paths
                        .into_iter()
                        .filter(|path| {
                            path.strip_prefix(&search_path)
                                .is_ok_and(|relative| matcher.is_match_std_path(relative))
                        })
                        .collect::<Vec<_>>();
                    'trees: for snapshot in snapshots {
                        for entry in snapshot.entries(false, 0) {
                            if entry.is_dir() || entry.is_private || entry.is_external {
                                continue;
                            }
                            let path = snapshot.absolutize(&entry.path);
                            if !allowed_path(&root_path, &path)
                                || entry
                                    .canonical_path
                                    .as_ref()
                                    .is_some_and(|path| !allowed_path(&root_path, path))
                            {
                                continue;
                            }
                            let Ok(relative) = path.strip_prefix(&search_path) else {
                                continue;
                            };
                            if matcher.is_match_std_path(relative) {
                                paths.push(path);
                                if paths.len() > limit {
                                    break 'trees;
                                }
                            }
                        }
                    }
                    paths.sort();
                    paths.dedup();
                    paths
                })
                .await;
            let mut count = 0;
            for path in candidates {
                if !project.read_with(cx, |project, cx| visible_path(project, &root, &path, cx)) {
                    continue;
                }
                if count == limit {
                    result.truncated = true;
                    break;
                }
                if !append_line(
                    &mut result,
                    &path.strip_prefix(&args.path)?.to_string_lossy(),
                ) {
                    break;
                }
                count += 1;
            }
            return Ok(finish(result, "No files found matching pattern"));
        }
        let pattern = args.pattern.as_deref().context("Missing search pattern")?;
        if pattern.is_empty() {
            bail!("Search pattern must not be empty");
        }
        let (scope, style) = project.read_with(cx, |project, cx| {
            let path = project
                .project_path_for_absolute_path(&args.path, cx)
                .context("Path is not in the project")?;
            let tree = project
                .worktree_for_id(path.worktree_id, cx)
                .context("Worktree is unavailable")?;
            let full_path = tree.read(cx).snapshot().root_name().join(&path.path);
            anyhow::Ok((escape_glob(&full_path.to_string()), project.path_style(cx)))
        })?;
        let include = if is_dir {
            PathMatcher::new([format!("{scope}/**")], style)?
        } else {
            PathMatcher::default()
        };
        let exclude = PathMatcher::new(["**/.git/**", "**/.local/**", "**/.pi/**"], style)?;
        let file_glob = args
            .glob
            .as_ref()
            .map(|glob| PathMatcher::new([glob], style))
            .transpose()?;
        let buffers = if is_dir {
            None
        } else {
            let load = project.update(cx, |project, cx| {
                let path = project
                    .project_path_for_absolute_path(&args.path, cx)
                    .context("Path is not in the project")?;
                anyhow::Ok(project.open_buffer(path, cx))
            })?;
            Some(vec![load.await?])
        };
        let query = if args.literal.unwrap_or(false) {
            SearchQuery::text(
                pattern,
                false,
                !args.ignore_case.unwrap_or(false),
                !is_dir,
                include,
                exclude,
                is_dir,
                buffers,
            )?
        } else {
            SearchQuery::regex(
                pattern,
                false,
                !args.ignore_case.unwrap_or(false),
                !is_dir,
                true,
                include,
                exclude,
                is_dir,
                buffers,
            )?
        };
        let SearchResults {
            rx,
            task_handle: _search,
        } = project.update(cx, |project, cx| project.search(query.clone(), cx));
        futures::pin_mut!(rx);
        let mut count = 0;
        while let Some(found) = rx.next().await {
            let buffer = match found {
                SearchResult::Buffer { buffer, .. } => buffer,
                SearchResult::LimitReached => {
                    result.truncated = true;
                    break;
                }
                _ => continue,
            };
            let Some(project_path) = buffer.read_with(cx, |buffer, cx| {
                buffer.file().map(|file| project::ProjectPath {
                    worktree_id: file.worktree_id(cx),
                    path: file.path().clone(),
                })
            }) else {
                continue;
            };
            let Some(path) =
                project.read_with(cx, |project, cx| project.absolute_path(&project_path, cx))
            else {
                continue;
            };
            if !path.starts_with(&args.path) || (!is_dir && path.as_path() != args.path.as_path()) {
                continue;
            }
            if !project.read_with(cx, |project, cx| visible_path(project, &root, &path, cx)) {
                continue;
            }
            let canonical = canonical_editor_path(fs.as_ref(), &path).await?;
            if !allowed_path(&canonical_root, &canonical) {
                continue;
            }
            let relative = if is_dir {
                path.strip_prefix(&args.path)?
            } else {
                Path::new(path.file_name().context("Missing filename")?)
            };
            if file_glob
                .as_ref()
                .is_some_and(|glob| !glob.is_match_std_path(relative))
            {
                continue;
            }
            let snapshot = buffer.read_with(cx, |buffer, _| buffer.snapshot());
            // A buffer can change while filesystem validation is awaiting. Match
            // and format the same immutable snapshot, never old match positions.
            let query = query.clone();
            let (snapshot, ranges) = cx
                .background_spawn(async move {
                    let ranges = query.search(&snapshot, None).await;
                    (snapshot, ranges)
                })
                .await;
            let rows: BTreeSet<_> = ranges
                .iter()
                .map(|range| range.to_point(&snapshot).start.row)
                .collect();
            for row in rows {
                if count == limit {
                    result.truncated = true;
                    break;
                }
                for current in row.saturating_sub(context)
                    ..=row.saturating_add(context).min(snapshot.max_point().row)
                {
                    let text = snapshot
                        .text_for_range(
                            Point::new(current, 0)..Point::new(current, snapshot.line_len(current)),
                        )
                        .collect::<String>();
                    let clipped: String = text.chars().take(MAX_LINE).collect();
                    let separator = if current == row { ":" } else { "-" };
                    let line = format!(
                        "{}{separator}{}{separator} {}{}",
                        relative.display(),
                        current + 1,
                        clipped,
                        if text.chars().count() > MAX_LINE {
                            " [line truncated]"
                        } else {
                            ""
                        }
                    );
                    if !append_line(&mut result, &line) {
                        break;
                    }
                }
                count += 1;
                if result.truncated {
                    break;
                }
            }
            if result.truncated {
                break;
            }
        }
        Ok(finish(result, "No matches found"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use project::FakeFs;
    use serde_json::json;
    use settings::SettingsStore;

    fn args(operation: &str, path: &str, pattern: &str) -> EidoFileQuery {
        EidoFileQuery {
            operation: operation.into(),
            path: path.into(),
            pattern: Some(pattern.into()),
            glob: None,
            limit: None,
            context: None,
            ignore_case: None,
            literal: None,
        }
    }

    #[gpui::test]
    async fn test_eido_file_queries_observe_unsaved_buffers_and_bound_results(
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| {
            let store = SettingsStore::test(cx);
            cx.set_global(store);
        });
        let fs = FakeFs::new(cx.executor());
        fs.insert_tree("/workspace", json!({
            ".gitignore":"ignored.ts\n", ".git":{}, ".local":{"secret.ts":"needle"}, ".pi":{"secret.ts":"needle"},
            "src":{"a.ts":"disk\n","b.ts":"needle\n","c.js":"needle\n"},"ignored.ts":"needle\n"
        })).await;
        fs.insert_tree("/other", json!({"outside.ts":"needle\n"}))
            .await;
        fs.insert_symlink("/workspace/leak", PathBuf::from("/other"))
            .await;
        let project = Project::test(
            fs.clone(),
            [Path::new("/workspace"), Path::new("/other")],
            cx,
        )
        .await;
        let buffer = project
            .update(cx, |project, cx| {
                let path = project
                    .project_path_for_absolute_path(Path::new("/workspace/src/a.ts"), cx)
                    .unwrap();
                project.open_buffer(path, cx)
            })
            .await
            .unwrap();
        buffer.update(cx, |buffer, cx| {
            let len = buffer.len();
            buffer.edit([(0..len, "before\nUnSaVeD needle\nafter\n")], None, cx);
        });
        let mut query = args("grep", "/workspace/src", "unsaved");
        query.ignore_case = Some(true);
        query.context = Some(1);
        query.glob = Some("*.ts".into());
        let result = cx
            .update(|cx| eido_file_query(project.clone(), "/workspace".into(), query, cx))
            .await
            .unwrap();
        assert_eq!(
            result.output,
            "a.ts-1- before\na.ts:2: UnSaVeD needle\na.ts-3- after"
        );
        assert!(!result.truncated);
        let result = cx
            .update(|cx| {
                eido_file_query(
                    project.clone(),
                    "/workspace".into(),
                    args("grep", "/workspace/src/a.ts", "disk"),
                    cx,
                )
            })
            .await
            .unwrap();
        assert_eq!(result.output, "No matches found");
        let result = cx
            .update(|cx| {
                eido_file_query(
                    project.clone(),
                    "/workspace".into(),
                    args("grep", "/workspace", "needle"),
                    cx,
                )
            })
            .await
            .unwrap();
        assert!(result.output.contains("src/a.ts:2: UnSaVeD needle"));
        assert!(
            !result.output.contains("secret")
                && !result.output.contains("outside")
                && !result.output.contains("ignored")
        );
        let result = cx
            .update(|cx| {
                eido_file_query(
                    project.clone(),
                    "/workspace".into(),
                    args("grep", "/workspace/ignored.ts", "needle"),
                    cx,
                )
            })
            .await
            .unwrap();
        assert_eq!(result.output, "ignored.ts:1: needle");
        let result = cx
            .update(|cx| {
                eido_file_query(
                    project.clone(),
                    "/workspace".into(),
                    args("find", "/workspace", "**/*.ts"),
                    cx,
                )
            })
            .await
            .unwrap();
        assert_eq!(result.output, "src/a.ts\nsrc/b.ts");
        let result = cx
            .update(|cx| {
                eido_file_query(
                    project.clone(),
                    "/workspace".into(),
                    args("ls", "/workspace", ""),
                    cx,
                )
            })
            .await
            .unwrap();
        assert!(result.output.contains("src/") && result.output.contains(".gitignore"));
        assert!(
            !result.output.contains(".local")
                && !result.output.contains(".pi")
                && !result.output.contains("leak")
        );
        let mut query = args("grep", "/workspace/src", "needle");
        query.limit = Some(1);
        let result = cx
            .update(|cx| eido_file_query(project.clone(), "/workspace".into(), query, cx))
            .await
            .unwrap();
        assert!(result.truncated);
        assert_eq!(
            result
                .output
                .lines()
                .filter(|line| line.contains(": "))
                .count(),
            1
        );
        assert_eq!(
            String::from_utf8(fs.read_file_sync("/workspace/src/a.ts").unwrap()).unwrap(),
            "disk\n"
        );
        assert!(buffer.read_with(cx, |buffer, _| buffer.is_dirty()));
        for path in [
            "/other",
            "/workspace/.local",
            "/workspace/leak",
            "/workspace/../other",
        ] {
            assert!(
                cx.update(|cx| eido_file_query(
                    project.clone(),
                    "/workspace".into(),
                    args("grep", path, "needle"),
                    cx
                ))
                .await
                .is_err()
            );
        }
        for (pattern, limit) in [("[", 1), ("needle", 0), ("needle", 1001)] {
            let mut query = args("grep", "/workspace", pattern);
            query.limit = Some(limit);
            assert!(
                cx.update(|cx| eido_file_query(project.clone(), "/workspace".into(), query, cx))
                    .await
                    .is_err()
            );
        }
    }
}
