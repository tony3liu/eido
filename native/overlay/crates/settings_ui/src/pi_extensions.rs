use std::{io::Write, process::{Command, Stdio}};
use editor::Editor;
use gpui::{Context, Entity, IntoElement, Render, Window};
use serde_json::{Value, json};
use ui::prelude::*;

pub(crate) struct PiExtensionsView {
    data: Value,
    results: Vec<Value>,
    tab: &'static str,
    query: Entity<Editor>,
    source: Entity<Editor>,
    mcp_editor: Entity<Editor>,
    editing_mcp: bool,
    mcp_revision: String,
    busy: bool,
    notice: String,
    failed: bool,
    scroll: gpui::ScrollHandle,
}

fn input(placeholder: &str, window: &mut Window, cx: &mut Context<PiExtensionsView>) -> Entity<Editor> {
    cx.new(|cx| {
        let mut editor = Editor::single_line(window, cx);
        editor.set_placeholder_text(placeholder, window, cx);
        editor
    })
}
fn field(editor: Entity<Editor>, cx: &App) -> gpui::AnyElement {
    div().w_full().p_2().rounded_md().border_1().border_color(cx.theme().colors().border)
        .bg(cx.theme().colors().editor_background).child(editor).into_any_element()
}
fn string(value: &Value, key: &str) -> String { value[key].as_str().unwrap_or_default().to_owned() }

impl PiExtensionsView {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self {
            data: json!({}), results: vec![], tab: "Plugins",
            query: input("Search pi packages", window, cx),
            source: input("npm package name or absolute local package folder", window, cx),
            mcp_editor: cx.new(|cx| Editor::auto_height(8, 18, window, cx)),
            editing_mcp: false, mcp_revision: String::new(), busy: false, notice: String::new(), failed: false,
            scroll: gpui::ScrollHandle::new(),
        };
        view.request(json!({"operation":"status"}), window, cx);
        view
    }
    fn request(&mut self, request: Value, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy { return; }
        self.busy = true; self.notice.clear(); self.failed = false;
        let operation = string(&request, "operation");
        let root = std::env::var_os("EIDO_ROOT").map(std::path::PathBuf::from);
        let node = std::env::var_os("EIDO_NODE");
        let task = cx.background_spawn(async move {
            let root = root.ok_or("Eido runtime directory is unavailable.")?;
            let node = node.ok_or("Eido Node.js runtime is unavailable.")?;
            let mut child = Command::new(node).arg(root.join("scripts/pi-extensions.mjs")).current_dir(root)
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
                .spawn().map_err(|_| "Unable to open pi extensions.".to_owned())?;
            let body = serde_json::to_vec(&request).map_err(|_| "Invalid extension request.".to_owned())?;
            if let Some(mut stdin) = child.stdin.take() {stdin.write_all(&body).map_err(|_| "Unable to send extension request.".to_owned())?;}
            let output = child.wait_with_output().map_err(|_| "Extension request did not complete.".to_owned())?;
            let response: Value = serde_json::from_slice(&output.stdout).map_err(|_| "Invalid extension response.".to_owned())?;
            if response["ok"] == true {Ok(response["data"].clone())}
            else {Err(response["error"].as_str().unwrap_or("Extension operation failed.").to_owned())}
        });
        cx.spawn_in(window, async move |view, cx| {
            let result = task.await;
            view.update_in(cx, |view, window, cx| {
                view.busy = false;
                match result {
                    Ok(data) if operation == "search" => {
                        view.results = data["results"].as_array().cloned().unwrap_or_default();
                        if view.results.is_empty() { view.notice = "No pi packages found.".into(); }
                    }
                    Ok(data) if operation == "mcp-read" => {
                        view.mcp_editor.update(cx, |editor, cx| editor.set_text(string(&data, "text"), window, cx));
                        view.mcp_revision = string(&data, "revision");
                        view.editing_mcp = true;
                    }
                    Ok(data) => {
                        view.data = data;
                        if operation == "mcp-save" {
                            view.editing_mcp = false;
                            view.mcp_editor.update(cx, |editor, cx| editor.set_text("", window, cx));
                        }
                        if operation != "status" {view.notice = "Configuration updated. Restart Eido to apply package changes; new tasks use resource settings.".into();}
                    }
                    Err(error) => {view.failed = true; view.notice = error;}
                }
                cx.notify();
            }).ok();
        }).detach();
        cx.notify();
    }
    fn action(&self, id: String, label: &str, request: Value, cx: &mut Context<Self>) -> Button {
        Button::new(gpui::SharedString::from(id), label.to_owned()).disabled(self.busy)
            .on_click(cx.listener(move |view, _, window, cx| view.request(request.clone(), window, cx)))
    }
    fn package_row(&self, row: &Value, search: bool, cx: &mut Context<Self>) -> gpui::AnyElement {
        let source = string(row, "source");
        let enabled = row["enabled"] == true;
        let installed = self.data["packages"].as_array().is_some_and(|packages| packages.iter().any(|p| p["source"] == row["source"]));
        v_flex().w_full().gap_2().py_4().border_b_1().border_color(cx.theme().colors().border_variant)
            .child(h_flex().gap_2().child(Label::new(string(row, "name"))).child(Label::new(string(row, "version")).size(LabelSize::Small).color(Color::Muted)))
            .when(!string(row, "description").is_empty(), |this| this.child(Label::new(string(row, "description")).size(LabelSize::Small).color(Color::Muted)))
            .child(h_flex().gap_2()
                .when(search && !installed, |this| this.child(self.action(format!("install-{source}"), "Install", json!({"operation":"install","source":source}), cx)))
                .when(search && installed, |this| this.child(Label::new("Installed").size(LabelSize::Small).color(Color::Success)))
                .when(!search, |this| this
                    .child(self.action(format!("toggle-{source}"), if enabled {"Disable"} else {"Enable"}, json!({"operation":"toggle-package","source":source,"enabled":!enabled}), cx))
                    .child(self.action(format!("update-{source}"), "Update", json!({"operation":"update","source":source}), cx))
                    .child(self.action(format!("remove-{source}"), "Uninstall", json!({"operation":"remove","source":source}), cx))))
            .into_any_element()
    }
}

impl Render for PiExtensionsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let packages = self.data["packages"].as_array().cloned().unwrap_or_default();
        let extensions = self.data["extensions"].as_array().cloned().unwrap_or_default();
        let skills = self.data["skills"].as_array().cloned().unwrap_or_default();
        let servers = self.data["mcp"].as_array().cloned().unwrap_or_default();
        let pending = self.data["pending"].as_array().cloned().unwrap_or_default();
        let mut body = v_flex().gap_3().w_full();
        if self.tab == "Plugins" {
            body = body.child(Label::new("Discover pi packages"))
                .child(h_flex().gap_2().child(field(self.query.clone(), cx))
                    .child(Button::new("pi-package-search", "Search").disabled(self.busy).on_click(cx.listener(|this, _, window, cx| {
                        this.request(json!({"operation":"search","query":this.query.read(cx).text(cx)}), window, cx);
                    }))))
                .child(Label::new("Searches npm packages tagged pi-package.").size(LabelSize::Small).color(Color::Muted))
                .children(self.results.iter().map(|row| self.package_row(row, true, cx)))
                .child(h_flex().gap_2().child(field(self.source.clone(), cx))
                    .child(Button::new("pi-package-add", "Install Source").disabled(self.busy).on_click(cx.listener(|this, _, window, cx| {
                        this.request(json!({"operation":"install","source":this.source.read(cx).text(cx).trim()}), window, cx);
                    }))))
                .child(Label::new("Installed packages"))
                .when(packages.is_empty(), |this| this.child(Label::new("No pi packages installed. Add a package to extend your agent.").size(LabelSize::Small).color(Color::Muted)))
                .children(packages.iter().map(|row| self.package_row(row, false, cx)));
            if !extensions.is_empty() { body = body.child(Label::new("Loaded extension files")); }
        }
        let resources = if self.tab == "Skills" {skills} else if self.tab == "Plugins" {extensions} else {vec![]};
        if self.tab == "Skills" && resources.is_empty() {
            body = body.child(Label::new("No installed skills found.").color(Color::Muted));
        }
        for resource in resources {
            let name = string(&resource, "name");
            let path = string(&resource, "path");
            let enabled = resource["enabled"] == true;
            let kind = if self.tab == "Skills" {"skills"} else {"extensions"};
            body = body.child(v_flex().gap_1().py_3().border_b_1().border_color(cx.theme().colors().border_variant)
                .child(h_flex().justify_between().gap_2().child(Label::new(name))
                    .child(self.action(format!("toggle-{path}"), if enabled {"Disable"} else {"Enable"}, json!({"operation":"toggle-resource","kind":kind,"path":path,"enabled":!enabled}), cx)))
                .child(Label::new(string(&resource, "description")).size(LabelSize::Small).color(Color::Muted))
                .child(Label::new(path).size(LabelSize::XSmall).color(Color::Muted)));
        }
        if self.tab == "MCP" {
            body = body.child(self.action("mcp-edit".into(), "Edit Global Configuration", json!({"operation":"mcp-read"}), cx));
            for server in servers {
                let name = string(&server, "name");
                let enabled = server["enabled"] == true;
                body = body.child(h_flex().py_3().gap_3().border_b_1().border_color(cx.theme().colors().border_variant)
                    .child(v_flex().flex_1().child(Label::new(name.clone())).child(Label::new(string(&server, "detail")).size(LabelSize::Small).color(Color::Muted)))
                    .when(server["builtin"] != true, |this| this
                        .child(self.action(format!("mcp-toggle-{name}"), if enabled {"Disable"} else {"Enable"}, json!({"operation":"mcp-toggle","name":name,"enabled":!enabled}), cx))
                        .child(self.action(format!("mcp-remove-{name}"), "Remove", json!({"operation":"mcp-remove","name":name}), cx))));
            }
            if self.editing_mcp {
                body = body.child(Label::new("Global mcp.json · command/args/env or url/headers").size(LabelSize::Small))
                    .child(field(self.mcp_editor.clone(), cx))
                    .child(h_flex().gap_2()
                        .child(Button::new("mcp-save", "Save Configuration").disabled(self.busy).on_click(cx.listener(|this, _, window, cx| {
                            this.request(json!({"operation":"mcp-save","text":this.mcp_editor.read(cx).text(cx),"revision":this.mcp_revision}), window, cx);
                        })))
                        .child(Button::new("mcp-cancel", "Cancel").on_click(cx.listener(|this, _, window, cx| {
                            this.editing_mcp = false; this.mcp_editor.update(cx, |editor, cx| editor.set_text("", window, cx)); cx.notify();
                        }))));
            }
        }
        v_flex().id("pi-extension-center").size_full().overflow_y_scroll().track_scroll(&self.scroll).px_8().pb_12().gap_4()
            .child(h_flex().pt_4().gap_2().child(Label::new("pi Extension Center")).child(div().flex_1())
                .child(self.action("extensions-refresh".into(), if self.busy {"Working…"} else {"Refresh"}, json!({"operation":"status"}), cx)))
            .child(Label::new("Global plugins, connected tools, and installed skills.").size(LabelSize::Small).color(Color::Muted))
            .child(h_flex().gap_2().children(["Plugins", "MCP", "Skills"].into_iter().map(|tab| {
                Button::new(tab, tab).style(if self.tab == tab {ButtonStyle::Filled} else {ButtonStyle::Subtle}).on_click(cx.listener(move |this, _, _, cx| {this.tab = tab; this.notice.clear(); cx.notify();}))
            })))
            .when(self.tab != "Plugins", |this| this.child(Label::new("Manage installed resources. Changes apply to new tasks.").size(LabelSize::Small).color(Color::Muted)))
            .when(!self.notice.is_empty(), |this| this.child(Label::new(self.notice.clone()).size(LabelSize::Small).color(if self.failed {Color::Error} else {Color::Muted})))
            .children(pending.iter().map(|item| {
                let source = string(item, "source");
                h_flex().gap_2().child(Label::new(format!("Pending {} · {source}{}", string(item, "operation"), if item["error"].is_string() {" · Failed; retry after restart"} else {" · Restart Eido to apply"})).size(LabelSize::Small))
                    .when(item["error"].is_string(), |this| this.child(self.action(format!("retry-{source}"), "Retry", json!({"operation":"retry"}), cx)))
                    .child(self.action(format!("cancel-{source}"), "Cancel", json!({"operation":"cancel-pending","source":source}), cx))
            }))
            .child(body)
    }
}

pub(crate) fn render_pi_extensions_page(settings: &crate::SettingsWindow, _: &gpui::ScrollHandle, _: &mut Window, _: &mut Context<crate::SettingsWindow>) -> gpui::AnyElement {
    div().size_full().children(settings.pi_extensions.clone()).into_any_element()
}
