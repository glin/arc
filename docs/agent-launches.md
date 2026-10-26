# Agent launches

[Agent protocols](agent-protocols.md#hosted-read-only-launches) owns immutable launch restrictions.

## Runtime shape

Arc-owned children receive their immutable private CLI launcher directory before inherited PATH. Windows preserves the inherited PATH key's casing. `ARC_WINDOW` names the current activation when its channel exists. Otherwise remove it. `ARC_EDITOR_EXECUTABLE` names the editor binary.

Arc checks Claude's session skill and snapshot hooks separately. Each accepted plugin adds one `--plugin-dir` argument to the Claude command. Arc still launches the provider directly. [Session tools](native-skills.md#checks-before-startup-and-input) describes the checks before startup and input.

Both private launchers set `ELECTRON_RUN_AS_NODE=1` and run their release's `cli/arc.cjs` with that binary. Extensionless `arc` serves POSIX shells and Git Bash. `arc.cmd` serves Windows command shells. Every Arc-owned child uses this environment through `childEnv` in [`agenthost.ts`](../extension/src/agenthost.ts).

Unavailable private tools refuse launch. Trusted remote children use commands on their execution host. Untrusted windows refuse launch. Watch builds supply development launchers without immutable package identity. [Bundled tools](installation.md#bundled-tools) defines complete development builds.

## Launch selection

[`composerview.ts`](../extension/src/composerview.ts) owns executable selection and fallbacks. Unix PATH search skips relative entries and nonexecutable files. Child working directories can differ from the host's.

Windows npm batch shims cannot spawn directly without a shell. Resolve their package scripts and run them under `process.execPath`. VS Code's Electron binary requires `ELECTRON_RUN_AS_NODE`. Windows Codex packages prefer the platform binary and its launcher environment, avoiding a grandchild console window. Unsupported architectures use the JavaScript launcher.

## Agent launch commands

Claude framing requires these flags:

```text
claude -p --verbose --input-format stream-json --output-format stream-json --permission-prompt-tool stdio --include-partial-messages
```

Without `--verbose`, Claude refuses stream-json output. The undocumented stdio permission flag enables asks. Without it, headless Claude silently allows tools. Partial-message output supplies text before turn completion.

`spawnArgs` in [`claudewire.ts`](../extension/src/claudewire.ts) owns optional launch arguments. Existing sessions use `--resume`, new sessions use `--session-id`, and temporary children use `--no-session-persistence`. [Claude receipts](agent-protocols.md#guarded-receipts) owns replay requirements.

Codex runs this command. Operations travel through JSON-RPC 2.0 objects, one per line, without a `jsonrpc` field. The official Codex editor extension uses this experimental protocol.

```text
codex app-server
```

### Environment identity

`childEnv` removes inherited identity variables, including every case variant:

```text
CLAUDE_CODE_ENTRYPOINT
CLAUDE_AGENT_SDK_VERSION
CLAUDE_AGENT_SDK_CLIENT_APP
CLAUDE_CODE_REMOTE_SESSION_ID
CLAUDE_CODE_CHILD_SESSION
CLAUDE_CODE_CONTAINER_ID
CLAUDE_CODE_SESSION_ID
CODEX_THREAD_ID
```

Apply launch variables afterward. Attribution selection below replaces both attribution keys again. Without an explicit entrypoint override, print-mode Claude uses `sdk-cli`.

Claude generates headless `ai-title` records only with `CLAUDE_AGENT_SDK_VERSION` or `CLAUDE_CODE_REMOTE_SESSION_ID`. The official Claude extension sets the SDK variable in the shared host on its first query. Removing both prevents inherited automatic titling. Slash-command first prompts do not trigger titles. Resumed sessions with messages do not start titling. Without custom or generated titles, the first typed prompt supplies the name.

### Claude attribution selection

Read `ARC_CLAUDE_BILLING_LABEL` from the extension host environment for each new Claude child. When absent, read only that selector from `.env` in the child's directory. Do not search parents or mutate the editor environment. Trim surrounding whitespace and accept these lowercase values:

| Value           | `CLAUDE_CODE_ENTRYPOINT` | `CLAUDE_CODE_ATTRIBUTION_HEADER` |
| --------------- | ------------------------ | -------------------------------- |
| `sdk-cli`       | `sdk-cli`                | `1`                              |
| `claude-vscode` | `claude-vscode`          | `1`                              |
| `omit`          | `sdk-cli`                | `0`                              |

Unset, empty, whitespace-only, unsupported, and missing-file values select `omit`. Other file-read errors prevent launch. Selector names accept case variants. Launch variables cannot select attribution. Remove every variant of both vendor keys before setting canonical names. Codex retains its launch values.

Metadata children use the same selection. Existing children retain their captured environment, including reused provisional children. Changing the host environment requires restarting the relevant editor processes. A terminal environment change does not update a running editor. Attribution supplies no subscription-rate guarantee.

Delegated Claude launches default to five-minute prompt-cache lifetime unless an explicit environment value exists. Ordinary reader launches keep the provider default. [`claudeCacheLifetime`](../extension/src/launchpolicy.ts) owns explicit lifetime selection.
