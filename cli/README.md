# Arc CLI

The Arc CLI is experimental. npm publication is deferred.

Show context, prompt-cache status, and the next turn's starting price in Claude Code. Read estimated costs for saved Claude Code and Codex sessions. [Session commands](../docs/cli.md#sessions) list a running Arc window's repository sessions and read bounded turns.

## Install

Requires Node.js 18 or later. [Build from source](#build-from-source) and install the local tarball.

The package installs `arc` and the compatible `arc-status` alias. If you use the old `arc-agent-status` package, uninstall it first:

```sh
npm uninstall --global arc-agent-status
```

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

If Claude Code cannot find `arc`, use the installed bundle's absolute path in the command. Find npm's global prefix with:

```sh
npm prefix --global
```

On Windows, the command takes this form. Use forward slashes:

```text
node C:/path/to/npm-prefix/node_modules/@glin/arc/dist/arc-status.cjs statusline
```

On macOS and Linux, use:

```text
node /path/to/npm-prefix/lib/node_modules/@glin/arc/dist/arc-status.cjs statusline
```

## Session costs

Read a saved session by ID or transcript path:

```sh
arc cost SESSION_ID --by-model
arc cost ./session.jsonl --source-only
```

Replace `SESSION_ID` with a saved Claude Code or Codex session ID. The command reads local records and prints JSON. It includes discovered child sessions unless you use `--source-only`, which requires a file path. `--by-model` adds cost subtotals for each model.

Restrict the report to a time window:

```sh
arc cost SESSION_ID --since 2026-10-01T00:00:00Z --until 2026-10-02T00:00:00Z
```

Use ISO timestamps with `Z` or a UTC offset. The report includes requests at `--since` and excludes requests at `--until`.

Pricing covers supported Anthropic and OpenAI models, including supported models through Amazon Bedrock. Estimates use published prices, not your subscription bill. Missing usage or unsupported prices produce partial totals. `costUsd` is `null` when the full cost is unknown. `pricedCostUsd` contains the known subtotal.

Run `arc --help` for all options. The [CLI guide](https://github.com/glin/arc/blob/main/docs/cli.md) explains output fields, custom session folders, and additional reports.

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
