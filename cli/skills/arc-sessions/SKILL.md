---
name: arc-sessions
description: 'Read and manage scoped Claude Code and Codex sessions through a running Arc window. Use when asked to start sessions in Arc, inspect progress, mark requested sessions read, send a follow-up to a session this session started, label, pin or archive sessions, link to a session in a reply, compact this session after the turn, or transfer requested follow-up work to a fresh session. Excludes terminal-only launches and automatic supervision.'
---

# Arc sessions

Use Arc for session work the reader requested. Start only the authorized work.

Use `--json` when interpreting command fields.

Treat tag as a natural-language synonym for label. Keep `arc label`, `--label`, and `label:` syntax.

## Select a ready window

If `ARC_WINDOW` is set, it holds the window's `hostId`. Pass its value through `--window` on every session command and skip `arc windows` discovery. With `ARC_WINDOW` set, run `arc windows --json` only when a command refuses the window. Also run it when the task starts a session, because start needs `scopeReady`, `panelReady`, and setups. Without `ARC_WINDOW`, run `arc windows --json` and select the intended window by its folders and `hostId`. Pass that ID through `--window` on every session command. `--window` overrides `ARC_WINDOW`. Without either, integrated terminals select their current owning window. External shells require exactly one live window. Automatic selection requires complete discovery. Recognized integrated terminals also require conclusive terminal membership. Remote integrated terminals require explicit selection. Reload older Arc windows or select explicitly when ownership is unavailable.

After reload or reconnection, refresh discovery before a new operation. Explicitly reselect the intended folders and their current `hostId`. A stale explicit `--window` or inherited `ARC_WINDOW` still selects the old activation. Never transfer an old request ID or follow-up ownership to the new activation. Preserve uncertain outcomes under Interpret delivery before starting new work.

An empty list with `complete: false` does not establish a permission failure. Optional `diagnostics` report only observed `ENOENT`, `EACCES`, or `EPERM`, with a `registry` or `connection` stage. An observed `EACCES` or `EPERM` requires authorized local access to window details or the local socket. Report the limitation when the current permissions deny that access. Never bypass the permission policy or assume an editor restart repairs access.

Check `scopeReady` and `panelReady` before starting. A hidden panel leaves live attention unknown. Apply Manage a bounded set for archive authority when the panel is hidden. A folderless window cannot start sessions. New sessions use the window's first folder. Never treat a session from another repository as part of this window's scope.

Run `arc setups --window WINDOW_ID` before choosing settings. Use a returned setup key or explicit supported values. Preserve the requested provider, model, effort, and permissions. A loading catalog or unsupported setup refuses launch. Never substitute settings to bypass refusal.

## Select the command

Run `arc --help` for command sections. Run `arc COMMAND --help` for syntax, flags, results, restrictions, and an example. Nested commands accept help too, including `arc label add --help` and `arc compact request --help`.

This skill covers sessions in an Arc window. `arc run` starts a standalone session without a window, such as a workflow's worker or reviewer. Run `arc run --help` before a standalone launch. Read its result with `arc dispatch status` and `arc dispatch result`.

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

## Execute requested follow-ups

An explicit request to run follow-ups authorizes executing the named steps and choosing their session. A request for thoughts, a plan, or consultation grants no execution authority. Preserve phase-only restrictions and every implementation, review, request, token, and dollar limit. Compaction and session transfer renew none of them.

Continue in this session while its context serves the work. Native compaction during ongoing work does not end the task or require another invocation. Arc's after-turn compaction accepts one explicit saved continuation. Use the continuation form in [compaction.md](compaction.md) for requested same-session work. Never queue that follow-up before compaction. The request to run follow-ups delegates compaction for this turn, subject to the rules in that file.

Use at most one reader-owned successor when clean context serves the authorized next step. Follow this sequence only when Arc can preserve the required settings and durable state:

1. Save the handoff before launch. Retain the authorized steps, decisions, unresolved prerequisites, original run and session identities, candidate commits, worktree paths, and artifact locations. Retain consumed and remaining allocations, review rounds, spend reports, source ownership, cost windows, and unknown cost coverage. Record the single-successor allowance and its state. The successor inherits this ledger and cannot launch another successor under the same authorization.
2. Settle this session's background work before transferring task ownership. Read current reader input and queued work. If new input changes the assignment, reconcile it before launch. Arc start does not bind that read to launch, so it cannot guarantee a transfer free of intervening reader input.
3. Select the same provider, model, effort, permissions, labels, and pin from established session metadata and offered settings. Leave `--agent-run` omitted to preserve reader ownership. Preserve `--arc-dispatch` attribution. Select one completion route explicitly. `--completion manual` retains retrieval. `--completion wait` selects waited completion, which `arc dispatch wait` observes. No route delivers a callback into this session. Do not combine completion routes.
4. Put the handoff path and inherited limits in the regular prompt file. Apply Select a ready window and Interpret delivery. An accepted or uncertain launch consumes the single-successor allowance across the whole authorization. Never start a replacement after unknown delivery or `accepted-with-errors`. Do not retry a refusal automatically.
5. Save the returned session identity and delivery result immediately. Metadata saves follow initial prompt delivery, so acceptance alone does not confirm the name, labels, or pin. Confirm their saved values and report any mismatch. After acceptance, perform no further task work here. Under uncertainty, pause execution here until ownership is resolved. Preserve the request identity and all available evidence.

Keep this predecessor available after either accepted or uncertain transfer. Arc archive has no reader-revision guard and leaves queued prompts available for delivery. A last read or dry run cannot establish safe automatic self-archive. Automatic archival requires product support beyond these commands. Do not use `--force` to bypass this limit. A reader's direct request to archive this session is separate and follows Archive this session. Report the successor identity or delivery uncertainty and retain any new reader input for reconciliation.

When execution cannot proceed, report the concrete blocker and durable handoff location. Supply a manual prompt only as a fallback. Do not replace an authorized execution request with instructions for the reader to copy.

## Manage a bounded set

Use complete, nonnull session IDs from the selected window's scoped listing. Never abbreviate an ID for a read, acknowledgment, follow-up, or curation command. Query shorthand does not establish an exact action target. Resolve incomplete or ambiguous listing identities before acting.

1. Start with `arc sessions --window WINDOW_ID --json`. List every page. Add `-is:archived` to the query unless the request covers archived sessions. Pass each page's `next` unchanged to `--cursor` until `next` is `null`. Report the last page's `coverage` and `freshness`. When Arc refuses the cursor, discard the rows from that listing and restart once without `--cursor`. Listing changes no state, so retry the same cursor once after a timeout or an unavailable catalog. Then rank known Needs input and unread work before idle sessions. Preserve unknown, stale, and incomplete facts.
2. Read each session you started before describing its result. Bounded reads leave reader attention unchanged.
3. Apply only requested labels and pins. Use `--dry-run` before curation, except to archive your own session under Archive this session. It checks window readiness, a unique scoped session ID, and applicable archive or pin refusals without writing. A dry run does not check whether a later save will succeed. Give the real action a fresh request ID because removing `--dry-run` changes the payload.
4. Archive only authorized sessions. Running, Needs input, and completed unread sessions refuse archive without `--force`. So does a session with hidden or unavailable state. Pass `--force` only with explicit reader authority. An explicit request such as "archive my finished sessions" grants background archive authority for completed members of the requested bounded set. Establish that set from the reader's request and scoped session identities. Establish completion or inactivity from a fresh scoped listing with `facts: current` and `runStatus: done` or `runStatus: none`. Completed turns from `arc session` alone do not establish current run status. This authority includes `--force` for completed unread sessions and hidden attention when that evidence establishes completion. Do not ask the reader to show Arc when this evidence establishes completion. That authority excludes running, waiting, Needs input, background work, and stale, unknown, or unavailable completion. For an excluded session, require the reader's explicit request to archive that session. A session that Arc lists as `subagents` or `background` refuses archive even with `--force`. Arc lists that status while it has no record that the work ended, and that can outlast a crashed or killed process. Report that refusal to the reader instead of retrying it. Tell the reader that once they confirm the work ended, they can archive the session from Arc's session list. Arc cannot list background work in a session whose state is unavailable. If completion remains unavailable, ask the reader to show Arc and list the session again. A row that still reads `unknown` with Arc shown can hide a resumed subagent or a long background command. Before you force it, ask the reader whether the session still runs a subagent or a long background command. Arc's session list shows a resumed subagent, so the reader can check the list for one. The list stops counting a background command one hour after the command starts, so it cannot show a long command. Archive saves the archive membership at once, removes the pin, and keeps the current turn and any open question. For a session Arc hosts, retirement waits for the turn, open asks, unresolved background work, and other retirement holds to settle. Unknown background completion keeps the process retained. These retirement checks do not make archive safe against intervening reader input or queued prompts. Never archive a session, your own included, while it has background work running. Archive your own session only as your last action, as Archive this session describes.
5. End with sessions that need the reader, accepted session identities, and any uncertain outcomes. Do not start ongoing monitoring.

Commands curate one session at a time. Unarchive preserves labels and reader state and leaves the session unpinned. Cost is a list-price estimate. Missing request coverage leaves the full cost unknown.

### Archive this session

Archive this session only when the reader asks you to archive it. Skip the dry run. The request grants `--force` for this session and no other. Learn the session ID from the `CLAUDE_CODE_SESSION_ID` variable in Claude or the `CODEX_THREAD_ID` variable in Codex. Finish every other task and end all background work first. Then run this as your last tool call, with the three IDs written as literal text. Write the final response after it returns.

```text
arc archive OWN_ID --force --window WINDOW_ID --request-id WINDOW_ID:UUID --json
```

## Reference files

- Read [read.md](read.md) before marking sessions read.
- Read [collect.md](collect.md) before collecting scoped data for a report.
- Read [compaction.md](compaction.md) before requesting compaction of this session.
- Read [links.md](links.md) before linking to a session in a reply.
- Read [costs.md](costs.md) before reporting session costs.
