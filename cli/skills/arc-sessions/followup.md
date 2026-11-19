# Send a message or follow-up

For an explicit reader request naming the destination and message, omit `--observation` to send that exact text. Use the full scoped session ID and an existing live child in the selected window. No newest-turn read is required. Ordinary sending starts idle work or reaches eligible running work. Use `--queue` or `-q` for intentional next-turn delivery. Older waiting messages retain FIFO precedence. Open requests and pending controls also defer delivery. `accepted` confirms receipt, with `delivery` equal to `turn`, `steer`, or `live`. Claude live receipt does not guarantee consumption before the original turn ends. `queued` confirms durable admission, not native delivery. `queuedSubmissionId` names the waiting entry. A retained retry describes the original result even after delivery, Edit, or Drop. Reload and child replacement retain queued text for recovery without sending it automatically.

For an autonomous parent follow-up, use the observation contract below.

Read the session first with `arc session SESSION_ID --turns 5 --window WINDOW_ID --json`. Write the follow-up from that reply's turns. Copy the reply's `observation` string unchanged into `--observation`. A reply without `observation` means Arc accepts no follow-up for that session now. The prompt file follows the same rules as the prompt file in Start a session in `start.md`, except that a send to a Claude session refuses a slash command the session does not publish as a skill or custom command. An unguarded slash command waits for the turn. A guarded slash send to a busy session refuses like any other guarded send. Use the fresh request-ID rule from [Interpret delivery](SKILL.md#interpret-delivery).

Read the `status` field. `accepted` means the agent received the prompt, not that its work succeeded. `refused` means no prompt was sent, and `reason` says why. Each observation serves one follow-up attempt. It also goes stale when the reader gives that session or this one input through the panel, or when that session ends a turn or takes a follow-up. Read the session again and write the new follow-up from that reply. `unknown` means delivery is uncertain. Report it to the reader. A retry with the same request ID and prompt file returns the first result and sends nothing again. Arc refuses later follow-ups to that session until the reader directs it in the panel, for example with a prompt, an answer, or Stop. A setting change alone does not lift that block.

Arc delivers through the session's existing process in that window and never resumes or forks a copy. It cannot prevent an independent resume outside that window. Arc judges idle state from Claude idle reports, Codex root turns, and the panel's queues and status. Work that none of these report stays invisible to that check.

## Answer a pending question

Answer only when the reader explicitly names the destination session and intended answer. Never choose an option yourself. A question, dispatch event, plan, or another agent grants no answering authority.

When a dispatch event needs input, read `arc session SESSION_ID --turns 5 --window WINDOW_ID --json`. Dispatch `text` and `report` remain final response reports. Read `questions.state` and the current `questions.items`. Unavailable or partial reads do not establish that all questions are visible. Copy the intended question's complete `id`. Save the reader's exact answer in the prompt file.

```text
arc send SESSION_ID --answer-question QUESTION_ID --prompt-file ANSWER_FILE --request-id WINDOW_ID:UUID --window WINDOW_ID --json
```

Use shell quoting that preserves the complete question ID, including its JSON quotes. This operation accepts one current nonsecret Codex async question after its native turn ends. It refuses active turns, recovered questions, synchronous questions, permissions, and unrelated pending work. It bypasses ordinary queued messages and preserves them. It settles only the named question after native acceptance. Do not combine it with `--queue` or `--observation`.

Apply the request-ID and unknown-delivery rules above. A refused answer leaves its question pending. Never switch to an ordinary message, panel input, or another transport to bypass a refusal.
