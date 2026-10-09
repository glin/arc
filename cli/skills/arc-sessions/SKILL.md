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
| List scoped sessions and attention | `arc sessions --window WINDOW_ID --json` |
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

1. List sessions once. Rank known Needs input and unread work before idle sessions. Preserve unknown, stale, and incomplete facts.
2. Read each session you started before describing its result. Bounded reads leave reader attention unchanged.
3. Apply only requested labels and pins. Use `--dry-run` on curation commands to inspect an action without writing.
4. Archive only authorized completed sessions. Running and Needs input sessions always refuse archive. Completed unread sessions require explicit `--force` authority. Hidden or unavailable attention refuses archive.
5. End with sessions that need the reader, accepted session identities, and any uncertain outcomes. Do not start ongoing monitoring.

Commands curate one session at a time. Unarchive preserves labels and reader state and leaves the session unpinned. Cost is a list-price estimate. Missing coverage leaves the full cost unknown.
