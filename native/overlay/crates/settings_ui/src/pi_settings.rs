use std::{collections::{HashMap, HashSet}, io::Write, process::{Command, Stdio}};

use editor::Editor;
use eido_i18n::{tr, tr_args, tr_or, LocaleState};
use gpui::{Context, Entity, IntoElement, Render, Window};
use serde_json::{Value, json};
use ui::{ContextMenu, DropdownMenu, DropdownStyle, prelude::*};

struct ModelSettingsDraft {
    expected: Value,
    thinking: Value,
    reserve: Entity<Editor>,
    recent: Entity<Editor>,
}

pub(crate) struct PiSettingsView {
    data: Option<Value>,
    scroll_handle: gpui::ScrollHandle,
    provider: String,
    model: String,
    thinking: String,
    section: &'static str,
    custom_model_open: bool,
    service_open: HashSet<&'static str>,
    model_settings_open: bool,
    model_settings: HashMap<String, ModelSettingsDraft>,
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
    custom_key: Entity<Editor>,
    custom_api: String,
    jev_url: Entity<Editor>,
    jev_model: Entity<Editor>,
    jev_key: Entity<Editor>,
    browser_engine: String,
    browser_text_url: Entity<Editor>,
    browser_text_model: Entity<Editor>,
    browser_text_key: Entity<Editor>,
    browser_text_reasoning: String,
    cua_path: Entity<Editor>,
    research_url: Entity<Editor>,
    research_key: Entity<Editor>,
    research_enabled: bool,
    research_limits: HashMap<String, Entity<Editor>>,
    busy: bool,
    notice: String,
    failed: bool,
    locale_revision: u64,
}

fn input(placeholder: &str, masked: bool, window: &mut Window, cx: &mut Context<PiSettingsView>) -> Entity<Editor> {
    let placeholder = tr(cx, placeholder);
    cx.new(|cx| {
        let mut editor = Editor::single_line(window, cx);
        editor.set_placeholder_text(&placeholder, window, cx);
        editor.set_masked(masked, cx);
        editor
    })
}

impl PiSettingsView {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self {
            data: None, scroll_handle: gpui::ScrollHandle::new(), provider: String::new(), model: String::new(), thinking: "off".into(),
            section: "models", custom_model_open: false, service_open: HashSet::new(),
            model_settings_open: false, model_settings: HashMap::new(),
            default_tools: input("settings.placeholder.tools", false, window, cx),
            runtime_inputs: HashMap::new(), runtime_values: HashMap::new(), runtime_expected: HashMap::new(), runtime_open: HashSet::new(),
            http_proxy: input("settings.placeholder.proxy", true, window, cx), http_proxy_expected: Value::Null,
            key: input("settings.placeholder.key", true, window, cx),
            custom_provider: input("settings.placeholder.provider", false, window, cx),
            custom_url: input("settings.placeholder.base_url", false, window, cx),
            custom_model: input("settings.placeholder.model", false, window, cx),
            custom_key: input("settings.placeholder.key_keep", true, window, cx),
            jev_url: input("settings.placeholder.jev_url", false, window, cx),
            jev_model: input("settings.placeholder.jev_model", false, window, cx),
            jev_key: input("settings.placeholder.key_keep", true, window, cx),
            browser_engine: "ultrafast".into(), browser_text_reasoning: "low".into(),
            browser_text_url: input("settings.placeholder.text_url", false, window, cx),
            browser_text_model: input("settings.placeholder.text_model", false, window, cx),
            browser_text_key: input("settings.placeholder.key_keep", true, window, cx),
            cua_path: input("settings.placeholder.cua_path", false, window, cx),
            research_url: input("settings.placeholder.research_url", false, window, cx),
            research_key: input("settings.placeholder.research_key", true, window, cx),
            research_enabled: false, research_limits: HashMap::new(),
            custom_api: "openai-completions".into(), busy: false, notice: String::new(), failed: false,
            locale_revision: cx.try_global::<LocaleState>().map_or(0, |state| state.revision),
        };
        cx.observe_global_in::<LocaleState>(window, |view, window, cx| {
            view.refresh_placeholders(window, cx);
            cx.notify();
        }).detach();
        view.request(json!({"operation":"status"}), window, cx);
        view
    }

    // Language changes update only placeholder strings on the existing editor entities.
    fn refresh_placeholders(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let revision = cx.try_global::<LocaleState>().map_or(0, |state| state.revision);
        if self.locale_revision == revision { return; }
        self.locale_revision = revision;
        for (editor, key) in [
            (&self.default_tools, "settings.placeholder.tools"),
            (&self.http_proxy, "settings.placeholder.proxy"),
            (&self.key, "settings.placeholder.key"),
            (&self.custom_provider, "settings.placeholder.provider"),
            (&self.custom_url, "settings.placeholder.base_url"),
            (&self.custom_model, "settings.placeholder.model"),
            (&self.custom_key, "settings.placeholder.key_keep"),
            (&self.jev_url, "settings.placeholder.jev_url"),
            (&self.jev_model, "settings.placeholder.jev_model"),
            (&self.jev_key, "settings.placeholder.key_keep"),
            (&self.browser_text_url, "settings.placeholder.text_url"),
            (&self.browser_text_model, "settings.placeholder.text_model"),
            (&self.browser_text_key, "settings.placeholder.key_keep"),
            (&self.cua_path, "settings.placeholder.cua_path"),
            (&self.research_url, "settings.placeholder.research_url"),
            (&self.research_key, "settings.placeholder.research_key"),
        ] {
            let placeholder = tr(cx, key);
            editor.update(cx, |editor, cx| editor.set_placeholder_text(&placeholder, window, cx));
        }
        // Every dynamic runtime number uses the pi default; research limits use a finite limit.
        for (editors, key) in [(&self.runtime_inputs, "settings.placeholder.pi_default"), (&self.research_limits, "settings.placeholder.limit")] {
            for editor in editors.values() {
                let placeholder = tr(cx, key);
                editor.update(cx, |editor, cx| editor.set_placeholder_text(&placeholder, window, cx));
            }
        }
        for draft in self.model_settings.values() {
            for editor in [&draft.reserve, &draft.recent] {
                let placeholder = tr(cx, "settings.placeholder.global_default");
                editor.update(cx, |editor, cx| editor.set_placeholder_text(&placeholder, window, cx));
            }
        }
    }

    fn request(&mut self, request: Value, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy { return; }
        self.busy = true;
        self.notice.clear();
        self.failed = false;
        let operation = request["operation"].as_str().unwrap_or("status").to_owned();
        let saved_provider = request["provider"].as_str().unwrap_or_default().trim().to_owned();
        let saved_model_id = request["model"].as_str().unwrap_or_default().trim().to_owned();
        let saved_model = format!("{}/{}", request["provider"].as_str().unwrap_or_default(), request["model"].as_str().unwrap_or_default());
        let root = std::env::var_os("EIDO_ROOT").map(std::path::PathBuf::from);
        let node = std::env::var_os("EIDO_NODE");
        let task = cx.background_spawn(async move {
            let root = root.ok_or_else(|| "Eido runtime directory is unavailable.".to_string())?;
            let node = node.ok_or_else(|| "Eido Node.js runtime is unavailable.".to_string())?;
            let mut child = Command::new(node)
                .arg(root.join("packages/runtime/bin/pi-settings.mjs"))
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
                        let model_catalog_notice = data["modelCatalogNotice"].as_str().unwrap_or_default().to_owned();
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
                                    let editor = view.runtime_inputs.entry(path.into()).or_insert_with(|| input("settings.placeholder.pi_default", false, window, cx));
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
                            view.browser_engine = data["browserDecision"]["engine"].as_str().unwrap_or("ultrafast").into();
                            view.jev_url.update(cx, |editor, cx| editor.set_text(data["browserDecision"]["apiUrl"].as_str().unwrap_or_default(), window, cx));
                            view.jev_model.update(cx, |editor, cx| editor.set_text(data["browserDecision"]["model"].as_str().unwrap_or_default(), window, cx));
                        }
                        if view.data.is_none() || matches!(operation.as_str(), "status" | "browser-text") {
                            view.browser_text_url.update(cx, |editor, cx| editor.set_text(data["browserText"]["overrideApiUrl"].as_str().or_else(|| data["browserText"]["apiUrl"].as_str()).unwrap_or_default(), window, cx));
                            view.browser_text_model.update(cx, |editor, cx| editor.set_text(data["browserText"]["overrideModel"].as_str().or_else(|| data["browserText"]["model"].as_str()).unwrap_or_default(), window, cx));
                            view.browser_text_reasoning = data["browserText"]["reasoning"].as_str().unwrap_or("low").into();
                        }
                        if view.data.is_none() || matches!(operation.as_str(), "status" | "computer-use") {
                            view.cua_path.update(cx, |editor, cx| editor.set_text(data["computerUse"]["path"].as_str().unwrap_or_default(), window, cx));
                        }
                        if view.data.is_none() || matches!(operation.as_str(), "status" | "research" | "research-test") {
                            view.research_enabled = data["research"]["enabled"].as_bool().unwrap_or(false);
                            view.research_url.update(cx, |editor, cx| editor.set_text(data["research"]["baseUrl"].as_str().unwrap_or_default(), window, cx));
                            for field in data["research"]["limitFields"].as_array().into_iter().flatten() {
                                let Some(name) = field["name"].as_str() else { continue; };
                                let editor = view.research_limits.entry(name.into()).or_insert_with(|| input("settings.placeholder.limit", false, window, cx));
                                editor.update(cx, |editor, cx| editor.set_text(data["research"]["limits"][name].to_string(), window, cx));
                            }
                        }
                        view.data = Some(data);
                        if operation == "custom-model" {
                            view.provider = saved_provider.clone();
                            view.model = saved_model_id.clone();
                            if !view.levels().contains(&view.thinking) { view.thinking = "off".into(); }
                            view.custom_key.update(cx, |editor, cx| editor.set_text("", window, cx));
                            view.key.update(cx, |editor, cx| editor.set_text("", window, cx));
                            view.custom_model_open = false;
                            view.scroll_handle.set_offset(gpui::point(px(0.), px(0.)));
                        }
                        if operation == "key" {
                            view.key.update(cx, |editor, cx| editor.set_text("", window, cx));
                        }
                        if matches!(operation.as_str(), "status" | "import") { view.model_settings.clear(); }
                        if operation == "model-settings" { view.model_settings.remove(&saved_model); }
                        if view.provider.is_empty() {
                            view.provider = view.providers().first().map(|p| p["id"].as_str().unwrap_or_default().into()).unwrap_or_default();
                            view.select_first_model();
                        }
                        view.ensure_model_settings(window, cx);
                        view.notice = match operation.as_str() {
                            "status" => model_catalog_notice,
                            "check-update" => String::new(),
                            "import" => if model_catalog_notice.is_empty() { "Local pi configuration imported. New tasks will use these settings.".into() } else { model_catalog_notice },
                            "defaults" => "Defaults saved for new tasks. Existing tasks keep their models.".into(),
                            "model-settings" => "Model overrides saved. New tasks use them; /reload updates compaction in open tasks. Thinking applies when selecting this model.".into(),
                            "tool-defaults" => "Tool defaults saved. New tasks use this list; /reload adds newly selected tools to the current task.".into(),
                            "runtime" => "Runtime settings saved. Use /reload in an existing task to apply them.".into(),
                            "http-proxy" => "HTTP proxy saved. Restart Eido to apply this change to all tasks.".into(),
                            "browser-text" => "Browser text model saved. New tasks use this configuration.".into(),
                            "browser-decision" => "Browser decision settings saved. New tasks use this configuration.".into(),
                            "computer-use" => "Computer Use configuration saved. New tasks use this configuration.".into(),
                            "research" => "Research configuration saved locally. New requests use these settings; your conversation model is unchanged.".into(),
                            "research-test" => "Connection check finished. Search availability does not confirm OCR availability.".into(),
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

    fn save_research(&mut self, remove_key: bool, window: &mut Window, cx: &mut Context<Self>) {
        let mut limits = serde_json::Map::new();
        for (name, editor) in &self.research_limits {
            let Ok(value) = editor.read(cx).text(cx).trim().parse::<u64>() else {
                self.failed = true; self.notice = "Research limits must be positive whole numbers.".into(); cx.notify(); return;
            };
            limits.insert(name.clone(), json!(value));
        }
        let key = self.research_key.read(cx).text(cx);
        self.research_key.update(cx, |editor, cx| editor.set_text("", window, cx));
        self.request(json!({"operation":"research", "changes":{"enabled":self.research_enabled,
            "baseUrl":self.research_url.read(cx).text(cx), "limits":limits}, "key":key, "removeKey":remove_key,
            "expectedRevision":self.data.as_ref().map(|d| &d["research"]["revision"])}), window, cx);
    }

    fn research_section(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let data = self.data.as_ref().map(|d| d["research"].clone()).unwrap_or(Value::Null);
        v_flex().gap_3().pt_4().border_t_1().border_color(cx.theme().colors().border_variant)
            .child(Label::new(tr(cx, "settings.research.title")))
            .child(Label::new(tr_args(cx, "settings.research.usage", &[("attempts", data["usage"]["attempts"].as_u64().unwrap_or(0).to_string()), ("successful", data["usage"]["successful"].as_u64().unwrap_or(0).to_string()), ("unknown", data["usage"]["unknown"].as_u64().unwrap_or(0).to_string()), ("estimated", format!("{:.4}", data["usage"]["estimatedCny"].as_f64().unwrap_or(0.)))])).size(LabelSize::Small).color(Color::Muted))
            .child(Label::new(tr_args(cx, "settings.research.limits_summary", &[("pages", data["usage"]["ocrPages"].to_string()), ("bytes", data["usage"]["uploadedBytes"].to_string()), ("requests", data["usage"]["remaining"]["attempts24h"].to_string()), ("remaining_pages", data["usage"]["remaining"]["ocrPages24h"].to_string()), ("remaining_bytes", data["usage"]["remaining"]["uploadBytes24h"].to_string())])).size(LabelSize::Small).color(Color::Muted))
            .child(Label::new(owned_message(data["status"].as_str().unwrap_or("Not configured"), cx)).color(Color::Muted))
            .child(Label::new(tr(cx, "settings.research.description")).size(LabelSize::Small).color(Color::Muted))
            .child(Button::new("pi-research-enabled", if self.research_enabled { tr(cx, "settings.choice.enabled") } else { tr(cx, "settings.choice.disabled") }).disabled(self.busy)
                .on_click(cx.listener(|view, _, _, cx| { view.research_enabled = !view.research_enabled; cx.notify(); })))
            .child(field(tr(cx, "settings.research.base_url"), text_field(self.research_url.clone(), cx)))
            .child(field(tr(cx, "settings.research.credential"), text_field(self.research_key.clone(), cx)))
            .child(Label::new(tr(cx, "settings.research.credential_help")).size(LabelSize::Small).color(Color::Muted))
            .children(data["limitFields"].as_array().into_iter().flatten().filter_map(|item| {
                let name = item["name"].as_str()?;
                let editor = self.research_limits.get(name)?;
                Some(v_flex().gap_1().child(field(research_limit_label(name, item["label"].as_str().unwrap_or(name), cx), text_field(editor.clone(), cx)))
                    .child(Label::new(tr_args(cx, "settings.research.range", &[("min", item["min"].to_string()), ("max", item["max"].to_string())])).size(LabelSize::XSmall).color(Color::Muted)))
            }))
            .child(h_flex().gap_2()
                .child(Button::new("pi-save-research", tr(cx, "settings.research.save")).disabled(self.busy).style(ButtonStyle::Outlined)
                    .on_click(cx.listener(|view, _, window, cx| view.save_research(false, window, cx))))
                .child(Button::new("pi-remove-research-key", tr(cx, "settings.research.remove_key")).disabled(self.busy)
                    .on_click(cx.listener(|view, _, window, cx| view.save_research(true, window, cx)))))
            .child(Button::new("pi-test-research", tr(cx, "settings.research.test")).disabled(self.busy)
                .on_click(cx.listener(|view, _, window, cx| view.request(json!({"operation":"research-test"}), window, cx))))
            .child(Label::new(owned_message(data["toolsMessage"].as_str().unwrap_or_default(), cx)).size(LabelSize::Small).color(Color::Muted))
            .into_any_element()
    }

    fn model_key(&self) -> String { format!("{}/{}", self.provider, self.model) }

    fn ensure_model_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.model_settings_open || self.model.is_empty() { return; }
        let key = self.model_key();
        if self.model_settings.contains_key(&key) { return; }
        let expected = self.models().iter().find(|model| model["id"].as_str() == Some(&self.model))
            .map(|model| model["settings"]["values"].clone()).unwrap_or_else(|| json!({}));
        let reserve = input("settings.placeholder.global_default", false, window, cx);
        let recent = input("settings.placeholder.global_default", false, window, cx);
        reserve.update(cx, |editor, cx| editor.set_text(runtime_text(&expected["reserveTokens"]), window, cx));
        recent.update(cx, |editor, cx| editor.set_text(runtime_text(&expected["keepRecentTokens"]), window, cx));
        self.model_settings.insert(key, ModelSettingsDraft {thinking: expected["thinkingLevel"].clone(), expected, reserve, recent});
    }

    fn save_model_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(draft) = self.model_settings.get(&self.model_key()) else { return; };
        let mut values = json!({"thinkingLevel": draft.thinking});
        for (key, editor) in [("reserveTokens", &draft.reserve), ("keepRecentTokens", &draft.recent)] {
            let text = editor.read(cx).text(cx);
            values[key] = if text.trim().is_empty() { Value::Null }
                else if let Ok(value) = text.trim().parse::<u64>() { json!(value) }
                else { self.failed = true; self.notice = "Enter a non-negative whole token count, or leave blank for the global default.".into(); cx.notify(); return; };
        }
        let changes: serde_json::Map<String, Value> = values.as_object().unwrap().iter()
            .filter(|(key, value)| *value != &draft.expected[*key]).map(|(key, value)| (key.clone(), value.clone())).collect();
        if changes.is_empty() { self.failed = false; self.notice = "No model overrides to save.".into(); cx.notify(); return; }
        self.request(json!({"operation":"model-settings", "provider": self.provider, "model": self.model,
            "changes": changes, "expected": draft.expected}), window, cx);
    }

    fn model_settings_section(&self, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let mut section = v_flex().gap_3().child(h_flex().child(Button::new("pi-model-overrides", tr(cx, "settings.model.overrides"))
            .start_icon(Icon::new(if self.model_settings_open { IconName::ChevronDown } else { IconName::ChevronRight }))
            .on_click(cx.listener(|view, _, window, cx| {
                view.model_settings_open = !view.model_settings_open; view.ensure_model_settings(window, cx); cx.notify();
            }))));
        if !self.model_settings_open { return section.into_any_element(); }
        let key = self.model_key();
        let Some(draft) = self.model_settings.get(&key) else { return section.into_any_element(); };
        let selected = draft.thinking.clone();
        let levels = self.levels();
        let weak = cx.entity().downgrade();
        let menu = ContextMenu::build(window, cx, move |mut menu, _, cx| {
            for value in std::iter::once(Value::Null).chain(levels.into_iter().map(Value::String)) {
                let weak = weak.clone(); let key = key.clone();
                let label = if value.is_null() { tr(cx, "settings.placeholder.global_default").to_string() } else { runtime_choice(&value, cx) };
                menu = menu.entry(label, None, move |_, cx| { let _ = weak.update(cx, |view, cx| {
                    if view.busy { return; }
                    if let Some(draft) = view.model_settings.get_mut(&key) { draft.thinking = value.clone(); }
                    cx.notify();
                }); });
            }
            menu
        });
        let effective = self.models().iter().find(|model| model["id"].as_str() == Some(&self.model))
            .map(|model| model["settings"]["effective"].clone()).unwrap_or(Value::Null);
        section = section
            .child(Label::new(tr_args(cx, "settings.model.overrides_for", &[("model", self.model_key())])).size(LabelSize::Small).color(Color::Muted))
            .child(field(tr(cx, "settings.model.thinking"), DropdownMenu::new("pi-model-thinking", if selected.is_null() {tr(cx, "settings.placeholder.global_default").to_string()} else {runtime_choice(&selected, cx)}, menu)
                .style(DropdownStyle::Outlined).full_width(true).into_any_element()))
            .child(field(tr(cx, "settings.model.reserved_tokens"), text_field(draft.reserve.clone(), cx)))
            .child(field(tr(cx, "settings.model.recent_tokens"), text_field(draft.recent.clone(), cx)))
            .child(Label::new(tr_args(cx, "settings.model.effective_limits", &[("reserved", runtime_text(&effective["reserveTokens"])), ("recent", runtime_text(&effective["keepRecentTokens"]))])).size(LabelSize::Small).color(Color::Muted))
            .child(h_flex().child(Button::new("pi-save-model-overrides", tr(cx, "settings.model.save_overrides")).style(ButtonStyle::Outlined).disabled(self.busy)
                .on_click(cx.listener(|view, _, window, cx| view.save_model_settings(window, cx)))));
        section.into_any_element()
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
        let menu = ContextMenu::build(window, cx, move |mut menu, _, cx| {
            for value in std::iter::once(Value::Null).chain(choices) {
                let weak = weak.clone(); let key = key.clone();
                menu = menu.entry(runtime_choice(&value, cx), None, move |_, cx| {
                    let _ = weak.update(cx, |view, cx| {
                        if view.busy { return; }
                        view.runtime_values.insert(key.clone(), value.clone()); cx.notify();
                    });
                });
            }
            menu
        });
        DropdownMenu::new(SharedString::from(format!("pi-runtime-{path}")), runtime_choice(&selected, cx), menu)
            .style(DropdownStyle::Outlined).full_width(true).into_any_element()
    }

    fn runtime_section(&self, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let fields = self.data.as_ref().and_then(|data| data["runtime"].as_array()).cloned().unwrap_or_default();
        let mut section = v_flex().gap_3().pt_4().border_t_1().border_color(cx.theme().colors().border_variant)
            .child(Label::new(tr(cx, "settings.runtime.title")))
            .child(Label::new(tr(cx, "settings.runtime.description")).size(LabelSize::Small).color(Color::Muted));
        for group in ["Messages", "Images", "Context", "Recovery", "Requests", "Thinking Budgets", "Tools"] {
            let open = self.runtime_open.contains(group);
            section = section.child(h_flex().child(Button::new(SharedString::from(format!("pi-runtime-group-{group}")), runtime_group(group, cx))
                .start_icon(Icon::new(if open { IconName::ChevronDown } else { IconName::ChevronRight }))
                .on_click(cx.listener(move |view, _, _, cx| {
                    if !view.runtime_open.remove(group) { view.runtime_open.insert(group.into()); } cx.notify();
                }))));
            if !open { continue; }
            if group == "Messages" {
                section = section.child(Label::new(tr(cx, "settings.runtime.messages_help")).size(LabelSize::Small).color(Color::Muted));
            } else if group == "Requests" {
                section = section.child(Label::new(tr(cx, "settings.runtime.requests_help")).size(LabelSize::Small).color(Color::Muted));
            } else if group == "Thinking Budgets" {
                section = section.child(Label::new(tr(cx, "settings.runtime.thinking_help")).size(LabelSize::Small).color(Color::Muted));
            }
            for field in fields.iter().filter(|field| field["group"] == group) {
                let effective = if field["effective"].is_null() { tr(cx, "settings.choice.provider_default").to_string() } else { runtime_choice(&field["effective"], cx) };
                section = section.child(v_flex().gap_1()
                    .child(h_flex().gap_4().items_center().justify_between()
                        .child(Label::new(runtime_label(field["path"].as_str().unwrap_or_default(), field["label"].as_str().unwrap_or_default(), cx)).size(LabelSize::Small))
                        .child(div().w(px(240.)).child(self.runtime_control(field, window, cx))))
                    .child(Label::new(tr_args(cx, "settings.runtime.current", &[("effective", effective)])).size(LabelSize::XSmall).color(Color::Muted)));
            }
            if group == "Requests" {
                let configured = self.data.as_ref().is_some_and(|data| data["httpProxy"]["configured"] == true);
                section = section.child(v_flex().gap_2().pt_2()
                    .child(Label::new(if configured { tr(cx, "settings.choice.proxy_configured") } else { tr(cx, "settings.choice.proxy_environment") }).size(LabelSize::Small))
                    .child(Label::new(tr(cx, "settings.proxy.help")).size(LabelSize::Small).color(Color::Muted))
                    .child(text_field(self.http_proxy.clone(), cx))
                    .child(h_flex().gap_2()
                        .child(Button::new("pi-save-http-proxy", tr(cx, "settings.proxy.save")).style(ButtonStyle::Outlined).disabled(self.busy)
                            .on_click(cx.listener(|view, _, window, cx| {
                                let proxy = view.http_proxy.read(cx).text(cx);
                                if proxy.trim().is_empty() { view.failed = false; view.notice = "Proxy unchanged. Enter a URL to replace it, or choose Remove Proxy.".into(); cx.notify(); return; }
                                view.request(json!({"operation":"http-proxy", "proxy":proxy, "expected":view.http_proxy_expected}), window, cx);
                            })))
                        .child(Button::new("pi-remove-http-proxy", tr(cx, "settings.proxy.remove")).disabled(self.busy || !configured)
                            .on_click(cx.listener(|view, _, window, cx| view.request(json!({"operation":"http-proxy", "proxy":Value::Null, "expected":view.http_proxy_expected}), window, cx))))));
            }
        }
        section.child(h_flex().child(Button::new("pi-save-runtime", tr(cx, "settings.runtime.save")).style(ButtonStyle::Outlined).disabled(self.busy)
            .on_click(cx.listener(|view, _, window, cx| view.save_runtime(window, cx))))).into_any_element()
    }
    fn service_heading(&self, id: &'static str, label: &'static str, cx: &Context<Self>) -> gpui::AnyElement {
        h_flex().w_full().pb_2().border_b_1().border_color(cx.theme().colors().border_variant)
            .child(Button::new(id, tr(cx, label))
                .start_icon(Icon::new(if self.service_open.contains(id) { IconName::ChevronDown } else { IconName::ChevronRight }))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if !this.service_open.remove(id) { this.service_open.insert(id); }
                    cx.notify();
                }))).into_any_element()
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
        let menu = ContextMenu::build(window, cx, move |mut menu, _, cx| {
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
                            "pi-browser-engine" => view.browser_engine = value.clone(),
                            "pi-browser-text-reasoning" => view.browser_text_reasoning = value.clone(),
                            _ => {}
                        }
                        view.ensure_model_settings(window, cx);
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
fn runtime_choice(value: &Value, cx: &App) -> String {
    let key = match value {
        Value::Null => "settings.placeholder.pi_default",
        Value::Bool(true) => "settings.choice.on",
        Value::Bool(false) => "settings.choice.off",
        Value::String(value) if value == "one-at-a-time" => "settings.choice.one_at_a_time",
        Value::String(value) if value == "all" => "settings.choice.all_pending",
        Value::String(value) if value == "on" => "settings.choice.on",
        Value::String(value) if value == "only" => "settings.runtime.choice.only",
        Value::String(value) if value == "auto" => "settings.runtime.choice.auto",
        Value::String(value) if value == "streaming" => "settings.runtime.choice.streaming",
        Value::String(value) if value == "idle" => "settings.runtime.choice.idle",
        Value::String(value) => return level_label(value, cx),
        _ => return runtime_text(value),
    };
    tr(cx, key).to_string()
}

fn level_label(value: &str, cx: &App) -> String {
    let key = match value {
        "off" => "settings.level.off",
        "none" => "settings.level.none",
        "minimal" => "settings.level.minimal",
        "low" => "settings.level.low",
        "medium" => "settings.level.medium",
        "high" => "settings.level.high",
        "xhigh" => "settings.level.xhigh",
        _ => return value.to_owned(),
    };
    tr(cx, key).to_string()
}

fn field(label: impl Into<SharedString>, element: impl IntoElement) -> gpui::AnyElement {
    v_flex().gap_2().w_full().child(Label::new(label).size(LabelSize::Small)).child(element).into_any_element()
}
fn text_field(editor: Entity<Editor>, cx: &App) -> gpui::AnyElement {
    div().w_full().px_2().py_2().rounded_md().border_1().border_color(cx.theme().colors().border)
        .bg(cx.theme().colors().editor_background).child(editor).into_any_element()
}

impl Render for PiSettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.refresh_placeholders(window, cx);
        let providers = self.providers().iter().map(|p| (p["id"].as_str().unwrap_or_default().to_owned(), p["name"].as_str().unwrap_or_default().to_owned())).collect();
        let models = self.models().iter().map(|m| (m["id"].as_str().unwrap_or_default().to_owned(), m["name"].as_str().unwrap_or_default().to_owned())).collect();
        let levels = self.levels().into_iter().map(|level| (level.clone(), level_label(&level, cx))).collect();
        let provider_name = self.selected_provider().and_then(|p| p["name"].as_str()).map(str::to_owned).unwrap_or_else(|| tr(cx, "settings.choice.select_provider").to_string());
        let model_name = self.models().iter().find(|m| m["id"].as_str() == Some(self.model.as_str())).and_then(|m| m["name"].as_str()).map(str::to_owned).unwrap_or_else(|| tr(cx, "settings.choice.select_model").to_string());
        let credential = self.selected_provider().and_then(|p| p["credential"].as_str()).unwrap_or("none");
        let auth_label = match credential { "oauth" => tr(cx, "settings.choice.oauth_configured"), "api_key" => tr(cx, "settings.choice.key_configured"), "none" => tr(cx, "settings.choice.no_credentials"), _ => tr(cx, "settings.choice.environment_credentials") };
        let version = self.data.as_ref().and_then(|d| d["version"].as_str()).unwrap_or("1.5.2");
        let update = self.data.as_ref().map(|d| &d["update"]);
        let update_label = match update.and_then(|u| u["status"].as_str()) {
            Some("up_to_date") => tr(cx, "settings.choice.update_current").to_string(),
            Some("update_available") => tr_args(cx, "settings.update.available", &[("version", update.and_then(|u| u["latest"].as_str()).unwrap_or_default().to_owned())]).to_string(),
            Some("ahead") => tr(cx, "settings.choice.update_ahead").to_string(),
            Some("error") => tr(cx, "settings.choice.update_error").to_string(),
            _ => tr(cx, "settings.choice.update_unchecked").to_string(),
        };
        let checked_at = update.and_then(|u| u["checkedAt"].as_str()).map(|s| tr_args(cx, "settings.update.checked_at", &[("time", s.to_owned())]));
        let mut content = v_flex().w_full().max_w(px(820.)).gap_6();
        match self.section {
            "models" => {
                content = content
                    .child(h_flex().gap_2().flex_wrap()
                        .child(Button::new("pi-import", tr(cx, "settings.auth.import")).style(ButtonStyle::Outlined).disabled(self.busy)
                            .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"import"}), window, cx))))
                        .child(Button::new("pi-custom-toggle", tr(cx, "settings.connection.custom"))
                            .start_icon(Icon::new(if self.custom_model_open { IconName::ChevronDown } else { IconName::Plus }))
                            .on_click(cx.listener(|this, _, _, cx| { this.custom_model_open = !this.custom_model_open; cx.notify(); }))));
                if self.custom_model_open {
                    content = content.child(v_flex().gap_4()
                        .child(Label::new(tr(cx, "settings.connection.custom_help")).size(LabelSize::Small).color(Color::Muted))
                        .child(field(tr(cx, "settings.connection.provider_id"), text_field(self.custom_provider.clone(), cx)))
                        .child(field(tr(cx, "settings.api.base_url"), text_field(self.custom_url.clone(), cx)))
                        .child(field(tr(cx, "settings.connection.protocol"), self.selector("pi-custom-api", match self.custom_api.as_str() {
                            "openai-responses" => "OpenAI Responses", "anthropic-messages" => "Anthropic Messages", _ => "OpenAI Chat Completions",
                        }.into(), vec![("openai-completions".into(), "OpenAI Chat Completions".into()),
                            ("openai-responses".into(), "OpenAI Responses".into()), ("anthropic-messages".into(), "Anthropic Messages".into())], window, cx)))
                        .child(field(tr(cx, "settings.placeholder.model"), text_field(self.custom_model.clone(), cx)))
                        .child(field(tr(cx, "settings.api.key"), text_field(self.custom_key.clone(), cx)))
                        .child(Label::new(tr(cx, "settings.connection.key_help")).size(LabelSize::Small).color(Color::Muted))
                        .child(h_flex().child(Button::new("pi-save-custom", tr(cx, "settings.connection.save")).style(ButtonStyle::Filled).disabled(self.busy)
                            .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"custom-model",
                                "provider":this.custom_provider.read(cx).text(cx), "baseUrl":this.custom_url.read(cx).text(cx),
                                "api":this.custom_api, "model":this.custom_model.read(cx).text(cx), "key":this.custom_key.read(cx).text(cx)}), window, cx))))));
                } else {
                    content = content.child(v_flex().gap_4()
                        .child(field(tr(cx, "settings.model.provider"), self.selector("pi-provider", provider_name, providers, window, cx)))
                        .child(v_flex().gap_2()
                            .child(h_flex().gap_2().justify_between()
                                .child(Label::new(tr(cx, "settings.api.key")).size(LabelSize::Small))
                                .child(Label::new(auth_label).size(LabelSize::Small).color(Color::Muted)))
                            .child(text_field(self.key.clone(), cx))
                            .when(credential == "none", |this| this.child(Label::new(tr(cx, "settings.connection.missing_key")).size(LabelSize::Small).color(Color::Warning)))
                            .child(h_flex().gap_2()
                                .child(Button::new("pi-save-key", tr(cx, "settings.auth.save_key")).style(ButtonStyle::Outlined).disabled(self.busy || self.provider.is_empty())
                                    .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"key", "provider":this.provider, "key":this.key.read(cx).text(cx)}), window, cx))))
                                .child(Button::new("pi-remove-key", tr(cx, "settings.auth.remove")).disabled(self.busy || credential == "none")
                                    .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"remove-key", "provider":this.provider}), window, cx))))))
                        .child(field(tr(cx, "settings.model.default"), self.selector("pi-model", model_name, models, window, cx)))
                        .child(field(tr(cx, "settings.model.thinking"), self.selector("pi-thinking", level_label(&self.thinking, cx), levels, window, cx)))
                        .child(h_flex().gap_2().flex_wrap()
                            .child(Button::new("pi-save-defaults", tr(cx, "settings.model.save_defaults")).style(ButtonStyle::Filled).disabled(self.busy || self.model.is_empty())
                                .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"defaults", "provider":this.provider,"model":this.model,"thinking":this.thinking}), window, cx))))
                            .child(Button::new("pi-refresh", tr(cx, "settings.reload")).disabled(self.busy)
                                .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"status", "refreshModels":true}), window, cx))))))
                        .child(self.model_settings_section(window, cx));
                }
            }
            "services" => {
                content = content.child(self.service_heading("browser", "settings.browser.title", cx));
                if self.service_open.contains("browser") { content = content
            .child(v_flex().gap_3()
                .child(Label::new(tr(cx, "settings.browser.description")).size(LabelSize::Small).color(Color::Muted))
                .child(field(tr(cx, "settings.browser.execution"), self.selector("pi-browser-engine", if self.browser_engine == "legacy" { "Legacy" } else { "Ultrafast" }.into(),
                    vec![("ultrafast".into(), "Ultrafast".into()), ("legacy".into(), "Legacy".into())], window, cx)))
                .child(Label::new(tr(cx, "settings.browser.engine_help")).size(LabelSize::Small).color(Color::Muted))
                .child(field(tr(cx, "settings.api.endpoint"), text_field(self.jev_url.clone(), cx)))
                .child(field(tr(cx, "settings.model.label"), text_field(self.jev_model.clone(), cx)))
                .child(field(tr(cx, "settings.api.key"), text_field(self.jev_key.clone(), cx)))
                .child(Label::new(match self.data.as_ref().and_then(|d| d["browserDecision"]["credential"].as_str()) {
                    Some("configured") => tr(cx, "settings.choice.key_configured"),
                    Some("environment") => tr(cx, "settings.choice.jev_environment"),
                    _ => tr(cx, "settings.choice.jev_no_key"),
                }).size(LabelSize::Small).color(Color::Muted))
                .child(h_flex().gap_2()
                    .child(Button::new("pi-save-jev", tr(cx, "settings.browser.save")).style(ButtonStyle::Outlined).disabled(self.busy)
                        .on_click(cx.listener(|this, _, window, cx| {
                            let key = this.jev_key.read(cx).text(cx);
                            this.jev_key.update(cx, |editor, cx| editor.set_text("", window, cx));
                            this.request(json!({"operation":"browser-decision", "apiUrl":this.jev_url.read(cx).text(cx),
                                "model":this.jev_model.read(cx).text(cx), "engine":this.browser_engine, "key":key}), window, cx);
                        })))
                    .child(Button::new("pi-remove-jev-key", tr(cx, "settings.api.remove_key")).disabled(self.busy)
                        .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"browser-decision",
                            "apiUrl":this.jev_url.read(cx).text(cx), "model":this.jev_model.read(cx).text(cx), "removeKey":true}), window, cx)))))); }
                content = content.child(self.service_heading("text", "settings.browser_text.title", cx));
                if self.service_open.contains("text") { content = content
            .child(v_flex().gap_3()
                .child(Label::new(tr(cx, "settings.browser_text.description")).size(LabelSize::Small).color(Color::Muted))
                .when_some(self.data.as_ref().and_then(|d| d["browserText"]["message"].as_str()).map(str::to_owned), |this, message| this.child(Label::new(browser_text_message(&message, cx)).size(LabelSize::Small).color(Color::Muted)))
                .child(field(tr(cx, "settings.api.base_url"), text_field(self.browser_text_url.clone(), cx)))
                .child(field(tr(cx, "settings.model.label"), text_field(self.browser_text_model.clone(), cx)))
                .child(field(tr(cx, "settings.api.key"), text_field(self.browser_text_key.clone(), cx)))
                .child(field(tr(cx, "settings.model.reasoning"), self.selector("pi-browser-text-reasoning", level_label(&self.browser_text_reasoning, cx),
                    vec![("low".into(), level_label("low", cx)), ("none".into(), level_label("none", cx))], window, cx)))
                .child(Label::new(match self.data.as_ref().and_then(|d| d["browserText"]["credential"].as_str()) {
                    Some("configured") => tr(cx, "settings.choice.auth_configured"),
                    Some("environment") => tr(cx, "settings.choice.text_environment"),
                    _ => tr(cx, "settings.choice.text_configure"),
                }).size(LabelSize::Small).color(Color::Muted))
                .child(h_flex().gap_2()
                    .child(Button::new("pi-use-main-browser-text", tr(cx, "settings.browser_text.use_main")).style(ButtonStyle::Outlined).disabled(self.busy)
                        .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"browser-text", "source":"pi"}), window, cx))))
                    .child(Button::new("pi-save-browser-text", tr(cx, "settings.browser_text.save")).style(ButtonStyle::Outlined).disabled(self.busy)
                        .on_click(cx.listener(|this, _, window, cx| {
                            let key = this.browser_text_key.read(cx).text(cx);
                            this.browser_text_key.update(cx, |editor, cx| editor.set_text("", window, cx));
                            this.request(json!({"operation":"browser-text", "source":"custom", "apiUrl":this.browser_text_url.read(cx).text(cx),
                                "model":this.browser_text_model.read(cx).text(cx), "reasoning":this.browser_text_reasoning, "key":key}), window, cx);
                        })))
                    .child(Button::new("pi-remove-browser-text-key", tr(cx, "settings.browser_text.remove_key")).disabled(self.busy)
                        .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"browser-text", "removeKey":true}), window, cx)))))); }
                content = content.child(self.service_heading("computer", "settings.computer.title", cx));
                if self.service_open.contains("computer") { content = content
            .child(v_flex().gap_3()
                .child(Label::new(owned_message(self.data.as_ref().and_then(|d| d["computerUse"]["message"].as_str()).unwrap_or("Checking Cua Driver..."), cx)).size(LabelSize::Small).color(Color::Muted))
                .child(field(tr(cx, "settings.computer.executable"), text_field(self.cua_path.clone(), cx)))
                .child(h_flex().gap_2()
                    .children([true, false].into_iter().map(|enabled| {
                        Button::new(if enabled { "pi-enable-cua" } else { "pi-disable-cua" }, if enabled { tr(cx, "settings.choice.computer_enable") } else { tr(cx, "settings.choice.computer_disable") })
                            .disabled(self.busy)
                            .on_click(cx.listener(move |this, _, window, cx| this.request(json!({"operation":"computer-use", "enabled":enabled,
                                "path":this.cua_path.read(cx).text(cx), "expected":this.data.as_ref().map(|d| &d["computerUseRevision"])}), window, cx)))
                    })))
                .child(Label::new(tr(cx, "settings.computer.help")).size(LabelSize::Small).color(Color::Muted))); }
                content = content.child(self.service_heading("research", "settings.research.title", cx));
                if self.service_open.contains("research") { content = content.child(self.research_section(cx)); }
                content = content.child(self.service_heading("tools", "settings.tools.title", cx));
                if self.service_open.contains("tools") { content = content
            .child(v_flex().gap_3().pt_4().border_t_1().border_color(cx.theme().colors().border_variant)
                .child(Label::new(tr(cx, "settings.tools.title")))
                .child(text_field(self.default_tools.clone(), cx))
                .child(Label::new(tr(cx, "settings.tools.defaults_help")).size(LabelSize::Small).color(Color::Muted))
                .child(Label::new(tr(cx, "settings.tools.syntax_help")).size(LabelSize::Small).color(Color::Muted))
                .child(Button::new("pi-save-tool-defaults", tr(cx, "settings.tools.save")).style(ButtonStyle::Outlined).disabled(self.busy)
                    .on_click(cx.listener(|this, _, window, cx| {
                        let text = this.default_tools.read(cx).text(cx);
                        let tools = if text.trim().is_empty() { Value::Null }
                            else if text.trim() == "[]" { json!([]) }
                            else { json!(text.split(',').map(str::trim).collect::<Vec<_>>()) };
                        let expected = this.data.as_ref().map(|data| data["defaultTools"].clone()).unwrap_or(Value::Null);
                        this.request(json!({"operation":"tool-defaults", "tools":tools, "expected":expected}), window, cx);
                    })))); }
            }
            _ => { content = content.child(self.runtime_section(window, cx))
            .child(v_flex().gap_2().pt_4().border_t_1().border_color(cx.theme().colors().border_variant)
                .child(Label::new(tr(cx, "settings.update.title")))
                .child(Label::new(tr_args(cx, "settings.bundled_version", &[("version", version.to_owned())])).size(LabelSize::Small).color(Color::Muted))
                .child(Label::new(update_label).size(LabelSize::Small).color(Color::Muted))
                .when_some(checked_at, |this, text| this.child(Label::new(text).size(LabelSize::XSmall).color(Color::Muted)))
                .child(Button::new("pi-check-update", if self.busy { tr(cx, "settings.choice.please_wait") } else { tr(cx, "settings.choice.check_updates") }).style(ButtonStyle::Outlined).disabled(self.busy)
                    .on_click(cx.listener(|this, _, window, cx| this.request(json!({"operation":"check-update"}), window, cx))))
                .child(Label::new(tr(cx, "settings.update.help")).size(LabelSize::Small).color(Color::Muted))); }
        }
        v_flex().id("eido-pi-settings").size_full().min_h_0()
            .child(v_flex().flex_none().px_8().pt_4().pb_3().gap_3()
                .child(Label::new(tr(cx, "settings.connection.title")).size(LabelSize::Large))
                .child(Label::new(tr(cx, "settings.connection.description")).size(LabelSize::Small).color(Color::Muted))
                .child(h_flex().gap_2().flex_wrap().children([
                    ("models", "settings.section.models"), ("services", "settings.section.services"), ("advanced", "settings.section.advanced"),
                ].into_iter().map(|(id, label)| Button::new(id, tr(cx, label))
                    .style(if self.section == id { ButtonStyle::Filled } else { ButtonStyle::Transparent })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.section = id;
                        this.scroll_handle.set_offset(gpui::point(px(0.), px(0.)));
                        window.blur(cx);
                        cx.notify();
                    }))))))
            .child(v_flex().id("pi-settings-content").flex_1().min_h_0().overflow_y_scroll().track_scroll(&self.scroll_handle).px_8().py_4().gap_4()
                .when(!self.notice.is_empty(), |this| this.child(Label::new(notice_message(&self.notice, self.failed, cx)).size(LabelSize::Small).color(if self.failed { Color::Error } else { Color::Success })))
                .child(content))

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

// This whitelist covers Eido-owned status and notice text from the settings bridge.
// Unknown third-party messages retain their original text. Translation is deferred
// until render, so notices already on screen respond to language changes.
fn settings_message_key(message: &str) -> Option<&'static str> {
    Some(match message {
        "Local pi configuration imported. New tasks will use these settings." => "settings.notice.import_saved",
        "Defaults saved for new tasks. Existing tasks keep their models." => "settings.notice.defaults_saved",
        "Model overrides saved. New tasks use them; /reload updates compaction in open tasks. Thinking applies when selecting this model." => "settings.notice.model_saved",
        "Tool defaults saved. New tasks use this list; /reload adds newly selected tools to the current task." => "settings.notice.tools_saved",
        "Runtime settings saved. Use /reload in an existing task to apply them." => "settings.notice.runtime_saved",
        "HTTP proxy saved. Restart Eido to apply this change to all tasks." => "settings.notice.proxy_saved",
        "Browser text model saved. New tasks use this configuration." => "settings.notice.browser_text_saved",
        "Browser decision settings saved. New tasks use this configuration." => "settings.notice.browser_saved",
        "Computer Use configuration saved. New tasks use this configuration." => "settings.notice.computer_saved",
        "Research configuration saved locally. New requests use these settings; your conversation model is unchanged." => "settings.notice.research_saved",
        "Connection check finished. Search availability does not confirm OCR availability." => "settings.notice.research_checked",
        "Local pi configuration imported. Retired deepseek/deepseek-v4-flash was updated to deepseek/deepseek-flash." => "settings.notice.import_alias",
        "Invalid cached pi model catalog. Nothing was imported." => "settings.notice.invalid_catalog",
        "Model saved. Select it above to make it the default." => "settings.notice.custom_model_saved",
        "pi credentials updated." => "settings.notice.credentials_saved",
        "Research limits must be positive whole numbers." => "settings.notice.invalid_research_limits",
        "Enter a non-negative whole token count, or leave blank for the global default." => "settings.notice.invalid_model_tokens",
        "No model overrides to save." => "settings.notice.no_model_changes",
        "Enter a non-negative whole number, or leave blank for the pi default." => "settings.notice.invalid_runtime_number",
        "No runtime changes to save." => "settings.notice.no_runtime_changes",
        "Proxy unchanged. Enter a URL to replace it, or choose Remove Proxy." => "settings.notice.proxy_unchanged",
        "Eido runtime directory is unavailable." => "settings.notice.no_runtime",
        "Eido Node.js runtime is unavailable." => "settings.notice.no_node",
        "Unable to start pi settings." => "settings.notice.start_failed",
        "Unable to read settings." => "settings.notice.read_failed",
        "Unable to send settings." => "settings.notice.send_failed",
        "The pi settings request did not complete." => "settings.notice.request_incomplete",
        "The pi settings response was invalid." => "settings.notice.invalid_response",
        "Unable to update pi settings." => "settings.notice.update_failed",
        "Not configured" => "settings.notice.not_configured",
        "Disabled" => "settings.notice.disabled",
        "Configured · Not checked" => "settings.notice.configured_unchecked",
        "Connected" => "settings.notice.connected",
        "Authentication failed" => "settings.notice.authentication_failed",
        "Rate limited" => "settings.notice.rate_limited",
        "Unavailable" => "settings.notice.unavailable",
        "Research tools respect task tool defaults and Agent Access." => "settings.notice.research_tools_enabled",
        "Enable Research to make its tools available to new tasks." => "settings.notice.research_tools_disabled",
        "Checking Cua Driver..." => "settings.notice.computer_checking",
        "Cua Driver is not installed or its executable path is unavailable." => "settings.notice.computer_missing",
        "Computer Use is disabled." => "settings.notice.computer_disabled",
        "Eido’s bundled Computer Use driver is configured. Grant Eido Accessibility and Screen Recording access in macOS; connection and tool availability are shown in Extensions." => "settings.notice.computer_bundled",
        "Cua Driver is configured. macOS Accessibility and Screen Recording permissions are required; connection and tool availability are shown in Extensions." => "settings.notice.computer_configured",
        "Choose a main model in global settings to generate browser input text." => "settings.notice.browser_text_no_main",
        "Invalid configuration file format. The file was not changed." => "settings.notice.config_invalid",
        "Provider IDs may only contain letters, numbers, dots, hyphens, and underscores." => "settings.notice.provider_id_invalid",
        "models.json did not pass pi validation. Check the provider, model, and API fields." => "settings.notice.model_validation_failed",
        "Invalid custom model API, URL, or parameters. Configuration was not changed." => "settings.notice.custom_model_invalid",
        "Unable to read pi settings.json. Fix the configuration and try again." => "settings.notice.pi_read_failed",
        "Invalid pi model configuration. Fix models.json and try again." => "settings.notice.pi_model_invalid",
        "Model settings changed while this page was open. Reload before saving." => "settings.notice.model_stale",
        "The selected model is not in the pi catalog." => "settings.notice.model_unknown",
        "Unknown runtime setting. Reload the page and try again." => "settings.notice.runtime_unknown",
        "Invalid model settings request." => "settings.notice.model_bad_request",
        "Invalid runtime settings request." => "settings.notice.runtime_bad_request",
        "Use a supported thinking level or non-negative whole token count." => "settings.notice.model_value_invalid",
        "A settings section has an invalid format. Repair settings.json before saving." => "settings.notice.section_invalid",
        "HTTP proxy changed while this page was open. Reload before saving." => "settings.notice.http_stale",
        "Tool defaults changed while this page was open. Reload the page before saving." => "settings.notice.tools_stale",
        "Enter comma-separated tool names, optional + or - prefixes, or [] for no default file tools." => "settings.notice.tools_invalid",
        "Enter an absolute Cua Driver executable path, or leave blank for automatic discovery." => "settings.notice.computer_path_invalid",
        "Enter a valid DeepSeek API key or environment reference." => "settings.notice.research_key_invalid",
        "Research connection check failed." => "settings.notice.research_check_failed",
        _ => return None,
    })
}

fn owned_message(message: &str, cx: &App) -> SharedString {
    if let Some(key) = settings_message_key(message) { return tr_or(cx, key, message); }
    message.to_owned().into()
}

fn notice_message(message: &str, failed: bool, cx: &App) -> SharedString {
    if let Some(key) = settings_message_key(message) { return tr_or(cx, key, message); }
    if failed { return tr_args(cx, "settings.error_detail", &[("error", message.to_owned())]); }
    message.to_owned().into()
}

fn browser_text_message(message: &str, cx: &App) -> SharedString {
    if let Some(model) = message.strip_prefix("Uses the main model (")
        .and_then(|rest| rest.strip_suffix(") and its pi authentication. Configure an optional override only to use a different text model.")) {
        return tr_args(cx, "settings.browser_text.main_model", &[("model", model.to_owned())]);
    }
    owned_message(message, cx)
}

fn runtime_label(path: &str, fallback: &str, cx: &App) -> SharedString {
    let key = match path {
        "steeringMode" => "settings.runtime.field.steeringMode",
        "followUpMode" => "settings.runtime.field.followUpMode",
        "images.autoResize" => "settings.runtime.field.images.autoResize",
        "images.blockImages" => "settings.runtime.field.images.blockImages",
        "compaction.enabled" => "settings.runtime.field.compaction.enabled",
        "compaction.reserveTokens" => "settings.runtime.field.compaction.reserveTokens",
        "compaction.keepRecentTokens" => "settings.runtime.field.compaction.keepRecentTokens",
        "branchSummary.reserveTokens" => "settings.runtime.field.branchSummary.reserveTokens",
        "branchSummary.skipPrompt" => "settings.runtime.field.branchSummary.skipPrompt",
        "retry.enabled" => "settings.runtime.field.retry.enabled",
        "retry.maxRetries" => "settings.runtime.field.retry.maxRetries",
        "retry.baseDelayMs" => "settings.runtime.field.retry.baseDelayMs",
        "retry.maxAgentDelayMs" => "settings.runtime.field.retry.maxAgentDelayMs",
        "transport" => "settings.runtime.field.transport",
        "httpIdleTimeoutMs" => "settings.runtime.field.httpIdleTimeoutMs",
        "websocketConnectTimeoutMs" => "settings.runtime.field.websocketConnectTimeoutMs",
        "retry.provider.timeoutMs" => "settings.runtime.field.retry.provider.timeoutMs",
        "retry.provider.maxRetries" => "settings.runtime.field.retry.provider.maxRetries",
        "retry.provider.maxRetryDelayMs" => "settings.runtime.field.retry.provider.maxRetryDelayMs",
        "cacheWarming" => "settings.runtime.field.cacheWarming",
        "thinkingBudgets.minimal" => "settings.runtime.field.thinkingBudgets.minimal",
        "thinkingBudgets.low" => "settings.runtime.field.thinkingBudgets.low",
        "thinkingBudgets.medium" => "settings.runtime.field.thinkingBudgets.medium",
        "thinkingBudgets.high" => "settings.runtime.field.thinkingBudgets.high",
        "codemode.mode" => "settings.runtime.field.codemode.mode",
        "codemode.inlineBudget" => "settings.runtime.field.codemode.inlineBudget",
        "enableSkillCommands" => "settings.runtime.field.enableSkillCommands",
        _ => return fallback.to_owned().into(),
    };
    tr_or(cx, key, fallback)
}

fn runtime_group(group: &str, cx: &App) -> SharedString {
    let key = match group {
        "Messages" => "settings.runtime.group.messages",
        "Images" => "settings.runtime.group.images",
        "Context" => "settings.runtime.group.context",
        "Recovery" => "settings.runtime.group.recovery",
        "Requests" => "settings.runtime.group.requests",
        "Thinking Budgets" => "settings.runtime.group.thinking_budgets",
        "Tools" => "settings.runtime.group.tools",
        _ => return group.to_owned().into(),
    };
    tr(cx, key)
}

fn research_limit_label(name: &str, fallback: &str, cx: &App) -> SharedString {
    let key = match name {
        "attempts24h" => "settings.research.limit.attempts24h",
        "uploadBytes24h" => "settings.research.limit.uploadBytes24h",
        "ocrPages24h" => "settings.research.limit.ocrPages24h",
        "attemptsPerTurn" => "settings.research.limit.attemptsPerTurn",
        "httpConcurrency" => "settings.research.limit.httpConcurrency",
        "ocrConcurrency" => "settings.research.limit.ocrConcurrency",
        "fileBytes" => "settings.research.limit.fileBytes",
        "pageBytes" => "settings.research.limit.pageBytes",
        "pdfPages" => "settings.research.limit.pdfPages",
        "responseBytes" => "settings.research.limit.responseBytes",
        "modelTextBytes" => "settings.research.limit.modelTextBytes",
        "searchTimeoutMs" => "settings.research.limit.searchTimeoutMs",
        "ocrTimeoutMs" => "settings.research.limit.ocrTimeoutMs",
        _ => return fallback.to_owned().into(),
    };
    tr_or(cx, key, fallback)
}
