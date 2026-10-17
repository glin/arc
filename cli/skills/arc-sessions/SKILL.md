---
name: arc-sessions
description: 'Read and manage scoped Claude Code and Codex sessions through a running Arc window. Use when asked to start sessions in Arc, inspect progress, mark requested sessions read, send a follow-up to a session this session started, label, pin or archive sessions, link to a session in a reply, compact this session after the turn, or transfer requested follow-up work to a fresh session. Excludes terminal-only launches and automatic supervision.'
---

# Arc sessions

Use Arc for session work the reader requested. Start only the authorized work.

Treat tag as a natural-language synonym for label. Keep `arc label`, `--label`, and `label:` syntax.

## Select a ready window

Run `arc windows --json`. Select the intended window by its folders and `hostId`. Pass that ID through `--window` on every session command. `--window` overrides `ARC_WINDOW`. Without either, Arc requires exactly one live window and complete discovery.

After reload or reconnection, refresh discovery before a new operation. Explicitly reselect the intended folders and their current `hostId`. A stale explicit `--window` or inherited `ARC_WINDOW` still selects the old activation. Never transfer an old request ID or follow-up ownership to the new activation. Preserve uncertain outcomes under Interpret delivery before starting new work.

An empty list with `complete: false` does not establish a permission failure. Optional `diagnostics` report only observed `ENOENT`, `EACCES`, or `EPERM`, with a `registry` or `connection` stage. An observed `EACCES` or `EPERM` requires authorized local access to window details or the local socket. Report the limitation when the current permissions deny that access. Never bypass the permission policy or assume an editor restart repairs access.

Check `scopeReady` and `panelReady` before starting. A hidden panel leaves live attention unknown. Ask the reader to show Arc when archive checks need current attention. A folderless window cannot start sessions. New sessions use the window's first folder. Never treat a session from another repository as part of this window's scope.

Run `arc setups --window WINDOW_ID` before choosing settings. Use a returned setup key or explicit supported values. Preserve the requested provider, model, effort, and permissions. A loading catalog or unsupported setup refuses launch. Never substitute settings to bypass refusal.

## Select the command

Run `arc --help` for command sections. Run `arc COMMAND --help` for syntax, flags, output fields, refusals, and an example. Nested commands accept help too, including `arc label add --help` and `arc compact request --help`.

Start requires a regular UTF-8 prompt file, at most 48 KiB, with nonempty text that does not begin with a slash command. Omitted model, effort, and permissions retain provider defaults.

Omitted `--agent-run` or `--agent-run=false` keeps reader ownership and Prompt box continuation. A session the reader asked you to start keeps that ownership, even when it coordinates other agents or reports back. Bare `--agent-run` or `--agent-run=true` marks delegated work under Run by agents. Use it only for a session you choose for your own task, such as a worker or reviewer. Attribution alone establishes neither ownership nor authority. Use `--arc-dispatch` to record the requester for guarded follow-ups and supply the parent session's Dispatched link. Reader-owned dispatch receipts include `owned: true`.

## Interpret delivery

`accepted` means the prompt reached an agent. `accepted-with-errors` means the prompt reached an agent but naming or saved metadata failed. Report those errors without starting another session. Requested setup values do not establish observed native execution. Read recorded turns before claiming which model or effort ran.

`refused` means no accepted launch. A timeout, disconnect, malformed response, or missing acknowledgment leaves delivery unknown. Preserve the window, request ID, prompt, and settings. Never launch a replacement or switch transports after an unknown outcome.

Save a fresh `WINDOW_ID:UUID` before each new start, curation action, read acknowledgment, or follow-up. `WINDOW_ID` is the selected window's `hostId`. `UUID` is a fresh lowercase UUID. Pass that ID through `--request-id` on the first attempt. Start and curation accept an explicit identical-payload retry with that ID in the same activation. Arc retains results by ID and refuses conflicting payloads. A reload changes the activation and leaves the old outcome unknown. Never change the ID to retry. Do not retry automatically.

## Send a follow-up

Send only to a session that this session started with `arc start --arc-dispatch` in the same window activation. A reload of the window ends that relationship. Read the session first with `arc session SESSION_ID --turns 5 --window WINDOW_ID --json`. Write the follow-up from that reply's turns. Copy the reply's `observation` string unchanged into `--observation`. A reply without `observation` means Arc accepts no follow-up for that session now. The prompt file follows the start rules. Use the fresh request-ID rule from Interpret delivery.

Read the `status` field. `accepted` means the agent received the prompt, not that its work succeeded. `refused` means no prompt was sent, and `reason` says why. Each observation serves one follow-up attempt. It also goes stale when the reader gives that session or this one input through the panel, or when that session ends a turn or takes a follow-up. Read the session again and write the new follow-up from that reply. `unknown` means delivery is uncertain. Report it to the reader. A retry with the same request ID and prompt file returns the first result and sends nothing again. Never retry under a new request ID, start a replacement, or resume the session. Arc refuses later follow-ups to that session until the reader directs it in the panel, for example with a prompt, an answer, or Stop. A setting change alone does not lift that block.

Arc delivers through the session's existing process in that window and never resumes or forks a copy. It cannot prevent an independent resume outside that window. Arc judges idle state from Claude idle reports, Codex root turns, and the panel's queues and status. Work that none of these report stays invisible to that check.

## Mark requested turns read

Mark only sessions the reader explicitly asked you to mark read. Establish that bounded set from the request and exact scoped identities. A listing, an incidental lookup, or a status report grants no marking authority.

Check the selected window's `sessionRead` capability. Read acknowledgments work without a visible panel. Hidden attention remains unknown. A window without it does not support read writes. Report that limitation without switching windows or changing reader attention through another command.

For a supporting window, read each authorized session with `arc session SESSION_ID --turns 5 --window WINDOW_ID --json`. Read the delivered completed turns before acknowledging them. Copy `readObservation` unchanged, never the send-only `observation`. A reply without `readObservation` grants no read acknowledgment.

```text
arc read SESSION_ID --observation READ_OBSERVATION --request-id WINDOW_ID:UUID --window WINDOW_ID --json
```

Use `--dry-run` to check admission without saving. Use a different request ID for the later applied action. Preserve identical-payload retry rules from Interpret delivery. Report `applied`, `dry-run`, `refused`, or `unknown` exactly. Preserve the selected window and request ID after an unknown outcome.

Acknowledgment covers only the delivered completed projection. It does not establish full transcript consumption or complete history. Omitted and later work stays outside that acknowledgment. A changed source invalidates its acknowledgment, including an append. After a stale refusal, read again and use a fresh request ID for the new receipt. After an unknown outcome, retry only the identical payload with the same request ID. Never change the ID for that uncertainty retry. Marking read sends no prompt and changes no archive membership, label, or pin.

## Execute requested follow-ups

An explicit request to run follow-ups authorizes executing the named steps and choosing their session. A request for thoughts, a plan, or consultation grants no execution authority. Preserve phase-only restrictions and every implementation, review, request, token, and dollar limit. Compaction and session transfer renew none of them.

Continue in this session while its context serves the work. Native compaction during ongoing work does not end the task or require another invocation. Arc's after-turn compaction accepts one explicit saved continuation. Use the continuation form below for requested same-session work. Never queue that follow-up before compaction. The request to run follow-ups delegates compaction for this turn, subject to Request compaction of this session below.

Use at most one reader-owned successor when clean context serves the authorized next step. Follow this sequence only when Arc can preserve the required settings and durable state:

1. Save the handoff before launch. Retain the authorized steps, decisions, unresolved prerequisites, original run and session identities, candidate commits, worktree paths, and artifact locations. Retain consumed and remaining allocations, review rounds, spend reports, source ownership, cost windows, and unknown cost coverage. Record the single-successor allowance and its state. The successor inherits this ledger and cannot launch another successor under the same authorization.
2. Settle this session's background work before transferring task ownership. Read current reader input and queued work. If new input changes the assignment, reconcile it before launch. Arc start does not bind that read to launch, so it cannot guarantee a transfer free of intervening reader input.
3. Select the same provider, model, effort, permissions, labels, and pin from established session metadata and offered settings. Leave `--agent-run` omitted to preserve reader ownership. Preserve `--arc-dispatch` attribution. Select one completion route explicitly. `--completion manual` retains retrieval without an automatic parent callback. Use a supported callback route only when the task requires it, and retain its delivery state. Do not combine completion routes.
4. Put the handoff path and inherited limits in the regular prompt file. Apply Select a ready window and Interpret delivery. An accepted or uncertain launch consumes the single-successor allowance across the whole authorization. Never start a replacement after unknown delivery or `accepted-with-errors`. Do not retry a refusal automatically.
5. Save the returned session identity and delivery result immediately. Metadata saves follow initial prompt delivery, so acceptance alone does not confirm the name, labels, or pin. Confirm their saved values and report any mismatch. After acceptance, perform no further task work here. Under uncertainty, pause execution here until ownership is resolved. Preserve the request identity and all available evidence.

Keep this predecessor available after either accepted or uncertain transfer. Arc archive has no reader-revision guard and leaves queued prompts available for delivery. A last read or dry run cannot establish safe automatic self-archive. Automatic archival requires product support beyond these commands. Do not use `--force` to bypass this limit. Report the successor identity or delivery uncertainty and retain any new reader input for reconciliation.

When execution cannot proceed, report the concrete blocker and durable handoff location. Supply a manual prompt only as a fallback. Do not replace an authorized execution request with instructions for the reader to copy.

## Request compaction of this session

Request compaction only when the reader explicitly delegates it for this turn, including through Execute requested follow-ups. Save the handoff the reader asked for first. Only the main agent can request compaction. Arc refuses a subagent's request. Inherited environment, session IDs, and archived prompts supply no authority.

Run one foreground command in this exact form. Write the window `hostId` and a fresh lowercase UUID as literal text:

```text
arc compact request --self --after-turn --request-id WINDOW_ID:UUID --window WINDOW_ID --json
```

Both window values are the `hostId` of the window that hosts this session. `ARC_WINDOW` names it when supplied. Claude agents run the command with the Bash tool. Arc does not admit it from the Claude PowerShell tool. Codex agents run the bare command as a foreground shell command. Codex adds its own PowerShell wrapper on Windows, so never write a wrapper. Do not use shell substitutions, command chains, background execution, or alternate payload transports.

Arc admits the request only while this tool call runs in a session that this window's panel holds. The session must have no open asks, no queued reader prompts, and no reader action since this turn's prompt. An answer to one of this turn's asks given before the request does not block admission. Any reader action after admission, including an answer, cancels the request. Each turn holds one pending request. Each request ID is admitted once in a window activation.

Read the `state` field of the result. The command returns at once. After `queued`, finish the successful final response. Report the request in the past tense: "I requested compaction after this turn." Arc checks delivery conditions after the turn. Reader intervention can cancel unsubmitted compaction after the last observation, including while you write the final response. Never promise future delivery from `queued` or a status check.

For authorized same-session follow-up work, save the exact next-turn instruction in a regular UTF-8 file. Include the durable handoff location and inherited execution limits. Use 1 through 8192 bytes. Preserve its whitespace. Exclude a byte-order mark, NUL, invalid UTF-8, and a leading slash command. Arc sends this agent-authored instruction as one ordinary next-turn prompt without adding reader comments or files.

Compute the lowercase digest before the foreground request. On Windows:

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath 'C:/Windows/Temp/arc-next.txt').Hash.ToLowerInvariant()
```

On Linux:

```sh
sha256sum /tmp/arc-next.txt
```

On macOS:

```sh
shasum -a 256 /tmp/arc-next.txt
```

Copy only the 64-character digest into this exact command. Windows requires the drive-absolute form shown. POSIX requires a path beginning `/`. Use forward slashes and single quotes. Filenames accept ASCII letters, digits, spaces, underscore, period, hyphen, parentheses, and slash. Dot segments, repeated slashes, and shell expansion refuse.

```text
arc compact request --self --after-turn --continuation-file 'C:/Windows/Temp/arc-next.txt' --continuation-sha256 SHA256 --request-id WINDOW_ID:UUID --window WINDOW_ID --json
```

Admission consumes this reader assignment's single continuation allowance, including cancellation or failure. A different request ID never returns it. Finish the requesting turn successfully after admission. Compaction completion and continuation acceptance are separate observations. The continuation states are `waiting`, `preparing`, `attempting`, `accepted`, `cancelled`, `refused`, and `uncertain`. Acceptance confirms prompt acknowledgment rather than successful task completion. Never retry uncertain input, reopen a child, or chain another continuation without a new explicit reader submission.

After window reload, select the current window for the same workspace. Keep the original request ID for status. Status returns saved text only when the current scope admits the exact original source. Restart recovery cancels unattempted continuation and marks possible input uncertain. It never restarts work.

Observe a known request without submitting work:

```text
arc compact status --request-id ORIGINAL_WINDOW:UUID --window CURRENT_WINDOW --json
```

`ORIGINAL_WINDOW` identifies the admitting activation. `CURRENT_WINDOW` identifies the selected current window for the same workspace.

The `state` field names one outcome:

- `queued`: the request waits for this turn to succeed, a saved final response, and delivery checks.
- `started`: the agent accepted the compaction.
- `completed`: the agent finished the compaction.
- `cancelled`: a reader action, a session change, the session leaving the window's scope, the agent process ending, the window closing, or the 15-minute deadline stopped the request before Arc sent it.
- `refused`: Arc did not admit the request, or did not send it. A window without compaction support also refuses.
- `failed`: the requesting tool or turn failed, the final response was not saved, or the agent refused or failed the compaction.
- `uncertain`: admission or the compaction outcome is not known yet. Arc also reports this right after it sends the compaction, until native evidence arrives. When the request command returns it, report it and finish the turn. Never resend, change transport, reopen the session, or fork the session.
- `unavailable`: the window holds no record of this request ID, or the window did not answer the status read.

Start and curation retry advice does not apply to compaction. Follow-ups follow their own rules in Send a follow-up.

## Report session links

Report known sessions as named Markdown links:

```markdown
[name](arc-session:<id>)
```

Link only destinations established in the window scope containing the invoking conversation. When supplied, `ARC_WINDOW` identifies that window. A successful operation with explicit `--window` does not establish the invoking window. Keep another or unestablished window's sessions as plain text with their known names and IDs. Never invent an ID or link an unverified destination. Never substitute a source hash, transcript path, short reference, or guess.

For lookup reports, use `arc sessions` rows with exact, nonnull `id` and `name`, neither listed in `truncated`, and `ambiguous: false`. Keep incomplete identities and ambiguous rows as plain text. A detailed `arc session` read returns `id`, without a session name. Pair it with an exact, untruncated name from an authorized source before linking.

For an accepted start, use the requested name and returned `sessionId`. If naming failed, identify the name as requested and report the error. Do not claim that Arc saved it.

Backslash-escape every ASCII punctuation character in the label to preserve the displayed name. The name `Plan **[draft](notes)**` becomes the label `Plan \*\*\[draft\]\(notes\)\*\*`. Percent-encode the raw ID once using UTF-8. Encode every character outside ASCII letters, digits, hyphen, underscore, period, and tilde. One decode must restore the exact returned ID without normalization. The raw ID `literal%2f` becomes `arc-session:literal%252f`. Keep parser-rejected IDs as plain text, including empty IDs and IDs containing whitespace, control characters, `/`, `\`, `?`, or `#`.

These links require Arc's response-link support and open only inside its live extension panel. CLI JSON versions do not establish that support. Exported responses display only the label, without session navigation. Response links complement the existing Dispatched link. Preserve its `ARC_DISPATCH_SESSION` receipt, attribution, and delegated cost accounting.

## Collect data for a report

Use `arc collect --window WINDOW_ID --query QUERY --json` for scoped pages. Add `--turns 1-20` for recent turns. Run `arc collect --help` for lower request and admission limits. Keep report selection and interpretation with the caller. Costs require separate commands.

Use `listing.usablePages` and `rows` for the accepted traversal. `pages` also retain abandoned and unavailable observations. Keep traversal end, coverage, freshness, and turn outcomes separate. A completed outcome preserves the raw reply's partial, stale, or unparsed state. Report skipped and failed rows explicitly. Matching identities establish no physical source continuity. Collection leaves read receipts unacknowledged and changes no session state.

## Manage a bounded set

Use complete, nonnull session IDs from the selected window's scoped listing. Never abbreviate an ID for a read, acknowledgment, follow-up, or curation command. Query shorthand does not establish an exact action target. Resolve incomplete or ambiguous listing identities before acting.

1. List every page. Pass each page's `next` unchanged to `--cursor` until `next` is `null`. Report the last page's `coverage` and `freshness`. When Arc refuses the cursor, discard the rows from that listing and restart once without `--cursor`. Listing changes no state, so retry the same cursor once after a timeout or an unavailable catalog. Then rank known Needs input and unread work before idle sessions. Preserve unknown, stale, and incomplete facts.
2. Read each session you started before describing its result. Bounded reads leave reader attention unchanged.
3. Apply only requested labels and pins. Use `--dry-run` before curation. It checks window readiness, a unique scoped session ID, and applicable archive or pin refusals without writing. A dry run does not check whether a later save will succeed. Give the real action a fresh request ID because removing `--dry-run` changes the payload.
4. Archive only authorized sessions. Running, Needs input, and completed unread sessions refuse archive without `--force`. So does a session with hidden or unavailable state. Pass `--force` only with explicit reader authority. An explicit request such as "archive my finished sessions" grants `--force` authority for completed unread members of the requested bounded set. Establish that set from the reader's request and scoped session identities. That authority excludes running, waiting, Needs input, hidden state, background work, and unavailable state. For a running, Needs input, hidden, or unavailable session, require the reader's explicit request to archive that session. A session that Arc lists as `subagents` or `background` refuses archive even with `--force`. Arc lists that status while it has no record that the work ended, and that can outlast a crashed or killed process. Report that refusal to the reader instead of retrying it. Tell the reader that once they confirm the work ended, they can archive the session from Arc's session list. Arc cannot list background work in a session whose state is unavailable. Before you force that archive, ask the reader to show Arc, then list the session again. A row that still reads `unknown` with Arc shown can hide a resumed subagent or a long background command. Before you force it, ask the reader whether the session still runs a subagent or a long background command. Arc's session list shows a resumed subagent, so the reader can check the list for one. The list stops counting a background command one hour after the command starts, so it cannot show a long command. Archive saves the archive membership at once, removes the pin, and keeps the current turn and any open question. For a session Arc hosts, retirement waits for the turn, open asks, unresolved background work, and other retirement holds to settle. Unknown background completion keeps the process retained. These retirement checks do not make archive safe against intervening reader input or queued prompts. Never archive a session, your own included, while it has background work running. Archive your own session only as your last action.
5. End with sessions that need the reader, accepted session identities, and any uncertain outcomes. Do not start ongoing monitoring.

Commands curate one session at a time. Unarchive preserves labels and reader state and leaves the session unpinned. Cost is a list-price estimate. Missing request coverage leaves the full cost unknown.

## Report costs

Arc supplies raw data. Assemble any report yourself. Arc has no report dashboard, label accounting, or report schedule.

1. List every page. Read each row once by its exact path: `arc cost PATH --since START --until END --by-model --json`. Cost takes no `--window`. It reads transcripts from disk and searches every project, not the window scope.
2. Take each row's `parent` subtotal. Add each `children[]` entry whose `file` is not a listed `path`, once across the whole report. A child transcript that is also a listed row counts only through its own row.
3. Report a row whose `path` is `null`, or whose cost read fails, as an explicit unknown cost. Preserve null full totals, known priced subtotals, legacy estimates, model gaps, and request coverage.
4. Use a half-open interval of request times. Pass `START` and `END` as ISO 8601 times with an explicit offset, for example `2026-10-01T00:00:00-07:00`. Include sessions with requests in the interval, even when they started earlier. Do not select sessions by last activity or creation date alone.
5. Treat labels as the reader's current labels, not historical labels. Keep unlabelled work visible. Choose a rule for sessions with more than one label, and choose whether a child's cost joins its parent's labels. State both rules in the report. List-price estimates are not subscription charges.
