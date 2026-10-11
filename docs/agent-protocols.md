# Agent protocols and runtime

Read this document when changing CLI launch, child ownership, resume, asks, streaming, model controls, usage reads, or protocol translation.

## Runtime shape

Panel-started children receive the packaged `arc` launcher directory before their inherited PATH. Windows preserves the inherited PATH key's casing. `ARC_WINDOW` names this activation's window when its channel exists. Without a channel, children receive no `ARC_WINDOW`. `ARC_EDITOR_EXECUTABLE` names the editor binary. Both launchers set `ELECTRON_RUN_AS_NODE=1` and run `dist/cli.cjs` with that binary. The extensionless `arc` serves POSIX shells and Git Bash. `arc.cmd` serves Windows command shells. Fresh, resumed, draft, idle, and rename-only children share this environment.

Each active session owns a child process in the window that started it. Children communicate over stdio and die with the extension host. Another window follows their work through the transcript on disk rather than by attaching to the child.

Session identity outlives the process. The Panel sends each prompt to its named session, and the extension starts a fresh child with that id when no current child owns it. The transcript remains the record used by the timeline.

Idle control reads use a child that starts no session. They supply account usage, model catalogs, skills, or MCP state without writing a prompt. `agenthost.ts` reuses a live idle child when it can and closes it after the requested controls settle. A Claude draft is the exception. Opening Servers retains its provisional child for pending status refreshes and the first prompt.

## Shared vocabulary

`agentwire.ts` defines asks, answers, session events, settings, and turn outcomes. `claudewire.ts` and `codexwire.ts` reduce their vendor messages to those values. `activitydetail.ts` assigns known operations an explicit detail policy and reads only safe subject fields from unknown tool inputs. Prompt box and host code must use these shared values.

Prompts use a shared value containing text and staged file descriptors. Vendor-specific content blocks stay inside the wire adapters. String callers are normalized to the same value with no files.

The shared stream includes:

- readiness and settled session identity
- busy state and streamed response text
- visible work activity with stable source ids, including narration, clear reasoning summaries, tools, plans, and collaboration
- permission or question asks
- completed, interrupted, and failed turn outcomes
- model catalogs, usage, rate limits, commands, and MCP reports

The adapters retain source-specific fields only where a later decision needs them. Unknown messages are ignored or reported without blocking the line reader.

Native evidence events retain the session, tool identity, literal command, and successful settlement separately from display Activity. Claude events retain prompt submission generations, explicit root tool envelopes, direct caller fields, result UUIDs, and result indices. Codex tool and turn events require exact thread and turn identities. Codex compaction acceptance and refusal carry the thread alone, because the request answer can arrive before the compaction turn has an ID. Each Codex compaction request has a generation. Its submission event, acceptance, refusal and turn evidence carry that generation. Each compaction request that gets no answer before its deadline keeps reporting the evidence of its own later turn, also after a later compaction starts. The wire holds such a request until its late turn ends, its thread is replaced or the wire closes. While it holds eight, a reader's compaction drops the oldest receipt of a reader's compaction and is still written. Deferred work passes the write callback. The full bound refuses such a compaction before writing it, so no receipt of deferred work is dropped. A new compaction turn belongs to the oldest such request only while no compaction is pending and no prompt waits for its own turn. Compaction evidence preserves native acceptance separately from terminal completion. The compact operation accepts a synchronous callback before provider input is written.

## Link a launched session

Arc links direct `claude --bg` and `claude -p --output-format json` launches when the parent Bash result reports their IDs. A fresh `codex exec --json` launch links from its paired stdout `thread.started` event. Claude and Codex parents support Codex launches and wrapper receipts. A wrapper can opt in with a standalone `--arc-dispatch` argument and print one receipt line to stdout:

```bash
python review.py --arc-dispatch task.md
```

```text
ARC_DISPATCH_SESSION={"agent":"claude","session_id":"4f4bf298-958f-4751-8782-d8688ff808a6","name":"Review branch"}
```

```text
ARC_DISPATCH_SESSION={"agent":"codex","session_id":"aaaaaaaa-1111-1111-1111-111111111111","name":"Review branch"}
```

The `name` field is optional. Add `"owned":true` when a person asked for the session. Arc then files it with their own sessions instead of Run by agents. `owned` takes no other value. A Codex `session_id` must name a full UUID. A Claude ID accepts a full UUID or eight hexadecimal characters from its background launch. Arc resolves each ID against sessions of the named agent in the current project. A detached wrapper must capture the child ID before printing its receipt. Print one unquoted stdout receipt per launch, after framing any receipt-shaped worker text. Arc rejects malformed, oversized, repeated, and ambiguous receipt results. A direct Codex launch must start fresh and supply one top-level `thread.started` event in its own stdout. Resumes, nested or quoted events, mixed launch modes, and stderr events link nothing.

## Claude stream-json

Claude starts in stream-json input and output mode with verbose records and partial assistant messages. The permission prompt tool is set to stdio so tool permissions and `AskUserQuestion` arrive as control requests. The flag is required even though it is not shown in the CLI help.

A permission question arrives as a tool-use request. An answer allows that request with an answers map keyed by the question text. Denial includes the reader's reason.

A resumed child may not announce its session id until it produces output. The launch plan seeds the expected id so the host can associate the first prompt and any compaction with the correct session.

Claude compaction uses the `/compact` command published by its initialization response. The session treats it as a distinct operation so the prompt box cannot attach comments or other prompt text.

Claude control responses share stdout with turn events. Request ids pair responses with callers, and unanswered controls expire so one missing response cannot hold the host open.

Claude's text cannot be classified from a partial delta alone. A completed assistant message that stops for tool use becomes Activity narration. A message that stops for any other reason remains response text. Tool-use ids and message ids let the transcript copy replace the temporary live copy.

JPEG, PNG, GIF, and WebP files become base64 image blocks. PDFs become base64 document blocks. Text media types become UTF-8 text document blocks. Other binary media types are rejected before the prompt is accepted. Base64 exists only in the Claude wire envelope and never in saved prompt box state or webview messages.

A command the CLI answers by itself still reports a result. The result carries the command output as `result`, `num_turns` of zero, and a null `stop_reason`, and it arrives in well under a second. A real turn reports at least one turn and a cost. That count is how the panel tells a command the agent ran from a turn that produced nothing. A harness control such as `/model` or `/context` writes no turn the transcript reader can find. Neither does a command the CLI records only as a `system` record. A command the CLI records as a typed user record, such as `/rename` or `/usage`, opens a turn, and its recorded answer withdraws that turn. [`timeline.md`](timeline.md) describes that rule.

`/clear` keeps the child and starts a new session inside it. The transcript it was writing stays on disk, complete and resumable, and everything after that moment is written to a new file. The CLI announces the change with a `conversation_reset` message, then repeats `system/init` under the new id.

**Read the successor id from that `system/init`, never from the reset message.** The reset carries `new_conversation_id`, which is not the session id that names the transcript file. A panel that follows `new_conversation_id` watches a file that is never written.

`system/init` repeats before every local command result, so its arrival means nothing on its own. Only a change of session id does.

A fresh start that carries a requester adds `--replay-user-messages`, because a guarded follow-up uses the replay as its receipt. The follow-up write starts a native submission, as an ordinary prompt does. The follow-up carries a client UUID. Only a replay frame with that UUID, the same session, root scope, and exact text accepts it. A result, an idle report, child exit, or 120 seconds without that frame leave the outcome unknown. Replay frames never reach display or turn tracking.

## Codex app-server

Codex speaks JSON-RPC through `codex app-server`. Server requests carry both a method and an `id`. Request id `0` is valid and must not be tested for truthiness. Notifications carry no request id.

The opening command catalog comes from `skills/list` with the child's working directory. A `skills/changed` notification starts another `skills/list` with the same directory and `forceReload: true`. A notification received during opening waits for that read before it starts the forced refresh. Notifications received during a refresh produce one trailing refresh. A successful response replaces the complete catalog. A failed response leaves the previous catalog active.

Thread start or resume establishes the session. A prompt is accepted only after `turn/start` succeeds. The host does not show a prompt as delivered while the server can still reject it.

Compaction uses `thread/compact/start` with the established thread id. `turn/start` does not parse the CLI's slash commands. Sending `/compact` there gives the text to the model, which can answer it or select a similarly named skill. The empty native response only acknowledges the request. The host remains busy until the compaction turn reported by `turn/started` reaches `turn/completed` or `turn/failed`.

Clear and `/new` use `thread/start` with the current session settings. `/new` accepts the rest of its line as the new session name and applies it through `thread/name/set`. The new thread emits a session event with the previous thread id, so the panel records the reset edge and follows the successor.

Recent rollout `compacted` records include `latest_token_usage_record.usage` for the completed compaction request. The following `thread_settings_applied` record can supply its model and billing route. The parser reads that request only. It does not infer a compaction charge from the record's cumulative counters. Codex records no trigger. The parser uses the containing non-replayed turn: normal work before the boundary is automatic, and a known empty dedicated turn is manual. An incomplete turn start remains unknown. Context size does not identify the trigger.

The `turn/start` response is the authoritative source for the active turn id because it is paired with the request that began that turn. Stop waits for a pending start response, then sends `turn/interrupt` with both the owning thread id and that turn id. Prompts accepted while work is in flight can share the same server turn id and complete together. Stop targets the oldest unfinished server turn. A matching completion clears every submission grouped under that id, while a late notification cannot disarm a newer turn.

Codex gives a rollout an exclusive writer. When another client owns the source thread, the panel offers continuation. Acceptance forks the stored thread, sends the prompt to the returned thread id, and uses that session for later messages.

Approvals are server requests. Interrupt is a client request, and the resulting non-completed turn is translated to `interrupted` rather than a user-visible failure.

A file approval carries no changed path. Its item id joins it to the active `fileChange` item, and the wire republishes the normalized ask when the item arrives after the request. The original server request id remains the identity used for the answer.

Codex agent messages carry a phase. Commentary is visible Activity and final-answer text is the response. Reasoning contributes a row only when the server supplies a clear summary. Empty and encrypted reasoning content is not displayed. Command, plan, and collaboration items keep their item ids so starts, completions, and transcript records reconcile.

An agent message can also carry `delivery: async`, the marker for an item returned to the model without ending its turn, set for example by the `request_user_input_async` and `send_message_to_user_async` tools. Its item can carry `phase: final_answer` on a message that is not the turn's reply. The wire reads `delivery` and keeps an async item off the reply stream and out of the turn's outcome text. An async item with at least one titled entry in `questions` becomes a question ask. Its id is the JSON text of `["request_user_input_async", itemId, index]`. The question also becomes a done Activity row that replaces the streamed row. It remains while the panel retains that turn's live Activity. An async item with no titled question becomes one Activity row instead. An async question ask stays open after its turn ends, because no request waits for its answer. The answer travels as a user message whose whole text is a reply envelope: `<send_user_message_question_reply>`, a JSON array of `{ questionItemId, question, answer }` entries, and `</send_user_message_question_reply>`. Each entry's `questionItemId` is the question id, and its `answer` joins the picked labels and any written answer with commas. `codexreply.ts` builds and reads the envelope. The wire sends it with `turn/steer` while the question's turn runs. After that turn ends, or when the server refuses the steer, the wire sends the same text as a new prompt on the thread that asked. A refused prompt offers the question again. A steer or prompt with no response before its deadline is not sent again, because it can have arrived. A new thread in the same session, such as the one a clear starts, closes every async question an earlier thread asked. A dismissal sends Codex nothing. A user message on the thread that is only a reply envelope answers each open async question it names. An ask keeps its unanswered questions and closes when none are left, so an answer given on another Codex client closes the question in the panel too.

A rollout records an async item as an `event_msg` `item_completed` record whose `AgentMessage` item carries `delivery: "async"`, `phase: "final_answer"`, and the `questions` array. The model's tool call sits beside it as a `function_call` record, and no `response_item` message repeats its text. Codex leaves the item out of the `last_agent_message` that `task_complete` records. `codex.ts` reads the item as one Activity update under the item id, with the text of the live Activity row, and never as an answer. A recorded user message that is only a reply envelope reads as each question followed by its answer, in the prompt, in a later prompt, and in the session title. A user message with any other text around the envelope stays ordinary prompt text.

Codex image files become `localImage` inputs. Other files become `mention` inputs with their display name and staged path. The JSON request contains paths and metadata only. It never contains the file bytes. The staged file is checked against its saved SHA-256 digest before delivery and remains available until the Codex turn ends.

A guarded follow-up is accepted on its own `turn/start` response. A returned turn ID that the wire saw before the write, or that another pending start holds, means the input joined a shared turn. That outcome is unknown, and the follow-up's assignment goes stale. Every error response after the write also leaves the outcome unknown. A compaction request that got no answer withholds idle evidence and refuses a guarded follow-up until its late turn ends, because that turn can still start.

## Session rename

Each agent writes a session's new name itself. Arc never writes a transcript record, a title file, or an index entry.

Claude renames through the CLI's `rename_session` control request. It carries the name, the session id Arc resolved for the session, and `source` set to `host`, which tells the CLI that a person renamed the session in the application hosting it. Claude Code persists the name in a transcript `custom-title` record or `<transcript directory>/<session id>/custom-title.json`. It answers on the control channel and writes no result, so the rename runs no turn and costs nothing.

The CLI refuses a session id that is not the one its process is in, with `session_id is not the current session`. That refusal fails the rename, and so does a request the CLI does not answer within the control deadline. A child that runs the session keeps running through both. A rename-only child is disposed, because it was started for the one request. The answer is matched by its request id, so a late one settles nothing.

The control channel is read beside the turns rather than inside one, so a rename applies while a turn is running. A typed command line does not: the CLI reads it when the running turn ends.

Claude Code reports success for a rename it could not save. An existing session rename counts only when the saved title file holds the requested name. Initial naming also accepts the newest complete `custom-title` for the accepted session in a bounded 16 KiB transcript tail. That transcript title takes precedence over the sidecar for initial naming. Arc reads at most 4 KiB of `custom-title.json` and compares the whole saved value. It checks up to six times, 50 ms apart. These reads happen only inside a rename, never on the listing path. Initial confirmation resolves only the accepted transcript. Recorded cwd determines membership. Missing cwd requires an exact project slug. Multiple matching transcripts refuse confirmation.

Arc cleans the name once, before either agent call, and sends nothing when the cleaning leaves nothing. The Claude wire sends the cleaned name as given.

Arc runs one rename of a session at a time. Two renames sent together read the same transcript end, and the session keeps only the record the agent wrote last.

Codex renames through `thread/name/set` with the thread id and the name. A typed `/rename` in a Codex session takes this path too, because `turn/start` gives the text to the model. The server writes the name to the index every Codex client reads, and a refusal rejects with the server's message. Initial naming retries only an empty-rollout metadata refusal for the same accepted session. It starts at most 40 requests within two seconds, with 50 ms between refused attempts. Each request retains the provider control deadline. Other refusals and exhausted readiness return the accepted session with a naming error. It reads no turn, so this rename also applies while a turn is running.

A session with a running child renames through that child, whatever that child is doing. A session that is still opening renames through its child once the opening ends. Any other session starts a rename-only child. The Claude child resumes the session in the folder the session recorded, and sends only the rename request. The Codex child finishes the handshake and sends only `thread/name/set`, without resuming or starting the thread. Either child then closes.

## Child ownership and shutdown

`AgentHost` serializes session opening by host key and provider session id. A resumed writer waits for confirmed process exit, including when the old child adopted its id under a fresh key. A termination request does not release that barrier. Host disposal rejects pending and later openings. A rename-only child is a writer too. An opening of the same session waits for its exit, and it waits for a retiring writer's exit before it starts. Host disposal ends it.

`AgentHost` treats a successful opening as settled until the first turn ends. That starts the first idle window. Each turn-end housekeeping batch then receives a new generation. Only the latest generation can start retirement after its usage and MCP reads settle. `arc.agentIdleMinutes` sets the warm window. Changing it restarts timers only for sessions whose current housekeeping generation settled.

The timer rechecks that the child is live, idle, and has no open ask.

The panel publishes its restored archive set when the host connects. It also publishes archive changes and an empty set when the reader clears workspace state. Archiving retires an eligible child immediately. A child is eligible when it has no busy turn, no open asks, no held lease or opening reservation, and settled housekeeping. Otherwise the host retires the archived child at the first later settlement that meets those conditions. Unarchiving cancels deferred archive retirement. Eligibility ignores background subagents and background commands, so retirement can run while that work is in progress. Retirement closes the child's input and requests termination of the child process when it outlives a grace period. Arc sends no signal to processes the child started.

Prompt and control operations hold an activity lease. The lease cancels timed retirement before work starts. Its release starts a new full idle window when the child remains eligible. Retirement removes only the child. The saved session id and accepted session settings let the next prompt resume the session from disk with the same configuration.

A targeted retirement closes one provisional draft child after any opening or control activity settles. Abandoning a draft retires its retained MCP child. Closing the last panel retires all retained MCP children. Draft profile changes follow the acceptance rule in [Architecture](architecture.md#module-boundaries). Extension disposal closes every remaining child.

Agent-wide permission and MCP changes lease every live target before they await the first control response. An MCP lease lasts through the final status read. A replacement builds its launch settings after the previous child finishes shutting down. Persisted settings publication preserves provisional draft entries held only by the panel. A Codex fork stores its accepted launch profile under the returned session identity.

Closing input is the first shutdown step. Claude can persist control changes during orderly exit. A process that does not stop after input closes receives a termination request. Replacement waits until the process reports exit.

Each pending ask, open request, and completion promise is settled when the child closes. A dead pipe returns an error to the initiating action instead of leaving the prompt box in a running state.

## Launch selection

User-configured executable paths take priority. Each agent then uses its command on `PATH`, followed by the binary bundled with its official editor extension. Standalone installs remain fallbacks. The Unix search skips relative entries and paths that are not executable files, because a child can start in a different directory from the extension host.

On Windows, npm command shims are batch files and cannot be spawned directly without a shell. The launch plan resolves the package script and runs it under `process.execPath`. When `process.execPath` is VS Code's Electron binary, `ELECTRON_RUN_AS_NODE` makes it behave as Node.

Codex package launch prefers the platform binary over its JavaScript launcher to avoid a console window from a grandchild. The launch plan supplies the package environment that the launcher would have set. Unsupported machine architectures fall back to the launcher.

A Claude child inherits the extension host's environment. Claude Code writes an `ai-title` record for a headless launch only when that environment carries `CLAUDE_AGENT_SDK_VERSION` or `CLAUDE_CODE_REMOTE_SESSION_ID`. The official Claude Code extension sets the SDK version variable in the shared extension host on its first query in the window. `childEnv` removes both variables from every child Arc starts, so a Claude child never gets a generated title. Claude Code never titles from a first prompt that is a slash command, and it never starts titling a resumed session that already has messages. A session with neither a `custom-title` nor an `ai-title` is named by its first typed prompt.

## Settings and control reads

Claude can change the current child's model through its control channel. The control channel carries no request for an effort level. Arc changes a live Claude level by writing the CLI's own `/effort <level>` command on the stream-json input. The CLI handles that command itself and answers with a `result` event. The applied level is read back from the `effort` field on the next assistant record. Codex applies model and effort to the next turn and confirms them through the transcript.

Codex approval policy, approval reviewer, and sandbox policy are separate protocol fields presented as one reader choice. The `on-request` policy still asks the reader unless `approvalsReviewer` selects auto-review. Thread-start and turn-start sandbox values use different spellings, and `codexwire.ts` translates between them.

Rate limits and model catalogs are read from each CLI. Claude answers control requests and can send rate-limit events during a turn. Codex answers JSON-RPC reads and sends update notifications. `usageview.ts` receives normalized snapshots from either route.

Account reads serialize per agent. Two reads share one request only when they target the same session or draft for MCP discovery. A selected owner's read starts in that owner's recorded working directory.

Codex caches account eligibility for each app-server process. Read again independently rediscovers eligibility before renewing managed authentication for supported usage reads. Fresh idle children also renew authentication on explicit supported reads. A long-lived process keeps the credentials it opened with. An eligible idle sibling supplies the account reading when another child remains busy. A fresh control child reads Codex accounts when only obsolete siblings are idle. When all live children are busy, both agents wait without interrupting work or changing active authentication.

Read again selects the newest eligible idle Codex source unless MCP discovery selects its idle owner. A surviving older child becomes eligible after the authoritative source exits or retires. Discovery revisions reject obsolete replies, and source identities reject obsolete notifications. Rejected usage admission leaves model catalogs independent.

Each explicit attempt has a 120-second deadline from its accepted press, including queue and busy waits. Expired requests cannot dispatch unsent reads. A sent read retains its ownership until it settles. Retry joins that read without a second authentication renewal. Late supported readings update figures without changing an expired attempt's outcome.

Unsupported account discovery releases account ownership, joined attempts, deferred waits, and the refresh deadline before catalogs finish. Model catalogs, commands, and MCP discovery remain independent. Account completion releases automatic and explicit read ownership before model catalogs or MCP status finish. Each operation has its own identity, so an older catalog completion cannot release a newer account read. Failed and empty answers retain the previous readings. Explicit failures appear in usage detail, while automatic failures remain quiet. Discovery stays hidden until the account supports subscription reads. Queued, waiting, reading, and terminal status stay in memory and never enter account history or workspace state.

## Failure interpretation

Both CLIs use failure-shaped records when the reader interrupts a turn. The adapters recognize each protocol's interrupt marker before they classify a failure.

A command with a nonzero exit is failed activity, not necessarily a failed turn. A turn failure comes from the agent protocol's turn outcome. The card can show the activity row without claiming the whole turn failed.

Launch, handshake, control, and prompt deadlines are separate. Their messages name the action that failed so the prompt box can offer an appropriate next step.

## Agent launch commands

Arc starts each installed CLI as a child process and communicates over its headless protocol. The panel does not drive a terminal UI.

`claudePlan` and `codexPlan` in `agenthost.ts` build the command. The executable and any leading arguments come from `composerview.ts`, which decides whether the agent is an executable or a script that runs under the Node on this machine.

**Claude Code**, print mode over the stream-json protocol:

```
claude -p --verbose --input-format stream-json --output-format stream-json --permission-prompt-tool stdio --include-partial-messages
```

`spawnArgs` in `claudewire.ts` adds `--model`, `--effort`, and `--permission-mode` from the reader's accepted settings. The host adds `--resume <id>` for an existing session or `--session-id <id>` for a new one. It adds `--no-session-persistence` for a temporary child and `--settings <path>` when a launch supplies a settings file.

The following flags provide stream framing, permission requests, and partial response text:

- `--verbose` is required. Without it the CLI refuses `--output-format stream-json` and exits.
- `--permission-prompt-tool stdio` enables permission requests. It does not appear in `claude --help`. Without it the CLI silently allows every tool in headless mode and the reader is never asked.
- `--include-partial-messages` publishes response text while the agent writes it. Without it, the CLI emits no response text until the turn ends.

`childEnv` removes inherited `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_AGENT_SDK_CLIENT_APP`, `CLAUDE_CODE_REMOTE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, and `CLAUDE_CODE_CONTAINER_ID` before applying launch variables. Removal includes every case variant of these environment names. Without an explicit override, print-mode Claude uses its ordinary `sdk-cli` entrypoint. Without a generated title, the session keeps the name the session-name rules give it.

### Claude attribution selection

Arc reads `ARC_CLAUDE_BILLING_LABEL` from the extension host environment when starting each Claude child. If that variable is absent, Arc reads it from `.env` in the child's working directory. Arc reads only this selector from the file and does not change the editor environment. It trims surrounding whitespace and accepts only these lowercase values:

| Value           | `CLAUDE_CODE_ENTRYPOINT` | `CLAUDE_CODE_ATTRIBUTION_HEADER` |
| --------------- | ------------------------ | -------------------------------- |
| `sdk-cli`       | `sdk-cli`                | `1`                              |
| `claude-vscode` | `claude-vscode`          | `1`                              |
| `omit`          | `sdk-cli`                | `0`                              |

Unset, empty, whitespace-only, and unsupported values preserve ordinary launch behavior, including inherited attribution settings. Recognized selections replace conflicting inherited and launch values for both vendor keys. Arc removes all their case variants before writing canonical names. The selector name also accepts case variants. Launch variables cannot select the mode. Codex launch behavior stays unchanged.

The selection applies to fresh and resumed sessions, provisional draft children, renames, idle account and model reads, and metadata-default reads. Existing children keep their captured environment, including a provisional child reused for its first prompt. Arc does not restart children to apply a selection.

Changes to `.env` apply when Arc starts another Claude child. Arc does not search parent directories. Missing files preserve ordinary launch behavior. Other file-read errors prevent the Claude child from starting. Close the relevant editor processes and restart them to change the extension host environment. Changing a terminal's environment does not update an already running editor. These values select request attribution and provide no subscription-rate guarantee.

**Codex**, the app-server protocol:

```
codex app-server
```

Codex uses JSON-RPC 2.0 over stdio, with one object per line and no `jsonrpc` field. Protocol requests carry operations instead of command-line flags. The official Codex editor extension uses this experimental protocol.

## Runtime constraints

- Session identity comes from the saved session id and disk record, not from process lifetime. Closing the window ends children. The next prompt resumes from disk.
- `AgentHost` owns idle and archive retirement. A successful opening starts the first idle window. The panel sends restored, changed, and cleared archive sets to the host. Turn-end housekeeping uses session generations so an older completion cannot settle a newer turn. Process operations reserve opening keys and hold retirement leases. They restart a full idle window when they finish. A resumed writer waits for confirmed exit or terminal closure from the prior child with the same provider session id. Every timer callback rechecks busy state and open asks before it closes a child. Host disposal prevents pending openings from starting another process.
- A draft's setting controls change only that draft. Its accepted model, effort, and permission mode move to the real session id and become that session's resume settings. The panel publishes those settings only after identity adoption succeeds. The same path publishes settings copied to a `/clear` successor. A draft press routed through the live pick path would change existing sessions.
- A fresh child starts from the draft's own frozen copy of its setup. A pick that updates the stored profile alone starts the child on the setup the reader replaced.
- Opening Servers on a new Claude draft starts the child under the draft's first-prompt host key. Pending states refresh against that child. The first prompt reuses it. Draft removal or panel closure retires it without creating a started-session record.
- A fresh child can report its session id before the transcript or rollout is discoverable. Keep the selected synthetic row under that actual id until the disk record replaces it.
- The panel sends every Claude prompt with a human origin, and the CLI copies that origin onto the prompt record. The Claude agent-run rule reads a human origin as a person, so a session driven from the panel reads as a person's in every window.
- Claude Code writes some system records with no person present: `stop_hook_summary`, `compact_boundary`, `turn_duration`, `api_error`, `informational`, and `away_summary`, its recap for a session left unattended. The agent-run rule skips those subtypes in a transcript whose records carry an SDK entrypoint, such as `sdk-cli`. It also skips them once `sessionKind: 'bg'`, the field `claude --bg` writes, has arrived by the time the whole file is read. Older editor and terminal builds write no human origin. Under every other entrypoint, with no `sessionKind: 'bg'` in the file, each of those records reads as a person. Every other system record, `local_command` among them, reads as a person under every entrypoint. A slash command with no origin is the run's own prompt in an SDK-only transcript. An SDK-only transcript never counts a typed prompt with no origin toward a second prompt. That is what a resumed `claude -p --resume` review leaves behind. In a background session, the launch prompt carries a human origin, and the rule excuses it whether it is typed or a slash command. A second prompt of either form with a human origin reads as a person. In a background session, a follow-up prompt with `promptSource: 'sdk'` and no human origin is the dispatching agent's own. It is not counted at all, so a background session whose only prompt is shaped that way reads as the owner's, not a run.
- The Claude agent-run rule answers run only after a turn finishes, because a person's first turn shows no sign of a person yet. An SDK-only transcript with no `sessionKind: 'bg'` is the exception. Its prompt with no human origin did not come from the panel, so a reviewer or worker that another agent started files under Run by agents while its first turn runs. Every later sign of a person still ends the run answer. The exception assumes that the panel is the SDK host with a person at the keyboard, and that it sends a human origin on every prompt. A person in another Agent SDK host that sends no human origin files under Run by agents during the first turn, and after that turn finishes. A background session keeps the finish requirement, because its first prompt carries a human origin.
- A panel session whose prompts carry no human origin reads as an agent run in its own transcript. The Claude rule reads the absence of a person, and a first turn shows none. The panel's launch record (`startedHere`) overrides that guess for the sessions it started. A dispatched session answers run whenever it and its parent both have a session row, because the parent's shell command is a positive fact. The reader owning the session is the one fact that outranks it. The reader owns a dispatched session when its receipt is owned, or when its transcript holds a sign that only a person leaves: a prompt or a slash command with a human origin, a follow-up queued while the agent worked that `isReaderQueued` reads as the reader's, an editor tag on a prompt after the launch prompt, or a tool call the reader refused. A background session's launch prompt is no sign, whether typed or a slash command, because `claude --bg` sends it with a human origin itself. `scanForPerson` in `transcript.ts` reads those signs apart from the transcript's guess, because a guess of a person also covers a first turn that has not finished. The catalog worker scans a running child from the size it first sees, so a running child costs little more than its metadata. That scan counts no typed prompt and reads no editor tag, because it cannot see the prompts written before it. It reads a slash command with a human origin as a sign. The one exception is the first prompt the scan reads, when that prompt is a slash command, in a background session whose bytes before the scan's start hold no user record, because that command is the launch prompt. A slash command that follows an earlier prompt in the same scan counts as a person's. The worker reads those bytes whenever a fresh scan starts above byte zero: when it first sees the child, after the file shrinks, and when a quiet child with no held scan becomes active again. Each of those reads stops at the first user record. Once the child is quiet, the spend read of its whole file reads every sign, so the fact costs no read of its own. A session the reader owns keeps its dispatch edge for its heading and its parent's cost. The launch record wins over a dispatch edge, because an opted-in wrapper's receipt can name a session this window started. The record outlives the window, because the transcript never becomes any more readable. The panel applies the override where the answer is read. The cached transcript reading stays true for a window that did not start the session.
- The metadata tail answers the Claude agent-run rule only when it reaches the start of the file. Session list enrichment scans a larger top-level session whole in the progressive worker, beside its turn starts, and stores the answer and its byte cursor in the derived session cache. Both the metadata tail and the whole-file scan skip a half-written last record, a last line with no newline that does not parse, and answer from the lines before it. Both read a complete line that does not parse as a person. The metadata tail reads a last line that parses but has no newline yet, and the scan answers a person until that newline arrives. The scan answers run for an SDK entrypoint, or for `sessionKind: 'bg'` arriving on or before any record naming another entrypoint. A non-SDK entrypoint seen with no `sessionKind: 'bg'` yet locks the scan to a person at once. A `bg` record later in the file cannot undo that. A person answer is final. A run answer rereads only appended bytes, and a file that shrank is read from the start. A metadata reread of a file that only grew keeps a run answer two ways, because the metadata tail answers nothing past its window. An entry with no scan yet, answered run from the tail read alone, carries that answer forward until the first scan runs. An entry with a scan carries a run answer whenever the scan itself answers run for the bytes it covers, never from the entry's own `agentRun` field, because a scan result that lands through a stale worker read moves the cursor without touching that field, except that a person answer also writes `agentRun: false` there, since a person answer is final and must not show as a run beside it. A scan whose transcript only grew while it ran keeps its cursor, even though its other results are stale. A child transcript never takes this scan: the parent's `Agent` call is the positive fact, and every record in a child transcript is a sidechain record the scan would count as nobody's prompt. The metadata read and the panel's session list row both answer a child transcript as an agent run directly, so a stale cached answer never reaches the reader. A metadata reread also stops carrying a stale scan forward, so a cached entry that disagrees settles to the right answer without a cache clear.
- A reader stop is reported as a failure-shaped outcome by both CLIs. Each wire adapter converts that case to `interrupted`.
- Claude reports one turn ending for the prompt an accepted Stop abandoned, and none for the prompts it canceled. A Stop of a turn the CLI started by itself, such as one for a task notification, gets one ending too. That ending is told apart by the word the CLI puts on it. An abandoned turn ends with `aborted_streaming`, or with `aborted_tools` when the Stop came during a tool. A prompt sent after the Stop ends with `completed`. Counting endings instead strands whichever turn guessed wrong, and that turn then keeps the session busy for the life of the child. `STOP_ENDING_GRACE_MS` bounds how long the ending stays owed, so an unrelated interrupt long afterward cannot claim it. The session list bounds the same claim a second time. A busy child stops answering for a card once the record closes a turn that ended after the child became busy.
- A Claude setting the CLI takes as a command costs a turn. `/effort` and `/compact` both end with a `result` event, which the wire reads as a turn ending. `agenthost.ts` books an open turn before either goes out. Without that booking the ending closes a turn the reader is waiting on. A level picked while the session is working is held rather than sent, and goes out when the session next has nothing running. A prompt the reader sends meanwhile waits for the held level and reaches the child after it, so its turn runs at the picked level. An accepted Stop leaves the session idle without ending a turn, and the held level goes out there too. A level the chosen model does not offer is dropped instead, because the command has no level to name. The drop still reaches the child, which throws away a pick waiting to go out under the old level. The child keeps running at the last level it heard, and the panel ticks no level until the reader picks one the new model offers. `modelChange` in `agenthost.ts` decides all of this.
- A Claude prompt that arrives while a turn runs joins that turn and gets no `result` of its own. One `result` ends the turn and every prompt it took in. Arc launches Claude with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`, so the CLI writes `system` events with subtype `session_state_changed`. The CLI reports `running` when it takes work while idle, and `idle` right after the `result` that leaves it nothing to run. `/compact` and `/effort` follow the same order. Each `result` still ends the oldest open turn. An `idle` report ends, in one pass, every prompt and command turn that was open when a `result` arrived. It releases their attachments and drains the panel queue. A turn that reached the child after the latest `result` waits for its own `result`, because it cannot have joined the work that `result` ended. A prompt still being prepared stays open. A `running` report, or `requires_action` while a permission ask waits, keeps the session busy until the next `idle`. That covers a turn the CLI starts by itself for a task notification. The CLI reports `idle` while background tasks still run, so a background task never holds `/compact`. An accepted Stop leaves the session idle before the CLI reports it. The CLI answers the Stop, then writes the aborted `result`, then `idle`. The aborted `result` does not count as a `result` for the `idle` rule, so a command sent after the accepted Stop waits for its own `result`. A CLI that never reports its state leaves `result` events as the only turn endings.
- Claude asks depend on `--permission-prompt-tool stdio`.
- Claude's `init` system message, and the skill list it carries, arrives only once a session has taken its first prompt. It never arrives before a prompt, so an idle child started only to answer controls never reports one. The stored skill list for a session's working directory stands in for a session's own list until that session's `init` message arrives, and a new list replaces the stored list for that directory.
- Codex reports `skills/changed` only while an app-server child is connected. The child refreshes with its original working directory and `forceReload: true`. A failed refresh keeps the last complete catalog, and a later notification can replace it. When no child remains, the next child reads the current catalog while it opens.
- Claude reset times have two sources. Account usage carries ISO timestamps on named windows, while live rate-limit events carry Unix seconds from model-response headers. The monthly money cap carries no reset, and an idle child cannot read headers held by another process.
- Claude account usage names the subscription but not its Max multiplier, so a Max account reads as `Max plan` with no tier beside it. The multiplier exists only in the local auth profile, which is not a source the panel reads.
- Live reset windows persist in VS Code workspace state. Reload restores them until their reported reset time passes.
- A Codex `account/rateLimits/updated` notification can carry a named model bucket instead of the account aggregate. The model name is part of the limit identity. Dropping it lets that update overwrite an account window on the same clock.
- Codex server requests are identified by the presence of `id`. Request id `0` is valid.
- Codex refuses `request_user_input` in default collaboration mode, and the model then asks its question as plain prose. The mode rides `turn/start` as `collaborationMode`, which the panel does not send, so every synchronous `request_user_input` question card the panel draws comes from another client's thread. An async question card can come from the panel's own thread instead, as the `delivery: async` paragraph in `docs/agent-protocols.md` describes. The server accepts an answer that is none of the offered options, and the model reads it back unchanged. Its own tool schema tells the model to leave `Other` out, because the client adds the free-form choice.
- A Codex question carries `isOther` and `isSecret` per question. The panel reads `isSecret`, because a secret answer must not be drawn on the tab that reports what the reader chose. It leaves `isOther` unread and offers a written answer on every question.
- A Codex file approval names only its item id. The paths come from the related `fileChange` item, whose changes are an array on the live app-server wire and an object map in saved rollouts.
- Codex `approvalPolicy` decides which requests may surface, while `approvalsReviewer` decides whether those requests stop for the reader or go through auto-review. "Approve for me" needs both settings.
- The empty permission value means Arc has no override for a launcher, draft, or live permission pick. Selecting it for a live session retires every live child for that agent before the next prompt. Claude then launches without `--permission-mode`. Codex starts and turns omit `approvalPolicy`, `approvalsReviewer`, and `sandbox`. Each agent applies its configuration and policy. Arc does not read or edit vendor configuration files. It reads transcript and rollout files without editing them.
- A live permission control names the effective mode the child reports. Its menu checks the agent-default row when Arc has no stored override, even when the effective behavior matches an explicit preset. A draft has no child response, so its control names its profile's permission, and names the agent default only for the empty value.
- `Same setup as current` copies Arc's stored override, including the empty value. A session with no stored override offers the permission a new setup preselects. A handoff draft from that session starts on the same permission. The row does not copy the effective mode reported by a live child.
- The Codex permissions control shows an explicit preset only when approval, reviewer, and sandbox all match. A custom combination names its approval behavior and access boundary. A reader override stays in Arc's VS Code state and travels on the app-server wire.
- Codex slash commands are client behavior, not `turn/start` behavior. Session compaction uses `thread/compact/start`. A literal `/compact` sent as turn input can reach the model or a similarly named skill instead. The manual compaction turn is not steerable, so prompts and another compaction wait until its terminal notification.
- Codex failure causes arrive as a notification string, an object with a `message`, or a turn error. The wire reads each form. Failed turns write no final answer. Lower layers must preserve the cause instead of supplying generic failure text.
- Codex model catalogs put their rows under `data` and continue through `nextCursor`. Stopping while a cursor remains can leave available models out of the picker.
- Accepted capability belongs to the newest discovered child process. Read revisions reject obsolete completions. Older children cannot restore excluded limits through direct notifications.
- Usage and rate-limit values are snapshots reported by the CLIs. They are not reconstructed from local turn totals.
- A Codex rollout has an exclusive writer. If another client holds it, continuation forks the saved thread and sends the prompt to the returned session id.
- A session discovered in another worktree resumes, compacts, and hands off from the cwd recorded in its transcript. Starting unrelated new work still uses the editor's open folder.
- Commentary and clear reasoning summaries are displayable activity. Empty, signed, encrypted, or raw reasoning content is not a source of visible text.

## Verification

`claudewire.test.ts` and `codexwire.test.ts` cover protocol framing and translation. `agenthost.test.ts` uses injected fake children to cover ownership, races, deadlines, shutdown, idle reads, asks, settings, and recovery. `codex.test.ts` and `transcript.test.ts` cover the disk records produced by those protocols.
