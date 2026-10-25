# Installation and packaging

## Source setup

A built source tree exposes durable source setup helpers. The VSIX prepares private commands automatically. Each command performs only its named operation. Command installation leaves PATH configuration unchanged.

```bash
node extension/dist/setup.cjs --commands
node extension/dist/setup.cjs --snapshots
```

Both default source routes use the built snapshot helper to preserve matching hooks in durable storage. Installed local builds use frozen plugin bytes. Rebuild and reinstall to select changed files. `--remote` forces download for development testing. `--repo` and `--ref` select the downloaded source. `--marketplace-url` explicitly selects an independently published HTTPS catalog. `--no-hooks` skips Claude plugin setup and legacy cleanup. Skill selection is independent and uses the matching built CLI. [Skill installation](arc-sessions.md#install-the-parts-you-need) owns its selectors and destinations.

When the installer reports component outcomes, it uses readable text by default. `--json` renders those outcomes as the final structured output line. Help and early argument or prerequisite refusals omit that result. Hook-only preflight failures preserve admitted editor and skill work. Exit 0 means selected work succeeded or preserved an exact stable external skill. Exit 2 means global argument or prerequisite refusal before installation. Exit 1 means incomplete requested work. Delivered HUP, INT, and TERM preserve statuses 129, 130, and 143. The shell records cancellation and awaits its unreaped skill child before deleting temporary source. No platform/runtime forwarding branch has native graceful-delivery acceptance, so handlers wait without forwarding. Automated disposable-home checks do not establish authenticated native skill discovery.

## Snapshot installation

The `arc-hooks` Claude Code plugin owns one PreToolUse and Stop pair. Both default source routes invoke bundled setup after editor installation. Its ownership, disabled-plugin refusal, runtime requirements, and immutable storage follow [Bundled tools](#bundled-tools). A checkout or temporary download never becomes a registered marketplace. Local setup supplies its canonical checkout for a dedicated legacy transition explanation without granting replacement authority. [Legacy recovery](#legacy-checkout-plugin-recovery) owns migration choices. An explicit hosted catalog reads marketplace ownership before building and checks it again before changing plugins. That route installs, updates, and enables `arc-hooks@arc` at user scope and requires Claude Code 2.1.224 or later. Claude owns archive downloads and its installed plugin cache. Hook commands resolve through `${CLAUDE_PLUGIN_ROOT}`. Plugin failure preserves legacy hooks and leaves a successful editor installation usable, with a nonzero installer result. After plugin success, local installation removes direct Arc entries naming that checkout's legacy hook paths. Remote installation does not infer legacy paths from temporary source. Migration reads `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` and `${CODEX_HOME:-~/.codex}/hooks.json`. It leaves unrelated, uncertain, malformed, or symlinked settings unchanged. The installer does not install a Codex plugin.

On Windows, a Codex CLI session on the shared background server keeps its loaded hook definitions after the hook file changes. Reopening the CLI on that session does not reload them. Exit the affected CLI and resume with `codex resume --no-daemon <session-id>`, or restart the background server after other sessions stop.

## Isolated installer tests

Use `scripts/test-installer.mjs` to test source installation without writing to daily editor, agent, or Arc directories. Pass the installed editor directory explicitly. The driver creates a fresh sandbox under the physical temporary directory and prints its absolute path.

```bash
node scripts/test-installer.mjs install --source local --checkout /absolute/arc --editor /absolute/editor-install
node scripts/test-installer.mjs install --source remote --repo glin/arc --ref PUBLISHED_SHA --editor /absolute/editor-install
node scripts/test-installer.mjs sequence --first local --checkout /absolute/arc --repo glin/arc --ref PUBLISHED_SHA --editor /absolute/editor-install
node scripts/test-installer.mjs sequence --first remote --checkout /absolute/arc --repo glin/arc --ref PUBLISHED_SHA --editor /absolute/editor-install
```

A sequence installs its first source, the other source, then the first again in one sandbox. Separate install commands create separate sandboxes. Remote refs must exist on GitHub. Substituted downloads establish simulated source switching only. Review `installer-run.json` and private `evidence` logs for source, network, archive, build, and plugin failures. Bootstrap digest and downloaded revision remain separate.

Installed checks stage tracked working source without Git metadata, dependencies, or private agent folders. Repeat `--include RELATIVE_FILE` for untracked source. The manifest retains original commit, dirty state, selected files, and digests. Builds retain that identity separately from the extension version. Installed checks require one Arc identity and matching bundled and managed-plugin digests.

The driver checks actual Node home, Arc storage, agent homes, and both skill destinations before installation. Editor data, extensions, caches, application data, XDG state, and temporary files stay in the sandbox. Executable discovery keeps the caller's search path.

Test an independently hosted catalog in its own sandbox:

```bash
node scripts/test-installer.mjs install --source local --checkout /absolute/arc --marketplace-url HTTPS_CATALOG --editor /absolute/editor-install
```

The hosted catalog selects its plugin independently of the extension revision. The manifest records Claude's selected plugin metadata and file digests. A successful bundled-plugin test does not establish hosted catalog availability.

For live checkout hooks, prepare a fresh Claude home and run the printed scoped launcher:

```bash
node scripts/test-installer.mjs checkout-plugin --checkout /absolute/arc
```

The printed launcher enters the private workspace and loads live checkout hooks through `--plugin-dir`. Later sessions load later edits. The checkout stays outside cleanup ownership. Home and agent state stay inside the sandbox. Windows resolves executables through Git Bash before restoring that environment. The driver refuses installed `arc-hooks@arc` in its home. No editor installation is required. Never combine installed and `--plugin-dir` hooks in one session.

Check registration and selected bytes, then remove a stopped run:

```bash
node scripts/test-installer.mjs check-plugin --run-root /absolute/owned-run
node scripts/test-installer.mjs cleanup --run-root /absolute/owned-run
```

Cleanup refuses unknown manifests, running or unsettled children, changed root identity, and unfamiliar or external links. Checkout launches require process creation identities and terminal receipts even for executables or plugins outside the sandbox. Interrupted launchers or surviving observed descendants remain unsettled. Cleanup unlinks admitted aliases before targets. Keep failed runs until their evidence is reviewed.

Filesystem isolation does not isolate Keychain, credential-manager, keyring, or editor secret storage. Perform authenticated acceptance in a disposable operating-system account or virtual machine with separate credentials. An alternative credential boundary requires explicit approval and an inventory of external state and cleanup. Do not sign in from a disposable home until that boundary is settled. The driver makes no model calls and reports registration evidence only.

Native acceptance requires real Claude on Windows, macOS, and Linux. Run both sequences with two payloads whose plugin versions remain `0.1.0`. Check reported paths and selected file digests after every step. In a fresh scratch repository, exercise PreToolUse with an existing file and Stop after an edit. Check original baseline bytes, the manifest, and the trigger for installed local, installed downloaded, and checkout-plugin sessions. Registration alone does not establish snapshot capture.

## Legacy checkout plugin recovery

An existing checkout marketplace remains user-owned. A local reinstall preserves it and reports incomplete hook setup until migration. The diagnostic names the checkout, expected managed source, and Claude home. `--no-hooks` permits extension updates while skipping hook refresh and compatibility checks. This does not establish compatibility between arbitrary older hooks and the new extension. Matching managed payloads are the supported source-switching path.

Rehearse the same-path upgrade in disposable state before changing a daily installation:

```bash
node scripts/test-installer.mjs legacy-upgrade --baseline 048538a873d1c5edfa096aa5d759f6135e12c128 --checkout /absolute/arc --editor /absolute/editor-install
node scripts/test-installer.mjs legacy-upgrade --baseline 048538a873d1c5edfa096aa5d759f6135e12c128 --checkout /absolute/arc --editor /absolute/editor-install --via-link
```

The rehearsal registers baseline hooks through Claude and overlays candidate files at the same path. It checks legacy refusal, `--no-hooks`, enabled and disabled restoration, migration, and exact-path cleanup. It simulates interruption after declaration removal. Physical-path hooks must disappear. Unrelated and alias-string hooks must survive. `--via-link` uses a Windows junction or Unix directory symlink within its sandbox. Rehearse natively on each target platform.

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

## Bundled tools

Build CLI, source setup, extension, and tools from one source state. `extension/scripts/bundled-tools.mjs` packages canonical payloads and hashes. Session-skill copies must agree, include every reference, and exclude unrelated plugin components. Tool files and canonical skill inputs enter build identity. Content identity distinguishes repeated version strings. Digests establish consistency, not publisher authentication.

`bundledtools.ts` refuses redirected software roots and requires current-user ownership on Unix. It claims `tools` through `ownership.json` and publishes complete immutable releases with `release.json`. Unfamiliar files remain untouched. Standalone commands use `tools/active.json` and an absolute external Node runtime, independently of caller `ARC_HOME`. Private editor preparation leaves that shared selection unchanged. Previous releases remain. Complete development builds use immutable private releases. Watch builds lack validated identity and use development commands with manual native skill discovery.

Retry interrupted command setup explicitly. It refuses unfamiliar launcher bytes and restores the prior selection after settled failure when storage permits. Configuration writes refuse redirected ancestors. Incomplete native selection requires user scope, the owned marketplace, the requested path, and matching bytes. Snapshot setup refuses project executables shadowing external Node on PATH.

Each canonical Claude home selects its own immutable plugin under `tools/claude/<configuration-id>/marketplace`. Setup checks native path and bytes before completion. Settled failed updates restore the prior owned catalog and retain incomplete-operation evidence. Plugin setup leaves standalone CLI selection unchanged. Retained files do not establish behavior in running Claude sessions.

`toolownership.ts` acquires the software lock before the Claude home lock. Plugin setup holds both through native mutations and completion. Wrapped errors retain both locks when descendant settlement remains uncertain. CLI-only setup acquires only software ownership. No timeout transfers a lock. These locks coordinate Arc writers and do not exclude unrelated filesystem editors.

Hook setup freezes project, configuration home, and environment for each consented operation. Enabled plugins suppress passive offers. Explicit setup checks owned scope, path, and bytes before enabled-state exits. Remote hosts refuse Claude hook setup. Trusted admission fixes the host software root and workspace identity. `TerminalTools` clears nonpersistent terminal changes before admission and after failure or disposal. Preparation must settle before another attempt acquires ownership. Private preparation reads matching published releases without software write ownership. Publication waits without blocking activation. Contention ends after thirty seconds without taking over retained locks. Disposal cancels waiting. New terminals receive PATH and editor runtime without `ARC_WINDOW`. Child selection supplies the current window separately. Defaults reads wait for preparation without blocking activation. Admission recovery invalidates cached defaults. Obsolete or disposed requests start no child. Failed defaults reads publish unavailable metadata. Pending launches ask for retry. Admission or preparation failures require resolution and window reload. Expired contention names the retained lock.

For Windows launcher paths of 260 characters or more, `toolpath.ts` asks the packaged bridge for an existing short path. It checks the directory's physical identity and canonical path before publishing that spelling in terminal PATH and Arc-child environments. Ownership, release metadata, and locks retain canonical paths. An unavailable or excessive short path refuses command preparation. This avoids PowerShell adding a long launcher path before its command arguments.

## Build identity and packaging

The extension build packages the CLI and both shell launchers. VSIX packaging marks the extensionless launcher executable on POSIX, including archives built on Windows. It patches the archive named by VSCE's successful packaging output.

Package the same panel script used by browser fixtures, with inline script and stylesheet. Installed exports read the viewer assets under `dist` without source or esbuild. Their inputs and digests participate in build identity. [Live panel development](development.md#live-panel-development) owns the separate Vite path.

Production builds write `dist/build-identity.json` beside the bundle. It records version, source commit, dirty state, input digest, and bundle digest. `scripts/source-identity.mjs` supplies one snapshot to the host, CLI, tools, and identity file. A physical source root needs its own Git metadata. Enclosing repositories supply no identity.

For archives, set `ARC_SOURCE_COMMIT` to forty hexadecimal characters. Dirty state remains unknown unless `ARC_SOURCE_DIRTY` supplies `true` or `false` for known staged source. Checkouts reject conflicting overrides. Invalid overrides fail the build. Local installation clears inherited overrides. Downloads use the resolved revision and clear inherited dirty state. Without Git or archive identity, commit and dirty state remain null.

Build inputs cover host, browser, worker, CLI, manifest, configuration, and the identity helper. Watch startup removes the manifest. Startup accepts identity asynchronously only when the bundle digest matches. Missing or mismatched identity remains unavailable. [Startup measurement](performance.md#startup-measurement) owns frozen inputs, seeded state, and launch identity.

## Release

Set versions through `scripts/release-version.js`. `extension/package.json` owns the version. `scripts/release-version.test.js` checks agreement with the CLI, lockfiles, and Claude plugin manifest.

1. Before the first release, keep `CHANGELOG.md` at `## 0.1.0 (Unreleased)` with `Initial release.`. After the first release, add user-visible changes under `## Unreleased`.
2. Run `npm run release -- X.Y.Z`. The script accepts the current version only when its changelog heading marks that version `(Unreleased)`. Otherwise, it requires a greater version. The changelog must have an unreleased section. The script sets the version and dates that section as `## X.Y.Z (YYYY-MM-DD)` in UTC. It opens an empty `## Unreleased` above it.
3. Run the two commands the script prints. They commit `chore(release): X.Y.Z` and tag `vX.Y.Z`.
4. Push the commit, then push the tag.

Generate hosted plugin candidate artifacts locally with `node scripts/package-claude-plugin.js release`. The ZIP contains the plugin manifest, hook definitions, and runtime scripts. Its catalog names the immutable versioned ZIP and SHA-256 digest. Candidate generation does not publish assets or establish real Claude cache acceptance.

The tag starts the `VSIX candidate` workflow. It fails when the tag differs from the `extension/package.json` version. Otherwise it builds the VSIX and checksum, plugin ZIP and digest, and hosted catalog. It creates a GitHub release for the tag with those artifacts. The release notes are the changelog section for that version. Only a tag push publishes a release.

## Installer implementation

Use [Isolated installer tests](#isolated-installer-tests) for source staging, receipts, sandbox cleanup, and native acceptance.

`install.sh` selects complete source beside the script, then in the caller's folder. Otherwise it resolves a GitHub ref and downloads its exact SHA. Remote source, dependencies, and VSIX occupy an owned temporary directory. Both source routes run `npm install`. Snapshot setup runs from the caller's folder so project configuration and plugin scope apply. `--marketplace-url` selects hooks independently of `--repo` and `--ref`.

Current-editor detection requires product metadata, not `TERM_PROGRAM=vscode` alone. `VSCODE_GIT_ASKPASS_MAIN` identifies bundled metadata. On Windows, content-addressed askpass copies also require readable `VSCODE_GIT_ASKPASS_NODE` in the same installation. Flat resources and immediate ten-hexadecimal version folders must agree on product identity. Missing, conflicting, or unsupported metadata leaves detection unavailable. The supplied executable is read, never run. The selected CLI belongs to that installation, including macOS products with a `code` launcher.

Use [Skill installation](arc-sessions.md#install-the-parts-you-need) for destinations, conflicts, and recovery. `cli/src/skills.ts` owns copying, replacement, removal, and cancellation. The installer invokes its matching compiled CLI and waits for it before removing downloaded source. Uncertain operations retain locks for manual recovery.
