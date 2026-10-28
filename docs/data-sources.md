# Data sources

[Timeline](timeline.md) owns the shared turn model. [Session history](session-history.md) owns derived caches. [Window channel](window-channel.md) owns local cross-process contracts.

## Source catalog

Root selection follows [Environment overrides](development.md#environment-overrides). Claude and Codex record paths below use their resolved roots.

| Source | Location | What it establishes |
| --- | --- | --- |
| Static Arc demo and main README image | `extension/scripts/readme-fixture.ts` through `web-demo.ts` | Invented records. [Demo source contracts](demo-assets.md#demo-source-contracts) own decoding, catalogs, static rendering, and interaction limits |
| Offline review evidence | `evals/agent-review/cases/` and a separate bare evidence cache | Source commits, partial review keys, and exported review conditions for the development tool only |
| Saved session capture | Configured Claude project directories, Codex rollout directories, and caller-supplied reader-started links and saved reader-parent identities | Verified identities across working directories and the outgoing relationships of the selected saved session. Unreachable text bodies stay outside the capture |
| Portable review fixtures | `evals/agent-review/portable/cases/`, `evals/agent-review/fixtures/`, `evals/agent-review/cohorts/`, and captured checkout instructions | Candidate source, qualification checks, frozen keys, coverage targets, and instruction hashes for local exploratory comparisons |
| Codex account capability | Non-refreshing `account/read` on the selected app-server process | `account.type: amazonBedrock` excludes subscription usage. Missing accounts, unknown types, and discovery failures establish no exclusion |
| Claude context summary | `get_context_usage` with `detail: summary` on the selected connected child | Estimated content categories, optional message partitions, occupied tokens, accounting window, free space, and compaction reserve from one response |
| Codex retained context | The selected rollout's newest complete replacement history or opening, plus subsequent response items and request usage | Locally estimated text categories, retained checkpoint tool text, and an explicit unattributed remainder, without attaching to a saved session |
| Claude status-line JSON | CLI stdin | Current Claude status and usage. [`status.ts`](../cli/src/status.ts) owns the fields |
| CLI transcript target | `arc cost` path or session id | Windowed request usage and list-price cost for one session and its children |
| Window registry | `${ARC_HOME:-~/.arc}/hosts/<host-id>.json` | Window discovery and authentication. [`sessionrequests.ts`](../extension/src/sessionrequests.ts) defines the registration |
| Claude snapshots | `${ARC_HOME:-~/.arc}/snapshots/<session_id>/` | File content before the session first changed it, plus manifest entries for new files and existing files that differ |
| Claude transcripts | `<resolved Claude projects root>/<cwd-slug>/<session_id>.jsonl` | Recorded Claude turns, usage, relationships, commands, file changes, commits, process outcomes, and session names. [`transcript.ts`](../extension/src/transcript.ts) owns record decoding |
| Claude child transcripts | `<transcript directory>/<parent_session_id>/subagents/agent-<agent_id>.jsonl`, and `agent-<agent_id>.jsonl` beside a child transcript for the subagents that child launched | Recorded child work, usage, output speed, timing, and completeness. See [`agentspend.ts`](../extension/src/agentspend.ts) and [`childartifacts.ts`](../extension/src/childartifacts.ts) |
| Claude subagent meta files | `agent-<agent_id>.meta.json` beside each child transcript | Which subagent launched a nested subagent, through `parentAgentId`. The launch call in `toolUseId` locates a child's transcript for its row's cost and effort before child discovery lists that child |
| Claude saved title file | `<transcript directory>/<session_id>/custom-title.json` | Whether Claude Code saved a session rename. Only a rename reads it, at most 4 KiB |
| Claude `init` skill list | The `skills` array on the child's own `init` system message | Which of a Claude session's published slash commands the Prompt box highlights as an inspectable skill |
| Claude skill files | `<project>/.claude/skills/<name>/SKILL.md`, then `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/<name>/SKILL.md` | The definition path a Claude skill mark and its popover show, the project folder winning over the reader's own |
| Native session skill admission | Claude selected-home and ancestor settings, inline settings, managed files, plugin inventories, marketplace manifests, linked definitions, and actual-child `get_settings`. Codex raw `skills/list`, `config/read` layers and origins, and `configRequirements/read` | Native authority for optional delivery. Unknown or unreadable inputs grant no optional authority |
| Immutable supplied session skill | The private selected release's `release.json`, complete payload bytes, `session-plugin/skills/arc-sessions/SKILL.md`, and `skills/arc-sessions/SKILL.md` | Child-local release identity and exact definition paths. The shared standalone active selection supplies no authority |
| Codex live skill catalog | `skills/list` on a connected app-server child, refreshed after `skills/changed` | The complete Codex command and skill list the Prompt box offers for that child's working directory |
| Codex rollouts | `<resolved Codex sessions root>/YYYY/MM/DD/*.jsonl` | The Codex form of the same turn record, including recent compaction request usage, subagent results from completed notifications and final answers, and shell-command dispatch receipts from each command's string `stdout`, or `aggregated_output` otherwise |
| Claude print results in Codex commands | The completed `CommandExecution` inside its parent Codex rollout | Shell-child ownership, recorded model usage, duration, session identity, and list-price cost |
| Agent child stdio | Process owned by the current extension host | Temporary live narration and activity before the disk record catches up, and the live session's busy state and turn endings |
| Claude main-response stream events | The connected child's identified `message_start`, terminal `message_delta`, and `message_stop` | Actual output tokens and observed response time for one unambiguous submitted prompt. Workspace state retains bounded measurements by session and response identity |
| Claude attribution selection | Editor environment or `.env` in the child's working directory | The local request attribution selection described in [Agent launch commands](agent-launches.md#claude-attribution-selection) |
| Panel launch record | VS Code workspace state, beside the saved panel state | Which sessions the reader started from this panel |
| Codex session index | `session_index.jsonl` beside the resolved Codex sessions root, defaulting to `~/.codex/session_index.jsonl` | Thread names, which may arrive after a rollout stops changing |
| Local git repository | The folder a command changed, and each open workspace folder | Registered worktree roots, commit details whose output printed none, and fast-forward landings from the head log |
| Built-in Git extension API | `vscode.extensions.getExtension('vscode.git')`, API version 1 | The repository roots the editor registered, read before Arc opens a commit |
| Browser saved panel state | VS Code webview state | The latest five exact workspace prompt submissions, saved synchronously before dispatch and reconciled with workspace recovery |
| VS Code workspace state | Extension-managed storage | Exact submitted prompt recovery, saved panel state, reader-started parent relationships and session list filters, queued submissions with delivery ownership and reset barriers, file descriptors, normalized account usage and live reset windows, and the last-reported Claude skill list for each working directory |
| Saved continuations | Workspace storage `continuations` | Exact agent-authored next-turn instructions, original source and assignment authority, native compaction generations, and separate delivery outcomes under one recovery lease |
| Hosted launch restrictions | `${ARC_HOME:-~/.arc}/launch-policies` | Immutable restrictions shared across windows, indexed by hashed session identity, plus one exclusive pending restricted clear or Codex fork |
| Bounded usage history | `${ARC_HOME:-~/.arc}/usage/bounded-v1/` | Admitted Claude and Codex account limit readings in thirty fixed UTC-day slots |
| Legacy usage history | `~/.arc/usage/readings.jsonl` by default | Preserved experimental readings, outside the bounded store's quota |
| Applied CLI defaults | Prompt-free Claude `get_settings` and Codex `config/read`, `model/list`, and `configRequirements/read` | Applied model and effort for the launch folder and committed model. Arc reads Codex defaults from Codex 0.159.2 and later, outside the refused version ranges in `codexwire.ts`. The version comes from the first `product/version` token of the server user agent. A missing or unreadable version and a malformed configuration or policy reply report unavailable defaults. The host rejects obsolete configuration replies |
| Saved model readings (`arc.savedDefaults.v1:`, `arc.savedModelCatalog.v1:`) | VS Code global state | The last applied defaults answer for each agent, folder, and committed model value, one key per reading, keeping the 64 newest. Each agent's last model catalog with the CLI path that answered it. They draw the Model and Effort fields until a fresh read answers |
| Model display names | Each agent's model catalog from Claude `list_models` or Codex `model/list`, the saved catalog under `arc.savedModelCatalog.v1:` until the run's first read answers, then Codex's `models_cache.json` in the Codex home folder | The name a cost popover gives a recorded model ID. It is the label of the first entry, in source order, whose value or resolved model is that ID without a context window suffix or a snapshot date. A `default` entry, an entry whose label repeats its ID, and an entry with a context window suffix name no model. Arc parses `models_cache.json` again only after its modification time changes. A file that exists but cannot be read keeps the held list, and Arc reads it again at the next catalog publication. A model that no list names keeps Arc's Claude or GPT family name, or else its recorded ID |
| Project setups (`arc.projectSetups.v1:`) | VS Code global state, keyed by canonical project identity | Reader-local pinned setups and accepted recent setups for one repository or non-Git folder |
| Legacy pinned setups (`arc.pinnedSetups`) | VS Code global state | Initial pins copied once into each new project entry, retaining their IDs and order |
| Project spend index | `${ARC_HOME:-~/.arc}/cache/<workspace-key>/project-spend` | Recorded usage buckets, supplemental Claude accounting, resumable reconciliation, lifetime session-cost and primary-turn facts, and incremental parser state for one normalized workspace identity |
| Derived session cache | `${ARC_HOME:-~/.arc}/cache/<workspace-key>/derived-session-cache-v1.json` | Rebuildable session titles, activity, run classification, outcome, and bounded context facts for one normalized workspace identity |
| Verified dispatch relationships | `${ARC_HOME:-~/.arc}/cache/dispatch-relationships/<launch-id>.json` | Successful cwd verification shared by window discovery and CLI cost reads. [Standalone sessions](standalone-sessions.md#standalone-observation-contracts) owns admission and retention |
| Codex opening records | `${ARC_HOME:-~/.arc}/cache/codex-openings.json` | The opening record of every Codex rollout on the machine, which places each rollout in a workspace. Every workspace and window reads and writes the one file |
| Prompt asset staging | Extension global storage | Generated-id copies of files attached to unsent, locally queued, or in-flight prompts |
| Local filesystem | The selected session's recorded working directory | Immediate path-completion candidates for the Prompt box, and the file or folder kind of each dropped or added item |
| Editor drag and Explorer menu | The `dataTransfer` of a drop on the Prompt box, and the resource arguments of `Add to Arc` | File URIs that become path text in the draft or image attachments staged from disk |

## Bounded usage history

Hosts record bounded usage history asynchronously and preserve duplicate readings. Each slot permits 4 MiB of compressed payload and 8 KiB of metadata, temporary, and lock bytes. A fixed format file keeps protocol-created logical content below 128 MiB. This limit excludes filesystem allocation and files added by external actors. The raw allowance is 64 MiB per UTC day. Retained dates are today and the preceding twenty-nine UTC dates. Project cost uses local calendar dates.

Each host admits at most 256 KiB of queued and in-flight raw readings into one drain. Each gzip batch contains at most 64 KiB. One compressor and compressed result add bounded memory overhead. Busy, full, invalid, or failed recording leaves current account figures and their workspace persistence available.

Exclusive slot ownership spans payload writes, sync, close, and committed-prefix metadata publication. It requires a filesystem that honors exclusive creation. Unexplained payload tails, metadata temporaries, unsupported files, and failed publication or close preserve bytes and block admission. Locks receive no age takeover. Verified expired generations are replaced under ownership using the current UTC date. Closed editors and blocked slots retain physical expired bytes.

Terminal host shutdown closes recording admission synchronously and waits for active work to settle. Unowned preparation starts no further filesystem operation after closure, except closing acquired handles. Owned slot operations finish while retaining their lock. Closing a panel tab leaves recording active. Hosts running the legacy recorder append legacy history until they stop. The bounded recorder leaves that file unchanged. Historical analysis has no shipped command or panel surface.

Usage payloads name the plan without identifying the account or organization. Readings from accounts on the same machine can therefore mix.

## Snapshot storage

On activation, the extension removes snapshot session folders whose trigger is older than 30 days. If no trigger exists, it uses the folder timestamp.

The store contains:

```text
baseline/<sha1(abspath)>   first-touch content
pending-baselines/<hash>/   published baseline bytes and path, cwd, and new-file facts awaiting index completion
index.json                 hash-to-path entries and the session cwd
manifest.json              new files and existing files that differ from the baseline
trigger                    watcher signal
```
