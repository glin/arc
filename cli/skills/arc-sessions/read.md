# Mark requested turns read

Mark only sessions the reader explicitly asked you to mark read. Establish that bounded set from the request and exact scoped identities. A listing, an incidental lookup, or a status report grants no marking authority.

Check the selected window's `sessionRead` capability. Read acknowledgments work without a visible panel. Hidden attention remains unknown. A window without it does not support read writes. Report that limitation without switching windows or changing reader attention through another command.

For a supporting window, read each authorized session with `arc session SESSION_ID --turns 5 --window WINDOW_ID --json`. Read the delivered completed turns before acknowledging them. Copy `readObservation` unchanged, never the send-only `observation`. A reply without `readObservation` grants no read acknowledgment.

```text
arc read SESSION_ID --observation READ_OBSERVATION --request-id WINDOW_ID:UUID --window WINDOW_ID --json
```

Use `--dry-run` to check admission without saving. Use a different request ID for the later applied action. Report `applied`, `dry-run`, `refused`, or `unknown` exactly. Preserve the selected window and request ID after an unknown outcome.

Acknowledgment covers only the delivered completed projection. It does not establish full transcript consumption or complete history. Omitted and later work stays outside that acknowledgment. A changed source invalidates its acknowledgment, including an append. After a stale refusal, read again and use a fresh request ID for the new receipt. After an unknown outcome, retry only the identical payload with the same request ID. Never change the ID for that uncertainty retry. Marking read sends no prompt and changes no archive membership, label, or pin.
