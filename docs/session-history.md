# Session history

[Session discovery](session-discovery.md) owns admission, repository scope, and relationships. [Data sources](data-sources.md#source-catalog) owns storage locations. [Retained rendering](panel-rendering.md#retained-rendering-contracts) owns browser node updates.

## Selected session history

A selected recorded session opens once the published catalog lists it. Otherwise it waits for ordinary discovery. Locally started drafts and accepted sessions retain host state until their records appear. Imported children receive no local awaiting-session ownership.

Selection starts with a bounded tail. Its loading payload precedes metadata work for other sessions. When the newest turn begins earlier, the worker scans disjoint older chunks for its boundary. Provider-specific adapters reduce 256 KiB chunks, observe cancellation between chunks, and create the accepted forward checkpoint. The host keeps their parser state opaque.

A completed prefix can publish when the same file grows during reading, then resume at the new revision. Append reuse validates physical identity and a bounded content anchor. Replacement, shrinkage, same-size rewrites, and incompatible identity discard affected work. Read failures retain drawable cards and show failed history status. Without cards, they show a diagnosis. Refresh or selection retries.

Older history reads semantic pages without enlarging the ordinary tail or reparsing it. One request runs at a time, with one cursor per session. The sentinel requests history within one viewport. Its button supports explicit and keyboard requests. Loading and accepted pages repaint selection while catalog refresh runs.

A page must establish both semantic edges before admission. A request containing only represented turns continues within a bound derived from loaded turns. Pages merge by stable turn identity. Each page retains target turns, an older guard, and required boundary records. Relevant turns can exceed a chunk. Irrelevant sparse lines do not accumulate.

Loaded pages survive only at their accepted revision or through revision-bound append provenance naming that revision. Catalog metadata never rebases or drops them during rendering. Truncation, replacement, or anchor mismatch resets pages after a stable retry. Semantic backward evidence stays separate from forward state.

A tail starting after byte zero excludes records touching its floor. Prompt or task starts decide turn membership even when associations reach earlier. Crossing required associations rebuilds the bounded tail. Generated titles survive trimming. Implicit compaction values expire with their source. Active turns can cross the byte window. Bounded tool pairing retains visible steps, so older unresolved results can become unpaired. Ambiguous pages use identity-only scans. Reaching byte zero finalizes that page's evidence.

An accepted append retains displaced completed turns in one bounded recent page. Its limit is the ordinary turn limit minus turns remaining in the tail. Explicit older pages stay separate. The selected cache budget bounds recent-page content except for one newest turn. A fresh panel starts from its bounded tail.

Accepted turns, source checkpoints, and older pages share `arc.sessionCacheMiB`. Selection protects the current session. Unselected sessions remain while the total fits, then leave in least-recently-viewed order. An oversized selected value evicts every optional session and stays retained. Returning restores retained pages without reading. Rendering updates recency in place. Eviction leaves unread metadata and completed lifetime facts available.

Session figures cover the tail plus loaded pages and name that count. Search uses a separate window and can cover less than the visible timeline. Empty states describe selection, not the background parse set. `historypages.ts` owns page admission, displaced windows, coverage, and eviction.

## Cache ownership

Agent records supply rebuildable metadata, parsed history, and spend. Reader-owned watermarks, pins, archive state, drafts, comments, open controls, and selection live separately in normalized VS Code state. Transcript retention determines historical timeline availability. Arc keeps no separate historical-turn archive.

| Cache | Reuse and ownership |
| --- | --- |
| Discovery metadata | Per-source opening, human-prompt, working-directory, and name evidence uses the revision that changes its answer. |
| Codex openings | Shared path-keyed `codex-openings.json` uses its independent opening generation. |
| Derived session metadata | Workspace entries retain names, starts, activity, classification, outcome, and bounded context by path, size, and modification time. Relationships and metadata have independent generations. |
| Selected history | File revision, parser options, folders, and descendant revisions qualify worker checkpoints and retained pages under one history budget. |
| Child usage | Worker-owned completed-child facts use child revisions and commit-placement scope. Parent reads carry descendant dependencies. |
| Project spend | Incremental source cursors and the last complete display ledger remain separate. Lifetime projection reuses the ledger revision. |
| Search | Explicit content searches populate compact text entries by path, size, and modification time. |

Discarding optional derived or opening caches triggers source reads. Trim metadata against a complete catalog, after Claude child discovery first answers. Earlier lists can contain only selected sessions. Workspace changes clear that catalog boundary. Metadata reuse comparing size and modification time cannot detect a replacement preserving both values.

`VERSION` in `derivedcache.ts` versions metadata derivation. A generation change drops incompatible facts but carries `label` and `fullLabel` until fresh metadata replaces each name. Carried names remain separately persisted across partial rebuilds. Recognizable incompatible entries can instead be rejected individually. Relationship interpretation uses `CLAUDE_CHILD_REFERENCE_PARSER_VERSION`. Opening derivation uses `CODEX_META_VERSION` in `codexopenings.ts`. Changing one does not invalidate the others.

`derived-session-cache-v1.json` separates format, metadata generation, and per-entry relationship generation. Only current-path absence permits legacy import. Known legacy versions 63 and 64 admit parser-26 relationships. Metadata still requires its current generation. Other current-file failures never fall back. Legacy scheduling restarts. Scope, semantic dependencies, retained cursors, and accepted relationship progress qualify continuation. Removing dependent rows or cursors discards scheduling state.

Migration requests a checkpoint without source growth and retries failed publication twice through the checkpoint timer. Imported opening seeds must reach atomic shared storage after an admitted walk before current-format publication, including shutdown. The openings writer resumes pending migration after publishing seeds. Bounded verified repository observations retain their independent format.

Codex opening changes require `CODEX_META_VERSION` changes, including derivation changes that preserve shape. This rereads machine-wide rollout heads. Unversioned derived cache versions 27, 28, and 29 identify opening generation 1. A metadata-generation change preserves compatible shared openings.

### Shared opening writes

Each opening save exclusively creates `codex-openings.json.lock`, reads shared rows, merges, and atomically replaces the file. Replacement and lock removal require its token. Lock contention retries after two seconds. Locks and takeover guards become stale at 30 seconds. Takeover rechecks lock text and modification time under a matching exclusive guard. A resumed previous holder with a changed token writes and removes nothing.

A holder paused between its final token check and rename can overwrite another window's rows. Startup rereads missing rows from rollouts. Saves retain existing rollouts and rows shared by disk and the latest walk. A deleted rollout absent from one side cannot return through older cache evidence. Missing or unreadable shared storage uses workspace opening seeds. A valid empty shared file does not use them. `saveCodexOpenings` owns merging and takeover rules.

### Folderless partitions

A folderless window allocates a unique path without creating it. The first cache write publishes ownership before data. Ownership survives panel closure. Provider disposal closes admission, flushes synchronous writers, then publishes release. Resumed writes allocate a fresh path and generation.

Every folderless write checks exact ownership bytes. Missing, unreadable, oversized, or replaced ownership blocks writes and release. Path checks do not prevent external replacement during a write.

Written folderless partitions remain on Windows, macOS, and Linux. Node pathname deletion cannot bind every ancestor and removed directory to validated identities. Linux boot differences remain uncertain without same-machine evidence. Windows lacks complete reparse-tag inspection. Windows and macOS lack precise process-lifetime inspection here. Reclamation performs zero filesystem operations and no process inspection. Unwritten activations leave no partition. Drafts and assets keep separate lifetimes.

## Source and cache contracts

Worker results bind source revision and request generation. Refresh and selection have separate cancellation and generations. Catalog refresh cannot cancel selected reads. Selection, scope, source changes, and disposal reject obsolete work while retaining accepted content. Unchanged polls preserve in-flight reads. Handoff acceptance rechecks selection and repository scope. Descendant dependencies include nested and cross-agent launches.

Forward checkpoints and retained-page messages carry hidden parser fields explicitly because structured clone drops non-enumerable properties. `parserstate.ts` transports open-turn ranges, exact Activity detail, call IDs, and agent tool associations without mutating parser-owned turns. Losing ranges discards cards at the tail boundary. Claude restored fields remain read-only and non-configurable. Codex detail remains writable and configurable. Byte ranges retain their separate checkpoint representation.

Claude model attachment recovery belongs to forward checkpoints. Backward slices stop between reads at 1 MiB or 15 ms. Recovery continues to applicable evidence or byte zero and caches positive or absent results at its revision and boundary. Validated contiguous appends preserve compatible cursors. Page boundaries recover their own preceding evidence. Replacement, truncation, rewrites, cancellation, and selection changes reject incompatible work.

Attachment evidence changes prompt box identity alone. `Turn.model` remains the reply API ID for display and pricing. Attachments preserve context-window spelling only when normalized model identities agree. Two dated identities require equal snapshot dates. An undated identity permits date tolerance. Incompatible replies or invalid attachments clear later evidence without changing completed turns. Recovery charges include follow-up and abandoned work separately from ordinary tail bytes.

Stopped Codex display recovery scans backward from its accepted forward boundary in cancellable slices. It retains at most 256 KiB per record and skips oversized non-model bodies. Opening-matched settings qualify pre-task identity. Exact native ownership admits retained context models in source order. Unproved ownership or identity leaves no display model. Results, including absence, cache by revision. Replacement, truncation, and rewrites restart recovery. Pending recovery continues even when content remains current and never delays attachment handoffs. Display identity remains separate from billing and retained-context facts.

Codex retained-context reads admit copied metadata only through declared fork ancestry. Tool pairs retain distinct function, custom-tool, and client-search identities. Local shell uses function outputs. Server search outputs require no local call.

Dispatched Codex spend uses worker-owned forward cursors and 256 KiB slices that scan for reader prompts. An owned final completion or abort admits spend after complete EOF coverage at one revision. Copied turns, identity mismatch, trailing activity, and incomplete records retain the one-hour quiet deadline. Deadline expiry schedules discovery without source growth. Cursor progress schedules continuation without card posts. Changed figures schedule collection and posting independently, including retained launching turns. Accepted posts consume their captured figure revision. Failed or obsolete posts retain pending figures. These cursors and figure revisions remain process-local.

Closed Claude children reopen only after user or assistant work exceeds their close timestamp by more than one second. File writes and bookkeeping do not establish resumed work. Changed sources scan disjoint 256 KiB chunks backward and reconstruct split records. Unchanged revisions, including absent work timestamps, require no reread. Ordinary-result filtering must preserve `toolEndsTurn`, or completed child sessions never become done.

[Card sources](timeline.md#card-sources) owns live activity reconciliation with recorded work. Accepted submission identity binds native responses and outcomes to prompts. Pending delivery retains destination events until adoption or continuation. Failed delivery and disposal clear them. Unresolved ownership expires after five minutes. Terminal responses remain readable until recorded replacement, including after Clear in their source session.

Accepted windows publish current turn facts before commit-repository discovery waits. Hydration rechecks selection's source and resumes changed reading without another trigger. Incomplete repository evidence clears navigation. Successfully accepted windows and commit rows survive transport failure. Undelivered current windows and failed enrichment posts retry. Retained-page child refresh accepts replies only while the same history state remains current. Cached-window refresh requires the same entry identity.

## Saved state and refresh

`turnview.ts` normalizes bounded saved collections, validates session keys, and ignores unknown fields. Extension state supplies shared selection and read state across restored tabs. Derived metadata checkpoints follow the first posted render. New entries checkpoint immediately. Later revisions are rate-limited. Shutdown flushes pending writes, but reload persistence cannot depend on disposal.

Initial metadata admission uses a 64 MiB budget, including Codex's separate title head. Catalog size determines admission charges, so concurrent growth can exceed physical read charges. Post-render turn-start enrichment also uses a nominal 64 MiB admission allowance. Its first oversized classification request remains admissible. Unread counts stay unknown until metadata or complete lifetime facts qualify them.

Expanded metadata records complete coverage, including empty results, separately from partial windows. Failed and short reads establish no coverage. Partial windows suppress identical tails while unresolved context and outcomes remain eligible for forward recovery. Successful partial and complete negative coverage survive restart. Runtime progress rebuilds under admission. Failed reads retry on ordinary visible refreshes, including refreshes that skip rendering.

Metadata recovery retains one live reducer and segmented fragments. Waiting sources retain identities alone. Slices read at most 16 MiB from byte zero or validated continuation. Facts materialize only at stable EOF. Compatible appends require identity and a bounded content anchor.

Records exceeding 1 MiB reduce while reading. Strings retain at most their first and last 64 KiB. Long `data:` strings retain their header through the first comma. `replacement_history` becomes `[]`. Invalid reduced JSON is dropped. Reduced unfinished records have a 16 MiB limit. Retained payload has a 64 MiB limit. Reservations cover new records. Pressure counts live payload in batches yielding after 512 values. Ignored chunks skip recounting.

Exhaustion preserves accepted facts and incomplete coverage, persists its recovery rule, and stops identical attempts. An older exhausted rule retries once. Source changes, accepted selection, or explicit older-history requests reopen one attempt. Automatic selected refresh and attachment continuation preserve exhaustion. Older pages never supply current metadata. `heldStats` preserves earlier context across tails missing the prompt or first usage. Context evidence, complete negative coverage, shrinkage, or replacement releases it.

Refresh observes transcript metadata, snapshot triggers, Codex names, and live child state. Every cache key must include external facts that change its answer. Metadata recovery runs one eligible session at a time and persists recovered facts. Repaint and Project cost signatures remain separate. Selection and Codex names affect repaint. Selected and targeted sources receive promoted integrity checks. [Project cost integrity scheduling](accounting.md#project-cost-integrity-scheduling) owns deadlines.

Watcher events use a trailing scheduler with a maximum wait of one second during continuous writes. Known change paths receive targeted validation. Renames, missing names, unknown paths, changed identities, watcher failures, and integrity polls use broad discovery. Polls run every five seconds while visible. Broad walks discover new Codex children and Claude child spend sources. Watcher loss clears retained rollout stats. Hidden walks stat every rollout. `CodexStatCache` and `SubagentDirectoryCache` own active-window, settle-window, and revalidation rules.

One catalog refresh runs at a time. Waiting triggers merge repaint intent and broad-walk demand, or union named files when every trigger is targeted. A waiting trigger replaces a refresh past its 30-second deadline. Last-host disposal, workspace changes, and repository-scope replacement abandon refresh and waiting work. Hiding a host stops polling without abandoning its current refresh.

Selected-only updates bypass catalog refresh and reuse the held catalog. They stat selection alone and draw held content synchronously. Worker completion refreshes selected facts and older pages. Accepted changes without a worker round trip still require publication. Selection's watermark and row wording use the same read state. A suppressed standalone row post falls back to the refresh's final publication.

Cold Codex discovery asynchronously primes missing openings with eight concurrent reads and walks in cooperative four-millisecond slices. Directory reads remain synchronous and uninterruptible. Cancellation stops further reads and a later refresh starts again. Search keeps only its latest waiting query. Older-history requests also wait for the replacement cold pass. Initial publication uses a complete listing. Later synchronous opening reads handle new rollouts, refused reads, and grown empty sources. Refusals retry after one second, then every 30 seconds. Each refresh owns and discards its enumeration when scope or visible-ready admission fails.

Held catalog identities receive at most 32 concurrent asynchronous stats. Missing or replaced sources require a walk and relationship discovery before publication. Listing requests separately check served-row freshness. Coverage requires matching membership and physical identities. Scope-root or workspace changes clear working-directory membership reuse.

Startup, loading wording, stable browser nodes, list deltas, focus preservation, and time tickers belong to [Session list loading](panel-rendering.md#session-list-loading-contracts) and [Retained rendering](panel-rendering.md#retained-rendering-contracts). Diagnostic capture, startup milestones, and their clocks belong to [Development](performance.md#diagnostic-implementation). Project-spend checkpoints preserve the last complete ledger separately from unfinished progress.

## Session name

Saved sessions rename through their heading or session-list context menu. Provisional sessions offer neither route. Confirmation redraws both names together. [Context menus](panel-navigation.md#context-menus-and-copy) owns the controls. [Agent protocols](agent-protocols.md#session-rename) owns persistence.

Claude custom titles outrank generated titles. The newest title wins within each kind. Eligible typed-prompt fallback reads the first 128 KiB. Locally answered commands give way to the next typed or reader-queued prompt. Whole-file reads reach later prompts. Codex fallback reads the first 1 MiB, excludes incomplete trailing records, injected context, and images, and cannot name an oversized first prompt. `VERSION` invalidates title rules independently from opening generation. Initial-name subscriptions share one Codex index per path and revision. Filename-free events rescan retained admitted directories alone.

## Search

The session-list box ordinarily filters titles. Content queries search prompt and response text and return turn snippets with match positions. `turnsearch.ts` and `domain/session-query.ts` own parsing and matching. Browser `search.ts` consumes results without reinterpreting query syntax.

Every search word must match within the same prompt or response half. Search includes later prompts and completed responses in reading order. Its independent 16 MiB tail can omit visible older pages. Scoped results report whether the read reached the first turn. Explicit search alone populates the corpus. Cached names update without reparsing unchanged text. Labels, archive state, and agent-run classification apply at query time.

Numeric cost and cache-expiry filters do not narrow content results because entries contain neither fact. Entries also lack facts for unsupported state predicates. Prefix resolution uses accepted scoped identities before other filters narrow the pool. Incomplete discovery suspends unresolved prefixes. Identity-context changes re-evaluate retained entries. [Session list](session-queries.md#session-query-syntax) owns the query language.
