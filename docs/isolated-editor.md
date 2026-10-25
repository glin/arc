# Isolated editor

## Isolated extension host

`scripts/isolated-editor.mjs` launches installed VS Code with a fresh profile. It loads Arc from a checkout or candidate VSIX and drives the window through Playwright. Agents use this window for editor checks. The driver never touches the owner's windows.

Build the checkout first with `npm --prefix extension run build`. Then run a check script:

```bash
node scripts/isolated-editor.mjs run check.mjs --screenshot shot.png
```

Keep check scripts outside the checkout or in ignored folders. The default export receives `app`, `page`, `arc`, `createDraft`, and `run`. `app` is Playwright's Electron application, `page` the workbench, and `arc` the panel frame containing `textarea#prompt`. Select a session or draft before using the prompt box. `createDraft({ agent })` selects New session, the agent, then Create draft. Locate controls by role and accessible name. `run` names the run directories.

```js
export default async ({ createDraft }) => {
  const prompt = await createDraft({ agent: 'Claude' });
  await prompt.fill('Hello');
  return prompt.inputValue();
};
```

The last output line is one JSON object. Its fields are `ok`, `run`, `mainPid`, `value`, `screenshot`, `errors`, and `cleanup`. Exit 0 requires successful execution and cleanup. Failed runs still write requested screenshots when a window exists.

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

Each run owns an isolated profile, extensions, Arc home, transcript roots, and workspace. Its run and sibling evidence directory stay at the pinned scratch location. Installed candidates retain separate `vsix-install.json` and `probe-vsix-install.json` receipts, copied archives, digests, registration manifests, editor logs, and `run.json`. Cleanup preserves those artifacts in the sibling evidence directory and reports their hashes. Failed retention keeps the run. Probe packaging and evidence retention refuse linked source or destination ancestors, including temporary aliases. Supply physical paths. Profile settings disable trust, telemetry, updates, startup editor, and AI prompts.

macOS creates default runs under `/private/tmp/arc-ie-<uid>`, with the user ID in hexadecimal. Default creation and automatic cleanup discovery refuse links, linked ancestors, foreign owners, and modes other than `0700` at that location. Run identifiers use twelve random hexadecimal characters on macOS and a UUID on Windows and Linux. The complete macOS profile socket path must fit within 103 UTF-8 bytes, including its filename. An oversized explicit scratch path stops before the run directory or editor starts. Windows and Linux default to the system temporary directory. Without `--scratch`, macOS cleanup searches both its private default and the system temporary directory. Explicit scratch selection searches only the selected directory.

Windows starts the installer and editor from the selected installation directory. That directory must use an absolute drive path shorter than 260 characters. Profile, extension, workspace, and candidate arguments remain absolute. macOS and Linux use the run directory. The Windows CLI accepts flat resources or a ten-hexadecimal version directory selected by the standard launcher. Unsupported or ambiguous launcher forms stop installation. Without a launcher, only the flat layout applies. The CLI file must remain inside the installation and be readable. macOS uses the bundle's `Contents/Resources/app/out/cli.js`. Linux uses `resources/app/out/cli.js` beside the executable.

The editor's environment drops every variable whose name starts with `VSCODE`, `ELECTRON`, `ARC_`, `CLAUDE`, `NODE_OPTIONS`, or `GIT_`, in any letter case. Arc gives the agents it starts `ELECTRON_RUN_AS_NODE=1`, and VS Code started with that variable runs as Node and opens no window. The run then points `ARC_HOME`, `ARC_PROJECTS_ROOT`, `ARC_CODEX_ROOT`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME` at the run's empty directories. It sets `ARC_MEASURE_BLOCK_AGENTS=1` and points `ARC_MEASURE_STATE` at an empty state file. Arc then opens its panel at activation, shows no real sessions, and starts no agent. Pass `--live-data` only when the task asks for the owner's live sessions. That mode opens the panel through the command palette.

The run replaces window show and focus calls after the main process starts. The initial window can take the foreground until the run ends. `--allow-focus` keeps normal focus behavior. Automated runs hold the [browser lane lock](testing.md#build-and-host-constraints), so they serialize with browser tests.

`run.json` records the profile and process identities before cleanup. Cleanup closes VS Code through Playwright, then stops matching processes, with descendants before ancestors. It matches exact profile arguments or recorded PID, start time, and command line. Windows profile matching ignores case and slash direction. Windows stops rechecked identities through an open process handle. macOS and Linux recheck each identity immediately before stopping it. Unix start times have one-second precision, so command lines distinguish same-second PID reuse only when the command changes. Observed identity mismatches are skipped and reported. Process listings share the cleanup deadline, with at least five seconds for the final check. Remaining processes or unavailable listings preserve the run and `run.json`. After an interrupted driver, clean up abandoned runs:

```bash
node scripts/isolated-editor.mjs cleanup
```

Pass a run directory or its `run.json` to clean up one run. A run directory that is already gone leaves the command nothing to read, so it reports no run. Pass `--scratch <directory>` when the run used one.

### Restored tab check

The restore command checks that the build under test adopts a panel tab that an older build saved:

```bash
node scripts/isolated-editor.mjs restore --baseline-commit <revision>
```

The command exports the baseline revision into its run, links this checkout's dependencies, and builds there. It excludes `evals`, `docs`, and agent folders. Use `--baseline <checkout>` for an existing build, including baselines needing different dependencies. Baselines must open Arc at activation through `ARC_MEASURE_BLOCK_AGENTS` and `ARC_MEASURE_STATE`.

The command starts the editor with the baseline build and waits for the panel. It then closes that editor and waits until no process of the profile remains, so VS Code saves the tab. It starts a second editor on the same profile, extensions directory, and workspace with the checkout under test. The second editor gets no `ARC_MEASURE_STATE`, so Arc opens no panel of its own at activation. A panel that is already open would hide a restored tab with stale options, because Arc disposes that tab with no replacement. Agents stay blocked.

The second editor must log `panelAdopted` with origin `serializer` or `serializer-replaced`. The restored panel must retain typed prompt text after New session and Create draft. The command enables `arc.diagnostics.log`. Its JSON `value` reports baseline, adopted origin, and log path. It accepts `--timeout`, `--repository`, `--editor`, `--workspace`, `--scratch`, `--screenshot`, and `--allow-focus`. It holds the browser lane lock across both editors and uses normal run cleanup. The baseline export goes with the run. Owner-window restoration remains an owner check.

The owner opens a window for manual testing with this command from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\launch-isolated-extension.ps1 -Repository .
```

The script builds Arc and opens this checkout through `scripts/isolated-editor.mjs open`. That command allows focus, takes no lock, and sets no time limit. It returns when the window closes, and it removes the run directory then. A failed launch gets the same cleanup. The last line of output is one JSON object with `ok`, the `run` directory, `errors`, and the `cleanup` report. The command exits with 0 only when the window opened and closed and its cleanup succeeded. `-LiveData` passes `--live-data`. `-Editor` names the VS Code install directory. Pass `-SkipBuild` only when `extension/dist` already contains the build under test.
