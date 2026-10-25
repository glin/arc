# Arc CLI reference

Use the [CLI guide](cli.md) for runnable examples. Run `arc COMMAND --help` for complete option syntax.

## Invocation

`--version` prints the package version and a twelve-character source commit, for example `0.1.0 (abcdef123456)`. Changed source adds `-dirty` inside the parentheses. Unavailable identity prints `unknown`. Unknown dirty state has no marker and does not establish a clean checkout. The command uses embedded build metadata without Git or the source folder.

`--version` takes precedence over every argument. No arguments, `help`, and `--help` print the overview. Command help supports nested commands. Help reads no stdin and performs no window discovery, network access, or filesystem mutations.

## Windows

`windows --json` returns `version: 1`, `windows`, `complete`, and optional `diagnostics`. Window fields include `hostId`, `pid`, `version`, `folders`, `scopeReady`, `panelReady`, `panelVisible`, and optional authenticated `capabilities`. Legacy windows omit capabilities. Folderless windows have no folders. Output excludes channel addresses and tokens.

Human output names panel visibility and scope readiness. Incomplete discovery retains reachable windows and exits 0. `complete: false` covers unvisited entries, denied registry access, and unavailable registered hosts.

Diagnostics report observed `ENOENT`, `EACCES`, or `EPERM`, the `registry` or `connection` stage, and an optional `hostId`. Human output names the same failures. Diagnostics exclude raw errors and authentication data. Cleaned-up registrations and closed windows leave no diagnostic. An empty incomplete listing alone establishes no permission failure. Windows bridge setup failures and pipe closures remain generic.

`ARC_HOME` selects the registry root, defaulting to `~/.arc`. [Architecture](architecture.md#module-boundaries) owns channel discovery and cleanup. Requester attribution uses `CLAUDE_CODE_SESSION_ID`, then `CODEX_THREAD_ID`, otherwise `null`. Attribution grants no authority.

The [guide's window selection rules](cli.md#windows) apply to window commands. A missing selected registration reports an unregistered window. Observed `EACCES` or `EPERM` reports local access failure. Other unavailable causes remain generic.

## Sessions

Session reads use the selected window's accepted catalog and repository scope. They never enumerate transcripts or advance discovery.

### Listing output

`sessions --json` returns `version`, `requester`, `sessions`, `complete`, `notes`, `next`, `coverage`, and `freshness`.

| Row field | Meaning |
| --- | --- |
| `source` | Fixed-length key for one transcript source. Rows sort by this key. |
| `id`, `provider`, `path` | Session identity, provider, and exact file usable by `arc cost PATH --source-only`. |
| `ambiguous` | Another source shares this session ID. |
| `name`, `setup` | Recorded name, model, and effort where accepted facts supply them. Missing values remain `null`. |
| `labels`, `pinned`, `archived` | Reader metadata. Labels include their source. |
| `runStatus`, `attention`, `lastActivity` | Observed activity and attention, independent of reader review and archive eligibility. |
| `parent`, `agentRun` | Reader-started, dispatched, or subagent relationships and classification. |
| `facts` | `current`, `stale`, or `unparsed` metadata. |
| `truncated` | Fields shortened or emptied to fit output limits. |

A page holds at most 128 rows by default and stays below 48 KiB and the window's full reply allowance. `--limit` accepts 1 through 128. Transcript appends do not reorder rows. Each page samples facts when served. New sources after the cursor can appear on later pages.

Pass `next` unchanged to `--cursor` with the same window, query, and limit. Modified or expired cursors refuse. Window reloads and scope changes require restarting without a cursor. An unavailable catalog or channel timeout leaves the cursor valid for retry. Only a first page returns an empty listing for an unavailable catalog.

| Field | Contract |
| --- | --- |
| `coverage: complete` | Every page so far reads a complete catalog, with no source before the cursor added, removed, or replaced. |
| `coverage: incomplete` | Catalog or source identity coverage is incomplete. Missing device or inode identity affects its page and later pages unless it is last. |
| `coverage: unavailable` | The window has no accepted catalog for its scope. |
| `freshness: current` | Every page so far has visible-panel observation, no pending refresh or file events, and unchanged served transcripts. |
| `freshness: stale` | At least one freshness condition fails. |
| `complete: true` | This is the last page, coverage is complete, and freshness is current. |

A row has `facts: current` when its accepted revision matches its transcript and metadata. Stale cumulative freshness does not invalidate that row. Complete traversal does not establish parsed row metadata. Notes contain no session IDs.

`id`, `path`, `setup.model`, `setup.effort`, `parent.id`, and `labels` each have a 4 KiB serialized cap. Names share that cap but shorten instead of becoming `null`. Other oversized fields become `null`. Oversized rows retain only `source`, `provider`, and fixed-size facts. Window metadata that prevents even a minimal row produces an explicit error.

### Queries

`sessions --query` filters catalog sources before row and byte limits. The [guide](cli.md#sessions) lists admitted predicates. Queries accept at most 200 characters. Repeat the exact query on every page. Changing or omitting it refuses the cursor. Retrieval reads catalog identity and cached reader metadata without scanning transcripts or marking turns read.

Unavailable agent-run identity matches neither positive nor negated predicates and makes coverage incomplete. Repeated, missing, malformed, and oversized arguments fail before application.

### Run status and attention

Run status uses `running`, `waiting`, `subagents`, `background`, `done`, `stopped`, `interrupted`, `failed`, `none`, and `unknown`.

A completed, failed, or interrupted turn reports `subagents` while a background subagent it launched has no close record. It reports `background` for an unended background command under one hour old. Subagents take precedence. Claude sessions without turns also report `background` when accepted command evidence lacks qualified process closure.

A process end recorded or observed after the turn starts preserves the turn's own status. Without that evidence, closed subagents or older commands leave a done turn `unknown`. A closed subagent can resume work visible only in its own transcript. Failed and interrupted turns retain their status in that case.

An unfinished turn without live running evidence or process closure reports `unknown`. It becomes `stopped` one hour after its last assistant activity. Without a readable end time, it stays `unknown`.

Claude reports `none` with current whole-file metadata, known empty turn starts, no outcome, and no live, waiting, or background work. Attention uses `input`, `unread`, `running`, `idle`, and `unknown`. Hidden panels report unknown live attention.

### Turn reads

`session --json` returns `version`, `requester`, `id`, `provider`, `state`, `turns`, `subagentContext`, `partial`, `readByteLimit`, and `notes`. Eligible replies also supply `observation` for follow-ups and `readObservation` for read acknowledgments.

`subagentContext` estimates the text that subagents returned into the current context, as `{ tokens, share, partial }`. `tokens` estimates from UTF-8 size, at approximately 2.79 bytes per token for Claude and four for Codex. `share` divides `tokens` by the recorded current context, or is `null` when that context is unknown. A share above 1 stays as computed. `partial` is `true` when the read could not reach every result the figure covers. `tokens` is `0` when the read shows no subagent result. The field is `null` when the read returns no current turns.

Each explicit read qualifies the selected accepted source's current opening without advancing discovery. Valid growth remains readable. Unknown membership, competing sources, replacement, changed opening identity or working directory, and unavailable qualification refuse the read. A source change during qualification or parsing returns no turns. Notes identify the failed condition.

The default is five newest turns, with 1 through 20 permitted. Reads allow 512 KiB, including directory checks and Codex opening reads. Output stays below 48 KiB and names excluded turns. Oversized turns are excluded. Exceeding the window's full reply allowance fails explicitly.

`partial` identifies bounded history. `state` is `current`, `stale`, or `unparsed`. Stale reads contain no turns. Unparsed reads do not establish empty history. Turn fields include `promptId`, `startedAt`, `endedAt`, `prompt`, `summary`, `model`, `effort`, `finished`, `interrupted`, and `error`.

## Collection

The version 1 `collect` envelope contains `window`, `selection`, `limits`, `listing`, `pages`, `rows`, `reads`, `outcomes`, and `turnRequests`.

| Field | Contract |
| --- | --- |
| `pages` | Raw replies or bounded errors, with their generation. Additive fields and notes remain intact. |
| `listing.usablePages` | Indexes accepted pages in the current generation. |
| `rows` | `{page, row}` references to usable sources. Raw rows exist only in page replies. |
| `listing` | Separate `stop`, traversal `ended`, `coverage`, `freshness`, `pageRequests`, and `generation`. |
| `outcomes` | One result per usable source when turns are requested. Each references its `rows` index and raw `reads` observations. |

Coverage and freshness remain null until a usable page exists. Cursor or scope refusal restarts once and excludes abandoned rows from usable results. Timeout or unavailable reads retry once with the same cursor. Repeated cursors, malformed replies, and unknown errors stop the affected path while preserving earlier observations.

Turn outcomes use `completed`, `skipped`, or `failed` with bounded reasons. Completed collection preserves partial, stale, and unparsed replies. Null, empty, truncated, ambiguous, colliding, and over-256-character identities receive skipped outcomes. Distinct providers and paths retain distinct listing rows. Source order establishes no priority.

Turn replies retain their returned identity separately from the requested row. Matching IDs and providers do not establish physical source continuity. Read receipts remain raw data and grant no automatic acknowledgment.

[Collection options](cli.md#collect-session-data) bound request admission. Retries and abandoned requests consume those limits. At most two turn requests run concurrently. Deadline expiry permits started requests to settle. Transport and Windows helper preparation prevent a fixed completion-time promise. Request limits establish no total host-I/O bound.

Output stays within eight MiB. Capacity exhaustion retains explicit outcomes and complete JSON. Collection supplies no ranking or summary.

## Panel filter

Use one nonempty positional query, one `--query QUERY`, or `--clear`. Mixing or repeating forms refuses before transport. Replacement clears retained lens membership and sets the live filter to Custom.

ID shorthand and noncanonical `session:` values of at least eight characters require `sessionQueryShorthandV1`. Older hosts refuse those queries before transport. Quoted literals, short exact `session:` values, and canonical UUID selectors retain legacy compatibility. Unresolved prefix retrieval and application fail during incomplete or unavailable discovery. Refusal preserves the previous query and preferences.

Assignments run in admission order. Queue time, readiness, application, and persistence share a 30-second deadline. Readiness receives at most 15 seconds. Persistence receives at most 10 seconds after application, including its storage queue wait. Transport waits 35 seconds.

Expired or disconnected queued requests never apply or begin storage later. Started saves can settle after expiry and retain their ordering barrier. Storage rollback is not guaranteed. An unconfirmed application, including one superseded by Reset Panel State, reports `unknown`.

## Setups

`arc setups` prints the project, reusable setup keys, model-specific efforts, and provider permissions. It marks the primary key and unavailable setups. `(default)` means omitting that flag. The literal model alias `default` remains distinct. A project without reusable setups still offers explicit provider settings.

`--json` returns one compact object:

| Field     | Meaning                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------- |
| `version` | Output version, currently `1`.                                                                           |
| `project` | Project identity.                                                                                        |
| `primary` | Preferred setup key, omitted when absent. An unavailable current setup can remain primary.               |
| `setups`  | Reusable rows with `key`, `provider`, and optional `model`, `effort`, `permissions`, and `missingValue`. |
| `agents`  | Providers with `provider`, `models`, `permissions`, and optional `modelsPending: true`.                  |

Setup keys retain `current`, `pin:ID`, and `recent:INDEX` values. Each distinct key appears once, including a primary key hidden from the panel's recent list. Empty setup overrides are omitted. Their absence retains provider resolution without identifying a concrete model, effort, or permission preset. `missingValue` identifies the first unavailable dimension: `agent`, `model`, `effort`, or `permission`. Available rows omit it.

Each provider's `models` lists exact catalog values as `{value, efforts}`, with string-array efforts. Aliases and full model IDs remain separate values. The first occurrence of an exact model value determines its efforts. Empty model, effort, and permission strings remain selectable provider defaults. The empty model offers the union of catalog efforts. Existing unique window-suffix matches, such as `opus[1m]`, also validate.

`modelsPending: true` marks incomplete model discovery. Permissions remain listed during discovery. Starts refuse until that provider's catalog loads, including reusable rows without a missing value.

## Session writes

Starts require a ready panel, project setup storage, and a loaded provider catalog. Unsupported settings refuse launch.

Prompt files must be regular and at most 48 KiB. Empty prompts and slash commands refuse. Encoded requests above the 64 KiB channel limit refuse before connection. Explicit working directories resolve from the caller's directory and use their real filesystem destination.

`--agent-run` and `--agent-run=true` classify delegated work. Omission or `--agent-run=false` retains reader ownership and Prompt box continuation. Classification accepts only literal `true` or `false` and cannot repeat. Only `--arc-dispatch` prints the dispatch receipt. Reader-owned receipts include `owned: true`.

`--cache-lifetime 5m` and `--cache-lifetime 1h` set `CLAUDE_CODE_PROMPT_CACHE_TTL` for a Claude launch from `start` or `run`. The flag replaces a value in the caller's environment for `run` and in the window's environment for `start`. Other values refuse. Codex launches refuse the flag, including a `--setup` key that selects Codex. Without the flag, a Claude launch under Run by agents gets `5m` unless the environment sets the variable, and a reader-owned launch keeps the environment value or the provider default. A standalone receipt records the requested value in its launch context. A hosted receipt does not record it. The requested value applies to the processes that a hosted start launches. A later resume of that session, after Arc retires its process, uses the default. `cost` reports the lifetime that the transcript records.

`--read-only` retains an immutable launch policy through follow-ups, clear, resume, fork, and permission setting changes. It refuses permission overrides. Repeat `--read-tool EXACT_MCP_TOOL` for Claude read-only MCP tools. [Hosted read-only launches](agent-protocols.md#hosted-read-only-launches) define provider restrictions and filesystem guarantees.

| Result | Meaning |
| --- | --- |
| Start `accepted` or `accepted-with-errors` | Launch accepted. Includes session ID, provider, requested setup, classification, attribution, and save errors. |
| Curation `applied` | Metadata change accepted. Rejected saves produce errors. |
| Curation `dry-run` | Admission checked without writes. |
| `refused` | Request refused, with its reason. |
| `unknown` | Delivery is uncertain. Retain the request ID and original activation. |

Start JSON includes additive `metadata.labels` and `metadata.pinned` results. Their `state` is `saved` only after persistence succeeds, otherwise `uncertain`. Labels include normalized `values`, and pin state includes `value`. Requested names include `metadata.name.requested` and a `state` of `pending`, `saved`, `failed`, `cancelled`, or `uncertain`. A known naming error also includes `error`. Durable pending naming permits `accepted`. Known metadata failure produces `accepted-with-errors`. Detailed session JSON exposes retained name state after ordinary catalog admission. Catalog visibility remains eventual. The start result supplies no catalog membership or observed model evidence.

Write JSON includes `requestId` and `status`. Unknown delivery omits accepted-result and curation details. Fresh IDs use the selected `hostId` followed by a colon and caller ID. Identical-payload retries return the retained result. Conflicting payloads refuse. Reloads invalidate the activation. The CLI never retries writes automatically.

Forced archive replies include `evaluatedRunStatus` before membership changes, or null without a listing row. [Archive safety](cli.md#session-management) applies independently of that observation. [Child ownership and shutdown](agent-protocols.md#child-ownership-and-shutdown) define hosted process retirement.

Each activation retains at most 256 shared write results for starts, curation, and queued, accepted, or unknown sends. Guarded sends separately admit at most 256 distinct IDs, including refused outcomes. Capacity never returns. Refused guarded sends preserve shared-result capacity. Exact retained retries precede capacity checks. Starts and curation consume no guarded units.

## Follow-ups

`send` requires exactly one native requester identity, from `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`. Without `--observation`, ordinary delivery requires `agentMessageSend` capability and transmits `delivery: "auto"`. Older windows refuse before transmission. Explicit `--queue` or `-q` requires `agentMessageQueue` and omits `delivery`. Upgraded hosts preserve queue-only behavior for legacy requests that omit both `delivery` and `observation`.

Ordinary accepted results include `delivery`: `turn` for idle prompt receipt, `steer` for exact-turn Codex acknowledgment, or `live` for Claude UUID replay. Receipt confirms neither completed work nor Claude consumption before the original turn ends. Queue admission includes `queuedSubmissionId` after durable saving. Admission creates no parent relationship or reader ownership. A retained retry returns its original result. Changing delivery mode under that request ID refuses.

With `--observation`, that requester must have started the target with `--arc-dispatch` in the same activation. Labels, parent links, and supplied IDs establish no ownership. A window without follow-up capability refuses before connection and requires a reload.

Only the owning requester receives `observation`, from a current read containing the newest turn. It binds source revision, newest turn, scope, and assignment. Arc consumes it when attempting input.

Reader input makes observations stale by panel acceptance. This includes prompts, queue changes, answers, Stop, compaction, clear, and setting picks. The same input to the requester invalidates observations for every session it started. A new request ID never revalidates an old observation. Read again before preparing another follow-up.

Observed follow-up admission requires a ready, idle process without asks, queued prompts, pending submissions or controls, deferred self-compaction, or known background work. Missing or contradictory state refuses. Work absent from native reports and panel state remains invisible.

Delivery uses the existing process in the owning window. It never resumes or forks another copy. Observed ownership conflicts refuse both input forms. Unexplained source changes refuse observed follow-ups. Independent resumes outside that window remain possible.

Results include `status`, `requestId`, `payloadSha256`, `nativeTurnId`, and `reason`. The [guide](cli.md#follow-ups) defines delivery statuses. The CLI's 120-second timeout reports transport `unknown` while the bounded host attempt continues. An identical retained retry retrieves that attempt without writing again. A client timeout does not release its target reservation. Terminal host `unknown` blocks later sends until panel input reaches that session. Prompts, queue changes, answers, Stop, compaction, and clear remove the block. Setting picks invalidate observations but preserve the block.

## Compaction

The observed root command supplies compaction intent. Reader delegation, submission ancestry, and foreground execution are not admission requirements. Notification and continuation turns can request repeated compaction without renewing task or spending authority. New reader activity after observation cancels unsubmitted work and suppresses continuation.

Request IDs use `WINDOW:UUID` with a lowercase UUID. Request window values must match the same activation. Requests begin up to four readiness reads across two seconds, then attempt admission once. Each read waits at most five seconds. Missing compaction support returns `refused`.

Results include `requestId` and `state`: `queued`, `started`, `completed`, `cancelled`, `refused`, `failed`, `uncertain`, or `unavailable`. Lost admission replies return `uncertain`. Observe the original ID without retrying or switching transports. `compact status` submits no work. Missing records and unanswered status requests return `unavailable`.

### Continuation files

Add `--continuation-file 'ABSOLUTE_PATH' --continuation-sha256 SHA256` immediately after `--after-turn`. Include both literal values in the native shell command.

Files require 1 through 8192 exact UTF-8 bytes. BOM, NUL, invalid UTF-8, whitespace-only input, and leading slash commands refuse. The digest is lowercase SHA-256 for those bytes. Arc reads the regular file once without deleting or rereading it.

Windows paths must be drive-absolute. POSIX paths must begin `/`. Use forward slashes and single quotes. Filenames accept ASCII letters, digits, spaces, underscore, period, hyphen, parentheses, and slash. Empty or dot segments, repeated slashes, shell expansion, and paths above 1024 characters refuse.

Arc saves the instruction before admission succeeds. Each completed compaction delivers its explicit continuation once outside the ordinary prompt queue. Its separate observation retains `state`, `sequence`, exact `text`, `sha256`, `write`, `nativeTurnId`, and `reason`. States are `waiting`, `preparing`, `attempting`, `accepted`, `cancelled`, `refused`, and `uncertain`.

Completed compaction does not establish continuation acceptance. Accepted continuation confirms prompt acknowledgment, not task completion. The prompt is agent-authored and uses the provider's ordinary format.

Continuation requires attributable native completion, settled controls, positive idle evidence, and unchanged reader revision on the retained child. Reader input, questions, queued work, changed source or settings, archive, and scope loss suppress delivery. Arc saves possible input before its final authority check. Uncertain writes never retry automatically.

Active requests and continuations wait for their prerequisites without execution deadlines. Saved status includes `originWindow` and `servedByWindow`. Only the same workspace and exact currently admitted source expose instruction text. Ended origins cancel unattempted work or expose possible input as uncertain. Status writes nothing and restarts no work. Terminal status remains visible for up to one hour after settlement. Capacity pressure evicts eligible terminal receipts sooner. Active receipts and possible writes remain protected.

## Dispatch results

`start --arc-dispatch` requires `dispatchResults` capability and reserves a durable launch receipt before starting. Accepted JSON includes `launchId`. `--completion manual` selects retained retrieval by default. `--completion wait` selects waited completion. Neither sends automatic parent notices.

`--report-file PATH` copies available reports to a regular output alias outside private dispatch storage. Both completion and report-file options require `--arc-dispatch`.

| Command | Contract |
| --- | --- |
| `dispatch status` | Bounded event pages with identity, outcomes, report and delivery availability, and consumption digests. Default limit: 32, range: 1-128. Follow `next`. |
| `dispatch result` | One frozen report and saved disposition. Text above 16,000 characters returns its private path, digest, and byte size. |
| `dispatch claim` | Claims one exact event. A different owner refuses. The same owner receives its retained random token. |
| `dispatch ack` | Saves a UTF-8 disposition before consumption. Requires a regular file up to 16 KiB that fits the exact-event reply allowance. |
| `dispatch refresh` | Publishes changed private report observations as separate unconsumed events without messaging agents. |
| `dispatch recover` | Reads the event and its completion route without input. Delivery remains unavailable because launches have no callback route. |
| `dispatch monitor` | Resumes standalone observation under an exclusive monitor claim. Hosted launches use lifecycle observation. |
| `dispatch wait` | Accepts standalone manual or waited completion. Hosted launches require waited completion. Default deadline: 110,000 milliseconds, range: 1-110,000. Hosted waits use the channel without model polling. Standalone waits read retained events. |

`reportSource` names the current private report. JSON stays below 48 KiB. Reports above eight MiB remain unavailable. A native root ending establishes success or failure. Matching saved transcript evidence establishes report availability. Missing saved evidence leaves it pending. Failed and interrupted turns retain their outcomes. Needs-input events identify the ask without a fabricated report. Process exit without a native ending reports unknown.

Acknowledgment retries return the saved disposition. Conflicting dispositions refuse. Tokens for earlier events never consume changed events. Wait failures and recovery behavior follow the [guide](cli.md#dispatch-results).

## Read acknowledgments

`read` requires `sessionRead` capability and one unambiguous native Claude Code or Codex requester. Its receipt binds activation, requester, unique scoped target, physical source revision, and delivered projection. Unfinished and omitted turns remain outside the acknowledgment.

Status is `applied`, `dry-run`, `refused`, or `unknown`. Applied confirms saved read state and settled publication to attached ready panels. Hidden panels receive accepted state when ready, while their attention remains unknown. Dry runs save nothing. Identical retries retain the first outcome. Conflicting payloads refuse.

Unavailable source facts project no marks. Reader boundaries remain separate, and partial zero counts remain uncertain. Each activation retains at most 256 distinct read operation IDs. New IDs refuse at capacity. Retained retries, ordinary panel reading, preference resets, and source invalidation remain available. Saves share a limit of 256 pending jobs. Reloads invalidate prior receipts.

## Cost reports

Cost prints readable summaries by default. `--json` prints one structured object. Neither format reads stdin. `schemaVersion: 3` identifies the contract. `buildCommit` identifies the bundled commit, or `unknown` without build identity. `rateNote` describes pricing.

### Source selection

Explicit `--projects` and `--codex-sessions` roots override environment values. Claude uses `ARC_PROJECTS_ROOT`, otherwise `projects` under `CLAUDE_CONFIG_DIR` or `~/.claude`. Codex uses `ARC_CODEX_ROOT`, otherwise `sessions` under `CODEX_HOME` or `~/.codex`.

ID discovery checks Claude project directories and Codex rollout filenames. Missing or multiple matches fail. Existing paths take precedence over ID discovery.

`--until` must be at or after `--since`. Equal bounds produce an empty main request window. That window applies to `parent`, `children`, and `combined`. Bounded reports retain children with requests, recorded failures, or intersecting coverage defects.

`--source-only` makes `children` empty and combined quantities equal parent quantities. Combined summaries never include `modelCosts`. Direct reads retain failures and linked print exclusions. Agent lookup still reads exact adjacent subagent metadata when needed.

### Quantities and missing coverage

The [guide](cli.md#read-a-cost-report) defines top-level summaries and dollar fields. Complete Claude usage omits `coverage`. Codex uses these values:

| Coverage | Meaning |
| --- | --- |
| `recorded-reconciled` | Recorded usage reconciles. A numeric total requires supported prices for every selected request. |
| `recorded-gaps` | Recorded usage is missing. |
| `billed-with-unknown-coverage` | Ownership, cumulative evidence, an unexplained compaction, resets, or contradictory revisions remain unresolved. |
| `unknown-request-coverage` | Evidence lacks identified requests. |
| `legacy-snapshots` | Estimates use snapshots without bills. |

Unique Codex response IDs establish recorded billing requests. Identified compaction usage enters the total once, including when its native bill also exists. Combined coverage ranks gaps above unknown coverage, then reconciled usage.

A compaction keeps reconciliation intact when its `compacted` record names a response, that response has a complete bill from the source thread, and the next snapshot repeats the total before that bill with zero request counters. When the `compacted` record carries a copy of that bill, each response, thread, usage, and cumulative field in the copy must equal the native bill. Each later snapshot must then equal its bill's thread total minus the usage of every earlier compaction bill that meets these conditions since the last snapshot reset, in every counter. Any other difference leaves coverage unresolved from that point.

A source summary whose coverage is neither absent nor `recorded-reconciled` carries `coverageDefect`. Its `kind` repeats the coverage value. `since` is the start of the earliest intersecting unresolved interval of any kind, which can precede `--since`. It is null for `legacy-snapshots`, which has no interval. `cause` names what left that interval unresolved. Combined summaries and `modelCosts` rows omit `coverageDefect`. Unsupported prices appear in `unpricedModels` instead.

| Cause | Meaning |
| --- | --- |
| `compaction-unmatched` | A compaction has no identified bill, its copy in the `compacted` record disagrees with the bill, or the bill does not explain later snapshot totals. |
| `snapshot-unmatched` | A bill has no matching snapshot or no cumulative counters, or a snapshot has no matching bill. |
| `foreign-thread` | A bill or session record belongs to another thread. |
| `conflicting-bill` | Complete revisions of one bill disagree. |
| `cumulative-jump` | Cumulative counters disagree with the identified bills and do not fall below their previous values. |
| `reset` | Cumulative counters fall below their previous values. |
| `anonymous-evidence` | Evidence names no billing identity or no thread. |
| `legacy-snapshots` | The source records snapshots and no bills. |

`requestCountExact: false` marks uncertain recorded request counts. Omission establishes exact recorded identities, not complete provider logging. With bills present, anonymous snapshots appear under `snapshotEvidence`. Request averages remain null when request identity is uncertain. Codex tool attribution and batching remain null.

An empty window omits cost fields without a coverage defect. An intersecting defect retains a null total and uncertain request count, even without selected requests. Evidence outside the window can resolve bills or reveal intersecting gaps.

Source summaries include supported request counts, tokens, context, averages, tool batching, failures, fast-mode pricing gaps, and cache-expiry returns. Claude context uses the final executor pass input. Tokens sum every executor pass and advisor consultation. Codex failures retain a count without attributed request cost.

`cacheExpiry.coverage` is `complete` when coverage is absent or `recorded-reconciled` and every selected request is exact and complete. The request before `--since` supplies the neighbor of the first selected request. It adds no return or charge. When the source cannot establish that request, `cacheExpiry.coverage` is `unknown-request-coverage`.

`cacheExpiry.inputCostAfterExpiryUsd` prices uncached input and cache writes on return requests. It excludes cached reads and output. `extraCostAfterExpiryUsd` prices returning first-pass input that resends prior final-pass context, above the cached-read price. It excludes new prompt text. Unpriced returns leave either amount null.

Compaction between requests crossing cache lifetime increments `cacheExpiry.excludedAmbiguous`. The command never measures that pair from compaction. Codex cache-write counters establish volume, not lifetime. Claude child prompts have no visible turn boundary. Codex pairs remain observations. Their amounts stay null without independent adjacency evidence.

### Model detail

`--by-model` adds `modelCosts` to parent and child summaries. Each row retains its recorded model name, or null when missing. Rows contain billing request counts, coverage, dollar amounts, and normalized token quantities. Prices include recorded amounts, provider routes, context bands, and service tiers.

Tokens are observed subtotals. A normalized zero does not prove the source recorded that counter. Source coverage uncertainty applies to every row, including fully priced rows. Unattributable snapshots and tools remain on source summaries. Model rows omit context, averages, failures, and cache-expiry figures.

Model quantities reconcile with source billing before rounding. Full costs require complete or recorded-reconciled coverage and supported prices. Public dollar values round to four decimals after addition. Summed rounded model amounts can differ from rounded source amounts.

### Supplementary results

`--by-tool` splits each parent request's price evenly across the tool results it reads. A Claude request reads the results recorded before it. A Codex request reads the outputs recorded before its billing record, which is the first `token_usage_record` after each output. A Codex rollout without billing records reports every request as `no tool result`. Codex `wait_agent`, `wait`, and `write_stdin` calls form the `wait` kind.

Each `byTool.rows[]` row names a kind and lists its `tools[]`. A tool is the tool name, or the tool and its program for a shell command, such as `Bash git` or `exec_command rg`. Tool shares use the same total as kind shares, so the tools of a kind sum to that kind. Text output indents each tool under its kind. A request counts once for every kind and every tool it touches, so row request counts can exceed the parent total. Top-level `byTool` uses the main parent window. `--by-tool-kind` is an alias of `--by-tool`.

`--until-text REGEX` requires `--by-tool`. Its separate `untilText.byTool` excludes the first matching parent request and all later requests within the main window. No match includes every parent request in that window. `untilText.matched` reports whether one exists. This result changes no other summary.

Matching searches Claude assistant text and tool input. Codex supplies empty text. Patterns requiring characters never match Codex. Empty-text patterns also match Codex and empty Claude requests. Multiline `^$` also matches blank Claude lines, including the separator before tool input without assistant text. A literal empty argument refuses.

Regex matching is multiline. Leading `(?i)`, `(?m)`, and `(?s)` select case-insensitive, multiline, and dot-all behavior. `\A` and `\Z` match input boundaries. Unsupported syntax fails.

`--window-agent ID` resolves launches from structured results, exact adjacent metadata, or launch-result text. The `agent-` prefix and `.jsonl` suffix are optional. Its separate `parentWindow` starts with the parent request launching that Agent. It ignores `--since`, includes requests at `--until`, and excludes children. With `--by-tool`, it includes its own tool result.

## Status line

`statusline` consumes one Claude Code JSON object. Text is the default. `--json` prints schema version 1 with `source: claude-statusline`, `model`, `workspace`, `session`, `context`, `cache`, `nextTurn`, and `limits`.

Unavailable or invalid figures use null. Text shows unknown context as `--`, unknown cache as `unknown`, and unpriced next-turn input as `next turn unknown`. Optional unavailable figures disappear.

Width uses `--width` before `COLUMNS`. Missing or invalid values mean unlimited width. Width changes text detail alone. Required context, cache, and next-turn segments can exceed it.

Text rounds positive next-turn starting prices below $10 upward to cents. Prices at least $10 round upward to whole dollars. JSON retains the underlying amount. [Status-line setup](../cli/README.md#status-line-setup) defines next-turn estimates and settings.

## Errors

Successful commands exit 0. Unless stated otherwise below, errors print one `arc:`-prefixed line to stderr, exit 1, and produce no stdout report. Returned outcomes such as `refused` and `unknown` are command output, distinct from CLI errors.

Cost rejects unknown options, missing values, multiple targets, invalid times or regexes, unreadable transcripts, and unresolved Agent launches. JSON arrays, identifiable Claude stream logs, empty files, and files without native transcript records fail. Metadata-only native sessions and empty request windows remain valid. Repeated cost options use their last value. When cost handles `SIGINT` or `SIGTERM` cancellation, it exits 130 or 143, respectively, and produces no stdout report.

Status-line input rejects empty stdin, malformed JSON, and non-object values. `--json` and `--next-turn` cannot combine. Other unknown status-line arguments are ignored.

`skills install`, `skills update`, and `skills remove` require repeatable `--agent claude` or `--agent codex`. They need no Arc window, network, hooks, or authentication. JSON reports each destination separately. Invalid selectors exit 2 before writes. Failed or incomplete destinations exit 1. Handled HUP, INT, and TERM exit 129, 130, and 143 after filesystem settlement. Repeated signals preserve the first cancellation. [Skill installation and recovery](arc-sessions.md#install-the-parts-you-need) defines destination and preservation rules.
