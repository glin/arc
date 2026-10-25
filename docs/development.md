# Development workflow

Use this guide for local setup, worktree safety, checks, and performance capture.

## Fast iteration

Run `npm run test:iterate` while you iterate. It runs the direct unit lanes. Run `npm test` to include static checks.

Check a change with the cheapest method that reaches it, in the order `CLAUDE.md` gives. A change that needs a real VS Code window goes to the [isolated editor](isolated-editor.md#isolated-extension-host).

Name the browser test files for the area you changed and run them directly with `node extension/test.mjs browser <files>`. Each named file narrows the lane to just that file, relative to `extension/` or to the repository root. A name that is not a browser test file fails with a clear message instead of running the whole lane.

After all edits, format your changes and run the tests once before handoff. In an isolated worktree, format every covered file and run the full suite:

```bash
npm run format
npm run test:all
```

## Dependencies

Use [Installation and packaging](installation.md) for installer checks and bundled tools. Use [Performance diagnostics](performance.md#performance-capture) before profiling.

Use [Testing](testing.md#verification) for test categories and [Demo assets](demo-assets.md) for screenshots and static demo changes.

Use [the isolated editor](isolated-editor.md#isolated-extension-host) for `scripts/isolated-editor.mjs run` checks. The owner opens a manual window with [`launch-isolated-extension.ps1`](isolated-editor.md#restored-tab-check).

Use [Handoff checks](testing.md#handoff-checks) for shared checkout and landing checks. Use [Timeline checks](testing.md#timeline-checks) for the read-only Claude sweep.

Use Node.js 22.12+. The extension targets the editor's Node runtime, while the source build uses newer packaging dependencies.

Install extension and CLI dependencies before building or testing:

```bash
npm install
npm --prefix extension install
npm --prefix cli install
npm --prefix extension exec -- playwright-core install chromium-headless-shell
```

The last command installs Playwright's bundled Chromium in the per-user Playwright cache, outside the repository. The browser tests and screenshot scripts use it first. [Verification](testing.md#verification) gives the reason.

`npm install` reuses existing dependencies and updates the lockfile when needed. Replacing an in-use package still conflicts with running tests on Windows.

`esbuild` is native. Install dependencies on the operating system that runs the commands. A `node_modules` tree copied from another operating system will not run it.

The source installer builds and installs the editor extension from local or temporary downloaded source. Its Claude plugin setup and legacy hook cleanup are described in [Snapshot installation](installation.md#snapshot-installation). [Isolated installer tests](installation.md#isolated-installer-tests) supplies the checkout plugin workflow. Validate the plugin and marketplace with `claude plugin validate --strict ./plugins/arc-hooks` and `claude plugin validate --strict .`.

The panel shots and their test write WebP files with the ImageMagick 7 `magick` command. Put `magick` on the `PATH` before running the full test suite.

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

The owner's VS Code loads the main worktree. A check in the owner's window therefore needs the change landed and built there, and the owner performs it. When the owner's window loads another checkout, the owner confirms the loaded worktree and bundle first. An agent checks a worktree build in the [isolated editor](isolated-editor.md#isolated-extension-host), which loads the checkout it names.

To compare test results between two commits, run both in checkouts set up the same way, for example two worktrees with the same dependency links. A worktree and the main checkout differ in more than the commit, such as build output and dependency links, so a difference between them does not show that the commit caused it.

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

This workflow runs in the owner's own VS Code window. An agent uses the [isolated editor](isolated-editor.md#isolated-extension-host) instead.

Wait for the ready message. Open this checkout in VS Code. Press F5 and select `Run Arc Extension`. The launch opens this checkout in an Extension Development Host and loads the nested `extension` package. Open Arc in that window. A CSS save patches the open panel in place. A Preact component save asks the extension host to replace only the webview document. A full Vite reload and a server reconnect use the same replacement path. The reload restores the selected session, unsent prompt, and scroll position after the initial render lays out. It also replaces the complete browser lifetime, so old handlers, timers, observers, subscriptions, roots, and message listeners do not remain active.

The launch passes the checkout as a positional folder argument on Windows. Do not use `${workspaceFolder}` with `--folder-uri`, because VS Code keeps the Windows path instead of creating a file URI. If F5 reuses a development host without a folder, stop debugging and close that host before starting again.

The development server binds to `127.0.0.1:5173` with a strict port. A port conflict stops the command. Stop the conflicting process, then run the command again. A panel opened while the server is down shows the command that restores it and reloads when the server returns. A syntax error leaves the last working panel active during an update. Fix and save the source to recover. Close and reopen the panel or restore an editor tab to confirm both paths reconnect.

Development command selection follows the [bundled tools contract](installation.md#bundled-tools). CLI source saves update `dist/cli.cjs`. Extension-host source saves rebuild `extension/dist/extension.js`. Reload the Extension Development Host to apply them. The panel does not present extension-host changes as hot updates.

This workflow supports a local Windows Extension Development Host. Remote extension hosts and port-forwarded development servers are unsupported. The webview loads its loopback address on the local VS Code machine, while a remote command binds on the remote machine.

Run `npm --prefix extension run build` after development. The production build restores the inline script, inline stylesheet, strict content policy, and offline operation. It contains no Vite client or development network request.

## Configuration watches

`configwatch.ts` watches each queried folder and each of its ancestors for its `.claude` and `.codex` directories. Inside each of those directories that exists, an inner watch covers `settings*.json` or `config.toml`. A directory that appears later gets its inner watch from the create event on its folder, or from a change event when a new check finds the directory. On Windows and macOS, the editor matches these directory names without case, so an event spelled `.Claude` also adds the inner watch. The agent user directories have their own watches on the same files. VS Code watches the base of a pattern recursively when the pattern holds `/` or `**`. Each of these patterns names direct children of its base, so every watch covers one folder. On macOS, VS Code skips a non-recursive watch under `/Volumes/` and reports no failure. A working directory on a second volume outside every workspace folder therefore gets no configuration invalidation. Unused folder watches and their inner watches are disposed, and only Arc executable path settings invalidate defaults through editor configuration events.

## Legacy checkout plugin recovery

Follow [Legacy checkout plugin recovery](installation.md#legacy-checkout-plugin-recovery) for the migration procedure.
