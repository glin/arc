# Arc CLI

The Arc CLI is experimental. npm publication is deferred.

Show context, prompt-cache status, and the next turn's starting price in Claude Code. Read estimated costs for saved Claude Code and Codex sessions. [Session commands](../docs/cli.md#sessions) filter and list a running Arc window's repository sessions and read bounded turns.

## Install

The Arc VSIX supplies matching private commands. [Terminal availability](../README.md#terminal-availability) describes integrated terminals and Arc sessions. Standalone installation uses npm.

Requires Node.js 18 or later. [Build from source](#build-from-source) and install the local tarball.

The package installs the `arc` command.

## Session skill

The package includes `skills/arc-sessions/SKILL.md`. Link its directory into your agent's skill directory after installation. Claude Code uses `~/.claude/skills`. Codex uses `~/.agents/skills`.

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

Run `arc --help` for command sections and `arc COMMAND --help` for syntax, flags, output fields, refusals, and examples. The [CLI guide](https://github.com/glin/arc/blob/main/docs/cli.md#session-management) explains delivery and session data.

Filter a selected window with the existing session list query:

```sh
arc sessions --query 'session:claude:one OR session:codex:two' --json
arc filter --query 'id:01a12cef id:01a12a6b' --json
arc filter --clear --json
```

[Session query syntax](../docs/rail-and-navigation.md#session-list) defines full IDs and alternative groups. [Panel filter](../docs/cli.md#panel-filter) defines completion outcomes and persistence.

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

To run the npm-installed bundle directly in PowerShell:

```powershell
node "C:/path/to/npm-prefix/node_modules/@glin/arc/dist/arc.cjs" statusline
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

## Session costs

Read a saved session by ID or transcript path:

```sh
arc cost SESSION_ID --by-model
arc cost ./session.jsonl --source-only
```

Replace `SESSION_ID` with a saved Claude Code or Codex session ID. The command reads local records and prints JSON. It includes discovered child sessions unless you use `--source-only`, which requires a file path. `--by-model` adds cost subtotals for each model.

The output has this shape for a Claude Code session that used six subagents. The excerpt shows selected fields, substitutes placeholders for IDs and paths, and keeps one of the six children:

```json
{
  "schemaVersion": 2,
  "source": {
    "kind": "claude",
    "file": "TRANSCRIPT_PATH",
    "sessionId": "SESSION_ID"
  },
  "parent": {
    "requests": 56,
    "costUsd": 3.2912,
    "uncachedInputTokens": 112,
    "cachedInputTokens": 6950100,
    "cacheWriteInputTokens": 143198,
    "outputTokens": 37758
  },
  "children": [
    {
      "kind": "claude-subagent",
      "file": "SUBAGENT_PATH",
      "sessionId": "SUBAGENT_ID",
      "requests": 76,
      "costUsd": 3.4524,
      "cachedInputTokens": 10513585,
      "outputTokens": 12266
    }
  ],
  "combined": {
    "requests": 229,
    "costUsd": 9.5626,
    "uncachedInputTokens": 458,
    "cachedInputTokens": 24421505,
    "cacheWriteInputTokens": 1650883,
    "outputTokens": 51739,
    "cacheExpiry": {
      "returns": 6,
      "extraCostAfterExpiryUsd": 2.1224
    }
  }
}
```

`combined` adds the parent and all six children. The [CLI guide](https://github.com/glin/arc/blob/main/docs/cli.md#read-a-cost-report) defines each field.

Restrict the report to a time window:

```sh
arc cost SESSION_ID --since 2026-10-01T00:00:00Z --until 2026-10-02T00:00:00Z
```

Use ISO timestamps with `Z` or a UTC offset. The report includes requests at `--since` and excludes requests at `--until`.

Pricing covers supported Anthropic and OpenAI models, including supported models through Amazon Bedrock. Estimates use published prices, not your subscription bill. Missing usage or unsupported prices produce partial totals. `costUsd` is `null` when the full cost is unknown. `pricedCostUsd` contains the known subtotal.

Run `arc cost --help` for cost options. The [CLI guide](https://github.com/glin/arc/blob/main/docs/cli.md) explains output fields, custom session folders, and additional reports.

## Running windows

List running Arc windows, including windows without folders:

```sh
arc windows
arc windows --json
```

The [CLI guide](https://github.com/glin/arc/blob/main/docs/cli.md#windows) explains discovery, output fields, and `ARC_HOME`.

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
