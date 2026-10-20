# Request compaction of this session

Request compaction only when the reader explicitly delegates it for this turn, including through [Execute requested follow-ups](SKILL.md#execute-requested-follow-ups). Save the handoff the reader asked for first. Only the main agent can request compaction. Arc refuses a subagent's request. Inherited environment, session IDs, and archived prompts supply no authority.

Run one foreground command in this exact form. Write the window `hostId` and a fresh lowercase UUID as literal text:

```text
arc compact request --self --after-turn --request-id WINDOW_ID:UUID --window WINDOW_ID --json
```

Both window values are the `hostId` of the window that hosts this session, as selected in [Select a ready window](SKILL.md#select-a-ready-window). Claude agents run the command with the Bash tool. Arc does not admit it from the Claude PowerShell tool. Codex agents run the bare command as a foreground shell command. Codex adds its own PowerShell wrapper on Windows, so never write a wrapper. Do not use shell substitutions, command chains, background execution, or alternate payload transports.

Arc admits the request only while this tool call runs in a session that this window's panel holds. The session must have no open asks, no queued reader prompts, and no reader action since this turn's prompt. An answer to one of this turn's asks given before the request does not block admission. Any reader action after admission, including an answer, cancels the request. Each turn holds one pending request. Each request ID is admitted once in a window activation.

A reader prompt takes over the background work that still runs once the agent reads the prompt, so an instruction such as "compact after this is done" covers that work. Claude can start a turn by itself, such as when a background task notice or a subagent hand-back wakes it. That turn carries the latest reader instruction that the agent read before the work reported back. Arc refuses the request when no task notice from work that a reader instruction covers woke the turn. Arc also refuses it when the notices that woke the turn come from work that different reader instructions cover. One reader instruction admits one compaction across its own turn and every turn that work it launched or took over wakes.

Read the `state` field of the result. The command returns at once. After `queued`, finish the successful final response. Report the request in the past tense: "I requested compaction after this turn." Arc checks delivery conditions after the turn. Reader intervention can cancel unsubmitted compaction after the last observation, including while you write the final response. Never promise future delivery from `queued` or a status check.

Arc's after-turn compaction accepts one explicit saved continuation. Use the continuation form below for requested same-session work. Never queue that follow-up before compaction.

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
- `refused`: Arc did not admit the request, or did not send it. A window without compaction support also refuses. The `reason` names the missing condition, for example a reader action after the instruction or an instruction that already requested compaction.
- `failed`: the requesting tool or turn failed, the final response was not saved, or the agent refused or failed the compaction.
- `uncertain`: admission or the compaction outcome is not known yet. Arc also reports this right after it sends the compaction, until native evidence arrives. When the request command returns it, report it and finish the turn. Never resend, change transport, reopen the session, or fork the session.
- `unavailable`: the window holds no record of this request ID, or the window did not answer the status read.

Start and curation retry advice does not apply to compaction. Follow-ups follow their own rules in [Send a follow-up](SKILL.md#send-a-follow-up).
