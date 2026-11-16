use std::{io::Write, path::PathBuf, process::{Command, Stdio}};
use gpui::{App, AppContext as _, Context, Window};
use serde_json::{Value, json};
use ui::{Tooltip, ContextMenu, PopoverMenu, prelude::*};

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
            let enabled = std::fs::read_to_string(std::env::var_os("EIDO_PI_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| root.join(".local/eido")).join("settings.json"))
                .ok().and_then(|content| serde_json::from_str::<Value>(&content).ok())
                .is_some_and(|settings| settings["eido"]["fullAccess"] == true);
            return Ok(enabled);
        };
        let node = node.ok_or_else(|| "Eido Node.js runtime is unavailable.".to_string())?;
        let mut child = Command::new(node).arg(root.join("packages/runtime/bin/pi-settings.mjs"))
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

pub(crate) fn refresh(cx: &mut App) { request(None, cx); }

pub(crate) fn render<T: 'static>(_window: &mut Window, cx: &mut Context<T>) -> impl IntoElement {
    let state = cx.global::<EidoAccess>();
    let full_access = state.full_access;
    let busy = state.busy;
    let tooltip = if let Some(error) = state.error.as_deref() {
        let key = match error {
            "Eido runtime is unavailable." => Some("access.error_runtime"),
            "Eido Node.js runtime is unavailable." => Some("access.error_node"),
            "Unable to update Agent Access." => Some("access.error_update"),
            "Unable to save Agent Access." => Some("access.error_save"),
            "Agent Access was not saved." => Some("access.error_unsaved"),
            "Invalid Agent Access response." => Some("access.error_response"),
            "Agent Access was not saved. Check global pi settings and try again." => Some("access.error_settings"),
            _ => None,
        };
        key.map(|key| eido_i18n::tr(cx, key)).unwrap_or_else(|| eido_i18n::tr_args(cx, "access.error_raw", &[("error", error.to_owned())]))
    } else {
        eido_i18n::tr(cx, if full_access { "access.full_help" } else { "access.ask_help" })
    };
    let label = eido_i18n::tr(cx, if full_access { "access.full" } else { "access.ask" });
    let aria_label = eido_i18n::tr_args(cx, "access.aria", &[("name", label.to_string())]);
    PopoverMenu::new("eido-agent-access")
        .trigger_with_tooltip(
            Button::new("eido-agent-access-trigger", label)
                .label_size(LabelSize::Small)
                .color(Color::Muted)
                .end_icon(Icon::new(IconName::ChevronDown).size(IconSize::XSmall).color(Color::Muted))
                .aria_label(aria_label)
                .disabled(busy),
            Tooltip::text(tooltip),
        )
        .menu(move |window, cx| {
            Some(ContextMenu::build(window, cx, move |mut menu, window, cx| {
                menu = menu.fixed_width(rems(13.).into());
                for (name, enabled) in [("access.ask", false), ("access.full", true)] {
                    menu = menu.custom_entry(
                        move |_, cx| {
                            h_flex().w_full().h_6().gap_3().justify_between()
                                .child(Label::new(eido_i18n::tr(cx, name)).size(LabelSize::Small))
                                .child(div().flex_none()
                                    .child(Icon::new(IconName::Check).size(IconSize::XSmall).color(Color::Muted))
                                    .when(full_access != enabled, |this| this.invisible()))
                                .into_any_element()
                        },
                        move |_, cx| request(Some(enabled), cx),
                    );
                }
                if full_access { menu.select_last(window, cx); }
                menu
            }))
        })
        .anchor(gpui::Anchor::BottomRight)
        .offset(gpui::point(px(0.), px(-4.)))
}
