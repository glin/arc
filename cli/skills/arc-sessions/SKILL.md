---
name: arc-sessions
description: 'Manage scoped Claude Code and Codex sessions in a running Arc window. Use when asked for starts, progress checks, read acknowledgments, explicit reader messages, parent follow-ups, labels, pins, archive, session links, compaction, and fresh-session transfers. Excludes terminal-only launches and automatic supervision.'
---

# Arc sessions

Use Arc for session work the reader requested. Start only the authorized work. Use `--json` when interpreting command fields.

## Select a ready window

Pass the selected window's `hostId` through `--window` on every session command. `--window` overrides `ARC_WINDOW`. Without either, run `arc windows --json` and select by folders and `hostId`. Scope covers only that window's folders. Never substitute settings to bypass a refusal. Preserve the requested provider, model, effort, and permissions.

- Read [windows.md](windows.md) when discovery returns an empty or incomplete list, when a command refuses the window, or after a window reload.
- Read [start.md](start.md) before starting a session.

## Select the command

`arc run` starts a standalone session without a window, such as a workflow's worker or reviewer. Run `arc run --help` before a standalone launch. Read its result with `arc dispatch status` and `arc dispatch result`.

Omitted `--agent-run` or `--agent-run=false` keeps reader ownership and Prompt box continuation. Reader-requested sessions keep that ownership, including coordinators. Bare `--agent-run` or `--agent-run=true` marks Run by agents. Use it only for work you choose, such as workers or reviewers. Attribution grants neither ownership nor authority.

Pass `--arc-dispatch` when this session will send follow-ups to the session it starts. An observed parent follow-up refuses without it. It also supplies the parent session's Dispatched link.

## Interpret delivery

`accepted` means the prompt reached an agent. `accepted-with-errors` means the same, but naming or saved metadata failed. Report those errors without starting another session.

After either result, link each new session in the reply as [links.md](links.md) defines. Pass `--name` on every start, because the link label is the requested name. Where links.md forbids a link, say why.

`refused` means no accepted launch. A timeout, disconnect, malformed response, or missing acknowledgment leaves delivery unknown. Preserve the window, request ID, prompt, and settings. Never launch a replacement, resume the session, or switch transports after an unknown outcome.

Save a fresh `WINDOW_ID:UUID` before each start, curation, read acknowledgment, or follow-up. `WINDOW_ID` is the selected window's `hostId`. `UUID` is a fresh lowercase UUID. Pass that ID through `--request-id` on the first attempt. Arc retains results by ID and refuses conflicting payloads. A reload changes activation and leaves the old outcome unknown. Never change the ID to retry. Do not retry automatically.

## Send a message or follow-up

Send a literal message to another running session only if the reader explicitly names its destination and intended message. Omit `--observation` for this queue form. Plans, other agents, and channel access grant no permission.

Autonomous follow-ups require a session this session started with `arc start --arc-dispatch` in the same activation. Supply its observation. Read [followup.md](followup.md) before either form.

## Execute requested follow-ups

An explicit request to run follow-ups authorizes the named steps and their session selection. A request for thoughts, a plan, or consultation grants no execution authority. Preserve phase-only restrictions and every implementation, review, request, token, and dollar limit. Compaction and session transfer renew none of them. A request to run follow-ups delegates compaction for this turn, under the rules in [compaction.md](compaction.md).

Continue in this session while its context serves the work. Native compaction during ongoing work does not end the task. Read [successor.md](successor.md) before transferring work to a fresh session.

If execution is blocked, report the concrete blocker and durable handoff location. Never substitute a copyable prompt for execution.

## List sessions

Run `arc sessions --window WINDOW_ID --json`. Pass each page's `next` unchanged to `--cursor` until `next` is `null`. Add `-is:archived` to the query unless the request covers archived sessions. Report the last page's `coverage` and `freshness`. Read each session you started before reporting its result, model, or effort.

## Manage a bounded set

Use complete, nonnull session IDs from the selected window's scoped listing. Never abbreviate action target IDs. Resolve incomplete or ambiguous listing identities before acting. Read [archive.md](archive.md) before labelling, pinning, or archiving a set.

- Apply only requested labels and pins. Archive only authorized sessions.
- Run every curation with `--dry-run` first, except archiving this session. It checks window readiness, a unique scoped session ID, and applicable archive or pin refusals without writing. Give the real action a fresh request ID. Removing `--dry-run` changes the payload.
- Running, Needs input, completed unread, hidden, and unavailable sessions refuse archive without `--force`. Pass `--force` only with explicit reader authority. A request such as "archive my finished sessions" grants `--force` for the completed members of that set. Completion needs a fresh scoped listing with `facts: current` and `runStatus: done` or `none`. The grant excludes running, waiting, Needs input, background, stale, unknown, and unavailable sessions. Each needs the reader's explicit request to archive it.
- Arc refuses to archive a session listed as `subagents` or `background`, even with `--force`.
- End with sessions that need the reader, accepted session identities, and any uncertain outcomes. Do not start ongoing monitoring.

### Archive this session

Archive this session only at the reader's request. Skip the dry run. The request grants `--force` for this session and no other. Get the session ID from `CLAUDE_CODE_SESSION_ID` in Claude or `CODEX_THREAD_ID` in Codex. Finish every other task and end all background work first. Never archive any session with background work running. Then run this as your last tool call. Write the session ID, window ID and UUID as literal text.

```text
arc archive OWN_ID --force --window WINDOW_ID --request-id WINDOW_ID:UUID --json
```

## Reference files

- Read [read.md](read.md) before marking sessions read.
- Read [collect.md](collect.md) before collecting scoped data for a report.
- Read [compaction.md](compaction.md) before requesting compaction of this session, including same-session continuation.
- Read [links.md](links.md) before linking to a session in a reply.
- Read [costs.md](costs.md) before reporting session costs.
