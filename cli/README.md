# Arc CLI

The Arc CLI is experimental. npm publication is deferred.

Install `arc` for saved session costs, a Claude Code status line, and session commands through a running Arc window. The [CLI guide](https://github.com/glin/arc/blob/main/docs/cli.md) provides command examples and troubleshooting. The [CLI reference](https://github.com/glin/arc/blob/main/docs/cli-reference.md) defines output contracts and limits.

## Install

The Arc VSIX supplies matching private commands. [Try it](../README.md#try-it) describes integrated terminals and Arc sessions. Standalone installation uses npm.

Requires Node.js 18 or later. [Build from source](#build-from-source) and install the local tarball.

The package installs the `arc` command.

## Session skill

The package includes the canonical `skills/arc-sessions` directory and its resources. npm installation does not write native agent configuration. Install independent copies explicitly:

```sh
arc skills install --agent claude --agent codex
arc skills update --agent claude --agent codex
arc skills remove --agent claude --agent codex
```

These commands support default personal destinations. [Skill ownership and recovery](../docs/arc-sessions.md#install-the-parts-you-need) defines preserved copies and interruption handling. For a manually maintained custom destination, link the packaged directory. Claude Code uses `~/.claude/skills`. Codex uses `~/.agents/skills`.

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

A source checkout supplies the same skill under `cli/skills/arc-sessions`. A project-local package supplies it under `node_modules/@glin/arc/skills/arc-sessions`. Use that absolute directory as the link target. Existing links require a separate removal before replacement. Restart the agent session to load the skill.

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

The command reads Claude Code's JSON from stdin. Available figures include the model, workspace, context, cache expiry, session cost, duration, and account limits.

| Option            | Output                                                               |
| ----------------- | -------------------------------------------------------------------- |
| `--next-turn`     | Only the next turn's starting price, for use in another status line. |
| `--json`          | A JSON snapshot with schema version 1.                               |
| `--width COLUMNS` | Less text detail for a narrower terminal.                            |

Use either `--next-turn` or `--json`. Width also reads the `COLUMNS` environment variable. Required figures can exceed the requested width.

The next-turn price estimates the minimum cost of sending the existing context again, including the latest answer. It excludes your next prompt and the model's next answer. An unknown cache state uses the uncached estimate. Missing cache fields show an unknown state. Session cost comes from Claude Code.

If Claude Code cannot find `arc`, use the npm-installed bundle's absolute path or a source build. Use forward slashes on Windows. Quote the path to support folders with spaces. The examples below are shell command strings for the `command` setting.

For a global package installation, find the prefix:

```sh
npm prefix --global
```

Call the bundle with Node.js. On Windows:

```text
node "C:/path/to/npm-prefix/node_modules/@glin/arc/dist/arc.cjs" statusline
```

On macOS and Linux:

```text
node "/path/to/npm-prefix/lib/node_modules/@glin/arc/dist/arc.cjs" statusline
```

For a source build, install dependencies as described in [Build from source](#build-from-source). Run this command in the checkout:

```sh
npm --prefix cli run build
```

Call the bundle with Node.js on Windows, macOS, or Linux:

```text
node "/path/to/checkout/cli/dist/arc.cjs" statusline
```

Escape each double quote as `\"` inside the JSON command string. For example:

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

`arc statusline --next-turn` prints one segment, for example `next turn starts at $0.47`. A status line tool that runs a command with Claude Code's JSON on stdin can show it beside its own segments.

ccstatusline runs a `custom-command` widget this way. Point Claude Code at ccstatusline in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "npx -y ccstatusline@latest"
  }
}
```

Then add the widget to a line in `~/.config/ccstatusline/settings.json`. If ccstatusline cannot find `arc`, use an absolute `node` command from above in `commandPath`:

```json
{
  "id": "arc-next-turn",
  "type": "custom-command",
  "commandPath": "arc statusline --next-turn",
  "timeout": 1000
}
```

## Commands

```sh
arc --help
arc cost SESSION_ID --by-model
arc windows --json
```

Replace `SESSION_ID` with a saved Claude Code or Codex session ID. See the [CLI guide](https://github.com/glin/arc/blob/main/docs/cli.md) for time windows, partial costs, window selection, and session management.

## Build from source

Source builds use Node.js 20.19+ (20.x) or 22.12+. From the [Arc repository](https://github.com/glin/arc), run:

```sh
npm --prefix extension ci
npm --prefix cli ci
npm --prefix cli test
npm pack ./cli
```

`npm pack` builds the bundle and prints the tarball filename. Install that file:

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

For an npm-installed standalone CLI, run:

```sh
npm uninstall --global @glin/arc
```

For a project-local installation, run in that project:

```sh
npm uninstall @glin/arc
```

Remove only the `arc-sessions` links you created in your agents' skill directories. Preserve unfamiliar skill directories.

Remove Claude hooks through its plugin manager:

```sh
claude plugin uninstall arc-hooks@arc --scope user
```

Remove the `arc` marketplace only when no installed plugin uses it. Local source marketplaces refer to their checkout. Downloaded source and VSIX setup keep owned copies under `${ARC_HOME:-~/.arc}/tools`.

Source command setup writes launchers to the selected Arc home's `bin` directory. Remove its owned `arc`, `arc.cmd`, and `run.cjs` files. Remove that exact directory entry from your shell configuration or Windows user PATH if you added it.

Stop every process using copied releases before removing owned `tools` storage. Confirm its `ownership.json` names the selected Arc home. Preserve unfamiliar files, snapshots, logs, caches, and other user data. Never delete the complete Arc home directory.

## Standalone launches

Use `arc run --help` for explicit standalone launch settings. The [CLI guide](../docs/cli.md#standalone-launches) describes native receipts, completion, reports, management, and recovery.
