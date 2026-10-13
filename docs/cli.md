# Arc CLI

The Arc CLI is experimental. npm publication is deferred.

The Arc CLI reports session cost from disk, renders Claude Code status-line input, and manages scoped sessions through running Arc windows.

`cost` reads a Claude transcript or Codex rollout and its discovered children. `statusline` reads one Claude Code JSON object from stdin.

## Run the command

Agents started by the panel can run `arc` from their shell commands through the extension's packaged launchers. [Agent runtime](agent-protocols.md#runtime-shape) owns their environment and window targeting.

Private VSIX launchers run their matching immutable release. Caller `ARC_HOME` still selects CLI data. [Extension installation](../README.md#try-it) owns terminal availability. Standalone commands use the separate npm installation route.

From a source checkout, build the CLI from the repository root:

```sh
npm --prefix cli run build
node cli/dist/arc.cjs --help
node cli/dist/arc.cjs --version
```

The [package README](../cli/README.md#install) covers installation and runtime requirements. It also covers [Claude Code settings](../cli/README.md#status-line-setup). Source development has separate [Node requirements](development.md#dependencies).

After global package installation, run `arc`:

```sh
arc --help
arc --version
arc cost SESSION_ID --by-model
```

`SESSION_ID` stands for a saved session's identifier. Path examples below require an existing transcript or rollout that you select.

`--version` takes precedence over every other argument. `--help`, the `help` command, and no arguments print the sectioned overview. `arc COMMAND --help` prints command syntax, flags, output fields, refusals, and an example. Nested commands accept help, including `arc label add --help` and `arc compact request --help`. Help reads no stdin and performs no window discovery, network access, or filesystem mutations.

## Windows

The command lists live window identifiers, workspace folders, repository scope readiness, panel readiness, and panel visibility. Folderless windows appear with no folders. Human output names the panel as visible, hidden, or not ready. Scope reads ready or loading. JSON contains `version: 1`, a `windows` array, and `complete`. Neither format includes channel addresses or tokens. An empty array means no verified live window. `complete: false` means discovery left entries unvisited or registered hosts unavailable. Human output names incomplete discovery, including when no host answered.

`ARC_HOME` selects the registry root and defaults to `~/.arc`. [Architecture](architecture.md#module-boundaries) owns the registry, channel, coverage limits, and cleanup rules. A requester uses `CLAUDE_CODE_SESSION_ID`, then `CODEX_THREAD_ID`, and otherwise sends `null`.

## Sessions

`sessions` and `session` print JSON. `--window` selects the window explicitly and takes precedence over `ARC_WINDOW`. Without either, exactly one live window and complete discovery are required. `session` rejects unknown or ambiguous IDs. File paths never select a session source. The selected window's current repository scope supplies session membership.

`sessions` returns one page with `version`, requester attribution, session rows, `complete`, explanatory `notes`, `next`, `coverage`, and `freshness`. Rows contain `source`, `id`, `provider`, `path`, `ambiguous`, `name`, `setup`, reader labels with their source, `pinned`, `archived`, `runStatus`, `attention`, `lastActivity`, `parent`, `agentRun`, `facts`, and `truncated`. `source` is a fixed-length key for one transcript source. `path` is the exact transcript file that `arc cost PATH --source-only` reads. Two transcripts with the same session ID are two rows with distinct `source` values, and both carry `ambiguous: true`. Setup reports recorded model and effort where accepted facts supply them. Missing values remain `null`. `facts` distinguishes current, stale, and unparsed metadata. Parent relations identify reader-started, dispatched, or subagent relationships. Run status uses `running`, `waiting`, `subagents`, `background`, `done`, `stopped`, `interrupted`, `failed`, `none`, and `unknown`. A done, failed, or interrupted turn reports `subagents` while a background subagent it launched has no close record. It reports `background` while a background command it started has no end record and is under one hour old. A Claude session without a turn reports `background` while accepted metadata retains command evidence without qualified process closure. Subagents take precedence over background. A process end that Arc records or observes after the turn starts reports the turn's own status instead. Without a process end, a done turn whose remaining records are only closed subagents or older background commands reports `unknown`, because a closed subagent can resume work that only its own transcript records. A failed or interrupted turn with only those records reports its own status. Claude sessions report `none` with current whole-file metadata, known empty turn starts, no outcome, and no live, waiting, or background work. Attention uses `input`, `unread`, `running`, `idle`, and `unknown`. Hidden panels report unknown live attention. Requester attribution names this request and establishes no saved session owner.

A page holds at most `--limit` rows, 128 by default. Its JSON stays below 48 KiB and below the channel's reply allowance for the window. Rows sort by `source`, so transcript appends never move a row to another page. `next` is the cursor for the following page, or `null` after the last page. Pass it unchanged to `--cursor` with the same window, and keep `--limit` if you set it. A `null` value of `next` does not establish complete discovery. Each page samples row facts when Arc serves it. Sessions added after the cursor appear on later pages.

`coverage` is `complete` when every page so far read a complete catalog and no session before the cursor was added, removed, or replaced. A session whose transcript lacks a device or inode identifier makes `coverage` `incomplete` on its own page and every later page, unless its page is the last. `coverage` is also `incomplete` otherwise, and `unavailable` when the window has no accepted catalog for its scope. `freshness` is `current` when every page so far was read with the panel visible and no pending refresh or file events. Every served transcript must also be unchanged since the catalog read. `freshness` is `stale` otherwise. A row reports `facts: current` when its accepted catalog revision matches both its transcript and metadata. Unrelated pending work and stale cumulative `freshness` do not invalidate that row. `complete` is `true` only on the last page, and only when `coverage` is `complete` and `freshness` is `current`. Complete traversal does not guarantee parsed row metadata. Notes never contain a session ID.

A forged, modified, or expired cursor fails with an instruction to restart without `--cursor`. A reload of the window expires every cursor. A scope change fails with the same restart instruction. An unavailable catalog or a channel timeout leaves the cursor valid, so retry with the same cursor. Only a first page returns an empty listing for an unavailable catalog.

`id`, `name`, `path`, `setup.model`, `setup.effort`, `parent.id`, and the `labels` array each have a cap of 4 KiB of serialized JSON. A longer `name` is shortened. Any other field over its cap becomes `null`. `truncated` lists each shortened or emptied field. A row that still does not fit an empty page keeps only `source`, `provider`, and its fixed-size facts. When window metadata leaves no room for that row, the command fails with an error that names the window metadata.

`sessions --query QUERY` filters catalog sources before row and byte limits. It accepts `id:`, `session:`, `agent:`, `title:`, `label:`, `is:archived`, and `is:agentrun`. [Session query syntax](rail-and-navigation.md#session-list) defines identities and OR groups. Other search areas, numeric predicates, and live statuses require `arc filter QUERY`. Retrieval reads catalog identity and cached reader metadata without scanning transcripts or marking turns read. Unavailable agent-run identity matches neither positive nor negated predicates and makes coverage incomplete. Repeat the exact query on every page. Changing or omitting it refuses its cursor. Queries accept at most 200 characters. Repeated, missing, malformed, or oversized arguments fail before application.

`session` defaults to five newest turns and accepts one through twenty. Its independent read allows at most 512 KiB, including source-directory checks and Codex opening reads. Open Arc to establish an unavailable session catalog before retrying. Output stops below 48 KiB and names excluded turns. Large turns that exceed the output allowance are excluded. A response exceeding the channel's full reply allowance fails explicitly. `partial` identifies bounded history, and `state` identifies current, stale, or unparsed reads. Stale reads return no turns. An unparsed read does not establish an empty session. Turn fields include prompt, response summary, recorded model and effort, timestamps, and completion state. These reads never mark turns read.

## Panel filter

`filter` reveals or creates the existing Arc editor panel and replaces its session list query. `--clear` clears it through an explicit flag that survives PowerShell argument handling. Supply one nonempty positional query, one `--query QUERY`, or `--clear`. Mixing or repeating these forms fails before transport. The command preserves selection, sort, groups, folds, Show settings, and saved filter definitions. A replacement clears retained lens membership and sets the live filter to Custom. Clearing restores All sessions.

Success reports `status: applied` only after the browser applies the query and persistent storage confirms its save. A rejected save reports `failed` even if the panel displays the query. An unconfirmed outcome after application reports `unknown`, including a filter superseded by Reset Panel State. Read the panel before retrying an unknown result. A window without query capability requires a reload. ID shorthand and noncanonical `session:` values of at least eight characters require `sessionQueryShorthandV1`. Older hosts refuse those queries before transport. Quoted literals, short exact `session:` values, and canonical UUID selectors retain legacy compatibility. Unresolved prefix retrieval and application fail during incomplete or unavailable discovery. Refused application preserves the previous query and preferences.

Assignments run in admission order. Queue time, readiness, application, and persistence share a 30-second operation deadline. Readiness receives at most 15 seconds. Persistence receives at most 10 seconds from browser application, including its storage queue wait. The transport waits 35 seconds. Expired or disconnected queued requests never apply or begin storage later. A save already started can settle after expiry. Its ordering barrier remains until settlement, and the command promises no storage rollback.

## Session management

`setups` returns the runtime catalog, permissions, and current, pinned, and recent setup keys. Use a returned key or explicit values. Omitted model, effort, and permissions retain provider defaults. Starts require a ready panel, project setup storage, and a loaded catalog for the chosen provider. Unsupported setup values refuse launch.

`start` reads one regular prompt file up to 48 KiB. Empty prompts and slash commands refuse launch. Repeat `--label` to apply initial labels. `--pinned` pins the new session. Omitted `--agent-run` or `--agent-run=false` retains reader ownership and Prompt box continuation. Bare `--agent-run` or `--agent-run=true` files delegated work under Run by agents. Classification cannot repeat across forms and accepts only literal `true` or `false`. Only `--arc-dispatch` prints the dispatch receipt. Reader-owned receipts include `owned: true`. The CLI measures the encoded request against the 64 KiB channel limit before it connects, and refuses a larger request before it sends anything.

Write results print JSON with `requestId` and a status. Starts report `accepted`, `accepted-with-errors`, or `refused`. Accepted results include `sessionId`, provider, requested setup, classification, attribution, and save errors. Requested settings do not establish observed provider execution. Curation reports `applied`, `dry-run`, or `refused`. Forced archive results also report `evaluatedRunStatus`, captured before membership changes. A missing listing row reports null. A rejected save produces an error. Dry runs perform no writes. Archive refuses running, needs-input, and completed unread sessions unless the request passes `--force`. A session whose run status is `subagents` or `background` refuses archive even with `--force`. Archive also refuses a session with unavailable state or hidden attention unless the request passes `--force`. Arc can miss background work in a session with unavailable state, and a forced archive then admits the session while that work runs. A forced archive keeps the current turn and any open question. [Child ownership and shutdown](agent-protocols.md#child-ownership-and-shutdown) owns when Arc ends the process of a session it hosts. Archive removes the pin. Unarchive preserves reader state and leaves the session unpinned.

A disconnected or timed-out write returns `unknown` with its request ID when delivery is uncertain. Use the returned ID for an identical-payload retry in the selected window. Fresh IDs are also accepted when prefixed with that window's `hostId` and a colon. The `windows` descriptor supplies `hostId`, which identifies one window activation. Arc retains one result per ID and refuses a conflicting payload. A window reload creates a new activation and makes an old ID's outcome unknown. Never change the ID to retry an uncertain launch. Requester text supplies attribution and grants no authority.

`compact request` asks Arc to compact the requesting agent's own session after its current turn. Both window values must name the same activation. The command begins up to four readiness reads across two seconds, then makes one admission attempt. Each read waits at most five seconds for an answer. A window without compaction support reports no readiness, so the command returns `refused`. Every compaction result names its outcome in a `state` field and carries the caller's request ID. The outcomes are `queued`, `started`, `completed`, `cancelled`, `refused`, `failed`, `uncertain`, and `unavailable`. A lost admission reply returns `uncertain`, which permits no retry or alternate transport. `compact status` observes a request ID without submitting work. It reports `unavailable` when the window holds no record of the ID or does not answer.

`send` delivers a follow-up prompt to a session that the requesting agent started. The requesting Claude Code or Codex session must have started it with `arc start --arc-dispatch` in the same window activation. Labels, parent links, and supplied session IDs never establish that relationship. `send` refuses when neither or both of `CLAUDE_CODE_SESSION_ID` and `CODEX_THREAD_ID` are set. The CLI refuses a window that predates follow-up delivery before it connects, and asks for a reload of that window. The prompt file follows the `start` rules, including the channel limit.

`--observation` takes the `observation` field of an `arc session ID --json` reply to the same requesting session. Only that requester receives the field, and only from a current read whose reply holds the newest turn. The observation binds the transcript revision, the newest turn, the repository scope, and the session's assignment. Arc consumes it when it attempts input. Reader input to the session makes earlier observations stale no later than when the panel accepts it. That input is a prompt, a queued prompt, a queued prompt edit or removal, an answer, Stop, a compaction, a clear, or a setting pick. The same input to the requesting session makes observations of every session it started stale. A new request ID never revalidates an old observation. Read the session again and prepare the follow-up from the new reply.

Arc admits a follow-up only when the session's process is ready and idle, with no asks, queued prompts, pending submissions, pending controls, waiting deferred self-compaction, or known background work. Missing or contradictory state refuses. Arc knows idle state from Claude idle reports, Codex root turns and compaction requests, and the panel's own queues and status. Work that none of these report stays invisible to admission.

Guarded send uses the session’s existing process in the owning Arc window. It never resumes or forks another copy to deliver a follow-up. Arc refuses ownership conflicts and unexplained session changes that it observes. Arc cannot prevent an independent resume outside that window.

The result reports `status`, `requestId`, `payloadSha256`, `nativeTurnId`, and `reason`. `accepted` means the agent acknowledged this exact prompt. It does not confirm that the work succeeded. `refused` means no prompt was sent. `unknown` means Arc attempted input without a conclusive receipt, and the CLI's own 120-second timeout also reports it. After an `unknown` result, Arc refuses every later follow-up to that session in the window activation. The block lasts until the panel accepts a prompt, a queued prompt change, an answer, Stop, a compaction, or a clear for that session. A setting pick makes observations stale but keeps the block, because the panel cannot tell whether the agent applied it. A retry with the same request ID and prompt returns the retained result and sends nothing again. A different prompt under that ID refuses as a conflict. Each window activation admits at most 256 distinct guarded request IDs. Every admitted follow-up consumes one lifetime unit, including accepted, unknown, and refused outcomes. Capacity never returns. Exhaustion rejects new unbound follow-ups before input. Accepted and unknown follow-ups also use the shared allowance of 256 write results for `start`, curation, and `send`. Refused follow-ups leave that shared allowance available. Starts and curation consume no guarded lifetime units.

```sh
arc setups --window WINDOW_ID
arc start --window WINDOW_ID --provider codex --prompt-file './review prompt.txt' --name 'Review branch' --label Review --pinned
arc label add SESSION_ID --label Followup --window WINDOW_ID
arc archive SESSION_ID --force --window WINDOW_ID
arc unarchive SESSION_ID --window WINDOW_ID
```

## Read acknowledgments

`arc read ID --observation TOKEN --request-id WINDOW:REQUEST [--dry-run] [--window WINDOW] [--json]` acknowledges completed turns delivered by `arc session`. Copy its `readObservation` field, separate from the guarded-send `observation`. The selected window requires `sessionRead` capability and one unambiguous Claude Code or Codex requester. The receipt binds that activation, requester, unique scoped target, physical source revision, and delivered projection. A partial reply can acknowledge its included completed turns. Unfinished and omitted turns remain outside the acknowledgment.

Results report `applied`, `dry-run`, `refused`, or `unknown`. Applied confirms saved read state and settled publication to attached ready panels. Dry runs save nothing. Identical retries retain the first outcome. Conflicting payloads refuse. Preserve the request ID after an unknown result. Source changes invalidate agent marks, including append growth. Unavailable source facts project no marks. Reader boundaries remain separate, and partial zero counts remain uncertain. Hidden panels receive accepted state when ready, while their attention remains unknown.

Each extension activation retains at most 256 distinct read operation IDs across agent acknowledgments, reader actions, resets, and source invalidations. New IDs refuse at capacity. Exact retained retries keep their original outcomes. Reloading starts a new activation and invalidates its prior receipts.

## Cost arguments

Run `arc cost --help` for target syntax and options. Cost reads no stdin and prints JSON by default.

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

For Codex, unique response IDs establish recorded billing requests. Identified compaction usage enters the total once, including when its native billing record also exists. `recorded-reconciled` permits a numeric total when every selected request has a supported price. `recorded-gaps` identifies missing recorded usage. `billed-with-unknown-coverage` identifies unresolved ownership, cumulative evidence, compaction, resets, or contradictory revisions. `unknown-request-coverage` identifies anonymous evidence. `legacy-snapshots` identifies estimates without bills. Complete Claude usage omits `coverage`. Combined coverage ranks gaps above unknown coverage, and unknown coverage above reconciled usage.

`requestCountExact: false` marks uncertain recorded request counts. Its omission establishes exact recorded identities, not proof that the provider logged every request. Anonymous snapshots appear under `snapshotEvidence` when bills exist. Request averages remain null when request identity is uncertain. Codex tool attribution and batching remain null because token reconciliation does not establish which response used each tool.

An empty window omits cost fields when it contains no coverage defect. An intersecting defect retains a null total and uncertain request count, even with no selected request. Evidence outside the window can resolve a selected bill or reveal an intersecting gap.

Source summaries include request counts, token quantities, context, request averages, and tool batching where the record supports them. Claude context figures use the final executor pass input. Token quantities sum every executor pass and advisor consultation. Source summaries also include failed tool calls, fast-mode pricing gaps, and cache-expiry returns. Codex failures carry a count without an attributed request cost.

`cacheExpiry.inputCostAfterExpiryUsd` prices the uncached input and cache writes on each return request. It excludes cached reads and output. `cacheExpiry.extraCostAfterExpiryUsd` prices the returning first pass's input that resent the previous final pass's context, above the cache-read price for those tokens. It leaves out new prompt text. Either amount is null when a return cannot be priced. `arc cost` counts a pair that crosses the cache lifetime with a compaction between its two requests in `cacheExpiry.excludedAmbiguous`, and never measures it from the compaction. Codex cache-expiry pairs remain observations, including with reconciled tokens. Their amounts remain null without independent adjacency evidence.

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

Run `arc statusline --help` for output options. The default output renders text from one Claude Code JSON object on stdin.

Without a valid width, text uses unlimited width. Invalid or missing `--width` values also use unlimited width. Width affects only text detail, not JSON or `--next-turn`. The required context, cache, and next-turn segments can exceed the requested width.

The status snapshot uses `null` for unavailable or invalid figures. Text shows unknown context as `--`, unknown cache as `unknown`, and an unpriced next turn as `next turn unknown`. Optional unavailable figures leave the text output.

For status-line settings, compatibility, and next-turn price meaning, see the [package README](../cli/README.md).

## Status-line examples

From the repository root in PowerShell, use the included synthetic input:

```powershell
Get-Content -Raw cli/test/fixtures/warm.json | node cli/dist/arc.cjs statusline --width 70
Get-Content -Raw cli/test/fixtures/warm.json | node cli/dist/arc.cjs statusline --json
Get-Content -Raw cli/test/fixtures/warm.json | node cli/dist/arc.cjs statusline --next-turn
```

On macOS or Linux, redirect the same input:

```sh
node cli/dist/arc.cjs statusline --width 70 < cli/test/fixtures/warm.json
node cli/dist/arc.cjs statusline --json < cli/test/fixtures/warm.json
node cli/dist/arc.cjs statusline --next-turn < cli/test/fixtures/warm.json
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

Successful commands write output to stdout and exit with status 0. Errors write one line prefixed with `arc:` to stderr and exit with status 1. Errors produce no report on stdout.

Cost rejects unknown options, missing option values, multiple targets, invalid times, unreadable transcripts, invalid regex syntax, and unresolved Agent launches. JSON arrays and identifiable Claude stream logs are unsupported. Empty files and files without native transcript records produce errors. Metadata-only native sessions and empty request windows remain valid. Status-line input must contain one JSON object. Empty input, malformed JSON, and incompatible output modes produce errors.

These complete stderr examples require no path substitutions:

```text
arc: --until-text requires --by-tool-kind.
arc: --json and --next-turn cannot be used together.
arc: Claude status input is not valid JSON.
```
