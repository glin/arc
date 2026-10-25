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

The last output line is one JSON object. `runCommand` in `scripts/isolated-editor.mjs` owns its fields. Exit 0 requires successful execution and cleanup. Failed runs still attempt requested screenshots when a window exists.

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

Each run owns an isolated profile, extensions, Arc home, transcript roots, and workspace. Its run and sibling evidence directory stay at the pinned scratch location. `retainRunEvidence` in `scripts/isolated-editor.mjs` owns candidate receipts and retained artifacts. Failed retention keeps the run. Probe packaging and evidence retention refuse linked source or destination ancestors, including temporary aliases. Supply physical paths. `PROFILE_SETTINGS` in that file owns first-run suppression.

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

The baseline editor must close and settle before the candidate reuses its profile, extensions directory, and workspace. This lets VS Code save the tab. The candidate gets no `ARC_MEASURE_STATE`, so Arc opens no panel of its own at activation. An already-open panel would hide a stale restored tab because Arc disposes that tab without replacement. Agents stay blocked. `restoreWork` in `scripts/isolated-editor.mjs` owns the sequence.

The candidate must log `panelAdopted` with origin `serializer` or `serializer-replaced` and retain prompt text after draft creation. The command enables `arc.diagnostics.log`. `checkRestoredPanel` and `parseArguments` in the driver own assertions and accepted options. It holds the browser lane lock across both editors and uses normal run cleanup. The baseline export goes with the run. Owner-window restoration remains an owner check.

The owner opens a window for manual testing with this command from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\launch-isolated-extension.ps1 -Repository .
```

The script builds Arc and opens this checkout through `scripts/isolated-editor.mjs open`. That command allows focus and takes no lock. Launch waits use 90-second timeouts. After launch, it waits until the window closes, then cleans up. Failed launches also receive cleanup. `openCommand` in the driver owns output and exit status. `-LiveData` passes `--live-data`. `-Editor` names the VS Code install directory. Pass `-SkipBuild` only when `extension/dist` already contains the build under test.
