<p align="center">
  <img src="native/branding/eido-readme.svg" alt="Eido — AI development workspace, 0.0.1 beta" width="100%">
</p>

<h1 align="center">From intent to code you can trust.</h1>

<p align="center">
  An AI workspace for understanding code, building with an agent,<br>
  and reviewing every change that matters.
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#the-eido-experience">Experience</a> ·
  <a href="#your-first-task">Getting started</a> ·
  <a href="#about-this-beta">Beta scope</a> ·
  <a href="#help-shape-the-next-version">Feedback</a> ·
  <a href="#acknowledgments-and-licensing">Open source</a>
</p>

---

Eido keeps the conversation and the code in the same place. Describe what you want to achieve, give the agent the context it needs, and work through the result in your editor. Your task, proposed changes, and review decisions stay connected as you move between planning and implementation.

**Eido 0.0.1 beta is the first macOS preview.** It is available for early, small-scale testing on real projects. The source is public; downloadable app releases are not available yet.

## The Eido experience

### Start with the intent

Ask a question about unfamiliar code, describe a bug, or outline a feature. Use `@` to bring relevant code into the conversation and keep the task grounded in your project.

> **Try a focused first task**<br>
> “Explain how this module works, identify the cause of this bug, and propose a small fix with a way to check it.”

### Work alongside the agent

Read files, make your own edits, and review the agent’s progress without leaving the workspace. Choose the view that fits the moment:

| View | Best for |
| :--- | :--- |
| **Workbench** | Planning a task, following the conversation, and coordinating the work. |
| **Code** | Reading, navigating, and editing your project. |
| **Split** | Keeping the conversation and the code visible together. |

Switching views preserves your conversation and draft, so you can change focus without losing your train of thought.

### Make the changes yours

Inspect proposed changes in the native review interface and decide what to accept or reject. Proposed file deletions and binary changes remain in review until you accept them. Supported accepted file operations can be restored, subject to checks that protect subsequent edits.

Review is part of the workflow: understand the change, check the result, and keep what belongs in your project.

### Return with context

Revisit earlier tasks with their conversations and review context. Continue interrupted work without starting the discussion from scratch. Eido also includes recovery support for task state and supported file operations.

## Your first task

**1. Open a project**<br>
Launch **Eido** from Applications and open a project folder. A small project with version history is a good place to begin.

**2. Choose how you work**<br>
Configure your model and authentication in global settings. Model, thinking, and **Agent Access** controls are available beside the conversation input.

**3. Give the task a clear outcome**<br>
Describe what should change and how you will know it works. Reference the relevant code, then let the agent investigate and propose a solution.

**4. Review and verify**<br>
Inspect the changes, run the relevant checks, and decide what to keep. Continue the conversation when the result needs refinement.

### You set the level of access

| Agent Access | How it works |
| :--- | :--- |
| **Ask Before Actions** | The agent asks before actions that require approval. A useful starting point while you learn the workflow. |
| **Full Access** | The agent decides how to use enabled tools without requesting approval for each action. |

Agent Access applies globally across tasks. Your configuration and work history are kept outside the application bundle and preserved during local updates. Model requests go to the provider you configure.

## About this beta

The first beta focuses on a usable coding loop: **describe → investigate → edit → review → verify**.

| Available to try | Still being refined |
| :--- | :--- |
| AI conversations with project context and tool execution. | Complete coverage of supported agent commands and extensions. |
| Native file editing and code review. | Language support and smart editing setup across projects. |
| Workbench, Code, and Split views with a shared conversation. | Plugin compatibility and browser and desktop workflows. |
| Task history, supported file-operation review, and recovery. | Large-project performance and broader upgrade and recovery scenarios. |

Smart code assistance depends on the language support you configure. This preview is intended to surface practical problems and improve the next version; it is not a promise of complete support for every project or plugin.

## Help shape the next version

The most useful feedback starts with a real task. Open an issue in the repository, or share it with the person who provided your beta build, including:

- **Your goal** — what you were trying to accomplish.
- **The friction** — what you expected and what happened instead.
- **A small example** — steps to reproduce, a screenshot, or the relevant error text.
- **The version** — Eido **0.0.1 beta**, plus your macOS version.

Please remove credentials and private project information from shared examples.

## Acknowledgments and licensing

Eido builds on the work of **[Zed](https://github.com/zed-industries/zed)** and **[pi](https://github.com/earendil-works/pi)**. Zed provides the native editor foundation; pi powers the coding agent. We thank their authors, contributors, and communities for making these projects available as open source.

Eido respects and preserves the licenses and attribution of both projects. **Eido-original code is licensed under GPL-3.0-or-later**, the same license as Zed's editor code.

| Code | License |
| :--- | :--- |
| Eido-original code and Zed editor code | [GPL-3.0-or-later](LICENSE) |
| Zed components marked Apache-2.0, including GPUI | [Apache-2.0](native/LICENSE-APACHE) |
| pi | [MIT](https://github.com/earendil-works/pi/blob/main/LICENSE) |
| Cua Driver desktop runtime | [MIT](native/cua/LICENSE-MIT) |

If you fork, modify, or distribute Eido, you must comply with the licenses that apply to each included component. Preserve license texts, copyright and attribution notices, and required modification notices. When distributing GPL-covered binaries, provide the Corresponding Source through a method permitted by the GPL and retain its licensing terms. Other dependencies retain their own licenses; see [NOTICE](NOTICE) for attribution and scope. This summary does not replace the license texts.

---

<p align="center">
  <strong>Understand. Create. Evolve.</strong><br>
  <sub>Eido · 0.0.1 beta · macOS preview</sub>
</p>
