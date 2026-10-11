---
name: arc-sessions
description: 'Read and manage scoped Claude Code and Codex sessions through a running Arc window. Use when the user asks to start sessions in Arc, inspect session progress, label or pin sessions, or archive completed work. Excludes terminal-only launches and automatic ongoing supervision.'
---

# Arc sessions

Use Arc for session work the reader requested. Start only the authorized work. Report each accepted session's name and ID. Include its existing Dispatched link when available. Never invent a session URL.

## Select a ready window

Run `arc windows --json`. Select the intended window by its folders and `hostId`. Pass that ID through `--window` on every session command. `--window` overrides `ARC_WINDOW`. Without either, Arc requires exactly one live window and complete discovery.

Check `scopeReady` and `panelReady` before starting. A hidden panel leaves live attention unknown. Ask the reader to show Arc when archive checks need current attention. A folderless window cannot start sessions. New sessions use the window's first folder. Never treat a session from another repository as part of this window's scope.

Run `arc setups --window WINDOW_ID` before choosing settings. Use a returned setup key or explicit supported values. Preserve the requested provider, model, effort, and permissions. A loading catalog or unsupported setup refuses launch. Never substitute settings to bypass refusal.

## Select the command

| Reader job | Command |
| --- | --- |
| List one page of scoped sessions and attention | `arc sessions --window WINDOW_ID --json`, then add `--cursor NEXT` for each later page |
| Read recent turns without marking them read | `arc session SESSION_ID --turns 5 --window WINDOW_ID --json` |
| List offered setups | `arc setups --window WINDOW_ID` |
| Start requested work | `arc start --window WINDOW_ID --setup SETUP_KEY --prompt-file PROMPT_PATH --untagged --name NAME --arc-dispatch` |
| Add or remove a reader label | `arc label add SESSION_ID --label LABEL --window WINDOW_ID` or `arc label remove SESSION_ID --label LABEL --window WINDOW_ID` |
| Pin or unpin a session | `arc pin SESSION_ID --window WINDOW_ID` or `arc unpin SESSION_ID --window WINDOW_ID` |
| Archive or unarchive completed work | `arc archive SESSION_ID --window WINDOW_ID` or `arc unarchive SESSION_ID --window WINDOW_ID` |
| Estimate saved session cost | `arc cost SESSION_ID --by-model` |

Start requires a regular UTF-8 prompt file, at most 48 KiB, with nonempty text that does not begin with a slash command. Explicit settings use `--provider claude|codex`, `--model`, `--effort`, and `--permissions` instead of `--setup`. Omitted values retain provider defaults. Repeat `--label` for initial labels. Use `--pinned` for an initial pin.

Choose exactly one classification. `--untagged` marks work the reader asked for and preserves prompt-box continuation. `--agent-run` marks delegated work under Run by agents. Attribution alone establishes neither ownership nor authority. `--arc-dispatch` adds a receipt that supplies the parent session's Dispatched link.

## Interpret delivery

`accepted` means the prompt reached an agent. `accepted-with-errors` means the prompt reached an agent but naming or saved metadata failed. Report those errors without starting another session. Requested setup values do not establish observed native execution. Read recorded turns before claiming which model or effort ran.

`refused` means no accepted launch. A timeout, disconnect, malformed response, or missing acknowledgment leaves delivery unknown. Preserve the window, request ID, prompt, and settings. Never launch a replacement or switch transports after an unknown outcome.

An explicit identical-payload retry uses the same `--request-id` in the same activation. Arc retains results by ID and refuses conflicting payloads. A reload changes the activation and leaves the old outcome unknown. Never change the ID to retry. Do not retry automatically.

## Manage a bounded set

1. List every page. Pass each page's `next` unchanged to `--cursor` until `next` is `null`. Report the last page's `coverage` and `freshness`. When Arc refuses the cursor, discard the rows from that listing and restart once without `--cursor`. Listing changes no state, so retry the same cursor once after a timeout or an unavailable catalog. Then rank known Needs input and unread work before idle sessions. Preserve unknown, stale, and incomplete facts.
2. Read each session you started before describing its result. Bounded reads leave reader attention unchanged.
3. Apply only requested labels and pins. Use `--dry-run` on curation commands to inspect an action without writing.
4. Archive only authorized completed sessions. Running and Needs input sessions always refuse archive. Completed unread sessions require explicit `--force` authority. Hidden or unavailable attention refuses archive.
5. End with sessions that need the reader, accepted session identities, and any uncertain outcomes. Do not start ongoing monitoring.

Commands curate one session at a time. Unarchive preserves labels and reader state and leaves the session unpinned. Cost is a list-price estimate. Missing request coverage leaves the full cost unknown.

## Report costs

Arc supplies raw data. Assemble any report yourself. Arc has no report dashboard, label accounting, or report schedule.

1. List every page. Read each row once by its exact path: `arc cost PATH --since START --until END --by-model --json`. Cost takes no `--window`. It reads transcripts from disk and searches every project, not the window scope.
2. Take each row's `parent` subtotal. Add each `children[]` entry whose `file` is not a listed `path`, once across the whole report. A child transcript that is also a listed row counts only through its own row.
3. Report a row whose `path` is `null`, or whose cost read fails, as an explicit unknown cost. Preserve null full totals, known priced subtotals, legacy estimates, model gaps, and request coverage.
4. Use a half-open interval of request times. Pass `START` and `END` as ISO 8601 times with an explicit offset, for example `2026-10-01T00:00:00-07:00`. Include sessions with requests in the interval, even when they started earlier. Do not select sessions by last activity or creation date alone.
5. Treat labels as the reader's current labels, not historical labels. Keep unlabelled work visible. Choose a rule for sessions with more than one label, and choose whether a child's cost joins its parent's labels. State both rules in the report. List-price estimates are not subscription charges.
