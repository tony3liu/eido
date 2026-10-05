use agent_ui::{AgentPanel, thread_metadata_store::ThreadMetadataStore};
use gpui::{
    Action, App, Context, Entity, EntityId, FocusHandle, Focusable, IntoElement, KeyBinding,
    Render, Subscription, WeakEntity, Window, actions,
};
use project_panel::ProjectPanel;
use terminal_view::terminal_panel::TerminalPanel;
use ui::{
    Button, ButtonStyle, Color, IconButton, Label, LabelSize, TintColor, Tooltip, prelude::*,
};
use workspace::{EidoLayout, Workspace, dock::Panel};

actions!(
    eido,
    [
        FocusComposer,
        Submit,
        ToggleWorkbench,
        Split,
        Workbench,
        Files,
        ToggleTerminal,
        ExpandTerminal,
        ToggleReply
    ]
);

pub fn init(cx: &mut App) {
    if std::env::var_os("EIDO_ROOT").is_some() {
        bind_keys(cx);
    }
}

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-shift-j", FocusComposer, None),
        KeyBinding::new("cmd-enter", Submit, Some("AcpThread > Editor")),
        KeyBinding::new("cmd-alt-j", ToggleWorkbench, None),
    ]);
}

pub fn attach(workspace: &mut Workspace, window: &mut Window, cx: &mut Context<Workspace>) {
    if std::env::var_os("EIDO_ROOT").is_none() || workspace.eido_enabled() {
        return;
    }
    let (Some(panel), Some(project), Some(terminal)) = (
        workspace.panel::<AgentPanel>(cx),
        workspace.panel::<ProjectPanel>(cx),
        workspace.panel::<TerminalPanel>(cx),
    ) else {
        return;
    };
    let embedded_panels = vec![panel.entity_id(), project.entity_id(), terminal.entity_id()];
    let weak = workspace.weak_handle();
    let navigation = cx.new(|_| Navigation { project });
    let composer = cx.new(|cx| Composer::new(panel.clone(), cx));
    let toolbar = cx.new(|cx| Toolbar::new(weak, cx));
    workspace.set_eido_views(
        embedded_panels,
        navigation.into(),
        panel.clone().into(),
        composer.into(),
        terminal.into(),
        toolbar.into(),
        cx,
    );
    workspace.register_action(|workspace, _: &FocusComposer, window, cx| {
        if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
            panel.update(cx, |panel, cx| panel.eido_focus_composer(window, cx));
        }
    });
    workspace.register_action(|workspace, _: &Submit, _, cx| {
        if let Some(thread) = workspace
            .panel::<AgentPanel>(cx)
            .and_then(|panel| panel.read(cx).active_thread_view(cx))
        {
            thread
                .read(cx)
                .message_editor
                .clone()
                .update(cx, |editor, cx| editor.send(cx));
        }
    });
    workspace.register_action(|workspace, _: &ToggleWorkbench, _, cx| {
        workspace.toggle_eido_workbench(cx)
    });
    workspace.register_action(|workspace, _: &Split, _, cx| {
        workspace.set_eido_layout(EidoLayout::Split, cx)
    });
    workspace.register_action(|workspace, _: &Workbench, _, cx| {
        workspace.set_eido_layout(EidoLayout::Workbench, cx)
    });
    workspace.register_action(|workspace, _: &Files, _, cx| {
        workspace.set_eido_layout(EidoLayout::Files, cx)
    });
    workspace.register_action(|workspace, _: &ToggleTerminal, window, cx| {
        workspace.toggle_eido_terminal(window, cx);
        let open = workspace.eido_terminal_open(cx);
        if let Some(panel) = workspace.panel::<TerminalPanel>(cx) {
            panel.update(cx, |panel, cx| panel.set_active(open, window, cx));
        }
    });
    workspace.register_action(|workspace, _: &ExpandTerminal, window, cx| {
        workspace.expand_eido_terminal(cx);
        if let Some(panel) = workspace.panel::<TerminalPanel>(cx) {
            panel.update(cx, |panel, cx| panel.set_active(true, window, cx));
        }
    });
    workspace.register_action(|workspace, _: &ToggleReply, _, cx| workspace.toggle_eido_reply(cx));
    panel.update(cx, |panel, cx| panel.eido_initialize(window, cx));
}

struct Navigation {
    project: Entity<ProjectPanel>,
}

impl Render for Navigation {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .size_full()
            .min_h_0()
            .bg(cx.theme().colors().panel_background)
            .child(
                h_flex()
                    .h(ui::Tab::container_height(cx))
                    .flex_none()
                    .px_3()
                    .gap_2()
                    .border_b_1()
                    .border_color(cx.theme().colors().border_variant)
                    .child(
                        Icon::new(IconName::Folder)
                            .size(IconSize::Small)
                            .color(Color::Muted),
                    )
                    .child(
                        Label::new("Project Files")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .child(self.project.clone()),
            )
    }
}

struct Composer {
    panel: Entity<AgentPanel>,
    metadata: Entity<ThreadMetadataStore>,
    active: Option<(EntityId, Vec<Subscription>)>,
    _subscriptions: Vec<Subscription>,
}
impl Composer {
    fn new(panel: Entity<AgentPanel>, cx: &mut Context<Self>) -> Self {
        let metadata = ThreadMetadataStore::global(cx);
        let subscriptions = vec![
            cx.observe(&panel, |_, _, cx| cx.notify()),
            cx.observe(&metadata, |_, _, cx| cx.notify()),
        ];
        Self {
            panel,
            metadata,
            active: None,
            _subscriptions: subscriptions,
        }
    }
}
impl Render for Composer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let panel = self.panel.read(cx);
        let title = panel
            .active_thread_id(cx)
            .and_then(|id| self.metadata.read(cx).entry(id))
            .map(|entry| entry.display_title())
            .or_else(|| {
                panel
                    .active_conversation_view()
                    .map(|view| view.read(cx).title(cx))
            })
            .unwrap_or_else(|| "New Task".into());
        let title = if title.as_ref() == "New Agent Thread" {
            "New Task".into()
        } else {
            title
        };
        let viewing_subagent = panel.active_conversation_view().is_some_and(|view| {
            view.read(cx).as_connected().and_then(|connected| connected.active_view())
                .is_some_and(|view| view.read(cx).thread.read(cx).parent_session_id().is_some())
        });
        let thread = self.panel.read(cx).active_thread_view(cx);
        let focused = thread.as_ref().is_some_and(|thread| {
            thread
                .read(cx)
                .message_editor
                .focus_handle(cx)
                .contains_focused(window, cx)
        });
        if let Some(thread) = &thread {
            if self.active.as_ref().map(|(id, _)| *id) != Some(thread.entity_id()) {
                let focus = thread.read(cx).message_editor.focus_handle(cx);
                self.active = Some((
                    thread.entity_id(),
                    vec![
                        cx.observe(thread, |_, _, cx| cx.notify()),
                        cx.on_focus_in(&focus, window, |_, _, cx| cx.notify()),
                        cx.on_focus_out(&focus, window, |_, _, _, cx| cx.notify()),
                    ],
                ));
            }
        } else {
            self.active = None;
        }
        v_flex()
            .key_context("AgentPanel")
            .w_full()
            .flex_none()
            .bg(cx.theme().colors().editor_background)
            .p_3()
            .gap_2()
            .child(
                h_flex()
                    .w_full()
                    .max_w(px(780.))
                    .mx_auto()
                    .min_w_0()
                    .gap_2()
                    .overflow_hidden()
                    .px_1()
                    .child(
                        Icon::new(IconName::ReplyArrowRight)
                            .size(IconSize::XSmall)
                            .color(Color::Muted),
                    )
                    .child(
                        div().flex_1().min_w_0().child(
                            Label::new(if viewing_subagent { format!("To Main agent · {title}").into() } else { title })
                                .truncate()
                                .size(LabelSize::XSmall)
                                .color(Color::Muted),
                        ),
                    )
                    .child(
                        Label::new("⌘↵ Send")
                            .size(LabelSize::XSmall)
                            .color(Color::Muted),
                    ),
            )
            .child(
                div()
                    .key_context("AcpThread")
                    .id("eido-global-composer")
                    .w_full()
                    .max_w(px(780.))
                    .mx_auto()
                    .max_h(px(300.))
                    .rounded(px(10.))
                    .border_1()
                    .border_color(cx.theme().colors().border)
                    .when(focused, |this| {
                        this.border_color(cx.theme().colors().border_focused)
                    })
                    .overflow_y_scroll()
                    .map(|this| {
                        if let Some(thread) = thread {
                            this.child(
                                thread.update(cx, |thread, cx| {
                                    thread.render_message_editor(window, cx)
                                }),
                            )
                        } else {
                            this.child(
                                div().h(px(112.)).p_3().child(
                                    Label::new("You can continue typing when the session is restored.")
                                        .size(LabelSize::Small)
                                        .color(Color::Muted),
                                ),
                            )
                        }
                    }),
            )
    }
}

struct Toolbar {
    workspace: WeakEntity<Workspace>,
    focus_handle: FocusHandle,
    _subscription: Subscription,
}
impl Toolbar {
    fn new(workspace: WeakEntity<Workspace>, cx: &mut Context<Self>) -> Self {
        let subscription = cx.observe(
            &workspace.upgrade().expect("workspace exists"),
            |_, _, cx| cx.notify(),
        );
        Self {
            workspace,
            focus_handle: cx.focus_handle(),
            _subscription: subscription,
        }
    }

    fn dispatch(&self, action: &dyn Action, window: &mut Window, cx: &mut Context<Self>) {
        // Layout changes can hide the editor that held focus. Route controls
        // through this persistent toolbar so their actions keep reaching the workspace.
        self.focus_handle.focus(window, cx);
        self.focus_handle.dispatch_action(action, window, cx);
    }
}
impl Render for Toolbar {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (layout, terminal_open, expanded, reply_open) = self
            .workspace
            .read_with(cx, |workspace, cx| {
                (
                    workspace.eido_layout(),
                    workspace.eido_terminal_open(cx),
                    workspace.eido_terminal_expanded(),
                    workspace.eido_reply_visible(),
                )
            })
            .unwrap_or((EidoLayout::Split, false, false, false));
        h_flex()
            .track_focus(&self.focus_handle)
            .w_full()
            .h_full()
            .px_3()
            .gap_2()
            .child(div().flex_1())
            .child(
                h_flex()
                    .gap_0p5()
                    .p_0p5()
                    .rounded_md()
                    .bg(cx.theme().colors().element_background)
                    .child(
                        Button::new("eido-split", "Split")
                            .label_size(LabelSize::Small)
                            .start_icon(Icon::new(IconName::Split).size(IconSize::Small))
                            .toggle_state(layout == EidoLayout::Split)
                            .selected_style(ButtonStyle::Tinted(TintColor::Accent))
                            .tooltip(Tooltip::text("Show workbench and code side by side · ⌘⌥J"))
                            .on_click(
                                cx.listener(|this, _, window, cx| {
                                    this.dispatch(&Split, window, cx)
                                }),
                            ),
                    )
                    .child(
                        Button::new("eido-workbench", "Workbench")
                            .label_size(LabelSize::Small)
                            .start_icon(Icon::new(IconName::Chat).size(IconSize::Small))
                            .toggle_state(layout == EidoLayout::Workbench)
                            .selected_style(ButtonStyle::Tinted(TintColor::Accent))
                            .tooltip(Tooltip::text("Focus on the current task"))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.dispatch(&Workbench, window, cx)
                            })),
                    )
                    .child(
                        Button::new("eido-files", "Code")
                            .label_size(LabelSize::Small)
                            .start_icon(Icon::new(IconName::Code).size(IconSize::Small))
                            .toggle_state(layout == EidoLayout::Files)
                            .selected_style(ButtonStyle::Tinted(TintColor::Accent))
                            .tooltip(Tooltip::text("Focus on code with the global composer available"))
                            .on_click(
                                cx.listener(|this, _, window, cx| {
                                    this.dispatch(&Files, window, cx)
                                }),
                            ),
                    ),
            )
            .child(div().w(px(1.)).h(px(16.)).bg(cx.theme().colors().border))
            .child(
                IconButton::new("eido-terminal", IconName::Terminal)
                    .icon_size(IconSize::Small)
                    .toggle_state(terminal_open)
                    .selected_style(ButtonStyle::Tinted(TintColor::Accent))
                    .tooltip(Tooltip::text(if terminal_open {
                        "Hide Terminal"
                    } else {
                        "Show Terminal"
                    }))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.dispatch(&ToggleTerminal, window, cx)
                    })),
            )
            .when(terminal_open, |this| {
                this.child(
                    IconButton::new(
                        "eido-expand-terminal",
                        if expanded {
                            IconName::Minimize
                        } else {
                            IconName::Maximize
                        },
                    )
                    .icon_size(IconSize::Small)
                    .tooltip(Tooltip::text(if expanded {
                        "Restore Terminal Size"
                    } else {
                        "Expand Terminal"
                    }))
                    .on_click(
                        cx.listener(|this, _, window, cx| {
                            this.dispatch(&ExpandTerminal, window, cx)
                        }),
                    ),
                )
            })
            .when(layout == EidoLayout::Files || expanded, |this| {
                this.child(
                    IconButton::new("eido-reply", IconName::Chat)
                        .icon_size(IconSize::Small)
                        .toggle_state(reply_open)
                        .selected_style(ButtonStyle::Tinted(TintColor::Accent))
                        .tooltip(Tooltip::text(if reply_open {
                            "Hide Task Response"
                        } else {
                            "Show Task Response"
                        }))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.dispatch(&ToggleReply, window, cx)
                        })),
                )
            })
    }
}
