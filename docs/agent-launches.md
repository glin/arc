# Agent launches

Use this guide when changing executable selection, child environments, launch arguments, or Claude attribution.

## Runtime shape

Arc-owned children receive the matching immutable private CLI launcher directory before inherited PATH. Windows preserves the inherited PATH key's casing. `ARC_WINDOW` names this activation's window when its channel exists. Without a channel, children receive no `ARC_WINDOW`. `ARC_EDITOR_EXECUTABLE` names the editor binary. Both private launchers set `ELECTRON_RUN_AS_NODE=1` and run their release's `cli/arc.cjs` with that binary. The extensionless `arc` serves POSIX shells and Git Bash. `arc.cmd` serves Windows command shells. Fresh, resumed, draft, idle, recovery, CLI-routed and rename-only children share this environment. Unavailable private tools refuse child launch. Trusted remote children use commands on their execution host. Untrusted windows refuse child launch. Watch builds supply development launchers without immutable package identity. [Bundled tools](development.md#bundled-tools) defines complete development builds.

## Launch selection

User-configured executable paths take priority. Each agent then uses its command on `PATH`, followed by the binary bundled with its official editor extension. Standalone installs remain fallbacks. The Unix search skips relative entries and paths that are not executable files, because a child can start in a different directory from the extension host.

On Windows, npm command shims are batch files and cannot be spawned directly without a shell. The launch plan resolves the package script and runs it under `process.execPath`. When `process.execPath` is VS Code's Electron binary, `ELECTRON_RUN_AS_NODE` makes it behave as Node.

Codex package launch prefers the platform binary over its JavaScript launcher to avoid a console window from a grandchild. The launch plan supplies the package environment that the launcher would have set. Unsupported machine architectures fall back to the launcher.

A Claude child inherits the extension host's environment. Claude Code writes an `ai-title` record for a headless launch only when that environment carries `CLAUDE_AGENT_SDK_VERSION` or `CLAUDE_CODE_REMOTE_SESSION_ID`. The official Claude Code extension sets the SDK version variable in the shared extension host on its first query in the window. `childEnv` removes both variables from every child Arc starts, so a Claude child never gets a generated title. Claude Code never titles from a first prompt that is a slash command, and it never starts titling a resumed session that already has messages. A session with neither a `custom-title` nor an `ai-title` is named by its first typed prompt.

## Agent launch commands

Arc starts each installed CLI as a child process and communicates over its headless protocol. The panel does not drive a terminal UI.

`claudePlan` and `codexPlan` in `agenthost.ts` build the command. The executable and any leading arguments come from `composerview.ts`, which decides whether the agent is an executable or a script that runs under the Node on this machine.

**Claude Code**, print mode over the stream-json protocol:

```
claude -p --verbose --input-format stream-json --output-format stream-json --permission-prompt-tool stdio --include-partial-messages
```

`spawnArgs` in `claudewire.ts` adds `--model` and `--effort` from the reader's accepted settings. Unrestricted launches also add the reader-selected `--permission-mode`. The host adds `--resume <id>` for an existing session or `--session-id <id>` for a new one. It adds `--no-session-persistence` for a temporary child. Unrestricted launches add `--settings <path>` when a launch supplies a settings file.

The following flags provide stream framing, permission requests, and partial response text:

- `--verbose` is required. Without it the CLI refuses `--output-format stream-json` and exits.

- `--permission-prompt-tool stdio` enables permission requests. It does not appear in `claude --help`. Without it the CLI silently allows every tool in headless mode and the reader is never asked.

- `--include-partial-messages` publishes response text while the agent writes it. Without it, the CLI emits no response text until the turn ends.

`childEnv` removes inherited `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_AGENT_SDK_CLIENT_APP`, `CLAUDE_CODE_REMOTE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, and `CLAUDE_CODE_CONTAINER_ID` before applying launch variables. It also removes `CLAUDE_CODE_SESSION_ID` and `CODEX_THREAD_ID` inherited from the editor's process environment. Removal includes every case variant of these environment names. Without an explicit override, print-mode Claude uses its ordinary `sdk-cli` entrypoint. Without a generated title, the session keeps the name the session-name rules give it.

### Claude attribution selection

Arc omits the attribution block by default for Claude children. Arc reads `ARC_CLAUDE_BILLING_LABEL` from the extension host environment when starting each Claude child. If that variable is absent, Arc reads it from `.env` in the child's working directory. Arc reads only this selector from the file and does not change the editor environment. It trims surrounding whitespace and accepts only these lowercase values:

| Value           | `CLAUDE_CODE_ENTRYPOINT` | `CLAUDE_CODE_ATTRIBUTION_HEADER` |
| --------------- | ------------------------ | -------------------------------- |
| `sdk-cli`       | `sdk-cli`                | `1`                              |
| `claude-vscode` | `claude-vscode`          | `1`                              |
| `omit`          | `sdk-cli`                | `0`                              |

Unset, empty, whitespace-only, and unsupported values select `omit`. Explicit `sdk-cli` and `claude-vscode` selections restore attribution. Every Claude selection replaces conflicting inherited and launch values for both vendor keys. Arc removes all their case variants before writing canonical names. The selector name also accepts case variants. Launch variables cannot select the mode. Codex launch behavior stays unchanged.

The selection applies to fresh and resumed sessions, provisional draft children, renames, idle account and model reads, and metadata-default reads. Existing children keep their captured environment, including a provisional child reused for its first prompt. Arc does not restart children to apply a selection.

Changes to `.env` apply when Arc starts another Claude child. Arc does not search parent directories. Missing files select `omit`. Other file-read errors prevent the Claude child from starting. Close the relevant editor processes and restart them to change the extension host environment. Changing a terminal's environment does not update an already running editor. These values select request attribution and provide no subscription-rate guarantee.

**Codex**, the app-server protocol:

```
codex app-server
```

Codex uses JSON-RPC 2.0 over stdio, with one object per line and no `jsonrpc` field. Protocol requests carry operations instead of command-line flags. The official Codex editor extension uses this experimental protocol.
