mod agent_notification;
mod end_trial_upsell;
mod mention_crease;
mod model_selector_components;
mod sandbox_status_tooltip;
mod session_notice;
mod terminal_tool_header;
mod undo_reject_toast;

pub use agent_notification::*;
pub use end_trial_upsell::*;
pub use mention_crease::*;
pub use model_selector_components::*;
pub use sandbox_status_tooltip::*;
pub use session_notice::*;
pub use terminal_tool_header::*;
pub use undo_reject_toast::*;

/// Returns the appropriate [`DocumentationSide`] for documentation asides
/// in the agent panel, based on the current dock position.
pub fn documentation_aside_side(cx: &gpui::App) -> ui::DocumentationSide {
    use agent_settings::AgentSettings;
    use settings::Settings;
    use ui::DocumentationSide;

    match AgentSettings::get_global(cx).dock {
        settings::DockPosition::Left => DocumentationSide::Right,
        settings::DockPosition::Bottom | settings::DockPosition::Right => DocumentationSide::Left,
    }
}

pub(crate) fn default_markdown_style(
    window: &gpui::Window,
    cx: &gpui::App,
) -> markdown::MarkdownStyle {
    use gpui::{TextStyleRefinement, UnderlineStyle};
    use markdown::MarkdownStyle;
    use settings::Settings as _;
    use theme_settings::ThemeSettings;
    use ui::prelude::*;
    let theme_settings = ThemeSettings::get_global(cx);
    let colors = cx.theme().colors();
    let mut text_style = window.text_style();
    text_style.refine(&TextStyleRefinement {
        font_family: Some(theme_settings.ui_font.family.clone()),
        font_fallbacks: theme_settings.ui_font.fallbacks.clone(),
        font_features: Some(theme_settings.ui_font.features.clone()),
        font_size: Some(TextSize::XSmall.rems(cx).into()),
        color: Some(colors.text_muted),
        ..Default::default()
    });

    MarkdownStyle {
        base_text_style: text_style.clone(),
        selection_background_color: colors.element_selection_background,
        link: TextStyleRefinement {
            background_color: Some(colors.editor_foreground.opacity(0.025)),
            underline: Some(UnderlineStyle {
                color: Some(colors.text_accent.opacity(0.5)),
                thickness: px(1.),
                ..Default::default()
            }),
            ..Default::default()
        },
        ..Default::default()
    }
}
