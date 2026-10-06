use std::{collections::{HashMap, HashSet}, io::Write, process::{Command, Stdio}};

use editor::Editor;
use gpui::{Context, Entity, IntoElement, Render, Window};
use serde_json::{Value, json};
use ui::{ContextMenu, DropdownMenu, DropdownStyle, prelude::*};

pub(crate) struct PiSettingsView {
    data: Option<Value>,
    scroll_handle: gpui::ScrollHandle,
    provider: String,
    model: String,
    thinking: String,
    default_tools: Entity<Editor>,
    runtime_inputs: HashMap<String, Entity<Editor>>,
    runtime_values: HashMap<String, Value>,
    runtime_expected: HashMap<String, Value>,
    runtime_open: HashSet<String>,
    http_proxy: Entity<Editor>,
    http_proxy_expected: Value,
    key: Entity<Editor>,
    custom_provider: Entity<Editor>,
    custom_url: Entity<Editor>,
    custom_model: Entity<Editor>,
    custom_api: String,
    jev_url: Entity<Editor>,
    jev_model: Entity<Editor>,
    jev_key: Entity<Editor>,
    busy: bool,
    notice: String,
    failed: bool,
}

fn input(placeholder: &str, masked: bool, window: &mut Window, cx: &mut Context<PiSettingsView>) -> Entity<Editor> {
    cx.new(|cx| {
        let mut editor = Editor::single_line(window, cx);
        editor.set_placeholder_text(placeholder, window, cx);
        editor.set_masked(masked, cx);
        editor
    })
}

impl PiSettingsView {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self {
            data: None, scroll_handle: gpui::ScrollHandle::new(), provider: String::new(), model: String::new(), thinking: "off".into(),
            default_tools: input("Leave blank to use Eido defaults", false, window, cx),
            runtime_inputs: HashMap::new(), runtime_values: HashMap::new(), runtime_expected: HashMap::new(), runtime_open: HashSet::new(),
            http_proxy: input("HTTP(S) proxy URL; leave blank to keep", true, window, cx), http_proxy_expected: Value::Null,
            key: input("API key or $ENV_VAR reference", true, window, cx),
            custom_provider: input("Provider ID, e.g. my-provider", false, window, cx),
            custom_url: input("Base URL, e.g. https://api.example.com/v1", false, window, cx),
            custom_model: input("Model ID", false, window, cx),
            jev_url: input("Jev System One API endpoint", false, window, cx),
            jev_model: input("Jev model ID", false, window, cx),
            jev_key: input("API key or $ENV_VAR reference; leave blank to keep", true, window, cx),
            custom_api: "openai-completions".into(), busy: false, notice: String::new(), failed: false,
        };
        view.request(json!({"operation":"status"}), window, cx);
        view
    }

    fn request(&mut self, request: Value, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy { return; }
        self.busy = true;
        self.notice.clear();
        self.failed = false;
        let operation = request["operation"].as_str().unwrap_or("status").to_owned();
        let root = std::env::var_os("EIDO_ROOT").map(std::path::PathBuf::from);
        let node = std::env::var_os("EIDO_NODE");
        let task = cx.background_spawn(async move {
            let root = root.ok_or_else(|| "Eido runtime directory is unavailable.".to_string())?;
            let node = node.ok_or_else(|| "Eido Node.js runtime is unavailable.".to_string())?;
            let mut child = Command::new(node)
                .arg(root.join("scripts/pi-settings.mjs"))
                .current_dir(&root)
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
                .spawn().map_err(|_| "Unable to start pi settings.".to_string())?;
            let body = serde_json::to_vec(&request).map_err(|_| "Unable to read settings.".to_string())?;
            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(&body).map_err(|_| "Unable to send settings.".to_string())?;
            }
            let output = child.wait_with_output().map_err(|_| "The pi settings request did not complete.".to_string())?;
            let response: Value = serde_json::from_slice(&output.stdout)
                .map_err(|_| "The pi settings response was invalid.".to_string())?;
            if response["ok"] == true { Ok(response["data"].clone()) }
            else { Err(response["error"].as_str().unwrap_or("Unable to update pi settings.").to_owned()) }
        });
        cx.spawn_in(window, async move |view, cx| {
            let result = task.await;
            let _ = view.update_in(cx, |view, window, cx| {
                view.busy = false;
                match result {
                    Ok(data) => {
                        if view.data.is_none() || matches!(operation.as_str(), "status" | "http-proxy" | "import") {
                            view.http_proxy_expected = data["httpProxy"]["revision"].clone();
                            view.http_proxy.update(cx, |editor, cx| editor.set_text("", window, cx));
                        }
                        if view.data.is_none() || matches!(operation.as_str(), "status" | "runtime" | "import") {
                            for field in data["runtime"].as_array().into_iter().flatten() {
                                let Some(path) = field["path"].as_str() else { continue; };
                                let value = field["value"].clone();
                                view.runtime_expected.insert(path.into(), value.clone());
                                view.runtime_values.insert(path.into(), value.clone());
                                if field["kind"] == "number" {
                                    let editor = view.runtime_inputs.entry(path.into()).or_insert_with(|| input("Use pi default", false, window, cx));
                                    editor.update(cx, |editor, cx| editor.set_text(runtime_text(&value), window, cx));
                                }
                            }
                        }
                        if view.data.is_none() || matches!(operation.as_str(), "status" | "tool-defaults" | "import") {
                            let text = data["defaultTools"].as_array().map(|names| {
                                if names.is_empty() { "[]".to_owned() }
                                else { names.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ") }
                            }).unwrap_or_default();
                            view.default_tools.update(cx, |editor, cx| editor.set_text(text, window, cx));
                        }
                        if view.data.is_none() || matches!(operation.as_str(), "status" | "import") {
                            view.provider = data["defaultProvider"].as_str().unwrap_or_default().into();
                            view.model = data["defaultModel"].as_str().unwrap_or_default().into();
                            view.thinking = data["defaultThinkingLevel"].as_str().unwrap_or("off").into();
                        }
                        if view.data.is_none() || matches!(operation.as_str(), "status" | "browser-decision") {
                            view.jev_url.update(cx, |editor, cx| editor.set_text(data["browserDecision"]["apiUrl"].as_str().unwrap_or_default(), window, cx));
                            view.jev_model.update(cx, |editor, cx| editor.set_text(data["browserDecision"]["model"].as_str().unwrap_or_default(), window, cx));
                        }
                        view.data = Some(data);
                        if view.provider.is_empty() {
                            view.provider = view.providers().first().map(|p| p["id"].as_str().unwrap_or_default().into()).unwrap_or_default();
                            view.select_first_model();
                        }
                        view.notice = match operation.as_str() {
                            "status" | "check-update" => String::new(),
                            "import" => "Local pi configuration imported. New tasks will use these settings.".into(),
                            "defaults" => "Defaults saved for new tasks. Existing tasks keep their models.".into(),
                            "tool-defaults" => "Tool defaults saved. New tasks use this list; /reload adds newly selected tools to the current task.".into(),
                            "runtime" => "Runtime settings saved. Use /reload in an existing task to apply them.".into(),
                            "http-proxy" => "HTTP proxy saved. Restart Eido to apply this change to all tasks.".into(),
                            "browser-decision" => "Browser decision settings saved. New tasks use this configuration.".into(),
                            "custom-model" => "Model saved. Select it above to make it the default.".into(),
                            _ => "pi credentials updated.".into(),
                        };
                    }
                    Err(error) => { view.failed = true; view.notice = error; }
                }
                cx.notify();
            });
        }).detach();
        cx.notify();
    }

    fn providers(&self) -> &[Value] {
        self.data.as_ref().and_then(|data| data["providers"].as_array()).map(Vec::as_slice).unwrap_or_default()
    }

    fn save_runtime(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut changes = serde_json::Map::new();
        for (path, original) in &self.runtime_expected {
            let value = if let Some(editor) = self.runtime_inputs.get(path) {
                let text = editor.read(cx).text(cx);
                if text.trim() == runtime_text(original) { continue; }
                if text.trim().is_empty() { Value::Null }
                else if let Ok(number) = text.trim().parse::<u64>() { json!(number) }
                else {
                    self.failed = true; self.notice = "Enter a non-negative whole number, or leave blank for the pi default.".into(); cx.notify(); return;
                }
            } else { self.runtime_values.get(path).cloned().unwrap_or(Value::Null) };
            if &value != original { changes.insert(path.clone(), value); }
        }
        if changes.is_empty() { self.failed = false; self.notice = "No runtime changes to save.".into(); cx.notify(); return; }
        self.request(json!({"operation":"runtime", "changes":changes,"expected":self.runtime_expected}), window, cx);
    }

    fn runtime_control(&self, field: &Value, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let path = field["path"].as_str().unwrap_or_default().to_owned();
        if let Some(editor) = self.runtime_inputs.get(&path) { return text_field(editor.clone(), cx); }
        let selected = self.runtime_values.get(&path).unwrap_or(&Value::Null).clone();
        let choices = if field["kind"] == "boolean" { vec![json!(true), json!(false)] }
            else { field["choices"].as_array().cloned().unwrap_or_default() };
        let weak = cx.entity().downgrade();
        let key = path.clone();
        let menu = ContextMenu::build(window, cx, move |mut menu, _, _| {
            for value in std::iter::once(Value::Null).chain(choices) {
                let weak = weak.clone(); let key = key.clone();
                menu = menu.entry(runtime_choice(&value), None, move |_, cx| {
                    let _ = weak.update(cx, |view, cx| {
                        if view.busy { return; }
                        view.runtime_values.insert(key.clone(), value.clone()); cx.notify();
                    });
                });
            }
            menu
        });
        DropdownMenu::new(SharedString::from(format!("pi-runtime-{path}")), runtime_choice(&selected), menu)
            .style(DropdownStyle::Outlined).full_width(true).into_any_element()
    }

    fn runtime_section(&self, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let fields = self.data.as_ref().and_then(|data| data["runtime"].as_array()).cloned().unwrap_or_default();
        let mut section = v_flex().gap_3().pt_4().border_t_1().border_color(cx.theme().colors().border_variant)
            .child(Label::new("Agent Runtime"))
            .child(Label::new("Global pi settings. Leave numeric fields blank or choose Use pi default to inherit pi behavior.").size(LabelSize::Small).color(Color::Muted));
        for group in ["Messages", "Images", "Context", "Recovery", "Requests", "Thinking Budgets", "Tools"] {
            let open = self.runtime_open.contains(group);
            section = section.child(h_flex().child(Button::new(SharedString::from(format!("pi-runtime-group-{group}")), group)
                .start_icon(Icon::new(if open { IconName::ChevronDown } else { IconName::ChevronRight }))
                .on_click(cx.listener(move |view, _, _, cx| {
                    if !view.runtime_open.remove(group) { view.runtime_open.insert(group.into()); } cx.notify();
                }))));
            if !open { continue; }
            if group == "Messages" {
                section = section.child(Label::new("Choose how pi consumes pending messages at its next processing boundary. Steering adjusts an active turn; follow-ups wait for it to finish. This does not reorder Eido's task queue. Use /reload to apply changes to an open task.").size(LabelSize::Small).color(Color::Muted));
            } else if group == "Requests" {
                section = section.child(Label::new("Transport support depends on the provider. Cache warming makes additional requests and may increase usage.").size(LabelSize::Small).color(Color::Muted));
            } else if group == "Thinking Budgets" {
                section = section.child(Label::new("Token budgets apply to models that support them. The conversation's thinking level selects the budget.").size(LabelSize::Small).color(Color::Muted));
            }
            for field in fields.iter().filter(|field| field["group"] == group) {
                let effective = if field["effective"].is_null() { "Provider default".to_owned() } else { runtime_choice(&field["effective"]) };
                section = section.child(v_flex().gap_1()
                    .child(h_flex().gap_4().items_center().justify_between()
                        .child(Label::new(field["label"].as_str().unwrap_or_default().to_owned()).size(LabelSize::Small))
                        .child(div().w(px(240.)).child(self.runtime_control(field, window, cx))))
                    .child(Label::new(format!("Current setting: {effective}")).size(LabelSize::XSmall).color(Color::Muted)));
            }
            if group == "Requests" {
                let configured = self.data.as_ref().is_some_and(|data| data["httpProxy"]["configured"] == true);
                section = section.child(v_flex().gap_2().pt_2()
                    .child(Label::new(if configured { "HTTP Proxy · Configured" } else { "HTTP Proxy · Environment defaults" }).size(LabelSize::Small))
                    .child(Label::new("Stored in global pi settings. Existing proxy environment variables take precedence. Restart Eido after changes. URLs and credentials stay hidden.").size(LabelSize::Small).color(Color::Muted))
                    .child(text_field(self.http_proxy.clone(), cx))
                    .child(h_flex().gap_2()
                        .child(Button::new("pi-save-http-proxy", "Save Proxy").style(ButtonStyle::Outlined).disabled(self.busy)
                            .on_click(cx.listener(|view, _, window, cx| {
                                let proxy = view.http_proxy.read(cx).text(cx);
                                if proxy.trim().is_empty() { view.failed = false; view.notice = "Proxy unchanged. Enter a URL to replace it, or choose Remove Proxy.".into(); cx.notify(); return; }
                                view.request(json!({"operation":"http-proxy", "proxy":proxy, "expected":view.http_proxy_expected}), window, cx);
                            })))
                        .child(Button::new("pi-remove-http-proxy", "Remove Proxy").disabled(self.busy || !configured)
                            .on_click(cx.listener(|view, _, window, cx| view.request(json!({"operation":"http-proxy", "proxy":Value::Null, "expected":view.http_proxy_expected}), window, cx))))));
            }
        }
        section.child(h_flex().child(Button::new("pi-save-runtime", "Save Runtime Settings").style(ButtonStyle::Outlined).disabled(self.busy)
            .on_click(cx.listener(|view, _, window, cx| view.save_runtime(window, cx))))).into_any_element()
    }
    fn selected_provider(&self) -> Option<&Value> {
        self.providers().iter().find(|p| p["id"].as_str() == Some(self.provider.as_str()))
    }
    fn models(&self) -> &[Value] {
        self.selected_provider().and_then(|p| p["models"].as_array()).map(Vec::as_slice).unwrap_or_default()
    }
    fn levels(&self) -> Vec<String> {
        self.models().iter().find(|m| m["id"].as_str() == Some(self.model.as_str()))
            .and_then(|m| m["thinkingLevels"].as_array())
            .map(|levels| levels.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_else(|| vec!["off".into()])
    }
    fn select_first_model(&mut self) {
        self.model = self.models().first().and_then(|m| m["id"].as_str()).unwrap_or_default().into();
        if !self.levels().contains(&self.thinking) { self.thinking = "off".into(); }
    }

    fn selector(&self, id: &'static str, label: String, choices: Vec<(String, String)>, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let weak = cx.entity().downgrade();
        let busy = self.busy;
        let menu = ContextMenu::build(window, cx, move |mut menu, _, _| {
            for (value, name) in choices {
                let weak = weak.clone();
                menu = menu.entry(name, None, move |window, cx| {
                    let _ = weak.update(cx, |view, cx| {
                        if busy || view.busy { return; }
                        match id {
                            "pi-provider" => {
                                view.provider = value.clone(); view.select_first_model();
                                view.key.update(cx, |editor, cx| editor.set_text("", window, cx));
                            }
                            "pi-model" => { view.model = value.clone(); if !view.levels().contains(&view.thinking) { view.thinking = "off".into(); } }
                            "pi-thinking" => view.thinking = value.clone(),
                            "pi-custom-api" => view.custom_api = value.clone(),
                            _ => {}
                        }
                        cx.notify();
                    });
                });
            }
            menu
        });
        DropdownMenu::new(id, label, menu).style(DropdownStyle::Outlined).full_width(true).into_any_element()
    }
}

fn runtime_text(value: &Value) -> String {
    if value.is_null() { String::new() } else { value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string()) }
}
fn runtime_choice(value: &Value) -> String {
    match value {
        Value::Null => "Use pi default".into(), Value::Bool(true) => "On".into(), Value::Bool(false) => "Off".into(),
        Value::String(value) if value == "one-at-a-time" => "One at a time".into(),
        Value::String(value) if value == "all" => "All pending messages".into(),
        _ => runtime_text(value),
    }
}

fn field(label: &str, element: impl IntoElement) -> gpui::AnyElement {
    v_flex().gap_2().w_full().child(Label::new(label.to_owned()).size(LabelSize::Small)).child(element).into_any_element()
}
fn text_field(editor: Entity<Editor>, cx: &App) -> gpui::AnyElement {
    div().w_full().px_2().py_2().rounded_md().border_1().border_color(cx.theme().colors().border)
        .bg(cx.theme().colors().editor_background).child(editor).into_any_element()
}

impl Render for PiSettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let providers = self.providers().iter().map(|p| (p["id"].as_str().unwrap_or_default().to_owned(), p["name"].as_str().unwrap_or_default().to_owned())).collect();
        let models = self.models().iter().map(|m| (m["id"].as_str().unwrap_or_default().to_owned(), m["name"].as_str().unwrap_or_default().to_owned())).collect();
        let levels = self.levels().into_iter().map(|level| (level.clone(), level)).collect();
        let provider_name = self.selected_provider().and_then(|p| p["name"].as_str()).unwrap_or("Select a provider").to_owned();
        let model_name = self.models().iter().find(|m| m["id"].as_str() == Some(self.model.as_str())).and_then(|m| m["name"].as_str()).unwrap_or("Select a model").to_owned();
        let credential = self.selected_provider().and_then(|p| p["credential"].as_str()).unwrap_or("none");
        let auth_label = match credential { "oauth" => "OAuth configured", "api_key" => "API key configured", "none" => "No credentials configured", _ => "Environment or custom credentials" };
        let version = self.data.as_ref().and_then(|d| d["version"].as_str()).unwrap_or("1.0.2");
        let update = self.data.as_ref().map(|d| &d["update"]);
        let update_label = match update.and_then(|u| u["status"].as_str()) {
            Some("up_to_date") => "You are using the latest stable pi release.".to_owned(),
            Some("update_available") => format!("pi {} is available. Your installed version has not changed.", update.and_then(|u| u["latest"].as_str()).unwrap_or_default()),
            Some("ahead") => "Your bundled version is newer than the stable release.".into(),
            Some("error") => "Unable to check for updates. Try again later.".into(),
            _ => "Updates have not been checked.".into(),
        };
        let checked_at = update.and_then(|u| u["checkedAt"].as_str()).map(|s| format!("Last checked: {s}"));
        v_flex().id("eido-pi-settings").size_full().overflow_y_scroll().track_scroll(&self.scroll_handle).px_8().pb_12().gap_6()
            .child(v_flex().gap_2().pt_4()
                .child(Label::new(format!("pi {version} · Built into Eido")))
                .child(Label::new("Manage models, credentials, and task defaults for Eido.").size(LabelSize::Small).color(Color::Muted)))
            .when(!self.notice.is_empty(), |this| this.child(Label::new(self.notice.clone()).size(LabelSize::Small).color(if self.failed { Color::Error } else { Color::Success })))
            .child(v_flex().gap_4()
                .child(field("Provider", self.selector("pi-provider", provider_name, providers, window, cx)))
                .child(field("Default Model", self.selector("pi-model", model_name, models, window, cx)))
                .child(field("Thinking Level", self.selector("pi-thinking", self.thinking.clone(), levels, window, cx)))
                .child(h_flex().gap_2()
                    .child(Button::new("pi-save-defaults", "Save Defaults").style(ButtonStyle::Filled).disabled(self.busy || self.model.is_empty())
                        .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"defaults", "provider":this.provider,"model":this.model,"thinking":this.thinking}), window, cx))))
                    .child(Button::new("pi-refresh", "Reload").disabled(self.busy)
                        .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"status"}), window, cx))))))
            .child(v_flex().gap_3().pt_4().border_t_1().border_color(cx.theme().colors().border_variant)
                .child(Label::new("Tool Defaults"))
                .child(text_field(self.default_tools.clone(), cx))
                .child(Label::new("Leave blank for read, edit, write, find, grep and ls. Enter [] for no default file tools.").size(LabelSize::Small).color(Color::Muted))
                .child(Label::new("Use tool names separated by commas. +codemode and -edit adjust pi defaults. Plugins keep their own defaults; agent roles still apply.").size(LabelSize::Small).color(Color::Muted))
                .child(Button::new("pi-save-tool-defaults", "Save Tool Defaults").style(ButtonStyle::Outlined).disabled(self.busy)
                    .on_click(cx.listener(|this, _, window, cx| {
                        let text = this.default_tools.read(cx).text(cx);
                        let tools = if text.trim().is_empty() { Value::Null }
                            else if text.trim() == "[]" { json!([]) }
                            else { json!(text.split(',').map(str::trim).collect::<Vec<_>>()) };
                        let expected = this.data.as_ref().map(|data| data["defaultTools"].clone()).unwrap_or(Value::Null);
                        this.request(json!({"operation":"tool-defaults", "tools":tools, "expected":expected}), window, cx);
                    }))))
            .child(self.runtime_section(window, cx))
            .child(v_flex().gap_3().pt_4().border_t_1().border_color(cx.theme().colors().border_variant)
                .child(Label::new(format!("Credentials · {auth_label}")))
                .child(text_field(self.key.clone(), cx))
                .child(h_flex().gap_2()
                    .child(Button::new("pi-save-key", "Save API Key").style(ButtonStyle::Outlined).disabled(self.busy || self.provider.is_empty())
                        .on_click(cx.listener(|this, _, window, cx| {
                            let key = this.key.read(cx).text(cx);
                            this.key.update(cx, |editor, cx| editor.set_text("", window, cx));
                            this.request(json!({"operation":"key", "provider":this.provider, "key":key}), window, cx);
                        })))
                    .child(Button::new("pi-remove-key", "Remove Credentials").disabled(self.busy || credential == "none")
                        .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"remove-key", "provider":this.provider}), window, cx)))))
                .child(Label::new("Keys stay hidden. Existing OAuth sessions and environment credentials use pi rules.").size(LabelSize::Small).color(Color::Muted))
                .child(Button::new("pi-import", "Import Local pi Configuration").disabled(self.busy)
                    .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"import"}), window, cx)))))
            .child(v_flex().gap_3().pt_4().border_t_1().border_color(cx.theme().colors().border_variant)
                .child(Label::new("Custom Models"))
                .child(text_field(self.custom_provider.clone(), cx))
                .child(text_field(self.custom_url.clone(), cx))
                .child(self.selector("pi-custom-api", self.custom_api.clone(), vec![
                    ("openai-completions".into(), "OpenAI Chat Completions".into()),
                    ("openai-responses".into(), "OpenAI Responses".into()),
                    ("anthropic-messages".into(), "Anthropic Messages".into()),
                ], window, cx))
                .child(text_field(self.custom_model.clone(), cx))
                .child(Button::new("pi-save-custom", "Save Model").style(ButtonStyle::Outlined).disabled(self.busy)
                    .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"custom-model",
                        "provider":this.custom_provider.read(cx).text(cx), "baseUrl":this.custom_url.read(cx).text(cx),
                        "api":this.custom_api, "model":this.custom_model.read(cx).text(cx)}), window, cx)))))
            .child(v_flex().gap_3().pt_4().border_t_1().border_color(cx.theme().colors().border_variant)
                .child(Label::new("Browser Decision Model · Jev"))
                .child(Label::new("Optional decision service for browser goals and checks. Direct browser control works without a key.").size(LabelSize::Small).color(Color::Muted))
                .child(field("API Endpoint", text_field(self.jev_url.clone(), cx)))
                .child(field("Model", text_field(self.jev_model.clone(), cx)))
                .child(field("API Key", text_field(self.jev_key.clone(), cx)))
                .child(Label::new(match self.data.as_ref().and_then(|d| d["browserDecision"]["credential"].as_str()) {
                    Some("configured") => "API key configured",
                    Some("environment") => "Using TYPESAFE_API_KEY from the environment",
                    _ => "No Jev API key configured",
                }).size(LabelSize::Small).color(Color::Muted))
                .child(h_flex().gap_2()
                    .child(Button::new("pi-save-jev", "Save Browser Configuration").style(ButtonStyle::Outlined).disabled(self.busy)
                        .on_click(cx.listener(|this, _, window, cx| {
                            let key = this.jev_key.read(cx).text(cx);
                            this.jev_key.update(cx, |editor, cx| editor.set_text("", window, cx));
                            this.request(json!({"operation":"browser-decision", "apiUrl":this.jev_url.read(cx).text(cx),
                                "model":this.jev_model.read(cx).text(cx), "key":key}), window, cx);
                        })))
                    .child(Button::new("pi-remove-jev-key", "Remove API Key").disabled(self.busy)
                        .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"browser-decision",
                            "apiUrl":this.jev_url.read(cx).text(cx), "model":this.jev_model.read(cx).text(cx), "removeKey":true}), window, cx))))))
            .child(v_flex().gap_2().pt_4().border_t_1().border_color(cx.theme().colors().border_variant)
                .child(Label::new("pi Updates"))
                .child(Label::new(update_label).size(LabelSize::Small).color(Color::Muted))
                .when_some(checked_at, |this, text| this.child(Label::new(text).size(LabelSize::XSmall).color(Color::Muted)))
                .child(Button::new("pi-check-update", if self.busy { "Please Wait" } else { "Check for Updates" }).style(ButtonStyle::Outlined).disabled(self.busy)
                    .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"check-update"}), window, cx))))
                .child(Label::new("Checks the latest release without replacing the running agent.").size(LabelSize::Small).color(Color::Muted)))
    }
}

pub(crate) fn render_pi_settings_page(
    settings: &crate::SettingsWindow,
    _: &gpui::ScrollHandle,
    _: &mut Window,
    _: &mut Context<crate::SettingsWindow>,
) -> gpui::AnyElement {
    div().size_full().children(settings.pi_settings.clone()).into_any_element()
}
