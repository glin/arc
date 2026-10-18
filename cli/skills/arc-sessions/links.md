# Report session links

Report known sessions as named Markdown links:

```markdown
[name](arc-session:<id>)
```

Link only destinations established in the window scope containing the invoking conversation. When supplied, `ARC_WINDOW` identifies that window. A successful operation with explicit `--window` does not establish the invoking window. Keep another or unestablished window's sessions as plain text with their known names and IDs. Never invent an ID or link an unverified destination. Never substitute a source hash, transcript path, short reference, or guess.

For lookup reports, use `arc sessions` rows with exact, nonnull `id` and `name`, neither listed in `truncated`, and `ambiguous: false`. Keep incomplete identities and ambiguous rows as plain text. A detailed `arc session` read returns `id`, without a session name. Pair it with an exact, untruncated name from an authorized source before linking.

For an accepted start, use the requested name and returned `sessionId`. If naming failed, identify the name as requested and report the error. Do not claim that Arc saved it.

Backslash-escape every ASCII punctuation character in the label to preserve the displayed name. The name `Plan **[draft](notes)**` becomes the label `Plan \*\*\[draft\]\(notes\)\*\*`. Percent-encode the raw ID once using UTF-8. Encode every character outside ASCII letters, digits, hyphen, underscore, period, and tilde. One decode must restore the exact returned ID without normalization. The raw ID `literal%2f` becomes `arc-session:literal%252f`. Keep parser-rejected IDs as plain text, including empty IDs and IDs containing whitespace, control characters, `/`, `\`, `?`, or `#`.

These links require Arc's response-link support and open only inside its live extension panel. CLI JSON versions do not establish that support. Exported responses display only the label, without session navigation. Response links complement the existing Dispatched link. Preserve its `ARC_DISPATCH_SESSION` receipt, attribution, and delegated cost accounting.
