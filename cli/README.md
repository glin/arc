# Arc CLI

Let agents use Arc from the command line:

- Start Claude Code and Codex sessions, dispatch work, and read results.
- Send messages between agents, including between Claude Code and Codex.
- Label, pin, and archive sessions across Arc windows.
- Calculate estimated API costs from recorded session usage.

## Install

The Arc extension includes `arc` for sessions it starts and new integrated terminals. For other terminals, [build and install the standalone package](#build-from-source). The installed command requires Node.js 18 or later.

## Commands

### Read sessions

List sessions in a running Arc window, then read one:

```sh
arc windows --json
arc sessions --window WINDOW_ID --json
arc session SESSION_ID --window WINDOW_ID --json
```

Replace `WINDOW_ID` with the intended window's `hostId` and `SESSION_ID` with an ID from its session list. Local integrated terminals select their owning window automatically. See [window selection](../docs/cli.md#windows) for external shells and explicit selectors.

### Dispatch and message agents

Start a Codex session with a task from `task.txt`:

```sh
arc start --provider codex --prompt-file task.txt --name Review --arc-dispatch --window WINDOW_ID --json
```

Use `--provider claude` to start Claude Code instead. Either agent can launch the other.

Send a message from `message.txt` to an existing live session:

```sh
arc send SESSION_ID --prompt-file message.txt --request-id WINDOW_ID:message --window WINDOW_ID --json
```

Choose a new request ID for each message. See [follow-ups](../docs/cli.md#follow-ups) for queued messages and follow-ups to dispatched agents.

`arc start` uses a running Arc window. For launches without one, use `arc run --help`.

### Organize sessions

Preview label, pin, and archive changes:

```sh
arc label add SESSION_ID --label Review --dry-run --window WINDOW_ID --json
arc pin SESSION_ID --dry-run --window WINDOW_ID --json
arc archive SESSION_ID --dry-run --window WINDOW_ID --json
```

Remove `--dry-run` to apply a change. See [session management](../docs/cli.md#session-management) for restrictions and recovery.

### Estimate API costs

Read a saved session's estimated API costs without an Arc window:

```sh
arc cost SESSION_ID --by-model
```

Use a Claude Code or Codex session ID. Cost reports also accept a transcript or rollout file path. See [cost figures](../docs/agent-cost-guide.md#read-the-estimate) for supported usage and partial estimates.

The [CLI guide](https://github.com/glin/arc/blob/main/docs/cli.md) covers examples and troubleshooting. The [CLI reference](https://github.com/glin/arc/blob/main/docs/cli-reference.md) defines JSON fields and command limits.

## Session skill

Install the bundled `arc-sessions` skill to let Claude Code and Codex agents manage sessions through Arc:

```sh
arc skills install --agent claude --agent codex
```

After updating the CLI, update its installed skill copies:

```sh
arc skills update --agent claude --agent codex
```

These commands use `~/.claude/skills` for Claude Code and `~/.agents/skills` for Codex. If either folder links to the other, install at the link's target. Arc never writes through linked skill folders. Restart the agent session to load the skill.

Installation preserves existing manual copies and links. See [skill installation and recovery](../docs/arc-sessions.md#install-the-parts-you-need) for ownership rules and interrupted operations.

### Manual links

For a custom installation, link the packaged `skills/arc-sessions` directory into your agent's skill folder.

For a global Windows installation, run in PowerShell:

```powershell
$arcSkill = Join-Path (npm prefix --global) 'node_modules/@glin/arc/skills/arc-sessions'
New-Item -ItemType Directory -Path "$HOME/.claude/skills", "$HOME/.agents/skills" -Force
New-Item -ItemType Junction -Path "$HOME/.claude/skills/arc-sessions" -Target $arcSkill
New-Item -ItemType Junction -Path "$HOME/.agents/skills/arc-sessions" -Target $arcSkill
```

For a global macOS or Linux installation, run:

```sh
arc_skill="$(npm prefix --global)/lib/node_modules/@glin/arc/skills/arc-sessions"
mkdir -p ~/.claude/skills ~/.agents/skills
ln -s "$arc_skill" ~/.claude/skills/arc-sessions
ln -s "$arc_skill" ~/.agents/skills/arc-sessions
```

A source checkout provides `cli/skills/arc-sessions`. A project-local package provides `node_modules/@glin/arc/skills/arc-sessions`. Use the directory's absolute path as the link target. Remove an existing link before replacing it.

## Build from source

Source builds require Node.js 20.19+ (20.x) or 22.12+. From an [Arc repository](https://github.com/glin/arc) checkout, run:

```sh
npm --prefix extension install
npm --prefix cli install
npm --prefix cli test
npm pack ./cli
```

`npm pack` builds the bundle and prints its tarball filename. Replace `<version>` below with that file's version:

```sh
npm install --global ./glin-arc-<version>.tgz
```

For a project-local installation, use:

```sh
npm install ./glin-arc-<version>.tgz
npm exec --offline --no -- arc --version
```

The offline command uses the installed package without a registry download.

## Uninstallation

Before uninstalling the CLI, remove skill copies that Arc installed:

```sh
arc skills remove --agent claude --agent codex
```

Remove manual `arc-sessions` links yourself. Preserve unfamiliar skill directories.

For a global npm installation:

```sh
npm uninstall --global @glin/arc
```

For a project-local installation, run in that project:

```sh
npm uninstall @glin/arc
```

Remove Claude hooks through its plugin manager:

```sh
claude plugin uninstall arc-hooks@arc --scope user
```

Remove the `arc` marketplace only when no installed plugin uses it.

### Source and extension commands

The source setup script installs launchers under the selected Arc home's `bin` directory. Remove its Arc-owned `arc`, `arc.cmd`, and `run.cjs` files. If you added that directory to your shell configuration or Windows user PATH, remove that entry.

Downloaded source and VSIX setup keep copies under the Arc home's `tools` directory. The Arc home defaults to `~/.arc` unless `ARC_HOME` is set. Local source marketplaces refer to their checkout.

Stop every process using those copies before removing them. Confirm `tools/ownership.json` names the selected Arc home. Preserve unfamiliar files, snapshots, logs, caches, and other user data. Never delete the complete Arc home directory.

<details>
<summary>Claude Code status line (beta)</summary>

## Status-line setup

Add `statusLine` to your Claude Code settings in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "arc statusline",
    "padding": 0
  }
}
```

The status line shows available model, workspace, context, cache, cost, duration, and account-limit information from Claude Code.

| Option            | Output                                 |
| ----------------- | -------------------------------------- |
| `--next-turn`     | Only the next-turn starting price.     |
| `--json`          | A JSON snapshot with schema version 1. |
| `--width COLUMNS` | Less detail for a narrower terminal.   |

Do not combine `--next-turn` and `--json`. Width defaults to the `COLUMNS` environment variable. Required figures can exceed the requested width.

The next-turn starting price estimates the minimum cost of resending existing context, including the latest answer. It excludes your next prompt and the model's next answer. Unknown cache state uses the uncached estimate. See [status-line output](../docs/cli-reference.md#status-line) for unavailable figures and rounding.

### When Claude Code cannot find arc

Use an absolute bundle path in the `command` setting. For a global npm installation, find its prefix:

```sh
npm prefix --global
```

On Windows, use forward slashes:

```text
node "C:/path/to/npm-prefix/node_modules/@glin/arc/dist/arc.cjs" statusline
```

On macOS and Linux:

```text
node "/path/to/npm-prefix/lib/node_modules/@glin/arc/dist/arc.cjs" statusline
```

For a source checkout, [install dependencies](#build-from-source), then build the bundle:

```sh
npm --prefix cli run build
```

Use its absolute path on Windows, macOS, or Linux:

```text
node "/path/to/checkout/cli/dist/arc.cjs" statusline
```

Keep the path quoted for folders with spaces. Escape those quotes as `\"` inside JSON:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"C:/path/to/npm-prefix/node_modules/@glin/arc/dist/arc.cjs\" statusline",
    "padding": 0
  }
}
```

### Show the next-turn price in another status line

`arc statusline --next-turn` prints a segment such as `next turn starts at $0.47`. Your status line tool must pass Claude Code's JSON to the command's stdin.

For ccstatusline, set the command in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "npx -y ccstatusline@latest"
  }
}
```

Add this widget to a line in `~/.config/ccstatusline/settings.json`:

```json
{
  "id": "arc-next-turn",
  "type": "custom-command",
  "commandPath": "arc statusline --next-turn",
  "timeout": 1000
}
```

If ccstatusline cannot find `arc`, use an [absolute bundle command](#when-claude-code-cannot-find-arc) in `commandPath`.

</details>
