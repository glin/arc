# Curate a bounded set

Read this before changing labels, pins, or archive state.

1. Start with `arc sessions --window WINDOW_ID --json`. List every page as [List sessions](SKILL.md#list-sessions) describes. When Arc refuses the cursor, discard the rows from that listing and restart once without `--cursor`. Listing changes no state, so retry the same cursor once after a timeout or an unavailable catalog. Then rank known Needs input and unread work before idle sessions. Preserve unknown, stale, and incomplete facts.
2. Bounded reads leave reader attention unchanged.
3. Curation accepts an explicit identical-payload retry with the same request ID in the same activation. The commands are `arc label add|remove SESSION_ID --label NAME`, `arc pin SESSION_ID`, `arc unpin SESSION_ID`, and `arc archive SESSION_ID`. Each takes `--dry-run`, `--window`, `--request-id`, and `--json`. A dry run checks window readiness, a unique scoped ID, and archive or pin refusals. Pass `--force` on the dry run of an archive that needs it. A dry run does not check whether a later save will succeed. Arc retains no dry-run result, so a retry checks again. Give the real action a fresh request ID.
4. Establish a bounded set from the reader's request and scoped session identities. Establish completion or inactivity from a fresh scoped listing with `facts: current` and `runStatus: done` or `runStatus: none`. Completed turns from `arc session` alone do not establish current run status. When the completed-set grant below applies, it covers unread sessions and hidden attention. Do not ask the reader to show Arc then.
5. Arc lists a session as `subagents` or `background` while it has no record that the work ended, and that can outlast a crashed or killed process.
6. Arc cannot list background work in a session whose state is unavailable. If completion remains unavailable, ask the reader to show Arc and list the session again. A row that still reads `unknown` with Arc shown can hide a resumed subagent or a long background command. Before you force it, ask the reader whether the session still runs a subagent or a long background command. Arc's session list shows a resumed subagent, so the reader can check the list for one. The list stops counting a background command one hour after the command starts, so it cannot show a long command.

Commands curate one session at a time. Archive removes the pin and keeps the current turn and any open question. Unarchive preserves labels and reader state and leaves the session unpinned.

## Archive a completed set

Running, Needs input, completed unread, hidden, and unavailable sessions refuse archive without `--force`. Pass `--force` only with explicit reader authority. A request such as "archive my finished sessions" grants `--force` for the completed members of that set. Completion requires the fresh listing described above. The grant excludes running, waiting, Needs input, background, stale, unknown, and unavailable sessions. Each requires the reader's explicit request to archive it.

## Archive this session

Archive this session only at the reader's request. Skip the dry run. The request grants `--force` for this session and no other. Get the session ID from `CLAUDE_CODE_SESSION_ID` in Claude or `CODEX_THREAD_ID` in Codex. Finish every other task and end all background work first. Never archive any session with background work running. Then run this as your last tool call. Write the session ID, window ID and UUID as literal text.

```text
arc archive OWN_ID --force --window WINDOW_ID --request-id WINDOW_ID:UUID --json
```
