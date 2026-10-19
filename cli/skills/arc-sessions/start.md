# Start a session

Read this before `arc start`.

Run `arc windows --json` when the task starts a session, even with `ARC_WINDOW` set, because start needs `scopeReady`, `panelReady`, and setups. Check `scopeReady` and `panelReady` before starting. A hidden panel leaves live attention unknown. A folderless window cannot start sessions. New sessions use the window's first folder.

Run `arc setups --window WINDOW_ID` before choosing settings. Use a returned setup key or explicit supported values. A loading catalog or unsupported setup refuses launch.

Start requires a regular UTF-8 prompt file, at most 48 KiB, with nonempty text that does not begin with a slash command. Omitted model, effort, and permissions retain provider defaults.

Start accepts an explicit identical-payload retry with the same request ID in the same activation.
