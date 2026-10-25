# Development workflow

## Fast iteration

Run direct units while you iterate, or include static checks:

```bash
npm run test:iterate
npm test
```

Check a change with the cheapest method that reaches it, in the order `CLAUDE.md` gives. A change that needs a real VS Code window goes to the [isolated editor](isolated-editor.md#isolated-extension-host).

Run named browser files directly:

```bash
node extension/test.mjs browser <files>
```

Paths are relative to `extension/` or the repository root. An invalid browser filename fails instead of expanding the lane.

After all edits, format your changes and run the tests once before handoff. In an isolated worktree, format every covered file and run the full suite:

```bash
npm run format
npm run test:all
```

## Subject guides

Use [Installation and packaging](installation.md) for installer checks and bundled tools. Use [Performance diagnostics](performance.md#performance-capture) before profiling.

Use [Testing](testing.md#verification) for test categories and [Demo assets](demo-assets.md) for screenshots and static demo changes.

Use [the isolated editor](isolated-editor.md#isolated-extension-host) for `scripts/isolated-editor.mjs run` checks. The owner opens a manual window with [`launch-isolated-extension.ps1`](isolated-editor.md#restored-tab-check).

Use [Handoff checks](testing.md#handoff-checks) for shared checkout and landing checks. [Landing acceptance](testing.md#checks-and-lanes) retains complete failure reports and explicit unrelated-failure dispositions. Use [Timeline checks](testing.md#timeline-checks) for the read-only Claude sweep.

## Dependencies

Use Node.js 22.12+ for source builds.

Install extension and CLI dependencies before building or testing:

```bash
npm install
npm --prefix extension install
npm --prefix cli install
npm --prefix extension exec -- playwright-core install chromium-headless-shell
```

The browser install writes to the per-user Playwright cache outside the repository. [Browser selection](testing.md#browser-selection) explains the channel order.

`npm install` reuses existing dependencies and updates the lockfile when needed. Replacing an in-use package conflicts with running tests on Windows.

`esbuild` is native. Install dependencies on the operating system that runs the commands. A `node_modules` tree copied from another operating system will not run it.

Validate the Claude plugin and marketplace before changing their packaging:

```bash
claude plugin validate --strict ./plugins/arc-hooks
claude plugin validate --strict .
```

The panel shots and their test write WebP files with the ImageMagick 7 `magick` command. Put `magick` on the `PATH` before running the full test suite.

## Panel-mockup link

`.agents/skills/panel-mockup` and `.agents/skills/isolated-editor` link to the skills of the same names under `.claude/skills/`. The links let Codex find the same skills.

On Windows, enable links before checkout and create them with administrator rights or Developer Mode:

```powershell
git config core.symlinks true
```

Git writes a text file instead of the link when it cannot create links. Repair the link before using the skill.

## Worktree dependencies

Root checks need `node_modules`, `extension/node_modules`, and `cli/node_modules`.

Link each dependency tree to its installed counterpart in the main worktree, or run [Dependencies](#dependencies) here.

Installing through a dependency link changes the main worktree. A branch changing `extension/package.json` or its lockfile needs its own installation. Remove its links first.

Remove a link without following it. Use a command that deletes only the link. Never delete recursively through a link, because that empties the dependencies of the main worktree. Count the files under the link target before and after the removal, and confirm that the link is gone before removing the worktree.

The owner's VS Code loads the main worktree. A check in the owner's window therefore needs the change landed and built there, and the owner performs it. When the owner's window loads another checkout, the owner confirms the loaded worktree and bundle first. An agent checks a worktree build in the [isolated editor](isolated-editor.md#isolated-extension-host), which loads the checkout it names.

Compare commits in equally configured checkouts, including build output and dependency links. Differences between a worktree and the main checkout alone do not establish a commit effect.

## Model pricing

Change model and provider pricing in `extension/src/pricing.ts`.

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

## Environment overrides

Empty vendor homes count as unset.

| Variable | Moves | Default |
| --- | --- | --- |
| `ARC_HOME` | The Arc store home. Snapshots sit below it, and the cache sits beside them | `~/.arc` |
| `ARC_PROJECTS_ROOT` | Where Arc reads Claude Code transcripts | `~/.claude/projects` |
| `ARC_CODEX_ROOT` | Where Arc reads Codex rollouts | `~/.codex/sessions` |
| `ARC_IGNORE_ROOTS` | The paths a turn writes for itself, which no diff shows. Entries are separated like `PATH` entries. An empty value disables the rule | the temporary directory, Claude Code home, Codex home, and Arc home |
| `CLAUDE_CONFIG_DIR` | The Claude Code home. Arc reads transcripts from `projects` below it and ignores agent-owned files below it | `~/.claude` |
| `CODEX_HOME` | The Codex home. Arc reads rollouts from `sessions` below it and ignores agent-owned files below it | `~/.codex` |

`ARC_PROJECTS_ROOT`, `ARC_CODEX_ROOT`, and `ARC_IGNORE_ROOTS` override their related vendor homes. The extension reads these values from the editor process environment.

## Live panel development

Start the extension build watcher and the local Vite server from the repository root:

```bash
npm --prefix extension run dev
```

This workflow runs in the owner's own VS Code window. An agent uses the [isolated editor](isolated-editor.md#isolated-extension-host) instead.

Wait for the ready message, then open this checkout in VS Code. Press F5 and select `Run Arc Extension`. Open Arc in the new Extension Development Host. Document replacement restores the selected session, unsent prompt, and scroll position after initial layout. `extension/src/paneldevelopment.ts` owns updates and recovery. `extension/src/webview/bootstrap.ts` owns browser-lifetime cleanup.

The launch passes the checkout as a positional folder argument on Windows. Do not use `${workspaceFolder}` with `--folder-uri`, because VS Code keeps the Windows path instead of creating a file URI. If F5 reuses a development host without a folder, stop debugging and close that host before starting again.

The server binds strictly to `127.0.0.1:5173`. Stop a conflicting process before retrying. Fix syntax errors and save to recover. Check reconnects with a reopened panel and a restored tab.

Development command selection follows the [bundled tools contract](installation.md#bundled-tools). Reload the Extension Development Host after extension-host source saves. Watch-mode CLI commands run the rebuilt bundle on their next invocation. `extension/esbuild.mjs` owns both watchers.

This workflow supports a local Windows Extension Development Host. Remote extension hosts and port-forwarded development servers are unsupported. The webview loads its loopback address on the local VS Code machine, while a remote command binds on the remote machine.

Restore the production panel after development:

```bash
npm --prefix extension run build
```

## Configuration watches

`extension/src/configwatch.ts` owns folder watches. `extension/src/extension.ts` connects them to defaults invalidation and watches agent user homes. Windows and macOS match directory-event names without case. Linux preserves case. Keep patterns non-recursive. VS Code treats `/` or `**` as recursive.

On macOS, VS Code silently skips non-recursive watches under `/Volumes/`. A second-volume working directory outside every workspace folder receives no configuration invalidation. Only Arc executable path settings invalidate defaults through editor configuration events.
