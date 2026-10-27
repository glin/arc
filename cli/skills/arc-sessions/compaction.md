# Request compaction of this session

The command requests context maintenance for this session through its live Arc window. Arc writes a launch token into the environment of each agent process it starts, and the command sends it. The token identifies the session, so subagents and background commands of the session can also request its compaction. Standalone sessions need an Arc host for this transport.

Run the command in this exact form. Write the window `hostId` and a fresh lowercase UUID as literal text:

```text
arc compact request --self --after-turn --request-id WINDOW_ID:UUID --window WINDOW_ID --json
```

Both window values are the `hostId` of the window that hosts this session, as selected in [Select a ready window](SKILL.md#select-a-ready-window). Claude agents run the command with the Bash tool. Without a launch token, Arc does not admit it from the Claude PowerShell tool. Codex agents run the bare command as a shell command. Codex adds its own PowerShell wrapper on Windows, so never write a wrapper. Do not use shell substitutions, command chains, or alternate payload transports.

Arc admits a request with a launch token at once for the live session that holds the token. Without a token, Arc admits the request only while it sees the native tool call run in a session this window holds, and the command waits up to 30 seconds for that. Open asks and queued reader prompts do not block admission. Arc sends the compaction after they clear. Reader activity after command observation withdraws an unadmitted call. After admission, a reader prompt carries the request to the turn that answers it, and a queue change keeps it. Stop, a setting pick, a reader compaction, a slash command, and an answer cancel unsubmitted compaction and suppress continuation. An answer approving the requesting tool before admission preserves its call.

Each exact session turn holds one pending request. Each request ID is admitted once per window activation. Root background commands, notification turns, and continuation turns use the same admission rules. Repeated compaction grants no new task, spending, model, or review authority.

Run the request as the last tool call of the turn, after every background child and waiter has returned. A Stop or another cancelling reader action after admission ends the request, so the last tool call leaves the least room for a reader action to cancel it.

A carried request keeps its continuation. The reader prompt that Arc delivers to you then ends with this line:

```text
Arc: compaction request WINDOW_ID:UUID runs after this turn. Run arc compact cancel to drop it.
```

Answer the prompt. When the prompt makes the compaction or its continuation wrong, cancel the request with `arc compact cancel`. Request again later with a fresh request ID. Arc compacts after the answering turn unless Stop or another cancelling reader action ends the request.

Read the `state` field of the result. The command returns at once. After `queued`, finish the turn. Report the request in the past tense: "I requested compaction after this turn." Arc checks delivery conditions after the turn. Reader intervention can cancel unsubmitted compaction after the last observation, including while you write the final response. Never promise future delivery from `queued` or a status check.

Arc's after-turn compaction accepts one explicit saved continuation. Use the continuation form below for requested same-session work. Never queue that follow-up before compaction.

For authorized same-session follow-up work, save the exact next-turn instruction in a regular UTF-8 file. Include the durable handoff location and inherited execution limits. Use 1 through 8192 bytes. Preserve its whitespace. Exclude a byte-order mark, NUL, invalid UTF-8, and a leading slash command. Arc sends this agent-authored instruction as one ordinary next-turn prompt without adding reader comments or files.

Compute the lowercase digest before the request. On Windows:

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

Each completed compaction can deliver its explicit continuation once. Compaction completion and continuation acceptance are separate observations. The continuation states are `waiting`, `preparing`, `attempting`, `accepted`, `cancelled`, `refused`, and `uncertain`. Acceptance confirms prompt acknowledgment rather than task completion. Never retry uncertain input or reopen a child. A continuation can request another compaction with a fresh request ID within the same authorized work and its existing limits.

Active requests wait for their prerequisites without an execution deadline. Terminal status remains available for up to one hour, subject to capacity eviction.

After window reload, select the current window for the same workspace. Keep the original request ID for status. Status returns saved text only when the current scope admits the exact original source. Restart recovery cancels unattempted continuation and marks possible input uncertain. It never restarts work.

Observe a known request without submitting work:

```text
arc compact status --request-id ORIGINAL_WINDOW:UUID --window CURRENT_WINDOW --json
```

`ORIGINAL_WINDOW` identifies the admitting activation. `CURRENT_WINDOW` identifies the selected current window for the same workspace.

Cancel your own admitted request before Arc sends it:

```text
arc compact cancel --self --request-id WINDOW_ID:UUID --window WINDOW_ID --json
```

Run it in the same bare form as the request, with literal values and no chain, pipe or substitution. Arc refuses a cancel for another session's request, for a request it already sent, and for an unknown ID. A request that already stopped returns its record unchanged. A lost reply returns `unavailable`. Read `arc compact status` for the request ID then, because the cancel can still have applied.

The `state` field names one outcome:

- `queued`: the request waits for its turn to end and for the session to be idle with no open ask or queued reader prompt. A carried request waits for the turn that answers the reader prompt.
- `started`: the agent accepted the compaction.
- `completed`: the agent finished the compaction.
- `cancelled`: The request stopped before Arc sent it. The `reason` names the change: reader activity, a replaced agent process, an agent process that exited or moved to another session, window closure, or `arc compact cancel`. To compact after all, request again with a fresh request ID.
- `refused`: Arc did not admit the request, or did not send it. A window without compaction support also refuses. The `reason` names the missing condition, for example a token that names no live session, an unseen command, or a changed session.
- `failed`: the agent refused or failed the compaction.
- `uncertain`: admission or the compaction outcome is not known yet. Arc also reports this right after it sends the compaction, until native evidence arrives. When the request command returns it, report it and finish the turn. Never resend, change transport, reopen the session, or fork the session.
- `unavailable`: the window holds no record of this request ID, or the window did not answer the status read.

Start and curation retry advice does not apply to compaction. Follow-ups follow their own rules in [Send a message or follow-up](SKILL.md#send-a-message-or-follow-up).
