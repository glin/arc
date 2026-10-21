# Development workflow

Use this guide for local setup, worktree safety, checks, and performance capture.

## Dependencies

Use Node.js 22.12+. The extension targets the editor's Node runtime, while the source build uses newer packaging dependencies.

Install extension and CLI dependencies before building or testing:

```bash
npm install
npm --prefix extension install
npm --prefix cli install
npm --prefix extension exec -- playwright-core install chromium-headless-shell
```

The last command installs Playwright's bundled Chromium in the per-user Playwright cache, outside the repository. The browser tests and screenshot scripts use it first. [Verification](#verification) gives the reason.

`esbuild` is native. Install dependencies on the operating system that runs the commands. A `node_modules` tree copied from another operating system will not run it.

The source installer builds and installs the editor extension from local or temporary downloaded source. Its Claude plugin setup and legacy hook cleanup are described in [Snapshot model](architecture.md#snapshot-model). To exercise the optional Claude plugin from a checkout, run `claude --plugin-dir ./plugins/arc-hooks`. Validate the plugin and marketplace with `claude plugin validate --strict ./plugins/arc-hooks` and `claude plugin validate --strict .`.

The panel shots and their test write WebP files with the ImageMagick 7 `magick` command. Put `magick` on the `PATH` before running the full test suite.

A built source tree exposes durable source setup helpers. The VSIX prepares private commands automatically. Each command performs only its named operation. Command installation leaves PATH configuration unchanged.

```bash
node extension/dist/setup.cjs --commands
node extension/dist/setup.cjs --snapshots
```

The source installer uses the checkout marketplace for local development. Downloaded source uses the built snapshot helper to preserve matching hooks in durable storage. `--remote` forces download for development testing. `--repo` and `--ref` select the downloaded source. `--marketplace-url` explicitly selects an independently published HTTPS catalog. `--no-hooks` skips Claude plugin setup and legacy cleanup. Skill selection is independent and uses the matching built CLI. [Skill installation](arc-sessions.md#install-the-parts-you-need) owns its selectors and destinations.

When the installer reports component outcomes, it uses readable text by default. `--json` renders those outcomes as the final structured output line. Help and early argument or prerequisite refusals omit that result. Hook-only preflight failures preserve admitted editor and skill work. Exit 0 means selected work succeeded or preserved an exact stable external skill. Exit 2 means global argument or prerequisite refusal before installation. Exit 1 means incomplete requested work. Delivered HUP, INT, and TERM preserve statuses 129, 130, and 143. The shell records cancellation and awaits its unreaped skill child before deleting temporary source. No platform/runtime forwarding branch has native graceful-delivery acceptance, so handlers wait without forwarding. Automated disposable-home checks do not establish authenticated native skill discovery.

## Panel screenshots

The ordinary command captures the full state matrix in both default themes under `extension/shots`:

```bash
npm --prefix extension run shots
```

One positional destination retains the full matrix outside plan directories:

```bash
npm --prefix extension run shots -- /path/to/shots
```

Positional destinations reject adjacent `.claude/plans` components regardless of letter case on Windows, macOS, and Linux. Existing redirected or unreadable ancestors also refuse before browser launch or file writes. Exported `shoot` with its default writer and direct `writeLosslessWebp` calls check the actual target's parent and refuse existing file links before capture. Shot names that reach plan directories also refuse before replacement or page setup. These checks provide no filesystem sandbox or protection against concurrent path replacement.

Explicit owner options select bounded capture through the checkout-local adapter:

```bash
npm --prefix extension run shots -- --owner PLAN --run RUN --reservation BYTES --shots wide,narrow
```

Owner, run, and reservation options are required together. Omit `--shots` for `wide,narrow`. Unknown, duplicate, missing, or mixed positional options fail. The adapter requires an existing In progress owner and a fresh run identifier. Select at most eight unique names from the existing shot list. Each selected state produces dark and light images. The byte reservation must exceed 8192 and stay within 10000000, including terminal receipt headroom. Whole-owner budgets and metadata reservations also apply. The command awaits terminal completion and preserves partial images on failure or cancellation. A checkout without the private adapter refuses owner captures without starting the legacy matrix. Default and safe positional captures need no private adapter.

## README screenshots

From `extension/`, run the README capture command:

```bash
npx tsx scripts/readme-shots.ts
```

The command builds the panel and writes the README images to `docs/images/`. Pass an output directory to keep comparison captures outside the repository. Bundled Chromium, Edge, or Chrome and ImageMagick 7 must be available. Captures use a fixed clock, `en-US` locale, `America/Chicago` timezone, and two device pixels per CSS pixel. GPU rasterization is off.

The main image captures the exported web demo with its session list narrowed to 270 CSS pixels. Its capture data omits sample comments, including the Prompt box count. The panel viewport is 1120 by 740 CSS pixels. The exported demo supplies the decorative VS Code title bar, activity strip, and Arc tab. The frame adds 16 CSS pixels of transparent spacing and a soft shadow. Its final image is 2372 by 1652 pixels. The capture hides the header through the shared shell stylesheet. The exported demo keeps its header and session list width.

The other captures use the production panel with synthetic Arc sessions and One Dark Pro Darker colors. Comment captures show the selection editor and the saved comment list beside response text. Their session list is 380 CSS pixels wide. The review and files viewports are 1100 by 1000 CSS pixels and use One column card layout. The files image crops the Commits and Files sections and adds 18 CSS pixels of surrounding panel background. Session-menu, response-menu, and cache-expiry viewports are 1430 CSS pixels wide. Other viewports are 1350 CSS pixels wide. All are 700 CSS pixels tall except review and files. Cost and usage figures come from synthetic request records and limit readings. Menu captures use the stand-in from `extension/scripts/web-demo-menu.ts`, which reads the extension manifest and panel context. Browser version, operating system, and fonts affect rendering.

## Static web demo

Build the sample demo from the repository root:

```bash
npx tsx extension/scripts/web-demo.ts
```

Serve `.scratch-web-demo/site` as a static directory. Its relative assets work at the server root and under a project path such as `/arc/`. The page uses the packaged panel renderer, invented session data, and a fixed clock. `view/static-shell.ts` and `webview/static-shell.css` supply its decorative editor frame. Narrow screens hide the activity strip and window title bar. The shell adds no keyboard stops. The panel and its fixed elements share the page viewport, so the demo stylesheet offsets the session list, sticky headings, prompt box, and usage bar. It has no agent connection. `Export session as HTML...` in the saved-session menu downloads the selected invented session and its reachable agent and reader-started sessions. Each download opens offline as one HTML file. The download uses the saved-session export restrictions. Selecting response text opens the production comment action. Comments support saving, editing, and deletion in page memory across session navigation. Back and Forward use the mouse navigation buttons. Keyboard navigation uses Alt+Left and Alt+Right on Windows, Ctrl+- and Ctrl+Shift+- on macOS, and Ctrl+Alt+- and Ctrl+Shift+- on Linux. These shortcuts leave editable fields unchanged. Reloading the page restores the sample comments. A right-click opens the same context menu stand-in with the entries the demo can answer in page memory. New session with the same labels and both Send entries perform no action. Run the browser boundary check with `node extension/test.mjs browser src/web-demo.browser.test.ts`.

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

`.agents/skills/panel-mockup` and `.agents/skills/isolated-editor` link to the skills of the same names under `.claude/skills/`. The links let Codex find the same skills.

On Windows, enable links before checkout and create them with administrator rights or Developer Mode:

```powershell
git config core.symlinks true
```

Git writes a text file instead of the link when it cannot create links. Repair the link before using the skill.

## Worktree dependencies

`npm run test:all` from a worktree root needs three dependency trees: `node_modules`, `extension/node_modules`, and `cli/node_modules`. A worktree that has only `extension/node_modules` cannot run the gate.

A worktree gets the three trees in one of two ways. It links each tree to the same tree in the main worktree after the main worktree has installed them. Or it runs the install commands in [Dependencies](#dependencies) inside the worktree.

A link changes what an install does. An install through a link changes the dependencies of the main worktree. A branch that changes `extension/package.json` or its lockfile therefore needs its own install. Remove the links in that worktree and install there.

Remove a link without following it. Use a command that deletes only the link. Never delete recursively through a link, because that empties the dependencies of the main worktree. Count the files under the link target before and after the removal, and confirm that the link is gone before removing the worktree.

The owner's VS Code loads the main worktree. A check in the owner's window therefore needs the change landed and built there, and the owner performs it. When the owner's window loads another checkout, the owner confirms the loaded worktree and bundle first. An agent checks a worktree build in the [isolated editor](#isolated-extension-host), which loads the checkout it names.

To compare test results between two commits, run both in checkouts set up the same way, for example two worktrees with the same dependency links. A worktree and the main checkout differ in more than the commit, such as build output and dependency links, so a difference between them does not show that the commit caused it.

## Fast iteration

Run `npm run test:iterate` while you iterate. It runs the direct unit lanes. Run `npm test` to include static checks.

Run the read-only Claude timeline sweep when a state needs checking:

```bash
npm --prefix extension run check:timeline -- --since 7d
```

The project defaults to the folder where the caller ran npm. Pass `--project <folder>` to select another project. Pass `--now <ISO-time>` to replay timestamped records at that time. Historical file write times remain unavailable. Violations exit with status 1. Invalid arguments or command failures exit with status 2.

Check a change with the cheapest method that reaches it, in the order `CLAUDE.md` gives. A change that needs a real VS Code window goes to the [isolated editor](#isolated-extension-host).

Name the browser test files for the area you changed and run them directly with `node extension/test.mjs browser <files>`. Each named file narrows the lane to just that file, relative to `extension/` or to the repository root. A name that is not a browser test file fails with a clear message instead of running the whole lane.

After all edits, format your changes and run the tests once before handoff. In an isolated worktree, format every covered file and run the full suite:

```bash
npm run format
npm run test:all
```

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

## Model pricing

`extension/src/pricing.ts` owns exact model definitions and explicit provider support. Its shared formulas serve the panel, Project cost, and status CLI.

1. Read primary pricing and cache-policy sources before adding a model or provider route. Check effort-change retention for each exact model identity and provider route. For Claude Code, consult [Changing effort level](https://code.claude.com/docs/en/prompt-caching#changing-effort-level).
2. Define the exact model identity, base rates, request threshold, fallback context window, and explicit sourced cache policy once.
3. Check `effortChangeKeepsCache` independently of `cachePolicy`. General prompt-cache support does not establish retention after an effort change. Set `true` only when primary retention evidence covers the whole pricing row. Use an exact-identity `RegExp` when primary evidence covers only part of the pricing row. Leave the field absent when primary evidence does not establish retention.
4. Preserve detectable route exclusions. Undetectable routes retain the direct-model policy. Record conflicting primary evidence as a route-detection limitation. Missing route signals do not establish a direct route.
5. An absent retention policy returns false. A false result does not establish provider rejection.
6. Add explicit provider support beside that definition for every confirmed provider.
7. Specify each provider's accepted prefixes, regional multiplier, effective dates, fallback window, and explicit sourced cache policy.
8. Reuse shared rates only when published provider rates establish equivalence. Set a provider rate override when they differ.
9. Keep service tiers specific to their provider. Price recorded cache tokens without inferring caching support or a lifetime.
10. Extend the independent exhaustive support matrix in `pricing.test.ts` before adding any model or provider route. Include rates, request bands, tiers, windows, accepted identities, cache policies, and effort-change retention.
11. Extend existing independent effort-change policy tests for exact identities, dated snapshots, context suffixes, broad-row exceptions, and detectable provider routes.
12. Require documented duration, recorded duration, unsupported caching, or sourced unknown duration. Never infer duration from token-field names.
13. Add symptom regressions to the existing pricing and consumer tests. Include saved usage and both request bands.
14. Bump `PROJECT_SPEND_PARSER_GENERATION` in `projectspend.ts` when model support changes saved request bands or derived usage facts.
15. Bump `VERSION` in `derivedcache.ts` when model support changes saved session cost or context facts.
16. Remove the new provider support temporarily and run the symptom regressions. Also remove its cache policy, price, and independent route expectation separately. Remove the new effort-change retention policy and its independent expectation separately. Also widen each exact-identity retention pattern. Require each guard to fail, then restore from plain backups.
17. Update exact model coverage in [Supported pricing](agent-cost-guide.md#supported-pricing). Update README provider summaries when provider coverage changes.
18. Check personal billing consumers against the same request evidence and Arc build. Record independent pricing behavior until each consumer uses Arc billing.
19. Run the focused tests and the verification commands in [Fast iteration](#fast-iteration).

## Verification

### VSIX candidate

Run `npm --prefix extension run build`, then `npm --prefix extension run package`, then `node extension/scripts/check-vsix.mjs`. The check reads the built VSIX and checks its files, identity, version, and bundle against the current build. The manual editor path is **Extensions: Install from VSIX** using `extension/arc.vsix`. The `VSIX candidate` workflow runs when started manually and when a `v*` tag is pushed. It runs the full test suite and stores a versioned VSIX with its SHA-256 checksum as a temporary Actions artifact. A manual run stops there, even when it runs on a tag. A tag push is described in [Release](#release).

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

Root tests that start real processes carry the Vitest tag `subprocess`. The root tag supplies a 120 second test budget. Tagged hooks retain their own budget. A whole file uses `// @module-tag subprocess`. Other files tag individual tests or suites with `{ tags: ['subprocess'] }`. Each package enables strict tags. `test:root` and `test:subprocess` partition the root tests and exclude the hook smoke file. `test:smoke` owns that file. The root subprocess runner takes its machine-wide lock and runs one file at a time, with at most two concurrent cases.

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

The browser tests build the panel and measure it in bundled Chromium, Edge, or Chrome. The browser runner names the executable before the lane runs. If no supported browser launches, browser mode and full mode fail. Node mode remains available for iteration without a browser. Direct Vitest runs bypass this check and skip individual tests when no browser launches.

Build before opening the panel after changing its stylesheet, browser script, browser entry, or bundle input:

```bash
npm --prefix extension run build
```

Review browser shots before and after changes to panel styles or browser code:

```bash
npm --prefix extension run shots
```

The shots run fails with EPERM when its output directory sits inside a folder that a file sync client watches, and passes with an output directory outside the working tree.

## Release

`extension/package.json` owns the version. `scripts/release-version.js` copies it into the extension and CLI lockfiles, `cli/package.json`, and the Claude plugin manifest. The extension and CLI builds read it from their manifests. `scripts/release-version.test.js` fails when any holder disagrees.

1. Before the first release, keep `CHANGELOG.md` at `## 0.1.0 (Unreleased)` with `Initial release.`. After the first release, add user-visible changes under `## Unreleased`.
2. Run `npm run release -- X.Y.Z`. The script accepts the current version only when its changelog heading marks that version `(Unreleased)`. Otherwise, it requires a greater version. The changelog must have an unreleased section. The script sets the version and dates that section as `## X.Y.Z (YYYY-MM-DD)` in UTC. It opens an empty `## Unreleased` above it.
3. Run the two commands the script prints. They commit `chore(release): X.Y.Z` and tag `vX.Y.Z`.
4. Push the commit, then push the tag.

Generate hosted plugin candidate artifacts locally with `node scripts/package-claude-plugin.js release`. The ZIP contains the plugin manifest, hook definitions, and runtime scripts. Its catalog names the immutable versioned ZIP and SHA-256 digest. Candidate generation does not publish assets or establish real Claude cache acceptance.

The tag starts the `VSIX candidate` workflow. It fails when the tag differs from the `extension/package.json` version. Otherwise it builds the VSIX and checksum, plugin ZIP and digest, and hosted catalog. It creates a GitHub release for the tag with those artifacts. The release notes are the changelog section for that version. Only a tag push publishes a release.

## Build and host constraints

For source archives, set `ARC_SOURCE_COMMIT` using the source identity rules in [Architecture](architecture.md#module-boundaries). Watch builds leave host and bundled CLI source identity unavailable across rebuilds.

- Extension activation must not walk and compare the snapshot store. Registration returns first. Cleanup runs later.
- `node_modules` cannot be shared across operating systems because esbuild is native. Install dependencies on the machine that runs the build.
- `packaging.test.ts` and `packaging.source.test.ts` spawn `node esbuild.mjs` directly, so everything the build imports must load under plain Node. `esbuild.mjs` loads `panelbundle.ts` through the scoped `tsx/cjs/api` require. Do not register a global TypeScript loader because Node 22 can reject the resulting ESM cycle.
- Browser tests are `panel.layout*.test.ts` or `*.browser.test.ts`. The node lane excludes them. The browser and full lanes run them through the built panel. They share `extension/test/browser.ts`, which uses an installed browser and gives each test a fresh context. Each page starts on the fixture's own clock, which stands at a fixed early afternoon in the local day. The session list files a session under a day by the browser's calendar, and the fixture reaches back further than one day. Time runs on from that instant at the rate of the real clock. A guard that waits for a cache band to end still sees it end.
- `extension/test.mjs` takes the machine-wide lock file `arc-browser-tests.lock` in the system temporary directory through `extension/test/browserlock.mjs`, before it detects a browser or spawns the browser lane, so at most one browser lane runs on the machine at a time regardless of worktree or checkout, except in a rare three-way race during stale-lock takeover. The lock file is published by linking it in from a fully written temporary file, which a plain create-then-write cannot do, so on a filesystem with hard links no reader ever observes it empty or partially written. A filesystem without hard-link support falls back to creating the lock file directly with an exclusive create, which can expose it empty or partially written for the moment between that file's creation and the write that fills it. A holder refreshes the file's mtime on a heartbeat while it runs. A live-owned lock is stale, and safe to take over, once the waiter's own polls have watched the file's mtime sit unchanged, on the waiter's monotonic clock, for the whole stale age. A lock whose owner process is no longer running, or whose owner record cannot be parsed, is stale at once. Retiring a stale lock renames it aside before a fresh one is published there. A rename that took the wrong file, because a fresh lock landed in the freed spot first, is restored by linking the retired file back onto the lock path, which fails instead of replacing anything already there, so a restore does not overwrite a lock currently in use except in that rare three-way race. A wait for the lock has a deadline and fails clearly past it. `scripts/test-subprocess.mjs` takes the same lock through the same module with its own lock file `arc-subprocess-tests.lock` and a three hour wait deadline, so the root subprocess lane and the browser lane do not block each other.
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

This workflow runs in the owner's own VS Code window. An agent uses the [isolated editor](#isolated-extension-host) instead.

Wait for the ready message. Open this checkout in VS Code. Press F5 and select `Run Arc Extension`. The launch opens this checkout in an Extension Development Host and loads the nested `extension` package. Open Arc in that window. A CSS save patches the open panel in place. A Preact component save asks the extension host to replace only the webview document. A full Vite reload and a server reconnect use the same replacement path. The reload restores the selected session, unsent prompt, and scroll position after the initial render lays out. It also replaces the complete browser lifetime, so old handlers, timers, observers, subscriptions, roots, and message listeners do not remain active.

The launch passes the checkout as a positional folder argument on Windows. Do not use `${workspaceFolder}` with `--folder-uri`, because VS Code keeps the Windows path instead of creating a file URI. If F5 reuses a development host without a folder, stop debugging and close that host before starting again.

The development server binds to `127.0.0.1:5173` with a strict port. A port conflict stops the command. Stop the conflicting process, then run the command again. A panel opened while the server is down shows the command that restores it and reloads when the server returns. A syntax error leaves the last working panel active during an update. Fix and save the source to recover. Close and reopen the panel or restore an editor tab to confirm both paths reconnect.

Development hosts select the watch build's `dist/bin` commands without requiring a production package identity. CLI source saves update `dist/cli.cjs`. Extension-host source saves rebuild `extension/dist/extension.js`. Reload the Extension Development Host to apply them. The panel does not present extension-host changes as hot updates.

This workflow supports a local Windows Extension Development Host. Remote extension hosts and port-forwarded development servers are unsupported. The webview loads its loopback address on the local VS Code machine, while a remote command binds on the remote machine.

Run `npm --prefix extension run build` after development. The production build restores the inline script, inline stylesheet, strict content policy, and offline operation. It contains no Vite client or development network request.

## Isolated extension host

`scripts/isolated-editor.mjs` launches the installed VS Code with a fresh profile, loads Arc from a checkout or an installed candidate VSIX, and drives the window through Playwright. Agents use it to check a change in a real editor. It never touches the owner's own VS Code windows.

Build the checkout first with `npm --prefix extension run build`. Then run a check script:

```bash
node scripts/isolated-editor.mjs run check.mjs --screenshot shot.png
```

Keep the check script outside the checkout or in an ignored folder. Its default export receives `app`, `page`, `arc`, `createDraft`, and `run`. `app` is the Playwright Electron application. `page` is the workbench window. `arc` is the panel frame that holds `textarea#prompt`. The prompt box stays hidden until a session or draft is selected. `createDraft({ agent })` presses New session, chooses the agent, presses Create draft, and returns the prompt box. `run` names the run's directories. Locate controls by role and accessible name, as `createDraft` does.

```js
export default async ({ createDraft }) => {
  const prompt = await createDraft({ agent: 'Claude' });
  await prompt.fill('Hello');
  return prompt.inputValue();
};
```

The last line of output is one JSON object with `ok`, the `run` directory, the editor's `mainPid`, the script's return `value`, `screenshot`, `errors`, and the `cleanup` report. The command exits with 0 only when the run and its cleanup both succeed. A failed run still writes the requested screenshot when the window exists.

| Option | Effect |
| --- | --- |
| `--timeout <seconds>` | Bounds the run once the browser lane lock is held. The default is 300. The wait for the lock has its own ten-minute deadline |
| `--repository <checkout>` | Loads that checkout's `extension` folder and its `playwright-core`. The default is the checkout that holds the script |
| `--vsix <candidate.vsix>` | Installs the candidate into the run's isolated profile and extensions directory. Omits development mode and requires isolated data |
| `--probe-extension <directory>` | Packages and installs a disposable probe extension through the selected editor CLI. Requires `--vsix` |
| `--editor <install directory>` | Selects the VS Code install. `ARC_MEASURE_EDITOR` does the same when the option is absent |
| `--workspace <folder>` | Opens that folder instead of the empty run workspace |
| `--scratch <directory>` | Creates the run directory there instead of at the platform default |
| `--live-data` | Keeps the owner's transcript roots and lets Arc start agents |
| `--allow-focus` | Keeps the editor's own window focus behavior |

The run and its sibling evidence directory stay at the pinned scratch location. Each run creates its own `arc-isolated-editor-<id>` directory with user data, an extensions directory, an Arc home, transcript roots, and a workspace. The extensions directory excludes the owner's installed extensions. Candidate checks record current Arc installation in `vsix-install.json` and probe installation in `probe-vsix-install.json`. Each installation copies the candidate into `installations` and passes that archive to the editor CLI. Its receipt digest identifies those archive bytes. The run manifest keeps their digests separate. Probe packaging uses a separate staging directory and archive for each start. Packaging refuses linked source manifests and every linked ancestor, including system temporary aliases. Pass a physical source path when an alias exists. Before cleanup removes an installed run, its sibling evidence directory retains these receipts, installation archives, `run.json`, available extensions registration manifests, and editor logs. Retention refuses linked destination ancestors and files. The cleanup report names that directory and its retained file hashes. A retention failure keeps the run directory. The profile settings turn off workspace trust, telemetry, updates, the startup editor, and AI features, so no Restricted Mode banner or sign-in prompt appears.

macOS creates default runs under `/private/tmp/arc-ie-<uid>`, with the user ID in hexadecimal. Default creation and automatic cleanup discovery refuse links, linked ancestors, foreign owners, and modes other than `0700` at that location. Run identifiers use twelve random hexadecimal characters on macOS and a UUID on Windows and Linux. The complete macOS profile socket path must fit within 103 UTF-8 bytes, including its filename. An oversized explicit scratch path stops before the run directory or editor starts. Windows and Linux default to the system temporary directory. Without `--scratch`, macOS cleanup searches both its private default and the system temporary directory. Explicit scratch selection searches only the selected directory.

Windows starts the installer and editor from the selected installation directory. That directory must use an absolute drive path shorter than 260 characters. Profile, extension, workspace, and candidate arguments remain absolute. macOS and Linux use the run directory. The Windows CLI accepts flat resources or a ten-hexadecimal version directory selected by the standard launcher. Unsupported or ambiguous launcher forms stop installation. Without a launcher, only the flat layout applies. The CLI file must remain inside the installation and be readable. macOS uses the bundle's `Contents/Resources/app/out/cli.js`. Linux uses `resources/app/out/cli.js` beside the executable.

The editor's environment drops every variable whose name starts with `VSCODE`, `ELECTRON`, `ARC_`, `CLAUDE`, `NODE_OPTIONS`, or `GIT_`, in any letter case. Arc gives the agents it starts `ELECTRON_RUN_AS_NODE=1`, and VS Code started with that variable runs as Node and opens no window. The run then points `ARC_HOME`, `ARC_PROJECTS_ROOT`, `ARC_CODEX_ROOT`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME` at the run's empty directories. It sets `ARC_MEASURE_BLOCK_AGENTS=1` and points `ARC_MEASURE_STATE` at an empty state file. Arc then opens its panel at activation, shows no real sessions, and starts no agent. Pass `--live-data` only when the task asks for the owner's live sessions. That mode opens the panel through the command palette.

Once VS Code starts, the run replaces each window's `show` with `showInactive` and turns the window and application focus calls into no-ops. The hook runs after the main process starts, and VS Code shows its first window as it creates it. That window can take the foreground until the run ends. A run holds the machine-wide browser lane lock from [Build and host constraints](#build-and-host-constraints). One isolated editor therefore runs at a time, and never beside a browser lane.

The run writes `run.json` in its directory before VS Code starts. The file records the run directory, the profile path, and the driver's process ID. It gains the editor's main process ID and start time once they are known. It also records the process ID, start time, and a digest of the command line of each run process after launch, once the workbench loads, and before VS Code closes. A failed write of that record goes to the cleanup report, and the close and the cleanup still run. After success, an error, a timeout, or a signal, the tool closes VS Code through Playwright. Cleanup then owns each process that passes the profile as its exact `--user-data-dir` value, each process whose process ID, start time, and command line match a record in `run.json`, and their descendants. Unix `ps` start times have one-second precision, so the command line tells apart a process that reuses a recorded PID within that second. On Windows the profile comparison ignores letter case and slash direction. A descendant must start no earlier than its parent. Cleanup stops descendants before ancestors. On Windows, one PowerShell call opens each process, compares its start time with the listing, and stops it through the same handle. The open handle keeps Windows from giving its PID to another process. On macOS and Linux, cleanup lists each process again just before its own stop and compares its start time and command line. A new process that reuses a PID keeps running, and the cleanup report names its PID under `skipped`. Each process listing stops when the cleanup deadline passes, and the final check has at least five seconds. The tool removes the run directory only when no owned process remains. Otherwise it keeps the directory and `run.json` for a later cleanup. It lists the processes again and reports any that remain. A driver that was killed leaves its run directory behind. Clean up every run whose driver no longer runs:

```bash
node scripts/isolated-editor.mjs cleanup
```

Pass a run directory or its `run.json` to clean up one run. A run directory that is already gone leaves the command nothing to read, so it reports no run. Pass `--scratch <directory>` when the run used one.

### Restored tab check

The restore command checks that the build under test adopts a panel tab that an older build saved:

```bash
node scripts/isolated-editor.mjs restore --baseline-commit <revision>
```

The command exports the revision from the checkout's repository into the run directory. The export leaves out `evals`, whose review fixture paths exceed the Windows path limit. It also leaves out `docs` and the agent folders, which the build does not need. It links the checkout's dependency folders into the export and builds it there. `--baseline <checkout>` names a checkout that already holds a build instead. A baseline whose dependencies differ from the checkout's needs that prebuilt form. The baseline must open the Arc panel at activation from `ARC_MEASURE_BLOCK_AGENTS` and `ARC_MEASURE_STATE`, as the isolated editor environment above describes.

The command starts the editor with the baseline build and waits for the panel. It then closes that editor and waits until no process of the profile remains, so VS Code saves the tab. It starts a second editor on the same profile, extensions directory, and workspace with the checkout under test. The second editor gets no `ARC_MEASURE_STATE`, so Arc opens no panel of its own at activation. A panel that is already open would hide a restored tab with stale options, because Arc disposes that tab with no replacement. Agents stay blocked.

The profile turns on `arc.diagnostics.log` for this command. The check has two conditions. The second editor's log must hold a `panelAdopted` record with origin `serializer` or `serializer-replaced`. The restored panel must also accept text in its prompt box after New session and Create draft. A build whose log holds no such record fails with the origins it logged. The `value` in the JSON line holds the `baseline` revision, or the checkout path for `--baseline`. It also holds the adopted `origin` and the `log` file. The command takes `--timeout`, `--repository`, `--editor`, `--workspace`, `--scratch`, `--screenshot`, and `--allow-focus`. It holds the browser lane lock across both editors and cleans up like `run`. The baseline build lives in the run directory and goes with it. A tab restored by the owner's own editor stays an owner check.

The owner opens a window for manual testing with this command from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\launch-isolated-extension.ps1 -Repository .
```

The script builds Arc and opens this checkout through `scripts/isolated-editor.mjs open`. That command allows focus, takes no lock, and sets no time limit. It returns when the window closes, and it removes the run directory then. A failed launch gets the same cleanup. The last line of output is one JSON object with `ok`, the `run` directory, `errors`, and the `cleanup` report. The command exits with 0 only when the window opened and closed and its cleanup succeeded. `-LiveData` passes `--live-data`. `-Editor` names the VS Code install directory. Pass `-SkipBuild` only when `extension/dist` already contains the build under test.

## Performance capture

### Host health evidence

Sparse health recording runs with `arc.diagnostics.log` disabled. Open the current file through `arc.openDiagnosticsLog` when no detailed log exists. `arc.savePerformanceDiagnostics` includes provider identity and the current I/O failure status without a local health file path. Preserve the files before restarting the editor.

Find retained activations on Windows:

```powershell
Get-ChildItem "$env:USERPROFILE/.arc/logs/health-*" | Sort-Object LastWriteTime
```

On Linux and macOS:

```bash
ls -lt ~/.arc/logs/health-*
```

Use `$env:ARC_HOME/logs` or `$ARC_HOME/logs` when `ARC_HOME` is set. Each activation has a `health-<provider-id>.json` snapshot and up to two JSONL event segments. The previous segment ends in `.previous.jsonl`. An interrupted atomic replacement leaves a `.json.next` temporary file. The complete `.json` remains the accepted snapshot.

Match PID to the Extension Host process and the window registry under `ARC_HOME/hosts`. The workspace field hashes the JSON array of workspace folder paths. Provider identity distinguishes separate Arc activations within one process. Production bundles embed source commit, dirty state and build time. Watch bundles mark build identity unavailable with reason `watch`. Uncompiled hosts report reason `missing`. `diskChanged` compares bundle size and modification time with activation. It does not certify loaded bytes or detect replacements that preserve both values.

Snapshots record wall time, monotonic elapsed time, process RSS, JavaScript heap, external memory and event-loop delay. RSS covers the whole host, including other extensions and workers. Heap and external memory cover the sampling JavaScript thread. Delay measures heartbeat delivery after a five-second interval. Additional settlement samples carry unavailable delay and preserve the heartbeat clock. A large delay establishes host scheduling delay without attributing its cause. An abrupt exit prevents a final sample. Unknown termination also covers forced shutdown and failed diagnostic I/O. Only successful provider disposal records clean termination.

Health snapshots and startup records include the session reader's pending requests and its four most recent window reads. A pending window request carries `enteredAfterMs`, which stays null until the worker acknowledges the start of the read. A recent window read carries its outcome, generation, agent, host duration and the worker's lifecycle. Host durations use the host monotonic clock. Worker durations use the worker thread's clock. The two clocks share no origin, so neither side reports absolute times. `enterMs` covers the revision check before the read. `readMs` is the wall interval of the read. `replyMs` ends before the reply post and starts at the last earlier stage that ran. `atReceipt` counts other requests in progress when the read arrived. `during` counts requests received and finished, discovery progress replies and repeated-record completions before the reply. These counts show that other work interleaved with the read. They do not divide the read's wall time between the read and other work. That division needs a worker CPU profile.

Compare attached, ready and retained-tab counts. Retained-tab count is unavailable when the editor lacks the tab API. Retained tabs with zero attachments identify missing provider ownership. Attached tabs without readiness identify an incomplete browser startup. Each observed panel carries sent and acknowledged health sequences. A panel admits one health request until its browser replies or a new browser reports readiness. Closed panels release observation without retaining transport promises. Acknowledged sequences advance monotonically and accept delayed replies. A progressing host with acknowledgements that stop identifies missing browser replies. The acknowledgement confirms browser message handling, not paint or action completion. A disconnected retained tab supplies no browser evidence to the replacement provider.

Read lifecycle and action events beside the snapshot. `serializer` spans restoration and prompt recovery before adoption. `attached`, `adopted`, `ready` and `disposed` locate provider ownership changes. `parseRejected` and `unready` identify discarded requests. `select`, `new` and `send` carry numeric request identities and settlement durations. Selection settles pending because its refresh continues independently. New remains active during attachment recovery. Its settlement records draft creation, refusal or recovery failure. A rejected New also records an unavailable setup or folder. Send records prompt retention separately and settles pending after entering delivery or queue handling. These stages do not certify agent acceptance. Failed retention restores the prompt through the existing behavior.

Activation prunes older health files to retain twenty activations. Concurrent active hosts can recreate pruned files. Each has a snapshot and temporary snapshot capped at 16 KiB each, plus two 64 KiB event segments. Snapshots retain twelve samples, thirty-two active work entries, sixteen panel observations and sixteen recent settlements. Fixed phase and outcome counters retain totals after those settlements age out. The event budget permits eight lines per second. Suppressed events and refused in-flight entries appear as counters. Settlements survive event suppression in snapshots while they remain among the sixteen recent outcomes. The first suppressed settlement writes an additional snapshot at most once per second. A later snapshot records only settlements still in that bounded history. Quiet hosts write one snapshot every five seconds. No prompts, session identifiers, file contents or arbitrary error messages enter these files. Diagnostic I/O failure leaves product actions unchanged. Snapshots retry on each cadence and count I/O failures. Observation errors leave unavailable counts and increment a separate counter. Retention races do not stop recording. The live capture reports current failure even when the last durable snapshot still says logging was active. Missing files establish unavailable evidence, not absence of traffic. Small synchronous writes add storage-dependent overhead and do not guarantee power-loss durability.

### System capture

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

The owner records the following profiles in their own window. Reload the VS Code window before recording an extension profile. Run `Developer: Show Running Extensions`, start the Extension Host profile from that editor, stop it, and save the profile.

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

The disposable profile enables Arc diagnostics. It disables telemetry, the startup editor, installation walkthroughs, experimental onboarding, editor updates, and automatic extension update checks and installation.

The runner records owned paths, frozen input hashes, artifact hash, and process identities. `result.json` retains completion, observations, clocks, and the selected identity. It stops only processes belonging to its unique profile. `--timeout <seconds>` bounds the wait for all startup milestones and defaults to 30 seconds. Completion received after the deadline remains incomplete. `completeRender` acknowledges background session-list completion after discovery and metadata settle. Accepted browser observations must show usable session-list rows and the selected turn. Raw response identity stays separate from rendered response text or the folded card headline. Missing milestones or observations produce an incomplete result and nonzero exit. Shell and empty-list acknowledgments do not establish usable content.

Add `--selection` to collect session-switching evidence through the isolated editor's local CDP endpoint. A measurement overlay records complete panel message payloads, bytes, refreshes, worker requests, execution, cancellation, synchronous file operations, draws, and subsequent animation frames. The driver clicks selected A, opens B, and alternates retained A/B after both selected windows finish. Ordinary scenarios wait for accepted completed content and its corresponding frame. An observed pending B request permits an interruption attempt. Final identified window events and conservative clock bounds determine whether B remained pending at the browser click. Ambiguous overlap remains unavailable. Browser events keep native monotonic timestamps. Clock exchanges bound browser-to-host and worker-to-host offsets by transport intervals.

Selection evidence lives in `selection.json` and `selection-trace-*.jsonl` under the printed run directory. The overlay copies message payloads and performs synchronous trace writes, so its timings include recording overhead. File traces retain descriptor ownership through successful open and close, numeric read counts, and encoded string byte lengths. Asynchronous file operations and compositor presentation remain unavailable. Missing stages, unmatched request chains, and inconsistent clock identities remain incomplete. Explicit cancellation supplies a terminal status without requiring a successful reply. Unobserved cached work remains unavailable. Untagged browser messages retain absent click ownership. The runner returns an incomplete result until independent review qualifies the evidence and representative frozen inputs. Synthetic inputs establish transport and correlation behavior, without establishing live workspace latency.

Add `--response` to capture one synthetic live response becoming a recorded rich response. The runner copies the fixture's Codex corpus into its run directory before activation. The overlay requires agent blocking and appends a completed turn beyond the newest four MiB of the copied rollout. The driver retains a text selection through publication, clears it, and checks rich descendants, live-card removal, and the following frame. Response evidence lives in `response.json`, `response-before.png`, `response-after.png`, and the selection trace files. These captures include the same recording overhead and timing limits as selection captures.

`--keep` retains the build checkout. Other run resources remain available for inspection. A cleanup refusal ends the run without a retry. `ARC_MEASURE_EDITOR` selects a VS Code install directory. Compare repeated runs with identical inputs, settings, selection, and imports. Shared machine workload and operating-system disk cache remain measurement limits.
