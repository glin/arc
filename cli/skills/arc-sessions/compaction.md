# Request compaction of this session

The command requests context maintenance for this session. Only its native main agent can request compaction through its live Arc window. A subagent cannot compact its parent. Standalone sessions need an Arc host for this transport.

Run the command in this exact form. Write the window `hostId` and a fresh lowercase UUID as literal text:

```text
arc compact request --self --after-turn --request-id WINDOW_ID:UUID --window WINDOW_ID --json
```

Both window values are the `hostId` of the window that hosts this session, as selected in [Select a ready window](SKILL.md#select-a-ready-window). Claude agents run the command with the Bash tool. Arc does not admit it from the Claude PowerShell tool. Codex agents run the bare command as a shell command. Codex adds its own PowerShell wrapper on Windows, so never write a wrapper. Do not use shell substitutions, command chains, or alternate payload transports.

Arc admits the request only while the native tool call runs in a session this window holds. Open asks and queued reader prompts block admission. Reader activity after command observation withdraws the call. Any reader action after admission, including an answer, cancels unsubmitted compaction and suppresses continuation. An answer approving the requesting tool before admission preserves its call.

Each exact session turn holds one pending request. Each request ID is admitted once per window activation. Root background commands, notification turns, and continuation turns use the same admission rules. Repeated compaction grants no new task, spending, model, or review authority.

Read the `state` field of the result. The command returns at once. After `queued`, finish the successful final response. Report the request in the past tense: "I requested compaction after this turn." Arc checks delivery conditions after the turn. Reader intervention can cancel unsubmitted compaction after the last observation, including while you write the final response. Never promise future delivery from `queued` or a status check.

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

Each completed compaction can deliver its explicit continuation once. Finish the requesting turn successfully after admission. Compaction completion and continuation acceptance are separate observations. The continuation states are `waiting`, `preparing`, `attempting`, `accepted`, `cancelled`, `refused`, and `uncertain`. Acceptance confirms prompt acknowledgment rather than task completion. Never retry uncertain input or reopen a child. A continuation can request another compaction with a fresh request ID within the same authorized work and its existing limits.

Active requests wait for their prerequisites without an execution deadline. Terminal status remains available for up to one hour, subject to capacity eviction.

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
- `cancelled`: The request stopped before Arc sent it. Reader activity, session changes, scope loss, child exit, or window closure cancelled it.
- `refused`: Arc did not admit the request, or did not send it. A window without compaction support also refuses. The `reason` names the missing condition, for example an open ask, queued reader input, or a changed session.
- `failed`: the requesting tool or turn failed, the final response was not saved, or the agent refused or failed the compaction.
- `uncertain`: admission or the compaction outcome is not known yet. Arc also reports this right after it sends the compaction, until native evidence arrives. When the request command returns it, report it and finish the turn. Never resend, change transport, reopen the session, or fork the session.
- `unavailable`: the window holds no record of this request ID, or the window did not answer the status read.

Start and curation retry advice does not apply to compaction. Follow-ups follow their own rules in [Send a message or follow-up](SKILL.md#send-a-message-or-follow-up).
