# Arc CLI

The Arc CLI is experimental. npm publication is deferred.

The Arc CLI reports session cost from disk and renders Claude Code status-line input. It performs no cache write or network request.

`cost` reads a Claude transcript or Codex rollout and its discovered children. `statusline` reads one Claude Code JSON object from stdin.

## Run the command

From a source checkout, build the CLI from the repository root:

```sh
npm --prefix cli run build
node cli/dist/arc-status.cjs --help
node cli/dist/arc-status.cjs --version
```

The [package README](../cli/README.md#install) covers installation, command aliases, replacement of `arc-agent-status`, and runtime requirements. It also covers [Claude Code settings](../cli/README.md#status-line-setup). Source development has separate [Node requirements](development.md#dependencies).

After global package installation, run `arc`:

```sh
arc --help
arc --version
arc cost SESSION_ID --by-model
```

`SESSION_ID` stands for a saved session's identifier. Path examples below require an existing transcript or rollout that you select.

`--version` takes precedence over every other argument. `--help`, the `help` command, and no arguments print usage without reading stdin or transcripts.

## Cost arguments

```text
arc cost TARGET [--since TIME] [--until TIME] [--projects PATH] [--codex-sessions PATH] [--by-model] [--source-only] [--by-tool-kind] [--until-text REGEX] [--window-agent ID] [--json]
```

| Argument | Behavior |
| --- | --- |
| `TARGET` | One existing absolute or relative file path, or one session ID. Existing paths take precedence over ID discovery. |
| `--since TIME` | Includes requests at or after this instant in the main report. |
| `--until TIME` | Excludes requests at or after this instant from the main report. |
| `--projects PATH` | Selects the Claude projects root. |
| `--codex-sessions PATH` | Selects the Codex sessions root. |
| `--by-model` | Adds `modelCosts` to each parent and child summary. |
| `--source-only` | Requires an exact existing file path and skips child discovery. It rejects session IDs and missing paths before searching either store. |
| `--by-tool-kind` | Adds parent request costs attributed to tool-result kinds. |
| `--until-text REGEX` | Requires `--by-tool-kind`. Adds a separate tool-kind result before the first matching parent request. |
| `--window-agent ID` | Adds a separate parent interval from the named Agent launch. |
| `--json` | Accepts an explicit JSON selection. Cost already prints JSON by default. |

Times require ISO 8601 with `Z` or an explicit offset. `--until` must be at or after `--since`. Equal bounds produce an empty main request window.

An explicit root takes precedence over its environment variable. `ARC_PROJECTS_ROOT` selects the Claude root. Otherwise, Arc uses `projects` under `CLAUDE_CONFIG_DIR` or `~/.claude`. `ARC_CODEX_ROOT` selects the Codex root. Otherwise, Arc uses `sessions` under `CODEX_HOME` or `~/.codex`.

ID discovery checks Claude project directories and Codex rollout filenames. No match or multiple matches produce an error. An exact path resolves that ambiguity.

## Read a cost report

Read a session and its children within a time window:

```sh
arc cost SESSION_ID --since 2026-09-26T00:00:00Z --until 2026-09-27T00:00:00Z
```

Read only a selected file, with model detail:

```sh
arc cost './session.jsonl' --source-only --by-model --since 2026-09-26T00:00:02Z --until 2026-09-26T00:00:03Z
```

The following excerpt shows selected JSON fields for synthetic usage. Each request records 1,000 uncached input tokens and 100 output tokens. The excerpt substitutes `BUILD_COMMIT` and `TRANSCRIPT_PATH` for the build identity and file path.

```json
{
  "schemaVersion": 2,
  "buildCommit": "BUILD_COMMIT",
  "source": {
    "kind": "claude",
    "file": "TRANSCRIPT_PATH",
    "sessionId": "session-example"
  },
  "window": {
    "since": "2026-09-26T00:00:02.000Z",
    "until": "2026-09-26T00:00:03.000Z"
  },
  "parent": {
    "requests": 1,
    "costUsd": 0.0075,
    "modelCosts": [
      {
        "model": "claude-opus-5",
        "requests": 1,
        "pricedRequests": 1,
        "unpricedRequests": 0,
        "uncachedInputTokens": 1000,
        "cachedInputTokens": 0,
        "cacheWriteInputTokens": 0,
        "outputTokens": 100,
        "reasoningOutputTokens": 0,
        "costUsd": 0.0075,
        "pricedCostUsd": 0.0075
      }
    ]
  },
  "children": [],
  "combined": {
    "requests": 1,
    "costUsd": 0.0075
  }
}
```

The command prints one JSON object followed by a newline. `schemaVersion` identifies the output contract. `buildCommit` identifies the bundled Git commit, or `unknown` for a build without that identity.

`rateNote` describes the estimate's pricing basis. `cacheExpiryNote` describes the cache-expiry evidence limits.

`source` identifies the selected file. `parent` summarizes its requests. `children` identifies and summarizes discovered descendant sources. `combined` summarizes the parent and retained children. The main time window applies to all three summaries. A bounded report retains children with requests, recorded failures, or an intersecting coverage defect.

With `--source-only`, `children` is empty. Combined quantities equal parent quantities. Combined summaries never include `modelCosts`. Direct reads retain failures and linked print exclusions. Agent launch lookup still reads exact adjacent subagent metadata when needed.

### Quantities and missing coverage

`pricedCostUsd` is the known list-price subtotal. `estimatedCostUsd` holds legacy snapshot estimates separately. An unknown price or incomplete Codex coverage leaves `costUsd` null. A null cost never counts as zero. The [pricing guide](agent-cost-guide.md#supported-pricing) owns supported models, providers, and rate meaning.

For Codex, unique response IDs establish recorded billing requests. `recorded-reconciled` permits a numeric total when every selected request has a supported price. `recorded-gaps` identifies missing recorded usage. `billed-with-unknown-coverage` identifies unresolved ownership, cumulative evidence, compaction, resets, or contradictory revisions. `unknown-request-coverage` identifies anonymous evidence. `legacy-snapshots` identifies estimates without bills. Complete Claude usage omits `coverage`. Combined coverage ranks gaps above unknown coverage, and unknown coverage above reconciled usage.

`requestCountExact: false` marks uncertain recorded request counts. Its omission establishes exact recorded identities, not proof that the provider logged every request. Anonymous snapshots appear under `snapshotEvidence` when bills exist. Request averages remain null when request identity is uncertain. Codex tool attribution and batching remain null because token reconciliation does not establish which response used each tool.

An empty window omits cost fields when it contains no coverage defect. An intersecting defect retains a null total and uncertain request count, even with no selected request. Evidence outside the window can resolve a selected bill or reveal an intersecting gap.

Source summaries include request counts, token quantities, context, request averages, and tool batching where the record supports them. They also include failed tool calls, fast-mode pricing gaps, and cache-expiry returns. Codex failures carry a count without an attributed request cost.

Cache-expiry input cost excludes cached reads and output. Codex cache-expiry pairs remain observations, including with reconciled tokens. Their total input cost remains null without independent adjacency evidence.

### Model detail

Each `modelCosts` row identifies one recorded model. Missing identity appears as `null`. Unknown named models retain their names.

Rows contain billing request counts, coverage, dollar amounts, and normalized token quantities. They follow source eligibility and individual request prices. Prices include recorded amounts, provider routes, context bands, and service tiers.

Token quantities are observed subtotals. A normalized zero does not establish that the source explicitly recorded that counter. Source coverage uncertainty applies to every row, including rows with only priced requests.

Unattributable snapshots and tools remain on the source summary. Model rows omit context, request averages, failures, and cache-expiry figures.

Model rows reconcile with source billing quantities before rounding. Full costs require complete or recorded-reconciled coverage and supported prices. Public dollar values round to four decimal places after addition. Summed rounded model amounts can differ slightly from the rounded source amount.

## Supplementary cost results

`--by-tool-kind` splits each Claude request's price across the first tool results it reads. Codex requests appear under `no tool result`. One request can touch several kinds, so row request counts can exceed the parent request total. The top-level `byToolKind` uses the main parent window.

`--until-text` searches Claude assistant text and tool input within that main parent window. Codex requests provide empty text, so patterns requiring characters never match them. Patterns that match empty text also match Codex requests and Claude requests with empty text. With multiline matching, `^$` also matches blank lines in Claude text. This includes the line break before tool input when assistant text is empty. A literal empty argument is rejected. `untilText.byToolKind` excludes the first matching request and all later requests. If no request matches, it includes every parent request in the main window. An empty main window has no match. `untilText.matched` reports whether a match exists. This result does not change `parent`, `children`, `combined`, or the top-level `byToolKind`.

The regex uses multiline matching. Leading `(?i)`, `(?m)`, and `(?s)` select case-insensitive, multiline, and dot-all matching. `\A` and `\Z` match the input boundaries. Unsupported regex syntax produces an error.

`--window-agent` resolves the named launch from structured results, exact adjacent metadata, or launch-result text. An `agent-` prefix and `.jsonl` suffix are optional. `parentWindow` starts with the parent request that launches the Agent. It ignores `--since` and includes requests at `--until`. It excludes children. With `--by-tool-kind`, it also contains its own tool-kind result.

For the synthetic session above, `reviewer` launches at second 1. The assistant says `checkpoint` at second 3. Compare the supplementary results:

```sh
arc cost './session.jsonl' --source-only --since 2026-09-26T00:00:02Z --until 2026-09-26T00:00:03Z --by-tool-kind --until-text 'checkpoint' --window-agent reviewer
```

This excerpt shows selected fields. The main window contains only second 2. It excludes the checkpoint, while the Agent interval includes seconds 1 through 3.

```json
{
  "parent": { "requests": 1, "costUsd": 0.0075 },
  "untilText": {
    "pattern": "checkpoint",
    "matched": false,
    "note": "No assistant text matched the pattern, so every request is counted."
  },
  "parentWindow": {
    "agentIdStartRequest": "request-1",
    "until": "2026-09-26T00:00:03.000Z",
    "requests": 3,
    "costUsd": 0.0225,
    "contextAtStart": 1000,
    "contextAtPeak": 1000
  }
}
```

## Status-line arguments

```text
arc statusline [--json | --next-turn] [--width COLUMNS]
```

| Argument | Behavior |
| --- | --- |
| No output option | Prints text with context, cache, and next-turn starting price. Available workspace, model, session cost, duration, and account limits also appear. |
| `--json` | Prints a schema version 1 snapshot. It includes `model`, `workspace`, `session`, `context`, `cache`, `nextTurn`, and `limits`. |
| `--next-turn` | Prints only the next-turn starting-price segment. It cannot combine with `--json`. |
| `--width COLUMNS` | Controls text detail using a positive column count, rounded down. It takes precedence over the `COLUMNS` environment variable. |

Without a valid width, text uses unlimited width. Invalid or missing `--width` values also use unlimited width. Width affects only text detail, not JSON or `--next-turn`. The required context, cache, and next-turn segments can exceed the requested width.

The status snapshot uses `null` for unavailable or invalid figures. Text shows unknown context as `--`, unknown cache as `unknown`, and an unpriced next turn as `next turn unknown`. Optional unavailable figures leave the text output.

For status-line settings, compatibility, and next-turn price meaning, see the [package README](../cli/README.md).

## Status-line examples

From the repository root in PowerShell, use the included synthetic input:

```powershell
Get-Content -Raw cli/test/fixtures/warm.json | node cli/dist/arc-status.cjs statusline --width 70
Get-Content -Raw cli/test/fixtures/warm.json | node cli/dist/arc-status.cjs statusline --json
Get-Content -Raw cli/test/fixtures/warm.json | node cli/dist/arc-status.cjs statusline --next-turn
```

On macOS or Linux, redirect the same input:

```sh
node cli/dist/arc-status.cjs statusline --width 70 < cli/test/fixtures/warm.json
node cli/dist/arc-status.cjs statusline --json < cli/test/fixtures/warm.json
node cli/dist/arc-status.cjs statusline --next-turn < cli/test/fixtures/warm.json
```

The fixture's saved cache expiry is in the past. The complete width-70 text output is:

```text
ctx 8% of 200k (16k) | cache expired | next turn starts at $0.47
session $0.12, 45s | 5h 23.5% | 7d 41.2%
```

The JSON excerpt shows selected fields without substituted values:

```json
{
  "schemaVersion": 1,
  "source": "claude-statusline",
  "context": {
    "usedTokens": 15500,
    "maxTokens": 200000,
    "usedPercentage": 8,
    "remainingTokens": 184500
  },
  "nextTurn": {
    "basis": "context-only-list-price-floor",
    "state": "cold",
    "startsAtDollars": 0.462,
    "warmDollars": 0.01375,
    "coldDollars": 0.462
  }
}
```

The complete `--next-turn` output is:

```text
next turn starts at $0.47
```

Text rounds positive next-turn starting prices below $10 upward to cents and prices of at least $10 upward to whole dollars. JSON retains the underlying amount.

## Errors

Successful commands write output to stdout and exit with status 0. Errors write one line prefixed with `arc-status:` to stderr and exit with status 1. Errors produce no report on stdout.

Cost rejects unknown options, missing option values, multiple targets, invalid times, unreadable transcripts, invalid regex syntax, and unresolved Agent launches. JSON arrays and identifiable Claude stream logs are unsupported. Empty files and files without native transcript records produce errors. Metadata-only native sessions and empty request windows remain valid. Status-line input must contain one JSON object. Empty input, malformed JSON, and incompatible output modes produce errors.

These complete stderr examples require no path substitutions:

```text
arc-status: --until-text requires --by-tool-kind.
arc-status: --json and --next-turn cannot be used together.
arc-status: Claude status input is not valid JSON.
```
