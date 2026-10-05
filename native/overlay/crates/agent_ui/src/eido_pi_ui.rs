use std::collections::BTreeMap;
use serde::Deserialize;
use ui::{prelude::*, Color, Label, LabelSize};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PiWidget {
    pub lines: Vec<String>,
    pub placement: String,
    #[serde(default)]
    pub component: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PiWorkingIndicator {
    pub frames: Option<Vec<String>>,
    pub interval_ms: Option<u64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PiUiState {
    pub statuses: BTreeMap<String, String>,
    pub widgets: BTreeMap<String, PiWidget>,
    pub header: Option<Vec<String>>,
    pub footer: Option<Vec<String>>,
    pub working_message: Option<String>,
    pub working_visible: bool,
    pub working_indicator: Option<PiWorkingIndicator>,
    pub hidden_thinking_label: Option<String>,
}

impl Default for PiUiState {
    fn default() -> Self {
        Self {statuses: BTreeMap::new(), widgets: BTreeMap::new(), header: None, footer: None, working_message: None,
            working_visible: true, working_indicator: None, hidden_thinking_label: None}
    }
}

impl PiUiState {
    pub fn widgets(&self, placement: &str, cx: &App) -> AnyElement {
        v_flex().w_full().gap_1().children(self.widgets.iter()
            .filter(|(_, widget)| widget.placement == placement)
            .map(|(key, widget)| if widget.component { Self::component(format!("pi-widget-{key}").into(), &widget.lines, cx) } else {
                v_flex().w_full().children(widget.lines.iter().map(|line|
                    Label::new(line.clone()).size(LabelSize::Small).color(Color::Muted))).into_any_element()
            })).into_any_element()
    }

    pub fn component(id: SharedString, lines: &[String], cx: &App) -> AnyElement {
        v_flex().id(id).w_full().max_h(px(160.)).font_buffer(cx).text_size(px(12.)).overflow_y_scroll().overflow_x_hidden()
            .children(lines.iter().map(|line| {
                let parsed = terminal::parse_ansi_text(line.as_bytes());
                // Foreground and background changes may have different boundaries.
                let mut boundaries = std::collections::BTreeSet::from([0, parsed.text.len()]);
                for (range, _) in parsed.foreground_spans.iter().chain(parsed.background_spans.iter()) {
                    boundaries.insert(range.start); boundaries.insert(range.end);
                }
                let boundaries = boundaries.into_iter().collect::<Vec<_>>();
                let highlights = boundaries.windows(2).filter_map(|pair| {
                    let color_at = |spans: &terminal::AnsiSpans| spans.iter()
                        .find(|(range, _)| range.contains(&pair[0])).and_then(|(_, color)| *color)
                        .map(|color| terminal_view::terminal_element::convert_color(&color, cx.theme()));
                    let color = color_at(&parsed.foreground_spans);
                    let background_color = color_at(&parsed.background_spans);
                    (color.is_some() || background_color.is_some()).then_some((pair[0]..pair[1],
                        gpui::HighlightStyle { color, background_color, ..Default::default() }))
                }).collect::<Vec<_>>();
                div().w_full().min_h(px(16.)).child(gpui::StyledText::new(parsed.text).with_highlights(highlights))
            })).into_any_element()
    }

    pub fn statuses(&self) -> AnyElement {
        h_flex().w_full().flex_wrap().gap_2().children(self.statuses.iter().map(|(key, text)|
            div().id(SharedString::from(format!("pi-status-{key}")))
                .child(Label::new(text.clone()).size(LabelSize::XSmall).color(Color::Muted)))).into_any_element()
    }
}
