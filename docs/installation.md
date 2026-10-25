# Installation and packaging

## Isolated installer tests

Use `scripts/test-installer.mjs` to test source installation without writing to daily editor, agent, or Arc directories. Pass the installed editor directory explicitly. The driver creates a fresh sandbox under the physical temporary directory and prints its absolute path.

```bash
node scripts/test-installer.mjs install --source local --checkout /absolute/arc --editor /absolute/editor-install
node scripts/test-installer.mjs install --source remote --repo glin/arc --ref PUBLISHED_SHA --editor /absolute/editor-install
node scripts/test-installer.mjs sequence --first local --checkout /absolute/arc --repo glin/arc --ref PUBLISHED_SHA --editor /absolute/editor-install
node scripts/test-installer.mjs sequence --first remote --checkout /absolute/arc --repo glin/arc --ref PUBLISHED_SHA --editor /absolute/editor-install
```

A sequence installs the first source, the other source, then the first source again in one sandbox. Independent install commands use separate sandboxes. A remote ref must already exist on GitHub. Unpublished candidate tests use substituted download fixtures and establish simulated source switching only. Source revision, network, archive, build, and plugin failures retain separate evidence. The manifest records the bootstrap digest independently of the downloaded commit.

Installed workflows copy tracked working source into the sandbox without Git metadata, dependencies, or private agent folders. Repeat `--include RELATIVE_FILE` to select an untracked source file. Its source manifest records the original commit, tracked modifications, selected extra files, and each file digest. Staged builds retain that commit and dirty state through the existing build identity helper. The extension version remains separate from the commit. Installed checks require one Arc extension identity and match its bundled payload and plugin digests against the selected managed plugin. Installed extension identities and selected plugin digests live in `installer-run.json`. Every child command retains a private log under `evidence`.

The driver resolves actual Node home, Arc storage, Claude configuration, Codex home, and both skill destinations before installation. Its editor wrapper always supplies isolated user-data and extension directories. Private npm caches, application-data directories, XDG directories, and temporary files remain in the sandbox. Executable discovery retains the caller's tool search path.

Test an independently hosted catalog in its own sandbox:

```bash
node scripts/test-installer.mjs install --source local --checkout /absolute/arc --marketplace-url HTTPS_CATALOG --editor /absolute/editor-install
```

The hosted catalog selects its plugin independently of the extension revision. The manifest records Claude's selected plugin metadata and file digests. A successful bundled-plugin test does not establish hosted catalog availability.

For live checkout hooks, prepare a fresh Claude home and run the printed scoped launcher:

```bash
node scripts/test-installer.mjs checkout-plugin --checkout /absolute/arc
```

That launcher loads the selected live checkout's plugin with `--plugin-dir`. Later sessions load later checkout edits. The checkout remains a read-only source outside cleanup ownership. The launcher enters the private workspace and keeps home, Claude, Arc, and Codex state inside the sandbox. Windows launchers convert executable discovery paths through Git Bash before restoring the private environment. The driver checks that workspace and refuses an installed `arc-hooks@arc` in its home. This workflow requires no installed editor artifacts. Never combine installed hooks and `--plugin-dir` hooks in one session.

Check registration and selected bytes, then remove a stopped run:

```bash
node scripts/test-installer.mjs check-plugin --run-root /absolute/owned-run
node scripts/test-installer.mjs cleanup --run-root /absolute/owned-run
```

Cleanup refuses unknown manifests, running or unsettled children, changed root identity, and unfamiliar or external links. Checkout launches retain process creation identities and require a terminal receipt even when their executable and plugin paths sit outside the sandbox. An interrupted launcher or a surviving observed descendant leaves its launch unsettled. It unlinks admitted aliases before removing their targets. Keep failed runs until their private evidence has been reviewed.

Filesystem isolation does not isolate Keychain, credential-manager, keyring, or editor secret storage. Perform authenticated acceptance in a disposable operating-system account or virtual machine with separate credentials. An alternative credential boundary requires explicit approval and an inventory of external state and cleanup. Do not sign in from a disposable home until that boundary is settled. The driver makes no model calls and reports registration evidence only.

Native acceptance requires real Claude on Windows, macOS, and Linux. Run both sequences with two payloads whose plugin versions remain `0.1.0`. Check reported paths and selected file digests after every step. In a fresh scratch repository, exercise PreToolUse with an existing file and Stop after an edit. Check original baseline bytes, the manifest, and the trigger for installed local, installed downloaded, and checkout-plugin sessions. Registration alone does not establish snapshot capture.

## Legacy checkout plugin recovery

An existing checkout marketplace remains user-owned. A local reinstall preserves it and reports incomplete hook setup until migration. The diagnostic names the checkout, expected managed source, and Claude home. `--no-hooks` permits extension updates while skipping hook refresh and compatibility checks. This does not establish compatibility between arbitrary older hooks and the new extension. Matching managed payloads are the supported source-switching path.

Rehearse the same-path upgrade in disposable state before changing a daily installation:

```bash
node scripts/test-installer.mjs legacy-upgrade --baseline 048538a873d1c5edfa096aa5d759f6135e12c128 --checkout /absolute/arc --editor /absolute/editor-install
node scripts/test-installer.mjs legacy-upgrade --baseline 048538a873d1c5edfa096aa5d759f6135e12c128 --checkout /absolute/arc --editor /absolute/editor-install --via-link
```

The driver registers the baseline with real Claude, then overlays candidate files at the same path. It checks the legacy refusal and `--no-hooks`, enabled and disabled backup restoration, managed migration, and exact-path direct-hook cleanup. A simulated interruption after declaration removal exercises restoration. The physical checkout's direct hook must disappear. Unrelated hooks and alias-string hooks must survive. The alias variant uses a Windows junction or Unix directory symlink inside its owned sandbox. Native rehearsal results remain required on each target platform.

For a daily migration, first obtain explicit authorization for that machine. Stop every affected Claude session. List the current marketplaces and plugins:

```bash
claude plugin marketplace list --json
claude plugin list --json
```

Record the original source, plugin version, user scope, enabled state, selected path, and selected file digests. Stop if any `arc` plugin has project, local, managed, duplicate, policy-controlled, or unfamiliar ownership. Back up the complete selected Claude configuration, affected marketplace cache, plugin registration, and plugin data into a private location. Preserve Arc snapshots and direct legacy hook settings. Rehearse byte-for-byte restoration with that platform's disposable fixture before removing anything.

After ownership, backup, and restoration checks succeed, remove only the known user plugin and declaration:

```bash
claude plugin uninstall arc-hooks@arc --scope user --keep-data --json
claude plugin marketplace remove arc --scope user --json
bash install.sh --local
```

If the plugin was disabled, preserve that choice. Complete managed installation under explicit migration authority, then disable `arc-hooks@arc` at user scope before restarting sessions. Check selected bytes, scope, and enabled state after installation. A failed migration requires restoring the private backup of the original owned configuration before daily sessions restart. Preserve the backup until a fresh Claude session passes functional acceptance. Subsequent local and downloaded builds reuse the same managed root.

## Installer implementation

`scripts/test-installer.mjs` stages installed workflow source outside the live checkout and allocates private editor, agent, Arc, build, and evidence directories. Its manifest records source digests, original commit and dirty state, bootstrap digest, downloaded revision, installed extension identity, and selected plugin bytes. Its private npm launcher supplies the staged commit and dirty state to the existing build identity helper. Session-only checkout loading reads the selected live checkout outside cleanup ownership and launches inside the private workspace. Each checkout launcher retains a private receipt and process creation identities through Claude exit and descendant settlement. Cleanup and launch admission share an exclusive directory claim. Interrupted launches retain unsettled receipts. Installed managed checks connect the installed Arc extension's bundled identity to the selected plugin payload. The driver reuses isolated editor executable and CLI resolution. It checks actual home and skill destination resolution before installation. Cleanup requires settled children, an unchanged root identity, and admitted contained links. The legacy operation stages a baseline and candidate at one fixed path, with an optional owned directory alias. [Installer testing](#isolated-installer-tests) owns its commands and native acceptance limits.

`install.sh` detects complete source beside the script, then in the working directory, or resolves a GitHub ref and downloads its exact SHA. Remote source, dependencies, and the VSIX live in an installer-owned temporary directory that cleanup removes. Both source routes install dependencies with `npm install`. Both default source routes invoke the built `setup.cjs --snapshots` helper for matching immutable plugin storage. The helper runs from the caller's folder so project settings and scoped plugin ownership apply. An explicit `--marketplace-url` selects the plugin independently of `--repo` and `--ref`. `scripts/package-claude-plugin.js` produces the plugin ZIP, digest, and hosted catalog for the candidate workflow. [Development setup](development.md#dependencies) owns source setup options. [Installation](../README.md#install) owns hook options.

The installer's current-editor detection reads `product.json` beside the bundled Git askpass script identified by `VSCODE_GIT_ASKPASS_MAIN`. Windows user and system installations also supply content-addressed askpass copies outside the installation. For those copies, readable `VSCODE_GIT_ASKPASS_NODE` anchors metadata lookup in its installation's flat resources or immediate ten-hexadecimal version folders. Matching product identities across those folders select the outer installation's CLI. Conflicting identities leave detection unavailable. Bundled askpass scripts in version folders use the executable path to resolve the outer installation. `TERM_PROGRAM=vscode` alone does not distinguish editor products. A supplied `VSCODE_GIT_ASKPASS_NODE` must identify a readable executable in the same installation and is never executed. Missing or unsupported identity data leaves current-editor detection unavailable. The selected CLI belongs to that installation, including macOS products whose launcher is named `code`.

`cli/src/skills.ts` owns explicit personal skill copying, replacement, removal, cancellation, and destination ownership. Its control folder sits beside the discovery root and binds physical directory identities, operation tokens, complete file digests, and settled seals. Uncertain operations retain matching locks for manual recovery. Resources finish before exclusive completed-file publication exposes `SKILL.md`. `skillfiles.ts` selects only the executing artifact's payload layout and resolves physical temporary roots without write admission. Installed release commands select `skills/arc-sessions` beside `release.json` after validating the release identity and files. The source installer invokes the matching compiled CLI after editor installation and awaits child exit before deleting downloaded source. [Skill installation](arc-sessions.md#install-the-parts-you-need) owns destination, conflict, and recovery behavior.

## Bundled tools

`extension/esbuild.mjs` builds the CLI, source setup entry and extension from one source state. `extension/scripts/bundled-tools.mjs` copies the plugin, CLI, Windows pipe helper, canonical session skill directory and licenses. It generates private launcher templates and a skill-only `arc-session-tools` plugin into `dist/tools`. Both native skill copies and the generated versioned manifest enter the release identity. Session payload validation rejects divergent copies, missing references, and unrelated plugin components. `dist/build-identity.json` retains the existing export-viewer hashes and adds every tool file's digest, source identity, runtime minimum and supported platforms. Canonical skill files also enter the build input digest. Content identity distinguishes packages with repeated version strings. Digests establish consistency, not publisher authentication.

`bundledtools.ts` admits the absolute software root and refuses redirected ancestors. Unix roots require the current user's ownership. The store claims its `tools` directory through `ownership.json`. Windows claim staging uses a namespace path for creation and retains canonical paths for ownership. Failed claim publication removes only its unchanged staging directory and matching ownership file. Unfamiliar contents remain. It validates complete immutable releases before publication and retains a `release.json` beside their files. `tools/active.json` selects only the source-installed standalone CLI release and absolute external Node runtime. Editor-private preparation selects no shared active release. The `arc` and `arc.cmd` launchers locate that selection independently of caller `ARC_HOME`. CLI data retains its normal environment. Previous releases remain on disk. A complete development build uses the same immutable private release. Watch output without validated package identity supplies development commands and manual native skill discovery.

Command publication records prior and requested bytes before replacing launchers. A settled failure restores the prior selection when storage permits. Explicit retry reads retained operation evidence and refuses unfamiliar bytes. Configuration publication records ownership before creating its folder and registration before copying its release. Catalog and configuration-release writes reject redirected destination ancestors. Incomplete native selection requires user scope, the owned marketplace source, the recorded requested path and matching payload bytes. Snapshot runtime admission refuses a project executable that shadows external Node on PATH.

Each canonical Claude home has a separate `tools/claude/<configuration-id>/marketplace`. Its catalog selects a contained immutable plugin copy. `registration.json` retains user scope, requested content, observed source path, operation identity and completion state. Native path and byte checks precede completion. Failed settled updates restore the prior owned catalog while retaining incomplete operation evidence. Plugin operations never select the shared CLI release. Retained files do not establish running Claude session behavior.

`toolownership.ts` acquires the software lock before the Claude home lock. Plugin setup holds both through native mutations and completion. Wrapped errors retain both locks when descendant settlement remains uncertain. CLI-only setup acquires only software ownership. No timeout transfers a lock. These locks coordinate Arc writers and do not exclude unrelated filesystem editors.

`claudeplugin.ts` freezes the project, configuration home and launch environment for each consented operation. Passive offers suppress prompts for an enabled plugin. Explicit requests compare owned scope, path and bytes before the enabled-state exits. Optional hook setup retains its consent and dismissal identity. `extension.ts` refuses Claude hook setup on remote hosts. `TerminalTools` in `toolpath.ts` clears the whole nonpersistent terminal collection before admission and after disposal or preparation failure. Trusted admission freezes the execution host's software root and workspace identity. Generation checks reject obsolete preparation. Preparation waits for previous work to settle before taking software ownership again. Private preparation validates matching published releases without software write ownership. Publication waits for software ownership without blocking panel activation. Notifications and periodic condition checks detect completed publication or released ownership. A thirty-second deadline ends contention without taking over a retained lock. Disposal cancels the wait. New terminals receive appended PATH and the editor runtime, without `ARC_WINDOW`. Child selection checks current admission and supplies the current window separately. Reading selection never cancels preparation. Applied-defaults reads wait for current preparation without delaying panel activation. Admission recovery invalidates cached defaults. Stale or disposed requests start no child. Refused or failed defaults reads publish unavailable metadata. Pending preparation asks the reader to retry session launch. Admission failure reports the rejected path. Failed preparation reports its cause, including the retained software lock path when contention expires. Both failures ask the reader to resolve the problem and reload the window. [Installation](../README.md#install) owns prerequisites and removal.

For Windows launcher paths of 260 characters or more, `toolpath.ts` asks the packaged bridge for an existing short path. It checks the directory's physical identity and canonical path before publishing that spelling in terminal PATH and Arc-child environments. Ownership, release metadata, and locks retain canonical paths. An unavailable or excessive short path refuses command preparation. This avoids PowerShell adding a long launcher path before its command arguments.

## Snapshot installation

The `arc-hooks` Claude Code plugin owns one PreToolUse and Stop pair. Both default source routes invoke bundled setup after editor installation. Its ownership, disabled-plugin refusal, runtime requirements, and immutable storage follow [Bundled tools](#bundled-tools). A checkout or temporary download never becomes a registered marketplace. Local setup supplies its canonical checkout for a dedicated legacy transition explanation without granting replacement authority. [Legacy recovery](#legacy-checkout-plugin-recovery) owns migration choices. An explicit hosted catalog reads marketplace ownership before building and checks it again before changing plugins. That route installs, updates, and enables `arc-hooks@arc` at user scope and requires Claude Code 2.1.224 or later. Claude owns archive downloads and its installed plugin cache. Hook commands resolve through `${CLAUDE_PLUGIN_ROOT}`. Plugin failure preserves legacy hooks and leaves a successful editor installation usable, with a nonzero installer result. After plugin success, local installation removes direct Arc entries naming that checkout's legacy hook paths. Remote installation does not infer legacy paths from temporary source. `--no-hooks` skips plugin setup and legacy cleanup. Migration reads `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` and `${CODEX_HOME:-~/.codex}/hooks.json`. It leaves unrelated, uncertain, malformed, or symlinked settings unchanged. The installer does not install a Codex plugin.

On Windows, a Codex CLI session on the shared background server keeps its loaded hook definitions after the hook file changes. Reopening the CLI on that session does not reload them. Exit the affected CLI and resume with `codex resume --no-daemon <session-id>`, or restart the background server after other sessions stop.

## Build identity and packaging

The extension build packages the CLI and both shell launchers. VSIX packaging marks the extensionless launcher executable on POSIX, including archives built on Windows. It patches the archive named by VSCE's successful packaging output.

`panelbundle.ts` builds the browser program from `webview/main.ts`. `webview/bootstrap.ts` mounts page-lifetime owners and acquires the VS Code API once. The package build and browser fixture use the same panel script. The packaged panel script and stylesheet are inline. The build also writes the static viewer script and stylesheet under `dist`. Installed exports read those packaged assets without loading source or esbuild. Their source inputs and output digests participate in build identity. [`development.md`](development.md#live-panel-development) describes the separate Vite path.

The production build writes `dist/build-identity.json` beside its bundle. It records the extension version, source commit, dirty state, input digest, and bundle digest. `scripts/source-identity.mjs` supplies one source identity snapshot to the standalone CLI and each production extension build. The extension reuses its snapshot for the host, bundled CLI, bundled tools, and identity file. Its physical source root must contain its own Git metadata. An enclosing repository supplies no source identity. `ARC_SOURCE_COMMIT` accepts a full forty-character hexadecimal archive revision with unknown dirty state. `ARC_SOURCE_DIRTY` supplies `true` or `false` for a staged source whose original state is known. A checkout remains authoritative and rejects conflicting commit or dirty-state overrides. Invalid overrides fail the build. The source installer passes its resolved archive revision to the downloaded build and clears inherited source identity overrides for local builds and inherited dirty state for downloads. Without Git or an archive revision, commit and dirty state remain null. The input digest covers host, browser, worker, and CLI sources, the package manifest, and build configuration, including the source identity helper. Watch startup removes the manifest. Startup reads it asynchronously and accepts identity only when its digest matches the bundle. Missing or mismatched manifests remain explicitly unavailable. The isolated measurement runner requires frozen source and cache roots, sanitizes copied reader state, and blocks agent connections before activation. Store seeding excludes diagnostics and startup history. The runner accepts diagnostics carrying its unique launch identity and pins the source revision before building. Its input hashes and measurement overlay identify comparisons independently of routine startup history.

## Release

`extension/package.json` owns the version. `scripts/release-version.js` copies it into the extension and CLI lockfiles, `cli/package.json`, and the Claude plugin manifest. The extension and CLI builds read it from their manifests. `scripts/release-version.test.js` fails when any holder disagrees.

1. Before the first release, keep `CHANGELOG.md` at `## 0.1.0 (Unreleased)` with `Initial release.`. After the first release, add user-visible changes under `## Unreleased`.
2. Run `npm run release -- X.Y.Z`. The script accepts the current version only when its changelog heading marks that version `(Unreleased)`. Otherwise, it requires a greater version. The changelog must have an unreleased section. The script sets the version and dates that section as `## X.Y.Z (YYYY-MM-DD)` in UTC. It opens an empty `## Unreleased` above it.
3. Run the two commands the script prints. They commit `chore(release): X.Y.Z` and tag `vX.Y.Z`.
4. Push the commit, then push the tag.

Generate hosted plugin candidate artifacts locally with `node scripts/package-claude-plugin.js release`. The ZIP contains the plugin manifest, hook definitions, and runtime scripts. Its catalog names the immutable versioned ZIP and SHA-256 digest. Candidate generation does not publish assets or establish real Claude cache acceptance.

The tag starts the `VSIX candidate` workflow. It fails when the tag differs from the `extension/package.json` version. Otherwise it builds the VSIX and checksum, plugin ZIP and digest, and hosted catalog. It creates a GitHub release for the tag with those artifacts. The release notes are the changelog section for that version. Only a tag push publishes a release.

## Source setup

A built source tree exposes durable source setup helpers. The VSIX prepares private commands automatically. Each command performs only its named operation. Command installation leaves PATH configuration unchanged.

```bash
node extension/dist/setup.cjs --commands
node extension/dist/setup.cjs --snapshots
```

Both default source routes use the built snapshot helper to preserve matching hooks in durable storage. Installed local builds use frozen plugin bytes. Rebuild and reinstall to select changed files. `--remote` forces download for development testing. `--repo` and `--ref` select the downloaded source. `--marketplace-url` explicitly selects an independently published HTTPS catalog. `--no-hooks` skips Claude plugin setup and legacy cleanup. Skill selection is independent and uses the matching built CLI. [Skill installation](arc-sessions.md#install-the-parts-you-need) owns its selectors and destinations.

When the installer reports component outcomes, it uses readable text by default. `--json` renders those outcomes as the final structured output line. Help and early argument or prerequisite refusals omit that result. Hook-only preflight failures preserve admitted editor and skill work. Exit 0 means selected work succeeded or preserved an exact stable external skill. Exit 2 means global argument or prerequisite refusal before installation. Exit 1 means incomplete requested work. Delivered HUP, INT, and TERM preserve statuses 129, 130, and 143. The shell records cancellation and awaits its unreaped skill child before deleting temporary source. No platform/runtime forwarding branch has native graceful-delivery acceptance, so handlers wait without forwarding. Automated disposable-home checks do not establish authenticated native skill discovery.
