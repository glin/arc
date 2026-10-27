# Arc CLI

The experimental Arc CLI reads saved session costs, renders a Claude Code status line, and manages sessions through a running Arc window. npm publication is deferred.

[Install the CLI](../cli/README.md#install) or use the matching commands supplied by the Arc extension. Agents started by Arc can run `arc` from their shell commands. [Session guidance](arc-sessions.md) describes automatic native skill availability and personal installation.

```sh
arc --help
arc cost --help
arc start --help
```

The [CLI reference](cli-reference.md) defines response fields, limits, and automation contracts.

## Windows

List windows before choosing one:

```sh
arc windows
arc windows --json
```

Check folders and readiness. Replace `WINDOW_ID` with the intended window's `hostId`. Commands use that window's repository scope.

`--window` overrides `ARC_WINDOW`. Without either, integrated terminals select their owning window. External shells require exactly one live window. Automatic selection requires complete discovery. Integrated terminals also require conclusive ownership replies from every window.

Remote integrated terminals and incompatible process namespaces require explicit selection. If ownership is unavailable, reload older Arc windows or pass `--window`.

After reload or reconnection, list windows again and select the intended folders. Saved IDs name the old activation. Running processes retain their initial `ARC_WINDOW`. When a window has a channel, launched sessions receive its current ID, as [Agent launches](agent-launches.md#runtime-shape) describes. Preserve uncertain writes and their original request IDs before starting another operation.

An empty window list means no verified live window. `complete: false` means discovery is incomplete, even when reachable windows appear. [Window output](cli-reference.md#windows) explains diagnostics and `ARC_HOME`.

## Sessions

Replace `SESSION_ID` with an ID returned by the listing:

```sh
arc sessions --window WINDOW_ID --json
arc sessions --query 'label:Review -is:archived' --window WINDOW_ID --json
arc session SESSION_ID --turns 5 --window WINDOW_ID --json
```

`sessions` prints one page of readable rows by default. `session` prints delivered prompts and responses. Use `--json` for fields and receipts. Follow `next` with `--cursor`, retaining the window, query, and limit:

```sh
arc sessions --query 'label:Review -is:archived' --cursor CURSOR --window WINDOW_ID --json
```

`next: null` ends traversal. It does not establish complete discovery. Check `coverage`, `freshness`, and each row's `facts`. Duplicate session IDs have distinct `source` keys and report `ambiguous: true`. `session` refuses ambiguous IDs and never selects by file path.

Listing queries accept `id:`, `session:`, `agent:`, `title:`, `label:`, `is:archived`, and `is:agentrun`. A listing includes archived sessions unless the query adds `-is:archived`. [Session query syntax](session-queries.md#session-query-syntax) defines identities and OR groups. Use [the panel filter](#panel-filter) for live statuses and other search areas.

`session` reads five recent turns by default. `--turns` accepts 1-20. Check `partial`, `state`, and `notes` before treating the reply as complete. Stale replies contain no turns. An unparsed reply does not establish an empty session. Reads never mark turns read.

[Session output](cli-reference.md#sessions) defines row fields, run statuses, pagination, and bounded reads.

## Collect session data

Use `collect` to follow listing pages and optionally read recent turns:

```sh
arc collect --window WINDOW_ID --query '-is:archived' --json
arc collect --window WINDOW_ID --query 'label:Review' --turns 2 --max-reads 2 --json
```

`collect` requires `--window` or `ARC_WINDOW` and never discovers or switches windows. Omit `--turns` to collect listings alone.

| Option | Meaning |
| --- | --- |
| `--limit 1-128` | Rows per page. Default: 128. |
| `--max-pages 1-64` | Listing requests, including retries. Default: 64. |
| `--max-reads 0-32` | Turn requests, including retries. Requires `--turns`. Default: 32. |
| `--deadline-ms 1-60000` | Stop starting requests after this interval. Default: 60000. Started requests can finish later. |

JSON preserves raw replies, usable row references, and turn outcomes. Check traversal, coverage, freshness, and outcomes separately. An unavailable empty first page does not establish an empty repository. Turn replies do not establish physical source continuity with earlier listings. Collection changes no session state and includes no cost aggregation.

[Collection output](cli-reference.md#collection) defines recovery, references, and limits.

## Panel filter

Reveal Arc and replace its session list query:

```sh
arc filter --query 'is:unread -is:archived' --window WINDOW_ID --json
arc filter --clear --window WINDOW_ID --json
```

`--clear` restores All sessions and works through PowerShell argument handling. Filtering preserves selection, sort, groups, folds, Show settings, and saved filter definitions.

`applied` confirms browser application and persistent save. A failed save reports `failed` even when the panel displays the query. Read the panel before retrying `unknown`. Reload a window that lacks query capability. [Filter contracts](cli-reference.md#panel-filter) cover compatibility and deadlines.

## Session management

List available setups, then start from a regular prompt file:

```sh
arc setups --window WINDOW_ID --json
arc start --provider codex --prompt-file './review prompt.txt' --name 'Review branch' --label Review --pinned --window WINDOW_ID
```

Use a returned `--setup KEY` instead of explicit provider settings. Prompt files accept at most 48 KiB. Empty prompts and slash commands refuse launch. Requested settings do not establish observed provider execution.

`--cwd DIR` selects an existing folder in the window's open project or registered worktrees. Omission uses its first folder. Arc creates no folder or worktree.

Starts retain reader ownership by default. Use `--agent-run` for delegated work. `--arc-dispatch` records the requesting session for guarded follow-ups and returns a `launchId` for [dispatch results](#dispatch-results).

The [start output reference](cli-reference.md#session-writes) defines `link` for reporting an accepted session.

For a Claude coordinator waiting on workers, `--cache-lifetime 1h` selects a 1 hour prompt cache. `--cache-lifetime 5m` selects 5 minutes. [Session writes](cli-reference.md#session-writes) defines the default and refusals.

Read [hosted read-only launches](agent-protocols.md#hosted-read-only-launches) before using `--read-only`. Codex denies filesystem writes. Claude restricts tools and git commands but can approve shell writes.

Apply labels, pins, or archive changes with `--dry-run` first:

```sh
arc label add SESSION_ID --label Followup --dry-run --window WINDOW_ID
arc pin SESSION_ID --dry-run --window WINDOW_ID
arc archive SESSION_ID --dry-run --window WINDOW_ID
arc unarchive SESSION_ID --window WINDOW_ID
```

Archive removes the pin. Unarchive leaves the session unpinned. `--force` admits running, Needs input, completed unread, and unavailable-state sessions. It still refuses known `subagents` or `background` work. Unknown state can conceal background work. Forced archive keeps the current turn and any open question.

### Uncertain writes

A disconnected or timed-out write with uncertain delivery returns `unknown` and its request ID. Retry only the identical payload with that ID in the original window activation. Never change the ID to retry an uncertain launch. Reloading creates a new activation and leaves the old outcome unknown.

[Write contracts](cli-reference.md#session-writes) define statuses, request IDs, and capacity limits.

### Follow-ups

`send` delivers literal reader-requested text when `--observation` is absent. The destination requires a live child in the selected scope. Eligible idle sessions start a prompt. Eligible running sessions receive live input. Add `--queue` or `-q` for intentional next-turn delivery. Older queued messages retain FIFO precedence. Open requests, pending work, and unsupported live delivery defer the message. `queued` confirms admission, not delivery.

```bash
arc send SESSION_ID --prompt-file message.txt --request-id WINDOW_ID:message --window WINDOW_ID --json
```

With `--observation`, `send` delivers one prompt to an idle session started by the requester with `start --arc-dispatch`. Read the session first:

```sh
arc session SESSION_ID --window WINDOW_ID --json
arc send SESSION_ID --prompt-file followup.txt --observation OBSERVATION --request-id WINDOW_ID:followup --window WINDOW_ID --json
```

Copy `observation` from the eligible reply. `accepted` confirms prompt receipt, not completed work. `refused` means no prompt was sent. `unknown` blocks further follow-ups until reader intervention in the panel. An identical retry returns the retained result without resending. [Follow-up contracts](cli-reference.md#follow-ups) define ownership, stale observations, and admission.

### Compaction

A hosted session can request its own compaction after the current turn:

```sh
arc compact request --self --after-turn --request-id WINDOW_ID:UUID --window WINDOW_ID --json
arc compact status --request-id WINDOW_ID:UUID --window CURRENT_WINDOW_ID --json
arc compact cancel --self --request-id WINDOW_ID:UUID --window WINDOW_ID --json
```

Replace `UUID` with a lowercase UUID. After `uncertain` admission, observe the original ID. Never retry admission or switch transports. `completed` describes compaction alone. An optional saved continuation has a separate outcome. `compact cancel` drops the session's own request before Arc sends it. [Compaction contracts](cli-reference.md#compaction) define continuation files and status retention.

## Dispatch results

Start with `--arc-dispatch` to retain reports. `--completion manual` is the default. Use `--completion wait` for waited completion.

```sh
arc dispatch status LAUNCH_ID --json
arc dispatch result LAUNCH_ID --event EVENT_ID --json
arc dispatch wait LAUNCH_ID --window WINDOW_ID --json
```

Copy `launchId` from the accepted start and `EVENT_ID` from status. Follow `next` through status pages. Standalone `wait` accepts manual or waited completion. Hosted `wait` requires waited completion. Disconnect returns `uncertain`. Deadline expiry returns `deadline`. Read status or recover afterward. Recovery never starts, resumes, stops, or replaces a worker.

Reports remain readable after host shutdown and when full cost is unknown. [Dispatch contracts](cli-reference.md#dispatch-results) define report availability, claims, acknowledgments, and limits.

## Standalone launches

`arc run` starts one explicitly selected provider without a window. Run `arc run --help` for required settings and output options. Claude read-only launches use print mode. Writable Claude uses background mode. Codex uses `exec` or an attended interactive session. Existing directories, repeated extra directories, executable overrides, and literal argument boundaries remain part of each receipt. Arc creates no branch or worktree. `--cache-lifetime` works as it does for [starts](#session-management).

`--log PATH` exposes live print output or writable Claude native logs. Print launches retain private stdout and stderr files, preserving byte order within each channel. Ordering between channels is unspecified. Resumed observation continues captured bytes without restarting the worker or taking over a reused log alias. Writable Claude logs use its accepted background ID and retain native bytes separately from launch output. Codex freezes its final response beside the log, using the log stem followed by `.last.md`. `--report-file` or `--output` selects another report alias. Reused aliases never supply receipt report bytes.

Manual completion returns the launch ID. Waited completion returns an observation or deadline. Each launch has one finite supervisor. Log capture continues after observation ends when requested. Print capture drains remaining output after provider exit. Writable Claude capture follows its accepted background job until native terminal evidence and drains its remaining log. Status separates session identity, worker exit, observation state, report availability, and consumption. Background launcher exit never establishes worker exit. A stopped supervisor permits explicit resumed observation without restarting its worker. Unknown final evidence remains pending. Callback delivery refuses before launch without original daemon parent authority.

`--arc-dispatch` waits up to 110,000 milliseconds for accepted native identity, within the waited completion deadline when selected. It prints the existing dispatch marker after the launch JSON. Missing identity produces no marker or replacement launch. The marker names the original transcript session, separate from Arc launch and Claude background job IDs. Absent or false `--agent-run` produces `owned: true`. Explicit true produces delegated work. `--attach` retains reader ownership. Attended Codex captures no transcript identity and prints no marker. Worker report text never supplies a marker. [Link a launched session](standalone-sessions.md#link-a-launched-session) owns receipt parsing and relationship discovery.

`--attach` opens a reader-owned session after terminal admission. It refuses Claude read-only and waited completion. Windows uses Windows Terminal with Git Bash from `DISPATCH_CLI_BASH` or Git's install ancestors. macOS uses Terminal. Other platforms use tmux when `TMUX` is set. Otherwise, they try x-terminal-emulator, then gnome-terminal. Codex runs interactively with a positional prompt and retains its real exit without a captured final response. Attended Codex refuses explicit log and report paths. Writable Claude starts in background mode, then opens its launch-bound native attach command. Failed terminal attachment preserves the original launch and result.

`arc dispatch logs LAUNCH_ID`, `arc dispatch attach LAUNCH_ID`, and `arc dispatch stop LAUNCH_ID` use the accepted Claude background identity of a standalone writable launch. Native output streams to the current terminal. A successful command returns JSON. Stop preserves the session and does not establish worker exit. Management refuses missing or ambiguous launch acknowledgments and native background IDs as command targets. `arc dispatch rm LAUNCH_ID` requires the same identity and refuses removal because native session and directory preservation remain unqualified. Extra arguments refuse before native execution. Arc removes no supplied directory, branch, transcript, or receipt.

## Read acknowledgments

Acknowledge delivered completed turns only at the reader's request:

```sh
arc read SESSION_ID --observation READ_OBSERVATION --request-id WINDOW_ID:read-check --window WINDOW_ID --dry-run --json
```

Copy `readObservation` from `arc session`, distinct from follow-up `observation`. Use a fresh request ID without `--dry-run` to save the acknowledgment. Partial replies acknowledge only their included completed turns. Source changes invalidate agent marks, including append growth. Preserve the request ID after `unknown`. [Read acknowledgment contracts](cli-reference.md#read-acknowledgments) define receipts and outcomes.

## Read a cost report

Cost reports read local records without an Arc window:

```sh
arc cost SESSION_ID --by-model
arc cost './session.jsonl' --source-only
arc cost SESSION_ID --since 2026-10-01T00:00:00Z --until 2026-10-02T00:00:00Z
```

Use a saved Claude Code or Codex ID, or an existing transcript or rollout path. An exact path resolves ambiguous ID discovery. `--source-only` requires a path and excludes children. Times require `Z` or an explicit offset. The report includes `--since` and excludes `--until`.

`cost` prints readable summaries by default. `--json` adds the fields below, tokens, context, and cache details.

| Field              | Meaning                                                                |
| ------------------ | ---------------------------------------------------------------------- |
| `parent`           | Selected source's requests.                                            |
| `children`         | Discovered descendant sources.                                         |
| `combined`         | Parent and retained children within the report window.                 |
| `pricedCostUsd`    | Known list-price subtotal.                                             |
| `estimatedCostUsd` | Legacy snapshot estimates, kept separately.                            |
| `costUsd`          | Full estimate, or `null` when prices or Codex coverage are incomplete. |

A null cost never counts as zero. These estimates use [supported list prices](cost-figures.md#supported-pricing), not subscription charges. Recorded reconciliation does not prove that the provider logged every request.

Run `arc cost --help` for model, tool, text-boundary, and Agent-window options. [Cost output](cli-reference.md#cost-reports) defines coverage, quantities, supplementary results, and custom source roots.

## Status line

[Configure Claude Code](../cli/README.md#status-line-setup) to run `arc statusline`. It reads one JSON object from stdin.

```sh
arc statusline --json < claude-status.json
arc statusline --next-turn < claude-status.json
```

In PowerShell, pipe the same input:

```powershell
Get-Content -Raw claude-status.json | arc statusline --json
```

`--width COLUMNS` reduces text detail. `--next-turn` prints only the next-turn starting price. Use either `--json` or `--next-turn`. [Status-line output](cli-reference.md#status-line) defines unknown values and price rounding.

## Troubleshooting

| Result | Action |
| --- | --- |
| `arc` is unavailable | Follow [installation and absolute-path setup](../cli/README.md#install). |
| Wrong or unavailable window | Run `arc windows --json`, check folders, and pass its current `hostId` with `--window`. |
| Unavailable session catalog | Open Arc in the selected window, then retry. |
| Invalid or expired cursor | Restart without `--cursor`. Preserve the query on later pages. |
| Stale or partial session reply | Read `state`, `partial`, and `notes`. An empty reply alone proves no empty history. |
| Unknown write | Preserve its ID and payload. Follow the command-specific retry rules above. |
| Null cost | Read coverage and the known subtotal. Missing usage and unsupported prices remain unknown. |

[Exit statuses and input errors](cli-reference.md#errors) provide automation details.
