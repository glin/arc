# Arc

Arc is a VS Code extension for working with Claude Code and Codex. **Experimental, personal software.**

[Web demo](https://glin.github.io/arc/)

- Run Claude Code and Codex sessions side by side. Keep track of all the agents with vertical tabs, labels, saved views, filters, and linked sessions.
- Read results, not chat. Each turn shows the final response with file edits, commits, subagents, and cost.
- See what a session costs with turn-level breakdowns. Save costs with the prompt cache expiry and next-turn starting price hints.
- Or use Arc as a session viewer. It reads sessions started from the Claude Code and Codex CLIs, VS Code extensions, and desktop apps.

<a href="docs/images/readme-main.webp"><img src="docs/images/readme-main.webp" alt="Arc open in a VS Code editor tab, with Claude Code and Codex sessions beside a completed turn" width="1186"></a>

## Try it

Arc is not on the VS Code Marketplace. For now, install it from source (requires Node 22.12+):

```bash
curl -fsSL https://raw.githubusercontent.com/glin/arc/main/install.sh | bash
```

The installer defaults to the current editor when its terminal identifies a supported installation. Otherwise, it defaults to all detected editors and offers a menu when several editors and a terminal are available. Append `code`, `cursor`, `positron`, `codium`, `code-insiders`, or a full CLI path to override detection. On Windows, use Git Bash.

Arc comes with optional [Claude Code hooks](https://github.com/glin/arc/tree/main/plugins/arc-hooks) to show file diffs when Claude edits a file. The installer sets up the hooks automatically, but you can disable hook installation by adding `--no-hooks` to the install command.

To install the hooks separately:

```bash
claude plugin marketplace add glin/arc
claude plugin install arc-hooks@arc
```

To open Arc, click the agent icon in the editor's top-right toolbar. Or run **Arc: Open Arc in Editor** from the Command Palette. The shortcut is `Ctrl+K`, then `A` on Windows/Linux, or `Cmd+K`, then `A` on macOS.

### Sign in

Arc works with both Claude/ChatGPT subscriptions and API plans.

Sign in using the Claude Code and Codex CLIs:

```bash
claude auth login

codex login
```

## Features

### Files and commits

Review file diffs even before the agent makes a commit. Open changed files and their diffs in VS Code from each turn's Files section.

Arc detects sessions in the project's registered Git worktrees. Commits show their branch and worktree when available, plus attribution for subagent commits. Fast-forward merges appear separately from authored commits.

Codex diffs use recorded patches. Claude's per-turn diffs use recorded edits, with changed regions shown when full file text is unavailable. Claude's full current-file diffs require Arc's optional hooks. These compare the file before the session's first edit with its current contents.

<a href="docs/images/readme-files.webp"><img src="docs/images/readme-files.webp" alt="Files and Commits sections with changed files, authored commits, branch and worktree names, subagent attribution, and a merge into main" width="680"></a>

### Session costs

Arc estimates costs for supported models using published prices. Subscription estimates do not measure your bill or plan limits.

| Provider       | Models                      |
| -------------- | --------------------------- |
| Anthropic      | Claude                      |
| OpenAI         | GPT                         |
| Amazon Bedrock | Anthropic and OpenAI models |

#### Cost by agent

<a href="docs/images/readme-cost.webp"><img src="docs/images/readme-cost.webp" alt="Cost details for Claude Opus 5.5 and a Sonnet 5.5 subagent" width="480"></a>

#### Next-turn price

<a href="docs/images/readme-next-turn.webp"><img src="docs/images/readme-next-turn.webp" alt="Cached and uncached next-turn prices with cache time above the prompt box" width="540"></a>

#### Cache expiries

<a href="docs/images/readme-cache-expiry.webp"><img src="docs/images/readme-cache-expiry.webp" alt="Cache expiry with its estimated input cost" width="541"></a>

#### Cache use

<a href="docs/images/readme-cache.webp"><img src="docs/images/readme-cache.webp" alt="Low cache reuse warning and cache costs" width="480"></a>

### Commenting

Select response text and add a comment beside it. Saved comments stay attached to their text. Edit or delete them from their marks, then send them with your next prompt.

<a href="docs/images/readme-comment-editor.webp"><img src="docs/images/readme-comment-editor.webp" alt="Selected response text with a comment being written beside it" width="970"></a>

### Project cost

<a href="docs/images/readme-project-cost.webp"><img src="docs/images/readme-project-cost.webp" alt="Project cost with estimated totals for Claude, Codex, and both agents over today, 7 days, and 30 days" width="340"></a>

### Account usage

<a href="docs/images/readme-usage.webp"><img src="docs/images/readme-usage.webp" alt="Usage bar with Claude and Codex limits, open to each agent's plan, 5h and 7d use, and reset times" width="308"></a>
