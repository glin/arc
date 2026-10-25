# Testing

## Verification

### VSIX candidate

Run `npm --prefix extension run build`, then `npm --prefix extension run package`, then `node extension/scripts/check-vsix.mjs`. The check reads the built VSIX and checks its files, identity, version, and bundle against the current build. The manual editor path is **Extensions: Install from VSIX** using `extension/arc.vsix`. The `VSIX candidate` workflow runs when started manually and when a `v*` tag is pushed. It runs the full test suite and stores a versioned VSIX with its SHA-256 checksum as a temporary Actions artifact. A manual run stops there, even when it runs on a tag. A tag push is described in [Release](installation.md#release).

`scripts/install-release.sh` is a standalone downloader for a tagged release. Run it with a version and one editor CLI, for example `bash install-release.sh 0.1.0 code`. Without an editor argument, it uses the sole detected editor or asks which detected editor to use. It does not need Node or a source checkout. Release assets must be named `glin.arc-<version>.vsix` and `glin.arc-<version>.vsix.sha256` under tag `v<version>`. Do not publish this command as an installation path until those assets exist.

The pre-commit hook in `.githooks/pre-commit` runs the format check and lint on the files a commit adds or changes. It runs Stylelint on fully staged files within the production CSS scope below. `npm install` at the repository root points Git at that folder through `core.hooksPath`, but only when this folder is the root of its Git repository. The hook skips a partly staged file with a warning, because its working copy holds edits outside the commit. It also skips a symbolic link. It takes each required tool from the checkout, or from the main worktree when the checkout lacks that tool. Stylelint keeps the checkout's configuration and resolves its shared configuration from the selected tool's installation. When neither has a required tool, it stops the commit.

Run formatting and lint checks from the repository root:

```bash
npm run format:check
npm run lint
```

`npm run lint` runs `lint:js` with Oxlint, then `lint:css` with Stylelint. `npm run lint:fix` applies Oxlint fixes. Oxfmt handles CSS formatting.

Stylelint checks only `extension/src/webview/*.css` with zero allowed warnings and the explicit root configuration in `.stylelintrc.cjs`. It excludes nested folders, generated output, fixtures, private agent files, and CSS embedded in TypeScript. The configuration extends `stylelint-config-recommended` and documents exceptions for selector organization, legacy accessibility clipping, and exact build placeholders. Property and value checks remain enabled. Host-provided VS Code custom properties need no local definitions.

Oxfmt covers root tooling, plugin hooks, CLI source and tests, extension build scripts, configuration, and current documentation. The root `.oxfmtrc.mjs` names each folder and root file that Oxfmt covers. Other files at the repository root, such as saved diagnostics and exported sessions, are not checked. Under `extension/src` it covers every file except `panel-shots.test.ts`, including `panel.css` and `webview/tsconfig.json`. It leaves generated output, dependencies, screenshots, fixtures, and private agent files unchanged. Oxfmt and Oxlint disable nested configurations, so saved configurations under private agent directories cannot change their scan scope. Run evidence belongs under its owning plan's `runs/` directory, or `.claude/plans/runs/` for tasks without plans. Git ignores the existing `.claude/plans/` tree. Oxlint checks `extension/src` and every other maintained source tree. The root `.oxlintrc.jsonc` names each folder and root file that Oxlint checks. Type-aware checks cover every package project.

Run the full test suite:

```bash
npm run test:all
```

`npm test` runs formatting, lint, typecheck, and direct unit tests in that order. `test:unit` runs root, extension, and CLI units sequentially. The default excludes cases tagged `subprocess`. Excluded discovery defers worker bundle builds. `npm run test:all` runs the default followed by all integration and browser categories. Run the complete command before handoff and after the final rebase or merge.

`npm run test:integration` runs root subprocess tests, extension integration tests, panel-mockup tests, and hook and CLI smoke tests sequentially. `npm run test:browser` runs every extension browser file. The CLI smoke command builds its bundle before running tagged CLI cases. `npm --prefix extension run test:node` runs every extension Node case. `node extension/test.mjs full` runs every extension Node and browser case. Named-file commands retain tagged and untagged cases unless the caller supplies a tag filter.

Root tests that start real processes carry the Vitest tag `subprocess`. The root tag supplies a 120 second test budget. Tagged hooks retain their own budget. A whole file uses `// @module-tag subprocess`. Other files tag individual tests or suites with `{ tags: ['subprocess'] }`. Each package enables strict tags. `test:root` and `test:subprocess` partition the root tests and exclude the hook smoke file. `test:smoke` owns that file. Each root subprocess runner starts independently and runs one file at a time, with at most two concurrent cases.

`scripts/test-lanes.test.js` checks category coverage, recursive relative-helper process discovery, deferred worker builds, and expensive-test admission. `scripts/test-admission.json` names each admitted file's failure boundary, case budget, and repetition identity. Added expensive cases and expanded matrices require an explicit admission update. Preserve corruption, installation, extraction, process identity, platform, accessibility, and browser interaction coverage. Input variations belong in direct tests when those tests reach the same failure.

The extension Node lane uses up to eight Vitest workers. The browser lane uses up to four. `VITEST_MAX_WORKERS` overrides both lane caps. Direct extension Vitest runs default to four workers. A machine-wide lock serializes browser lanes. Sixteen shared slots bound browser launches, including direct Vitest, IDE, and screenshot runs. Compare queue wait separately from execution time.

The GitHub workflow runs static checks, Node categories, and browser shards in parallel jobs. Its Node job runs `test:unit` and `test:integration`. Three browser jobs divide the browser files with Vitest's `--shard` flag. The VSIX candidate workflow runs `test:all` before packaging.

Run the readiness check and the stable four-worker browser lane with these commands:

```bash
npm exec -- vitest run scripts/extension-test-runner.test.js
npm --prefix extension run test:browser
```

Each browser process that waits for a shared slot prints `Browser test slot wait: <milliseconds> ms.` after it acquires one. The figure uses a monotonic clock and covers only time waiting for a slot. An immediate acquisition prints no wait line.

The shared browser launcher tries bundled Chromium, Edge, and Chrome in that order. Edge and Chrome on Windows record one failed sign-in for the Windows account on every launch, and one browser lane run reaches a lockout threshold of ten failures. Bundled Chromium leaves out the browser layer that makes that call. Edge and Chrome launches turn off the feature that makes the call. They also repeat Playwright's own `--disable-features` list, because Chromium keeps only the last copy of a switch. The comment on `BROWSER_CHANNELS` in `extension/test/browserchannels.mjs` links the browser defect reports. Each launch attempt has a ten-second timeout before the launcher tries the next channel. This bounds stalled launches before the panel-mockup scale test's sixty-second deadline.

A browser lane that waits for the machine-wide lock prints one line naming the PID, the extension directory, and the start time of the run holding it, once, when the wait begins. The lane prints a second line once it resumes, naming how long it waited. An immediate acquisition prints neither line.

### Test timing

The default, unit, integration, subprocess, and extension launchers print `Test timings: <path>` when each observed command ends. Isolated editor runs and panel startup measurements also report their timing file. Existing test commands retain their stage order and exit behavior.

`ARC_TEST_OBSERVATIONS_DIR` selects the artifact directory. Otherwise, artifacts use `arc-test-observations` under `ARC_TEST_MACHINE_TEMP` or the platform temporary directory. Nested commands inherit the selected artifact directory. Each request writes one JSONL file with its PID and run identity. Browser launches and temporary-directory setup write nested files without separate completion notices.

Each event carries `schemaVersion`, `runId`, `parentRunId`, `commit`, `cwd`, `lane`, `phase`, `event`, `elapsedMs`, `pid`, `command`, `workerCap`, `capacity`, and `exitCode`. The identity event records Node, platform, lockfile hashes, configuration hashes, browser registry metadata, and temporary-directory variables. Missing identities remain null. Browser launch events record the selected channel and available version. Registry metadata does not identify the executable of a fallback channel.

Queue, observed build, child lifetime, and cleanup intervals use monotonic clocks. A Vitest execution interval includes collection, internal builds, and teardown. Delegated stage walls also include nested waiting and startup. Unobserved build and execution boundaries remain unavailable. `wholeCommandWallMs` covers one observed request. Nested and overlapping durations must not be summed or subtracted to calculate pure execution.

Holder notices include their observation timestamp and duration since that holder was first observed. Earlier notices remain historical when the holder changes. Holder payload timestamps do not establish total holder duration. Queue order and position remain unavailable. Release events report lock or slot removal, without confirming descendant termination. Cleanup errors retain their observed result.

Coordination observations preserve `ARC_TEST_MACHINE_TEMP`, `TEMP`, `TMP`, and `TMPDIR`, including absent and empty values. Lane locks use `os.tmpdir()`. Browser slots use `ARC_TEST_MACHINE_TEMP` or `os.tmpdir()`. Vitest setup redirects temporary variables for its run while preserving its machine temporary directory. A nested lane lock that resolves inside a run directory excludes only callers using that directory. Windows, macOS, and Linux retain their existing temporary-path resolution.

Each file permits 1024 events and one MiB, including reserved terminal space. Oversized events and recording failures produce an explicit incomplete or unavailable report. Commands longer than 4096 bytes omit their text and mark recording incomplete. Recording failure preserves the test result. A writer that exits before settlement records an incomplete result when its exit handler runs. A killed writer supplies no terminal proof. Missing stages, failed cleanup, and unobserved descendants remain limits on interpretation.

The browser tests build the panel and measure it in bundled Chromium, Edge, or Chrome. The browser runner names the executable before the lane runs. If no supported browser launches, browser mode and full mode fail. Node mode remains available for iteration without a browser. Direct Vitest runs bypass this check and skip individual tests when no browser launches.

Build before opening the panel after changing its stylesheet, browser script, browser entry, or bundle input:

```bash
npm --prefix extension run build
```

Review browser shots before and after changes to panel styles or browser code:

```bash
npm --prefix extension run shots
```

## Test and capture implementation

`scripts/isolated-editor.mjs` installs candidate and disposable probe VSIX files into its isolated profile through the selected editor CLI. It pins the selected scratch directory to its physical path before creating run paths and discovering abandoned runs. macOS profile sockets require short scratch paths and run identifiers. It retains isolated registration manifests, editor logs, and process receipts before removal. It reads the installed Windows `bin/code.cmd` as data to select its matching CLI. Windows `mkdtemp` calls use namespace paths for long run directories. [Isolated extension host](isolated-editor.md#isolated-extension-host) owns supported layouts and launch directories.

`scripts/test-default.mjs` runs static checks and direct units sequentially. `scripts/test-unit.mjs` partitions root, extension, and CLI units. `scripts/test-integration.mjs` runs the complete external-boundary categories. `scripts/test-subprocess.mjs` starts root subprocess tests directly and shares child signal cleanup with the browser launcher. `scripts/test-classification.js` identifies admitted expensive tests and their repetition budgets. [Verification](#verification) owns test commands and category coverage.

`extension/test/observations.mjs` writes bounded JSONL timing files for test launchers and their existing resource boundaries. Parent run identities connect nested commands without combining their intervals. Lock and browser-slot observations retain the effective coordination paths and timestamped holders. Temporary-directory setup records environment changes. [Test timing](#test-timing) owns the schema, commands, and observation limits.

The portable review runner in `evals/agent-review/run.mjs` reads tracked case fixtures and current checkout instructions. It writes external workspaces, Codex execution records, adjudications, and reports for development comparisons. `portable/cohort.mjs` checks production exports, assigned inputs, qualification receipts, and final coverage separately. Its opt-in audited instruction bundle preserves default capture behavior. [The cohort guide](../evals/agent-review/cohorts/README.md) owns qualification and preparation commands. On Windows, `portable/live.mjs` selects the elevated native sandbox backend and checks read access and write denial before a paid launch. The frozen continuation command uses `portable/resume.mjs` to reconstruct unstarted cells from retained inputs and combine preserved adjudication with new decisions. Its Windows job host contains each paid attempt and terminates descendants when the host or its identified runner exits. Shared continuation ownership uses filesystem identity and prevents concurrent launches across output directories. Fatal condition stops persist beside that ownership and require matching completion evidence before another launch. Each derived execution must match its durable claim, terminal receipt, and final receipt. The historical importer in `evals/agent-review/cli.mjs` reads registered Arc commit objects into a separate bare cache. The developer recipe in `evals/agent-review/rebuild-corpus.mjs` rebuilds production exports from historical commits and a frozen instruction snapshot. These development tools sit outside the extension data flow. Their local workspaces do not certify semantic leakage or host access isolation.

## Build and host constraints

For source archives, set `ARC_SOURCE_COMMIT` using the source identity rules in [Build identity and packaging](installation.md#build-identity-and-packaging). Watch builds leave host and bundled CLI source identity unavailable across rebuilds.

- Extension activation must not walk and compare the snapshot store. Registration returns first. Cleanup runs later.
- `node_modules` cannot be shared across operating systems because esbuild is native. Install dependencies on the machine that runs the build.
- `packaging.test.ts` and `packaging.source.test.ts` spawn `node esbuild.mjs` directly, so everything the build imports must load under plain Node. `esbuild.mjs` loads `panelbundle.ts` through the scoped `tsx/cjs/api` require. Do not register a global TypeScript loader because Node 22 can reject the resulting ESM cycle.
- Browser tests are `panel.layout*.test.ts` or `*.browser.test.ts`. The node lane excludes them. The browser and full lanes run them through the built panel. They share `extension/test/browser.ts`, which uses an installed browser and gives each test a fresh context. Each page starts on the fixture's own clock, which stands at a fixed early afternoon in the local day. The session list files a session under a day by the browser's calendar, and the fixture reaches back further than one day. Time runs on from that instant at the rate of the real clock. A guard that waits for a cache band to end still sees it end.
- `extension/test.mjs` takes the machine-wide lock file `arc-browser-tests.lock` in the system temporary directory through `extension/test/browserlock.mjs`, before it detects a browser or spawns the browser lane, so at most one browser lane runs on the machine at a time regardless of worktree or checkout, except in a rare three-way race during stale-lock takeover. The lock file is published by linking it in from a fully written temporary file, which a plain create-then-write cannot do, so on a filesystem with hard links no reader ever observes it empty or partially written. A filesystem without hard-link support falls back to creating the lock file directly with an exclusive create, which can expose it empty or partially written for the moment between that file's creation and the write that fills it. A holder refreshes the file's mtime on a heartbeat while it runs. A live-owned lock is stale, and safe to take over, once the waiter's own polls have watched the file's mtime sit unchanged, on the waiter's monotonic clock, for the whole stale age. A lock whose owner process is no longer running, or whose owner record cannot be parsed, is stale at once. Retiring a stale lock renames it aside before a fresh one is published there. A rename that took the wrong file, because a fresh lock landed in the freed spot first, is restored by linking the retired file back onto the lock path, which fails instead of replacing anything already there, so a restore does not overwrite a lock currently in use except in that rare three-way race. A wait for the lock has a deadline and fails clearly past it.
- Every Vitest config lists `extension/test/temp-run.ts` as global setup. Before any worker starts, the setup points `TEMP`, `TMP` and `TMPDIR` at one new directory for the run, and its teardown removes that directory. A scratch file that a test, a child process or a browser writes to the temporary directory therefore goes with the run. A file that coordinates runs across the machine reads `ARC_TEST_MACHINE_TEMP` instead, which names the temporary directory from before the move. The browser slots do this. Run directories sit in `arc-test-runs` in the temporary directory, named for the process that owns them. A run that dies before its teardown leaves its directory there, and the next run removes it once that process has exited. `temproot.test.ts` fails when a Vitest config omits the setup.

## Timeline checks

Run the read-only Claude timeline sweep when a state needs checking:

```bash
npm --prefix extension run check:timeline -- --since 7d
```

The project defaults to the folder where the caller ran npm. Pass `--project <folder>` to select another project. Pass `--now <ISO-time>` to replay timestamped records at that time. Historical file write times remain unavailable. Violations exit with status 1. Invalid arguments or command failures exit with status 2.

## Handoff checks

In a shared checkout, another session can hold unformatted edits in files you do not own. A whole-repository format check then fails on their work. Format and check only your own files, then run the remaining steps of `npm run test:all` one by one:

```bash
npx oxfmt --config .oxfmtrc.mjs extension/src/panelhost.ts extension/src/panel.webview.test.ts
npx oxfmt --config .oxfmtrc.mjs --check extension/src/panelhost.ts extension/src/panel.webview.test.ts
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:browser
```

Run the full check after the final rebase or merge. Record the tested full commit SHA, checkout path, command, and exit status. A check of an earlier commit does not cover the landing candidate. After landing, run `npm run format:check` and `npm run lint` in the main checkout to check its local files.
