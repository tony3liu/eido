use std::collections::BTreeMap;
use serde::Deserialize;
use ui::{prelude::*, Color, Label, LabelSize};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PiWidget {
    pub lines: Vec<String>,
    pub placement: String,
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
    pub working_message: Option<String>,
    pub working_visible: bool,
    pub working_indicator: Option<PiWorkingIndicator>,
    pub hidden_thinking_label: Option<String>,
}

impl Default for PiUiState {
    fn default() -> Self {
        Self {statuses: BTreeMap::new(), widgets: BTreeMap::new(), working_message: None,
            working_visible: true, working_indicator: None, hidden_thinking_label: None}
    }
}

impl PiUiState {
    pub fn widgets(&self, placement: &str) -> AnyElement {
        v_flex().w_full().gap_1().children(self.widgets.values()
            .filter(|widget| widget.placement == placement)
            .map(|widget| v_flex().w_full().children(widget.lines.iter().map(|line|
                Label::new(line.clone()).size(LabelSize::Small).color(Color::Muted))))).into_any_element()
    }

    pub fn statuses(&self) -> AnyElement {
        h_flex().w_full().flex_wrap().gap_2().children(self.statuses.iter().map(|(key, text)|
            div().id(SharedString::from(format!("pi-status-{key}")))
                .child(Label::new(text.clone()).size(LabelSize::XSmall).color(Color::Muted)))).into_any_element()
    }
}
