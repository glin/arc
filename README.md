# Arc

Arc is a VS Code extension for working with Claude Code and Codex. (_Personal software, experimental_)

[Web demo](https://glin.github.io/arc/)

- Keep track of all the agents! Vertical tabs, labels, saved views, filters, links to subagent sessions.
- Read results, not chat. Arc groups the conversation into a timeline of turns, each showing the final response, file edits, commits, subagents, and cost.
- See what a session costs with turn-level breakdowns. Save costs with the prompt cache expiry and next-turn starting price hints.
- Keep your workflow. Use Arc with existing tools, no worktrees required, or use it as a session viewer for the Claude/Codex CLIs and desktop apps.

<a href="docs/images/readme-main.webp"><img src="docs/images/readme-main.webp" alt="Arc open in a VS Code editor tab, with Claude Code and Codex sessions beside a completed turn" width="1186"></a>

## Try it

Install from source with Node.js 22+ and npm. On Windows, use Git Bash.

Install [Claude Code](https://code.claude.com/docs/en/setup) and [Codex](https://developers.openai.com/codex/cli/) for the agents you use.

Arc is not on the VS Code Marketplace.

```bash
curl -fsSL https://raw.githubusercontent.com/glin/arc/main/install.sh | bash
```

The installer installs Arc in your editor and sets up Claude hooks.

Reload VS Code and open a new integrated terminal to use `arc`. Run **Arc: Open Arc in Editor** from the Command Palette.

### Claude hooks

Hooks capture files before Claude edits them for full current-file diffs. Restart Claude after installation. Earlier file baselines stay unavailable.

Run **Arc: Set up Claude hooks** to set them up separately. To install Arc without changing Claude hooks, use:

```bash
curl -fsSL https://raw.githubusercontent.com/glin/arc/main/install.sh | bash -s -- --no-hooks
```

### CLI outside VS Code

See [CLI installation](cli/README.md#install) to install `arc` for other terminals.

### Uninstall

Remove Arc from VS Code's Extensions view. Installed Claude hooks and standalone commands remain available.

See [uninstallation](cli/README.md#uninstallation) to remove those separately.

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

Use [`arc cost`](docs/cli.md#read-a-cost-report) to estimate costs from saved Claude and Codex transcripts.

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

### Quality-of-life features

- Save your favorite model setups with effort and permissions per project
- Find sessions with advanced filters
- Invoke Codex skills with `/skill`, consistently with Claude
- Copy responses as Markdown or start a new draft from selected response text
- Keep unsent drafts across session switches and panel restores

#### Commenting

<a href="docs/images/readme-comment-editor.webp"><img src="docs/images/readme-comment-editor.webp" alt="Selected response text with a comment being written beside it" width="970"></a>

### Control Arc with agents

Use the [`arc-sessions` skill](docs/arc-sessions.md) to:

- Start Claude or Codex sessions with labels and pins
- Read session results and status, then summarize work needing your attention
- Send follow-ups to sessions the agent started
- Estimate session and subagent costs with `arc cost`
- Request compaction of its own session after the turn when asked

#### Summarize sessions

```text
Use Arc to summarize the sessions labelled Review in this window. Read their completed turns. Report results, blockers, and decisions needing my input.
```

#### Start a branch review

```text
Use Arc to start a Codex session reviewing this branch. Name it Branch review, apply Review, and pin it. Read its result and summarize its findings.
```

#### Request compaction

```text
After saving the handoff, request compaction of this session after your response.
```

## Limitations

Some Claude Code and Codex features, such as starting Remote Control (`/remote-control`), are not implemented in Arc.
