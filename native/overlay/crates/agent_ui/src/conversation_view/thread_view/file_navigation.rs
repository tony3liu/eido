//! Navigation for file tools. Tool output stays in the transcript data, while
//! reading and reviewing use the existing native editor surfaces.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

struct FileActivityInput {
    base: Option<PathBuf>,
    read: Option<(u32, u32)>,
    output: String,
    label: String,
}

#[derive(Default)]
struct FileActivityRanges {
    reads: Vec<std::ops::Range<u32>>,
    matches: BTreeSet<u32>,
    original: Vec<String>,
}

fn tool_output(tool: &ToolCall, cx: &App) -> String {
    tool.content.iter().filter_map(|content| match content {
        ToolCallContent::ContentBlock(acp_thread::ContentBlock::Markdown { markdown }) => Some(markdown.read(cx).source().to_string()),
        _ => None,
    }).collect::<Vec<_>>().join("\n")
}


fn tool_name<'a>(tool: &'a ToolCall, cx: &'a App) -> &'a str {
    tool.tool_name.as_deref().unwrap_or_else(|| tool.label.read(cx).source().trim())
}

/// Pi emits matches as `path:line: text` and context as `path-line- text`.
/// Never interpret arbitrary Markdown or accept a path outside the search root.
fn grep_line(line: &str, separator: char) -> Option<(&str, u32)> {
    for (index, _) in line.match_indices(separator) {
        let path = &line[..index];
        let rest = &line[index + separator.len_utf8()..];
        let (number, text) = rest.split_once(separator)?;
        if !text.starts_with(' ') || number.is_empty() || !number.bytes().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let row = number.parse::<u32>().ok()?.checked_sub(1)?;
        let path_ref = Path::new(path);
        if path.is_empty() || path_ref.is_absolute()
            || path_ref.components().any(|part| matches!(part, std::path::Component::ParentDir))
        { return None; }
        return Some((path, row));
    }
    None
}

fn grep_matches(output: &str) -> Option<(BTreeMap<PathBuf, Vec<u32>>, String)> {
    let mut files: BTreeMap<PathBuf, Vec<u32>> = BTreeMap::new();
    let mut count = 0;
    let mut remainder = Vec::new();
    for line in output.lines().filter(|line| !line.is_empty() && *line != "--") {
        if let Some((path, row)) = grep_line(line, ':') {
            count += 1;
            if count > 1000 { return None; }
            files.entry(path.into()).or_default().push(row);
        } else if grep_line(line, '-').is_none() {
            // Keep notices and other output alongside the navigable matches.
            remainder.push(line);
        }
    }
    if files.is_empty() { return None; }
    for rows in files.values_mut() { rows.sort_unstable(); rows.dedup(); }
    Some((files, remainder.join("\n")))
}

impl ThreadView {
    pub(super) fn eido_file_tool(&self, tool: &ToolCall, cx: &App) -> bool {
        if self.agent_id.as_ref() != "eido-pi" || !matches!(tool.status,
            ToolCallStatus::Pending | ToolCallStatus::InProgress | ToolCallStatus::Completed)
        { return false; }
        let name = tool_name(tool, cx);
        (name == "read" && tool.locations.len() == 1
            && !tool.content.iter().any(|content| matches!(content,
                ToolCallContent::ContentBlock(block) if block.image().is_some())))
            || (name == "grep" && tool.raw_input.as_ref().and_then(|input| input.get("pattern")).and_then(|v| v.as_str()).is_some())
            || tool.diffs().next().is_some()
            || (matches!(tool.kind, acp::ToolKind::Edit | acp::ToolKind::Delete | acp::ToolKind::Move)
                && !tool.locations.is_empty())
    }

    pub(super) fn open_file_tool(&mut self, entry_ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(AgentThreadEntry::ToolCall(tool)) = self.thread.read(cx).entries().get(entry_ix) else { return; };
        if !self.eido_file_tool(tool, cx) { return; }
        let name = tool_name(tool, cx);
        if name == "grep" {
            let output = tool_output(tool, cx);
            let pattern = tool.raw_input.as_ref().and_then(|input| input.get("pattern")).and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let base = tool.locations.first().map(|location| location.path.clone())
                .or_else(|| self.thread.read(cx).work_dirs().and_then(|dirs| dirs.ordered_paths().next()).cloned());
            self.open_grep_results(base, output, pattern, window, cx);
        } else if name == "read" {
            self.open_tool_call_location(entry_ix, 0, window, cx);
        } else {
            let buffer = tool.diffs().next().map(|diff| diff.read(cx).buffer().clone());
            self.reveal_file_tools(cx);
            if let Some(pane) = AgentDiffPane::deploy(self.thread.clone(), self.workspace.clone(), window, cx).log_err()
                && let Some(buffer) = buffer
            {
                let key = PathKey::for_buffer(&buffer, cx);
                pane.update(cx, |pane, cx| pane.move_to_path(key, window, cx));
            }
        }
    }

    fn reveal_file_tools(&self, cx: &mut Context<Self>) {
        self.workspace.update(cx, |workspace, cx| {
            let layout = match workspace.eido_layout() {
                workspace::EidoLayout::Workbench => workspace::EidoLayout::Split,
                layout => layout,
            };
            workspace.set_eido_layout(layout, cx);
        }).log_err();
    }

    /// Combine successful reads and searches from one activity group. The
    /// native multibuffer groups by file and merges overlapping excerpt ranges.
    pub(super) fn open_file_activity(&mut self, first: usize, end: usize,
        window: &mut Window, cx: &mut Context<Self>)
    {
        let thread = self.thread.read(cx);
        let default_base = thread.work_dirs().and_then(|dirs| dirs.ordered_paths().next()).cloned();
        let mut inputs = Vec::new();
        for entry in thread.entries().iter().take(end).skip(first) {
            let AgentThreadEntry::ToolCall(tool) = entry else { continue; };
            if !matches!(tool.status, ToolCallStatus::Completed) || !self.eido_file_tool(tool, cx) { continue; }
            let name = tool_name(tool, cx);
            if name != "read" && name != "grep" { continue; }
            let output = tool_output(tool, cx);
            let base = tool.locations.first().map(|location| location.path.clone()).or_else(|| default_base.clone());
            let read = if name == "read" {
                if tool.locations.len() != 1 { continue; }
                let row = tool.raw_input.as_ref().and_then(|input| input.get("offset"))
                    .and_then(|value| value.as_u64()).and_then(|value| u32::try_from(value).ok())
                    .map(|row| row.saturating_sub(1))
                    .or_else(|| tool.locations[0].line).unwrap_or(0);
                let output_rows = u32::try_from(output.lines().count()).unwrap_or(u32::MAX).max(1);
                let count = tool.raw_input.as_ref().and_then(|input| input.get("limit"))
                    .and_then(|value| value.as_u64()).and_then(|value| u32::try_from(value).ok())
                    .map(|limit| limit.min(output_rows).max(1)).unwrap_or(output_rows);
                Some((row, count))
            } else { None };
            let label = if name == "grep" {
                let pattern = tool.raw_input.as_ref().and_then(|input| input.get("pattern"))
                    .and_then(|value| value.as_str()).unwrap_or_default();
                format!("grep · {}", util::truncate_and_trailoff(pattern, 80))
            } else { format!("read · {}", tool.locations[0].path.display()) };
            inputs.push(FileActivityInput { base, read, output, label });
        }
        self.open_file_inputs(inputs, eido_i18n::tr(cx, "workbench.files").to_string(), window, cx);
    }

    fn open_grep_results(&mut self, base: Option<PathBuf>, output: String, pattern: String,
        window: &mut Window, cx: &mut Context<Self>)
    {
        let title = format!("grep · {}", util::truncate_and_trailoff(&pattern, 80));
        self.open_file_inputs(vec![FileActivityInput { base, read: None, output, label: title.clone() }], title, window, cx);
    }

    fn open_file_inputs(&mut self, inputs: Vec<FileActivityInput>, title: String,
        window: &mut Window, cx: &mut Context<Self>)
    {
        let Some(project) = self.project.upgrade() else { return; };
        let fs = project.read(cx).fs().clone();
        self.reveal_file_tools(cx);
        cx.spawn_in(window, async move |this, cx| {
            let mut files: BTreeMap<PathBuf, FileActivityRanges> = BTreeMap::new();
            let mut notes = Vec::new();
            let mut base_kinds = BTreeMap::new();
            for input in inputs {
                let original = format!("{}\n{}", input.label, input.output);
                let Some(base) = input.base else { notes.push(original); continue; };
                if let Some((row, count)) = input.read {
                    let file = files.entry(base.components().collect()).or_default();
                    file.reads.push(row..row.saturating_add(count));
                    file.original.push(original);
                    continue;
                }
                let Some((matches, remainder)) = grep_matches(&input.output) else { notes.push(original); continue; };
                let open_base = project.read_with(cx, |project, cx| {
                    project.find_project_path(&base, cx).and_then(|path| project.get_open_buffer(&path, cx))
                });
                let is_dir = if let Some(is_dir) = base_kinds.get(&base) { *is_dir } else if open_base.is_some() {
                    base_kinds.insert(base.clone(), false);
                    false
                } else {
                    match fs.metadata(&base).await {
                        Ok(Some(metadata)) => { base_kinds.insert(base.clone(), metadata.is_dir); metadata.is_dir }
                        result => { notes.push(format!("{}\n{:?}", original, result)); continue; }
                    }
                };
                if !remainder.is_empty() { notes.push(format!("{}\n{}", input.label, remainder)); }
                for (relative, rows) in matches {
                    let path = if is_dir { base.join(relative) } else {
                        if base.file_name() != relative.file_name() || relative.components().count() != 1 {
                            notes.push(original.clone()); continue;
                        }
                        base.clone()
                    };
                    let file = files.entry(path.components().collect()).or_default();
                    file.matches.extend(rows);
                    file.original.push(original.clone());
                }
            }
            let mut buffers = Vec::new();
            for (path, mut ranges) in files {
                let loaded: Result<Entity<Buffer>> = async {
                    // Native tools can create and edit buffers before a file
                    // exists on disk; use those contents before filesystem I/O.
                    if let Some(buffer) = project.read_with(cx, |project, cx| {
                        project.find_project_path(&path, cx).and_then(|path| project.get_open_buffer(&path, cx))
                    }) { return Ok(buffer); }
                    let metadata = fs.metadata(&path).await?.ok_or_else(|| anyhow!("{}: file unavailable", path.display()))?;
                    if metadata.is_dir { return Err(anyhow!("{}: directory", path.display())); }
                    let (worktree, relative) = project.update(cx, |project, cx| project.find_or_create_worktree(&path, false, cx)).await?;
                    let project_path = ProjectPath { worktree_id: worktree.read_with(cx, |worktree, _| worktree.id()), path: relative };
                    project.update(cx, |project, cx| project.open_buffer(project_path, cx)).await
                }.await;
                match loaded {
                    Ok(buffer) => {
                        ranges.reads.sort_unstable_by_key(|range| (range.start, range.end));
                        ranges.reads.dedup();
                        let valid = buffer.read_with(cx, |buffer, _| {
                            let max = buffer.snapshot().max_point().row;
                            ranges.reads.iter().all(|range| range.start <= max) && ranges.matches.iter().all(|row| *row <= max)
                        });
                        if valid { buffers.push((buffer, ranges)); }
                        else { ranges.original.sort(); ranges.original.dedup(); notes.push(ranges.original.join("\n\n")); }
                    }
                    Err(error) => { ranges.original.sort(); ranges.original.dedup(); notes.push(format!("{}\n\n{}", error, ranges.original.join("\n\n"))); }
                }
            }
            notes.dedup();
            this.update_in(cx, |this, window, cx| {
                let mut matched_lines = Vec::new();
                let mut read_starts = Vec::new();
                let multibuffer = cx.new(|cx| {
                    let mut multibuffer = MultiBuffer::new(project.read(cx).capability());
                    for (buffer, file) in buffers {
                        let snapshot = buffer.read(cx).snapshot();
                        let max_row = snapshot.max_point().row;
                        let mut ranges: Vec<_> = file.reads.into_iter().map(|rows| {
                            let end = rows.end.saturating_sub(1).min(max_row);
                            let range = Point::new(rows.start, 0)..Point::new(end, snapshot.line_len(end));
                            read_starts.push((buffer.clone(), range.start));
                            range
                        }).collect();
                        for row in file.matches {
                            let range = Point::new(row, 0)..Point::new(row, snapshot.line_len(row));
                            matched_lines.push((buffer.clone(), range.clone()));
                            ranges.push(range);
                        }
                        ranges.sort_unstable_by_key(|range| (range.start, range.end));
                        ranges.dedup();
                        multibuffer.set_excerpts_for_buffer(buffer, ranges, 2, cx);
                    }
                    if !notes.is_empty() {
                        let notes = cx.new(|cx| Buffer::local(notes.join("\n\n"), cx));
                        let end = notes.read(cx).snapshot().max_point();
                        multibuffer.set_excerpts_for_buffer(notes, [Point::new(0, 0)..end], 0, cx);
                    }
                    multibuffer.set_title(title, cx);
                    multibuffer
                });
                let editor = cx.new(|cx| {
                    let highlights: Vec<_> = matched_lines.into_iter().filter_map(|(buffer, range)| {
                        let multibuffer = multibuffer.read(cx);
                        Some(multibuffer.buffer_point_to_anchor(&buffer, range.start, cx)?
                            ..multibuffer.buffer_point_to_anchor(&buffer, range.end, cx)?)
                    }).collect();
                    let first = highlights.first().map(|range| range.start).or_else(|| {
                        read_starts.into_iter().find_map(|(buffer, point)| multibuffer.read(cx).buffer_point_to_anchor(&buffer, point, cx))
                    });
                    let mut editor = Editor::for_multibuffer(multibuffer, Some(project), window, cx);
                    editor.set_read_only(true);
                    editor.highlight_background(editor::HighlightKey::ProjectSearchView, &highlights,
                        |_, theme| theme.colors().search_match_background, cx);
                    if let Some(first) = first {
                        editor.change_selections(Default::default(), window, cx, |selections| {
                            selections.select_anchor_ranges([first..first]);
                        });
                    }
                    editor
                });
                this.workspace.update(cx, |workspace, cx| {
                    workspace.add_item_to_active_pane(Box::new(editor), None, true, window, cx);
                }).log_err();
            })?;
            anyhow::Ok(())
        }).detach_and_log_err(cx);
    }
}

#[test]
fn test_eido_file_navigation_grep_parsing_preserves_boundaries() {
    let (parsed, remainder) = grep_matches("src/a.rs:2: fn main() {}\nsrc/a.rs-3- context\n研究 100%.rs:11: text\nsrc/a.rs:2: duplicate").unwrap();
    assert!(remainder.is_empty());
    assert_eq!(parsed[Path::new("src/a.rs")], vec![1]);
    assert_eq!(parsed[Path::new("研究 100%.rs")], vec![10]);
    assert_eq!(grep_line("dir/file:name.rs:2: text", ':'), Some(("dir/file:name.rs", 1)));
    let (limited, notice) = grep_matches("file.rs:3: value\n[100 matches limit reached]").unwrap();
    assert_eq!(limited[Path::new("file.rs")], vec![2]);
    assert_eq!(notice, "[100 matches limit reached]");
    for output in ["No matches found", "../private.rs:2: value", "/tmp/file.rs:1: value", "file.rs:0: value", "ordinary prose"] {
        assert!(grep_matches(output).is_none(), "retain original: {output}");
    }
}
