use std::{io::Write, path::PathBuf, process::{Command, Stdio}};
use gpui::{App, AppContext as _, Context, Window};
use serde_json::{Value, json};
use ui::{Tooltip, ContextMenu, DropdownMenu, DropdownStyle, prelude::*};

pub(crate) use agent_servers::EidoAccess;

pub(crate) fn init(cx: &mut App) {
    if cx.try_global::<EidoAccess>().is_some() { return; }
    cx.set_global(EidoAccess::default());
    if std::env::var_os("EIDO_ROOT").is_some() { request(None, cx); }
}

fn request(full_access: Option<bool>, cx: &mut App) {
    if cx.global::<EidoAccess>().busy { return; }
    cx.update_global::<EidoAccess, _>(|state, _| { state.busy = true; state.error = None; });
    let root = std::env::var_os("EIDO_ROOT").map(PathBuf::from);
    let node = std::env::var_os("EIDO_NODE");
    let task = cx.background_spawn(async move {
        let root = root.ok_or_else(|| "Eido runtime is unavailable.".to_string())?;
        let Some(full_access) = full_access else {
            let enabled = std::fs::read_to_string(root.join(".local/eido/settings.json"))
                .ok().and_then(|content| serde_json::from_str::<Value>(&content).ok())
                .is_some_and(|settings| settings["eido"]["fullAccess"] == true);
            return Ok(enabled);
        };
        let node = node.ok_or_else(|| "Eido Node.js runtime is unavailable.".to_string())?;
        let mut child = Command::new(node).arg(root.join("scripts/pi-settings.mjs"))
            .current_dir(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().map_err(|_| "Unable to update Agent Access.".to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            let body = json!({"operation":"access", "fullAccess":full_access}).to_string();
            stdin.write_all(body.as_bytes()).map_err(|_| "Unable to save Agent Access.".to_string())?;
        }
        let output = child.wait_with_output().map_err(|_| "Agent Access was not saved.".to_string())?;
        let response: Value = serde_json::from_slice(&output.stdout).map_err(|_| "Invalid Agent Access response.".to_string())?;
        if response["ok"] != true { return Err("Agent Access was not saved. Check global pi settings and try again.".into()); }
        Ok(response["data"]["fullAccess"] == true)
    });
    cx.spawn(async move |cx| {
        let result = task.await;
        let _ = cx.update(|cx| cx.update_global::<EidoAccess, _>(|state, _| {
            state.busy = false;
            match result {
                Ok(enabled) => state.full_access = enabled,
                Err(error) => state.error = Some(error),
            }
        }));
    }).detach();
}

pub(crate) fn render<T: 'static>(window: &mut Window, cx: &mut Context<T>) -> impl IntoElement {
    let state = cx.global::<EidoAccess>();
    let full_access = state.full_access;
    let busy = state.busy;
    let tooltip = state.error.clone().unwrap_or_else(|| if full_access {
        "Full Access · Global. pi decides and runs enabled tools without approval prompts. Stop remains available."
    } else {
        "Ask Before Actions · Global. Review tool permissions before pi acts."
    }.to_owned());
    let menu = ContextMenu::build(window, cx, move |menu, _, _| {
        menu.header("Agent Access · Global")
            .toggleable_entry("Ask Before Actions", !full_access, IconPosition::Start, None, |_, cx| request(Some(false), cx))
            .toggleable_entry("Full Access", full_access, IconPosition::Start, None, |_, cx| request(Some(true), cx))
    });
    let label = if full_access { "Full Access" } else { "Ask Before Actions" };
    DropdownMenu::new_with_element(
        "eido-agent-access",
        h_flex().gap_1()
            .child(Label::new(label).size(LabelSize::Small).color(Color::Muted))
            .child(Icon::new(IconName::ChevronDown).size(IconSize::XSmall).color(Color::Muted))
            .into_any_element(),
        menu,
    )
        .style(DropdownStyle::Ghost).no_chevron().disabled(busy)
        .aria_label("Agent Access").aria_value(label)
        .trigger_tooltip(Tooltip::text(tooltip))
}
