# Development workflow

Use this guide for local setup, worktree safety, checks, and performance capture.

## Dependencies

Use Node.js 20.19+ (20.x) or 22.12+. The extension targets the editor's Node runtime, while the source build uses newer packaging dependencies.

Install extension and CLI dependencies before building or testing:

```bash
npm install
npm --prefix extension install
npm --prefix cli install
```

`esbuild` is native. Install dependencies on the operating system that runs the commands. A `node_modules` tree copied from another operating system will not run it.

The source installer builds and installs the editor extension from local or temporary downloaded source. Its Claude plugin setup and legacy hook cleanup are described in [Snapshot model](architecture.md#snapshot-model). To exercise the optional Claude plugin from a checkout, run `claude --plugin-dir ./plugins/arc-hooks`. Validate the plugin and marketplace with `claude plugin validate --strict ./plugins/arc-hooks` and `claude plugin validate --strict .`.

The panel shots and their test write WebP files with the ImageMagick 7 `magick` command. Put `magick` on the `PATH` before running the full test suite.

## README screenshots

From `extension/`, run the README capture command:

```bash
npx tsx scripts/readme-shots.ts
```

The command builds the panel and writes the README images to `docs/images/`. Pass an output directory to keep comparison captures outside the repository. Edge, Chrome, or bundled Chromium and ImageMagick 7 must be available. Captures use a fixed clock, `en-US` locale, `America/Chicago` timezone, and two device pixels per CSS pixel. GPU rasterization is off.

The main image captures the exported web demo with its session list narrowed to 270 CSS pixels. The panel viewport is 1120 by 740 CSS pixels. The exported demo supplies the decorative VS Code title bar, activity strip, and Arc tab. The frame adds 16 CSS pixels of transparent spacing and a soft shadow. Its final image is 2372 by 1652 pixels. The capture hides the header through the shared shell stylesheet. The exported demo keeps its header and session list width.

The other captures use the production panel with synthetic Arc sessions and One Dark Pro Darker colors. Their session list is 380 CSS pixels wide. The review viewport is 1100 by 1000 CSS pixels and uses One column card layout. Session-menu, response-menu, and cache-expiry viewports are 1430 CSS pixels wide. Other viewports are 1350 CSS pixels wide. All are 700 CSS pixels tall except review. Cost and usage figures come from synthetic request records and limit readings. Menu captures use the stand-in from `extension/scripts/web-demo-menu.ts`, which reads the extension manifest and panel context. Browser version, operating system, and fonts affect rendering.

## Static web demo

Build the sample demo from the repository root:

```bash
npx tsx extension/scripts/web-demo.ts
```

Serve `.scratch-web-demo/site` as a static directory. Its relative assets work at the server root and under a project path such as `/arc/`. The page uses the packaged panel renderer, invented session data, and a fixed clock. `web-demo-shell.ts` and `web-demo-shell.css` supply its decorative editor frame. Narrow screens hide the activity strip and window title bar. The shell adds no keyboard stops. The panel and its fixed elements share the page viewport, so the demo stylesheet offsets the session list, sticky headings, prompt box, and usage bar. It has no agent connection. Selecting response text opens the production comment action. Comments support saving, editing, and deletion in page memory across session navigation. Reloading the page restores the sample comments. A right-click opens the same context menu stand-in with the entries the demo can answer in page memory. New session with the same labels and both Send entries perform no action. Run the browser boundary check with `node extension/test.mjs browser src/web-demo.browser.test.ts`.

### Updating the demo

Update `extension/scripts/readme-fixture.ts` for sample turns and relationships. Keep usage, request clocks, context totals, and parent edges consistent. The exporter uses the production panel bundle, view factories, text, and manifest menus.

Run the prompt-free catalog check from `extension/` with the folder used to launch Arc:

```bash
node --import tsx scripts/demo-catalog-check.ts --cwd <launch-folder>
```

Refresh stale snapshots with `--refresh`, then review their model and default changes. Offline export does not check catalog freshness.

Classify every `PanelToHost` message in `extension/scripts/web-demo-host.ts`. Add an adapter branch for each handled message. Keep agent launch, file, and terminal actions as silent no-ops. Context replies use the production normalizer and protocol parsers.

Run the fixture and interaction checks, then export the current source:

```bash
node extension/test.mjs node src/panel-shots.test.ts
node extension/test.mjs browser src/web-demo.browser.test.ts
npm --prefix extension run build
npx tsx extension/scripts/web-demo.ts
```

Inspect both providers' context detail, cache expiry, turn history, dispatched-session navigation, and existing interactions in dark and light themes at desktop and narrow widths. Run the [README capture command](#readme-screenshots) when a shared fixture changes a published scene. Retain original image bytes when only rasterization differs. New visible states need representative sample data and interaction checks. The protocol policy does not establish complete UI coverage.

## Panel-mockup link

`.agents/skills/panel-mockup` links to the skill under `.claude/skills/`. The link lets Codex find the same skill.

On Windows, enable links before checkout and create them with administrator rights or Developer Mode:

```powershell
git config core.symlinks true
```

Git writes a text file instead of the link when it cannot create links. Repair the link before using the skill.

## Worktree dependencies

`npm test` from a worktree root needs three dependency trees: `node_modules`, `extension/node_modules`, and `cli/node_modules`. A worktree that has only `extension/node_modules` cannot run the gate.

A worktree gets the three trees in one of two ways. It links each tree to the same tree in the main worktree after the main worktree has installed them. Or it runs the install commands in [Dependencies](#dependencies) inside the worktree.

A link changes what an install does. An install through a link changes the dependencies of the main worktree. A branch that changes `extension/package.json` or its lockfile therefore needs its own install. Remove the links in that worktree and install there.

Remove a link without following it. Use a command that deletes only the link. Never delete recursively through a link, because that empties the dependencies of the main worktree. Count the files under the link target before and after the removal, and confirm that the link is gone before removing the worktree.

VS Code loads the main worktree for manual testing. Land and build there before real-panel verification. When another checkout is loaded, verify the loaded worktree and bundle before panel validation.

To compare test results between two commits, run both in checkouts set up the same way, for example two worktrees with the same dependency links. A worktree and the main checkout differ in more than the commit, such as build output and dependency links, so a difference between them does not show that the commit caused it.

## Fast iteration

Run `npm run test:iterate` while you iterate. It runs typecheck and then the extension node lane.

Name the browser test files for the area you changed and run them directly with `node extension/test.mjs browser <files>`. Each named file narrows the lane to just that file, relative to `extension/` or to the repository root. A name that is not a browser test file fails with a clear message instead of running the whole lane.

After all edits, format your changes and run the tests once before handoff. In an isolated worktree, format the whole repository and run the full suite:

```bash
npm run format
npm test
```

In a shared checkout, another session can hold unformatted edits in files you do not own. A whole-repository format check then fails on their work. Format and check only your own files, then run the remaining steps of `npm test` one by one:

```bash
npx oxfmt extension/src/panelhost.ts extension/src/panel.webview.test.ts
npx oxfmt --check extension/src/panelhost.ts extension/src/panel.webview.test.ts
npm run lint
npm run typecheck
npm run test:unit
npm run test:smoke
```

Run the full check after the final rebase or merge. Record the tested full commit SHA, checkout path, command, and exit status. A check of an earlier commit does not cover the landing candidate. After landing, run `npm run format:check` and `npm run lint` in the main checkout to check its local files.

## Model pricing

`extension/src/pricing.ts` owns exact model definitions and explicit provider support. Its shared formulas serve the panel, Project cost, and status CLI.

1. Read primary pricing and cache-policy sources before adding a model or provider route.
2. Define the exact model identity, base rates, request threshold, fallback context window, and explicit sourced cache policy once.
3. Add explicit provider support beside that definition for every confirmed provider.
4. Specify each provider's accepted prefixes, regional multiplier, effective dates, fallback window, and explicit sourced cache policy.
5. Reuse shared rates only when published provider rates establish equivalence. Set a provider rate override when they differ.
6. Keep service tiers specific to their provider. Price recorded cache tokens without inferring caching support or a lifetime.
7. Extend the independent exhaustive support matrix in `pricing.test.ts` before adding any model or provider route. Include rates, request bands, tiers, windows, accepted identities, and cache policies.
8. Require documented duration, recorded duration, unsupported caching, or sourced unknown duration. Never infer duration from token-field names.
9. Add symptom regressions to the existing pricing and consumer tests. Include saved usage and both request bands.
10. Bump `PROJECT_SPEND_PARSER_GENERATION` in `projectspend.ts` when model support changes saved request bands or derived usage facts.
11. Bump `VERSION` in `derivedcache.ts` when model support changes saved session cost or context facts.
12. Remove the new provider support temporarily and run the symptom regressions. Also remove its policy, price, and independent route expectation separately. Require each guard to fail, then restore from plain backups.
13. Update exact model coverage in [Supported pricing](agent-cost-guide.md#supported-pricing). Update README provider summaries when provider coverage changes.
14. Check personal billing consumers against the same request evidence and Arc build. Record independent pricing behavior until each consumer uses Arc billing.
15. Run the focused tests and the verification commands in [Fast iteration](#fast-iteration).

## Verification

### VSIX candidate

Run `npm --prefix extension run build`, then `npm --prefix extension run package`, then `node extension/scripts/check-vsix.mjs`. The check reads the built VSIX and checks its files, identity, version, and bundle against the current build. The manual editor path is **Extensions: Install from VSIX** using `extension/arc.vsix`. The `VSIX candidate` workflow runs when started manually and when a `v*` tag is pushed. It runs the full test suite and stores a versioned VSIX with its SHA-256 checksum as a temporary Actions artifact. A manual run stops there, even when it runs on a tag. A tag push is described in [Release](#release).

`scripts/install-release.sh` is a standalone downloader for a tagged release. Run it with a version and one editor CLI, for example `bash install-release.sh 0.1.0 code`. Without an editor argument, it uses the sole detected editor or asks which detected editor to use. It does not need Node or a source checkout. Release assets must be named `glin.arc-<version>.vsix` and `glin.arc-<version>.vsix.sha256` under tag `v<version>`. Do not publish this command as an installation path until those assets exist.

The pre-commit hook in `.githooks/pre-commit` runs the format check and lint on the files a commit adds or changes. `npm install` at the repository root points Git at that folder through `core.hooksPath`, but only when this folder is the root of its Git repository. The hook skips a partly staged file with a warning, because its working copy holds edits outside the commit. It also skips a symbolic link. It takes the tools from the checkout, or from the main worktree when the checkout has none. When neither has them, it stops the commit.

Run formatting and lint checks from the repository root:

```bash
npm run format:check
npm run lint
```

Oxfmt covers root tooling, plugin hooks, CLI source and tests, extension build scripts, configuration, and current documentation. Under `extension/src` it covers every file except `panel-shots.test.ts`, including `panel.css` and `webview/tsconfig.json`. It leaves generated output, dependencies, screenshots, fixtures, and private agent files unchanged. Root formatting and lint commands disable nested configurations, so saved configurations under private agent directories cannot change their scan scope. Run evidence belongs under its owning plan's `runs/` directory, or `.claude/plans/runs/` for tasks without plans. Git ignores the existing `.claude/plans/` tree. Oxlint checks `extension/src` and every other maintained source tree. Type-aware checks cover every package project.

Run the full test suite:

```bash
npm test
```

`npm test` runs `format:check`, then lint, then typecheck, then the test suite, and stops at the first failing step. The test suite runs `test:unit` and then `test:smoke`. `test:unit` runs `test:root`, which holds the root Vitest files (`plugins`, `scripts`, `test`), then `npm run test:panel-mockup`, `extension/test.mjs` in full mode, and the CLI unit tests. `test:panel-mockup` runs the panel-mockup renderer tests from `.claude/skills/panel-mockup/vitest.config.mts`. `extension/test.mjs` runs the extension node lane and then the extension browser lane. `test:smoke` runs the hook smoke test and then the CLI smoke tests. Run a lane on its own with `npm --prefix extension run test:node` or `npm --prefix extension run test:browser`. The GitHub workflow runs the same steps as parallel jobs. One job runs the format check, lint and typecheck. One runs every Node test. Three each run a third of the browser lane files with the Vitest `--shard` flag. The node lane holds every extension test file that is not a browser file and runs it with up to 8 Vitest workers. The browser lane holds every `panel.layout*.test.ts` file and every `*.browser.test.ts` file and runs it with up to 4 Vitest workers. Both worker caps are explicit numbers in `extension/test.mjs`, not the Vitest default. `extension/vitest.config.ts` carries a floor of 4 workers for a Vitest run that bypasses `test.mjs`, such as an IDE runner or `npx vitest run` in `extension/`. The node lane's `--maxWorkers=8` flag overrides that floor. Two limiters bound the headless browsers a machine runs at once, and they bound different things. 16 machine-wide slots bound individual browser launches, so a direct Vitest run that bypasses `test.mjs`, an IDE runner, or the `shots` script, still launches its own browser and still competes for one of the 16.

Run the readiness check and the stable four-worker browser lane with these commands:

```bash
npm exec -- vitest run scripts/extension-test-runner.test.js
npm --prefix extension run test:browser
```

Each browser process that waits for a shared slot prints `Browser test slot wait: <milliseconds> ms.` after it acquires one. The figure uses a monotonic clock and covers only time waiting for a slot. An immediate acquisition prints no wait line.

The shared browser launcher tries Edge, Chrome, and bundled Chromium in that order. Each launch attempt has a ten-second timeout before the launcher tries the next channel. This bounds stalled launches before the panel-mockup scale test's sixty-second deadline.

A browser lane that waits for the machine-wide lock prints one line naming the PID, the extension directory, and the start time of the run holding it, once, when the wait begins. The lane prints a second line once it resumes, naming how long it waited. An immediate acquisition prints neither line.

The `panel.layout*.test.ts` files and the other browser files build the panel and measure it in Edge or Chrome. Each test skips when neither browser exists. Full mode names the browser executable it found before the browser lane runs, or states that the lane found no browser. Read the skip result after changing panel styles.

Build before opening the panel after changing its stylesheet, browser script, browser entry, or bundle input:

```bash
npm --prefix extension run build
```

Review browser shots before and after changes to panel styles or browser code:

```bash
npm --prefix extension run shots
```

The shots run fails with EPERM when its output directory sits inside a folder that a file sync client watches, and passes with an output directory outside the working tree.

Open the real panel after changing panel host options. Test a restored tab because stored host options are outside browser coverage.

## Release

`extension/package.json` owns the version. `scripts/release-version.js` copies it into the extension and CLI lockfiles, `cli/package.json`, and the Claude plugin manifest. The extension and CLI builds read it from their manifests. `scripts/release-version.test.js` fails when any holder disagrees.

1. Before the first release, keep `CHANGELOG.md` at `## 0.1.0 (Unreleased)` with `Initial release.`. After the first release, add user-visible changes under `## Unreleased`.
2. Run `npm run release -- X.Y.Z`. The script accepts the current version only when its changelog heading marks that version `(Unreleased)`. Otherwise, it requires a greater version. The changelog must have an unreleased section. The script sets the version and dates that section as `## X.Y.Z (YYYY-MM-DD)` in UTC. It opens an empty `## Unreleased` above it.
3. Run the two commands the script prints. They commit `chore(release): X.Y.Z` and tag `vX.Y.Z`.
4. Push the commit, then push the tag.

Generate hosted plugin candidate artifacts locally with `node scripts/package-claude-plugin.js release`. The ZIP contains the plugin manifest, hook definitions, and runtime scripts. Its catalog names the immutable versioned ZIP and SHA-256 digest. Candidate generation does not publish assets or establish real Claude cache acceptance.

The tag starts the `VSIX candidate` workflow. It fails when the tag differs from the `extension/package.json` version. Otherwise it builds the VSIX and checksum, plugin ZIP and digest, and hosted catalog. It creates a GitHub release for the tag with those artifacts. The release notes are the changelog section for that version. Only a tag push publishes a release.

## Build and host constraints

- Extension activation must not walk and compare the snapshot store. Registration returns first. Cleanup runs later.
- `node_modules` cannot be shared across operating systems because esbuild is native. Install dependencies on the machine that runs the build.
- `packaging.test.ts` spawns `node esbuild.mjs` directly, so everything the build imports must load under plain Node. `esbuild.mjs` loads `panelbundle.ts` through the scoped `tsx/cjs/api` require. Do not register a global TypeScript loader because Node 22 can reject the resulting ESM cycle.
- Browser tests are `panel.layout*.test.ts` or `*.browser.test.ts`. The node lane excludes them. The browser and full lanes run them through the built panel. They share `extension/test/browser.ts`, which uses an installed browser and gives each test a fresh context. Read their skip result when changing layout because they skip if a supported browser is unavailable. Each page starts on the fixture's own clock, which stands at a fixed early afternoon in the local day. The session list files a session under a day by the browser's calendar, and the fixture reaches back further than one day. Time runs on from that instant at the rate of the real clock. A guard that waits for a cache band to end still sees it end.
- `extension/test.mjs` takes the machine-wide lock file `arc-browser-tests.lock` in the system temporary directory through `extension/test/browserlock.mjs`, before it detects a browser or spawns the browser lane, so at most one browser lane runs on the machine at a time regardless of worktree or checkout, except in a rare three-way race during stale-lock takeover. The lock file is published by linking it in from a fully written temporary file, which a plain create-then-write cannot do, so on a filesystem with hard links no reader ever observes it empty or partially written. A filesystem without hard-link support falls back to creating the lock file directly with an exclusive create, which can expose it empty or partially written for the moment between that file's creation and the write that fills it. A holder refreshes the file's mtime on a heartbeat while it runs. A live-owned lock is stale, and safe to take over, once the waiter's own polls have watched the file's mtime sit unchanged, on the waiter's monotonic clock, for the whole stale age. A lock whose owner process is no longer running, or whose owner record cannot be parsed, is stale at once. Retiring a stale lock renames it aside before a fresh one is published there. A rename that took the wrong file, because a fresh lock landed in the freed spot first, is restored by linking the retired file back onto the lock path, which fails instead of replacing anything already there, so a restore does not overwrite a lock currently in use except in that rare three-way race. A wait for the lock has a deadline and fails clearly past it.
- Every Vitest config lists `extension/test/temp-run.ts` as global setup. Before any worker starts, the setup points `TEMP`, `TMP` and `TMPDIR` at one new directory for the run, and its teardown removes that directory. A scratch file that a test, a child process or a browser writes to the temporary directory therefore goes with the run. A file that coordinates runs across the machine reads `ARC_TEST_MACHINE_TEMP` instead, which names the temporary directory from before the move. The browser slots do this. Run directories sit in `arc-test-runs` in the temporary directory, named for the process that owns them. A run that dies before its teardown leaves its directory there, and the next run removes it once that process has exited. `temproot.test.ts` fails when a Vitest config omits the setup.

## Environment overrides

Six variables move roots that Arc otherwise derives from the home directory. Arc-specific overrides take precedence over vendor homes. An empty vendor home counts as unset.

| Variable | Moves | Default |
| --- | --- | --- |
| `ARC_HOME` | The Arc store home. Snapshots sit below it, and the cache sits beside them | `~/.arc` |
| `ARC_PROJECTS_ROOT` | Where Arc reads Claude Code transcripts | `~/.claude/projects` |
| `ARC_CODEX_ROOT` | Where Arc reads Codex rollouts | `~/.codex/sessions` |
| `ARC_IGNORE_ROOTS` | The paths a turn writes for itself, which no diff shows. Entries are separated like `PATH` entries. An empty value disables the rule | the temporary directory, Claude Code home, Codex home, and Arc home |
| `CLAUDE_CONFIG_DIR` | The Claude Code home. Arc reads transcripts from `projects` below it and ignores agent-owned files below it | `~/.claude` |
| `CODEX_HOME` | The Codex home. Arc reads rollouts from `sessions` below it and ignores agent-owned files below it | `~/.codex` |

`ARC_PROJECTS_ROOT`, `ARC_CODEX_ROOT`, and `ARC_IGNORE_ROOTS` win when their related vendor home is also set. Arc reads these values from the editor process environment.

## Live panel development

Start the extension build watcher and the local Vite server from the repository root:

```bash
npm --prefix extension run dev
```

Wait for the ready message. Open this checkout in VS Code. Press F5 and select `Run Arc Extension`. The launch opens this checkout in an Extension Development Host and loads the nested `extension` package. Open Arc in that window. A CSS save patches the open panel in place. A Preact component save asks the extension host to replace only the webview document. A full Vite reload and a server reconnect use the same replacement path. The reload restores the selected session, unsent prompt, and scroll position after the initial render lays out. It also replaces the complete browser lifetime, so old handlers, timers, observers, subscriptions, roots, and message listeners do not remain active.

The launch passes the checkout as a positional folder argument on Windows. Do not use `${workspaceFolder}` with `--folder-uri`, because VS Code keeps the Windows path instead of creating a file URI. If F5 reuses a development host without a folder, stop debugging and close that host before starting again.

The development server binds to `127.0.0.1:5173` with a strict port. A port conflict stops the command. Stop the conflicting process, then run the command again. A panel opened while the server is down shows the command that restores it and reloads when the server returns. A syntax error leaves the last working panel active during an update. Fix and save the source to recover. Close and reopen the panel or restore an editor tab to confirm both paths reconnect.

Extension-host source saves rebuild `extension/dist/extension.js`. Reload the Extension Development Host to apply them. The panel does not present extension-host changes as hot updates.

This workflow supports a local Windows Extension Development Host. Remote extension hosts and port-forwarded development servers are unsupported. The webview loads its loopback address on the local VS Code machine, while a remote command binds on the remote machine.

Run `npm --prefix extension run build` after development. The production build restores the inline script, inline stylesheet, strict content policy, and offline operation. It contains no Vite client or development network request.

## Isolated extension host

Run this command from the repository root when a test needs fresh VS Code settings and no installed extensions.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\launch-isolated-extension.ps1 -Repository .
```

The script builds Arc, creates unique user-data and extensions directories under the temporary directory, and opens this checkout in a new window. A separate extensions directory prevents the installed OpenAI extension and other extensions from starting beside Arc. Pass `-SkipBuild` only when `extension/dist` already contains the build under test. The script prints both temporary paths. Close the window before deleting its run directory.

## Performance capture

Start performance investigations with a bounded system diagnostics capture. Use the script for requests to capture performance diagnostics. Save the capture before reloading the editor or restarting Explorer. Record the scenario and active test runners beside the capture. Use the same collector and comparable workloads for later measurements.

For a Windows capture, run:

```powershell
.\scripts\capture-panel-diagnostics.ps1 -Scenario "<scenario>" -Samples 8 -SampleIntervalSeconds 1
```

For a Windows, Linux, or macOS capture, run:

```bash
node scripts/capture-panel-diagnostics.js --scenario "<scenario>" --samples 8 --sample-interval-seconds 1
```

Keep active windows and sessions running during script captures.

Collect additional snapshots or profiles only for an explicit request or a question the system capture cannot answer.

Reload the VS Code window before recording an extension profile. Run `Developer: Show Running Extensions`, start the Extension Host profile from that editor, stop it, and save the profile.

Use `Developer: Open Webview Developer Tools` and record the Performance tab for session list scrolling, typing, and paint. Capture the Extension Host and webview profiles for the same scenario. Capture matching session list-open and session list-closed scenarios. Record the commit, dirty state, pin count, and spend-ledger state beside each capture.

`Developer: Profile Local Agent Host Process` profiles a different process. Do not use it as an Extension Host profile.

An Extension Host profile samples one JavaScript thread. It reads as mostly idle while the webview or a worker thread holds a core, so an idle host profile cannot identify the process causing high CPU use. Read the startup milestones before the profiles. `arc.savePerformanceDiagnostics` writes them. `firstCard` follows the first turn card drawn and acknowledged by the browser. A large gap after `railReady` directs investigation toward selected-session reading or rendering. The two milestones alone do not identify which one delayed the card. On Windows the extension host runs as `Code.exe --utility-sub-type=node.mojom.NodeService`, and the workbench and each webview run as `Code.exe --type=renderer`.

`arc.savePerformanceDiagnostics` takes the file to write as its first argument, so an automated run captures a snapshot without the save dialog. Call it as `vscode.commands.executeCommand('arc.savePerformanceDiagnostics', file)` and read the path it answers with. It answers with nothing when the write fails, and the reason reaches both the window and the diagnostics log under `performanceCaptureFailed`. That line is written whatever `arc.diagnostics.log` says, so a run with nobody at the window still learns why. `ARC_PERF_OUT_DIR` holds a directory for a run that passes no argument, and every capture writes its own stamped file there. An argument wins over the variable. A relative path is read against the open folder. A window with no folder open refuses a relative path and names it, because the writer takes the path as given. A capture aimed by the variable names the file it wrote in a message, because that run opens no dialog. A run with neither opens the dialog.

The diagnostics log records where each panel came from under `panelAdopted`. `created` is a panel the open command made, `serializer` is a tab the editor restored after a window reload, and `serializer-replaced` is the panel Arc opens after it disposes a restored tab whose stored options were stale. A restored tab with current options is adopted even while a panel is already open, and the panel that was open is disposed. A stale restored tab that arrives while a panel is already open is disposed with no replacement, and the panel already open is revealed. Every reveal of a panel that is already open records `panelRevealed` under the origin that panel was adopted with. Read those lines before a startup measurement, because the panels start from different places. The log writes them while `arc.diagnostics.log` is on.

The collector writes repository, editor, process, memory, CPU, storage, bundle, and settings diagnostics. The manifest records the platform, collector path and hash, configured sampling duration, elapsed capture time, and collection errors. The default output directory sits under the system temporary directory. Pass `--output-directory <path>` to retain a capture inside its investigation plan. The directory must not already exist. These local files can contain sensitive command-line arguments and paths. Review them before sharing.

Windows runs the existing PowerShell collector. Direct invocation of `scripts/capture-panel-diagnostics.ps1` remains available with `-Scenario`, `-Samples`, `-SampleIntervalSeconds`, and `-OutputDirectory`. Machine snapshots include boot time, memory commitment, pool use, logon-session count, LSASS handles, sandbox-user last logon, and GUI quotas. The quota snapshot reads the registry value or the Windows default of 10000 when the value is absent. Process rows include command lines, paths, parents, handle counts, and GDI and USER counts. The performance-counter CSV includes whole-machine CPU and every process, including numbered instances. An invalid sample retains its status and has no value. Do not sum process counters to infer whole-machine CPU utilization.

Windows findings highlight quota pressure, Explorer graphics growth, large or growing handle counts, orphaned Git `find` processes, high memory commitment, and unavailable readings. GDI and USER values count objects owned by a process. Positive growth alone does not establish a leak. Explorer quota pressure includes Task Manager restart instructions for temporary relief. A restart reloads the taskbar and File Explorer windows. It does not identify the allocation source.

Linux and macOS use Node.js, `ps`, and platform memory counters. They require no PowerShell installation. Linux reads `/proc/meminfo` and preserves paging counters from `/proc/vmstat` and device counters from `/proc/diskstats`. macOS preserves `vm_stat` output with its reported page size and `sysctl vm.swapusage`. `performance-counters.json` records machine samples and CPU utilization derived from system CPU-time deltas. CPU readings remain unavailable when no valid interval exists. Linux commitment estimates have separate names because their overcommit rules differ from Windows commitment. Free memory and available memory remain separate measurements. macOS does not infer available memory from free pages.

Non-Windows manifests mark Windows diagnostics as `not-applicable`. GDI, USER, GUI quotas, LSA sessions, and sandbox-account checks do not run on those platforms. Their absence produces no Windows-counter warnings. Process deltas require the same PID and start time. Unix `ps` start times have one-second precision, so a PID reused within that second cannot be distinguished. Editor paths follow each platform's configuration directory. Both Unix platforms record installed bundle hashes for VS Code, VS Code Insiders, and Cursor.

Measure startup against frozen inputs with `extension/scripts/panel-startup-measure/measure.ts`. Run it from `extension`:

```bash
npx tsx scripts/panel-startup-measure/measure.ts --fixture <manifest.json> --commit <ref>
```

The manifest names `workspace`, `projects`, `codex`, `store`, and `state` paths beneath its own directory. State must name the selected session through `showing`. `expectedSelection` supplies its `session`, newest turn `key`, `prompt`, and `summary` text. Missing expectations leave the result incomplete. Freeze transcript roots, cache inputs, and selected session before comparison. The workspace must resolve no Git repository. Inputs containing directory links or external transcript paths fail validation. The runner reads no live editor database. It retains only navigation and filtering state and removes pending agent actions.

Every run creates unique profile, extensions, Arc store, state, and build directories. The browser lane lock serializes editor measurements with browser tests. `--commit` selects the source revision. Without it, the runner builds HEAD in an isolated checkout. Dependencies are linked without installing. The measured editor blocks agent connections before activation and opens Arc through the created-panel route. Older baselines receive the same measurement-only launch block and state seed. This overlay is recorded with the artifact identity.

The runner records owned paths, frozen input hashes, artifact hash, and process identities. `result.json` retains completion, observations, clocks, and the selected identity. It stops only processes belonging to its unique profile. `--timeout <seconds>` bounds the wait for all startup milestones and defaults to 30 seconds. Completion received after the deadline remains incomplete. `completeRender` acknowledges background session-list completion after discovery and metadata settle. Accepted browser observations must show usable session-list rows and the selected turn. Raw response identity stays separate from rendered response text or the folded card headline. Missing milestones or observations produce an incomplete result and nonzero exit. Shell and empty-list acknowledgments do not establish usable content.

Add `--selection` to collect session-switching evidence through the isolated editor's local CDP endpoint. A measurement overlay records complete panel message payloads, bytes, refreshes, worker requests, execution, cancellation, synchronous file operations, draws, and subsequent animation frames. The driver clicks selected A, opens B, and alternates retained A/B after both selected windows finish. Ordinary scenarios wait for accepted completed content and its corresponding frame. An observed pending B request permits an interruption attempt. Final identified window events and conservative clock bounds determine whether B remained pending at the browser click. Ambiguous overlap remains unavailable. Browser events keep native monotonic timestamps. Clock exchanges bound browser-to-host and worker-to-host offsets by transport intervals.

Selection evidence lives in `selection.json` and `selection-trace-*.jsonl` under the printed run directory. The overlay copies message payloads and performs synchronous trace writes, so its timings include recording overhead. File traces retain descriptor ownership through successful open and close, numeric read counts, and encoded string byte lengths. Asynchronous file operations and compositor presentation remain unavailable. Missing stages, unmatched request chains, and inconsistent clock identities remain incomplete. Explicit cancellation supplies a terminal status without requiring a successful reply. Unobserved cached work remains unavailable. Untagged browser messages retain absent click ownership. The runner returns an incomplete result until independent review qualifies the evidence and representative frozen inputs. Synthetic inputs establish transport and correlation behavior, without establishing live workspace latency.

`--keep` retains the build checkout. Other run resources remain available for inspection. Cleanup uses the junction-safe worktree helper under the local reference skills. A cleanup refusal ends the run without a retry. `ARC_MEASURE_EDITOR` selects a VS Code install directory. Compare repeated runs with identical inputs, settings, selection, and imports. Shared machine workload and operating-system disk cache remain measurement limits.
