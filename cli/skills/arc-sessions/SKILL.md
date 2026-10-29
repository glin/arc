---
name: arc-sessions
description: 'Use when asked to manage Arc sessions, dispatch or message agents, change labels, pins, archives or filters, estimate API costs, compact sessions, or transfer work. Includes standalone launches. Excludes automatic supervision.'
---

# Arc sessions

Use Arc for work the reader requested. Start only authorized work. Use `--json` for command results.

## Select a ready window

For window commands, run `arc windows --json` and select by folders and `hostId` when no window is established. Pass that `hostId` through `--window`. Scope covers only that window's folders. Preserve the requested provider, model, effort, service tier, and permissions. Never substitute settings to bypass a refusal.

- Read [windows.md](windows.md) when discovery returns an empty or incomplete list, when a command refuses the window, or after a window reload.

## Select the command

- Use `arc start` for a window session. Read [start.md](start.md) first.
- Use `arc run` without a window. Read the service-tier guidance in [start.md](start.md). Run `arc run claude --help` or `arc run codex --help` first. Retrieve results with `arc dispatch status` and `arc dispatch result`.
- Use `arc filter QUERY` only when asked to change the visible Session list query. `arc filter --clear` restores All sessions. Listing with `arc sessions --query` leaves the panel unchanged.
- Use `arc cost` for saved session estimates, without a window. Read [costs.md](costs.md) before reporting costs.

Omitted or false `--agent-run` keeps reader ownership and Prompt box continuation. Keep it for reader-requested sessions, including coordinators. Bare or true `--agent-run` marks Run by agents. Use it for your workers or reviewers. Attribution grants neither ownership nor authority.

Pass `--arc-dispatch` to `arc start` for parent follow-ups and the Dispatched link. Observed follow-ups refuse without it.

## Interpret delivery

`accepted` means the prompt reached an agent. `accepted-with-errors` means the same, with metadata errors or uncertain saves. Report those errors without starting another session.

After either result, report each new session as [links.md](links.md) defines. Pass `--name` on every start for its link label.

`refused` means no accepted launch. A timeout, disconnect, malformed response, or missing acknowledgment leaves delivery unknown. Preserve the window, request ID, prompt, and settings. Never launch a replacement, resume the session, or switch transports after an unknown outcome.

Save a fresh `WINDOW_ID:UUID` before each start, curation, read acknowledgment, or follow-up. `WINDOW_ID` is the selected window's `hostId`. `UUID` is a fresh lowercase UUID. Pass that ID through `--request-id` on the first attempt. Arc retains results by ID and refuses conflicting payloads. A reload changes activation and leaves the old outcome unknown. Never change the ID to retry. Do not retry automatically.

## Send a message or follow-up

Send a literal message to another running session only if the reader explicitly names its destination and intended message. Ordinary sending reaches eligible current work. Use `--queue` or `-q` for intentional next-turn delivery. Plans, other agents, and channel access grant no permission.

Autonomous follow-ups require a session this session started with `arc start PROVIDER --arc-dispatch` in the same activation. Supply its observation. Read [followup.md](followup.md) before either form.

## Execute requested follow-ups

An explicit request to run follow-ups authorizes the named steps and their session selection. Thoughts, planning, and consultation grant no execution authority. Preserve phase restrictions and implementation, review, request, token, and dollar limits. Compaction and session transfer renew none of them.

Continue in this session while its context serves the work. Native compaction during ongoing work does not end the task. Read [successor.md](successor.md) before transferring work to a fresh session.

Report blockers and the durable handoff location. Never substitute a copyable prompt for authorized execution.

## List sessions

Run `arc sessions --window WINDOW_ID --json`. Follow each `next` unchanged with `--cursor` until `null`. Add `-is:archived` unless the request includes archived sessions. Report the last page's `coverage` and `freshness`. Read each session you started before reporting its result, model, or effort.

## Manage a bounded set

Use complete, nonnull IDs from the scoped listing. Resolve incomplete or ambiguous identities before acting. Read [archive.md](archive.md) before changing labels, pins, or archive state.

- Apply only requested labels and pins. Archive only authorized sessions.
- Run each curation with `--dry-run` first, except archiving this session. Give the real action a fresh request ID.
- Pass `--force` only with reader authority, including the completed-set grant in archive.md.
- Arc refuses to archive a session listed as `subagents` or `background`, even with `--force`.
- End with sessions that need the reader, accepted session identities, and any uncertain outcomes. Do not start ongoing monitoring.

### Archive this session

Archive this session only at the reader's request, as your last tool call. Follow archive.md after finishing all tasks and background work.

## Reference files

- Read [read.md](read.md) before marking sessions read.
- Read [collect.md](collect.md) before collecting scoped data for a report.
- Read [compaction.md](compaction.md) before requesting compaction of this session, including same-session continuation.
