# What I need from an agent workflow tool

I use this list to reject a tool that cannot support my workflow. [`design-goals.md`](design-goals.md) explains Arc's product direction.

- **Use my CLI subscriptions.** I can run Claude Code and Codex through the accounts their CLIs already use. An API key is optional.
- **Stay in VS Code.** I keep its theme, keys, file tree, editor, diff viewer, and terminal.
- **Give me graphical input and output.** I can edit a prompt in a normal text field and read formatted responses.
- **Show several sessions from both agents.** No agent is the default, and each session has its own state.
- **Show each turn's work.** I can read its response, changed files, diffs, commits, and subagents together.
- **Explain cost and context.** I can inspect turn and session usage by model and delegated work. I can see what the record cannot price.
- **Let me respond in place.** I can answer an agent request and send a comment anchored to a turn or selected passage.
- **Track my attention.** Read state, labels, saved views, pins, and archive help me return to the work that needs me.
- **Keep my workflow.** Arc reads sessions started elsewhere and does not create worktrees, assign tasks, or require file-naming conventions.
- **Keep my data local.** Arc reads the records on my machine and starts the installed CLIs. It has no account or server of its own.
- **Stay within one project.** I see sessions from the open folder and its registered worktrees.
