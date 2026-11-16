use collab_ui::collab_panel;
use gpui::{App, Menu, MenuItem, OsAction};
use project::DisableAiSettings;
use release_channel::ReleaseChannel;
use settings::Settings;
use terminal_view::terminal_panel;
use zed_actions::{Quit, assistant, debug_panel, dev, git_panel, project_panel};

pub fn app_menus(cx: &mut App) -> Vec<Menu> {
    let mut view_items = vec![
        MenuItem::action(
            eido_i18n::tr(cx, "menu.zoom_in"),
            zed_actions::IncreaseBufferFontSize { persist: false },
        ),
        MenuItem::action(
            eido_i18n::tr(cx, "menu.zoom_out"),
            zed_actions::DecreaseBufferFontSize { persist: false },
        ),
        MenuItem::action(
            eido_i18n::tr(cx, "menu.reset_zoom"),
            zed_actions::ResetBufferFontSize { persist: false },
        ),
        MenuItem::action(
            eido_i18n::tr(cx, "menu.reset_all_zoom"),
            zed_actions::ResetAllZoom { persist: false },
        ),
        MenuItem::separator(),
        MenuItem::action(eido_i18n::tr(cx, "menu.toggle_left_dock"), workspace::ToggleLeftDock),
        MenuItem::action(eido_i18n::tr(cx, "menu.toggle_right_dock"), workspace::ToggleRightDock),
        MenuItem::action(eido_i18n::tr(cx, "menu.toggle_bottom_dock"), workspace::ToggleBottomDock),
        MenuItem::action(eido_i18n::tr(cx, "menu.toggle_all_docks"), workspace::ToggleAllDocks),
        MenuItem::submenu(Menu {
            name: eido_i18n::tr(cx, "menu.editor_layout"),
            disabled: false,
            items: vec![
                MenuItem::action(eido_i18n::tr(cx, "menu.split_up"), workspace::SplitUp::default()),
                MenuItem::action(eido_i18n::tr(cx, "menu.split_down"), workspace::SplitDown::default()),
                MenuItem::action(eido_i18n::tr(cx, "menu.split_left"), workspace::SplitLeft::default()),
                MenuItem::action(eido_i18n::tr(cx, "menu.split_right"), workspace::SplitRight::default()),
            ],
        }),
        MenuItem::separator(),
        MenuItem::action(eido_i18n::tr(cx, "menu.project_panel"), project_panel::ToggleFocus),
        MenuItem::action(eido_i18n::tr(cx, "menu.outline_panel"), outline_panel::ToggleFocus),
        MenuItem::action(eido_i18n::tr(cx, "menu.collab_panel"), collab_panel::ToggleFocus),
        MenuItem::action(eido_i18n::tr(cx, "menu.terminal_panel"), terminal_panel::Toggle),
        MenuItem::action(eido_i18n::tr(cx, "menu.debugger_panel"), debug_panel::ToggleFocus),
    ];

    if !DisableAiSettings::get_global(cx).disable_ai {
        view_items.push(MenuItem::action(eido_i18n::tr(cx, "menu.agent_panel"), assistant::ToggleFocus));
    }

    view_items.extend([
        MenuItem::action(eido_i18n::tr(cx, "menu.git_panel"), git_panel::ToggleFocus),
        MenuItem::separator(),
        MenuItem::action(eido_i18n::tr(cx, "menu.diagnostics"), diagnostics::Deploy),
        MenuItem::separator(),
    ]);

    if ReleaseChannel::try_global(cx) == Some(ReleaseChannel::Dev) {
        view_items.push(MenuItem::action(
            eido_i18n::tr(cx, "menu.toggle_gpui_inspector"),
            dev::ToggleInspector,
        ));
        view_items.push(MenuItem::separator());
    }

    vec![
        Menu {
            name: "Eido".into(),
            disabled: false,
            items: vec![
                MenuItem::action(eido_i18n::tr(cx, "menu.about_eido"), zed_actions::About),
                MenuItem::action(eido_i18n::tr(cx, "menu.check_for_updates"), auto_update::Check),
                MenuItem::separator(),
                MenuItem::submenu(Menu::new(eido_i18n::tr(cx, "menu.settings")).items([
                    MenuItem::action(eido_i18n::tr(cx, "menu.open_settings"), zed_actions::OpenSettings),
                    MenuItem::action(eido_i18n::tr(cx, "menu.open_settings_file"), super::OpenSettingsFile),
                    MenuItem::action(eido_i18n::tr(cx, "menu.open_default_settings"), super::OpenDefaultSettings),
                    MenuItem::separator(),
                    MenuItem::action(eido_i18n::tr(cx, "menu.open_keymap"), zed_actions::OpenKeymap),
                    MenuItem::action(eido_i18n::tr(cx, "menu.open_keymap_file"), zed_actions::OpenKeymapFile),
                    MenuItem::action(eido_i18n::tr(cx, "menu.open_default_key_bindings"), zed_actions::OpenDefaultKeymap),
                    MenuItem::separator(),
                    MenuItem::action(
                        eido_i18n::tr(cx, "menu.select_theme"),
                        zed_actions::theme_selector::Toggle::default(),
                    ),
                    MenuItem::action(
                        eido_i18n::tr(cx, "menu.select_icon_theme"),
                        zed_actions::icon_theme_selector::Toggle::default(),
                    ),
                ])),
                MenuItem::separator(),
                #[cfg(target_os = "macos")]
                MenuItem::os_submenu("Services", gpui::SystemMenuType::Services),
                MenuItem::separator(),
                MenuItem::action(eido_i18n::tr(cx, "menu.extensions"), zed_actions::Extensions::default()),
                #[cfg(not(target_os = "windows"))]
                MenuItem::action(eido_i18n::tr(cx, "menu.install_cli"), install_cli::InstallCliBinary),
                MenuItem::separator(),
                #[cfg(target_os = "macos")]
                MenuItem::action(eido_i18n::tr(cx, "menu.hide_eido"), super::Hide),
                #[cfg(target_os = "macos")]
                MenuItem::action(eido_i18n::tr(cx, "menu.hide_others"), super::HideOthers),
                #[cfg(target_os = "macos")]
                MenuItem::action(eido_i18n::tr(cx, "menu.show_all"), super::ShowAll),
                MenuItem::separator(),
                MenuItem::action(eido_i18n::tr(cx, "menu.quit_eido"), Quit),
            ],
        },
        Menu {
            name: eido_i18n::tr(cx, "menu.file"),
            disabled: false,
            items: vec![
                MenuItem::action(eido_i18n::tr(cx, "menu.new"), workspace::NewFile),
                MenuItem::action(eido_i18n::tr(cx, "menu.new_window"), workspace::NewWindow),
                MenuItem::separator(),
                #[cfg(not(target_os = "macos"))]
                MenuItem::action(eido_i18n::tr(cx, "menu.open_file"), workspace::OpenFiles),
                MenuItem::action(
                    if cfg!(not(target_os = "macos")) {
                        eido_i18n::tr(cx, "menu.open_folder")
                    } else {
                        eido_i18n::tr(cx, "menu.open")
                    },
                    workspace::Open::default(),
                ),
                MenuItem::action(eido_i18n::tr(cx, "menu.open_recent"), zed_actions::OpenRecent::default()),
                MenuItem::action(eido_i18n::tr(cx, "menu.open_remote"), zed_actions::OpenRemote::default()),
                MenuItem::separator(),
                MenuItem::action(eido_i18n::tr(cx, "menu.add_folder_to_project"), workspace::AddFolderToProject),
                MenuItem::separator(),
                MenuItem::action(eido_i18n::tr(cx, "menu.save"), workspace::Save { save_intent: None }),
                MenuItem::action(eido_i18n::tr(cx, "menu.save_as"), workspace::SaveAs),
                MenuItem::action(eido_i18n::tr(cx, "menu.save_all"), workspace::SaveAll { save_intent: None }),
                MenuItem::separator(),
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.close_editor"),
                    workspace::CloseActiveItem {
                        save_intent: None,
                        close_pinned: true,
                    },
                ),
                MenuItem::action(eido_i18n::tr(cx, "menu.close_project"), workspace::CloseProject),
                MenuItem::action(eido_i18n::tr(cx, "menu.close_window"), workspace::CloseWindow),
            ],
        },
        Menu {
            name: eido_i18n::tr(cx, "menu.edit"),
            disabled: false,
            items: vec![
                MenuItem::os_action(eido_i18n::tr(cx, "menu.undo"), editor::actions::Undo, OsAction::Undo),
                MenuItem::os_action(eido_i18n::tr(cx, "menu.redo"), editor::actions::Redo, OsAction::Redo),
                MenuItem::separator(),
                MenuItem::os_action(eido_i18n::tr(cx, "menu.cut"), editor::actions::Cut, OsAction::Cut),
                MenuItem::os_action(eido_i18n::tr(cx, "menu.copy"), editor::actions::Copy, OsAction::Copy),
                MenuItem::action(eido_i18n::tr(cx, "menu.copy_and_trim"), editor::actions::CopyAndTrim),
                MenuItem::os_action(eido_i18n::tr(cx, "menu.paste"), editor::actions::Paste, OsAction::Paste),
                MenuItem::separator(),
                MenuItem::action(eido_i18n::tr(cx, "menu.find"), search::buffer_search::Deploy::find()),
                MenuItem::action(eido_i18n::tr(cx, "menu.find_in_project"), workspace::DeploySearch::default()),
                MenuItem::separator(),
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.toggle_line_comment"),
                    editor::actions::ToggleComments::default(),
                ),
            ],
        },
        Menu {
            name: eido_i18n::tr(cx, "menu.selection"),
            disabled: false,
            items: vec![
                MenuItem::os_action(
                    eido_i18n::tr(cx, "menu.select_all"),
                    editor::actions::SelectAll,
                    OsAction::SelectAll,
                ),
                MenuItem::action(eido_i18n::tr(cx, "menu.expand_selection"), editor::actions::SelectLargerSyntaxNode),
                MenuItem::action(eido_i18n::tr(cx, "menu.shrink_selection"), editor::actions::SelectSmallerSyntaxNode),
                MenuItem::action(eido_i18n::tr(cx, "menu.select_next_sibling"), editor::actions::SelectNextSyntaxNode),
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.select_previous_sibling"),
                    editor::actions::SelectPreviousSyntaxNode,
                ),
                MenuItem::separator(),
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.add_cursor_above"),
                    editor::actions::AddSelectionAbove {
                        skip_soft_wrap: true,
                    },
                ),
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.add_cursor_below"),
                    editor::actions::AddSelectionBelow {
                        skip_soft_wrap: true,
                    },
                ),
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.select_next_occurrence"),
                    editor::actions::SelectNext {
                        replace_newest: false,
                    },
                ),
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.select_previous_occurrence"),
                    editor::actions::SelectPrevious {
                        replace_newest: false,
                    },
                ),
                MenuItem::action(eido_i18n::tr(cx, "menu.select_all_occurrences"), editor::actions::SelectAllMatches),
                MenuItem::separator(),
                MenuItem::action(eido_i18n::tr(cx, "menu.move_line_up"), editor::actions::MoveLineUp),
                MenuItem::action(eido_i18n::tr(cx, "menu.move_line_down"), editor::actions::MoveLineDown),
                MenuItem::action(eido_i18n::tr(cx, "menu.duplicate_selection"), editor::actions::DuplicateLineDown),
            ],
        },
        Menu {
            name: eido_i18n::tr(cx, "menu.view"),
            disabled: false,
            items: view_items,
        },
        Menu {
            name: eido_i18n::tr(cx, "menu.go"),
            disabled: false,
            items: vec![
                MenuItem::action(eido_i18n::tr(cx, "menu.back"), workspace::GoBack),
                MenuItem::action(eido_i18n::tr(cx, "menu.forward"), workspace::GoForward),
                MenuItem::separator(),
                MenuItem::action(eido_i18n::tr(cx, "menu.command_palette"), zed_actions::command_palette::Toggle),
                MenuItem::separator(),
                MenuItem::action(eido_i18n::tr(cx, "menu.go_to_file"), workspace::ToggleFileFinder::default()),
                // MenuItem::action(eido_i18n::tr(cx, "menu.go_to_symbol_in_project"), project_symbols::Toggle),
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.go_to_symbol_in_editor"),
                    zed_actions::outline::ToggleOutline,
                ),
                MenuItem::action(eido_i18n::tr(cx, "menu.go_to_line_column"), editor::actions::ToggleGoToLine),
                MenuItem::separator(),
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.go_to_definition"),
                    editor::actions::GoToDefinition::default(),
                ),
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.go_to_declaration"),
                    editor::actions::GoToDeclaration::default(),
                ),
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.go_to_type_definition"),
                    editor::actions::GoToTypeDefinition::default(),
                ),
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.find_all_references"),
                    editor::actions::FindAllReferences::default(),
                ),
                MenuItem::action(eido_i18n::tr(cx, "menu.show_incoming_calls"), call_hierarchy::ShowIncomingCalls),
                MenuItem::action(eido_i18n::tr(cx, "menu.show_outgoing_calls"), call_hierarchy::ShowOutgoingCalls),
                MenuItem::separator(),
                MenuItem::action(eido_i18n::tr(cx, "menu.next_problem"), editor::actions::GoToDiagnostic::default()),
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.previous_problem"),
                    editor::actions::GoToPreviousDiagnostic::default(),
                ),
            ],
        },
        Menu {
            name: eido_i18n::tr(cx, "menu.run"),
            disabled: false,
            items: vec![
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.spawn_task"),
                    zed_actions::Spawn::ViaModal {
                        reveal_target: None,
                    },
                ),
                MenuItem::action(eido_i18n::tr(cx, "menu.start_debugger"), debugger_ui::Start),
                MenuItem::separator(),
                MenuItem::action(eido_i18n::tr(cx, "menu.edit_tasks_json"), zed_actions::OpenProjectTasks),
                MenuItem::action(eido_i18n::tr(cx, "menu.edit_debug_json"), zed_actions::OpenProjectDebugTasks),
                MenuItem::separator(),
                MenuItem::action(eido_i18n::tr(cx, "menu.continue"), debugger_ui::Continue),
                MenuItem::action(eido_i18n::tr(cx, "menu.step_over"), debugger_ui::StepOver),
                MenuItem::action(eido_i18n::tr(cx, "menu.step_into"), debugger_ui::StepInto),
                MenuItem::action(eido_i18n::tr(cx, "menu.step_out"), debugger_ui::StepOut),
                MenuItem::separator(),
                MenuItem::action(eido_i18n::tr(cx, "menu.toggle_breakpoint"), editor::actions::ToggleBreakpoint),
                MenuItem::action(eido_i18n::tr(cx, "menu.edit_breakpoint"), editor::actions::EditLogBreakpoint),
                MenuItem::action(eido_i18n::tr(cx, "menu.clear_all_breakpoints"), debugger_ui::ClearAllBreakpoints),
            ],
        },
        Menu {
            name: eido_i18n::tr(cx, "menu.window"),
            disabled: false,
            items: vec![
                MenuItem::action(eido_i18n::tr(cx, "menu.minimize"), super::Minimize),
                MenuItem::action(eido_i18n::tr(cx, "menu.zoom"), super::Zoom),
                MenuItem::separator(),
            ],
        },
        Menu {
            name: eido_i18n::tr(cx, "menu.help"),
            disabled: false,
            items: vec![
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.view_release_notes_locally"),
                    auto_update_ui::ViewReleaseNotesLocally,
                ),
                MenuItem::action(eido_i18n::tr(cx, "menu.view_telemetry"), zed_actions::OpenTelemetryLog),
                MenuItem::action(eido_i18n::tr(cx, "menu.view_dependency_licenses"), zed_actions::OpenLicenses),
                MenuItem::action(eido_i18n::tr(cx, "menu.show_welcome"), onboarding::ShowWelcome),
                MenuItem::separator(),
                MenuItem::action(eido_i18n::tr(cx, "menu.file_bug_report"), zed_actions::feedback::FileBugReport),
                MenuItem::action(eido_i18n::tr(cx, "menu.request_feature"), zed_actions::feedback::RequestFeature),
                MenuItem::action(eido_i18n::tr(cx, "menu.email_us"), zed_actions::feedback::EmailZed),
                MenuItem::separator(),
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.documentation"),
                    super::OpenBrowser {
                        url: "https://zed.dev/docs".into(),
                    },
                ),
                MenuItem::action(eido_i18n::tr(cx, "menu.zed_repository"), feedback::OpenZedRepo),
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.zed_twitter"),
                    super::OpenBrowser {
                        url: "https://twitter.com/zeddotdev".into(),
                    },
                ),
                MenuItem::action(
                    eido_i18n::tr(cx, "menu.join_the_team"),
                    super::OpenBrowser {
                        url: "https://zed.dev/jobs".into(),
                    },
                ),
            ],
        },
    ]
}
