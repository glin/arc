# Arc sessions for agents

The `arc-sessions` skill lets a Claude Code or Codex agent start, inspect, and organize requested work through a running Arc window. The reader reviews those sessions in the panel and continues them through the Prompt box.

## The four components

| Component | Job | Installation |
| --- | --- | --- |
| Arc extension | Displays sessions and connects to agent CLIs. Includes `arc` launchers for Arc sessions and new integrated terminals. | Source installer or an available VSIX. |
| Standalone Arc CLI | Makes `arc` available to ordinary shell commands. | Local npm tarball from the [CLI build instructions](../cli/README.md#build-from-source). |
| `arc-sessions` skill | Gives an agent instructions for bounded session work through the CLI. | Source installer, explicit CLI setup, or a manual copy or link. |
| `arc-hooks` Claude plugin | Captures first-touch file snapshots for Claude file diffs. | Source installer or Claude plugin marketplace. |

The skill source is [`cli/skills/arc-sessions/SKILL.md`](../cli/skills/arc-sessions/SKILL.md). `SKILL.md` links to reference files beside it, and every artifact and installation carries them. The source installer, the bundler, and the skill payload loader refuse a skill that lacks a file `SKILL.md` links. The standalone CLI package includes the directory under `skills/arc-sessions`. The VSIX includes the canonical skill directory under `dist/tools/skills/arc-sessions`, with its paths and digests in the tool identity. The Claude plugin does not include the skill.

Bundled files are part of an artifact. An installed skill exists in an agent's skill directory. A release requires publication of the corresponding artifact. None of these states establishes the others.

## Install the parts you need

`install.sh` builds and installs the editor extension. It also sets up the optional Claude plugin unless passed `--no-hooks`. Both default source installations copy matching plugin bytes into managed storage. Local source selects the checkout bytes. Remote source resolves its ref before downloading. Existing checkout marketplaces require [one-time recovery](development.md#legacy-checkout-plugin-recovery).

A VSIX installs the extension. Claude marketplace installation selects `arc-hooks`, not the CLI or session skill. [Installer testing](development.md#isolated-installer-tests) owns local plugin commands. Session commands use Arc's local window channel without requiring Claude hooks. Codex records come from its rollouts.

Arc has no editor command named **Arc: Install CLI**. To update the standalone CLI, build a current source checkout and install its tarball. [CLI installation](../cli/README.md#install) owns the commands and Node requirements. npm publication is deferred, so a registry `latest` install is not an available release path.

The source installer selects detected Claude and Codex executables by default. Explicit `--skill-agent claude` and `--skill-agent codex` select personal copies without requiring those executables. `--no-skills` skips this invocation's skill setup. `--no-hooks` excludes only hooks. The explicit `arc skills install`, `arc skills update`, and `arc skills remove` commands accept repeatable `--agent claude` or `--agent codex`. Claude Code uses `~/.claude/skills/arc-sessions`. Codex uses `~/.agents/skills/arc-sessions`, independently of `CODEX_HOME`. A nondefault `CLAUDE_CONFIG_DIR` refuses Claude skill setup. Managed and custom discovery setups require a separately maintained manual installation. Installation never changes provider policy or enables disabled skills. Restart the agent session after installation.

Arc copies regular files and publishes `SKILL.md` after resources finish. Existing manual copies and links remain user-owned. Install preserves an exact stable external copy with `external-match-preserved`. Matching links, redirected folders above the home folder, temporary copies, copies inside the executing payload, and unresolved temporary roots produce an incomplete result without takeover. A personal skills folder that is a link, or that sits under a linked `~/.claude` or `~/.agents`, is never written through. Setup reports `linked` when the skill at the link's target has exactly the bundled files. When the target is the other agent's skills folder, the result says that this agent reads that folder. A `linked` result there also covers a readable skill that a person made or edited, and says that no action is needed. The command exits 0. An `incomplete` result there names the other agent's install command when the skill is missing. It names the other agent's update command when Arc owns a copy that differs from the bundled files. When invalid ownership bindings or retained setup files in the other agent's setup storage would make those commands refuse, the result gives manual recovery directions in their place. An entry with no readable `SKILL.md` also gives `incomplete`, such as an empty folder, an ordinary file, or a link that leads nowhere. That result says what is there and that Arc will not replace it, and it asks the person to move or delete it and then run the other agent's install command. That install command replaces an install record whose copy a person moved or deleted. When the target is any other folder, setup reports `incomplete` for a missing or different skill and names the packaged skill folder and the destination to copy or link it to. Setup writes the folders that are not linked first, so one run that selects both agents installs the skill and then reports the link. Removal leaves a linked folder unchanged. When the target is the other agent's skills folder, the result says that no action is needed and names no command, even when that setup storage is blocked. It says the skill is not there when that folder holds no readable `SKILL.md`. When the target is any other folder, the result says to remove the copy at the target by hand. Removing the skill from a folder that a link also serves says that the other agent loses it too. Update and removal require unchanged Arc-owned files. Added files, edited files, unfamiliar ownership, and retained interrupted operations refuse destructive changes. [Manual skill installation](../cli/README.md#session-skill) provides Windows junction and macOS/Linux link commands.

The third-party [Vercel skills CLI](https://github.com/vercel-labs/skills#readme) also supports local paths, named skills, and both agents. From an Arc checkout, these commands list the skill, then install it:

```sh
npx skills add ./cli/skills --list
npx skills add ./cli/skills --skill arc-sessions --global --agent claude-code --agent codex
```

Use the explicit `cli/skills` directory because the repository nests the skill beneath `cli`. Repository-root discovery requires `--full-depth`. `npx skills` installs skill files. It does not install the Arc CLI, extension, or Claude plugin.

Arc does not inject skill instructions into agent prompts. The agent discovers installed skills through its native skill directories. Both providers list skill metadata and load the full instructions when the skill activates. Explicit invocation uses `/arc-sessions` in Claude Code or `$arc-sessions` in Codex. The agent also selects relevant skills from their descriptions, subject to provider configuration. [Claude skill guidance](https://code.claude.com/docs/en/skills) and [Codex skill guidance](https://learn.chatgpt.com/docs/build-skills) own discovery, selection, and context-loading behavior.

## Manual recovery

A skill result with `publication` names the completed installation, update, or removal. An `incomplete` status still requires cleanup when files or locks remain. Cancellation preserves that publication result and the first signal's exit status.

An interrupted operation retains uncertain files and locks. Arc never takes ownership through a timeout, PID check, or heartbeat. Establish that every participating installer and descendant has stopped before changing retained files. Stop when any participant remains unknown.

Use the canonical `control` and `operation` paths in the CLI result. The Claude control folder is `~/.claude/skills.arc-skill-control`. The Codex control folder is `~/.agents/skills.arc-skill-control`. Each contains `ownership.json`, optional `installed.json`, and matching `software.lock` and `destination.lock` files. An operation folder is `operation-TOKEN`. Its `journal.json` names the exact `destination`, `stage`, `backup`, source digest, complete file digests, and previous directory identity. `claim.json` identifies a replacement directory when present. `seal.json` marks settled work.

Preserve a separate byte copy of every retained file before recovery. Compare the lock tokens, journal token, canonical paths, directory device/inode/birth identities, and complete file sets. Compare each file's SHA256 with the journal. Preserve added files, edits, links, and identities that differ. Never remove a foreign destination to restore a backup.

Preserve a completed publication when `installed.json` matches the journal token, destination identity, and complete new file digests. Cleanup failures retain this publication and its ownership. Never remove that destination to restore a backup whose cleanup has begun. Preserve partially removed backups and uncertain cleanup files for manual review.

For an uncommitted operation, restore `backup` to the journal's `destination` only when the destination is absent and every previous identity and digest matches. A replacement destination requires its exact `claim.json` identity and unchanged published bytes before manual removal. Preserve the backup when either check fails. Restore `installed.json` only from the same operation's verified `previous` entry. When `previous` is absent, remove `installed.json` only if its token and complete destination bytes identify this operation.

Retire the stopped operation only after restoration and every identity and byte check succeeds. Remove its unchanged remaining stage files and empty stage directories. Remove its verified `claim.json`, `journal.json`, and matching `seal.json` when present, then its empty `operation-TOKEN` directory. Remove only the exact `software.lock` and `destination.lock` files whose paths and unchanged tokens match that journal. Keep `ownership.json`, restored `installed.json`, other operations, and the separate recovery copies. Retry the original skill command after retirement. Preserve all records when ownership or participant shutdown remains uncertain. There is no automatic recovery command.

Ordinary `claude -p` loads the same configured context as an interactive session, including available skills unless disabled. By default, `--bare` skips automatic skill discovery. [Claude programmatic guidance](https://code.claude.com/docs/en/headless) owns bare-mode exceptions. Context use depends on listed metadata and activated instructions. Loading the skill does not authorize session starts or create an automatic workflow. The agent must receive a request authorizing the work it starts.

An ordinary CLI session can coordinate work when its shell finds `arc` and the intended Arc window is ready. The extension supplies its own launcher environment to panel-started agents. [Agent runtime](agent-protocols.md#runtime-shape) owns that environment.

## Example requests

Ask an agent to summarize work in the current window:

```text
Use Arc to summarize the sessions labelled Review in this window. Read their completed turns. Report results, blockers, and decisions needing my input.
```

Authorize a session with a specific task:

```text
Use Arc to start a Codex session reviewing this branch. Name it Branch review, apply Review, and pin it. Read its result and summarize its findings.
```

Direct the agent to save a handoff before compaction:

```text
After saving the handoff, request compaction of this session after your response.
```

A compaction request does not establish completed compaction. [CLI compaction requests](cli-reference.md#compaction) define admission and outcome states.

## Collect data for a report

Use `arc collect` for scoped pagination and optional recent turns. The caller selects the query and interprets the returned observations. [Collection output](cli-reference.md#collection) defines references, outcomes, recovery, and limits. The command requires an explicit window selection and changes no session state.

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
7. To continue a session the coordinator started, follow the skill's [follow-up rules](../cli/skills/arc-sessions/followup.md).
8. Apply only authorized labels and pins, using `--dry-run` first. Archive only sessions that the skill's [archive authority](../cli/skills/arc-sessions/SKILL.md#manage-a-bounded-set) covers. [Session management](cli.md#session-management) owns what a forced archive admits and keeps.
9. Leave the requested continuation session available. The reader opens it and sends the next prompt through its Prompt box.

`arc start --arc-dispatch` emits the parent-link receipt for `accepted` and `accepted-with-errors` results that include a session ID. Basic starts require no personal dispatch script. Personal dispatch workflow receipts link sessions. Personal dispatch workflows own durable callback claim/ack outside Arc to track callback ownership and acknowledgement. The receipt does not provide that state. Arc supplies neither detached callbacks nor a cross-provider peer inbox.

Python and shell coordinators both invoke the same CLI. The skill's [command rules](../cli/skills/arc-sessions/SKILL.md#select-the-command) own reader ownership and `--agent-run`. Run `arc --help` and `arc COMMAND --help` for command syntax. [CLI contracts](cli-reference.md) define delivery outcomes and session data. [Session management](cli.md#session-management) explains archive rules and uncertain launches.

The skill's [delivery rules](../cli/skills/arc-sessions/SKILL.md#interpret-delivery) define what a result establishes. Keep a session available for reader continuation when that is part of the task.

Personal `ship` and `dispatch` skills define their own implementation and review workflows. Arc does not package them. The session skill does not automatically review changes, send corrections, rotate coordinator context, or supervise workers continuously. `arc send` queues an explicit reader-requested message or delivers an observed follow-up to a session the requester started. [Session management](cli.md#session-management) owns when Arc accepts it.

## Named session links

An agent reports a known session with a named Markdown link:

```markdown
[name](arc-session:<id>)
```

Links open only inside the live extension panel that contains the invoking session. The [skill's reporting rules](../cli/skills/arc-sessions/links.md) define identity sources, label escaping, destination encoding, scope, and plain-text fallbacks.

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

Replace `WINDOW_ID` with the selected window's `hostId`. Confirm `scopeReady` and `panelReady` before proceeding. When the listing returns a `next` cursor, run `arc sessions --window WINDOW_ID --cursor NEXT --json` until `next` is `null`. Replace `SESSION_ID` with a complete, nonnull ID from that scoped listing. Never abbreviate the action target. If the list is empty, skip the session read and pin dry run. Reads leave reader attention unchanged, and the pin dry run writes no state. Preserve incomplete or unknown results when reporting the check.

[Window discovery](cli-reference.md#windows) defines capability output and observed access diagnostics. [Window selection](cli.md#windows) defines stale activation handling. The [skill](../cli/skills/arc-sessions/SKILL.md#select-a-ready-window) applies these limits before agent actions.

An optional launch check sends paid agent requests and requires reader authorization. Choose the cheapest suitable offered settings for one Claude session and one Codex session. `arc setups` prints readable choices. For structured choices, use `arc setups --window WINDOW_ID --json`. Reusable rows appear in `setups`, with `key` and `provider`. Use a row for the intended provider, and exclude rows with `missingValue`.

A provider without a reusable row still has explicit choices in `agents`. Select its `provider`, then a model's `models[].value`, that model's string-array `efforts`, and the provider's string-array `permissions`. Model choices are values, not setup keys. A fresh project has no guaranteed reusable row for either provider. If `modelsPending` is true or no model is offered, wait for catalog loading and read setups again. [Setups](cli-reference.md#setups) defines empty values and the output fields.

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

Arc supplies raw session and cost data. The agent assembles any report by label, parent, or time. Arc has no report dashboard, label accounting, or report schedule. The skill's [cost rules](../cli/skills/arc-sessions/costs.md) define pagination, child costs, intervals, and label accounting.

## Cache expiry and handoff

Arc reports context and prompt-cache evidence. The skill does not manage cache expiry, send keepalive prompts, compact sessions, or create durable handoffs automatically. [Lowering agent costs](lowering-agent-costs.md) owns continuation and handoff decisions.

A coordinator's handoff must retain the selected window, accepted session IDs, results, uncertain request IDs, and remaining reader decisions. Window reload changes the activation, so re-discover the window before new work. Saved session records and CLI reads do not restore a coordinator's own context.

## Read acknowledgments

The skill's [read rules](../cli/skills/arc-sessions/read.md) define the reader authority that marking a bounded set read requires. [CLI read acknowledgments](cli-reference.md#read-acknowledgments) define receipt, retry, source-change, and publication behavior.
