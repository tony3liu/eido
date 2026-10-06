pub mod agent_connection_store;
mod agent_diff;
mod agent_panel;
mod completion_provider;
mod config_options;
pub(crate) mod conversation_view;
mod diagnostics;
mod eido_access;
mod eido_reference;
mod eido_pi_ui;
mod eido_verification;
mod eido_queue;
mod eido_review_store;
mod eido_task_windows;
mod eido_session_store;
pub mod draft_prompt_store;
mod entry_view_state;
mod external_source_prompt;
mod inline_assistant;
mod mention_set;
mod message_editor;
mod mode_selector;
mod model_selector;
mod model_selector_popover;
mod profile_selector;
pub mod terminal_thread_metadata_store;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
mod thread_import;
pub mod thread_metadata_store;
pub mod thread_worktree_archive;

pub mod threads_archive_view;
mod ui;
mod unicode_confusables;

use std::rc::Rc;
use std::sync::Arc;

use ::ui::IconName;
use agent_client_protocol::schema::v1 as acp;
use agent_settings::{AgentProfileId, AgentSettings};
use command_palette_hooks::CommandPaletteFilter;
use editor::{Editor, SelectionEffects, scroll::Autoscroll};
use fs::Fs;
use gpui::{
    Action, App, Context, Entity, ImageSource, Resource, SharedString, SharedUri, TaskExt, Window,
    actions,
};
use language::LanguageRegistry;
use project::AgentId;
use prompt_store::{self, PromptBuilder};
use rope::Point;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use settings::{Settings as _, SidebarSide};
use std::any::TypeId;
use std::path::{Path, PathBuf};
use workspace::{OpenOptions, Workspace};

pub use crate::agent_connection_store::{ActiveAcpConnection, AgentConnectionStore};
pub use crate::agent_panel::{
    AgentPanel, AgentPanelEvent, AgentPanelTerminalInfo, MaxIdleRetainedThreads, TerminalId,
    ThreadTitleRegenerationResult,
};
pub use crate::inline_assistant::InlineAssistant;
pub use crate::message_editor::MessageEditorEvent;
pub use crate::thread_metadata_store::ThreadId;
pub use agent_diff::{AgentDiffPane, AgentDiffToolbar};
pub use conversation_view::open_markdown_in_workspace;
pub use conversation_view::{ConversationView, StateChange};
pub use external_source_prompt::ExternalSourcePrompt;
pub(crate) use mode_selector::ModeSelector;
pub(crate) use model_selector::ModelSelector;
pub(crate) use model_selector_popover::ModelSelectorPopover;
pub use thread_import::{
    AcpThreadImportOnboarding, CrossChannelImportOnboarding, ThreadImportModal,
    channels_with_threads, import_threads_from_other_channels,
};
use zed_actions;
pub use zed_actions::{CreateWorktree, NewWorktreeBranchTarget, SwitchWorktree};

pub(crate) fn resolve_agent_image(
    dest_url: &str,
    worktree_roots: &[PathBuf],
) -> Option<ImageSource> {
    if dest_url.starts_with("http://") || dest_url.starts_with("https://") {
        return Some(ImageSource::Resource(Resource::Uri(SharedUri::from(
            dest_url.to_string(),
        ))));
    }

    let path = Path::new(dest_url);
    if path.is_absolute() && path.exists() {
        return Some(ImageSource::Resource(Resource::Path(Arc::from(path))));
    }

    for root in worktree_roots {
        let absolute_path = root.join(dest_url);
        if absolute_path.exists() {
            return Some(ImageSource::Resource(Resource::Path(Arc::from(
                absolute_path.as_path(),
            ))));
        }
    }

    None
}

/// Opens `abs_path` in the workspace, moving the cursor to `point` when one
/// is given. Paths outside every worktree are only opened when a file exists
/// there, so broken agent links don't create empty buffers.
pub(crate) fn open_abs_path_at_point(
    workspace: &mut Workspace,
    abs_path: PathBuf,
    point: Option<Point>,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) {
    let project_path = workspace
        .project()
        .update(cx, |project, cx| project.find_project_path(&abs_path, cx));
    let fs = workspace.project().read(cx).fs().clone();
    let workspace = cx.weak_entity();
    window
        .spawn(cx, async move |cx| {
            let item = if let Some(project_path) = project_path {
                workspace
                    .update_in(cx, |workspace, window, cx| {
                        workspace.open_path(project_path, None, true, window, cx)
                    })?
                    .await?
            } else {
                let metadata = fs.metadata(&abs_path).await?;
                anyhow::ensure!(
                    metadata.is_some_and(|metadata| !metadata.is_dir),
                    "no file found at path {abs_path:?}"
                );
                workspace
                    .update_in(cx, |workspace, window, cx| {
                        workspace.open_abs_path(
                            abs_path,
                            OpenOptions {
                                focus: Some(true),
                                ..Default::default()
                            },
                            window,
                            cx,
                        )
                    })?
                    .await?
            };
            let Some(point) = point else {
                return Ok(());
            };
            let Some(editor) = item.downcast::<Editor>() else {
                return Ok(());
            };
            editor
                .update_in(cx, |editor, window, cx| {
                    editor.change_selections(
                        SelectionEffects::scroll(Autoscroll::center()),
                        window,
                        cx,
                        |selections| selections.select_ranges([point..point]),
                    );
                })
                .ok();
            anyhow::Ok(())
        })
        .detach_and_log_err(cx);
}

pub const DEFAULT_THREAD_TITLE: &str = "New Agent Thread";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentThreadSource {
    AgentPanel,
    GitPanel,
    Sidebar,
}

impl AgentThreadSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AgentPanel => "agent_panel",
            Self::GitPanel => "git_panel",
            Self::Sidebar => "sidebar",
        }
    }
}

pub(crate) fn agent_sidebar_side(cx: &App) -> &'static str {
    match AgentSettings::get_global(cx).sidebar_side() {
        SidebarSide::Left => "left",
        SidebarSide::Right => "right",
    }
}

actions!(
    agent,
    [
        /// Toggles the menu to create new agent threads.
        ToggleNewThreadMenu,
        /// Toggles the options menu for agent settings and preferences.
        ToggleOptionsMenu,
        /// Toggles the profile or mode selector for switching between agent profiles.
        ToggleProfileSelector,
        /// Cycles through available session modes.
        CycleModeSelector,
        /// Cycles through favorited models in the ACP model selector.
        CycleFavoriteModels,
        /// Expands the message editor to full size.
        ExpandMessageEditor,
        /// Archives the currently selected thread.
        ArchiveSelectedThread,
        /// Removes the currently selected thread.
        RemoveSelectedThread,
        /// Renames the currently selected thread.
        RenameSelectedThread,
        /// Starts a chat conversation with follow-up enabled.
        ChatWithFollow,
        /// Cycles to the next inline assist suggestion.
        CycleNextInlineAssist,
        /// Cycles to the previous inline assist suggestion.
        CyclePreviousInlineAssist,
        /// Moves focus up in the interface.
        FocusUp,
        /// Moves focus down in the interface.
        FocusDown,
        /// Moves focus left in the interface.
        FocusLeft,
        /// Moves focus right in the interface.
        FocusRight,
        /// Opens the active thread as a markdown file.
        OpenActiveThreadAsMarkdown,
        /// Opens the agent diff view to review changes.
        OpenAgentDiff,
        /// Copies the current thread to the clipboard as JSON for debugging.
        CopyThreadToClipboard,
        /// Loads a thread from the clipboard JSON for debugging.
        LoadThreadFromClipboard,
        /// Reruns the rules-to-skills migration.
        RerunRulesToSkillsMigration,
        /// Keeps the current suggestion or change.
        Keep,
        /// Rejects the current suggestion or change.
        Reject,
        /// Rejects all suggestions or changes.
        RejectAll,
        /// Undoes the most recent reject operation, restoring the rejected changes.
        UndoLastReject,
        /// Keeps all suggestions or changes.
        KeepAll,
        /// Allow this operation only this time.
        AllowOnce,
        /// Allow this operation and remember the choice.
        AllowAlways,
        /// Reject this operation only this time.
        RejectOnce,
        /// Follows the agent's suggestions.
        Follow,
        /// Resets the trial upsell notification.
        ResetTrialUpsell,
        /// Resets the trial end upsell notification.
        ResetTrialEndUpsell,
        /// Re-enables the fast mode warning for every provider and model.
        ResetFastModeWarnings,
        /// Opens the "Add Context" menu in the message editor.
        OpenAddContextMenu,
        /// Interrupts the current generation and sends the message immediately.
        SendImmediately,
        /// Sends the next queued message immediately.
        SendNextQueuedMessage,
        /// Removes the first message from the queue (the next one to be sent).
        RemoveFirstQueuedMessage,
        /// Edits the first message in the queue (the next one to be sent).
        EditFirstQueuedMessage,
        /// Toggles steering for the first queued message: when on, it interrupts
        /// the agent at its next step instead of waiting for it to finish.
        ToggleSteerFirstQueuedMessage,
        /// Clears all messages from the queue.
        ClearMessageQueue,
        /// Opens the permission granularity dropdown for the current tool call.
        OpenPermissionDropdown,
        /// Toggles thinking mode for models that support extended thinking.
        ToggleThinkingMode,
        /// Cycles through available thinking effort levels for the current model.
        CycleThinkingEffort,
        /// Toggles the thinking effort selector menu open or closed.
        ToggleThinkingEffortMenu,
        /// Toggles fast mode for models that support it.
        ToggleFastMode,
        /// Scroll the output by one page up.
        ScrollOutputPageUp,
        /// Scroll the output by one page down.
        ScrollOutputPageDown,
        /// Scroll the output up by three lines.
        ScrollOutputLineUp,
        /// Scroll the output down by three lines.
        ScrollOutputLineDown,
        /// Scroll the output to the top.
        ScrollOutputToTop,
        /// Scroll the output to the bottom.
        ScrollOutputToBottom,
        /// Scroll the output to the previous user message.
        ScrollOutputToPreviousMessage,
        /// Scroll the output to the next user message.
        ScrollOutputToNextMessage,
        /// Toggles in-thread search over the current agent thread's contents.
        ToggleSearch,
        /// Import agent threads from other Zed release channels (e.g. Preview, Nightly).
        ImportThreadsFromOtherChannels,
        /// Starts a new terminal thread.
        NewTerminalThread,
    ]
);

actions!(
    dev,
    [
        /// Shows metadata for the currently active thread.
        ShowThreadMetadata,
        /// Shows metadata for all threads in the sidebar.
        ShowAllSidebarThreadMetadata,
    ]
);

/// Action to authorize a tool call with a specific permission option.
/// This is used by the permission granularity dropdown to authorize tool calls.
#[derive(Clone, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = agent)]
#[serde(deny_unknown_fields)]
pub struct AuthorizeToolCall {
    /// The tool call ID to authorize.
    pub tool_call_id: String,
    /// The permission option ID to use.
    pub option_id: String,
    /// The kind of permission option (serialized as string).
    pub option_kind: String,
}

/// Action to select a permission granularity option from the dropdown.
/// This updates the selected granularity without triggering authorization.
#[derive(Clone, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = agent)]
#[serde(deny_unknown_fields)]
pub struct SelectPermissionGranularity {
    /// The tool call ID for which to select the granularity.
    pub tool_call_id: String,
    /// The index of the selected granularity option.
    pub index: usize,
}

/// Action to toggle a command pattern checkbox in the permission dropdown.
#[derive(Clone, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = agent)]
#[serde(deny_unknown_fields)]
pub struct ToggleCommandPattern {
    /// The tool call ID for which to toggle the pattern.
    pub tool_call_id: String,
    /// The index of the command pattern to toggle.
    pub pattern_index: usize,
}

/// Creates a new conversation thread, optionally based on an existing thread.
#[derive(Default, Clone, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = agent)]
#[serde(deny_unknown_fields)]
pub struct NewThread;

/// Creates a new external agent conversation thread.
#[derive(Clone, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = agent)]
#[serde(deny_unknown_fields)]
pub struct NewExternalAgentThread {
    /// The agent id to use for the conversation.
    #[serde(deserialize_with = "deserialize_external_agent_id")]
    agent: AgentId,
}

fn deserialize_external_agent_id<'de, D>(deserializer: D) -> Result<AgentId, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum AgentIdOrLegacyAgent {
        LegacyAgent(Agent),
        AgentId(AgentId),
    }

    match AgentIdOrLegacyAgent::deserialize(deserializer)? {
        AgentIdOrLegacyAgent::AgentId(agent_id) => Ok(agent_id),
        AgentIdOrLegacyAgent::LegacyAgent(Agent::Custom { id }) => Ok(id),
        AgentIdOrLegacyAgent::LegacyAgent(Agent::NativeAgent) => Ok(Agent::NativeAgent.id()),
        #[cfg(any(test, feature = "test-support"))]
        AgentIdOrLegacyAgent::LegacyAgent(Agent::Stub) => Ok(Agent::Stub.id()),
    }
}

#[derive(Clone, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = agent)]
#[serde(deny_unknown_fields)]
pub struct NewNativeAgentThreadFromSummary {
    from_session_id: acp::SessionId,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum Agent {
    #[default]
    #[serde(alias = "NativeAgent", alias = "TextThread")]
    NativeAgent,
    #[serde(alias = "Custom")]
    Custom {
        #[serde(rename = "name")]
        id: AgentId,
    },
    #[cfg(any(test, feature = "test-support"))]
    Stub,
}

impl From<AgentId> for Agent {
    fn from(id: AgentId) -> Self {
        if id.as_ref() == agent::ZED_AGENT_ID.as_ref() {
            return Self::NativeAgent;
        }
        #[cfg(any(test, feature = "test-support"))]
        if id.as_ref() == "stub" {
            return Self::Stub;
        }
        Self::Custom { id }
    }
}

impl Agent {
    pub fn id(&self) -> AgentId {
        match self {
            Self::NativeAgent => agent::ZED_AGENT_ID.clone(),
            Self::Custom { id } => id.clone(),
            #[cfg(any(test, feature = "test-support"))]
            Self::Stub => "stub".into(),
        }
    }

    pub fn is_native(&self) -> bool {
        matches!(self, Self::NativeAgent)
    }

    pub fn label(&self) -> SharedString {
        match self {
            Self::NativeAgent => "Zed Agent".into(),
            Self::Custom { id, .. } => id.0.clone(),
            #[cfg(any(test, feature = "test-support"))]
            Self::Stub => "Stub Agent".into(),
        }
    }

    pub fn icon(&self) -> Option<IconName> {
        match self {
            Self::NativeAgent => None,
            Self::Custom { .. } => Some(IconName::Sparkle),
            #[cfg(any(test, feature = "test-support"))]
            Self::Stub => None,
        }
    }

    pub fn server(
        &self,
        fs: Arc<dyn fs::Fs>,
        thread_store: Entity<agent::ThreadStore>,
    ) -> Rc<dyn agent_servers::AgentServer> {
        match self {
            Self::NativeAgent => Rc::new(agent::NativeAgentServer::new(fs, thread_store)),
            Self::Custom { id: name } => {
                Rc::new(agent_servers::CustomAgentServer::new(name.clone()))
            }
            #[cfg(any(test, feature = "test-support"))]
            Self::Stub => Rc::new(crate::test_support::StubAgentServer::default_response()),
        }
    }
}

/// Content to initialize new external agent with.
pub enum AgentInitialContent {
    ThreadSummary {
        session_id: acp::SessionId,
        title: Option<SharedString>,
    },
    ContentBlock {
        blocks: Vec<acp::ContentBlock>,
        auto_submit: bool,
    },
    FromExternalSource(ExternalSourcePrompt),
}

impl From<ExternalSourcePrompt> for AgentInitialContent {
    fn from(prompt: ExternalSourcePrompt) -> Self {
        Self::FromExternalSource(prompt)
    }
}

/// Opens the profile management interface for configuring agent tools and settings.
#[derive(PartialEq, Clone, Default, Debug, Deserialize, JsonSchema, Action)]
#[action(namespace = agent)]
#[serde(deny_unknown_fields)]
pub struct ManageProfiles {
    #[serde(default)]
    pub customize_tools: Option<AgentProfileId>,
}

impl ManageProfiles {
    pub fn customize_tools(profile_id: AgentProfileId) -> Self {
        Self {
            customize_tools: Some(profile_id),
        }
    }
}

pub(crate) fn humanize_token_count(count: u64) -> String {
    match count {
        0..=999 => count.to_string(),
        1000..=9999 => {
            let thousands = count / 1000;
            let hundreds = (count % 1000 + 50) / 100;
            if hundreds == 0 {
                format!("{}k", thousands)
            } else if hundreds == 10 {
                format!("{}k", thousands + 1)
            } else {
                format!("{}.{}k", thousands, hundreds)
            }
        }
        10_000..=999_999 => format!("{}k", (count + 500) / 1000),
        1_000_000..=9_999_999 => {
            let millions = count / 1_000_000;
            let hundred_thousands = (count % 1_000_000 + 50_000) / 100_000;
            if hundred_thousands == 0 {
                format!("{}M", millions)
            } else if hundred_thousands == 10 {
                format!("{}M", millions + 1)
            } else {
                format!("{}.{}M", millions, hundred_thousands)
            }
        }
        10_000_000.. => format!("{}M", (count + 500_000) / 1_000_000),
    }
}

/// Initializes the shared ACP workbench and history used by Eido.
pub fn init(
    _fs: Arc<dyn Fs>,
    _prompt_builder: Arc<PromptBuilder>,
    _language_registry: Arc<LanguageRegistry>,
    _is_new_install: bool,
    _is_eval: bool,
    cx: &mut App,
) {
    eido_access::init(cx);
    eido_review_store::init(cx);
    agent::ThreadStore::init_global(cx);
    prompt_store::init(cx);
    agent_panel::init(cx);
    thread_metadata_store::init(cx);
    terminal_thread_metadata_store::init(cx);
    update_command_palette_filter(cx);
}

fn update_command_palette_filter(cx: &mut App) {
    CommandPaletteFilter::update_global(cx, |filter, _| {
        use editor::actions::{
            AcceptEditPrediction, AcceptNextLineEditPrediction, AcceptNextWordEditPrediction,
            NextEditPrediction, PreviousEditPrediction, ShowEditPrediction, ToggleEditPrediction,
        };
        let edit_prediction_actions = [
            TypeId::of::<AcceptEditPrediction>(),
            TypeId::of::<AcceptNextWordEditPrediction>(),
            TypeId::of::<AcceptNextLineEditPrediction>(),
            TypeId::of::<ShowEditPrediction>(),
            TypeId::of::<NextEditPrediction>(),
            TypeId::of::<PreviousEditPrediction>(),
            TypeId::of::<ToggleEditPrediction>(),
        ];

        let manage_skills_action = [TypeId::of::<zed_actions::assistant::ManageSkills>()];
        let skill_creator_actions = [
            TypeId::of::<zed_actions::assistant::OpenSkillCreator>(),
            TypeId::of::<zed_actions::assistant::CreateSkillFromUrl>(),
        ];

        for namespace in ["copilot", "edit_prediction", "zed_predict_onboarding"] {
            filter.hide_namespace(namespace);
        }
        filter.hide_action_types(&edit_prediction_actions);
        filter.hide_action_types(&manage_skills_action);
        filter.hide_action_types(&skill_creator_actions);
        filter.hide_action_types(&[
            TypeId::of::<zed_actions::assistant::OpenGlobalAgentsMdRules>(),
            TypeId::of::<zed_actions::assistant::OpenProjectAgentsMdRules>(),
            TypeId::of::<git::GenerateCommitMessage>(),
            TypeId::of::<NewTerminalThread>(),
            TypeId::of::<NewExternalAgentThread>(),
            TypeId::of::<NewNativeAgentThreadFromSummary>(),
            TypeId::of::<zed_actions::OpenZedPredictOnboarding>(),
        ]);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    fn test_eido_only_exposes_supported_agent_actions(cx: &mut App) {
        command_palette_hooks::init(cx);
        update_command_palette_filter(cx);
        let filter = CommandPaletteFilter::try_global(cx).unwrap();
        assert!(!filter.is_hidden(&NewThread));
        assert!(filter.is_hidden(&NewTerminalThread));
        assert!(filter.is_hidden(&zed_actions::assistant::OpenSkillCreator));
        assert!(filter.is_hidden(&editor::actions::AcceptEditPrediction));
    }
}
