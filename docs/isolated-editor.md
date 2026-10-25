# Isolated editor

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

Once VS Code starts, the run replaces each window's `show` with `showInactive` and turns the window and application focus calls into no-ops. The hook runs after the main process starts, and VS Code shows its first window as it creates it. That window can take the foreground until the run ends. A run holds the machine-wide browser lane lock from [Build and host constraints](testing.md#build-and-host-constraints). One isolated editor therefore runs at a time, and never beside a browser lane.

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
