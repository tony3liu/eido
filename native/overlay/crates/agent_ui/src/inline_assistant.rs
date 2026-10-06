use crate::AgentPanel;
use gpui::{Context, Window};
use workspace::Workspace;

pub struct InlineAssistant;

impl InlineAssistant {
    pub fn inline_assist(
        workspace: &mut Workspace,
        action: &zed_actions::assistant::InlineAssist,
        window: &mut Window,
        cx: &mut Context<Workspace>,
    ) {
        window.dispatch_action(Box::new(zed_actions::agent::AddSelectionToThread), cx);
        if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
            panel.update(cx, |panel, cx| {
                if let Some(prompt) = action.prompt.as_deref()
                    && let Some(thread) = panel.active_thread_view(cx)
                {
                    thread
                        .read(cx)
                        .message_editor
                        .clone()
                        .update(cx, |editor, cx| {
                            editor.insert_text(prompt, window, cx);
                        });
                }
                panel.eido_focus_composer(window, cx);
            });
        }
    }
}
