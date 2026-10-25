# Testing

## Verification

### Checks and lanes

Root `npm install` registers `.githooks/pre-commit` only at the Git repository root. The hook checks formatting and lint for added or changed files. It skips partly staged files with a warning and skips symbolic links. Required tools come from this checkout or the main worktree. Missing tools stop the commit. Fully staged production CSS also receives Stylelint checks.

Run formatting and lint checks from the repository root:

```bash
npm run format:check
npm run lint
```

`npm run lint` runs `lint:js` with Oxlint, then `lint:css` with Stylelint. `npm run lint:fix` applies Oxlint fixes. Oxfmt handles CSS formatting.

Stylelint checks only `extension/src/webview/*.css`, with zero warnings. Keep property and value checks enabled. `.stylelintrc.cjs` owns selector, clipping, and build-placeholder exceptions. Host VS Code custom properties require no local definitions.

Use `.oxfmtrc.mjs` and `.oxlintrc.jsonc` for scan scope. Both tools disable nested configurations. Type-aware lint covers every package project. Store run evidence under the owning plan's `runs/` directory, or `.claude/plans/runs/` without a plan.

Run the full test suite:

```bash
npm run test:all
```

`npm test` runs formatting, lint, typecheck, and direct units in order. `test:unit` runs root, extension, and CLI units sequentially. It excludes `subprocess` cases and defers their worker builds. `npm run test:all` adds every integration and browser category. Follow [Handoff checks](#handoff-checks) before handoff or landing.

`npm run test:integration` runs root subprocess tests, extension integration tests, panel-mockup tests, and hook and CLI smoke tests sequentially. `npm run test:browser` runs every extension browser file. The CLI smoke command builds its bundle before running tagged CLI cases. `npm --prefix extension run test:node` runs every extension Node case. `node extension/test.mjs full` runs every extension Node and browser case. Named-file commands retain tagged and untagged cases unless the caller supplies a tag filter.

Root tests that start real processes carry the Vitest tag `subprocess`. The root tag supplies a 120 second test budget. Tagged hooks retain their own budget. A whole file uses `// @module-tag subprocess`. Other files tag individual tests or suites with `{ tags: ['subprocess'] }`. Each package enables strict tags. `test:root` and `test:subprocess` partition the root tests and exclude the hook smoke file. `test:smoke` owns that file. Each root subprocess runner starts independently and runs one file at a time, with at most two concurrent cases.

Update `scripts/test-admission.json` when adding expensive cases or expanding a matrix. It names failure boundaries, case budgets, and repetition identities. `scripts/test-lanes.test.js` checks admission and lane coverage. Keep corruption, installation, extraction, process identity, platform, accessibility, and browser interaction coverage. Put input variations in direct tests when they reach the same failure.

### Browser selection

The extension Node lane uses up to eight Vitest workers. The browser lane uses up to four. `VITEST_MAX_WORKERS` overrides both lane caps. Direct extension Vitest runs default to four workers. A machine-wide lock serializes browser lanes. Sixteen shared slots bound browser launches, including direct Vitest, IDE, and screenshot runs. Compare queue wait separately from execution time.

Check browser readiness and run the browser lane:

```bash
npm exec -- vitest run scripts/extension-test-runner.test.js
npm --prefix extension run test:browser
```

Each browser process that waits for a shared slot prints `Browser test slot wait: <milliseconds> ms.` after it acquires one. The figure uses a monotonic clock and covers only time waiting for a slot. An immediate acquisition prints no wait line.

The launcher tries bundled Chromium, Edge, then Chrome. Each launch attempt times out after ten seconds, within the panel-mockup scale test's sixty-second deadline. On Windows, unmitigated Edge and Chrome launches record failed sign-ins. A lane reaches a ten-failure lockout threshold. Bundled Chromium omits that browser layer. Fallback launches disable the responsible feature. Preserve the combined `--disable-features` list in `extension/test/browserchannels.mjs`. Chromium keeps only the last switch, so replacing Playwright's list drops its settings. That file links the browser defect reports.

A waiting browser lane prints its holder's PID, extension directory, and start time once when waiting begins. It reports elapsed wait on resumption. Immediate acquisitions print neither line.

The browser tests build the panel and measure it in bundled Chromium, Edge, or Chrome. The browser runner names the executable before the lane runs. If no supported browser launches, browser mode and full mode fail. Node mode remains available for iteration without a browser. Direct Vitest runs bypass this check and skip individual tests when no browser launches.

### VSIX candidate

Build and check a candidate VSIX from the repository root:

```bash
npm --prefix extension run build
npm --prefix extension run package
node extension/scripts/check-vsix.mjs
```

The check compares packaged files, identity, version, and bundle with the current build. For manual installation, use **Extensions: Install from VSIX** with `extension/arc.vsix`. A manual `VSIX candidate` workflow runs the full suite and retains a versioned VSIX and SHA-256 checksum as temporary artifacts. Manual runs never publish, including runs on tags. [Release](installation.md#release) owns tag publication.

The standalone tagged-release downloader needs no Node or source checkout:

```bash
bash scripts/install-release.sh 0.1.0 code
```

Without an editor argument, it selects the sole detected editor or asks the reader to choose. Tag `v<version>` must contain `glin.arc-<version>.vsix` and `glin.arc-<version>.vsix.sha256`. Publish this installation path only when those assets exist.

### Test timing

The default, unit, integration, subprocess, and extension launchers print `Test timings: <path>` when each observed command ends. Isolated editor runs and panel startup measurements also report their timing file. Existing test commands retain their stage order and exit behavior.

`ARC_TEST_OBSERVATIONS_DIR` selects the artifact directory. Otherwise, artifacts use `arc-test-observations` under `ARC_TEST_MACHINE_TEMP` or the platform temporary directory. Nested commands inherit the selected artifact directory. Each request writes one JSONL file with its PID and run identity. Browser launches and temporary-directory setup write nested files without separate completion notices.

Use `runId` and `parentRunId` to relate timing files. `extension/test/observations.mjs` owns the event schema and captured environment identities. Missing identities remain null. Browser registry metadata does not identify a fallback executable. Use the launch event's selected channel and available version.

Queue, observed build, child lifetime, and cleanup intervals use monotonic clocks. Vitest execution includes collection, internal builds, and teardown. Delegated stage walls include nested waiting and startup. `wholeCommandWallMs` covers one request. Never sum or subtract overlapping durations to infer pure execution. Unobserved boundaries remain unavailable.

Holder notices include their observation timestamp and duration since that holder was first observed. Earlier notices remain historical when the holder changes. Holder payload timestamps do not establish total holder duration. Queue order and position remain unavailable. Release events report lock or slot removal, without confirming descendant termination. Cleanup errors retain their observed result.

Lane locks use `os.tmpdir()`. Browser slots use `ARC_TEST_MACHINE_TEMP` or `os.tmpdir()`. Vitest redirects `TEMP`, `TMP`, and `TMPDIR` for each run and preserves the machine temporary directory. A nested lane lock inside a run directory excludes only callers using that directory. Timing files retain absent and empty environment values on Windows, macOS, and Linux.

Each file permits 1024 events and one MiB, including reserved terminal space. Oversized events and recording failures produce an explicit incomplete or unavailable report. Commands longer than 4096 bytes omit their text and mark recording incomplete. Recording failure preserves the test result. A writer that exits before settlement records an incomplete result when its exit handler runs. A killed writer supplies no terminal proof. Missing stages, failed cleanup, and unobserved descendants remain limits on interpretation.

## Build and host constraints

- Return from extension registration before walking or comparing the snapshot store. Run cleanup later.

- Keep build imports loadable under plain Node. Packaging tests spawn `node esbuild.mjs` directly. Load `panelbundle.ts` through scoped `tsx/cjs/api`. A global TypeScript loader risks an ESM cycle on Node 22.
- Browser files use `panel.layout*.test.ts` or `*.browser.test.ts`. Node mode excludes them. Browser and full modes use the built panel and `extension/test/browser.ts`. Each test gets a fresh context. Its fixture clock starts in the local day's early afternoon and advances normally. Use browser-local calendar dates when checking day groups. The fixture includes older days, and cache bands still expire.
- Browser lanes share `arc-browser-tests.lock` in the system temporary directory. The lock is acquired before browser detection. Do not bypass it to compare execution times. Stale-lock takeover has a rare three-way race. Hard-link publication prevents partial reads. Its exclusive-create fallback permits them. `extension/test/browserlock.mjs` owns heartbeat, monotonic stale-age checks, retirement, restoration, and the wait deadline.
- Include `extension/test/temp-run.ts` as global setup in every Vitest configuration. `temproot.test.ts` checks this requirement. Run-local temporary files are removed at teardown. Machine coordination uses `ARC_TEST_MACHINE_TEMP`. Interrupted runs remain under `arc-test-runs` until a later run finds their owner exited.

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

## Portable review

Use [the cohort guide](../evals/agent-review/cohorts/README.md) for portable review qualification and preparation. `evals/agent-review/run.mjs` captures current instructions into external workspaces. Windows live runs check native read access and write denial before paid launch. Local workspaces do not certify semantic leakage or host access isolation. Continuations require matching retained claims and terminal receipts. Fatal stops need matching completion evidence before another launch. Historical corpus tools use separate cached Git objects and frozen instructions.
