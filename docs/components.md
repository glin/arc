# Extension components

Paths are relative to `extension/src/`. [Architecture](architecture.md) owns package boundaries and routes changes to topic guides.

[`architecture.test.ts`](../extension/src/architecture.test.ts) checks the first column against recursive extension source components, excluding tests.

| File | Job | Imports `vscode`? |
| --- | --- | --- |
| `bundledtools.ts` | Package validation, admitted software roots, immutable release publication, configuration catalogs, completion and installed command activation | no |
| `bundledsetup.ts` | Source-build entry for the shared command and snapshot installer | no |
| `toolownership.ts` | Canonical paths, redirected ancestor admission, exclusive setup ownership and wrapped uncertainty | no |
| `toolpath.ts` | Private terminal environment lifetime, PATH admission, current child CLI selection, and canonical session skill release selection | no |
| `sessionskills.ts` | Read-only native skill admission, personal configuration and collision checks, retained release identity, and raw Codex skill validation | no |
| `claudeplugin.ts` | Consented Claude plugin detection, local source admission, bounded subprocess lifetime, scope and byte checks, and configuration ownership | no |
| `extension.ts` | Activation, local window channel lifetime, watcher registration, commands, editor integration, and the agent host | yes |
| `configwatch.ts` | Non-recursive applied-defaults configuration watches for queried folders and their ancestors, with directory checks and watch lifecycle | no |
| `identity.ts` | Re-exports product identifiers and owns measurement environment names, saved-state keys, and the multi-root spend workspace path | no |
| `projectsetups.ts` | Canonical setup project identity, project-entry normalization, one-time legacy pin import, and serialized pin and accepted-profile persistence | no |
| `sessiondetails.ts` | Filters cards to the displayed session | no |
| `panelhost.ts` | Extension-host side of the panel webview, window state publication, per-host readiness, durable initial catalog demand, staged loading, accepted progressive reader state, startup counters and sparse history, reader metadata read intent, and reader-started parent ownership, and context-detail acceptance, plus host-owned initial-name persistence and lifecycle cancellation | yes |
| `timelinestate.ts` | Combines accepted tail, lifetime, and parsed outcomes, assembles child write and work times and live child IDs, caches child work by file version, projects session-list status and counts, and exposes the card's carried-subagent count | no |
| `timelinecheck.ts` | Reads raw Claude work and close evidence independently, checks timeline consistency, and assembles read-only project sweeps through the shared timeline state and card projections | no |
| `progressiveworker.ts` | Typed worker requests, cancellation, bounded pending-work, window read lifecycle and failure observations, discovery checkpoints and quantum deltas, transport counters, revision and generation acceptance, and host-lifetime commit evidence reservations. Completed Codex dispatched-source parses survive worker replacement in a host cache capped at 200 entries and 32 MiB of serialized payload. | no |
| `selectedsource.ts` | Selected descendant transport | no |
| `progressiveworker-entry.ts` | Worker execution of metadata, one protected live metadata recovery, bounded provider relationship quanta and worker heap observations, serialized discovery admission, recursive catalog closure, Codex dispatch discovery, and source-local dispatched figures, incremental readers, semantic page adapters, and window read start signals with bounded lifecycle and overlap measurements | no |
| `tones.ts` | Measures text contrast against backgrounds and color differences between status tones in panel.css | no |
| `webview/panel.css` | Panel styles served into the webview | not TypeScript |
| `webview/panel.ts` | Typed page-lifetime owner composition, cross-owner coordination, exhaustive host-message dispatch, and production message boundary | no |
| `webview/payload-contracts.ts` | Complete browser-safe card and session list-row contracts shared by protocol parsing and renderers | no |
| `webview/card.ts` | Preact turn-card renderer, card-local disclosures and Activity filters, actions, clock updates, and read and comment subscriptions | no |
| `webview/card-rows.ts` | Shared Preact file, child-session, and commit rows for card sections and chip popovers, with scoped records and repository and branch grouping | no |
| `webview/choice-picker.ts` | Shared select-only combobox with tentative selection, non-tabbable options, keyboard navigation, and owned popup dismissal | no |
| `webview/chrome.ts` | Preact renderer for the compact controls and the New session menu, with its setup list, custom fields and field pin, composing the compact Project cost face | no |
| `webview/clock.ts` | The panel's one-second tick, subscriptions, and in-place age and duration updates outside the session list | no |
| `webview/composer-controls.ts` | Preact owner for usage, Prompt box picker controls, permissions, MCP menus, context-detail demand, the Remote Control item with its measured glyph-only state and link popover, and their page-lifetime popover state | no |
| `webview/composer-presentation.ts` | Typed owner for Prompt box body mounts, slots, next-turn presentation, shared-clock updates, footer measurement, box floor, session list-relative placement, and transient divider gesture hysteresis | no |
| `webview/composer.ts` | Preact Prompt box owner for the stable shell, live prompt text field, native-menu selection highlight, inline skill and Claude-command detail controls, host-activation focus recovery, drafts, submitted-prompt recall, editing history, completion, the page-level send chord, and later-owner slots | no |
| `webview/attachments.ts` | Preact owner for Prompt box attachment chips, browser file reads, staging tokens, paste and drop handling including editor URI drags posted to the host, attachment and submission-refusal notices, and both removable Prompt box chips and non-removable transient-card chips | no |
| `webview/sessiondetails.ts` | Body-mounted non-modal session dialog opened by the native session context menu, including copy actions, focus return, and viewport placement | no |
| `webview/dom.ts` | Authoritative browser DOM lookups, shared editable-target checks, float placement, accessibility wiring, and selected DOM conversion to Markdown | no |
| `webview/hints.ts` | Page-lifetime delayed and keyboard hint service, body tooltip placement, the prose form of a session name hint, the drawn body an anchor names with `data-hint-body` and its redraw port, and hint cleanup when anchors leave | no |
| `webview/history-control.ts` | Typed owner for empty and archived timeline presentation, semantic footer reuse, older-history requests, and viewport prefetch | no |
| `webview/host.ts` | Private VS Code API closure, host posting, and browser state ports | no |
| `webview/layout-dialog.ts` | Page-lifetime Timeline layout dialog, gear anchoring, keyboard and focus handling, and host setting requests | no |
| `webview/inline-text.ts` | Wrapper-free literal spaces between explicitly supplied textual siblings | no |
| `webview/bootstrap.ts` | Sole browser bootstrap, owner of global startup side effects, and sender of browser readiness after owners mount | no |
| `webview/development-state.ts` | Development reload choice, browser-state preference, and render-driven scroll restoration | no |
| `webview/development.ts` | Vite browser entry that patches CSS and reloads one panel lifetime for component updates | no |
| `webview/main.ts` | Packaged browser entry | no |
| `webview/native-menu.ts` | Shared three-dot artwork and native context-menu dispatch for session and saved-view headings | no |
| `webview/navigation.ts` | Timeline-scoped roving key and focus listeners, shared supplementary movement decisions, membership of the timeline walk, mouse history navigation, and back-to-top behavior | no |
| `webview/page-style.ts` | Page-lifetime owner for dynamic icon-font rules | no |
| `webview/comments.ts` | Page-lifetime comment state, selection and editor surfaces, annotations, popovers, native turn-menu contexts, and comment interaction deferral | no |
| `webview/projectspend.ts` | Preact renderer and page-lifetime state owner for both Project cost faces, its dialog focus and dismissal, measured placement, selection deferral, indexing status timing, and update age | no |
| `webview/queue-live.ts` | Preact owner for queued submissions and live cards, including keyed ordering, queue and live disclosures, scoped actions, and selected-live draw debt | no |
| `webview/requests.ts` | Preact owner for agent requests, request-local answers and disclosure state, announcements, focus continuation, and nested scroll identity | no |
| `webview/read-state.ts` | Page-lifetime read keys, session watermarks, subscriptions, bulk read notifications and saves, and host state updates | no |
| `webview/stat-detail.ts` | Page-lifetime chip popovers, nested instances, pinning, keyboard access, shared notes disclosure state, and selection-deferred updates | no |
| `webview/stat-chip.ts` | Browser-safe interactive card and session chips, static session list and subagent-row figures with the popover a figure's record opens, the figure line `RailStats` that a session list card and a compact row's hover both draw, and diff-pair rendering | no |
| `webview/summary.ts` | Shared Markdown actions with effect cleanup, plus mounted response disclosure identity, open state, and focus restoration | no |
| `webview/search.ts` | Preact owner for the pending content-search query, the reply it accepts, and the results list with its scoped wording | no |
| `webview/session-state.ts` | Saved open, selected, archived, pinned, read, session list, and comment state assembly plus native session-menu context | no |
| `webview/rail-hover.ts` | Builds the hint card for a compact session list row. Uses `railHoverLines` in `view/rail.ts` for text and `RailStats` for figures | no |
| `webview/rail.ts` | Page-lifetime Preact session list, group headings, navigation and focus recovery, hover cards, queries, View menu, naming editors, folds, selection deferral, and width resizing | no |
| `webview/session-rename.ts` | Session rename editor form, and the rule that lets only the answer to the waiting request change it | no |
| `webview/text-field.ts` | Shared single-line text box with a clear button | no |
| `webview/protocol.ts` | The message contract both sides read: one union and one parser for each direction, and a dispatcher that names every message | no |
| `webview/row-deltas.ts` | Session row deltas in render and session list messages: row prints and order edits for each panel on the host, held rows and revision checks in the panel | no |
| `webview/retained-visibility.ts` | Retained-page opacity, revision and observation generations, viewport observation, resize invalidation, paint-boundary release, and retained focus | no |
| `panelvisibility.ts` | Per-panel visibility revisions and lifetime cleanup | no |
| `webview/state.ts` | Saved panel state shape, submitted-prompt identity and ordering, reconciliation, synchronous browser protection, local reset saves, and writes to the host memento | no |
| `webview/timeline-renderer.ts` | Preact session sections and headings, bulk turn disclosure, heading actions and metadata, keyed cards, Activity publication, reading position, selection deferral, and focus recovery | no |
| `webview/tsconfig.json` | Browser TypeScript project with browser platform libraries | not TypeScript |
| `panelbundle.ts` | Builds the compact browser program and stylesheet for the host build and page fixture | no |
| `paneldevelopment.ts` | Validates the loopback development origin and component updates, then builds production or development panel HTML and CSP | no |
| `paneltext.ts` | Replaces named panel tokens with values prepared by tested modules | no |
| `payload.ts` | Shapes the render, selection, and session list messages the extension posts, and weighs a message by field, by session list row, and by repeated long string | no |
| `richtext.ts` | Safe block and noninteractive inline Markdown, named response session anchors, literal file citations, validated disclosure structure, host-only content references, local picture rules, and fallback text | no |
| `uris.ts` | Read-only URI schemes used by diff editors | yes |
| `config.ts` | Reads and writes extension settings through `vscode` | yes |
| `store.ts` | Snapshot manifests, path matching, current-file comparison, expiry, lazy cache partition ownership, and conservative folderless retention | no |
| `agentpaths.ts` | Resolves the Claude Code and Codex homes from their process environment and home-directory fallbacks | no |
| `claudeskillpath.ts` | Finds a Claude skill's `SKILL.md` in the session's project skills folder, then the reader's Claude skills folder | no |
| `transcript.ts` | Shared transcript byte windows, Claude records, consumed-prefix evidence and read accounting, resumable parent-owned relationship reduction, shell receipt validation, local link candidates for opening and copying paths, and local HTML, Markdown, and video classification | no |
| `filerevision.ts` | Converts filesystem stats into file revisions and preserves bigint physical identities | no |
| `readmeter.ts` | Counts the bytes and distinct files that synchronous transcript reads return while one measurement window is open | no |
| `codex.ts` | Watches exact accepted-session metadata independently of panel visibility, reads Codex rollouts into shared values, indexes descendant ownership by semantic catalog revision for turn cost and revision keys, and scans shell launches with a resumable cursor, and reads dispatched figures with native descendants through resumable source quanta and one retained aggregate fold, keeps retained-context estimates separate from billed usage, and marks usage events that read a `wait_agent` return | no |
| `outputrate.ts` | Qualified response clocks, bounded content-free response measurements, per-turn measurements and qualified model identity, and native Codex response boundaries with blocking local tool outputs | no |
| `codexcontext.ts` | Bounded revisioned retained-context reads, text attribution, request reconciliation, and unsupported-history refusal for Codex | no |
| `subagentcontext.ts` | Byte-based token estimates, four bytes a token shared with the Codex Context detail and a Claude-only subagent rate, and the running estimate of text that subagents returned into a session's context, with its per-subagent lines, compaction clearing, and partial marker | no |
| `gitcommits.ts` | Reads a turn's commits and fast-forward landings, their repositories, and each landing's merged branch | no |
| `commitrepositories.ts` | Retains verified commit occurrences, validates their original sources and physical repositories, and supplies repository identity after worktree removal | no |
| `sessioncoverage.ts` | Binds physical enumeration and admitted membership evidence to scope and revision, and decides source presence | no |
| `repositoryscope.ts` | Refreshes discovery roots and registered checkout identities, classifies starting worktrees, and checks explicit launch folder destinations | no |
| `parserstate.ts` | Clones resumable parser state without losing hidden associations, counts live retained payload, captures and restores hidden activity fields for checkpoints and worker transport, and supplies shared scan budgets | no |
| `history.ts` | Exact-revision history cursors, semantic pages, transactional forward checkpoints, and opt-in metadata recovery slices with live source reduction and resumable payload accounting | no |
| `exportlimits.ts` | Admission limits and typed failures for explicit saved-session captures | no |
| `exportdata.ts` | Workspace-independent source identities, reachable session relationships, complete semantic pages, provider-owned saved names, allowlisted numeric facts, and graph revision checks | no |
| `exportsite.ts` | Bounded card, full-text and numeric projection through production builders, inert Markdown and relative script assets | no |
| `sessionexport.ts` | Saved-source admission, native export sequence through injected ports, packaged asset projection and completion outcomes | no |
| `exportassets.ts` | Reads packaged static viewer assets from the installed extension directory | no |
| `exportwriter.ts` | Generated assets, page spools, exclusive directory publication, cancellation, and ownership-checked cleanup | no |
| `oversizedrecord.ts` | Incremental byte reducer that cuts the bulky strings and compaction history of one oversized record while metadata recovery reads it | no |
| `claudehistory.ts` | Claude semantic-page and forward-checkpoint adapter, with resumable revisioned model-attachment recovery | no |
| `codexhistory.ts` | Codex semantic-page and forward-checkpoint adapter, bounded display-model recovery, and bounded raw parent/child commit ownership coverage | no |
| `historypages.ts` | Per-session older-history pages, completed turns displaced from an accepted selected window, their retention budget, and end-of-list control | no |
| `turnview.ts` | Saved panel state, parse budgets, list selection, empty states, and re-exports | no |
| `turncard.ts` | Reduces a turn to the card the panel draws, merging each child's recorded files and commits into the card's own rows with the child's session, naming each commit's repository and branch, and re-exports shared card-menu projections | no |
| `turncomments.ts` | Normalizes, stores, and emits comments, then re-exports shared comment rules | no |
| `turnread.ts` | Owns unread counts, completed identity mapping admission, retained-tail decisions, and current records for each session, then re-exports shared read rules | no |
| `turnrail.ts` | Host session rows and ordering, the session that started each dispatched or subagent row, and re-exports of shared session list projections | no |
| `turnsearch.ts` | Host turn-content search and snippets using full scoped catalog identity resolution and re-exports shared session-query rules and projections | no |
| `turnformat.ts` | Formats host-only time, duration, size, tokens, and model names and re-exports shared relative-time rules | no |
| `turnlabels.ts` | Session-label storage, membership, counts, abandoned-draft cleanup, and editor rows and re-exports shared label rules | no |
| `turnplaces.ts` | Tracks visited sessions for Back and Forward navigation | no |
| `turnfixtures.ts` | Shared test fixtures. Shipped code must not import it | no |
| `panelfixture.ts` | The real page and a full render payload for browser tests and the screenshot script | no |
| `temproot.ts` | Scratch directories beneath a suite root, plus private socket directories with explicit ownership and local cleanup. Shipped code must not import it | no |
| `patchview.ts` | Selects a turn's unambiguous recorded file change and builds both diff sides from recorded edits | no |
| `fileicons.ts` | Chooses a fallback file-type badge | no |
| `icontheme.ts` | Resolves the active file-icon theme and its font or image resources | no |
| `pricing.ts` | Shared model and provider resolution, recorded route classes, retained request-band quotes, promotion metadata, fallback windows, required sourced cache policies, and cost estimates | no |
| `clauderepeated.ts` | Recognizes Claude repeated records, and owns the per-file repeated-record map that the project cost index saves and publishes to windowed readers | no |
| `projectspend.ts` | Incremental transcript usage index, linked-result deduplication, lifetime session costs and turn counts, what each dispatched session adds to the turn cards of the sessions above it, ordered cache-expiry and compaction derivation, the history-limit offer decision, project-cost windows, retention, and display values | no |
| `sessioncost.ts` | Resolves transcript sources and descendants. Shares report assembly between synchronous callers and cooperative CLI reads. Report assembly filters and summarizes one child's history at a time. CLI discovery and transcript scans yield and accept cancellation. Recognizes native records during usage scans. Reconciles recorded Codex usage and reports windowed cost, model subtotals, failures, tool attribution, and cache-expiry evidence. Direct source reads skip catalogs and descendants. | no |
| `cacheexpirysummary.ts` | Combines independently classified cache-expiry source summaries for the index and CLI | no |
| `childcacheexpiry.ts` | Attributes native child return clocks across a card batch, preserving recorded history and reusing source-revision prices | no |
| `sessionfilter.ts` | Ordered panel filter assignments and confirmed resets, operation deadlines, cancellation, and persistence ordering | no |
| `sessionrequests.ts` | Per-activation window identity, private registry publication, authenticated bounded JSON-lines requests, live window discovery, observed access diagnostics, target selection, query capability, connection cancellation, and channel cleanup | no |
| `sessionreads.ts` | Paged programmatic session listings with signed cursors, independent transcript reads, and bounded exact source identity mappings | no |
| `sessionwrites.ts` | Session-write schema with scoped launch folders and read-only options, activation-bound request retention, archive refusal decisions, and guarded follow-up ownership, admission, and panel wiring | no |
| `dispatchreceipts.ts` | Launch-private receipts, immutable report events, authoritative file identity checks, read-only relationship scans, retained claims, durable consumption dispositions, standalone capture checkpoints, and log alias publication | no |
| `dispatchhost.ts` | Exact hosted submission observation, native ending and saved-response agreement, and finite lifecycle waits | no |
| `terminalownership.ts` | Bounded process ancestry, current terminal membership comparison, and independent process identity checks | no |
| `windowpipe.ts` | Host-lifetime Windows pipe bridge, shared native executable resolution, connected-server identity checks, and bounded stdio | no |
| `windowpipe-source.ts` | Native Windows pipe access rules, overlapped transport source, and separate read-only ancestry query | no |
| `claudecoststate.ts` | Captures cumulative Claude accounting snapshots, reconciles native child usage under bounded background budgets, and allocates supplemental lifetime and Project cost | no |
| `projectspendstate.ts` | Runtime validation for persisted project-spend records and resumable parser checkpoints | no |
| `derivedcache.ts` | Validates and atomically stores session metadata, complete relationship facts, and pending discovery checkpoints, and holds metadata figures until their facts change | no |
| `codexopenings.ts` | Versions, validates, and merges the machine's stored Codex opening records under a lock | no |
| `sessionnames.ts` | Holds the one name each Claude session draws on every surface, ranks its sources, and releases withdrawn command names | no |
| `sessionrename.ts` | Owns durable initial-name transitions and readiness-driven recovery, cleans a session name before either agent renames it, confirms a Claude rename from its saved title file, and builds the rename editor's opening message and the answer every rename request gets | no |
| `atomicfile.ts` | Replaces a stored file through a named temporary, and sweeps the temporaries an abandoned writer left | no |
| `scheduler.ts` | Bounded trailing scheduling, aggregation of pending watcher events and of the transcripts a live-activity fallback names, and the targeted or broad wake decision | no |
| `performancediagnostics.ts` | Redacted performance-snapshot projection, the file a capture is written to, message budgets, and monotonic host and panel counters | no |
| `diagnosticslog.ts` | Per-host JSON-line diagnostics, startup thresholds, asynchronous startup history, and bounded durable host health, lifecycle and action evidence independent of detailed logging | no |
| `sessionloadingline.ts` | Decides what the session-list loading line publishes, holds it hidden for the scope roots that completed the list, and writes each change of the line to the diagnostics log under fixed line budgets | no |
| `agentspend.ts` | Reads and caches child-transcript usage and direct-source measurements with measured model identity, shares aggregate refresh bands, and defines the verified child-session target lookup boundary | no |
| `childartifacts.ts` | Reduces a child's recorded files and commits to one record per file, with its line counts, and to distinct commit ids, with completeness and the child revision. Counts the child's tool calls and failed calls by tool name, keeps when its turns started and ended, and counts its turns where it ran more than one | no |
| `settings.ts` | Setting names, defaults, and compatibility aliases | no |
| `activitydetail.ts` | Shared activity subject policies and safe tool-input presentation | no |
| `agentwire.ts` | Shared asks, answers, events, settings, and turn outcomes | no |
| `commandcatalog.ts` | Retains ordinary provider catalogs and child-specific supplied commands, rejects superseded idle reads, and skips unchanged Prompt box payloads | no |
| `promptassets.ts` | Prompt asset limits, descriptor normalization, media-type decisions including the plain-text check for unlisted extensions, staging paths, integrity validation, and staged-copy lifecycle | no |
| `droppeduris.ts` | Drag type reading, `file:` URI to path conversion, path text in the path-completion format, image routing, and the `Add to Arc` argument shape | no |
| `domain/context-detail.ts` | Separate native Claude and local Codex context normalization, provider-specific unavailable reason validation, bounded category and optional Claude message partition checks, category shares, aggregate-compatible demand reuse, and stale-demand release | no |
| `contextframe.ts` | Claude context envelope identification and transport budgets | no |
| `webview/export-host.ts` | Local host for captured pages, bounded decoding, navigation and read-only capabilities | no |
| `webview/static-menu.ts` | Static editor-menu stand-in shared by the demo and captured pages | no |
| `webview/static-page.css` | Shared static-page header and theme picker styles | no |
| `webview/static-shell.css` | Shared decorative editor frame and viewport placement | no |
| `webview/static-menu.css` | Shared static editor-menu styles | no |
| `view/static-shell.ts` | Shared decorative editor frame markup | no |
| `view/static-page.ts` | Shared static-page body, header and session-list width | no |
| `webview/export-model.ts` | Static viewer contracts and exhaustive capability policy | no |
| `view/static-themes.ts` | Dark Modern, Light Modern and One Dark Pro Darker colors shared by static pages and browser fixtures | no |
| `webview/context-detail.ts` | Semantic context categories, decorative chart, optional Messages disclosure, mismatch table, measurement disclosure, and Compact action. `webview/stat-detail.ts` retains disclosure state through refreshes and places the popover after disclosure toggles | no |
| `claudewire.ts` | Claude stream-json and control-channel adapter, including the per-child Remote Control state | no |
| `compactrequest.ts` | Digest-bound self-compaction request and cancel commands, native operation bindings, separate continuation observations, durable admission ports, exact-child guarded delivery, and native completion evidence | no |
| `compactstore.ts` | Workspace continuation receipts, exclusive immutable recovery leases, bounded storage, pure status reads, and ended-owner evidence | no |
| `codexwire.ts` | Codex app-server JSON-RPC adapter, ordered cancellable prompt preparation, and child-local skill discovery authority for native prompt attachments | no |
| `codexreply.ts` | Codex async-question ids and the reply envelope that answers them | no |
| `questionrecovery.ts` | Durable captured questions, exclusive origin leases, local dispositions, admission, and contextual answer construction | no |
| `questionrecords.ts` | Bounded exact-source reconciliation for captured question identities, with independent read cursors | no |
| `launchpolicystore.ts` | Shared authoritative session restrictions, bounded per-session reads, atomic policy writes, and exclusive durable clear admission | no |
| `launchpolicy.ts` | Immutable read-only launch policy, exact MCP read tools, Claude tool and git restrictions, model permission-mode eligibility, and standalone model aliases. Codex provider selection reads the top-level `model_provider` in `CODEX_HOME/config.toml` or `~/.codex/config.toml` | no |
| `agenthost.ts` | Child ownership, packaged CLI environment and window targeting, launch environment, immutable read-only permissions and Claude attribution selection, line framing, lifecycle, durable question capture and restoration, accepted-turn identity, control-read scheduling, explicit usage attempt ownership, session state after model changes, and the Remote Control hold on idle retirement | no |
| `composerview.ts` | Prompt box, agent-request, and new-session view data, bounded question Markdown reuse, wording, settings, queue behavior, answers, prompt assembly, completion rows, and the walk back through earlier prompts | no |
| `domain/ask-answer.ts` | Browser-safe completion and answer assembly rules for agent questions | no |
| `domain/claude-skills.ts` | Browser-safe Claude skill-highlight decision, the per-working-directory skill-list cache reducer, and the safe-folder-name check the host skill-path lookup runs first | no |
| `domain/commit-sha.ts` | Browser-safe commit identity: two recorded shas name one commit when either is the prefix of the other, and the lower-case hex pattern that tells a commit hash from a ref name | no |
| `domain/composer-editing.ts` | Browser-safe prompt-history key decisions, the platform send chord, completion token parsing, command matching, and Remote Control command recognition | no |
| `pathcompletion.ts` | Host-safe immediate directory resolution, filtering, ordering, and completion bounds | no |
| `domain/labels.ts` | Browser-safe label identity, name ceiling, typed-name warning, label-count wording rules, and the choice of the row Tab applies | no |
| `domain/model-identity.ts` | Model id comparison shared by transcript turns and the Prompt box: window suffix, snapshot date, Bedrock prefix, and deployment suffix | no |
| `domain/version.ts` | Release version parsing and semantic-version ordering for the Claude snapshot setup floor and the Codex applied-defaults floor | no |
| `domain/link-path.ts` | Browser-safe local-path versus URI-scheme classification | no |
| `domain/file-citation.ts` | Bounded assistant-directive grammar, source masking, and native literal file destination admission | no |
| `domain/prompt-assets.ts` | Browser-safe prompt attachment count and byte limits and the shared drag type list | no |
| `domain/prompt-text.ts` | Browser-safe individual text limit shared by drafts, queued submissions, and submitted prompt recovery | no |
| `domain/read.ts` | Browser-safe turn keys, read predicates, unread counts, retained read limits, complete agent acknowledgment identities, ordered persistence contracts, and single-session read-state comparisons | no |
| `domain/rail-filters.ts` | Browser-safe saved session list filter records, normalization, live-filter identity, the lens words a lens press writes, the migration of older stored lenses into those words, naming, and query-term toggles | no |
| `domain/rail-sort.ts` | Browser-safe session list sort values, normalization, and display names | no |
| `domain/resume.ts` | Browser-safe terminal resume command for each supported agent, and the session identities that may not become one | no |
| `domain/identity.ts` | Browser-safe product, extension, storage, package, and scheme identifiers, re-exported by `identity.ts` | no |
| `domain/session-link.ts` | Browser-safe response session link parsing and formatting, native context masks, exact target resolution, and pending target admission | no |
| `domain/session-query.ts` | Browser-safe session-query grammar, quoting, caret tokens, native session identity alternatives, catalog-backed prefix resolution and capability requirements, metadata-only listing predicates, cost, cache-expiry, status and caller-answered cache terms, matching, and content-search eligibility | no |
| `domain/session-setups.ts` | Browser-safe pinned setup records, value checks, and recent setup limits | no |
| `domain/export-model.ts` | Browser-safe captured session contracts | no |
| `domain/export-limits.ts` | Capture and static viewer admission limits | no |
| `domain/places.ts` | Bounded local session navigation, shared through `turnplaces.ts` | no |
| `domain/text.ts` | Browser-safe line shortening and shared normalization for every typed name | no |
| `domain/views.ts` | Browser-safe saved-view record, name rules, label-derived name suggestions, ceilings, cost- and cache-expiry-query acceptance, live status-view acceptance, and normalization | no |
| `view/card-menu.ts` | Browser-safe turn-menu sections and context projections | no |
| `view/card-presentation.ts` | Browser-safe status glyphs, card identity, context-band class projection, the repository-work label the commits chip draws and the figures the Commits heading draws, the commit-sha comparison, and the grouping of commit rows by branch within a repository that the popover heading and the panel both read | no |
| `view/card-words.ts` | Browser-safe card and control wording, including prompt box visibility and height names, shared by typed panel owners | no |
| `view/comments.ts` | Browser-safe comment contracts, names, grouping, and quote anchor matching | no |
| `view/composer-editing.ts` | Browser-safe prompt-history announcements | no |
| `view/composer-size.ts` | Browser-safe prompt floor clamping, keyboard movement, and line counts | no |
| `view/cost.ts` | Browser-safe money wording for a cost estimate | no |
| `domain/model-catalog.ts` | Browser-safe model and effort catalog types | no |
| `view/model-picks.ts` | Model and effort reading labels, open-option default annotations, and saved-value transitions | no |
| `view/launcher.ts` | Browser-safe launcher contracts, compact CLI setup projection from exact supported launch choices, and accessible names for Create draft and the field pin | no |
| `view/projectspend.ts` | Browser-safe Project cost display contracts, projections, ordering, and indexing timing | no |
| `view/rail.ts` | Browser-safe session list preferred width, effective viewport bounds, keyboard resize decisions, group-list identities, bucket, section, grouping, sort, density, time-slot, count, label-chip count, cache-mark, figure, drawn-row, row-id, and clock-tick projections, and the pin glyph the session list card and the session heading share, with the pencil glyph beside it | no |
| `view/session-query.ts` | Browser-safe label suggestions, unknown search-area wording, identity resolution notes, and the cost and cache-expiry invalid-value notes | no |
| `view/stat-detail.ts` | Browser-safe cost-line suffix shared by host and panel renderers, including cached-input share and request scale. Selects which line-count figures appear. Defines the subagent-row figures sent over the wire | no |
| `view/export-facts.ts` | Browser-safe readable labels and exact captured values with shared figure formatting | no |
| `view/timeline-layout.ts` | Browser-safe Timeline layout values, defaults, dialog wording, normalization of hand-typed settings, and save-refusal messages | no |
| `view/time.ts` | Browser-safe relative-time ladder with compact and verbose recency formatters, including `formatRelativeShort` for a compact session list row, the cache-span figure, and the duration formatter | no |
| `view/tokens.ts` | Browser-safe compact token-count formatter shared by host and panel renderers | no |
| `view/usage.ts` | Browser-safe display contracts for collapsed and expanded usage figures | no |
| `usageview.ts` | Normalizes reported account limits, owns current-process admission and retained account exclusion, and prepares usage-bar rows | no |
| `usagerecord.ts` | Bounds normalized account-reading admission and asynchronously publishes committed gzip prefixes under exclusive daily-slot ownership | no |
| `mcpview.ts` | Normalizes reported MCP server state and available actions | no |
