use agent_ui::AgentPanel;
use gpui::{
    Action, App, Context, Entity, EntityId, FocusHandle, Focusable, IntoElement, KeyBinding,
    Render, Subscription, WeakEntity, Window, actions,
};
use project_panel::ProjectPanel;
use terminal_view::terminal_panel::TerminalPanel;
use ui::{
    Button, ButtonSize, ButtonStyle, Color, IconButton, Label, LabelSize, TintColor, Tooltip, prelude::*,
};
use workspace::{EidoLayout, MultiWorkspace, ToggleWorkspaceSidebar, Workspace, dock::Panel};

actions!(
    eido,
    [
        FocusComposer,
        NewConversation,
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
    let composer = cx.new(|cx| Composer::new(panel.clone(), weak.clone(), window, cx));
    let toolbar = cx.new(|cx| Toolbar::new(weak, window, cx));
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
    workspace.register_action(|workspace, _: &NewConversation, window, cx| {
        if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
            workspace.set_eido_layout(EidoLayout::Workbench, cx);
            panel.update(cx, |panel, cx| panel.eido_new_thread(window, cx));
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
                        Label::new(eido_i18n::tr(cx, "workbench.project_files"))
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
    active: Option<(EntityId, Vec<Subscription>)>,
    workspace: WeakEntity<Workspace>,
    new_task: bool,
    _subscriptions: Vec<Subscription>,
}
impl Composer {
    fn new(
        panel: Entity<AgentPanel>,
        workspace: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let subscriptions = vec![
            cx.observe_in(&panel, window, |this, _, window, cx| {
                this.sync_active_thread(window, cx);
                cx.notify();
            }),
            cx.observe(&workspace.upgrade().expect("workspace exists"), |_, _, cx| cx.notify()),
        ];
        let mut this = Self {
            panel,
            active: None,
            workspace,
            new_task: false,
            _subscriptions: subscriptions,
        };
        this.sync_active_thread(window, cx);
        this
    }

    fn sync_active_thread(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let thread = self.panel.read(cx).active_thread_view(cx);
        if self.active.as_ref().map(|(id, _)| *id) != thread.as_ref().map(|thread| thread.entity_id()) {
            self.active = thread.as_ref().map(|thread| {
                let focus = thread.read(cx).message_editor.focus_handle(cx);
                (thread.entity_id(), vec![
                    cx.observe(thread, |this, _, cx| {
                        this.sync_layout(cx);
                        cx.notify();
                    }),
                    cx.on_focus_in(&focus, window, |_, _, cx| cx.notify()),
                    cx.on_focus_out(&focus, window, |_, _, _, cx| cx.notify()),
                ])
            });
        }
        self.sync_layout(cx);
    }

    fn sync_layout(&mut self, cx: &mut Context<Self>) {
        let panel = self.panel.read(cx);
        let thread = panel.active_thread_view(cx);
        let displayed_thread = panel.active_conversation_view().and_then(|view| {
            view.read(cx).as_connected().and_then(|connected| connected.active_view()).cloned()
        });
        let new_task = thread.as_ref().is_some_and(|thread| {
            displayed_thread.as_ref() == Some(thread) && thread.read(cx).eido_is_new_task(cx)
        });
        if new_task != self.new_task {
            self.new_task = new_task;
            let workspace = self.workspace.clone();
            // Panel notifications can arrive during a workspace update.
            // Defer only the presentation flag, never the editor or its draft.
            cx.defer(move |cx| {
                let _ = workspace.update(cx, |workspace, cx| workspace.set_eido_composer_centered(new_task, cx));
            });
        }
    }
}

impl Render for Composer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let panel = self.panel.read(cx);
        let viewing_child = panel.active_conversation_view().and_then(|view| {
            view.read(cx).as_connected().and_then(|connected| connected.active_view()).cloned()
                .filter(|view| view.read(cx).thread.read(cx).parent_session_id().is_some())
        });
        let thread = self.panel.read(cx).active_thread_view(cx);
        let recipient = thread.as_ref().and_then(|thread| thread.read(cx).eido_recipient());
        let recipient_title = recipient.as_ref().and_then(|view| view.read(cx).thread.read(cx).title());
        let delivery_status = thread.as_ref().and_then(|thread| thread.read(cx).eido_delivery_status.clone());
        let recipient_running = recipient.as_ref().or(thread.as_ref()).is_some_and(|view| view.read(cx).eido_is_generating(cx));
        let focused = thread.as_ref().is_some_and(|thread| {
            thread
                .read(cx)
                .message_editor
                .focus_handle(cx)
                .contains_focused(window, cx)
        });
        let centered = self.workspace.read_with(cx, |workspace, cx| workspace.eido_composer_centered(cx)).unwrap_or(false);
        let content_width = thread.as_ref().map(|thread| thread.read(cx).eido_content_width(cx)).unwrap_or(px(780.));
        let compact = window.viewport_size().width < px(1000.);
        let colors = cx.theme().colors();
        v_flex()
            .key_context("AgentPanel")
            .id("eido-composer-surface")
            .w_full()
            .min_w_0()
            .when(centered, |this| this.flex_1().min_h_0().overflow_y_scroll())
            .when(!centered, |this| this.flex_none())
            .bg(cx.theme().colors().editor_background)
            .px(if compact { px(14.) } else { px(20.) })
            .py_4()
            .child(
                v_flex()
                    .w_full()
                    .max_w(content_width)
                    .mx_auto()
                    .flex_none()
                    .when(centered, |this| this.my_auto().py_6())
                    .gap_3()
                    .when(centered, |this| this.child(
                        v_flex()
                            .items_center()
                            .text_center()
                            .gap_3()
                            .pb_5()
                            .child(div().text_size(px(29.)).font_weight(gpui::FontWeight::MEDIUM)
                                .child(eido_i18n::tr(cx, "workbench.welcome")))
                            .child(Label::new(eido_i18n::tr(cx, "workbench.welcome_hint"))
                                .color(Color::Muted)),
                    ))
            .when(viewing_child.is_some() || recipient.is_some() || recipient_running, |this| this.child(
                h_flex()
                    .w_full()
                    .max_w(content_width)
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
                            Label::new(recipient_title.as_ref().map(|recipient| eido_i18n::tr_args(cx, "workbench.to_agent", &[("name", recipient.to_string())])).unwrap_or_else(|| eido_i18n::tr(cx, "workbench.to_main")))
                                .truncate()
                                .size(LabelSize::Small)
                                .color(Color::Muted),
                        ),
                    )
                    .when_some(viewing_child, |this, child| {
                        let root = thread.clone();
                        this.child(Button::new("eido-message-agent", eido_i18n::tr(cx, "workbench.message_agent"))
                            .label_size(LabelSize::Small)
                            .tooltip(Tooltip::text(eido_i18n::tr(cx, "workbench.message_agent_help")))
                            .on_click(move |_, window, cx| {
                                if let Some(root) = &root {
                                    root.update(cx, |root, cx| {
                                        root.eido_set_recipient(Some(child.clone()), cx);
                                        root.message_editor.focus_handle(cx).focus(window, cx);
                                    });
                                }
                            }))
                    })
                    .when(recipient.is_some(), |this| {
                        let root = thread.clone();
                        this.child(Button::new("eido-message-main", eido_i18n::tr(cx, "workbench.main_agent"))
                            .label_size(LabelSize::Small)
                            .on_click(move |_, _, cx| {
                                if let Some(root) = &root { root.update(cx, |root, cx| root.eido_set_recipient(None, cx)); }
                            }))
                    })
                    .when(recipient_running, |this| {
                        let root = thread.clone();
                        this.child(Button::new("eido-send-next", eido_i18n::tr(cx, "workbench.send_next"))
                            .label_size(LabelSize::Small)
                            .tooltip(Tooltip::text(eido_i18n::tr(cx, "workbench.send_next_help")))
                            .on_click(move |_, window, cx| {
                                if let Some(root) = &root { root.update(cx, |root, cx| root.eido_send_next(window, cx)); }
                            }))
                    })
            ))
            .when_some(delivery_status, |this, status| this.child(
                div().w_full().max_w(content_width).mx_auto().px_1()
                    .child(Label::new(status.render(cx)).size(LabelSize::Small).color(Color::Muted))))
            .child(
                div()
                    .key_context("AcpThread")
                    .id("eido-global-composer")
                    .w_full()
                    .max_w(content_width)
                    .mx_auto()
                    .max_h(ui::vh(0.5, window))
                    .rounded(px(12.))
                    .bg(colors.surface_background)
                    .border_1()
                    .border_color(colors.border)
                    .when(focused, |this| this.border_color(colors.border_focused))
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
                                    Label::new(eido_i18n::tr(cx, "workbench.restoring_hint"))
                                        .size(LabelSize::Small)
                                        .color(Color::Muted),
                                ),
                            )
                        }
                    }),
            ),
            )
    }
}

struct Toolbar {
    workspace: WeakEntity<Workspace>,
    focus_handle: FocusHandle,
    _subscriptions: Vec<Subscription>,
}
impl Toolbar {
    fn new(workspace: WeakEntity<Workspace>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let subscription = cx.observe(
            &workspace.upgrade().expect("workspace exists"),
            |_, _, cx| cx.notify(),
        );
        let mut subscriptions = vec![subscription];
        if let Some(multi_workspace) = window.root::<MultiWorkspace>().flatten() {
            subscriptions.push(cx.observe(&multi_workspace, |_, _, cx| cx.notify()));
        }
        Self {
            workspace,
            focus_handle: cx.focus_handle(),
            _subscriptions: subscriptions,
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
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
            .unwrap_or((EidoLayout::Workbench, false, false, false));
        let tasks_open = window.root::<MultiWorkspace>().flatten().is_some_and(|workspace| workspace.read(cx).sidebar_open());
        let colors = cx.theme().colors();
        h_flex()
            .track_focus(&self.focus_handle)
            .w_full()
            .h_full()
            .pl_2()
            .pr_3()
            .gap_1p5()
            .child(
                Button::new("eido-tasks", eido_i18n::tr(cx, "workbench.tasks"))
                    .label_size(LabelSize::Small)
                    .size(ButtonSize::Compact)
                    .style(ButtonStyle::Subtle)
                    .selected_style(ButtonStyle::Tinted(TintColor::Accent))
                    .start_icon(Icon::new(IconName::Thread).size(IconSize::Small))
                    .toggle_state(tasks_open)
                    .tooltip(Tooltip::text(eido_i18n::tr(cx, "workbench.tasks_help")))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.dispatch(&ToggleWorkspaceSidebar, window, cx)
                    })),
            )
            .child(
                Button::new("eido-new-conversation", eido_i18n::tr(cx, "workbench.new_task"))
                    .label_size(LabelSize::Small)
                    .size(ButtonSize::Compact)
                    .style(ButtonStyle::Subtle)
                    .start_icon(Icon::new(IconName::Plus).size(IconSize::Small))
                    .tooltip(Tooltip::text(eido_i18n::tr(cx, "workbench.new_task_help")))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.dispatch(&NewConversation, window, cx)
                    })),
            )
            .child(
                div()
                    .id("eido-titlebar-drag-region")
                    .flex_1()
                    .h_full()
                    .window_control_area(gpui::WindowControlArea::Drag)
                    .when(cfg!(target_os = "macos"), |this| {
                        this.on_mouse_down(gpui::MouseButton::Left, |event, window, cx| {
                            // The toolbar owns focus, so start the native drag from
                            // its empty region while AppKit still has mouse-down.
                            cx.stop_propagation();
                            if window.is_fullscreen() || window.is_simple_fullscreen() {
                                return;
                            }
                            if event.click_count == 2 {
                                window.titlebar_double_click();
                            } else {
                                window.start_window_move();
                            }
                        })
                    }),
            )
            .child(
                h_flex()
                    .gap_0p5()
                    .p_0p5()
                    .rounded_md()
                    .border_1()
                    .border_color(colors.border_variant)
                    .bg(colors.surface_background)
                    .child(
                        Button::new("eido-workbench", eido_i18n::tr(cx, "workbench.task"))
                            .label_size(LabelSize::Small)
                            .size(ButtonSize::Compact)
                            .style(ButtonStyle::Subtle)
                            .start_icon(Icon::new(IconName::Chat).size(IconSize::Small))
                            .toggle_state(layout == EidoLayout::Workbench)
                            .selected_style(ButtonStyle::Tinted(TintColor::Accent))
                            .tooltip(Tooltip::text(eido_i18n::tr(cx, "workbench.task_help")))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.dispatch(&Workbench, window, cx)
                            })),
                    )
                    .child(
                        Button::new("eido-split", eido_i18n::tr(cx, "workbench.split"))
                            .label_size(LabelSize::Small)
                            .size(ButtonSize::Compact)
                            .style(ButtonStyle::Subtle)
                            .start_icon(Icon::new(IconName::Split).size(IconSize::Small))
                            .toggle_state(layout == EidoLayout::Split)
                            .selected_style(ButtonStyle::Tinted(TintColor::Accent))
                            .tooltip(Tooltip::text(eido_i18n::tr(cx, "workbench.split_help")))
                            .on_click(
                                cx.listener(|this, _, window, cx| {
                                    this.dispatch(&Split, window, cx)
                                }),
                            ),
                    )
                    .child(
                        Button::new("eido-files", eido_i18n::tr(cx, "workbench.files"))
                            .label_size(LabelSize::Small)
                            .size(ButtonSize::Compact)
                            .style(ButtonStyle::Subtle)
                            .start_icon(Icon::new(IconName::Code).size(IconSize::Small))
                            .toggle_state(layout == EidoLayout::Files)
                            .selected_style(ButtonStyle::Tinted(TintColor::Accent))
                            .tooltip(Tooltip::text(eido_i18n::tr(cx, "workbench.files_help")))
                            .on_click(
                                cx.listener(|this, _, window, cx| {
                                    this.dispatch(&Files, window, cx)
                                }),
                            ),
                    ),
            )
            .child(div().w(px(1.)).h(px(14.)).bg(colors.border_variant))
            .child(
                IconButton::new("eido-terminal", IconName::Terminal)
                    .icon_size(IconSize::Small)
                    .style(ButtonStyle::Subtle)
                    .toggle_state(terminal_open)
                    .selected_style(ButtonStyle::Tinted(TintColor::Accent))
                    .tooltip(Tooltip::text(if terminal_open {
                        eido_i18n::tr(cx, "workbench.hide_terminal")
                    } else {
                        eido_i18n::tr(cx, "workbench.show_terminal")
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
                        eido_i18n::tr(cx, "workbench.restore_terminal")
                    } else {
                        eido_i18n::tr(cx, "workbench.expand_terminal")
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
                            eido_i18n::tr(cx, "workbench.hide_response")
                        } else {
                            eido_i18n::tr(cx, "workbench.show_response")
                        }))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.dispatch(&ToggleReply, window, cx)
                        })),
                )
            })
    }
}
