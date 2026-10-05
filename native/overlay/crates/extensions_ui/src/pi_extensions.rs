use std::{io::Write, process::{Command, Stdio}};

use serde_json::{Value, json};
use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ExtensionSource { Editor, Pi, Mcp, Skills }

impl ExtensionSource {
    pub const ALL: [Self; 4] = [Self::Editor, Self::Pi, Self::Mcp, Self::Skills];
    pub fn label(self) -> &'static str {
        match self { Self::Editor => "Editor Extensions", Self::Pi => "pi Plugins", Self::Mcp => "MCP", Self::Skills => "Skills" }
    }
    pub fn searchable(self) -> bool { matches!(self, Self::Editor | Self::Pi) }
}

pub(super) struct PiExtensionsState {
    data: Value,
    results: Vec<Value>,
    loaded: bool,
    busy: bool,
    searching: bool,
    search_error: Option<String>,
    searched_query: Option<String>,
    pub(super) management_focus: gpui::FocusHandle,
    search_generation: u64,
    search_task: Option<Task<()>>,
    editor_query: String,
    query: String,
    package_input: Entity<Editor>,
    installing: bool,
    mcp_editor: Entity<Editor>,
    editing_mcp: bool,
    mcp_revision: String,
    notice: String,
    failed: bool,
}

impl PiExtensionsState {
    pub fn new(window: &mut Window, cx: &mut Context<ExtensionsPage>) -> Self {
        Self {
            data: json!({}), results: vec![], loaded: false, busy: false, searching: false,
            search_error: None, searched_query: None, management_focus: cx.focus_handle(),
            search_generation: 0, search_task: None, editor_query: String::new(), query: String::new(),
            package_input: cx.new(|cx| {
                let mut editor = Editor::single_line(window, cx);
                editor.set_placeholder_text("npm package name or absolute local package folder", window, cx);
                editor
            }),
            installing: false, mcp_editor: cx.new(|cx| Editor::auto_height(4, 10, window, cx)),
            editing_mcp: false, mcp_revision: String::new(), notice: String::new(), failed: false,
        }
    }

    fn finish_search(&mut self, generation: u64, result: Result<Value, String>) {
        if generation != self.search_generation { return; }
        self.searching = false;
        match result {
            Ok(data) => { self.results = array(&data, "results"); self.search_error = None; self.searched_query = Some(self.query.clone()); }
            Err(error) => self.search_error = Some(error),
        }
    }
}

fn string(value: &Value, key: &str) -> String { value[key].as_str().unwrap_or_default().to_owned() }
fn array(value: &Value, key: &str) -> Vec<Value> { value[key].as_array().cloned().unwrap_or_default() }

fn run_pi_request(request: Value) -> Result<Value, String> {
    let root = std::env::var_os("EIDO_ROOT").ok_or("Eido runtime directory is unavailable.")?;
    let node = std::env::var_os("EIDO_NODE").ok_or("Eido Node.js runtime is unavailable.")?;
    let root = std::path::PathBuf::from(root);
    let mut child = Command::new(node).arg(root.join("scripts/pi-extensions.mjs")).current_dir(root)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
        .map_err(|_| "Unable to manage pi extensions.".to_owned())?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(request.to_string().as_bytes()).map_err(|_| "Unable to send extension request.".to_owned())?;
    }
    let output = child.wait_with_output().map_err(|_| "Extension request did not complete.".to_owned())?;
    let response: Value = serde_json::from_slice(&output.stdout).map_err(|_| "Invalid extension response.".to_owned())?;
    if response["ok"] == true { Ok(response["data"].clone()) }
    else { Err(response["error"].as_str().unwrap_or("Extension operation failed.").to_owned()) }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ResourceKind { Package, Extension, Mcp, Skill }

pub(super) struct ResourceRow { kind: ResourceKind, data: Value, configured: bool }

fn resource_rows(data: &Value, results: &[Value], source: ExtensionSource, filter: ExtensionFilter, query: &str) -> Vec<ResourceRow> {
    let query = query.trim().to_lowercase();
    let matches = |value: &Value| query.is_empty() || ["name", "description", "source"].iter()
        .any(|key| string(value, key).to_lowercase().contains(&query));
    match source {
        ExtensionSource::Editor => vec![],
        ExtensionSource::Pi => {
            let packages = array(data, "packages");
            let mut rows = Vec::new();
            if filter != ExtensionFilter::NotInstalled {
                rows.extend(packages.iter().filter(|p| matches(p)).cloned()
                    .map(|data| ResourceRow { kind: ResourceKind::Package, data, configured: true }));
                // Package-owned extensions are managed by the package card; only standalone
                // extensions need their own row in the same list.
                rows.extend(array(data, "extensions").into_iter()
                    .filter(|p| p["metadata"]["origin"] != "package" && matches(p))
                    .map(|data| ResourceRow { kind: ResourceKind::Extension, data, configured: true }));
            }
            if filter != ExtensionFilter::Installed {
                rows.extend(results.iter().filter(|p| !packages.iter().any(|installed| installed["source"] == p["source"]
                    || (installed["name"].is_string() && installed["name"] == p["name"])))
                    .cloned().map(|data| ResourceRow { kind: ResourceKind::Package, data, configured: false }));
            }
            rows
        }
        ExtensionSource::Mcp => array(data, "mcp").into_iter()
            .map(|data| ResourceRow { kind: ResourceKind::Mcp, data, configured: true }).collect(),
        ExtensionSource::Skills => array(data, "skills").into_iter()
            .map(|data| ResourceRow { kind: ResourceKind::Skill, data, configured: true }).collect(),
    }
}

impl ExtensionsPage {
    pub(super) fn change_source(&mut self, source: ExtensionSource, window: &mut Window, cx: &mut Context<Self>) {
        if self.source == source { return; }
        match self.source {
            ExtensionSource::Editor => self.pi.editor_query = self.query_editor.read(cx).text(cx),
            ExtensionSource::Pi => self.pi.query = self.query_editor.read(cx).text(cx),
            _ => {}
        }
        self.pi.search_generation += 1;
        self.pi.search_task = None;
        self.pi.searching = false;
        self.extension_fetch_task = None;
        self.source = source;
        let query = match source { ExtensionSource::Editor => self.pi.editor_query.clone(), ExtensionSource::Pi => self.pi.query.clone(), _ => String::new() };
        self.query_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text(if source == ExtensionSource::Pi { "Search pi plugins..." } else { "Search extensions..." }, window, cx);
            editor.set_text(query, window, cx);
        });
        if source != ExtensionSource::Editor && !self.pi.loaded && !self.pi.busy {
            self.request_pi(json!({"operation":"status"}), window, cx);
        }
        if source.searchable() {
            self.query_editor.read(cx).focus_handle(cx).focus(window, cx);
            self.refresh_search(cx);
        } else { self.pi.management_focus.focus(window, cx); }
        self.scroll_to_top(cx);
    }

    pub(super) fn search_pi_debounced(&mut self, cx: &mut Context<Self>) {
        if self.source != ExtensionSource::Pi { return; }
        if self.filter == ExtensionFilter::Installed {
            self.pi.search_generation += 1;
            self.pi.search_task = None;
            self.pi.searching = false;
            cx.notify();
            return;
        }
        let query = self.query_editor.read(cx).text(cx);
        if self.pi.searched_query.as_deref() == Some(query.as_str()) && self.pi.search_error.is_none() { return; }
        self.pi.query = query.clone();
        self.pi.search_generation += 1;
        let generation = self.pi.search_generation;
        self.pi.searched_query = None;
        self.pi.results.clear();
        self.pi.searching = true;
        self.pi.search_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(250)).await;
            let result = cx.background_spawn(async move { run_pi_request(json!({"operation":"search", "query":query})) }).await;
            this.update(cx, |this, cx| {
                this.pi.finish_search(generation, result);
                cx.notify();
            }).ok();
        }));
        cx.notify();
    }

    fn request_pi(&mut self, request: Value, window: &mut Window, cx: &mut Context<Self>) {
        if self.pi.busy { return; }
        self.pi.busy = true; self.pi.notice.clear(); self.pi.failed = false;
        let operation = string(&request, "operation");
        let task = cx.background_spawn(async move { run_pi_request(request) });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            this.update_in(cx, |this, window, cx| {
                this.pi.busy = false;
                match result {
                    Ok(data) if operation == "mcp-read" => {
                        this.pi.mcp_editor.update(cx, |editor, cx| editor.set_text(string(&data, "text"), window, cx));
                        this.pi.mcp_revision = string(&data, "revision"); this.pi.editing_mcp = true;
                    }
                    Ok(data) => {
                        this.pi.data = data; this.pi.loaded = true;
                        if operation == "mcp-save" {
                            this.pi.editing_mcp = false;
                            this.pi.mcp_editor.update(cx, |editor, cx| editor.set_text("", window, cx));
                        }
                        if operation == "install" { this.pi.installing = false; }
                        if operation != "status" {
                            this.pi.notice = if array(&this.pi.data, "pending").is_empty() {
                                "Updated. New pi tasks use these resource settings."
                            } else { "Package changes are queued. Restart Eido to apply them." }.into();
                        }
                    }
                    Err(error) => { this.pi.failed = true; this.pi.notice = error; }
                }
                cx.notify();
            }).ok();
        }).detach();
        cx.notify();
    }

    fn pi_action(&self, id: String, label: &str, request: Value, cx: &mut Context<Self>) -> Button {
        Button::new(SharedString::from(id), label.to_owned()).disabled(self.pi.busy)
            .on_click(cx.listener(move |this, _, window, cx| this.request_pi(request.clone(), window, cx)))
    }

    pub(super) fn render_source_actions(&self, cx: &mut Context<Self>) -> AnyElement {
        if self.source == ExtensionSource::Editor {
            return Button::new("install-dev-extension", "Install Dev Extension").style(ButtonStyle::Outlined)
                .size(ButtonSize::Medium).on_click(|_, window, cx| window.dispatch_action(Box::new(InstallDevExtension), cx))
                .into_any_element();
        }
        h_flex().gap_2()
            .when(self.source == ExtensionSource::Pi, |row| row.child(
                Button::new("install-pi-package", "Install Package…").style(ButtonStyle::Outlined)
                    .disabled(self.pi.busy).on_click(cx.listener(|this, _, window, cx| {
                        this.pi.installing = !this.pi.installing;
                        if this.pi.installing { this.pi.package_input.read(cx).focus_handle(cx).focus(window, cx); }
                        cx.notify();
                    }))))
            .when(self.source == ExtensionSource::Mcp, |row| row.child(
                self.pi_action("edit-mcp".into(), "Edit Configuration", json!({"operation":"mcp-read"}), cx)))
            .child(Button::new("refresh-pi-resources", "Refresh").disabled(self.pi.busy)
                .on_click(cx.listener(|this, _, window, cx| {
                    this.request_pi(json!({"operation":"status"}), window, cx);
                    if this.source == ExtensionSource::Pi { this.pi.searched_query = None; this.search_pi_debounced(cx); }
                })))
            .into_any_element()
    }

    pub(super) fn pi_rows(&self, cx: &App) -> Vec<ResourceRow> {
        resource_rows(&self.pi.data, &self.pi.results, self.source, self.filter, &self.query_editor.read(cx).text(cx))
    }

    pub(super) fn render_source_entries(&mut self, range: Range<usize>, window: &mut Window, cx: &mut Context<Self>) -> Vec<ExtensionCard> {
        if self.source == ExtensionSource::Editor { return self.render_extensions(range, window, cx); }
        let rows = self.pi_rows(cx);
        range.filter_map(|index| rows.get(index)).map(|row| self.render_pi_card(row, cx)).collect()
    }

    fn render_pi_card(&self, row: &ResourceRow, cx: &mut Context<Self>) -> ExtensionCard {
        let data = &row.data;
        let name = string(data, "name");
        let enabled = data["enabled"] == true;
        let mut actions = [None, None, None];
        let (id, feature, description) = match row.kind {
            ResourceKind::Package => {
                let source = string(data, "source");
                let pending = array(&self.pi.data, "pending").iter().any(|p| p["source"] == data["source"]);
                if !pending {
                    if row.configured {
                        actions[0] = Some(self.pi_action(format!("toggle-{source}"), if enabled {"Disable"} else {"Enable"}, json!({"operation":"toggle-package","source":source,"enabled":!enabled}), cx));
                        actions[1] = Some(self.pi_action(format!("update-{source}"), "Update", json!({"operation":"update","source":source}), cx));
                        actions[2] = Some(self.pi_action(format!("remove-{source}"), "Uninstall", json!({"operation":"remove","source":source}), cx));
                    } else { actions[0] = Some(self.pi_action(format!("install-{source}"), "Install", json!({"operation":"install","source":source}), cx)); }
                }
                (source, "pi Plugin", string(data, "description"))
            }
            ResourceKind::Extension | ResourceKind::Skill => {
                let path = string(data, "path");
                let kind = if row.kind == ResourceKind::Skill {"skills"} else {"extensions"};
                actions[0] = Some(self.pi_action(format!("toggle-{path}"), if enabled {"Disable"} else {"Enable"}, json!({"operation":"toggle-resource","kind":kind,"path":path,"enabled":!enabled}), cx));
                let description = string(data, "description");
                (path.clone(), if row.kind == ResourceKind::Skill {"Skill"} else {"Extension"}, if description.is_empty() {path} else {description})
            }
            ResourceKind::Mcp => {
                if data["builtin"] != true {
                    actions[0] = Some(self.pi_action(format!("toggle-{name}"), if enabled {"Disable"} else {"Enable"}, json!({"operation":"mcp-toggle","name":name,"enabled":!enabled}), cx));
                    actions[1] = Some(self.pi_action(format!("remove-{name}"), "Remove", json!({"operation":"mcp-remove","name":name}), cx));
                }
                (name.clone(), "MCP", string(data, "detail"))
            }
        };
        let status = if array(&self.pi.data, "pending").iter().any(|p| p["source"].as_str() == Some(&id)) {
            "Pending · Restart Eido to apply"
        } else if data["builtin"] == true { "Built-in · Enabled" }
        else if !row.configured { "Available from npm" }
        else if enabled { "Enabled · Global" } else { "Disabled · Global" };
        ExtensionCard::for_pi_resource(id, name, string(data, "version"), description, status.into(), feature, actions)
    }

    pub(super) fn render_pi_status(&self, cx: &mut Context<Self>) -> AnyElement {
        let catalog = self.source == ExtensionSource::Pi && self.filter != ExtensionFilter::Installed;
        v_flex().px_4().py_2p5().gap_2().border_b_1().border_color(cx.theme().colors().border_variant)
            .when(self.pi.busy || (catalog && self.pi.searching), |body| body.child(Label::new(if self.pi.busy {"Updating resources…"} else {"Searching pi plugins…"}).size(LabelSize::Small).color(Color::Muted)))
            .when(catalog && self.pi.search_error.is_some(), |body| body.child(Label::new(self.pi.search_error.clone().unwrap_or_default()).size(LabelSize::Small).color(Color::Error)))
            .when(!self.pi.notice.is_empty(), |body| body.child(Label::new(self.pi.notice.clone()).size(LabelSize::Small).color(if self.pi.failed {Color::Error} else {Color::Muted})))
            .children(array(&self.pi.data, "pending").iter().map(|item| {
                let source = string(item, "source");
                h_flex().gap_2().child(Label::new(format!("{} · {source} · {}", string(item, "operation"), if item["error"].is_string() {"Failed"} else {"Pending restart"})).size(LabelSize::Small).truncate())
                    .when(item["error"].is_string(), |row| row.child(self.pi_action(format!("retry-{source}"), "Retry", json!({"operation":"retry"}), cx)))
                    .child(self.pi_action(format!("cancel-{source}"), "Cancel", json!({"operation":"cancel-pending","source":source}), cx))
            }))
            .when(self.source == ExtensionSource::Pi && self.pi.installing, |body| body.child(
                h_flex().gap_2().child(div().flex_1().min_w_0().p_2().border_1().border_color(cx.theme().colors().border).rounded_md()
                    .child(self.render_text_input(&self.pi.package_input, cx)))
                    .child(Button::new("confirm-pi-install", "Install").disabled(self.pi.busy).on_click(cx.listener(|this, _, window, cx| {
                        this.request_pi(json!({"operation":"install","source":this.pi.package_input.read(cx).text(cx)}), window, cx);
                    })))
                    .child(Button::new("cancel-pi-install", "Cancel").on_click(cx.listener(|this, _, _, cx| {this.pi.installing = false; cx.notify();})))))
            .when(self.source == ExtensionSource::Mcp && self.pi.editing_mcp, |body| body.child(
                v_flex().gap_2()
                    .child(Label::new("Global MCP configuration").size(LabelSize::Small))
                    .child(div().w_full().p_2().border_1().border_color(cx.theme().colors().border).rounded_md().child(self.pi.mcp_editor.clone()))
                    .child(h_flex().gap_2()
                        .child(Button::new("save-mcp", "Save").disabled(self.pi.busy).on_click(cx.listener(|this, _, window, cx| {
                            this.request_pi(json!({"operation":"mcp-save","text":this.pi.mcp_editor.read(cx).text(cx),"revision":this.pi.mcp_revision}), window, cx);
                        })))
                        .child(Button::new("cancel-mcp", "Cancel").on_click(cx.listener(|this, _, window, cx| {
                            this.pi.editing_mcp = false; this.pi.mcp_editor.update(cx, |editor, cx| editor.set_text("", window, cx)); cx.notify();
                        }))))))
            .into_any_element()
    }

    pub(super) fn render_pi_empty(&self, _cx: &mut Context<Self>) -> AnyElement {
        let catalog = self.source == ExtensionSource::Pi && self.filter != ExtensionFilter::Installed;
        let message = if self.pi.busy || (catalog && self.pi.searching) { "Loading resources…" }
            else if !self.pi.loaded || (catalog && self.pi.search_error.is_some()) { "Unable to load resources. Use Refresh to retry." }
            else { match self.source {
                ExtensionSource::Pi => match self.filter {
                    ExtensionFilter::Installed => "No installed pi plugins match this search.",
                    ExtensionFilter::NotInstalled => "No available pi plugins match this search.",
                    ExtensionFilter::All => "No pi plugins match this search.",
                },
                ExtensionSource::Mcp => "No MCP servers configured.",
                ExtensionSource::Skills => "No installed skills. Skills from pi packages appear here automatically.",
                ExtensionSource::Editor => "No extensions.",
            }};
        v_flex().flex_1().justify_center().items_center().gap_2()
            .child(Icon::new(IconName::Blocks).size(IconSize::Medium).color(Color::Muted))
            .child(Label::new(message).size(LabelSize::Small).color(Color::Muted)).into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_eido_pi_catalog_merges_installed_without_duplicate_actions() {
        let data = json!({"packages":[{"source":"npm:installed@1.0.0", "name":"installed", "enabled":false}],
            "extensions":[{"name":"owned", "metadata":{"origin":"package"}}, {"name":"local", "metadata":{"origin":"auto"}}]});
        let results = vec![json!({"source":"npm:installed", "name":"installed"}), json!({"source":"npm:available", "name":"available"})];
        let all = resource_rows(&data, &results, ExtensionSource::Pi, ExtensionFilter::All, "");
        assert_eq!(all.len(), 3);
        assert!(all[0].configured);
        assert_eq!(all[1].kind, ResourceKind::Extension);
        assert!(!all[2].configured);
        assert_eq!(resource_rows(&data, &results, ExtensionSource::Pi, ExtensionFilter::Installed, "installed").len(), 1);
        let available = resource_rows(&data, &results, ExtensionSource::Pi, ExtensionFilter::NotInstalled, "");
        assert_eq!(available.len(), 1);
        assert_eq!(available[0].data["name"], "available");
    }

    #[test]
    fn test_eido_mcp_and_skills_ignore_catalog_search_and_install_filters() {
        let data = json!({"mcp":[{"name":"local"}],"skills":[{"name":"review"}]});
        for source in [ExtensionSource::Mcp, ExtensionSource::Skills] {
            assert!(!source.searchable());
            let rows = resource_rows(&data, &[json!({"name":"remote"})], source, ExtensionFilter::NotInstalled, "unrelated");
            assert_eq!(rows.len(), 1);
            assert!(rows[0].configured);
        }
        assert!(!editor_extension_provides(ExtensionProvides::ContextServers));
        assert!(!editor_extension_provides(ExtensionProvides::AgentServers));
        assert!(editor_extension_provides(ExtensionProvides::Languages));
    }
}
