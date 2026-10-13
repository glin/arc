# Design goals

Use these goals to decide whether a proposed feature belongs in Arc. [`architecture.md`](architecture.md) maps the implementation. [`criteria.md`](criteria.md) records the author's personal pass or fail requirements.

## Product job

Arc helps one reader direct several coding agents and review their work in VS Code. It reads the records their CLIs write, and it sends prompts, answers, and comments through each CLI's protocol. It does not choose tasks, assign agents, or require a new workflow.

The session list shows which sessions need attention. The timeline shows turns inside the selected session, newest first. A turn card puts the agent's response beside recorded files, diffs, commits, activity, cost, and context. The Prompt box lets the reader act on that review without switching tools.

Arc serves the author's fitted workflow. The CLI status companion also serves teammates who work in terminals. It stays useful without an editor, while the panel remains the reading and driving surface.

## First-class agents

Claude and Codex have equal standing. The session list supports several sessions of either agent at once. A new agent needs its own protocol, record reader, and pricing support. Shared presentation preserves differences that matter to the reader.

The CLIs and their records remain the source of agent work. Arc reads sessions started in another client and sends new input through the agent's own protocol. A reader can choose the client that fits the moment.

## Review after the work

The reader reviews completed work rather than approving each edit as it happens. The response is an agent claim. Recorded file changes, diffs, commits, and usage sit beside it, with limits shown when the record is incomplete.

A session has several reading levels: a short heading, turns, activity, and detailed records. The reader opens detail when it helps a decision. Newest turns appear first because the reader usually returns after work has happened.

Read and unread state, archive, pins, labels, and saved views help the reader track attention across sessions. A group connects sessions that serve one piece of work inside the current project. These are reader-owned labels rather than facts inferred from file names or agent summaries. A session list filter that an agent sets at the reader's request belongs in Arc. The filter changes no label, pin, or archive state, and the reader can change or clear it.

Comments remain attached to the turn or selected passage they answer. Sending a later prompt carries unsent comments to that session. A review that finds a problem can therefore produce a directed response in place.

## Cost and context

Every turn shows what the record can establish about usage and cost. The breakdown separates main-agent work from delegated work. An unsupported price or incomplete child record remains visibly partial.

Context and prompt-cache information help the reader choose whether to continue, compact, or hand off. Arc reports recorded facts and labels estimates. It does not turn an estimated list price into a subscription charge.

## Boundaries

Arc uses VS Code for the file tree, editor, diff viewer, terminal, theme, and platform controls. It adds a graphical agent surface inside that editor. It has no account or hosted service. Each window opens a local channel for the reader's own agents, and the channel closes with the window.

Arc has no code-hosting integration for pull requests, issues, reviews, or remotes. It adds no persistent VS Code status bar UI. The panel covers the open project and its registered worktrees, not every repository on the machine or several unrelated workspaces. It opens existing worktrees but creates and deletes none. The CLI reads sessions and starts agents through the selected local window. It acknowledges delivered completed turns at the reader's request. It sends agent follow-ups to sessions they started and changes labels, pins, and archive membership. An agent can also ask the CLI to compact its own session after the current turn. Arc has no standalone desktop or web application.

The panel must remain responsive with many sessions. Reads are bounded, derived caches are rebuildable, and expensive history work waits for an explicit request or a background budget.

A feature must make review or direction easier for this reader. It must work without naming conventions for plans, handoffs, or repository files. It must not make one agent the default or hide uncertainty in a cost or activity figure.
