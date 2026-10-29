# Start a session

Read this before `arc start claude`, `arc start codex`, or `arc start --setup KEY`.

Choose the provider immediately after `start` or `run`. Read that provider command's `--help` for its options. Saved setups determine their own provider and reject a positional provider, model, effort, and permissions.

Run `arc windows --json` when the task starts a session, even with `ARC_WINDOW` set, because start needs `scopeReady`, `panelReady`, and setups. Check `scopeReady` and `panelReady` before starting. A hidden panel leaves live attention unknown. A folderless window cannot start sessions. New sessions use the window's first folder.

Run `arc setups --window WINDOW_ID` before choosing settings. Use a returned setup key or explicit supported values. A loading catalog or unsupported setup refuses launch.

Start requires a regular UTF-8 prompt file, at most 48 KiB, with nonempty text that does not begin with a slash command. Omitted model, effort, and permissions retain provider defaults.

Start accepts an explicit identical-payload retry with the same request ID in the same activation.

Confirm initial labels from `metadata.labels.state: saved` and its normalized `values`. Confirm pins from `metadata.pinned.state: saved` and `value`. A missing catalog row does not invalidate these save results.

Read `metadata.name.state` separately from launch acceptance. `pending` retains naming work in this activation. `saved` confirms the requested name. Report `failed`, `cancelled`, or `uncertain` without launching another session or resending the prompt. Later detailed session JSON reports retained name state after catalog admission. Older hosts omit metadata.

For Codex, `start` and `run` accept `--service-tier default|fast|priority|ultrafast`. Omission inherits the provider setting. `fast` selects canonical `priority`. Explicit unavailable tiers refuse before prompt delivery. Preserve the requested tier after refusal. Never retry at a different speed.
