# Arc sessions for agents

The `arc-sessions` skill lets a Claude Code or Codex agent start, inspect, and organize requested work through a running Arc window. The reader reviews those sessions in the panel and continues them through the Prompt box.

## The four components

| Component | Job | Installation |
| --- | --- | --- |
| Arc extension | Displays sessions and connects to agent CLIs. Includes `arc` launchers for panel-started agents. | Source installer or an available VSIX. |
| Standalone Arc CLI | Makes `arc` available to ordinary shell commands. | Local npm tarball from the [CLI build instructions](../cli/README.md#build-from-source). |
| `arc-sessions` skill | Gives an agent instructions for bounded session work through the CLI. | Reader installs or links the skill separately. |
| `arc-hooks` Claude plugin | Captures first-touch file snapshots for Claude file diffs. | Source installer or Claude plugin marketplace. |

The skill source is [`cli/skills/arc-sessions/SKILL.md`](../cli/skills/arc-sessions/SKILL.md). The standalone CLI package includes it under `skills/arc-sessions/SKILL.md`. The VSIX and Claude plugin do not include the skill.

Bundled files are part of an artifact. An installed skill exists in an agent's skill directory. A release requires publication of the corresponding artifact. None of these states establishes the others.

## Install the parts you need

`install.sh` builds and installs the editor extension. It also sets up the optional Claude plugin unless passed `--no-hooks`. A local source installation uses the checkout's code. A remote source installation resolves the selected ref before downloading it.

A VSIX installs the extension. The separate release downloader requires published VSIX and checksum assets. Claude marketplace installation selects `arc-hooks`, not the CLI or session skill. [Development setup](development.md#dependencies) owns local plugin commands. Session commands use Arc's local window channel without requiring Claude hooks. Codex records come from its rollouts.

Arc has no editor command named **Arc: Install CLI**. To update the standalone CLI, build a current source checkout and install its tarball. [CLI installation](../cli/README.md#install) owns the commands and Node requirements. npm publication is deferred, so a registry `latest` install is not an available release path.

The reader chooses which agents receive the skill. [Manual skill installation](../cli/README.md#session-skill) provides Windows junction and macOS/Linux link commands. Claude Code uses `~/.claude/skills/arc-sessions`. Codex uses `~/.agents/skills/arc-sessions`. A source link reads the linked checkout's instructions. Restart the agent session after installation.

The third-party [Vercel skills CLI](https://github.com/vercel-labs/skills#readme) also supports local paths, named skills, and both agents. From an Arc checkout, these commands list the skill, then install it:

```sh
npx skills add ./cli/skills --list
npx skills add ./cli/skills --skill arc-sessions --global --agent claude-code --agent codex
```

These are documented installer forms, not a tested Arc installation route. Use the explicit `cli/skills` directory because the repository nests the skill beneath `cli`. Repository-root discovery requires `--full-depth`. `npx skills` installs skill files. It does not install the Arc CLI, extension, or Claude plugin.

Arc does not automatically install the session skill or inject its instructions into agent prompts. The agent discovers installed skills through its native skill directories. Both providers list skill metadata and load the full instructions when the skill activates. Explicit invocation uses `/arc-sessions` in Claude Code or `$arc-sessions` in Codex. The agent also selects relevant skills from their descriptions, subject to provider configuration. [Claude skill guidance](https://code.claude.com/docs/en/skills) and [Codex skill guidance](https://learn.chatgpt.com/docs/build-skills) own discovery, selection, and context-loading behavior.

Ordinary `claude -p` loads the same configured context as an interactive session, including available skills unless disabled. By default, `--bare` skips automatic skill discovery. [Claude programmatic guidance](https://code.claude.com/docs/en/headless) owns bare-mode exceptions. Context use depends on listed metadata and activated instructions. Loading the skill does not authorize session starts or create an automatic workflow. The agent must receive a request authorizing the work it starts.

An ordinary CLI session can coordinate work when its shell finds `arc` and the intended Arc window is ready. The extension supplies its own launcher environment to panel-started agents. [Agent runtime](agent-protocols.md#runtime-shape) owns that environment.

## A bounded coordinator run

A coordinator is an ordinary agent session given an explicit session-management task. The skill supplies instructions rather than a scheduler or separate coordinator process.

```text
Reader authorizes a bounded task
             |
             v
Coordinator + installed native arc-sessions skill
             |
             v
arc CLI <--- local channel ---> Selected ready Arc window
                                         |
                              Provider runtime adapters
                                 /                \
                                v                  v
                         Native Claude CLI   Native Codex CLI
                                |                  |
                                v                  v
                         Claude transcripts   Codex rollouts
                                 \                /
                                  v              v
                                  Arc record readers
                                         |
                                         v
                              Session results and panel
                                 /                \
                                v                  v
                       Coordinator reads      Reader continues
                       through arc session    through Prompt box
```

1. Give the coordinator a bounded task authorizing one Claude session and one Codex session. Invoke its installed native `arc-sessions` skill.
2. Read `arc windows --json`. Select the intended repository's window and check `scopeReady` and `panelReady`.
3. Read `arc setups` for that window. Choose offered settings for each provider using the [Manual check](#manual-check) commands.
4. Start each session through `arc start`. Save accepted session IDs and preserve uncertain request IDs without launching replacements.
5. Arc's adapters run the native CLIs. Arc reads Claude transcripts and Codex rollouts for recorded turns. The panel shows live process activity, and session listings show live run status.
6. Read recorded turns through `arc session`. Report each session's result and recorded settings without changing reader attention.
7. To continue a session the coordinator started, prepare the follow-up from the newest `arc session --json` reply. Send it through `arc send` with that reply's `observation`. After an `unknown` result, report it and send that session nothing more.
8. Apply only authorized labels and pins, using `--dry-run` first. Archive only authorized sessions. Running, Needs input, unread completed, and unavailable-state sessions refuse archive without `--force`. Pass `--force` for a running, Needs input, or unavailable-state session only when the reader explicitly asked to archive that session. A session whose listing reports background work refuses archive even with `--force`. Archive removes the pin. [Session management](cli.md#session-management) owns what a forced archive admits and keeps.
9. Leave the requested continuation session available. The reader opens it and sends the next prompt through its Prompt box.

`arc start --arc-dispatch` emits the parent-link receipt for `accepted` and `accepted-with-errors` results that include a session ID. Basic starts require no personal dispatch script. Personal dispatch workflow receipts link sessions. Personal dispatch workflows own durable callback claim/ack outside Arc to track callback ownership and acknowledgement. The receipt does not provide that state. Arc supplies neither detached callbacks nor a cross-provider peer inbox.

Python and shell coordinators both invoke the same CLI. Reader-requested starts keep reader ownership by default. Use `--agent-run` for delegated work. Run `arc --help` and `arc COMMAND --help` for command syntax. [Session management](cli.md#session-management) owns command arguments, delivery outcomes, archive rules, and uncertain-launch handling.

Read each result before describing it. Recorded model and effort establish execution settings, while a requested setup only establishes what the caller selected. Keep a session available for reader continuation when that is part of the task.

Personal `ship` and `dispatch` skills define their own implementation and review workflows. Arc does not package them. The session skill does not automatically review changes, send corrections, rotate coordinator context, or supervise workers continuously. `arc send` delivers one follow-up that the coordinator prepared to a session the coordinator started. [Session management](cli.md#session-management) owns when Arc accepts it.

## Named session links

An agent reports a known session with a named Markdown link:

```markdown
[name](arc-session:<id>)
```

Links open only inside the live extension panel that contains the invoking session. The [skill's reporting rules](../cli/skills/arc-sessions/SKILL.md#report-session-links) define identity sources, label escaping, destination encoding, scope, and plain-text fallbacks.

The response link complements the Dispatched link. Its receipt, attribution, and delegated cost accounting remain part of that relationship. [Architecture](architecture.md#module-boundaries) owns response-link resolution and navigation.

## Manual check

Start with read-only commands. Open Arc in the intended repository and keep the panel visible.

```sh
arc --version
arc windows --json
arc setups --window WINDOW_ID
arc sessions --window WINDOW_ID --json
arc session SESSION_ID --turns 2 --window WINDOW_ID --json
arc pin SESSION_ID --dry-run --window WINDOW_ID
```

Replace `WINDOW_ID` with the selected window's `hostId`. Confirm `scopeReady` and `panelReady` before proceeding. When the listing returns a `next` cursor, run `arc sessions --window WINDOW_ID --cursor NEXT --json` until `next` is `null`. Replace `SESSION_ID` with a listed session. If the list is empty, skip the session read and pin dry run. Reads leave reader attention unchanged, and the pin dry run writes no state. Preserve incomplete or unknown results when reporting the check.

An optional launch check sends paid agent requests and requires reader authorization. Choose the cheapest suitable offered settings for one Claude session and one Codex session. In `arc setups`, reusable rows appear in `primary`, `inherited`, `pinned`, and `recent`. Each row supplies a `key` and a `profile.agent`. Use a row for the intended provider, and exclude pinned rows whose `available` is false.

A provider without a reusable row still has explicit choices in `agents`. Select its `value`, then a model's `models[].value`, that model's `efforts[].value`, and the provider's `permissions[].value`. Model choices are values, not setup keys. A fresh project has no guaranteed reusable row for either provider. If `modelsPending` is true or no model is offered, wait for catalog loading and read setups again.

Create the prompt file below in PowerShell. Replace `WINDOW_ID` with the selected window's `hostId`. This writes regular UTF-8 without a byte-order mark, including on PowerShell 5.1.

```powershell
$arcWindow = 'WINDOW_ID'
$arcPrompt = [System.IO.Path]::GetTempFileName()
$arcEncoding = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($arcPrompt, 'Reply with Ready. Do not use tools or change files.', $arcEncoding)
```

For each provider, use one launch route. With returned keys, replace the key placeholders below:

```powershell
arc start --window $arcWindow --setup 'CLAUDE_SETUP_KEY' --prompt-file $arcPrompt --name 'Claude session check' --arc-dispatch
arc start --window $arcWindow --setup 'CODEX_SETUP_KEY' --prompt-file $arcPrompt --name 'Codex session check' --arc-dispatch
```

Without a returned key, replace the placeholders below with that provider's offered values. If a selected model, effort, or permission value is empty, omit its corresponding flag to retain the provider default. Do not combine `--setup` with explicit settings.

```powershell
arc start --window $arcWindow --provider claude --model 'CLAUDE_MODEL_VALUE' --effort 'CLAUDE_EFFORT_VALUE' --permissions 'CLAUDE_PERMISSION_VALUE' --prompt-file $arcPrompt --name 'Claude session check' --arc-dispatch
arc start --window $arcWindow --provider codex --model 'CODEX_MODEL_VALUE' --effort 'CODEX_EFFORT_VALUE' --permissions 'CODEX_PERMISSION_VALUE' --prompt-file $arcPrompt --name 'Codex session check' --arc-dispatch
```

Record both accepted session IDs. Inspect each session with the read commands above and confirm its response and recorded provider settings. If delivery is unknown, stop that launch check and preserve its request ID. Do not start a replacement.

To check curation, use the commands below only on the check sessions. Replace `SESSION_ID` with the chosen check session.

```sh
arc label add SESSION_ID --label Session-check --dry-run --window WINDOW_ID
arc label add SESSION_ID --label Session-check --window WINDOW_ID
arc pin SESSION_ID --window WINDOW_ID
arc unpin SESSION_ID --window WINDOW_ID
```

Archiving is a separate reader decision. To archive the completed Claude check session, confirm its identity and authorize removal from the active session list. If it remains unread, use the force option:

```sh
arc archive CLAUDE_SESSION_ID --force --window WINDOW_ID
```

Hidden or unavailable attention refuses archive without `--force`. Leave the Codex session unarchived and send a follow-up through its Prompt box to check reader continuation. No launch check requires automatic cleanup of session state.

## Session cost reports

Arc supplies raw session and cost data. The agent assembles any report by label, parent, or time. Arc has no report dashboard, label accounting, or report schedule.

`arc cost` reads Claude and Codex transcripts from disk and needs no running window. It searches every project and Codex store, not the window's repository scope. List every page first. Then read each listed row once by its exact path:

```text
arc cost PATH --since START --until END --by-model --json
```

Take each row's `parent` subtotal. Add each `children[]` entry whose file is not a listed `path`, once across the whole report. These unlisted children include Codex guardian threads and linked print sessions. A child transcript that is also a listed row counts only through its own row. A row's `parent` link appears when Arc knows the edge. The agent chooses whether a child's cost joins its parent's labels. A row whose `path` is `null`, or whose cost read fails, is an explicit unknown cost.

Use an explicit timezone and a half-open interval of request times. Include sessions with requests in that interval, even when they started earlier. Do not select sessions by last activity or creation date alone.

Labels are the reader's current labels, not the labels a session had during the interval. A session with more than one label needs an accounting rule for that report. Keep unlabelled work visible. Keep null full totals, known priced subtotals, legacy estimates, model gaps, and request coverage as Arc reports them. List-price estimates are not subscription charges.

## Cache expiry and handoff

Arc reports context and prompt-cache evidence. The skill does not manage cache expiry, send keepalive prompts, compact sessions, or create durable handoffs automatically. [Lowering agent costs](lowering-agent-costs.md) owns continuation and handoff decisions.

A coordinator's handoff must retain the selected window, accepted session IDs, results, uncertain request IDs, and remaining reader decisions. Window reload changes the activation, so re-discover the window before new work. Saved session records and CLI reads do not restore a coordinator's own context.
