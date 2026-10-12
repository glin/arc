# Arc

Arc is a VS Code extension for working with Claude Code and Codex. **Experimental, personal software.**

[Web demo](https://glin.github.io/arc/)

- Keep track of all the agents! See which are running. Vertical tabs, labels, saved views, filters, links to subagent sessions.
- Read results, not chat! Each turn shows the final response with file edits, commits, subagents, and cost.
- See what a session costs with turn-level breakdowns. Save costs with the prompt cache expiry and next-turn starting price hints.
- Or use Arc as a session viewer. It reads sessions started from the Claude Code and Codex CLIs, VS Code extensions, and desktop apps.

<a href="docs/images/readme-main.webp"><img src="docs/images/readme-main.webp" alt="Arc open in a VS Code editor tab, with Claude Code and Codex sessions beside a completed turn" width="1186"></a>

## Try it

Arc is not on the VS Code Marketplace. Obtain a VSIX through one of these routes:

- For a published version, download `glin.arc-<version>.vsix` from [GitHub Releases](https://github.com/glin/arc/releases).
- For an unpublished candidate, open its successful [VSIX candidate workflow run](https://github.com/glin/arc/actions/workflows/vsix-candidate.yml). Download the `arc-vsix-candidate-<commit SHA>` artifact and extract `glin.arc-<version>.vsix`.
- If no package is available, use [source installation](#manual-and-source-installation) below.

The VSIX includes the prebuilt CLI and optional Claude snapshot plugin. Installing the downloaded package needs no Git, npm, network access, or source build.

Terminal commands and snapshots require Node.js 18 or later in the editor's launch environment. Snapshots also require Claude Code 2.1.268 or later. Install those prerequisites before setup. If you installed them while VS Code was open, restart VS Code first.

Set any intended `ARC_HOME` or `CLAUDE_CONFIG_DIR` before starting VS Code.

1. Open VS Code's Extensions view. Select **Install from VSIX...** from its menu and choose the downloaded `.vsix` file.
2. Run **Developer: Reload Window** from the Command Palette.
3. Open your project folder. Trust the project if VS Code requests it and you trust its contents.
4. Run **Arc: Set up terminal commands** from the Command Palette and approve installation. Open a new editor terminal after setup.
5. Run **Arc: Set up Claude snapshots** separately and approve the optional plugin installation. Skip this step for terminal commands only or an existing source or hosted snapshot installation.
6. Restart Claude or start a fresh Claude session to load the snapshot plugin.

The `arc` command provides session commands, cost reports, and `arc statusline`. Snapshots supply file baselines for Claude edits after setup. Earlier baselines stay unavailable. Successful setup confirms installation and selected files. It does not confirm snapshot capture.

To open Arc, click the agent icon in the editor's top-right toolbar. Or run **Arc: Open Arc in Editor** from the Command Palette. The shortcut is `Ctrl+K`, then `A` on Windows/Linux, or `Cmd+K`, then `A` on macOS.

### Terminal availability

Command setup appends its installation folder to PATH for new editor terminals when the folder forms one PATH entry. Windows offers separate consent to append that folder to user PATH. Restart terminal hosts and applications after accepting it. Bash, Zsh and Fish receive manual PATH instructions for terminals outside the editor. Existing commands, aliases and functions keep precedence. A folder containing the platform PATH separator cannot be added to PATH. Use the absolute command path reported by setup when PATH setup is unavailable or skipped.

Setup uses `${ARC_HOME:-~/.arc}` and rejects relative roots or redirected installation ancestors. Remote windows refuse setup. Run setup locally on the execution host.

Snapshot setup supports ordinary personal Claude configuration and default plugin storage. Managed setups are unsupported. Claude enforces its native plugin policy. Runtime or storage overrides require [manual setup](#manual-and-source-installation). Disabled plugins and unfamiliar marketplaces stay unchanged.

### Updates

For bundled tools, install a newer VSIX and reload VS Code. Rerun each setup command for those tools. Restart Claude after snapshot setup. Explicit setup selects this extension's bundled files, including downgrades. Extension upgrades and passive checks do not update installed tools automatically.

### Manual and source installation

For the CLI without the editor extension, follow [CLI installation](cli/README.md#install).

Build and install the extension from source with Node.js 22.12 or later:

```bash
curl -fsSL https://raw.githubusercontent.com/glin/arc/main/install.sh | bash -s -- --no-hooks
```

Reload the window, then continue at step 3 above. Terminal command setup remains independent of snapshot setup. On Windows, run the source installer in Git Bash. The installer uses the current editor when its terminal identifies a supported installation. Otherwise, it selects detected editors and offers a menu when several editors and a terminal are available. Append `code`, `cursor`, `positron`, `codium`, `code-insiders`, or a full CLI path to select an editor. `--no-hooks` preserves existing hooks. Omitting it also installs the snapshot plugin through the source installer's separate route. [Development setup](docs/development.md#dependencies) describes checkout builds and individual source helper modes.

To install the optional hooks manually through Claude's plugin manager, run:

```bash
claude plugin marketplace add glin/arc
claude plugin install arc-hooks@arc
```

The hosted plugin requires Claude Code 2.1.224 or later. Review existing marketplace ownership before selecting this route.

### Remove installed tools

Removing the extension leaves installed commands and plugins available. Remove `arc-hooks@arc` through Claude's plugin manager. Remove the owned `arc` and `arc.cmd` launchers and their `run.cjs` from the selected software root's `bin` directory. Remove that exact directory entry from Windows user PATH or your shell configuration. Remove `tools` only after confirming its `ownership.json` and stopping every process that uses its releases. Preserve unfamiliar files and all snapshots, logs, caches and other user data. Never delete the complete Arc home directory.

### Sign in

Arc works with both Claude/ChatGPT subscriptions and API plans.

Sign in using the Claude Code and Codex CLIs:

```bash
claude auth login

codex login
```

## Features

### Session links and export

- Open named session links in agent responses without leaving Arc.
- Export a saved session and its linked work as HTML for offline review.

### Files and commits

- Review file diffs before the agent commits. Open changed files and their diffs in VS Code.
- Find sessions in the open project and its registered Git worktrees.
- See commit branches and worktrees when available, including who made each subagent commit.
- See fast-forward merges separately from authored commits.

Claude's full current-file diffs require the optional [hooks](#try-it). See [diff limits](docs/timeline.md#diff-selection).

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

<a href="docs/images/readme-cache-expiry.webp"><img src="docs/images/readme-cache-expiry.webp" alt="Cache expiries with cost added over cache-read price" width="541"></a>

#### Cache use

<a href="docs/images/readme-cache.webp"><img src="docs/images/readme-cache.webp" alt="Low cache reuse warning and cache costs" width="480"></a>

#### Project cost

<a href="docs/images/readme-project-cost.webp"><img src="docs/images/readme-project-cost.webp" alt="Project cost with estimated totals for Claude, Codex, and both agents over today, 7 days, and 30 days" width="340"></a>

#### Account usage

<a href="docs/images/readme-usage.webp"><img src="docs/images/readme-usage.webp" alt="Usage bar with Claude and Codex limits, open to each agent's plan, 5h and 7d use, and reset times" width="308"></a>

### Commenting

<a href="docs/images/readme-comment-editor.webp"><img src="docs/images/readme-comment-editor.webp" alt="Selected response text with a comment being written beside it" width="970"></a>
