use std::{io::Write, process::{Command, Stdio}};

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
    key: Entity<Editor>,
    custom_provider: Entity<Editor>,
    custom_url: Entity<Editor>,
    custom_model: Entity<Editor>,
    custom_api: String,
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
            key: input("API key or environment variable name", true, window, cx),
            custom_provider: input("Provider ID, e.g. my-provider", false, window, cx),
            custom_url: input("Base URL, e.g. https://api.example.com/v1", false, window, cx),
            custom_model: input("Model ID", false, window, cx),
            custom_api: "openai-completions".into(), busy: false, notice: String::new(), failed: false,
        };
        view.request(json!({"operation":"status"}), cx);
        view
    }

    fn request(&mut self, request: Value, cx: &mut Context<Self>) {
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
        cx.spawn(async move |view, cx| {
            let result = task.await;
            let _ = view.update(cx, |view, cx| {
                view.busy = false;
                match result {
                    Ok(data) => {
                        if view.data.is_none() || matches!(operation.as_str(), "status" | "import") {
                            view.provider = data["defaultProvider"].as_str().unwrap_or_default().into();
                            view.model = data["defaultModel"].as_str().unwrap_or_default().into();
                            view.thinking = data["defaultThinkingLevel"].as_str().unwrap_or("off").into();
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
                        .on_click(cx.listener(|this, _, _, cx| this.request(json!({"operation":"defaults", "provider":this.provider,"model":this.model,"thinking":this.thinking}), cx))))
                    .child(Button::new("pi-refresh", "Reload").disabled(self.busy)
                        .on_click(cx.listener(|this, _, _, cx| this.request(json!({"operation":"status"}), cx))))))
            .child(v_flex().gap_3().pt_4().border_t_1().border_color(cx.theme().colors().border_variant)
                .child(Label::new(format!("Credentials · {auth_label}")))
                .child(text_field(self.key.clone(), cx))
                .child(h_flex().gap_2()
                    .child(Button::new("pi-save-key", "Save API Key").style(ButtonStyle::Outlined).disabled(self.busy || self.provider.is_empty())
                        .on_click(cx.listener(|this, _, window, cx| {
                            let key = this.key.read(cx).text(cx);
                            this.key.update(cx, |editor, cx| editor.set_text("", window, cx));
                            this.request(json!({"operation":"key", "provider":this.provider, "key":key}), cx);
                        })))
                    .child(Button::new("pi-remove-key", "Remove Credentials").disabled(self.busy || credential == "none")
                        .on_click(cx.listener(|this, _, _, cx| this.request(json!({"operation":"remove-key", "provider":this.provider}), cx)))))
                .child(Label::new("Keys stay hidden. Existing OAuth sessions and environment credentials use pi rules.").size(LabelSize::Small).color(Color::Muted))
                .child(Button::new("pi-import", "Import Local pi Configuration").disabled(self.busy)
                    .on_click(cx.listener(|this, _, _, cx| this.request(json!({"operation":"import"}), cx)))))
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
                    .on_click(cx.listener(|this, _, _, cx| this.request(json!({"operation":"custom-model",
                        "provider":this.custom_provider.read(cx).text(cx), "baseUrl":this.custom_url.read(cx).text(cx),
                        "api":this.custom_api, "model":this.custom_model.read(cx).text(cx)}), cx)))))
            .child(v_flex().gap_2().pt_4().border_t_1().border_color(cx.theme().colors().border_variant)
                .child(Label::new("pi Updates"))
                .child(Label::new(update_label).size(LabelSize::Small).color(Color::Muted))
                .when_some(checked_at, |this, text| this.child(Label::new(text).size(LabelSize::XSmall).color(Color::Muted)))
                .child(Button::new("pi-check-update", if self.busy { "Please Wait" } else { "Check for Updates" }).style(ButtonStyle::Outlined).disabled(self.busy)
                    .on_click(cx.listener(|this, _, _, cx| this.request(json!({"operation":"check-update"}), cx))))
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
