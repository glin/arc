# Settings

Search for **Arc** in VS Code settings. [`development.md`](development.md) documents environment overrides and performance capture.

| Setting | Default | Effect |
| --- | --- | --- |
| `arc.maxSessions` | `3` | Keeps this many recent sessions up to date. Pinned and open sessions remain available. |
| `arc.agentIdleMinutes` | `60` | Retires an idle child process after this many minutes. Archiving retires it after current work settles. |
| `arc.sessionCacheMiB` | `16` | Bounds memory for viewed sessions. The selected session remains loaded. |
| `arc.projectCost.historyDays` | `0` | Limits Project cost indexing to recent source files. Zero reads all history. A period extending before the limit shows a lower bound. |
| `arc.timeline.cardLayout` | `Two columns` | Places files, subagents, and commits in Compact, One column, or Two columns layout. |
| `arc.timeline.promptPosition` | `Below the response` | Places a turn prompt above or below its response. |
| `arc.claudePath` | Empty | Overrides Claude CLI discovery for the next process Arc starts. |
| `arc.codexPath` | Empty | Overrides Codex CLI discovery for the next process Arc starts. |
| `arc.diagnostics.log` | `false` | Writes the diagnostics used for performance capture after the window reloads. |
