# Session skills and snapshot hooks

[Session guidance](arc-sessions.md#use-the-skill-in-arc) explains command names, existing skills, and disabled settings.

## Checks before startup and input

Arc checks optional skills and hooks before starting a process for live sessions, recovery, replacement, or idle discovery. Processes started only to rename a session receive neither. Arc fixes the environment and bundled release before launch. Windows configuration-home selection remains case-insensitive through launch. Running processes keep their release across extension updates.

Claude loads the skill plugin and snapshot plugin separately through repeated `--plugin-dir` arguments. Both plugins come from the same immutable release. Arc reads settings once before choosing them. The running Claude process must report version `>=2.1.310 <3.0.0` in its initialize response.

Claude's `get_settings` response must contain readable `effective` and `applied` objects and an array of source objects. Arc accepts `userSettings`, `projectSettings`, `localSettings`, `flagSettings`, and `policySettings`. Each source must pass the same settings checks. A `policySettings` source must also use only top-level keys from a reviewed list in [`sessionskills.ts`](../extension/src/sessionskills.ts). The list holds no key that restricts plugins, skills, hooks, marketplaces, or plugin directories. Inside `permissions`, a policy can set only `allow`, `additionalDirectories`, `disableBypassPermissionsMode`, and `disableAutoMode`. Inside `env`, a policy can set only `CLAUDE_CODE_ENABLE_TELEMETRY`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DO_NOT_TRACK`, `BETA_TRACING_ENDPOINT`, `ENABLE_BETA_TRACING_DETAILED`, and names that start with `OTEL_` or `CLAUDE_CODE_OTEL_`, in that exact case. Any other policy key or variable refuses both optional plugins. When no other settings check refuses first, the check names the key as `policySettings:unreviewed-policy-key:<key>` or the variable as `policySettings:unreviewed-policy-env:<name>`. The check never names a value. An unknown settings source refuses both optional plugins with the `unsupported-settings-layer` check. Arc never changes native settings or enables disabled components at launch.

Claude marketplace declarations in `extraKnownMarketplaces` accept GitHub, Git, URL, and directory sources. Arc checks installed plugins separately for existing skills and snapshot commands. Inline or unknown marketplace sources prevent automatic loading.

An installed plugin without `.claude-plugin/plugin.json` takes its name from its registration and its components from its marketplace catalog entry, as in Claude. Arc reads the catalog of a directory marketplace in that directory. Arc reads the catalog of a GitHub or Git marketplace under its `installLocation` in `known_marketplaces.json`, at the marketplace source's `path` when one is set. Arc reads each catalog at most once per check. A catalog may hold 1 MiB, and all catalogs together 4 MiB. Arc checks the default skill, command, and hook locations and every `skills`, `commands`, and `hooks` value in the entry. A skill or command named `arc-sessions` in any letter case counts as an existing definition on every platform. For a GitHub or Git marketplace, a missing catalog, an unreadable or oversized catalog, or a catalog that does not list the plugin exactly once withholds the skill and the hooks with the `unreadable-plugin-catalog` reason. Arc finds the root of a plugin from a directory marketplace through that catalog. So the same catalog failures in a directory marketplace, or an entry without a relative source, withhold the skill and the hooks as an uncertain configuration, and the error names the catalog file. An entry path outside the plugin withholds only the skill. Entry hooks in a form other than an inline event map without a `hooks` wrapper withhold only the hooks. Each of these refusals names the plugin and the catalog file as its check. When Arc cannot locate the catalog, the check names `known_marketplaces.json`.

After preparing attachments, Arc repeats settings and file-identity checks before sending the first input. Competing first writes run one at a time. Cancelled attempts cannot authorize later prompts. Arc checks generation, cancellation, guards, and reservations synchronously beside the write. This applies to text, files, guarded input, local commands, and effort commands. Processes with hooks alone receive the same checks as processes with the skill.

Arc repeats these checks when refreshing the displayed skill list, including notifications received during a refresh. Confirmed removal of Arc's Codex skill root allows the same process to continue normally. Uncertain registration or removal blocks further input. An unsupported method reported before registration leaves ordinary startup available in that process.

Each optional Codex setup or refresh has one 15-second deadline across trailing notifications and retains output limits. Claude's running check is part of the opening and shares the opening deadline. When the settings check or the release recheck of a running Claude process refuses its plugins while a live session opens, Arc closes that process before any input. After that process exits, Arc opens the session in a new Claude process without the session plugins, and the prompt goes to that process. The opening fails when the session closes first, or when the process is still running 5 seconds after Arc ends it. A refusal at the recheck before the first input of an opened process still refuses that input. Codex starts no replacement process, and neither provider resends delivered input to repair optional skill discovery.

When a managed policy prevents Arc from supplying its skill or snapshot hooks, the session opens without them. The fallback is a personal install with `bash install.sh --skill-agent claude --hooks`. [Snapshot installation](installation.md#snapshot-installation) covers hook setup and storage. [Install the parts you need](arc-sessions.md#install-the-parts-you-need) covers what a personal install does under policy.

When Arc withholds the skill or the hooks from a process, it writes a `sessionComponentsWithheld` line to the diagnostics log, even with `arc.diagnostics.log` off. The line names the provider, the stage, each withheld component with its reason, and the working directory. It also names the failed check when one exists. For a failed provider request, the line names the request method and, when the provider sends one, its error code. It never names the provider's error text. A Claude process writes at most one line at launch and one line while running. A Codex process writes each distinct reason and failed check once, until Arc admits the skill again. A Codex process that closes during its check writes nothing. The line can contain local paths. The [system capture](performance.md#system-capture) copies these lines from every kept log, and `arc.openDiagnosticsLog` opens the current log file in `ARC_HOME/logs`.

## Snapshot hook requirements

Arc checks personal settings, ancestor settings, main-worktree settings, inline hooks, and applicable plugins. Directory marketplaces resolve their selected source. Any existing `arc-hooks` registration or setting prevents Arc from adding session hooks, including disabled registrations and registrations from another marketplace.

Direct hooks and renamed plugins also prevent automatic hooks when they contain either Arc capture command. Arc checks default hook files, manifest-selected paths, and inline declarations. Malformed or unreadable declarations prevent hooks from loading without preventing the session skill.

`disableAllHooks`, `allowManagedHooksOnly`, unsupported hook settings, and restrictions on `--plugin-dir` prevent automatic hooks. A refusal in any raw personal settings source remains effective.

Hooks require an external Node.js runtime from the environment Arc will pass to Claude. Arc rejects relative PATH entries, runtimes whose canonical paths lie within the project, and unsupported Node versions. Executable symlinks qualify when their canonical targets remain outside the project.

Nonempty `NODE_*` variables in the inherited environment or settings prevent automatic hooks. Malformed settings environments also prevent hooks without preventing the skill. Windows environment names compare without case, and conflicting aliases prevent hooks. macOS and Linux preserve case. Arc runs the Node version check with the selected environment.

Each prepared process reuses a successful Node version check while executable filesystem identity, working directory, platform, and checked environment agree. Arc selects the runtime again after reading Claude's settings and before the first input. A changed executable identity requires another version check.

When Arc omits hooks, it skips later Node checks and hook-configuration scans. Complete release validation still checks the bundled hook declaration. An inherited Node environment that prevents hooks does not prevent ordinary launch or the session skill.

## Codex skill registration

Codex initializes before Arc requests fresh raw skill discovery and effective settings. Arc reads `config/read` with layers and `configRequirements/read`. Personal settings and an empty system layer qualify. Managed layers, non-null requirements, malformed entries, and ambiguous skill paths prevent automatic skill loading.

Arc treats absent `skills` and `skills: null` as no skill configuration. It still checks discovered skills before registration.

Any existing matching raw skill entry prevents registration, including an enabled link to the selected definition. After registration, Arc retains only the exact enabled Arc-owned entry. Arc registers only its immutable root through `skills/extraRoots/set` and requires an empty object acknowledgment.

Arc repeats skill discovery and settings checks before start, resume, or fork. Idle processes open no thread.

## Platform checks

Windows checks cover skill discovery and registration without prompts, plus loading both Claude session plugins. They do not establish native snapshot event dispatch. Native macOS and Linux checks and authenticated instruction loading remain separate acceptance requirements. All platforms use the same selection rules. [`sessionskills.ts`](../extension/src/sessionskills.ts) owns static and settings checks.

## Codex skill attachment

Arc reads `skills/list` in the process's working directory. Connected `skills/changed` notifications force a reload in that directory. Failed refreshes retain autocomplete entries but do not permit attachments from stale paths. [`codexwire.ts`](../extension/src/codexwire.ts) owns refresh scheduling and attachment preparation.

Arc resolves invocations from the raw skill list before autocomplete drops enabled state and directory identity. It attaches `{ type: 'skill', name, path }` only for one enabled, unambiguous working-directory entry. The browser supplies neither canonical name nor path.

Input waits for discovery and trailing refreshes and retains its order through writing. Invalidation immediately prevents skill attachment. Stop cancels preparation before input. Native controls take priority. An attachment requests instructions without guaranteeing model compliance.

## Claude skill list

Claude's `system/init` skill list arrives after its first prompt. An idle process used only for control requests never receives it. [`panelhost.ts`](../extension/src/panelhost.ts) owns the stored working-directory list used as a fallback.

Use `sessionskills.test.ts`, `claudewire.test.ts`, `codexwire.test.ts`, and `agenthost.test.ts` for selection, refresh, and first-write races.
